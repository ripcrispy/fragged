/** @jsxImportSource hono/jsx */
/** Presentational pieces shared by the tournament pages, the spectator view and the LAN HQ widget. */
import { Time, UserLink, type Child, type UserCard } from '../../src/sdk/index.ts';
import { FORMATS, formatValue, withDefaults, type Standing, type FormatId } from './formats.ts';
import { STATUSES, type Status } from './service.ts';
import type { Tournament, Match, Entry } from './schema.ts';
import type { StageView } from './matches.ts';

export const MATCH_STATUS: Record<string, string> = {
  pending: 'Waiting', ready: 'Ready', live: 'Live', reported: 'Awaiting confirmation', disputed: 'Disputed', done: 'Finished', void: 'Not played',
};
/** Shorter labels for match cards. */
const CARD_STATUS: Record<string, string> = { ...MATCH_STATUS, reported: 'Reported' };
const STATUS_TAG: Record<string, string> = { registration_open: 'tag-ok', in_progress: 'tag-ok', completed: '', cancelled: 'tag-held', draft: 'tag-held', registration_closed: '' };
export const base = (t: Pick<Tournament, 'slug'>) => `/m/lan-tournaments/${t.slug}`;

export function StatusTag({ t }: { t: Tournament }) {
  return <span class={`tag ${STATUS_TAG[t.status] ?? ''} lt-status lt-status-${t.status}`}>{t.status === 'in_progress' ? <span class="lt-live-dot" aria-hidden="true" /> : null}{STATUSES[t.status as Status] ?? t.status}{t.archived ? ' · archived' : ''}</span>;
}

export function Banner({ t, tz, children }: { t: Tournament; tz: string; children?: Child }) {
  return (
    <header class={`lt-banner ${t.bannerUrl ? 'has-image' : ''}`}>
      {t.bannerUrl ? <img class="lt-banner-img" src={t.bannerUrl} alt="" /> : null}
      <div class="lt-banner-body">
        <p class="lt-kicker">{[t.game, t.platform, FORMATS[t.format as FormatId]].filter(Boolean).join(' · ')}</p>
        <h1 class="lt-title">{t.name}</h1>
        <p class="lt-banner-meta"><StatusTag t={t} />{t.startsAt ? <> · <Time d={t.startsAt} tz={tz} /></> : null}{t.mode === 'team' ? <> · teams of {t.teamMin === t.teamMax ? t.teamMin : `${t.teamMin}–${t.teamMax}`}</> : <> · solo</>}</p>
        {children}
      </div>
    </header>
  );
}

export function TournamentCard({ t, count, tz, eventName }: { t: Tournament; count: number; tz: string; eventName?: string | null }) {
  return (
    <a class="lt-card" href={base(t)}>
      <span class={`lt-card-art ${t.bannerUrl ? '' : 'is-plain'}`}>{t.bannerUrl ? <img src={t.bannerUrl} alt="" loading="lazy" /> : <span class="lt-card-initials" aria-hidden="true">{(t.game || t.name).slice(0, 2).toUpperCase()}</span>}</span>
      <span class="lt-card-body">
        <span class="lt-card-name">{t.name}</span>
        <span class="lt-card-meta">{[t.game, FORMATS[t.format as FormatId]].filter(Boolean).join(' · ')}</span>
        <span class="lt-card-meta"><StatusTag t={t} /> {count}{t.maxEntries ? ` / ${t.maxEntries}` : ''} {t.mode === 'team' ? 'teams' : 'players'}</span>
        {t.startsAt ? <span class="lt-card-meta"><Time d={t.startsAt} tz={tz} />{eventName ? ` · ${eventName}` : ''}</span> : eventName ? <span class="lt-card-meta">{eventName}</span> : null}
      </span>
    </a>
  );
}

/** Round names that read like a real bracket. */
export function roundName(m: Pick<Match, 'bracket' | 'round' | 'code'>, maxW: number, maxL: number): string {
  if (m.bracket === 'GF') return m.round === 1 ? 'Grand final' : 'Grand final reset';
  if (m.bracket === '3RD') return '3rd-place match';
  if (m.bracket === 'L') return m.round === maxL ? 'Losers’ final' : `Losers’ round ${m.round}`;
  if (m.bracket === 'W') {
    const fromEnd = maxW - m.round;
    return fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semi-finals' : fromEnd === 2 ? 'Quarter-finals' : `Round ${m.round}`;
  }
  if (m.bracket === 'S') return `Round ${m.round}`;
  if (m.bracket === 'H') return `Round ${m.round}`;
  return `Group ${m.bracket} · round ${m.round}`;
}

interface MatchCardProps { t: Tournament; m: Match; names: Map<number, string>; mine?: Set<number>; tz: string; showTime?: boolean }
export function MatchCard({ t, m, names, mine = new Set(), tz, showTime = true }: MatchCardProps) {
  const side = (id: number | null, from: string | null, score: number | null) => {
    const won = m.status === 'done' && id !== null && m.winner === id;
    const label = id !== null ? names.get(id) ?? '—' : from === 'BYE' ? 'Bye' : from ? `${from.startsWith('W') ? 'Winner' : 'Loser'} of ${from.slice(2)}` : 'TBD';
    return (
      <span class={`lt-side ${won ? 'is-winner' : ''} ${m.status === 'done' && id !== null && m.loser === id ? 'is-loser' : ''} ${id !== null && mine.has(id) ? 'is-mine' : ''} ${id === null ? 'is-tbd' : ''}`} data-entry={id ?? undefined}>
        <span class="lt-side-name">{label}</span>
        <span class="lt-side-score">{m.status === 'done' || m.status === 'reported' ? score ?? (won ? 'W' : '') : ''}</span>
      </span>
    );
  };
  return (
    <a class={`lt-match lt-m-${m.status}`} href={`${base(t)}/match/${m.id}`}>
      <span class="lt-match-head"><span class="lt-match-code">{m.code}</span>{m.bestOf > 1 ? <span>Bo{m.bestOf}</span> : null}<span class={`lt-ms lt-ms-${m.status}`}>{CARD_STATUS[m.status]}</span></span>
      {side(m.entryA, m.aFrom, m.scoreA)}
      {side(m.entryB, m.bFrom, m.scoreB)}
      {showTime && (m.scheduledAt || m.station) && m.status !== 'done' ? <span class="lt-match-foot">{m.scheduledAt ? <Time d={m.scheduledAt} tz={tz} /> : null}{m.station ? ` · ${m.station}` : ''}</span> : null}
    </a>
  );
}

/** The bracket for an elimination stage: one column per round, losers' bracket and grand final below. */
export function Bracket({ t, view, names, mine, tz }: { t: Tournament; view: StageView; names: Map<number, string>; mine?: Set<number>; tz: string }) {
  const ms = view.matches;
  const maxW = Math.max(0, ...ms.filter((m) => m.bracket === 'W').map((m) => m.round));
  const maxL = Math.max(0, ...ms.filter((m) => m.bracket === 'L').map((m) => m.round));
  const section = (bracket: string, title: string | null) => {
    const list = ms.filter((m) => m.bracket === bracket);
    if (!list.length) return null;
    const rounds = [...new Set(list.map((m) => m.round))].sort((a, b) => a - b);
    return (
      <section class="lt-bk-section" aria-label={title ?? 'Bracket'}>
        {title ? <h3 class="lt-bk-title">{title}</h3> : null}
        <div class="lt-bk" data-bracket>
          {rounds.map((r, i) => {
            const here = list.filter((m) => m.round === r).sort((a, b) => a.position - b.position);
            const next = rounds[i + 1] !== undefined ? list.filter((m) => m.round === rounds[i + 1]).length : 0;
            // pairs feed one match in the next round: join them with a vertical line; otherwise draw straight across
            const size = next && here.length === next * 2 ? 2 : 1;
            const slots = Array.from({ length: Math.ceil(here.length / size) }, (_, k) => here.slice(k * size, k * size + size));
            return (
            <div class={`lt-bk-col ${next ? 'has-next' : ''} ${i > 0 ? 'has-prev' : ''}`}>
              {bracket === '3RD' ? null : <h4 class="lt-bk-round">{roundName(list.find((m) => m.round === r)!, maxW, maxL)}</h4>}
              <div class="lt-bk-matches">{slots.map((slot) => <div class={`lt-bk-slot ${slot.length === 2 ? 'is-pair' : ''}`}>{slot.map((m) => <MatchCard t={t} m={m} names={names} mine={mine} tz={tz} />)}</div>)}</div>
            </div>
            );
          })}
        </div>
      </section>
    );
  };
  const double = view.stage.kind === 'double_elim';
  return (
    <div class="lt-bracket">
      {section('W', double ? 'Winners’ bracket' : null)}
      {section('L', 'Losers’ bracket')}
      {section('GF', 'Grand final')}
      {section('3RD', '3rd-place match')}
    </div>
  );
}

export function StandingsTable({ table, names, kind, cfg, caption, highlight = new Set(), limit }: { table: Standing[]; names: Map<number, string>; kind: string; cfg: Tournament['config']; caption?: string; highlight?: Set<number>; limit?: number }) {
  const c = withDefaults(cfg);
  const rows = limit ? table.slice(0, limit) : table;
  const league = kind === 'round_robin' || kind === 'swiss';
  return (
    <div class="table-wrap"><table class="data-table lt-standings">
      {caption ? <caption>{caption}</caption> : null}
      <thead><tr><th scope="col">#</th><th scope="col">{kind === 'time_trial' ? 'Entry' : 'Entry'}</th>
        {kind === 'time_trial' ? <th scope="col">Best</th> : kind === 'ffa' ? <><th scope="col">Points</th><th scope="col">Heats</th><th scope="col">Wins</th></> : <><th scope="col">W</th>{league ? <th scope="col">D</th> : null}<th scope="col">L</th>{league ? <><th scope="col">+/-</th><th scope="col">Pts</th></> : null}{kind === 'swiss' ? <th scope="col" title="Buchholz: the sum of your opponents' points">Bhz</th> : null}</>}
      </tr></thead>
      <tbody>{rows.map((s) => (
        <tr class={`${highlight.has(s.entry) ? 'is-mine' : ''} ${s.place <= 3 ? `lt-podium lt-p${s.place}` : ''}`}>
          <td class="lt-place">{s.place <= 3 ? <span class={`lt-medal lt-medal-${s.place}`}>{s.place}</span> : s.place}</td><td data-entry={s.entry}>{names.get(s.entry) ?? '—'}</td>
          {kind === 'time_trial' ? <td>{Number.isNaN(s.tiebreak) ? <span class="muted">—</span> : formatValue(s.tiebreak, c.scoreUnit)}</td>
            : kind === 'ffa' ? <><td><strong>{s.points}</strong></td><td>{s.played}</td><td>{s.wins}</td></>
            : <><td>{s.wins}</td>{league ? <td>{s.draws}</td> : null}<td>{s.losses}</td>{league ? <><td>{s.scoreFor - s.scoreAgainst}</td><td><strong>{s.points}</strong></td></> : null}{kind === 'swiss' ? <td>{s.tiebreak}</td> : null}</>}
        </tr>))}
      </tbody>
    </table></div>
  );
}

export function MatchList({ t, ms, names, mine, tz, empty }: { t: Tournament; ms: Match[]; names: Map<number, string>; mine?: Set<number>; tz: string; empty: string }) {
  return ms.length ? <div class="lt-match-grid">{ms.map((m) => <MatchCard t={t} m={m} names={names} mine={mine} tz={tz} />)}</div> : <p class="muted">{empty}</p>;
}

export function Heats({ t, heats, names, mine, tz }: { t: Tournament; heats: { m: Match; rows: { entryId: number; placement: number | null; points: number | null }[] }[]; names: Map<number, string>; mine?: Set<number>; tz: string }) {
  const rounds = [...new Set(heats.map((h) => h.m.round))].sort((a, b) => a - b);
  return (
    <div class="lt-heats">{rounds.map((r) => (
      <section><h3 class="lt-bk-title">Round {r}</h3>
        <div class="lt-match-grid">{heats.filter((h) => h.m.round === r).map(({ m, rows }) => (
          <a class={`lt-match lt-heat lt-m-${m.status}`} href={`${base(t)}/match/${m.id}`}>
            <span class="lt-match-head"><span class="lt-match-code">{m.code}</span><span class={`lt-ms lt-ms-${m.status}`}>{MATCH_STATUS[m.status]}</span></span>
            {[...rows].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99)).map((h) => (
              <span class={`lt-side ${h.placement === 1 ? 'is-winner' : ''} ${mine?.has(h.entryId) ? 'is-mine' : ''}`} data-entry={h.entryId}><span class="lt-side-name">{names.get(h.entryId) ?? '—'}</span><span class="lt-side-score">{h.placement ? `${h.placement}. · ${h.points} pts` : ''}</span></span>
            ))}
            {m.scheduledAt && m.status !== 'done' ? <span class="lt-match-foot"><Time d={m.scheduledAt} tz={tz} />{m.station ? ` · ${m.station}` : ''}</span> : null}
          </a>))}
        </div>
      </section>))}
    </div>
  );
}

export function EntryList({ list, cards, teamRosters, showStatus }: { list: Entry[]; cards: Map<number, UserCard>; teamRosters: Map<number, { userId: number; role: string }[]>; showStatus: boolean }) {
  return list.length ? (
    <ol class="lt-entries">{list.map((e) => (
      <li class={`lt-entry lt-e-${e.status}`}>
        <span class="lt-entry-name">{e.userId && cards.get(e.userId) ? <UserLink user={cards.get(e.userId)} /> : <strong>{e.name}</strong>}</span>
        {e.teamId ? <span class="lt-roster small">{(teamRosters.get(e.teamId) ?? []).map((m, i) => <>{i ? ', ' : ''}<UserLink user={cards.get(m.userId)} />{m.role === 'captain' ? ' (c)' : m.role === 'sub' ? ' (sub)' : ''}</>)}</span> : null}
        {e.checkedInAt ? <span class="tag tag-ok">Checked in</span> : null}
        {showStatus && e.status !== 'approved' ? <span class="tag tag-held">{e.status === 'pending' ? 'Awaiting approval' : e.status}</span> : null}
        {e.station ? <span class="small muted">· {e.station}</span> : null}
      </li>))}
    </ol>
  ) : <p class="muted">Nobody has registered yet.</p>;
}
