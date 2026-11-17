/**
 * Ready-made tournament configurations. Organisers pick one on the "New tournament" page to pre-fill the form;
 * the same data is in examples/*.json for people setting tournaments up by script.
 */
import type { TournamentInput } from './service.ts';

export interface Template { key: string; label: string; summary: string; values: Partial<TournamentInput> }

export const TEMPLATES: Template[] = [
  {
    key: 'cs2-5v5-double', label: '5v5 shooter, double elimination',
    summary: 'Teams of 5 (+1 sub), best of 1 with a best-of-3 grand final, losers’ bracket and reset.',
    values: { game: 'Counter-Strike 2', platform: 'PC', mode: 'team', teamMin: 5, teamMax: 5, subsMax: 1, maxEntries: 16, format: 'double_elim', requireCheckin: true,
      config: { bestOf: 1, finalBestOf: 3, grandFinalReset: true, seeding: 'random', rankingPoints: [100, 70, 50, 35], participationPoints: 10 },
      rules: '[list]\n[*]Knife round for sides.\n[*]MR12, overtime MR3.\n[*]Captains report scores straight after the match.\n[/list]' },
  },
  {
    key: 'fighting-1v1-single', label: '1v1 fighting game, single elimination',
    summary: 'Solo players, best of 3, best-of-5 final, 3rd-place match.',
    values: { game: 'Street Fighter 6', platform: 'PS5', mode: 'solo', maxEntries: 32, format: 'single_elim',
      config: { bestOf: 3, finalBestOf: 5, thirdPlace: true, seeding: 'manual', rankingPoints: [100, 70, 50, 35, 25, 25, 25, 25] } },
  },
  {
    key: 'rocket-groups', label: '3v3 car football, groups then playoffs',
    summary: 'Teams of 3, two groups (round robin), top 2 from each into a single-elimination playoff.',
    values: { game: 'Rocket League', platform: 'PC', mode: 'team', teamMin: 3, teamMax: 3, subsMax: 1, format: 'groups_playoffs',
      config: { bestOf: 1, finalBestOf: 3, groups: 2, advancePerGroup: 2, playoff: 'single_elim', points: { win: 3, draw: 1, loss: 0 } } },
  },
  {
    key: 'chess-swiss', label: 'Board game, swiss system',
    summary: 'Solo players, 5 swiss rounds, draws allowed (1 point for a draw).',
    values: { game: 'Chess', platform: 'Board', mode: 'solo', format: 'swiss', config: { bestOf: 1, swissRounds: 5, allowDraws: true, points: { win: 2, draw: 1, loss: 0 } } },
  },
  {
    key: 'league-round-robin', label: 'Small league, round robin',
    summary: 'Everyone plays everyone once; 3 points for a win.',
    values: { game: 'FIFA', platform: 'Xbox', mode: 'solo', maxEntries: 10, format: 'round_robin', config: { bestOf: 1, allowDraws: true, points: { win: 3, draw: 1, loss: 0 } } },
  },
  {
    key: 'kart-ffa', label: 'Kart racing, free-for-all heats',
    summary: '3 rounds of 8-player heats, points 15/12/10/8/6/4/2/1.',
    values: { game: 'Mario Kart 8 Deluxe', platform: 'Switch', mode: 'solo', format: 'ffa', config: { ffaRounds: 3, heatSize: 8, ffaPoints: [15, 12, 10, 8, 6, 4, 2, 1] } },
  },
  {
    key: 'trackmania-time', label: 'Time trial challenge',
    summary: 'Best lap time over the event; lower is better; a referee checks each attempt.',
    values: { game: 'Trackmania', platform: 'PC', mode: 'solo', format: 'time_trial', config: { winCondition: 'lower', scoreUnit: 'time', verifyAttempts: true } },
  },
];
export const templateByKey = (k: string) => TEMPLATES.find((t) => t.key === k) ?? null;
