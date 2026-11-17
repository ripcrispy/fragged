/**
 * The tournament engine: bracket and schedule generation, score validation and standings, as pure functions over
 * plain data. The database layer (service.ts) stores what these produce and applies progression in transactions.
 *
 * A planned match has two slots. A slot is either a known entry, the winner or loser of another match
 * ("W:code" / "L:code"), or a bye. When a match finishes, the slots fed by it are filled; a slot whose source
 * produced nobody (a walkover has no loser) is "dead", and a match with one live entry and one dead slot is a
 * walkover. That one rule handles byes in single and double elimination at any bracket size.
 */

export const FORMATS = {
  single_elim: 'Single elimination',
  double_elim: 'Double elimination',
  round_robin: 'Round robin',
  swiss: 'Swiss system',
  groups_playoffs: 'Group stage, then playoffs',
  ffa: 'Free-for-all heats',
  time_trial: 'Time or score challenge',
} as const;
export type FormatId = keyof typeof FORMATS;
export type StageKind = 'single_elim' | 'double_elim' | 'round_robin' | 'swiss' | 'ffa' | 'time_trial';

export interface FormatConfig {
  /** games per match: 1, 3, 5 or 7 */
  bestOf: number;
  /** best-of for finals (and grand finals) */
  finalBestOf?: number;
  /** single elimination: play a match for 3rd place */
  thirdPlace?: boolean;
  /** double elimination: a second grand final if the losers'-bracket finalist wins the first */
  grandFinalReset?: boolean;
  /** swiss: number of rounds (default: ceil(log2(entries))) */
  swissRounds?: number;
  /** group stage: number of groups and how many go through from each */
  groups?: number;
  advancePerGroup?: number;
  /** group stage playoffs */
  playoff?: 'single_elim' | 'double_elim';
  /** free-for-all: number of rounds, heat size and points per placing (1st, 2nd, …) */
  ffaRounds?: number;
  heatSize?: number;
  ffaPoints?: number[];
  /** round robin / swiss / groups: points for a win, draw and loss */
  points?: { win: number; draw: number; loss: number };
  allowDraws?: boolean;
  /** best-of-1 scores and time challenges: does the higher or the lower value win? */
  winCondition?: 'higher' | 'lower';
  /** time challenge: how values are shown */
  scoreUnit?: 'points' | 'time';
  /** time challenge: attempts need a referee's approval before they count */
  verifyAttempts?: boolean;
  seeding?: 'registration' | 'random' | 'manual';
  /** ranking points for final places (1st, 2nd, 3rd, …) and for everyone who took part */
  rankingPoints?: number[];
  participationPoints?: number;
}

/** Finals use the normal best-of unless `finalBestOf` is set. */
export const DEFAULT_CONFIG: Required<Omit<FormatConfig, 'swissRounds' | 'finalBestOf'>> & { swissRounds?: number; finalBestOf?: number } = {
  bestOf: 1, thirdPlace: false, grandFinalReset: true, groups: 2, advancePerGroup: 2, playoff: 'single_elim',
  ffaRounds: 3, heatSize: 8, ffaPoints: [10, 8, 6, 5, 4, 3, 2, 1], points: { win: 3, draw: 1, loss: 0 }, allowDraws: false,
  winCondition: 'higher', scoreUnit: 'points', verifyAttempts: true, seeding: 'registration', rankingPoints: [100, 70, 50, 35, 25, 20, 15, 10], participationPoints: 5,
};
export const withDefaults = (c: Partial<FormatConfig>): FormatConfig & typeof DEFAULT_CONFIG => ({ ...DEFAULT_CONFIG, ...c, points: { ...DEFAULT_CONFIG.points, ...(c.points ?? {}) } });

export type Slot = { entry: number } | { from: string } | { bye: true };
export interface PlannedMatch { code: string; bracket: string; round: number; position: number; bestOf: number; a: Slot; b: Slot }
export interface PlannedHeat { code: string; round: number; position: number; entries: number[] }

// ───────────────────────────── seeding ─────────────────────────────

export const nextPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

/** Standard bracket order for a power-of-two size: 1 meets the last seed, and 1 and 2 can only meet in the final. */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order.slice(0, size);
}

/** Deterministic shuffle (so tests and re-generation are reproducible for the same seed value). */
export function shuffle<T>(list: T[], seed: number): T[] {
  const a = [...list];
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ───────────────────────────── elimination ─────────────────────────────

const W = (code: string): Slot => ({ from: `W:${code}` });
const L = (code: string): Slot => ({ from: `L:${code}` });

/** Single elimination over seeded entries (best first). Byes go to the top seeds. */
export function singleElimination(seeded: number[], cfg: FormatConfig, prefix = 'R'): PlannedMatch[] {
  if (seeded.length < 2) throw new Error('At least 2 entries are needed.');
  const size = nextPow2(seeded.length);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const slotFor = (seed: number): Slot => (seed <= seeded.length ? { entry: seeded[seed - 1] } : { bye: true });
  const bo = (r: number) => (r === rounds ? cfg.finalBestOf ?? cfg.bestOf : cfg.bestOf);
  const out: PlannedMatch[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let p = 0; p < count; p++) {
      const code = `${prefix}${r}-${p + 1}`;
      const a = r === 1 ? slotFor(order[2 * p]) : W(`${prefix}${r - 1}-${2 * p + 1}`);
      const b = r === 1 ? slotFor(order[2 * p + 1]) : W(`${prefix}${r - 1}-${2 * p + 2}`);
      out.push({ code, bracket: 'W', round: r, position: p + 1, bestOf: bo(r), a, b });
    }
  }
  if (cfg.thirdPlace && rounds >= 2) {
    out.push({ code: '3RD', bracket: '3RD', round: rounds, position: 2, bestOf: cfg.finalBestOf ?? cfg.bestOf, a: L(`${prefix}${rounds - 1}-1`), b: L(`${prefix}${rounds - 1}-2`) });
  }
  return out;
}

/** Double elimination: a winners' bracket, a losers' bracket and a grand final (with an optional reset). */
export function doubleElimination(seeded: number[], cfg: FormatConfig): PlannedMatch[] {
  if (seeded.length < 3) throw new Error('Double elimination needs at least 3 entries.');
  const size = Math.max(4, nextPow2(seeded.length));
  const k = Math.log2(size);
  const order = seedOrder(size);
  const slotFor = (seed: number): Slot => (seed <= seeded.length ? { entry: seeded[seed - 1] } : { bye: true });
  const out: PlannedMatch[] = [];
  const wb = (r: number, p: number) => `W${r}-${p}`;
  const lb = (r: number, p: number) => `L${r}-${p}`;
  for (let r = 1; r <= k; r++) {
    for (let p = 1; p <= size / 2 ** r; p++) {
      out.push({ code: wb(r, p), bracket: 'W', round: r, position: p, bestOf: r === k ? cfg.finalBestOf ?? cfg.bestOf : cfg.bestOf,
        a: r === 1 ? slotFor(order[2 * p - 2]) : W(wb(r - 1, 2 * p - 1)), b: r === 1 ? slotFor(order[2 * p - 1]) : W(wb(r - 1, 2 * p)) });
    }
  }
  // losers' bracket: round 1 pairs winners'-round-1 losers; then alternating "drop-in" and "consolidation" rounds
  let lr = 1;
  for (let p = 1; p <= size / 4; p++) out.push({ code: lb(1, p), bracket: 'L', round: 1, position: p, bestOf: cfg.bestOf, a: L(wb(1, 2 * p - 1)), b: L(wb(1, 2 * p)) });
  for (let j = 1; j <= k - 1; j++) {
    lr = 2 * j;
    const count = size / 2 ** (j + 1);
    for (let p = 1; p <= count; p++) {
      // drop-ins come in reverse order on alternate rounds so players don't meet the same opponent again too soon
      const drop = j % 2 === 1 ? count + 1 - p : p;
      out.push({ code: lb(lr, p), bracket: 'L', round: lr, position: p, bestOf: cfg.bestOf, a: W(lb(lr - 1, p)), b: L(wb(j + 1, drop)) });
    }
    if (j < k - 1) {
      for (let p = 1; p <= count / 2; p++) out.push({ code: lb(lr + 1, p), bracket: 'L', round: lr + 1, position: p, bestOf: cfg.bestOf, a: W(lb(lr, 2 * p - 1)), b: W(lb(lr, 2 * p)) });
    }
  }
  const gfBo = cfg.finalBestOf ?? cfg.bestOf;
  out.push({ code: 'GF1', bracket: 'GF', round: 1, position: 1, bestOf: gfBo, a: W(wb(k, 1)), b: W(lb(lr, 1)) });
  if (cfg.grandFinalReset) out.push({ code: 'GF2', bracket: 'GF', round: 2, position: 1, bestOf: gfBo, a: W('GF1'), b: L('GF1') });
  return out;
}

// ───────────────────────────── round robin and groups ─────────────────────────────

/** Every entry plays every other once (circle method). */
export function roundRobin(entries: number[], cfg: FormatConfig, group = 'A'): PlannedMatch[] {
  if (entries.length < 2) throw new Error('A group needs at least 2 entries.');
  const list: (number | null)[] = [...entries];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const out: PlannedMatch[] = [];
  for (let r = 0; r < n - 1; r++) {
    let pos = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a === null || b === null) continue;
      // alternate home/away so nobody is always "side A"
      const [x, y] = r % 2 ? [b, a] : [a, b];
      out.push({ code: `G${group}R${r + 1}-${++pos}`, bracket: group, round: r + 1, position: pos, bestOf: cfg.bestOf, a: { entry: x }, b: { entry: y } });
    }
    list.splice(1, 0, list.pop()!);
  }
  return out;
}

/** Snake seeding into groups: 1→A, 2→B, …, then back the other way, so groups are balanced. */
export function splitGroups(seeded: number[], groups: number): number[][] {
  const out: number[][] = Array.from({ length: groups }, () => []);
  seeded.forEach((e, i) => {
    const lap = Math.floor(i / groups), pos = i % groups;
    out[lap % 2 ? groups - 1 - pos : pos].push(e);
  });
  return out;
}
export const groupLabel = (i: number) => String.fromCharCode(65 + i);

/** Playoff seeds from group standings: all group winners first (A1, B1, …), then runners-up, and so on. */
export function playoffSeeds(groupRanks: number[][], advance: number): number[] {
  const out: number[] = [];
  for (let place = 0; place < advance; place++) for (const g of groupRanks) if (g[place] !== undefined) out.push(g[place]);
  return out;
}

// ───────────────────────────── swiss ─────────────────────────────

export interface SwissState { entry: number; points: number; seed: number; opponents: Set<number>; hadBye: boolean }

/**
 * Pair a swiss round: highest points first, never a rematch when avoidable, and a bye (a free win) for the lowest
 * ranked entry that hasn't had one yet.
 */
export function swissPairings(state: SwissState[]): { pairs: [number, number][]; bye: number | null } {
  const ranked = [...state].sort((a, b) => b.points - a.points || a.seed - b.seed);
  let bye: number | null = null;
  if (ranked.length % 2) {
    const pick = [...ranked].reverse().find((s) => !s.hadBye) ?? ranked[ranked.length - 1];
    bye = pick.entry;
    ranked.splice(ranked.indexOf(pick), 1);
  }
  const byId = new Map(state.map((s) => [s.entry, s]));
  const solve = (left: SwissState[], allowRematch: boolean): [number, number][] | null => {
    if (!left.length) return [];
    const [first, ...rest] = left;
    for (let i = 0; i < rest.length; i++) {
      if (!allowRematch && byId.get(first.entry)!.opponents.has(rest[i].entry)) continue;
      const sub = solve([...rest.slice(0, i), ...rest.slice(i + 1)], allowRematch);
      if (sub) return [[first.entry, rest[i].entry], ...sub];
    }
    return null;
  };
  const pairs = (ranked.length <= 24 ? solve(ranked, false) : null) ?? solve(ranked, true) ?? [];
  return { pairs, bye };
}
export const swissRoundsFor = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

// ───────────────────────────── free-for-all ─────────────────────────────

/** Split entries (best first) into heats of at most `size`, snaking so every heat gets a mix. */
export function ffaHeats(ranked: number[], size: number, round: number): PlannedHeat[] {
  const count = Math.max(1, Math.ceil(ranked.length / size));
  return splitGroups(ranked, count).map((entries, i) => ({ code: `H${round}-${i + 1}`, round, position: i + 1, entries }));
}
export const ffaPointsFor = (placement: number, table: number[]) => table[placement - 1] ?? 0;

// ───────────────────────────── scores ─────────────────────────────

/**
 * Validate a head-to-head score. Best-of-N scores are games won (first to ceil(N/2)); best-of-1 scores are the
 * game's score, and the higher (or lower, if the tournament says so) wins. Returns the winning side or 'draw'.
 */
export function judgeScore(bestOf: number, a: number, b: number, cfg: Pick<FormatConfig, 'allowDraws' | 'winCondition'>): 'a' | 'b' | 'draw' {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 9999 || b > 9999) throw new Error('Scores must be whole numbers from 0 to 9999.');
  if (bestOf > 1) {
    const need = Math.ceil(bestOf / 2);
    if (Math.max(a, b) !== need || Math.min(a, b) >= need) throw new Error(`In a best of ${bestOf} the winner has exactly ${need} game wins and the loser fewer.`);
    return a > b ? 'a' : 'b';
  }
  if (a === b) {
    if (cfg.allowDraws) return 'draw';
    throw new Error('Draws aren’t allowed in this tournament.');
  }
  const higherWins = cfg.winCondition !== 'lower';
  return (a > b) === higherWins ? 'a' : 'b';
}

/** Placings for a heat: 1..n with no gaps or repeats, covering every entry. */
export function checkPlacements(entries: number[], placements: Record<string, number>) {
  const vals = entries.map((e) => placements[String(e)]);
  if (vals.some((v) => !Number.isInteger(v) || v < 1 || v > entries.length)) throw new Error('Give every entry a placing from 1 to the number of entries.');
  if (new Set(vals).size !== vals.length) throw new Error('Each placing can only be used once.');
}

/** Time challenge values: whole numbers (milliseconds for times, points otherwise). */
export function parseValue(raw: string, unit: FormatConfig['scoreUnit']): number | null {
  const s = raw.trim();
  if (unit === 'time') {
    const m = /^(?:(\d{1,3}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
    if (!m) return null;
    const ms = (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number((m[3] ?? '0').padEnd(3, '0'));
    return Number(m[2]) < 60 || !m[1] ? ms : null;
  }
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
}
export function formatValue(v: number, unit: FormatConfig['scoreUnit']): string {
  if (unit !== 'time') return String(v);
  const m = Math.floor(v / 60000), s = Math.floor((v % 60000) / 1000), ms = v % 1000;
  return `${m ? `${m}:${String(s).padStart(2, '0')}` : s}.${String(ms).padStart(3, '0')}`;
}

// ───────────────────────────── standings ─────────────────────────────

export interface MatchLike {
  code: string; bracket: string; round: number; stageIdx: number;
  entryA: number | null; entryB: number | null; scoreA: number | null; scoreB: number | null;
  winner: number | null; loser: number | null; isDraw: boolean; status: string;
}
export interface Standing { entry: number; place: number; played: number; wins: number; draws: number; losses: number; points: number; scoreFor: number; scoreAgainst: number; tiebreak: number }

function blank(entry: number): Standing { return { entry, place: 0, played: 0, wins: 0, draws: 0, losses: 0, points: 0, scoreFor: 0, scoreAgainst: 0, tiebreak: 0 }; }

/** Win/draw/loss records from finished head-to-head matches (walkovers don't count as played). */
export function records(entries: number[], ms: MatchLike[], pts = DEFAULT_CONFIG.points): Map<number, Standing> {
  const t = new Map(entries.map((e) => [e, blank(e)]));
  for (const m of ms) {
    if (m.status !== 'done' || m.entryA === null || m.entryB === null) continue;
    const a = t.get(m.entryA), b = t.get(m.entryB);
    if (!a || !b) continue;
    a.played++; b.played++;
    a.scoreFor += m.scoreA ?? 0; a.scoreAgainst += m.scoreB ?? 0; b.scoreFor += m.scoreB ?? 0; b.scoreAgainst += m.scoreA ?? 0;
    if (m.isDraw) { a.draws++; b.draws++; a.points += pts.draw; b.points += pts.draw; }
    else if (m.winner === m.entryA) { a.wins++; b.losses++; a.points += pts.win; b.points += pts.loss; }
    else if (m.winner === m.entryB) { b.wins++; a.losses++; b.points += pts.win; a.points += pts.loss; }
  }
  return t;
}

/** Give places to a sorted list; entries that compare equal share a place (1, 2, 2, 4…). */
export function assignPlaces(sorted: Standing[], same: (a: Standing, b: Standing) => boolean): Standing[] {
  sorted.forEach((s, i) => { s.place = i > 0 && same(sorted[i - 1], s) ? sorted[i - 1].place : i + 1; });
  return sorted;
}

/** League table (round robin and groups): points, then score difference, then score for, then wins. */
export function leagueTable(entries: number[], ms: MatchLike[], cfg: FormatConfig): Standing[] {
  const rows = [...records(entries, ms, cfg.points ?? DEFAULT_CONFIG.points).values()];
  const key = (s: Standing) => [s.points, s.scoreFor - s.scoreAgainst, s.scoreFor, s.wins];
  const cmp = (a: Standing, b: Standing) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
  return assignPlaces(rows.sort(cmp), (a, b) => cmp(a, b) === 0);
}

/** Swiss table: points, then Buchholz (the sum of opponents' points), then score difference. Byes count as wins. */
export function swissTable(entries: number[], ms: MatchLike[], byes: Map<number, number>, cfg: FormatConfig): Standing[] {
  const pts = cfg.points ?? DEFAULT_CONFIG.points;
  const t = records(entries, ms, pts);
  for (const [e, n] of byes) { const s = t.get(e); if (s) { s.wins += n; s.points += n * pts.win; } }
  for (const s of t.values()) {
    s.tiebreak = ms.filter((m) => m.status === 'done' && m.entryA !== null && m.entryB !== null && (m.entryA === s.entry || m.entryB === s.entry))
      .reduce((sum, m) => sum + (t.get(m.entryA === s.entry ? m.entryB! : m.entryA!)?.points ?? 0), 0);
  }
  const cmp = (a: Standing, b: Standing) => b.points - a.points || b.tiebreak - a.tiebreak || (b.scoreFor - b.scoreAgainst) - (a.scoreFor - a.scoreAgainst);
  return assignPlaces([...t.values()].sort(cmp), (a, b) => cmp(a, b) === 0);
}

/**
 * Elimination placings: the champion first, then by how late each entry was knocked out. Entries knocked out in
 * the same round share a place (e.g. both semi-final losers are 3rd unless a 3rd-place match is played).
 */
export function eliminationTable(entries: number[], ms: MatchLike[], double: boolean): Standing[] {
  const t = records(entries, ms);
  const maxRound = Math.max(0, ...ms.map((m) => m.round));
  // how late an elimination is: losers' bracket rounds and the grand final come after the winners' bracket
  // (single elimination counts in tens so the 3rd-place match slots in just above the other semi-final losers)
  const depth = (m: MatchLike) => {
    if (m.bracket === 'GF') return 1000 + m.round;
    if (m.bracket === '3RD') return (m.round - 1) * 10 + 1;
    if (double) return m.bracket === 'L' ? 100 + m.round : m.round;
    return m.round * 10;
  };
  const out = new Map<number, number>();
  for (const m of ms) {
    if (m.status !== 'done' || m.loser === null) continue;
    if (double && m.bracket === 'W') continue; // losing in the winners' bracket only drops you down
    if (m.code === 'GF1' && m.winner === m.entryB && ms.some((x) => x.code === 'GF2')) continue; // the reset decides it
    out.set(m.loser, Math.max(out.get(m.loser) ?? 0, depth(m)));
  }
  // the 3rd-place match ranks its two players above the other semi-final losers, winner first
  const bronze = ms.find((m) => m.bracket === '3RD' && m.status === 'done');
  if (bronze?.winner) out.set(bronze.winner, (bronze.round - 1) * 10 + 2);
  const finals = ms.filter((m) => m.status === 'done' && (m.bracket === 'GF' || (!double && m.bracket === 'W' && m.round === maxRound)));
  const last = finals.sort((a, b) => depth(b) - depth(a))[0];
  if (last?.winner) out.set(last.winner, 10_000);
  for (const s of t.values()) s.tiebreak = out.get(s.entry) ?? -1;
  const rows = [...t.values()].sort((a, b) => b.tiebreak - a.tiebreak || b.wins - a.wins);
  return assignPlaces(rows, (a, b) => a.tiebreak === b.tiebreak && (a.tiebreak !== -1 || a.wins === b.wins));
}

/** Free-for-all table: total placing points, then number of 1st places, then best average placing. */
export function ffaTable(entries: number[], heats: { entry: number; placement: number | null; points: number | null }[]): Standing[] {
  const t = new Map(entries.map((e) => [e, { ...blank(e), sum: 0 }]));
  for (const h of heats) {
    const s = t.get(h.entry);
    if (!s || h.placement === null) continue;
    s.played++; s.points += h.points ?? 0; s.sum += h.placement;
    if (h.placement === 1) s.wins++;
  }
  for (const s of t.values()) s.tiebreak = s.played ? -s.sum / s.played : -999;
  const cmp = (a: Standing, b: Standing) => b.points - a.points || b.wins - a.wins || b.tiebreak - a.tiebreak;
  return assignPlaces([...t.values()].sort(cmp), (a, b) => cmp(a, b) === 0);
}

/** Time challenge table: each entry's best counted attempt; entries without one come last. */
export function challengeTable(entries: number[], best: Map<number, number>, lowerWins: boolean): Standing[] {
  const rows = entries.map((e) => ({ ...blank(e), tiebreak: best.get(e) ?? NaN }));
  const has = (s: Standing) => !Number.isNaN(s.tiebreak);
  const cmp = (a: Standing, b: Standing) => (has(a) !== has(b) ? (has(a) ? -1 : 1) : !has(a) ? 0 : lowerWins ? a.tiebreak - b.tiebreak : b.tiebreak - a.tiebreak);
  return assignPlaces(rows.sort(cmp), (a, b) => cmp(a, b) === 0);
}

// ───────────────────────────── progression ─────────────────────────────

export interface LiveMatch {
  code: string;
  entryA: number | null; entryB: number | null;
  aFrom: string | null; bFrom: string | null;
  status: string; winner: number | null; loser: number | null;
}
export const FINISHED = new Set(['done', 'void']);

/** Planned slot → the stored form: an entry, or a "W:code" / "L:code" / "BYE" source. */
export function slotColumns(s: Slot): { entry: number | null; from: string | null } {
  if ('entry' in s) return { entry: s.entry, from: null };
  if ('bye' in s) return { entry: null, from: 'BYE' };
  return { entry: null, from: s.from };
}

/**
 * Fill slots from finished matches and settle walkovers until nothing changes. Returns the codes of matches that
 * changed. Idempotent: running it twice changes nothing the second time, so an entry can never advance twice.
 */
export function propagate(ms: LiveMatch[]): Set<string> {
  const byCode = new Map(ms.map((m) => [m.code, m]));
  const changed = new Set<string>();
  const feed = (from: string | null): { settled: boolean; entry: number | null } => {
    if (from === null) return { settled: false, entry: null };
    if (from === 'BYE') return { settled: true, entry: null };
    const [kind, code] = from.split(':');
    const src = byCode.get(code);
    if (!src || !FINISHED.has(src.status)) return { settled: false, entry: null };
    return { settled: true, entry: src.status === 'void' ? null : kind === 'W' ? src.winner : src.loser };
  };
  for (let guard = 0; guard < ms.length * 4 + 10; guard++) {
    let any = false;
    for (const m of ms) {
      if (FINISHED.has(m.status)) continue;
      // a grand-final reset is only played when the losers'-bracket finalist wins the first grand final
      if (m.code === 'GF2') {
        const gf1 = byCode.get('GF1');
        if (gf1?.status === 'done' && gf1.winner === gf1.entryA) { m.status = 'void'; changed.add(m.code); any = true; continue; }
      }
      const fa = m.entryA !== null ? { settled: true, entry: m.entryA } : feed(m.aFrom);
      const fb = m.entryB !== null ? { settled: true, entry: m.entryB } : feed(m.bFrom);
      if (m.entryA === null && fa.entry !== null) { m.entryA = fa.entry; changed.add(m.code); any = true; }
      if (m.entryB === null && fb.entry !== null) { m.entryB = fb.entry; changed.add(m.code); any = true; }
      if (!fa.settled || !fb.settled) continue;
      if (m.entryA !== null && m.entryB !== null) {
        if (m.status === 'pending') { m.status = 'ready'; changed.add(m.code); any = true; }
      } else if (m.entryA !== null || m.entryB !== null) {
        m.status = 'done'; m.winner = m.entryA ?? m.entryB; m.loser = null; changed.add(m.code); any = true; // walkover
      } else {
        m.status = 'void'; changed.add(m.code); any = true;
      }
    }
    if (!any) break;
  }
  return changed;
}

/** Matches whose slots come from this one (directly), so a result can only be undone while they're unplayed. */
export function dependents(ms: LiveMatch[], code: string): LiveMatch[] {
  return ms.filter((m) => m.aFrom === `W:${code}` || m.aFrom === `L:${code}` || m.bFrom === `W:${code}` || m.bFrom === `L:${code}` || (m.code === 'GF2' && code === 'GF1'));
}
