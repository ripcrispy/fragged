/** The tournament engine (pure): generation for every format, progression, scores and standings. */
import { describe, it, expect } from 'vitest';
import {
  seedOrder, singleElimination, doubleElimination, roundRobin, splitGroups, playoffSeeds, swissPairings, ffaHeats, judgeScore, checkPlacements,
  parseValue, formatValue, propagate, slotColumns, eliminationTable, leagueTable, swissTable, ffaTable, challengeTable, withDefaults, shuffle,
  type LiveMatch, type MatchLike, type PlannedMatch, type SwissState,
} from '../modules/lan-tournaments/formats.ts';

const cfg = withDefaults({});
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Play a bracket to the end, picking winners with the given function; returns the live matches. */
function play(planned: PlannedMatch[], pick: (m: LiveMatch) => number) {
  const ms: (LiveMatch & { round: number; bracket: string })[] = planned.map((p) => {
    const a = slotColumns(p.a), b = slotColumns(p.b);
    return { code: p.code, round: p.round, bracket: p.bracket, entryA: a.entry, entryB: b.entry, aFrom: a.from, bFrom: b.from, status: 'pending', winner: null, loser: null };
  });
  propagate(ms);
  for (let i = 0; i < 500; i++) {
    const m = ms.find((x) => x.status === 'ready');
    if (!m) break;
    const w = pick(m);
    m.winner = w; m.loser = w === m.entryA ? m.entryB : m.entryA; m.status = 'done';
    propagate(ms);
  }
  return ms;
}
const asLike = (ms: (LiveMatch & { round: number; bracket: string })[]): MatchLike[] =>
  ms.map((m) => ({ ...m, stageIdx: 0, scoreA: null, scoreB: null, isDraw: false }));

describe('seeding', () => {
  it('keeps the top seeds apart until the final', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(shuffle(ids(10), 7)).toEqual(shuffle(ids(10), 7));
    expect(shuffle(ids(10), 7).sort((a, b) => a - b)).toEqual(ids(10));
  });
});

describe('single elimination', () => {
  for (const n of [2, 3, 5, 8, 13, 16, 17]) {
    it(`finishes cleanly with ${n} entries`, () => {
      const ms = play(singleElimination(ids(n), cfg), (m) => Math.min(m.entryA!, m.entryB!)); // better seed always wins
      expect(ms.every((m) => m.status === 'done' || m.status === 'void')).toBe(true);
      const losses = new Map<number, number>();
      for (const m of ms) if (m.loser) losses.set(m.loser, (losses.get(m.loser) ?? 0) + 1);
      expect([...losses.values()].every((x) => x === 1)).toBe(true);
      expect(losses.size).toBe(n - 1);
      const table = eliminationTable(ids(n), asLike(ms), false);
      expect(table[0]).toMatchObject({ entry: 1, place: 1 });
      expect(table[1]).toMatchObject({ entry: 2, place: 2 });
    });
  }
  it('gives byes to the top seeds and plays a 3rd-place match when asked', () => {
    const planned = singleElimination(ids(6), withDefaults({ thirdPlace: true }));
    const r1 = planned.filter((p) => p.round === 1);
    expect(r1.filter((p) => 'bye' in p.a || 'bye' in p.b)).toHaveLength(2);
    const ms = play(planned, (m) => Math.min(m.entryA!, m.entryB!));
    const table = eliminationTable(ids(6), asLike(ms), false);
    expect(table.slice(0, 4).map((s) => [s.entry, s.place])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });
  it('lets semi-final losers share 3rd without a 3rd-place match', () => {
    const ms = play(singleElimination(ids(8), cfg), (m) => Math.min(m.entryA!, m.entryB!));
    const t = eliminationTable(ids(8), asLike(ms), false);
    expect(t.filter((s) => s.place === 3).map((s) => s.entry).sort()).toEqual([3, 4]);
    expect(t.filter((s) => s.place === 5)).toHaveLength(4);
  });
  it('uses the final best-of for the final only', () => {
    const p = singleElimination(ids(8), withDefaults({ bestOf: 1, finalBestOf: 5 }));
    expect(p.find((m) => m.code === 'R3-1')!.bestOf).toBe(5);
    expect(p.find((m) => m.code === 'R1-1')!.bestOf).toBe(1);
  });
});

describe('double elimination', () => {
  for (const n of [3, 4, 5, 7, 8, 11, 16]) {
    it(`needs two losses to go out, with ${n} entries`, () => {
      // random-ish winners: lower id wins except every third match
      let k = 0;
      const ms = play(doubleElimination(ids(n), cfg), (m) => (++k % 3 ? Math.min(m.entryA!, m.entryB!) : Math.max(m.entryA!, m.entryB!)));
      expect(ms.every((m) => m.status === 'done' || m.status === 'void')).toBe(true);
      const losses = new Map<number, number>();
      for (const m of ms) if (m.loser) losses.set(m.loser, (losses.get(m.loser) ?? 0) + 1);
      const champion = eliminationTable(ids(n), asLike(ms), true)[0].entry;
      for (const e of ids(n)) expect(losses.get(e) ?? 0).toBe(e === champion ? (losses.get(e) ?? 0) : 2);
      expect(losses.get(champion) ?? 0).toBeLessThanOrEqual(1);
    });
  }
  it('plays the grand-final reset only when the losers’-bracket finalist wins', () => {
    const wbWins = play(doubleElimination(ids(4), cfg), (m) => Math.min(m.entryA!, m.entryB!));
    expect(wbWins.find((m) => m.code === 'GF2')!.status).toBe('void');
    const lbWins = play(doubleElimination(ids(4), cfg), (m) => (m.code === 'GF1' ? m.entryB! : Math.min(m.entryA!, m.entryB!)));
    expect(lbWins.find((m) => m.code === 'GF2')!.status).toBe('done');
    const t = eliminationTable(ids(4), asLike(lbWins), true);
    expect(t[0].place).toBe(1);
    expect(t[1].place).toBe(2);
  });
});

describe('round robin and groups', () => {
  it('pairs everyone exactly once', () => {
    for (const n of [2, 3, 4, 7, 8]) {
      const ms = roundRobin(ids(n), cfg);
      const pairs = ms.map((m) => [('entry' in m.a ? m.a.entry : 0), ('entry' in m.b ? m.b.entry : 0)].sort().join('-'));
      expect(new Set(pairs).size).toBe((n * (n - 1)) / 2);
      expect(pairs.length).toBe((n * (n - 1)) / 2);
      // nobody plays twice in one round
      for (const r of new Set(ms.map((m) => m.round))) {
        const inRound = ms.filter((m) => m.round === r).flatMap((m) => [m.a, m.b].map((s) => ('entry' in s ? s.entry : 0)));
        expect(new Set(inRound).size).toBe(inRound.length);
      }
    }
  });
  it('snakes seeds into balanced groups and crosses them for playoffs', () => {
    expect(splitGroups(ids(8), 2)).toEqual([[1, 4, 5, 8], [2, 3, 6, 7]]);
    expect(playoffSeeds([[1, 4], [2, 3]], 2)).toEqual([1, 2, 4, 3]);
  });
  it('ranks a league table by points, then score difference', () => {
    const m = (a: number, b: number, sa: number, sb: number): MatchLike => ({ code: `${a}${b}`, bracket: 'A', round: 1, stageIdx: 0, entryA: a, entryB: b, scoreA: sa, scoreB: sb, winner: sa > sb ? a : sb > sa ? b : null, loser: sa > sb ? b : sb > sa ? a : null, isDraw: sa === sb, status: 'done' });
    const t = leagueTable([1, 2, 3], [m(1, 2, 3, 0), m(2, 3, 1, 0), m(3, 1, 2, 1)], withDefaults({ allowDraws: true }));
    expect(t.map((s) => [s.entry, s.points, s.place])).toEqual([[1, 3, 1], [3, 3, 2], [2, 3, 3]]);
  });
});

describe('swiss', () => {
  it('avoids rematches and gives the bye to someone who hasn’t had one', () => {
    const state: SwissState[] = ids(5).map((e) => ({ entry: e, points: 0, seed: e, opponents: new Set(), hadBye: false }));
    state[4].hadBye = true;
    state[0].opponents.add(2); state[1].opponents.add(1);
    const r = swissPairings(state);
    expect(r.bye).toBe(4);
    expect(r.pairs.some(([a, b]) => (a === 1 && b === 2) || (a === 2 && b === 1))).toBe(false);
    expect(r.pairs.flat().sort()).toEqual([1, 2, 3, 5]);
  });
  it('counts byes as wins and breaks ties with Buchholz', () => {
    const done = (a: number, b: number, w: number): MatchLike => ({ code: `${a}-${b}`, bracket: 'S', round: 1, stageIdx: 0, entryA: a, entryB: b, scoreA: w === a ? 1 : 0, scoreB: w === b ? 1 : 0, winner: w, loser: w === a ? b : a, isDraw: false, status: 'done' });
    const t = swissTable([1, 2, 3], [done(1, 2, 1)], new Map([[3, 1]]), cfg);
    expect(t.map((s) => [s.entry, s.points])).toEqual([[1, 3], [3, 3], [2, 0]]);
  });
});

describe('free-for-all and challenges', () => {
  it('splits heats evenly and scores placings', () => {
    const heats = ffaHeats(ids(10), 4, 1);
    expect(heats.map((h) => h.entries.length).sort()).toEqual([3, 3, 4]);
    expect(heats.flatMap((h) => h.entries).sort((a, b) => a - b)).toEqual(ids(10));
    expect(() => checkPlacements([1, 2, 3], { 1: 1, 2: 1, 3: 2 })).toThrow(/only be used once/);
    const t = ffaTable([1, 2], [{ entry: 1, placement: 2, points: 8 }, { entry: 2, placement: 1, points: 10 }, { entry: 1, placement: 1, points: 10 }]);
    expect(t.map((s) => [s.entry, s.points])).toEqual([[1, 18], [2, 10]]);
  });
  it('parses and ranks times', () => {
    expect(parseValue('1:02.5', 'time')).toBe(62_500);
    expect(parseValue('59.999', 'time')).toBe(59_999);
    expect(parseValue('1:75.0', 'time')).toBeNull();
    expect(formatValue(62_500, 'time')).toBe('1:02.500');
    const t = challengeTable([1, 2, 3], new Map([[1, 62_500], [2, 59_000]]), true);
    expect(t.map((s) => s.entry)).toEqual([2, 1, 3]);
  });
});

describe('scores', () => {
  it('validates best-of scores and draws', () => {
    expect(judgeScore(3, 2, 1, cfg)).toBe('a');
    expect(() => judgeScore(3, 3, 1, cfg)).toThrow(/exactly 2/);
    expect(() => judgeScore(3, 2, 2, cfg)).toThrow();
    expect(judgeScore(1, 16, 12, cfg)).toBe('a');
    expect(judgeScore(1, 61, 58, { winCondition: 'lower' })).toBe('b');
    expect(() => judgeScore(1, 5, 5, cfg)).toThrow(/Draws/);
    expect(judgeScore(1, 5, 5, { allowDraws: true })).toBe('draw');
    expect(() => judgeScore(1, -1, 2, cfg)).toThrow(/whole numbers/);
  });
});
