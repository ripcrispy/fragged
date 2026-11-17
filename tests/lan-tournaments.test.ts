/** LAN tournaments: lifecycle, registration, every format, reporting and disputes, concurrency, permissions, LAN integration. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, client } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { setModuleEnabled, exposedApi } from '../src/modules/runtime.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import * as Privacy from '../src/services/privacy.ts';
import {
  createTournament, validateTournament, setStatus, registerSolo, reviewEntry, invite, createTeam, inviteToTeam, answerInvite, registerTeam, removeFromTeam,
  entriesOf, byId, setStaff, checkIn, type TournamentInput,
} from '../modules/lan-tournaments/service.ts';
import {
  generateBracket, matchesOf, reportScore, confirmReport, disputeReport, overrideResult, reportHeat, submitAttempt, reviewAttempt, endChallenge, standings,
  publishResults, stagesOf, heatOf, matchById, resetBracket, swapEntries,
} from '../modules/lan-tournaments/matches.ts';
import { results, tournaments, type Tournament, type Match } from '../modules/lan-tournaments/schema.ts';
import { events as seatEvents, book as bookSeat } from '../modules/lan-seating/service.ts';
import { setUp as setUpBookings, typesFor, bookPlace, configs as bookingConfigs } from '../modules/lan-bookings/service.ts';

const base: TournamentInput = {
  name: 'Test Cup', game: 'Game', platform: 'PC', description: '', rules: '', visibility: 'public', mode: 'solo', teamMin: 1, teamMax: 1, subsMax: 0,
  maxEntries: null, requireApproval: false, requireCheckin: false, requireBooking: false, format: 'single_elim', config: {}, lanEventId: null,
  regOpensAt: null, regClosesAt: null, checkinOpensAt: null, startsAt: null, endsAt: null,
};
let admin: { id: number };
let n = 0;
const fresh = async (t: Tournament) => (await byId(t.id))!;
async function open(over: Partial<TournamentInput> = {}) {
  const t = await createTournament({ ...base, name: `Cup ${++n}`, ...over }, admin.id);
  await setStatus(t, 'registration_open');
  return fresh(t);
}
async function withPlayers(count: number, over: Partial<TournamentInput> = {}) {
  const t = await open(over);
  const users = [];
  for (let i = 0; i < count; i++) { const u = await makeUser(); users.push(u); await registerSolo(t, u.id, {}); }
  return { t: await fresh(t), users };
}
/** Play every ready match: the lower entry id wins 1–0 (or 2–0 in best of 3, etc.). */
async function playAll(t: Tournament, pick?: (m: Match) => 'a' | 'b') {
  for (let guard = 0; guard < 200; guard++) {
    const m = (await matchesOf(t.id)).find((x) => x.status === 'ready' && x.bracket !== 'H');
    if (!m) return;
    const need = Math.ceil(m.bestOf / 2);
    const side = pick ? pick(m) : (m.entryA! < m.entryB! ? 'a' : 'b');
    await overrideResult(await fresh(t), m, side === 'a' ? { scoreA: need, scoreB: 0 } : { scoreA: 0, scoreB: need });
  }
}
const sideUser = async (t: Tournament, entryId: number) => (await entriesOf(t.id)).find((e) => e.id === entryId)!.userId!;

beforeAll(async () => {
  await setupDb();
  for (const id of ['lan-seating', 'lan-bookings', 'lan-intranet', 'achievements', 'lan-tournaments']) await setModuleEnabled(id, true);
  admin = await makeUser({ group: 'admin' });
});
afterAll(teardownDb);
beforeEach(() => resetLimits());

describe('creation and configuration', () => {
  it('validates settings server-side', () => {
    expect(() => validateTournament({ ...base, name: 'x' })).toThrow(/at least 3/);
    expect(() => validateTournament({ ...base, mode: 'team', teamMin: 5, teamMax: 3 })).toThrow(/Team sizes/);
    expect(() => validateTournament({ ...base, config: { bestOf: 4 } })).toThrow(/best of 1, 3, 5 or 7/);
    expect(() => validateTournament({ ...base, format: 'groups_playoffs', config: { groups: 1 } })).toThrow(/at least 2 groups/);
    expect(() => validateTournament({ ...base, regOpensAt: new Date(2000), regClosesAt: new Date(1000) })).toThrow(/open before/);
    expect(() => validateTournament({ ...base, requireBooking: true })).toThrow(/Link a LAN event/);
    expect(validateTournament({ ...base, mode: 'solo', teamMin: 5, teamMax: 5 })).toMatchObject({ teamMin: 1, teamMax: 1 });
  });
  it('makes the creator an organiser and moves through statuses', async () => {
    const t = await createTournament({ ...base, name: 'Lifecycle Cup' }, admin.id);
    expect(t.status).toBe('draft');
    await expect(setStatus(t, 'completed')).rejects.toThrow(/can’t become/);
    await setStatus(t, 'registration_open');
    await setStatus(await fresh(t), 'registration_closed');
    await setStatus(await fresh(t), 'cancelled');
    expect((await fresh(t)).status).toBe('cancelled');
  });
});

describe('registration', () => {
  it('enforces capacity, duplicates, approval, invitations and the window', async () => {
    const t = await open({ maxEntries: 2, requireApproval: true });
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    const ea = await registerSolo(t, a.id, {});
    expect(ea.status).toBe('pending');
    await expect(registerSolo(t, a.id, {})).rejects.toThrow(/Already registered/);
    await registerSolo(t, b.id, {});
    await expect(registerSolo(t, c.id, {})).rejects.toThrow(/full/);
    await reviewEntry(ea, true);
    // simultaneous last-place grabs: only one wins
    const t2 = await open({ maxEntries: 2 });
    await registerSolo(t2, c.id, {});
    const res = await Promise.allSettled([registerSolo(t2, a.id, {}), registerSolo(t2, b.id, {})]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // invitation only
    const t3 = await open({ visibility: 'invite' });
    await expect(registerSolo(t3, a.id, {})).rejects.toThrow(/invitation only/);
    await invite(t3, a.id, admin.id);
    await registerSolo(t3, a.id, {});
    // window
    const t4 = await open({ regClosesAt: new Date(Date.now() - 1000) });
    await expect(registerSolo(t4, a.id, {})).rejects.toThrow(/closed/);
  });

  it('builds teams with captains, invitations, subs and size limits', async () => {
    const t = await open({ mode: 'team', teamMin: 2, teamMax: 2, subsMax: 1 });
    const [cap, p2, p3, sub, other] = [await makeUser(), await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const team = await createTeam(t, cap.id, 'Frag Squad', 'frg');
    await expect(createTeam(t, cap.id, 'Another', '')).rejects.toThrow(/already in a team/);
    await expect(createTeam(t, other.id, 'frag squad', '')).rejects.toThrow(/already a team with that name/);
    await expect(registerTeam(t, team, {})).rejects.toThrow(/at least 2 players/);
    await inviteToTeam(t, team, p2.id, 'player');
    await answerInvite(t, team, p2.id, true);
    await expect(inviteToTeam(t, team, p3.id, 'player')).rejects.toThrow(/at most 2 players/);
    await inviteToTeam(t, team, sub.id, 'sub');
    await expect(inviteToTeam(t, team, other.id, 'sub')).rejects.toThrow(/at most 1 substitutes/);
    await answerInvite(t, team, sub.id, true);
    const e = await registerTeam(t, team, {});
    expect(e).toMatchObject({ name: 'Frag Squad', status: 'approved' });
    await expect(removeFromTeam(t, team, p2.id)).rejects.toThrow(/at least 2 players/);
    // someone already on a team can't join another
    const t2team = await createTeam(t, other.id, 'Others', '');
    await expect(inviteToTeam(t, t2team, p2.id, 'player')).rejects.toThrow(/another team/);
  });
});

describe('formats', () => {
  it('single elimination: byes, advancement and final standings', async () => {
    const { t } = await withPlayers(5, { config: { thirdPlace: true } });
    await generateBracket(t);
    const ms = await matchesOf(t.id);
    expect(ms.filter((m) => m.round === 1 && m.status === 'done' && m.loser === null)).toHaveLength(3); // byes
    await playAll(await fresh(t));
    const st = await standings(await fresh(t));
    expect(st.finished).toBe(true);
    const ids = (await entriesOf(t.id)).map((e) => e.id).sort((a, b) => a - b);
    expect(st.overall[0]).toMatchObject({ entry: ids[0], place: 1 });
    expect(st.overall.slice(0, 4).map((s) => s.place)).toEqual([1, 2, 3, 4]);
  });

  it('double elimination finishes with a champion', async () => {
    const { t } = await withPlayers(6, { format: 'double_elim' });
    await generateBracket(t);
    await playAll(await fresh(t));
    const st = await standings(await fresh(t));
    expect(st.finished).toBe(true);
    expect(st.overall.filter((s) => s.place === 1)).toHaveLength(1);
  });

  it('round robin and draws', async () => {
    const { t } = await withPlayers(4, { format: 'round_robin', config: { allowDraws: true } });
    await generateBracket(t);
    expect(await matchesOf(t.id)).toHaveLength(6);
    const first = (await matchesOf(t.id))[0];
    await overrideResult(await fresh(t), first, { scoreA: 1, scoreB: 1 });
    expect((await matchById(first.id))!.isDraw).toBe(true);
    await playAll(await fresh(t));
    expect((await standings(await fresh(t))).finished).toBe(true);
  });

  it('swiss pairs the next round when one finishes, without rematches', async () => {
    const { t } = await withPlayers(5, { format: 'swiss', config: { swissRounds: 3 } });
    await generateBracket(t);
    const r1 = await matchesOf(t.id);
    expect(r1.filter((m) => m.round === 1)).toHaveLength(3); // 2 matches + a bye
    await playAll(await fresh(t));
    const all = await matchesOf(t.id);
    expect(new Set(all.map((m) => m.round))).toEqual(new Set([1, 2, 3]));
    const pairs = all.filter((m) => m.entryA !== null && m.entryB !== null).map((m) => [m.entryA, m.entryB].sort().join('-'));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect((await standings(await fresh(t))).finished).toBe(true);
  });

  it('groups then playoffs', async () => {
    const { t } = await withPlayers(8, { format: 'groups_playoffs', config: { groups: 2, advancePerGroup: 2 } });
    await generateBracket(t);
    expect((await stagesOf(t.id))).toHaveLength(1);
    await playAll(await fresh(t));
    const sts = await stagesOf(t.id);
    expect(sts.map((s) => s.name)).toEqual(['Group stage', 'Playoffs']);
    const st = await standings(await fresh(t));
    expect(st.finished).toBe(true);
    expect(st.overall).toHaveLength(8);
    expect(st.overall[0].place).toBe(1);
  });

  it('free-for-all heats: placings, confirmation and the next round', async () => {
    const { t, users } = await withPlayers(5, { format: 'ffa', config: { ffaRounds: 2, heatSize: 3 } });
    await generateBracket(t);
    let heats = (await matchesOf(t.id)).filter((m) => m.round === 1);
    expect(heats).toHaveLength(2);
    for (const hm of heats) {
      const ids = (await heatOf(hm.id)).map((x) => x.entryId);
      const pl = Object.fromEntries(ids.map((id, i) => [String(id), i + 1]));
      const reporter = await sideUser(t, ids[0]), confirmer = await sideUser(t, ids[1]);
      expect(await reportHeat(await fresh(t), hm, { userId: reporter, entryId: ids[0], staff: false }, pl)).toBe('waiting');
      expect(await reportHeat(await fresh(t), (await matchById(hm.id))!, { userId: confirmer, entryId: ids[1], staff: false }, pl)).toBe('final');
    }
    heats = (await matchesOf(t.id)).filter((m) => m.round === 2);
    expect(heats.length).toBeGreaterThan(0);
    await expect(reportHeat(await fresh(t), heats[0], { userId: users[0].id, entryId: null, staff: false }, {})).rejects.toThrow(/placing|Only players/);
  });

  it('time challenge: attempts, verification and the leaderboard', async () => {
    const { t, users } = await withPlayers(3, { format: 'time_trial', config: { winCondition: 'lower', scoreUnit: 'time', verifyAttempts: true } });
    await generateBracket(t);
    const ents = await entriesOf(t.id);
    await submitAttempt(await fresh(t), ents[0], 62_000, '', users[0].id, false);
    await submitAttempt(await fresh(t), ents[1], 59_000, '', users[1].id, false);
    let st = await standings(await fresh(t));
    expect(Number.isNaN(st.overall[0].tiebreak)).toBe(true); // nothing approved yet
    const atts = await getDb().select().from((await import('../modules/lan-tournaments/schema.ts')).attempts);
    for (const a of atts) await reviewAttempt(await fresh(t), a.id, true, admin.id);
    await endChallenge(await fresh(t));
    st = await standings(await fresh(t));
    expect(st.overall.map((s) => s.entry).slice(0, 2)).toEqual([ents[1].id, ents[0].id]);
    expect(st.finished).toBe(true);
  });
});

describe('reporting, disputes and overrides', () => {
  it('needs both sides to agree, disputes on a mismatch, and lets a referee settle it', async () => {
    const { t } = await withPlayers(4);
    await generateBracket(t);
    const m = (await matchesOf(t.id)).find((x) => x.status === 'ready')!;
    const ua = await sideUser(t, m.entryA!), ub = await sideUser(t, m.entryB!);
    const r1 = await reportScore(await fresh(t), m, { userId: ua, side: 'a' }, { scoreA: 1, scoreB: 0 });
    expect(r1.state).toBe('waiting');
    expect((await matchById(m.id))!.status).toBe('reported');
    await confirmReport(await fresh(t), (await matchById(m.id))!, 'b', ub);
    const done = (await matchById(m.id))!;
    expect(done).toMatchObject({ status: 'done', winner: m.entryA, scoreA: 1, scoreB: 0 });
    const next = (await matchesOf(t.id)).find((x) => x.aFrom === `W:${m.code}` || x.bFrom === `W:${m.code}`)!;
    expect([next.entryA, next.entryB]).toContain(m.entryA);

    const m2 = (await matchesOf(t.id)).find((x) => x.status === 'ready' && x.id !== next.id)!;
    const ua2 = await sideUser(t, m2.entryA!), ub2 = await sideUser(t, m2.entryB!);
    await reportScore(await fresh(t), m2, { userId: ua2, side: 'a' }, { scoreA: 1, scoreB: 0 });
    await disputeReport(await fresh(t), (await matchById(m2.id))!, 'b', ub2, 'They forfeited the second half.');
    expect((await matchById(m2.id))!.status).toBe('disputed');
    await expect(reportScore(await fresh(t), (await matchById(m2.id))!, { userId: ua2, side: 'a' }, { scoreA: 1, scoreB: 0 })).rejects.toThrow(/disputed/);
    await overrideResult(await fresh(t), (await matchById(m2.id))!, { scoreA: 0, scoreB: 1 });
    expect((await matchById(m2.id))!.winner).toBe(m2.entryB);
    // the two sides reporting different scores is a dispute too
    const t2 = (await withPlayers(2)).t;
    await generateBracket(t2);
    const f = (await matchesOf(t2.id))[0];
    await reportScore(await fresh(t2), f, { userId: await sideUser(t2, f.entryA!), side: 'a' }, { scoreA: 1, scoreB: 0 });
    const r = await reportScore(await fresh(t2), (await matchById(f.id))!, { userId: await sideUser(t2, f.entryB!), side: 'b' }, { scoreA: 0, scoreB: 1 });
    expect(r.state).toBe('disputed');
  });

  it('corrects a result while later matches are unplayed, and refuses once they’ve been played', async () => {
    const { t } = await withPlayers(4);
    await generateBracket(t);
    const [sf1, sf2] = (await matchesOf(t.id)).filter((m) => m.round === 1);
    await overrideResult(await fresh(t), sf1, { scoreA: 1, scoreB: 0 });
    await overrideResult(await fresh(t), (await matchById(sf1.id))!, { scoreA: 0, scoreB: 1 }); // correct it
    let final = (await matchesOf(t.id)).find((m) => m.round === 2)!;
    expect(final.entryA).toBe(sf1.entryB);
    await overrideResult(await fresh(t), sf2, { scoreA: 1, scoreB: 0 });
    final = (await matchesOf(t.id)).find((m) => m.round === 2)!;
    await overrideResult(await fresh(t), final, { scoreA: 1, scoreB: 0 });
    await expect(overrideResult(await fresh(t), (await matchById(sf1.id))!, { scoreA: 1, scoreB: 0 })).rejects.toThrow(/already been played/);
  });

  it('validates scores and rejects stale forms', async () => {
    const { t } = await withPlayers(2, { config: { bestOf: 3 } });
    await generateBracket(t);
    const m = (await matchesOf(t.id))[0];
    await expect(overrideResult(await fresh(t), m, { scoreA: 3, scoreB: 0 })).rejects.toThrow(/exactly 2/);
    await expect(overrideResult(await fresh(t), m, { scoreA: 2, scoreB: 0 }, m.version + 5)).rejects.toThrow(/changed while you were looking/);
  });

  it('never double-advances under concurrent submissions', async () => {
    const { t } = await withPlayers(8);
    await generateBracket(t);
    const r1 = (await matchesOf(t.id)).filter((m) => m.round === 1);
    // the same match decided twice at once: exactly one wins
    const same = await Promise.allSettled([overrideResult(await fresh(t), r1[0], { scoreA: 1, scoreB: 0 }), overrideResult(await fresh(t), r1[0], { scoreA: 0, scoreB: 1 })]);
    expect(same.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    // all the other first-round matches at once: every winner lands in exactly one slot
    await Promise.all(r1.slice(1).map(async (m) => overrideResult(await fresh(t), m, { scoreA: 1, scoreB: 0 })));
    const r2 = (await matchesOf(t.id)).filter((m) => m.round === 2);
    const placed = r2.flatMap((m) => [m.entryA, m.entryB]);
    expect(placed.every((x) => x !== null)).toBe(true);
    expect(new Set(placed).size).toBe(4);
  });

  it('lets organisers swap unplayed entries and reset the bracket', async () => {
    const { t } = await withPlayers(4);
    await generateBracket(t);
    const [a, b] = (await matchesOf(t.id)).filter((m) => m.round === 1);
    await swapEntries(await fresh(t), a.entryA!, b.entryA!);
    expect((await matchById(a.id))!.entryA).toBe(b.entryA);
    await overrideResult(await fresh(t), (await matchById(a.id))!, { scoreA: 1, scoreB: 0 });
    await expect(resetBracket(await fresh(t))).rejects.toThrow(/already been played/);
    await resetBracket(await fresh(t), { force: true });
    expect((await fresh(t)).status).toBe('registration_closed');
    expect(await matchesOf(t.id)).toHaveLength(0);
  });
});

describe('completion and results', () => {
  it('publishes standings with ranking points, then shows them on the leaderboard and profiles', async () => {
    const { t, users } = await withPlayers(4, { config: { rankingPoints: [100, 50, 25], participationPoints: 5, thirdPlace: true } });
    await generateBracket(t);
    await expect(publishResults(await fresh(t), admin.id)).rejects.toThrow(/Not every match/);
    await playAll(await fresh(t));
    await publishResults(await fresh(t), admin.id);
    expect((await fresh(t)).status).toBe('completed');
    const rows = await getDb().select().from(results).where(eq(results.tournamentId, t.id));
    expect(rows.map((r) => [r.place, r.points]).sort((a, b) => a[0] - b[0])).toEqual([[1, 105], [2, 55], [3, 30], [4, 5]]);
    const champ = rows.find((r) => r.place === 1)!;
    const lb = await client().get('/m/lan-tournaments/leaderboard');
    expect(lb.text).toContain('Tournament leaderboard');
    const winner = users.find((u) => u.id === champ.userId)!;
    expect((await client().get(`/u/${winner.username}`)).text).toContain('Tournaments');
    const notes = await getDb().select().from(schema.notifications).where(and(eq(schema.notifications.userId, winner.id), eq(schema.notifications.kind, 'lan-tournaments')));
    expect(notes.some((x) => /finished 1st/.test(x.text))).toBe(true);
    // the achievements module counts tournament wins
    const awards = await getDb().execute(`select d.key from user_achievements a join achievement_definitions d on d.id = a.achievement_id where a.user_id = ${winner.id}` as any) as any;
    expect((awards.rows ?? awards).map((r: any) => r.key)).toContain('tournament-champion');
  });
});

describe('permissions over HTTP', () => {
  it('keeps organiser and referee powers apart', async () => {
    await makeUser({ username: 'TourneyBoss', group: 'admin' });
    const ref = await makeUser({ username: 'TourneyRef' });
    const player = await makeUser({ username: 'TourneyPlayer' });
    await makeUser({ username: 'TourneyRival' });
    const boss = client(); await boss.login('TourneyBoss');
    const created = await boss.post('/m/lan-tournaments/new', { name: 'HTTP Cup', game: 'Quake', format: 'single_elim', mode: 'solo', visibility: 'public', bestOf: '1', finalBestOf: '1' });
    expect(created.location).toMatch(/^\/m\/lan-tournaments\/http-cup\/manage$/);
    const t = (await getDb().select().from(tournaments).where(eq(tournaments.slug, 'http-cup')))[0];
    await boss.post('/m/lan-tournaments/http-cup/manage/status', { to: 'registration_open' });
    await boss.post('/m/lan-tournaments/http-cup/manage/staff', { username: 'TourneyRef', role: 'referee' });

    const p = client(); await p.login('TourneyPlayer');
    expect((await p.get('/m/lan-tournaments/new')).status).toBe(403);
    expect((await p.get('/m/lan-tournaments/http-cup/manage')).status).toBe(403);
    await p.post('/m/lan-tournaments/http-cup/register');
    const rival = client(); await rival.login('TourneyRival');
    await rival.post('/m/lan-tournaments/http-cup/register');
    expect(await entriesOf(t.id)).toHaveLength(2);
    expect((await client().post('/m/lan-tournaments/http-cup/register')).status).toBe(403); // no CSRF session as a guest

    // the referee can't generate the bracket or publish, but can settle scores
    const r = client(); await r.login('TourneyRef');
    await r.post('/m/lan-tournaments/http-cup/manage/generate');
    expect((await byId(t.id))!.status).toBe('registration_open');
    await boss.post('/m/lan-tournaments/http-cup/manage/generate');
    expect((await byId(t.id))!.status).toBe('in_progress');
    const m = (await matchesOf(t.id))[0];
    // a player can't use the referee override
    await p.post(`/m/lan-tournaments/http-cup/match/${m.id}/override`, { scoreA: '1', scoreB: '0' });
    expect((await matchById(m.id))!.status).toBe('ready');
    await r.post(`/m/lan-tournaments/http-cup/match/${m.id}/override`, { scoreA: '1', scoreB: '0', version: String(m.version) });
    expect((await matchById(m.id))!.status).toBe('done');
    await r.post('/m/lan-tournaments/http-cup/manage/publish');
    expect((await byId(t.id))!.status).toBe('in_progress');
    await boss.post('/m/lan-tournaments/http-cup/manage/publish');
    expect((await byId(t.id))!.status).toBe('completed');
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'lan-tournaments.results.publish'));
    expect(audit).toHaveLength(1);
    // pages render for everyone
    for (const path of ['/m/lan-tournaments', '/m/lan-tournaments/http-cup', '/m/lan-tournaments/http-cup?tab=bracket', '/m/lan-tournaments/http-cup?tab=standings', '/m/lan-tournaments/http-cup/live', `/m/lan-tournaments/http-cup/match/${m.id}`, '/m/lan-tournaments/http-cup/data.json'])
      expect((await client().get(path)).status).toBe(200);
    void ref; void player;
  });

  it('hides drafts and private tournaments', async () => {
    const draft = await createTournament({ ...base, name: 'Secret Draft' }, admin.id);
    expect((await client().get(`/m/lan-tournaments/${draft.slug}`)).status).toBe(404);
    const priv = await open({ name: 'Private Cup', visibility: 'private' });
    expect((await client().get(`/m/lan-tournaments/${priv.slug}`)).status).toBe(404);
    expect((await client().get('/m/lan-tournaments')).text).not.toContain('Private Cup');
  });
});

describe('LAN event integration', () => {
  it('requires a booked place, uses seats as stations, and shows on LAN HQ', async () => {
    const [ev] = await getDb().insert(seatEvents).values({ slug: 'tourney-lan', name: 'Tourney LAN', layout: 'SSSS', status: 'open', startsAt: new Date(Date.now() + 86_400_000) }).returning();
    await setUpBookings(ev.id);
    await getDb().update(bookingConfigs).set({ status: 'open', rules: '' }).where(eq(bookingConfigs.eventId, ev.id));
    const [standard] = await typesFor(ev.id);
    const t = await open({ name: 'LAN Cup', lanEventId: ev.id, requireBooking: true });
    const booked = await makeUser(), unbooked = await makeUser();
    const tFresh = await fresh(t);
    const elig = { isBooked: async (u: number) => (await exposedApi<{ isBooked(e: number, u: number): Promise<boolean> }>('lan-bookings')!.isBooked(ev.id, u)) };
    await expect(registerSolo(tFresh, unbooked.id, elig)).rejects.toThrow(/Book a place/);
    const seating = exposedApi<{ seatFor(e: number, u: number): Promise<string | null> }>('lan-seating')!;
    await bookPlace({ ...seating, eventById: async () => null } as any, ev.id, booked.id, standard.id, '', { acceptedTerms: true });
    await registerSolo(tFresh, booked.id, elig);
    await bookSeat(ev, booked.id, 'A2');
    // stations from seats over HTTP
    await makeUser({ username: 'LanTourneyBoss', group: 'admin' });
    const boss = client(); await boss.login('LanTourneyBoss');
    await boss.post(`/m/lan-tournaments/${t.slug}/manage/stations`);
    expect((await entriesOf(t.id))[0].station).toBe('Seat A2');
    // check-in by staff, then shown on LAN HQ and in its API
    await checkIn(tFresh, (await entriesOf(t.id))[0], { byStaff: true });
    const api = exposedApi<{ liveSummary(e: number | null): Promise<{ name: string }[]> }>('lan-tournaments')!;
    expect((await api.liveSummary(ev.id)).map((x) => x.name)).toContain('LAN Cup');
    const { saveModuleSettings } = await import('../src/modules/runtime.ts');
    await saveModuleSettings('lan-intranet', { sections: 'tournaments,schedule' });
    expect((await client().get('/m/lan-intranet')).text).toContain('LAN Cup');
  });
});

describe('privacy', () => {
  it('exports and erases tournament data while keeping results intact', async () => {
    const { t, users } = await withPlayers(2);
    await generateBracket(t);
    await playAll(await fresh(t));
    await publishResults(await fresh(t), admin.id);
    const u = users[0];
    const data = await Privacy.exportUserData(u.id);
    expect((data.addOns['lan-tournaments'].data as any).results).toHaveLength(1);
    await Privacy.eraseUserData(u.id, new Set(['modules']), { ip: null });
    const rows = await getDb().select().from(results).where(eq(results.tournamentId, t.id));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.userId === u.id)).toBe(false);
    expect(rows.some((r) => r.name === 'Former member')).toBe(true);
    void setStaff;
  });
});
