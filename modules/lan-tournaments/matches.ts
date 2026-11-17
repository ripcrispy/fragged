/**
 * Brackets, matches, score reports, progression and standings.
 *
 * Every change to a result runs in one transaction that locks all matches of the stage (SELECT … FOR UPDATE), checks
 * the match's version, writes the result and runs the pure `propagate` step. Two people reporting at the same time
 * therefore queue up, and an entry can never be advanced twice or into a match that has moved on.
 */
import { database, services, eq, and, asc, inArray, sql, ServiceError } from '../../src/sdk/index.ts';
import { tournaments, entries, stages, matches, heatEntries, reports, attempts, results, type Tournament, type Entry, type Match, type Stage } from './schema.ts';
import {
  withDefaults, singleElimination, doubleElimination, roundRobin, splitGroups, groupLabel, playoffSeeds, swissPairings, swissRoundsFor, ffaHeats,
  ffaPointsFor, judgeScore, checkPlacements, propagate, dependents, slotColumns, shuffle, eliminationTable, leagueTable, swissTable, ffaTable, challengeTable,
  FINISHED, type PlannedMatch, type PlannedHeat, type StageKind, type Standing, type MatchLike, type LiveMatch, type SwissState,
} from './formats.ts';
import { entriesOf, counted, notifyEntry, notifyStaff, notifyParticipants, usersOfEntry } from './service.ts';

/** Set by the module: runs after results are published (e.g. to re-check achievements). */
let afterPublish: ((userIds: number[]) => Promise<void>) | null = null;
export function setAfterPublish(fn: typeof afterPublish) { afterPublish = fn; }

type Tx = Parameters<Parameters<ReturnType<typeof database.db>['transaction']>[0]>[0];
const db = () => database.db();
const url = (t: Pick<Tournament, 'slug'>, m?: { id: number }) => `/m/lan-tournaments/${t.slug}${m ? `/match/${m.id}` : ''}`;

export async function stagesOf(tId: number) { return db().select().from(stages).where(eq(stages.tournamentId, tId)).orderBy(asc(stages.idx)); }
export async function matchesOf(tId: number) { return db().select().from(matches).where(eq(matches.tournamentId, tId)).orderBy(asc(matches.stageId), asc(matches.bracket), asc(matches.round), asc(matches.position)); }
export async function matchById(id: number) { return (await db().select().from(matches).where(eq(matches.id, id)))[0] ?? null; }
export async function heatOf(matchId: number) { return db().select().from(heatEntries).where(eq(heatEntries.matchId, matchId)); }
export async function reportsOf(matchId: number) { return db().select().from(reports).where(eq(reports.matchId, matchId)).orderBy(asc(reports.createdAt)); }
export async function attemptsOf(tId: number) { return db().select().from(attempts).where(eq(attempts.tournamentId, tId)).orderBy(asc(attempts.createdAt)); }

// ───────────────────────────── generation ─────────────────────────────

/** Who plays: approved entries (and checked in, when required), in seeding order. */
export async function seededEntries(t: Tournament): Promise<Entry[]> {
  let list = (await entriesOf(t.id)).filter((e) => e.status === 'approved' && (!t.requireCheckin || e.checkedInAt));
  const cfg = withDefaults(t.config);
  if (cfg.seeding === 'random') list = shuffle(list, t.id * 7919 + list.length);
  else if (cfg.seeding === 'manual') list = [...list].sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.id - b.id);
  else list = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  return list;
}

async function insertStage(tx: Tx, t: Tournament, idx: number, kind: StageKind, name: string, config: Record<string, unknown> = {}) {
  return (await tx.insert(stages).values({ tournamentId: t.id, idx, kind, name, config }).returning())[0];
}
async function insertPlanned(tx: Tx, t: Tournament, stage: Stage, planned: PlannedMatch[]) {
  if (!planned.length) return;
  await tx.insert(matches).values(planned.map((p) => {
    const a = slotColumns(p.a), b = slotColumns(p.b);
    return { tournamentId: t.id, stageId: stage.id, bracket: p.bracket, round: p.round, position: p.position, code: p.code, bestOf: p.bestOf, entryA: a.entry, entryB: b.entry, aFrom: a.from, bFrom: b.from };
  }));
}
async function insertHeats(tx: Tx, t: Tournament, stage: Stage, heats: PlannedHeat[]) {
  for (const h of heats) {
    const [m] = await tx.insert(matches).values({ tournamentId: t.id, stageId: stage.id, bracket: 'H', round: h.round, position: h.position, code: h.code, bestOf: 1, status: 'ready' }).returning();
    await tx.insert(heatEntries).values(h.entries.map((entryId) => ({ matchId: m.id, entryId })));
  }
}
/** Fill slots and settle byes for a stage (inside the caller's transaction, with the stage locked). */
async function settleStage(tx: Tx, stageId: number): Promise<Match[]> {
  const rows = await tx.select().from(matches).where(eq(matches.stageId, stageId)).orderBy(asc(matches.id)).for('update');
  const live: LiveMatch[] = rows.map((r) => ({ ...r }));
  const changed = propagate(live);
  for (const m of live) {
    if (!changed.has(m.code)) continue;
    const r = rows.find((x) => x.code === m.code)!;
    await tx.update(matches).set({ entryA: m.entryA, entryB: m.entryB, status: m.status, winner: m.winner, loser: m.loser, completedAt: FINISHED.has(m.status) ? new Date() : null, version: r.version + 1 }).where(eq(matches.id, r.id));
  }
  return (await tx.select().from(matches).where(eq(matches.stageId, stageId))).filter((m) => changed.has(m.code) && m.status === 'ready');
}

/**
 * Generate the bracket (or first round) for the tournament's format and start the tournament. Returns the matches
 * that are ready to play, so their players can be told.
 */
export async function generateBracket(t: Tournament): Promise<Match[]> {
  if (!['registration_open', 'registration_closed'].includes(t.status)) throw new ServiceError('The bracket can only be generated before the tournament starts.', 409);
  if ((await stagesOf(t.id)).length) throw new ServiceError('The bracket already exists. Reset it first to generate a new one.', 409);
  const list = await seededEntries(t);
  const ids = list.map((e) => e.id);
  const cfg = withDefaults(t.config);
  const need = t.format === 'double_elim' ? 3 : 2;
  if (ids.length < need) throw new ServiceError(`At least ${need} ${t.requireCheckin ? 'checked-in ' : ''}approved entries are needed (there are ${ids.length}).`, 409);
  if (t.format === 'groups_playoffs' && ids.length < cfg.groups * 2) throw new ServiceError(`${cfg.groups} groups need at least ${cfg.groups * 2} entries.`, 409);
  if (t.format === 'groups_playoffs' && cfg.groups * cfg.advancePerGroup < 2) throw new ServiceError('At least 2 entries must go through to the playoffs.', 409);
  let ready: Match[] = [];
  await db().transaction(async (tx) => {
    const [locked] = await tx.select().from(tournaments).where(eq(tournaments.id, t.id)).for('update');
    if (!['registration_open', 'registration_closed'].includes(locked.status)) throw new ServiceError('The tournament has already started.', 409);
    let stage: Stage;
    switch (t.format) {
      case 'single_elim': stage = await insertStage(tx, t, 0, 'single_elim', 'Bracket'); await insertPlanned(tx, t, stage, singleElimination(ids, cfg)); break;
      case 'double_elim': stage = await insertStage(tx, t, 0, 'double_elim', 'Bracket'); await insertPlanned(tx, t, stage, doubleElimination(ids, cfg)); break;
      case 'round_robin': stage = await insertStage(tx, t, 0, 'round_robin', 'League'); await insertPlanned(tx, t, stage, roundRobin(ids, cfg, 'A')); break;
      case 'groups_playoffs': {
        stage = await insertStage(tx, t, 0, 'round_robin', 'Group stage', { groups: cfg.groups });
        const groups = splitGroups(ids, Math.min(cfg.groups, Math.floor(ids.length / 2)));
        await insertPlanned(tx, t, stage, groups.flatMap((g, i) => roundRobin(g, cfg, groupLabel(i))));
        break;
      }
      case 'swiss': {
        const rounds = cfg.swissRounds ?? swissRoundsFor(ids.length);
        stage = await insertStage(tx, t, 0, 'swiss', 'Swiss', { rounds });
        const half = Math.ceil(ids.length / 2);
        // round 1: top half against bottom half (1 v N/2+1 …); an odd one out gets the bye
        const pairs: PlannedMatch[] = [];
        const top = ids.slice(0, ids.length % 2 ? half - 1 : half), bottom = ids.slice(top.length, top.length * 2);
        top.forEach((a, i) => pairs.push({ code: `S1-${i + 1}`, bracket: 'S', round: 1, position: i + 1, bestOf: cfg.bestOf, a: { entry: a }, b: { entry: bottom[i] } }));
        if (ids.length % 2) pairs.push({ code: `S1-${pairs.length + 1}`, bracket: 'S', round: 1, position: pairs.length + 1, bestOf: cfg.bestOf, a: { entry: ids[ids.length - 1] }, b: { bye: true } });
        await insertPlanned(tx, t, stage, pairs);
        break;
      }
      case 'ffa': stage = await insertStage(tx, t, 0, 'ffa', 'Heats', { rounds: cfg.ffaRounds }); await insertHeats(tx, t, stage, ffaHeats(ids, cfg.heatSize, 1)); break;
      case 'time_trial': stage = await insertStage(tx, t, 0, 'time_trial', 'Challenge'); break;
      default: throw new ServiceError('Unknown format.', 400);
    }
    ready = await settleStage(tx, stage.id);
    if (t.format === 'ffa') ready = await tx.select().from(matches).where(eq(matches.stageId, stage.id));
    await tx.update(tournaments).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(tournaments.id, t.id));
  });
  return ready;
}

/** Throw away the bracket and go back to "registration closed". Only while no match has been played. */
export async function resetBracket(t: Tournament, opts: { force?: boolean } = {}) {
  const played = (await matchesOf(t.id)).filter((m) => m.status === 'done' && m.entryA !== null && m.entryB !== null || m.status === 'reported' || m.status === 'disputed');
  if (played.length && !opts.force) throw new ServiceError('Matches have already been played. Tick “Reset even though matches were played” to throw the results away.', 409);
  await db().transaction(async (tx) => {
    await tx.delete(stages).where(eq(stages.tournamentId, t.id));
    await tx.delete(attempts).where(eq(attempts.tournamentId, t.id));
    await tx.update(tournaments).set({ status: 'registration_closed', resultsPublishedAt: null, updatedAt: new Date() }).where(eq(tournaments.id, t.id));
    await tx.delete(results).where(eq(results.tournamentId, t.id));
  });
}

/** Manual adjustment: swap two entries between matches that haven't been played yet. */
export async function swapEntries(t: Tournament, entryX: number, entryY: number) {
  if (entryX === entryY) throw new ServiceError('Choose two different entries.');
  await db().transaction(async (tx) => {
    const rows = await tx.select().from(matches).where(eq(matches.tournamentId, t.id)).for('update');
    const where = (e: number) => rows.filter((m) => !FINISHED.has(m.status) && m.status !== 'reported' && m.status !== 'disputed' && (m.entryA === e || m.entryB === e));
    const mx = where(entryX), my = where(entryY);
    if (mx.length !== 1 || my.length !== 1) throw new ServiceError('Both entries must be waiting in exactly one unplayed match.', 409);
    if (mx[0].id === my[0].id) {
      await tx.update(matches).set({ entryA: mx[0].entryB, entryB: mx[0].entryA, version: mx[0].version + 1 }).where(eq(matches.id, mx[0].id));
      return;
    }
    const put = async (m: Match, from: number, to: number) => tx.update(matches).set(m.entryA === from ? { entryA: to, version: m.version + 1 } : { entryB: to, version: m.version + 1 }).where(eq(matches.id, m.id));
    await put(mx[0], entryX, entryY);
    await put(my[0], entryY, entryX);
  });
}

// ───────────────────────────── results ─────────────────────────────

export interface Outcome { scoreA: number; scoreB: number }

/**
 * Record a head-to-head result and advance the bracket. `expectVersion` makes a stale form fail instead of
 * overwriting a result someone else just entered.
 */
async function finalize(tx: Tx, t: Tournament, m: Match, o: Outcome, expectVersion?: number) {
  const [cur] = await tx.select().from(matches).where(eq(matches.id, m.id)).for('update');
  if (!cur) throw new ServiceError('Match not found.', 404);
  if (expectVersion !== undefined && cur.version !== expectVersion) throw new ServiceError('This match changed while you were looking at it. Check the latest result and try again.', 409, 'stale');
  if (cur.status === 'done' || cur.status === 'void') throw new ServiceError('This match already has a result.', 409);
  if (cur.entryA === null || cur.entryB === null) throw new ServiceError('Both sides of this match aren’t known yet.', 409);
  const cfg = withDefaults(t.config);
  let side: 'a' | 'b' | 'draw';
  try { side = judgeScore(cur.bestOf, o.scoreA, o.scoreB, { allowDraws: cfg.allowDraws && ['round_robin', 'swiss', 'groups_playoffs'].includes(t.format) && cur.bracket !== 'W', winCondition: cfg.winCondition }); }
  catch (e) { throw new ServiceError((e as Error).message, 400); }
  const winner = side === 'draw' ? null : side === 'a' ? cur.entryA : cur.entryB;
  const loser = side === 'draw' ? null : side === 'a' ? cur.entryB : cur.entryA;
  await tx.update(matches).set({ scoreA: o.scoreA, scoreB: o.scoreB, winner, loser, isDraw: side === 'draw', status: 'done', completedAt: new Date(), version: cur.version + 1 }).where(eq(matches.id, cur.id));
  await tx.update(reports).set({ status: 'superseded' }).where(and(eq(reports.matchId, cur.id), inArray(reports.status, ['pending', 'disputed'])));
  return { ...cur, scoreA: o.scoreA, scoreB: o.scoreB, winner, loser, status: 'done' as const };
}

/** After a result: settle the stage, then start the next swiss/ffa round or the playoffs when a round finishes. */
async function afterResult(tx: Tx, t: Tournament, stageId: number): Promise<Match[]> {
  const ready = await settleStage(tx, stageId);
  const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId));
  const all = await tx.select().from(matches).where(eq(matches.stageId, stageId));
  if (!all.length || !all.every((m) => FINISHED.has(m.status))) return ready;
  const cfg = withDefaults(t.config);
  const round = Math.max(...all.map((m) => m.round));
  if (stage.kind === 'swiss' && round < Number(stage.config.rounds ?? 1)) {
    // (entries come from this stage's matches: no queries outside the transaction while it holds the lock)
    const ids = [...new Set(all.flatMap((m) => [m.entryA, m.entryB]).filter((x): x is number => x !== null))];
    const table = swissTable(ids, all.map(toLike(0)), byesOf(all), cfg);
    const state: SwissState[] = table.map((s, i) => ({ entry: s.entry, points: s.points, seed: i, hadBye: (byesOf(all).get(s.entry) ?? 0) > 0,
      opponents: new Set(all.filter((m) => m.entryA === s.entry || m.entryB === s.entry).map((m) => (m.entryA === s.entry ? m.entryB : m.entryA)).filter((x): x is number => x !== null)) }));
    const { pairs, bye } = swissPairings(state);
    const planned: PlannedMatch[] = pairs.map(([a, b], i) => ({ code: `S${round + 1}-${i + 1}`, bracket: 'S', round: round + 1, position: i + 1, bestOf: cfg.bestOf, a: { entry: a }, b: { entry: b } }));
    if (bye !== null) planned.push({ code: `S${round + 1}-${planned.length + 1}`, bracket: 'S', round: round + 1, position: planned.length + 1, bestOf: cfg.bestOf, a: { entry: bye }, b: { bye: true } });
    await insertPlanned(tx, t, stage, planned);
    return [...ready, ...(await settleStage(tx, stage.id))];
  }
  if (stage.kind === 'ffa' && round < Number(stage.config.rounds ?? 1)) {
    const heats = await tx.select().from(heatEntries).where(inArray(heatEntries.matchId, all.map((m) => m.id)));
    const ids = [...new Set(heats.map((h) => h.entryId))];
    const ranked = ffaTable(ids, heats.map((h) => ({ entry: h.entryId, placement: h.placement, points: h.points }))).map((s) => s.entry);
    await insertHeats(tx, t, stage, ffaHeats(ranked, cfg.heatSize, round + 1));
    return [...ready, ...(await tx.select().from(matches).where(and(eq(matches.stageId, stage.id), eq(matches.round, round + 1))))];
  }
  await tx.update(stages).set({ status: 'done' }).where(eq(stages.id, stage.id));
  if (t.format === 'groups_playoffs' && stage.idx === 0) {
    const labels = [...new Set(all.map((m) => m.bracket))].sort();
    const ranks = labels.map((g) => {
      const gm = all.filter((m) => m.bracket === g);
      const ids = [...new Set(gm.flatMap((m) => [m.entryA, m.entryB]).filter((x): x is number => x !== null))];
      return leagueTable(ids, gm.map(toLike(0)), cfg).map((s) => s.entry);
    });
    const seeds = playoffSeeds(ranks, cfg.advancePerGroup);
    const po = await insertStage(tx, t, 1, cfg.playoff, 'Playoffs');
    await insertPlanned(tx, t, po, cfg.playoff === 'double_elim' && seeds.length >= 3 ? doubleElimination(seeds, cfg) : singleElimination(seeds, cfg));
    return [...ready, ...(await settleStage(tx, po.id))];
  }
  return ready;
}

export const toLike = (stageIdx: number) => (m: Match): MatchLike => ({ code: m.code, bracket: m.bracket, round: m.round, stageIdx, entryA: m.entryA, entryB: m.entryB, scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, loser: m.loser, isDraw: m.isDraw, status: m.status });
/** Swiss byes: finished matches with only one entry. */
export function byesOf(ms: Match[]) {
  const out = new Map<number, number>();
  for (const m of ms) if (m.status === 'done' && m.winner !== null && (m.entryA === null || m.entryB === null)) out.set(m.winner, (out.get(m.winner) ?? 0) + 1);
  return out;
}

async function tellReady(t: Tournament, list: Match[], names: Map<number, string>) {
  for (const m of list) {
    if (m.bracket === 'H') {
      for (const h of await heatOf(m.id)) { const e = await entryRow(h.entryId); if (e) await notifyEntry(e, null, `${t.name}: your heat ${m.code} is ready.`, url(t, m)); }
      continue;
    }
    if (m.status !== 'ready' || m.entryA === null || m.entryB === null) continue;
    for (const [me, them] of [[m.entryA, m.entryB], [m.entryB, m.entryA]] as const) {
      const e = await entryRow(me);
      if (e) await notifyEntry(e, null, `${t.name}: your match against ${names.get(them) ?? 'your opponent'} is ready${m.scheduledAt ? '' : ' to play'}.`, url(t, m));
    }
  }
}
const entryRow = async (id: number) => (await db().select().from(entries).where(eq(entries.id, id)))[0] ?? null;
const nameMap = async (tId: number) => new Map((await entriesOf(tId)).map((e) => [e.id, e.name]));

async function resultTx(t: Tournament, m: Match, fn: (tx: Tx) => Promise<Match>, opts: { notify?: boolean } = {}) {
  let ready: Match[] = [];
  let done: Match | null = null;
  await db().transaction(async (tx) => {
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.stageId, m.stageId)).for('update');
    done = await fn(tx);
    ready = await afterResult(tx, t, m.stageId);
  });
  const names = await nameMap(t.id);
  if (opts.notify !== false && done) {
    const d = done as Match;
    const line = d.isDraw ? `drew ${d.scoreA}–${d.scoreB}` : `${names.get(d.winner!) ?? 'Winner'} won ${Math.max(d.scoreA ?? 0, d.scoreB ?? 0)}–${Math.min(d.scoreA ?? 0, d.scoreB ?? 0)}`;
    for (const e of [d.entryA, d.entryB]) { const row = e ? await entryRow(e) : null; if (row) await notifyEntry(row, null, `${t.name}: result confirmed in ${d.code}: ${line}.`, url(t, d)); }
  }
  await tellReady(t, ready, names);
  return done as unknown as Match;
}

/**
 * A participant (or staff member) reports a head-to-head score.
 * - Staff (referees, organisers): the result is final.
 * - A participant: it waits for the other side. If the other side already reported the same score it's confirmed;
 *   a different score puts the match in dispute.
 */
export async function reportScore(t: Tournament, m: Match, by: { userId: number; side: 'a' | 'b' | 'staff' }, o: Outcome, expectVersion?: number) {
  if (t.status !== 'in_progress') throw new ServiceError('The tournament isn’t in progress.', 409);
  if (m.bracket === 'H') throw new ServiceError('Report a heat with placings.', 400);
  if (!['ready', 'live', 'reported', 'disputed'].includes(m.status)) throw new ServiceError(m.status === 'done' ? 'This match already has a result.' : 'This match isn’t ready to play.', 409);
  const cfg = withDefaults(t.config);
  try { judgeScore(m.bestOf, o.scoreA, o.scoreB, { allowDraws: cfg.allowDraws && ['round_robin', 'swiss', 'groups_playoffs'].includes(t.format) && m.bracket !== 'W', winCondition: cfg.winCondition }); }
  catch (e) { throw new ServiceError((e as Error).message, 400); }
  if (by.side === 'staff') return { state: 'final' as const, match: await resultTx(t, m, (tx) => finalize(tx, t, m, o, expectVersion)) };
  if (m.status === 'disputed') throw new ServiceError('This result is disputed. A referee will settle it.', 409);
  let state = 'waiting' as 'waiting' | 'final' | 'disputed';
  let ready: Match[] = [];
  const names = await nameMap(t.id);
  await db().transaction(async (tx) => {
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.stageId, m.stageId)).for('update');
    const [cur] = await tx.select().from(matches).where(eq(matches.id, m.id));
    if (expectVersion !== undefined && cur.version !== expectVersion) throw new ServiceError('This match changed while you were looking at it. Check the latest result and try again.', 409, 'stale');
    if (cur.status === 'done') throw new ServiceError('This match already has a result.', 409);
    const pending = await tx.select().from(reports).where(and(eq(reports.matchId, m.id), eq(reports.status, 'pending')));
    const theirs = pending.find((r) => r.side !== by.side);
    await tx.update(reports).set({ status: 'superseded' }).where(and(eq(reports.matchId, m.id), eq(reports.status, 'pending'), eq(reports.side, by.side)));
    if (theirs && theirs.scoreA === o.scoreA && theirs.scoreB === o.scoreB) {
      await tx.insert(reports).values({ matchId: m.id, side: by.side, scoreA: o.scoreA, scoreB: o.scoreB, reportedBy: by.userId, status: 'confirmed' });
      await tx.update(reports).set({ status: 'confirmed' }).where(eq(reports.id, theirs.id));
      await finalize(tx, t, cur, o);
      ready = await afterResult(tx, t, m.stageId);
      state = 'final';
      return;
    }
    if (theirs) {
      await tx.insert(reports).values({ matchId: m.id, side: by.side, scoreA: o.scoreA, scoreB: o.scoreB, reportedBy: by.userId, status: 'disputed', disputeReason: 'The two sides reported different scores.' });
      await tx.update(reports).set({ status: 'disputed' }).where(eq(reports.id, theirs.id));
      await tx.update(matches).set({ status: 'disputed', version: cur.version + 1 }).where(eq(matches.id, m.id));
      state = 'disputed';
      return;
    }
    await tx.insert(reports).values({ matchId: m.id, side: by.side, scoreA: o.scoreA, scoreB: o.scoreB, reportedBy: by.userId, status: 'pending' });
    await tx.update(matches).set({ status: 'reported', version: cur.version + 1 }).where(eq(matches.id, m.id));
  });
  const fresh = (await matchById(m.id))!;
  if (state === 'final') {
    for (const e of [fresh.entryA, fresh.entryB]) { const row = e ? await entryRow(e) : null; if (row) await notifyEntry(row, by.userId, `${t.name}: both sides confirmed the result of ${fresh.code}.`, url(t, fresh)); }
    await tellReady(t, ready, names);
  } else if (state === 'disputed') {
    await notifyStaff(t.id, by.userId, `${t.name}: the result of ${fresh.code} is disputed.`, url(t, fresh));
    for (const e of [fresh.entryA, fresh.entryB]) { const row = e ? await entryRow(e) : null; if (row) await notifyEntry(row, by.userId, `${t.name}: the two sides reported different scores in ${fresh.code}. A referee will settle it.`, url(t, fresh)); }
  } else {
    const other = by.side === 'a' ? fresh.entryB : fresh.entryA;
    const row = other ? await entryRow(other) : null;
    if (row) await notifyEntry(row, by.userId, `${t.name}: ${names.get(by.side === 'a' ? fresh.entryA! : fresh.entryB!) ?? 'Your opponent'} reported ${o.scoreA}–${o.scoreB} in ${fresh.code}. Confirm or dispute it.`, url(t, fresh));
  }
  return { state, match: fresh };
}

/** The other side confirms a pending report. */
export async function confirmReport(t: Tournament, m: Match, side: 'a' | 'b', userId: number) {
  const pending = (await reportsOf(m.id)).find((r) => r.status === 'pending');
  if (!pending) throw new ServiceError('There’s no reported score to confirm.', 409);
  if (pending.side === side) throw new ServiceError('The other side has to confirm your report.', 403);
  return reportScore(t, m, { userId, side }, { scoreA: pending.scoreA!, scoreB: pending.scoreB! });
}

/** The other side disputes a pending report. */
export async function disputeReport(t: Tournament, m: Match, side: 'a' | 'b', userId: number, reason: string) {
  const r = reason.trim().slice(0, 300);
  if (r.length < 3) throw new ServiceError('Say what’s wrong with the reported score.');
  const pending = (await reportsOf(m.id)).find((x) => x.status === 'pending');
  if (!pending) throw new ServiceError('There’s no reported score to dispute.', 409);
  if (pending.side === side) throw new ServiceError('You can’t dispute your own report. Report the correct score instead.', 403);
  await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(matches).where(eq(matches.id, m.id)).for('update');
    if (cur.status !== 'reported') throw new ServiceError('This match can’t be disputed now.', 409);
    await tx.update(reports).set({ status: 'disputed', disputeReason: r }).where(eq(reports.id, pending.id));
    await tx.insert(reports).values({ matchId: m.id, side, reportedBy: userId, status: 'disputed', disputeReason: r });
    await tx.update(matches).set({ status: 'disputed', version: cur.version + 1 }).where(eq(matches.id, m.id));
  });
  await notifyStaff(t.id, userId, `${t.name}: ${m.code} is disputed: “${r}”`, url(t, m));
  return (await matchById(m.id))!;
}

/**
 * Staff override: set (or correct) a result. A finished match can be corrected only while the matches it fed are
 * unplayed; their slots are cleared and filled again from the new result.
 */
export async function overrideResult(t: Tournament, m: Match, o: Outcome, expectVersion?: number) {
  if (!['in_progress', 'completed'].includes(t.status)) throw new ServiceError('The tournament isn’t running.', 409);
  if (m.bracket === 'H') throw new ServiceError('Use placings for heats.', 400);
  if (m.status !== 'done') return (await reportScore(t, m, { userId: 0, side: 'staff' }, o, expectVersion)).match;
  return resultTx(t, m, async (tx) => {
    const all = await tx.select().from(matches).where(eq(matches.stageId, m.stageId));
    const deps = dependents(all as LiveMatch[], m.code);
    const later = all.filter((x) => x.round > m.round && (t.format === 'swiss' || t.format === 'ffa'));
    if (deps.some((d) => d.status === 'done' || d.status === 'reported' || d.status === 'disputed' || d.status === 'live') || later.some((x) => x.status === 'done' && x.entryA !== null && x.entryB !== null))
      throw new ServiceError('Later matches that depend on this result have already been played. Correct those first.', 409);
    if (later.length) throw new ServiceError('The next round has already been paired from this result. Reset the bracket to change it.', 409);
    const [stage] = await tx.select().from(stages).where(eq(stages.id, m.stageId));
    if (stage.status === 'done' && (await tx.select().from(stages).where(and(eq(stages.tournamentId, t.id), eq(stages.idx, stage.idx + 1)))).length)
      throw new ServiceError('The next stage has already been drawn from these results. Reset the bracket to change them.', 409);
    for (const d of deps) {
      const clearA = d.aFrom === `W:${m.code}` || d.aFrom === `L:${m.code}`;
      const clearB = d.bFrom === `W:${m.code}` || d.bFrom === `L:${m.code}`;
      await tx.update(matches).set({ ...(clearA ? { entryA: null } : {}), ...(clearB ? { entryB: null } : {}), status: 'pending', winner: null, loser: null, version: (d as Match).version + 1, completedAt: null }).where(eq(matches.id, (d as Match).id));
    }
    await tx.update(matches).set({ status: 'ready', winner: null, loser: null, isDraw: false, scoreA: null, scoreB: null, completedAt: null }).where(eq(matches.id, m.id));
    await tx.update(stages).set({ status: 'active' }).where(eq(stages.id, m.stageId));
    return finalize(tx, t, { ...m, status: 'ready' }, o);
  });
}

// ───────────────────────────── heats (free-for-all) ─────────────────────────────

/** Placings for a heat. Staff placings are final; a participant's wait for another participant in the heat to confirm. */
export async function reportHeat(t: Tournament, m: Match, by: { userId: number; entryId: number | null; staff: boolean }, placements: Record<string, number>) {
  if (t.status !== 'in_progress') throw new ServiceError('The tournament isn’t in progress.', 409);
  if (m.bracket !== 'H') throw new ServiceError('This isn’t a heat.', 400);
  if (m.status === 'done') throw new ServiceError('This heat already has a result.', 409);
  const heat = await heatOf(m.id);
  const ids = heat.map((h) => h.entryId);
  try { checkPlacements(ids, placements); } catch (e) { throw new ServiceError((e as Error).message, 400); }
  if (!by.staff && (!by.entryId || !ids.includes(by.entryId))) throw new ServiceError('Only players in this heat can report it.', 403);
  const cfg = withDefaults(t.config);
  const same = (a: Record<string, number> | null) => !!a && ids.every((id) => a[String(id)] === placements[String(id)]);
  let state = 'waiting' as 'final' | 'waiting' | 'disputed';
  let readyHeats: Match[] = [];
  await db().transaction(async (tx) => {
    await tx.select({ id: matches.id }).from(matches).where(eq(matches.stageId, m.stageId)).for('update');
    const [cur] = await tx.select().from(matches).where(eq(matches.id, m.id));
    if (cur.status === 'done') throw new ServiceError('This heat already has a result.', 409);
    const pending = (await tx.select().from(reports).where(and(eq(reports.matchId, m.id), eq(reports.status, 'pending'))))[0];
    const side = by.staff ? 'staff' : `e${by.entryId}`;
    const final = by.staff || (pending && pending.side !== side && same(pending.placements));
    if (final) {
      for (const id of ids) await tx.update(heatEntries).set({ placement: placements[String(id)], points: ffaPointsFor(placements[String(id)], cfg.ffaPoints) }).where(and(eq(heatEntries.matchId, m.id), eq(heatEntries.entryId, id)));
      await tx.update(reports).set({ status: 'confirmed' }).where(and(eq(reports.matchId, m.id), eq(reports.status, 'pending')));
      await tx.insert(reports).values({ matchId: m.id, side, placements, reportedBy: by.userId || null, status: 'confirmed' });
      await tx.update(matches).set({ status: 'done', completedAt: new Date(), version: cur.version + 1 }).where(eq(matches.id, m.id));
      readyHeats = await afterResult(tx, t, m.stageId);
      state = 'final';
    } else if (pending && pending.side !== side) {
      await tx.update(reports).set({ status: 'disputed' }).where(eq(reports.id, pending.id));
      await tx.insert(reports).values({ matchId: m.id, side, placements, reportedBy: by.userId, status: 'disputed', disputeReason: 'Players reported different placings.' });
      await tx.update(matches).set({ status: 'disputed', version: cur.version + 1 }).where(eq(matches.id, m.id));
      state = 'disputed';
    } else {
      await tx.update(reports).set({ status: 'superseded' }).where(and(eq(reports.matchId, m.id), eq(reports.status, 'pending')));
      await tx.insert(reports).values({ matchId: m.id, side, placements, reportedBy: by.userId, status: 'pending' });
      await tx.update(matches).set({ status: 'reported', version: cur.version + 1 }).where(eq(matches.id, m.id));
    }
  });
  if (state === 'disputed') await notifyStaff(t.id, by.userId, `${t.name}: placings for ${m.code} are disputed.`, url(t, m));
  if (state === 'final') {
    for (const id of ids) { const row = await entryRow(id); if (row) await notifyEntry(row, null, `${t.name}: you placed ${placements[String(id)]} in ${m.code}.`, url(t, m)); }
    await tellReady(t, readyHeats.filter((x) => x.bracket === 'H' && x.id !== m.id && x.status === 'ready'), await nameMap(t.id));
  }
  return state;
}

// ───────────────────────────── time challenge ─────────────────────────────

export function challengeOpenReason(t: Tournament, now = new Date()) {
  if (t.format !== 'time_trial') return 'This isn’t a challenge.';
  if (t.status !== 'in_progress') return 'The challenge isn’t running.';
  if (t.endsAt && now > t.endsAt) return 'The challenge has ended.';
  return null;
}
export async function submitAttempt(t: Tournament, entry: Entry, value: number, proof: string, userId: number, staffMember: boolean) {
  const why = challengeOpenReason(t);
  if (why && !staffMember) throw new ServiceError(why, 409);
  if (!Number.isInteger(value) || value < 0 || value > 999_999_999) throw new ServiceError('That isn’t a valid score.');
  const cfg = withDefaults(t.config);
  await db().insert(attempts).values({ tournamentId: t.id, entryId: entry.id, value, proof: proof.trim().slice(0, 300), submittedBy: userId, status: cfg.verifyAttempts && !staffMember ? 'pending' : 'approved', reviewedBy: staffMember ? userId : null });
  if (cfg.verifyAttempts && !staffMember) await notifyStaff(t.id, userId, `${t.name}: ${entry.name} submitted an attempt to check.`, `${url(t)}/manage#attempts`, ['organiser', 'referee']);
}
export async function reviewAttempt(t: Tournament, attemptId: number, approve: boolean, by: number) {
  const [a] = await db().select().from(attempts).where(and(eq(attempts.id, attemptId), eq(attempts.tournamentId, t.id)));
  if (!a) throw new ServiceError('Attempt not found.', 404);
  await db().update(attempts).set({ status: approve ? 'approved' : 'rejected', reviewedBy: by }).where(eq(attempts.id, a.id));
  const e = await entryRow(a.entryId);
  if (e) await notifyEntry(e, by, `${t.name}: your attempt was ${approve ? 'approved' : 'rejected'}.`, url(t));
}
export async function endChallenge(t: Tournament) {
  if (t.format !== 'time_trial' || t.status !== 'in_progress') throw new ServiceError('There’s no challenge running.', 409);
  await db().update(stages).set({ status: 'done' }).where(eq(stages.tournamentId, t.id));
}

// ───────────────────────────── scheduling ─────────────────────────────

export async function scheduleMatch(t: Tournament, m: Match, at: Date | null, station: string) {
  const changed = (m.scheduledAt?.getTime() ?? null) !== (at?.getTime() ?? null);
  await db().update(matches).set({ scheduledAt: at, station: station.trim().slice(0, 40), remindedAt: changed ? null : m.remindedAt, version: m.version + 1 }).where(eq(matches.id, m.id));
  return changed;
}
/** Schedule a round: the first match at `start`, then one every `every` minutes across `parallel` stations. */
export async function scheduleRound(t: Tournament, stageId: number, round: number, bracket: string | null, start: Date, every: number, parallel: number) {
  if (!Number.isInteger(every) || every < 1 || every > 600) throw new ServiceError('Minutes between matches must be 1–600.');
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64) throw new ServiceError('Matches at once must be 1–64.');
  const list = (await matchesOf(t.id)).filter((m) => m.stageId === stageId && m.round === round && (!bracket || m.bracket === bracket) && !FINISHED.has(m.status));
  for (const [i, m] of list.entries()) await db().update(matches).set({ scheduledAt: new Date(start.getTime() + Math.floor(i / parallel) * every * 60_000), remindedAt: null, version: m.version + 1 }).where(eq(matches.id, m.id));
  return list;
}
export async function setLive(m: Match, live: boolean) {
  if (live && m.status !== 'ready') throw new ServiceError('Only a match that’s ready can go live.', 409);
  if (!live && m.status !== 'live') return;
  await db().update(matches).set({ status: live ? 'live' : 'ready', version: m.version + 1 }).where(eq(matches.id, m.id));
}
/** Reminders ~15 minutes before scheduled matches. Called on a timer while the module is running. */
export async function sendReminders(now = new Date()) {
  const soon = await db().select({ m: matches, t: tournaments }).from(matches).innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(and(inArray(matches.status, ['ready', 'pending']), sql`${matches.remindedAt} is null`, sql`${matches.scheduledAt} is not null`, sql`${matches.scheduledAt} <= ${new Date(now.getTime() + 15 * 60_000)}`, sql`${matches.scheduledAt} > ${new Date(now.getTime() - 5 * 60_000)}`, eq(tournaments.status, 'in_progress')));
  for (const { m, t } of soon) {
    await db().update(matches).set({ remindedAt: now }).where(eq(matches.id, m.id));
    const ids = m.bracket === 'H' ? (await heatOf(m.id)).map((h) => h.entryId) : [m.entryA, m.entryB].filter((x): x is number => x !== null);
    for (const id of ids) { const e = await entryRow(id); if (e) await notifyEntry(e, null, `${t.name}: ${m.code} starts soon${m.station ? ` at ${m.station}` : ''}.`, url(t, m)); }
  }
  return soon.length;
}

// ───────────────────────────── standings and results ─────────────────────────────

export interface StageView { stage: Stage; matches: Match[]; groups: { label: string; table: Standing[] }[]; table: Standing[] }

/** Standings for every stage and overall. `finished` is true when the last stage is complete. */
export async function standings(t: Tournament) {
  const cfg = withDefaults(t.config);
  const sts = await stagesOf(t.id);
  const ms = await matchesOf(t.id);
  const ents = await entriesOf(t.id);
  const views: StageView[] = [];
  for (const s of sts) {
    const sm = ms.filter((m) => m.stageId === s.id);
    const ids = [...new Set(sm.flatMap((m) => [m.entryA, m.entryB]).filter((x): x is number => x !== null))];
    const view: StageView = { stage: s, matches: sm, groups: [], table: [] };
    if (s.kind === 'single_elim' || s.kind === 'double_elim') view.table = eliminationTable(ids, sm.map(toLike(s.idx)), s.kind === 'double_elim');
    else if (s.kind === 'round_robin') {
      for (const g of [...new Set(sm.map((m) => m.bracket))].sort()) {
        const gm = sm.filter((m) => m.bracket === g);
        view.groups.push({ label: g, table: leagueTable([...new Set(gm.flatMap((m) => [m.entryA, m.entryB]).filter((x): x is number => x !== null))], gm.map(toLike(s.idx)), cfg) });
      }
      view.table = view.groups.length === 1 ? view.groups[0].table : [];
    } else if (s.kind === 'swiss') view.table = swissTable([...new Set([...ids, ...byesOf(sm).keys()])], sm.map(toLike(s.idx)), byesOf(sm), cfg);
    else if (s.kind === 'ffa') {
      const heats = sm.length ? await db().select().from(heatEntries).where(inArray(heatEntries.matchId, sm.map((m) => m.id))) : [];
      view.table = ffaTable([...new Set(heats.map((h) => h.entryId))], heats.map((h) => ({ entry: h.entryId, placement: h.placement, points: h.points })));
    } else if (s.kind === 'time_trial') {
      const att = (await attemptsOf(t.id)).filter((a) => a.status === 'approved' || (!cfg.verifyAttempts && a.status !== 'rejected'));
      const lower = cfg.winCondition === 'lower';
      const best = new Map<number, number>();
      for (const a of att) { const b = best.get(a.entryId); if (b === undefined || (lower ? a.value < b : a.value > b)) best.set(a.entryId, a.value); }
      view.table = challengeTable(counted(ents).filter((e) => e.status === 'approved').map((e) => e.id), best, lower);
    }
    views.push(view);
  }
  const finished = sts.length > 0 && sts.every((s) => s.status === 'done') && (t.format !== 'groups_playoffs' || sts.length === 2);
  let overall: Standing[] = views.at(-1)?.table ?? [];
  if (t.format === 'groups_playoffs' && views.length) {
    const po = views[1]?.table ?? [];
    const groupRows = views[0].groups.flatMap((g) => g.table.map((s) => ({ s, rank: s.place })));
    const rest = groupRows.filter((r) => !po.some((p) => p.entry === r.s.entry)).sort((a, b) => a.rank - b.rank || b.s.points - a.s.points);
    overall = [...po.map((p) => ({ ...p })), ...rest.map((r, i) => ({ ...r.s, place: po.length + 1 + i }))];
    // entries tied on group rank and points share a place
    for (let i = po.length + 1; i < overall.length; i++) { const a = rest[i - po.length - 1], b = rest[i - po.length]; if (a && b && a.rank === b.rank && a.s.points === b.s.points) overall[i].place = overall[i - 1].place; }
  }
  return { stages: views, overall, finished };
}

/** Publish final standings: store results (with ranking points), complete the tournament and tell everyone. */
export async function publishResults(t: Tournament, by: number, opts: { force?: boolean } = {}) {
  if (t.status !== 'in_progress') throw new ServiceError('Only a tournament in progress can be completed.', 409);
  const st = await standings(t);
  if (!st.finished && !opts.force) throw new ServiceError('Not every match has a result yet. Tick “Publish anyway” to finish early with the current standings.', 409);
  if (!st.overall.length) throw new ServiceError('There are no standings to publish.', 409);
  const cfg = withDefaults(t.config);
  const ents = new Map((await entriesOf(t.id)).map((e) => [e.id, e]));
  const rows: (typeof results.$inferInsert)[] = [];
  const allMatches = st.stages.flatMap((v) => v.matches);
  for (const s of st.overall) {
    const e = ents.get(s.entry);
    if (!e) continue;
    const mine = allMatches.filter((m) => m.status === 'done' && m.entryA !== null && m.entryB !== null && (m.entryA === e.id || m.entryB === e.id));
    const wins = mine.filter((m) => m.winner === e.id).length, draws = mine.filter((m) => m.isDraw).length, losses = mine.length - wins - draws;
    const points = (cfg.rankingPoints[s.place - 1] ?? 0) + (cfg.participationPoints ?? 0);
    if (e.teamId) {
      const users = await usersOfEntry(e);
      const cards = await services.users.cards(users);
      for (const u of users) rows.push({ tournamentId: t.id, entryId: e.id, userId: u, name: (cards.get(u)?.username ?? 'Member').slice(0, 60), teamName: e.name, place: s.place, points, wins, losses, draws });
    } else rows.push({ tournamentId: t.id, entryId: e.id, userId: e.userId, name: e.name, place: s.place, points, wins, losses, draws });
  }
  await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(tournaments).where(eq(tournaments.id, t.id)).for('update');
    if (cur.status !== 'in_progress') throw new ServiceError('The results have already been published.', 409);
    await tx.delete(results).where(eq(results.tournamentId, t.id));
    if (rows.length) await tx.insert(results).values(rows);
    await tx.update(tournaments).set({ status: 'completed', resultsPublishedAt: new Date(), updatedAt: new Date() }).where(eq(tournaments.id, t.id));
  });
  const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0] ?? 'th'}`;
  for (const s of st.overall) { const e = ents.get(s.entry); if (e) await notifyEntry(e, by, `${t.name} is over: you finished ${ordinal(s.place)}.`, `/m/lan-tournaments/${t.slug}`); }
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => !!x))];
  if (afterPublish) await afterPublish(userIds).catch(() => {});
  return { rows: rows.length, userIds: [...new Set(rows.map((r) => r.userId).filter((x): x is number => !!x))] };
}

export async function cancelNotice(t: Tournament, by: number) { await notifyParticipants(t.id, by, `${t.name} has been cancelled.`, `/m/lan-tournaments/${t.slug}`); }
