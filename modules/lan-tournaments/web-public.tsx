/** @jsxImportSource hono/jsx */
/** Public pages: discovery, tournament, registration and teams, matches and reporting, spectator view, JSON API. */
import {
  Box, Csrf, Notice, ActionButton, Field, Select, Time, Html, EmptyState, UserLink, Stat,
  form, str, int, renderBBCode, services, ServiceError, setFlash,
  type ModuleContext, type RequestContext, type Viewer, type PageCtx, type Child,
} from '../../src/sdk/index.ts';
import { FORMATS, withDefaults, parseValue, formatValue, type FormatId } from './formats.ts';
import {
  STATUSES, listAll, entriesOf, counted, teamsOf, membersOf, teamOfUser, entryOfUser, teamById, announcementsOf, registrationClosedReason, checkinClosedReason,
  registerSolo, withdrawEntry, createTeam, inviteToTeam, answerInvite, removeFromTeam, setCaptain, disbandTeam, registerTeam, checkIn, actorsOfEntry,
  historyOf, canSee, notifyUsers, ACTIVE_ENTRY, type Status,
} from './service.ts';
import {
  standings, matchesOf, matchById, heatOf, reportsOf, attemptsOf, reportScore, confirmReport, disputeReport, reportHeat, submitAttempt, challengeOpenReason, stagesOf,
} from './matches.ts';
import { StatusTag, Banner, TournamentCard, Bracket, StandingsTable, MatchList, Heats, EntryList, MATCH_STATUS, roundName, base } from './ui.tsx';
import { results, teamMembers, entries as entriesTable, type Tournament, type Match, type Entry } from './schema.ts';
import type { Helpers } from './context.ts';
import { database, eq, desc, inArray, sql } from '../../src/sdk/index.ts';

const db = () => database.db();
const TABS = [['overview', 'Overview'], ['bracket', 'Bracket'], ['matches', 'Matches'], ['standings', 'Standings'], ['participants', 'Participants'], ['rules', 'Rules']] as const;

/** What the viewer is in this tournament: their entry, team and which side(s) they act for. */
async function myself(t: Tournament, v: Viewer) {
  if (!v.user) return { entry: null as Entry | null, team: null as Awaited<ReturnType<typeof teamOfUser>>, mineIds: new Set<number>() };
  const entry = await entryOfUser(t, v.user.id);
  const team = t.mode === 'team' ? await teamOfUser(t.id, v.user.id) : null;
  return { entry, team, mineIds: new Set(entry && (ACTIVE_ENTRY as readonly string[]).includes(entry.status) ? [entry.id] : []) };
}

/** Live data used by the overview, the spectator view and the LAN HQ widget. */
export async function liveData(t: Tournament) {
  const ms = await matchesOf(t.id);
  const active = ms.filter((m) => ['live', 'reported', 'disputed'].includes(m.status));
  const now = Date.now();
  const upcoming = ms.filter((m) => m.status === 'ready' || (m.status === 'pending' && m.scheduledAt)).sort((a, b) => (a.scheduledAt?.getTime() ?? now + 1e12) - (b.scheduledAt?.getTime() ?? now + 1e12) || a.round - b.round || a.position - b.position);
  const recent = ms.filter((m) => m.status === 'done' && m.entryA !== null && m.entryB !== null || (m.status === 'done' && m.bracket === 'H')).sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  const open = ms.filter((m) => !['done', 'void'].includes(m.status));
  const sts = await stagesOf(t.id);
  const current = open.length ? open.reduce((x, m) => (m.round < x.round ? m : x), open[0]) : null;
  const stage = current ? sts.find((s) => s.id === current.stageId) : sts.at(-1);
  const progress = ms.length ? Math.round((ms.filter((m) => ['done', 'void'].includes(m.status)).length / ms.length) * 100) : 0;
  return { ms, active, upcoming, recent, current, stage, progress };
}

export function registerPublic(ctx: ModuleContext, h: Helpers) {
  const r = ctx.routes;

  // ───────── discovery ─────────
  r.get('/', async (c) => {
    const v = c.get('viewer'); await v.require(h.P.view);
    const page = c.get('page');
    const tz = h.tz(page);
    const filter = c.req.query('show') ?? 'current';
    const game = (c.req.query('game') ?? '').trim();
    const eventId = int(c.req.query('event') ?? '0');
    const all = await listAll();
    const visible: Tournament[] = [];
    for (const t of all) {
      const staff = await h.isStaff(v, t);
      if (t.status === 'draft' && !staff) continue;
      if (t.visibility === 'private' && !(await canSee(t, v.user?.id ?? null, staff))) continue;
      visible.push(t);
    }
    const shown = visible.filter((t) => {
      if (game && t.game !== game) return false;
      if (eventId && t.lanEventId !== eventId) return false;
      if (filter === 'archived') return t.archived;
      if (t.archived) return false;
      if (filter === 'past') return ['completed', 'cancelled'].includes(t.status);
      if (filter === 'live') return t.status === 'in_progress';
      return !['completed', 'cancelled'].includes(t.status);
    });
    const counts = new Map<number, number>();
    for (const t of shown) counts.set(t.id, counted(await entriesOf(t.id)).length);
    const seating = h.seating();
    const events = new Map<number, string>();
    for (const t of shown) if (t.lanEventId && seating && !events.has(t.lanEventId)) events.set(t.lanEventId, (await seating.eventById(t.lanEventId))?.name ?? '');
    const games = [...new Set(visible.map((t) => t.game).filter(Boolean))].sort();
    const q = (k: string, val: string) => { const p = new URLSearchParams({ show: filter, ...(game ? { game } : {}), ...(eventId ? { event: String(eventId) } : {}) }); if (val) p.set(k, val); else p.delete(k); return `/m/lan-tournaments?${p}`; };
    return ctx.render(c, 'Tournaments', (
      <>
        <div class="lt-page-head">
          <h1 class="page-title">Tournaments</h1>
          <div class="lt-head-actions">
            <a class="btn" href="/m/lan-tournaments/leaderboard">Leaderboard</a>
            {(await h.canCreate(v)) ? <a class="btn btn-primary" href="/m/lan-tournaments/new">New tournament</a> : null}
          </div>
        </div>
        <nav class="lt-tabs" aria-label="Which tournaments">
          {[['current', 'Upcoming and open'], ['live', 'Live now'], ['past', 'Finished'], ['archived', 'Archived']].map(([k, l]) => <a href={q('show', k)} aria-current={filter === k ? 'page' : undefined} class={filter === k ? 'active' : ''}>{l}</a>)}
        </nav>
        {games.length > 1 ? <form method="get" action="/m/lan-tournaments" class="inline-form lt-filter"><input type="hidden" name="show" value={filter} />
          <label for="lt-game">Game</label> <select id="lt-game" name="game"><option value="">All games</option>{games.map((g) => <option selected={g === game}>{g}</option>)}</select> <button class="btn btn-small">Filter</button></form> : null}
        {shown.length ? <div class="lt-cards">{shown.map((t) => <TournamentCard t={t} count={counts.get(t.id) ?? 0} tz={tz} eventName={t.lanEventId ? events.get(t.lanEventId) : null} />)}</div>
          : <EmptyState title={filter === 'live' ? 'Nothing is being played right now.' : 'No tournaments here yet.'}>{(await h.canCreate(v)) ? <p><a href="/m/lan-tournaments/new">Create a tournament</a>.</p> : <p>Check back soon.</p>}</EmptyState>}
      </>
    ), { crumbs: [{ label: 'Tournaments' }] });
  });

  r.get('/leaderboard', async (c) => {
    const v = c.get('viewer'); await v.require(h.P.view);
    const rows = (await db().execute(sql`
      select r.user_id, count(distinct r.tournament_id)::int as played, sum(r.points)::int as points,
        count(*) filter (where r.place = 1)::int as titles, count(*) filter (where r.place <= 3)::int as podiums,
        sum(r.wins)::int as wins, sum(r.losses)::int as losses
      from mod_lan_tournaments_results r join mod_lan_tournaments_tournaments t on t.id = r.tournament_id
      where r.user_id is not null and t.visibility <> 'private' and not t.archived
      group by r.user_id order by points desc, titles desc, podiums desc limit 100`)) as any;
    const list: { user_id: number; played: number; points: number; titles: number; podiums: number; wins: number; losses: number }[] = rows.rows ?? rows;
    const cards = await services.users.cards(list.map((x) => x.user_id));
    return ctx.render(c, 'Tournament leaderboard', (
      <>
        <h1 class="page-title">Tournament leaderboard</h1>
        <p class="page-desc">Ranking points from every published tournament. Organisers set the points for each place.</p>
        <Box title="Players">{list.length ? <div class="table-wrap"><table class="data-table lt-standings"><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">Points</th><th scope="col">Titles</th><th scope="col">Podiums</th><th scope="col">Tournaments</th><th scope="col">Matches W–L</th></tr></thead><tbody>
          {list.map((x, i) => <tr class={i < 3 ? `lt-podium lt-p${i + 1}` : ''}><td class="lt-place">{i < 3 ? <span class={`lt-medal lt-medal-${i + 1}`} title={['1st', '2nd', '3rd'][i]}>{i + 1}</span> : i + 1}</td><td><UserLink user={cards.get(x.user_id)} /></td><td><strong>{x.points}</strong></td><td>{x.titles}</td><td>{x.podiums}</td><td>{x.played}</td><td>{x.wins}–{x.losses}</td></tr>)}
        </tbody></table></div> : <p class="muted">No published results yet.</p>}</Box>
      </>
    ), { crumbs: [{ label: 'Tournaments', href: '/m/lan-tournaments' }, { label: 'Leaderboard' }] });
  });

  r.get('/api/tournaments', async (c) => {
    const v = c.get('viewer'); await v.require(h.P.view);
    const out = [];
    for (const t of await listAll()) {
      const staff = await h.isStaff(v, t);
      if ((t.status === 'draft' && !staff) || t.archived || !(await canSee(t, v.user?.id ?? null, staff))) continue;
      out.push({ slug: t.slug, name: t.name, game: t.game, platform: t.platform, format: t.format, status: t.status, startsAt: t.startsAt, entries: counted(await entriesOf(t.id)).length, maxEntries: t.maxEntries, url: base(t) });
    }
    return c.json({ tournaments: out });
  });

  // ───────── tournament ─────────
  r.get('/:slug', async (c) => {
    const { t, v, page, staff } = await h.load(c);
    const tz = h.tz(page);
    const tab = (TABS.find(([k]) => k === c.req.query('tab'))?.[0]) ?? 'overview';
    const me = await myself(t, v);
    const names = await h.names(t);
    const all = await entriesOf(t.id);
    const active = counted(all);
    const st = ['in_progress', 'completed'].includes(t.status) ? await standings(t) : null;
    const live = st ? await liveData(t) : null;
    const cfg = withDefaults(t.config);
    const seating = h.seating();
    const event = t.lanEventId && seating ? await seating.eventById(t.lanEventId) : null;
    const nextMine = live && me.mineIds.size ? [...live.active, ...live.upcoming].find((m) => (m.entryA !== null && me.mineIds.has(m.entryA)) || (m.entryB !== null && me.mineIds.has(m.entryB))) ?? null : null;
    const body: Child[] = [];

    if (tab === 'overview') {
      body.push(await ParticipationBox({ t, v, page, me, h, tz, nextMine, names }));
      if (live && t.status === 'in_progress') body.push(
        <Box title="Live now" actions={<a class="btn btn-small" href={`${base(t)}/live`}>Spectator view</a>}>
          <div class="stats-row"><Stat label="Stage" value={live.stage?.name ?? '—'} /><Stat label="Current round" value={live.current ? roundName(live.current, Math.max(...live.ms.filter((m) => m.bracket === 'W').map((m) => m.round), 0), Math.max(...live.ms.filter((m) => m.bracket === 'L').map((m) => m.round), 0)) : '—'} /><Stat label="Matches played" value={`${live.progress}%`} /></div>
          <h3 class="lt-h3">Active matches</h3><MatchList t={t} ms={live.active} names={names} mine={me.mineIds} tz={tz} empty="No matches are being played right now." />
          <h3 class="lt-h3">Up next</h3><MatchList t={t} ms={live.upcoming.slice(0, 6)} names={names} mine={me.mineIds} tz={tz} empty="Nothing scheduled yet." />
          {live.recent.length ? <><h3 class="lt-h3">Recent results</h3><MatchList t={t} ms={live.recent.slice(0, 4)} names={names} mine={me.mineIds} tz={tz} empty="" /></> : null}
        </Box>);
      if (st && t.status === 'completed') body.push(<Box title="Final standings"><StandingsTable table={st.overall} names={names} kind={st.stages.at(-1)?.stage.kind === 'single_elim' || st.stages.at(-1)?.stage.kind === 'double_elim' ? 'single_elim' : st.stages.at(-1)?.stage.kind ?? 'single_elim'} cfg={t.config} highlight={me.mineIds} limit={8} /></Box>);
      const anns = await announcementsOf(t.id);
      if (anns.length) body.push(<Box title="Announcements">{anns.slice(0, 5).map((a) => <article class="lt-ann"><p class="small muted"><Time d={a.createdAt} tz={tz} mode="ago" /></p><div class="bb"><Html html={renderBBCode(a.body, { embeds: false })} /></div></article>)}</Box>);
      body.push(
        <Box title="About">
          {t.description ? <div class="bb lt-desc"><Html html={renderBBCode(t.description, { embeds: true })} /></div> : null}
          <dl class="lt-facts">
            <dt>Format</dt><dd>{FORMATS[t.format as FormatId]}{t.format === 'groups_playoffs' ? ` (${cfg.groups} groups, top ${cfg.advancePerGroup} into ${cfg.playoff === 'double_elim' ? 'double' : 'single'} elimination)` : ''}{t.format === 'swiss' ? ` (${cfg.swissRounds ?? 'auto'} rounds)` : ''}{t.format === 'ffa' ? ` (${cfg.ffaRounds} rounds, heats of ${cfg.heatSize})` : ''}</dd>
            {!['ffa', 'time_trial'].includes(t.format) ? <><dt>Matches</dt><dd>Best of {cfg.bestOf}{cfg.finalBestOf !== cfg.bestOf ? `, finals best of ${cfg.finalBestOf}` : ''}{cfg.allowDraws ? ', draws allowed' : ''}</dd></> : null}
            {t.format === 'time_trial' ? <><dt>Scoring</dt><dd>{cfg.scoreUnit === 'time' ? 'Time' : 'Score'}, {cfg.winCondition === 'lower' ? 'lowest' : 'highest'} wins{cfg.verifyAttempts ? '; attempts are checked by a referee' : ''}</dd></> : null}
            <dt>Players</dt><dd>{t.mode === 'team' ? `Teams of ${t.teamMin === t.teamMax ? t.teamMin : `${t.teamMin}–${t.teamMax}`}${t.subsMax ? ` + up to ${t.subsMax} substitute${t.subsMax > 1 ? 's' : ''}` : ''}` : 'Solo'} · {active.length}{t.maxEntries ? ` of ${t.maxEntries}` : ''} registered</dd>
            {t.regOpensAt || t.regClosesAt ? <><dt>Registration</dt><dd>{t.regOpensAt ? <>opens <Time d={t.regOpensAt} tz={tz} /></> : null}{t.regOpensAt && t.regClosesAt ? ', ' : ''}{t.regClosesAt ? <>closes <Time d={t.regClosesAt} tz={tz} /></> : null}</dd></> : null}
            {t.checkinOpensAt ? <><dt>Check-in</dt><dd>opens <Time d={t.checkinOpensAt} tz={tz} />{t.requireCheckin ? ' (required to play)' : ''}</dd></> : null}
            {t.startsAt ? <><dt>When</dt><dd><Time d={t.startsAt} tz={tz} />{t.endsAt ? <> – <Time d={t.endsAt} tz={tz} /></> : null}</dd></> : null}
            {event ? <><dt>LAN event</dt><dd><a href={`/m/lan-seating/${event.slug}`}>{event.name}</a>{t.requireBooking ? ' (a booked place is required)' : ''}</dd></> : null}
            <dt>Ranking points</dt><dd>{cfg.rankingPoints.slice(0, 3).map((p, i) => `${['1st', '2nd', '3rd'][i]} ${p}`).join(' · ')}{cfg.participationPoints ? ` · ${cfg.participationPoints} for taking part` : ''}</dd>
          </dl>
        </Box>);
    } else if (tab === 'bracket') {
      if (!st) body.push(<EmptyState title="The bracket isn’t out yet.">{t.status === 'registration_open' ? <p>It’s drawn once registration closes.</p> : null}</EmptyState>);
      else for (const view of st.stages) {
        const k = view.stage.kind;
        body.push(<Box title={view.stage.name} className="lt-bracket-box">
          {k === 'single_elim' || k === 'double_elim' ? <Bracket t={t} view={view} names={names} mine={me.mineIds} tz={tz} />
            : k === 'round_robin' ? view.groups.map((g) => <div class="lt-group"><StandingsTable table={g.table} names={names} kind="round_robin" cfg={t.config} caption={view.groups.length > 1 ? `Group ${g.label}` : undefined} highlight={me.mineIds} /></div>)
            : k === 'swiss' ? <StandingsTable table={view.table} names={names} kind="swiss" cfg={t.config} highlight={me.mineIds} />
            : k === 'ffa' ? <Heats t={t} heats={await Promise.all(view.matches.map(async (m) => ({ m, rows: await heatOf(m.id) })))} names={names} mine={me.mineIds} tz={tz} />
            : <StandingsTable table={view.table} names={names} kind="time_trial" cfg={t.config} highlight={me.mineIds} />}
        </Box>);
      }
    } else if (tab === 'matches') {
      const ms = live?.ms ?? [];
      const groups: [string, Match[]][] = [['Active', ms.filter((m) => ['live', 'reported', 'disputed'].includes(m.status))], ['Up next', ms.filter((m) => m.status === 'ready')], ['Waiting for opponents', ms.filter((m) => m.status === 'pending')], ['Finished', ms.filter((m) => m.status === 'done' && (m.bracket === 'H' || (m.entryA !== null && m.entryB !== null)))]];
      if (!ms.length) body.push(<EmptyState title="No matches yet." />);
      for (const [title, list] of groups) if (list.length) body.push(<Box title={`${title} (${list.length})`}><MatchList t={t} ms={list} names={names} mine={me.mineIds} tz={tz} empty="" /></Box>);
      if (t.format === 'time_trial' && st) body.push(<Box title="Attempts"><AttemptsTable t={t} names={names} tz={tz} /></Box>);
    } else if (tab === 'standings') {
      if (!st) body.push(<EmptyState title="Standings appear once the tournament starts." />);
      else {
        body.push(<Box title={t.status === 'completed' ? 'Final standings' : 'Standings so far'}><StandingsTable table={st.overall} names={names} kind={['single_elim', 'double_elim', 'groups_playoffs'].includes(t.format) ? 'single_elim' : t.format} cfg={t.config} highlight={me.mineIds} /></Box>);
        if (t.status === 'completed') {
          const res = await db().select().from(results).where(eq(results.tournamentId, t.id));
          const cards = await services.users.cards(res.map((x) => x.userId).filter((x): x is number => !!x));
          body.push(<Box title="Ranking points awarded"><ul class="plain-list lt-awards">{[...res].sort((a, b) => a.place - b.place).map((x) => <li><strong>{x.place}.</strong> {x.userId ? <UserLink user={cards.get(x.userId)} /> : x.name}{x.teamName ? <span class="muted"> ({x.teamName})</span> : null} · {x.points} pts</li>)}</ul></Box>);
        }
      }
    } else if (tab === 'participants') {
      const userIds = all.map((e) => e.userId).filter((x): x is number => !!x);
      const rosters = new Map<number, { userId: number; role: string }[]>();
      for (const team of await teamsOf(t.id)) { const ms = (await membersOf(team.id)).filter((m) => m.status === 'active'); rosters.set(team.id, ms); userIds.push(...ms.map((m) => m.userId)); }
      const cards = await services.users.cards(userIds);
      const shown = all.filter((e) => e.status === 'approved' || (staff && e.status === 'pending'));
      body.push(<Box title={`${t.mode === 'team' ? 'Teams' : 'Players'} (${counted(all).length}${t.maxEntries ? ` of ${t.maxEntries}` : ''})`}>
        {t.maxEntries ? <p class="small muted">{Math.max(0, t.maxEntries - counted(all).length)} places left.</p> : null}
        <EntryList list={shown} cards={cards} teamRosters={rosters} showStatus={staff} />
      </Box>);
    } else if (tab === 'rules') {
      body.push(<Box title="Rules">{t.rules ? <div class="bb"><Html html={renderBBCode(t.rules, { embeds: false })} /></div> : <p class="muted">The organisers haven’t written rules yet.</p>}</Box>);
    }

    return ctx.render(c, t.name, (
      <div class="lt-page" data-lt-page>
        <Banner t={t} tz={tz}>
          <p class="lt-banner-actions">
            {t.status === 'in_progress' ? <a class="btn btn-small" href={`${base(t)}/live`}>Spectator view</a> : null}
            {staff ? <a class="btn btn-small btn-primary" href={`${base(t)}/manage`}>Manage</a> : null}
          </p>
        </Banner>
        {t.status === 'draft' ? <Notice type="warn">Draft: only staff can see this tournament.</Notice> : null}
        {t.status === 'cancelled' ? <Notice type="warn">This tournament was cancelled.</Notice> : null}
        <nav class="lt-tabs" aria-label="Tournament sections">{TABS.map(([k, l]) => <a href={k === 'overview' ? base(t) : `${base(t)}?tab=${k}`} aria-current={tab === k ? 'page' : undefined} class={tab === k ? 'active' : ''}>{l}</a>)}</nav>
        {body}
        <script src="/modules/lan-tournaments/tournaments.js" defer></script>
      </div>
    ), { crumbs: [{ label: 'Tournaments', href: '/m/lan-tournaments' }, { label: t.name }] });
  });

  async function ParticipationBox({ t, v, page, me, h: hh, tz, nextMine, names }: { t: Tournament; v: Viewer; page: PageCtx; me: Awaited<ReturnType<typeof myself>>; h: Helpers; tz: string; nextMine: Match | null; names: Map<number, string> }) {
    const closed = registrationClosedReason(t);
    const compete = v.user ? await v.can(hh.P.compete) : false;
    const checkinWhy = checkinClosedReason(t);
    const e = me.entry;
    const entryStatus = e ? <p>{e.status === 'approved' ? <span class="tag tag-ok">Registered</span> : e.status === 'pending' ? <span class="tag tag-held">Waiting for approval</span> : <span class="tag">Not accepted</span>}
      {e.checkedInAt ? <> <span class="tag tag-ok">Checked in</span></> : null}{e.station ? <> · station <strong>{e.station}</strong></> : null}</p> : null;
    const checkinBtn = e && e.status === 'approved' && !e.checkedInAt && !checkinWhy ? <ActionButton ctx={page} action={`${base(t)}/checkin`} label="Check in" className="btn btn-primary btn-small" /> : null;
    const nextLine = nextMine ? <p>Your next match: <a href={`${base(t)}/match/${nextMine.id}`}>{nextMine.code}</a> against <strong>{names.get(nextMine.entryA !== null && me.mineIds.has(nextMine.entryA) ? nextMine.entryB ?? -1 : nextMine.entryA ?? -1) ?? 'TBD'}</strong>{nextMine.scheduledAt ? <> at <Time d={nextMine.scheduledAt} tz={tz} /></> : null}{nextMine.station ? ` · ${nextMine.station}` : ''}</p> : null;

    if (!v.user) return <Box title="Take part">{closed ? <p class="muted">{closed}</p> : <p><a class="btn btn-primary" href={`/login?returnTo=${encodeURIComponent(base(t))}`}>Sign in to register</a></p>}</Box>;

    if (t.mode === 'solo') {
      return (
        <Box title="Your registration">
          {e && e.status !== 'withdrawn' ? <>{entryStatus}{nextLine}{checkinBtn}
            {['registration_open', 'registration_closed'].includes(t.status) ? <ActionButton ctx={page} action={`${base(t)}/withdraw`} label="Withdraw" className="btn btn-small btn-ghost" confirm="Withdraw from this tournament?" /> : null}</>
            : closed ? <p class="muted">{closed}</p>
            : !compete ? <p class="muted">You can’t register for tournaments.</p>
            : <form method="post" action={`${base(t)}/register`} class="inline-form"><Csrf ctx={page} /><button class="btn btn-primary">Register</button>{t.requireApproval ? <span class="small muted"> An organiser approves registrations.</span> : null}</form>}
        </Box>
      );
    }
    // teams
    const myTeam = me.team?.team ?? null;
    const invitations = (await db().select().from(teamMembers).where(eq(teamMembers.userId, v.user.id))).filter((m) => m.tournamentId === t.id && m.status === 'invited');
    if (!myTeam) {
      return (
        <Box title="Your team">
          {invitations.length ? <ul class="plain-list">{await Promise.all(invitations.map(async (inv) => { const team = await teamById(inv.teamId); return <li>You’re invited to join <strong>{team?.name}</strong>{inv.role === 'sub' ? ' as a substitute' : ''}.{' '}
            <ActionButton ctx={page} action={`${base(t)}/team/${inv.teamId}/answer`} fields={{ accept: '1' }} label="Accept" className="btn btn-small btn-primary" />{' '}
            <ActionButton ctx={page} action={`${base(t)}/team/${inv.teamId}/answer`} fields={{ accept: '0' }} label="Decline" className="btn btn-small btn-ghost" /></li>; }))}</ul> : null}
          {closed ? <p class="muted">{closed}</p> : !compete ? <p class="muted">You can’t register for tournaments.</p> : (
            <form method="post" action={`${base(t)}/team`} class="form-grid"><Csrf ctx={page} />
              <p>Create a team and invite your teammates. You’ll be its captain.</p>
              <div class="field-row"><Field label="Team name" name="name" required maxlength={60} /><Field label="Tag (optional)" name="tag" maxlength={8} placeholder="e.g. FRG" /></div>
              <div class="form-actions"><button class="btn btn-primary btn-small">Create team</button></div>
            </form>)}
        </Box>
      );
    }
    const roster = await membersOf(myTeam.id);
    const cards = await services.users.cards(roster.map((m) => m.userId));
    const captain = myTeam.captainId === v.user.id;
    const players = roster.filter((m) => m.status === 'active' && m.role !== 'sub').length;
    const locked = ['in_progress', 'completed', 'cancelled'].includes(t.status);
    return (
      <Box title={`Your team: ${myTeam.name}${myTeam.tag ? ` [${myTeam.tag}]` : ''}`}>
        {entryStatus ?? <p class="muted">Not registered yet{players < t.teamMin ? `: you need ${t.teamMin - players} more player${t.teamMin - players === 1 ? '' : 's'}` : ''}.</p>}
        {nextLine}{checkinBtn}
        <ul class="plain-list lt-roster-list">{roster.map((m) => <li><UserLink user={cards.get(m.userId)} /> <span class="small muted">{m.role === 'captain' ? 'captain' : m.role === 'sub' ? 'substitute' : 'player'}{m.status === 'invited' ? ' · invited' : ''}</span>
          {captain && !locked && m.userId !== v.user!.id ? <> <ActionButton ctx={page} action={`${base(t)}/team/${myTeam.id}/remove`} fields={{ userId: m.userId }} label={m.status === 'invited' ? 'Cancel invite' : 'Remove'} className="btn btn-small btn-ghost" />
            {m.status === 'active' ? <ActionButton ctx={page} action={`${base(t)}/team/${myTeam.id}/captain`} fields={{ userId: m.userId }} label="Make captain" className="btn btn-small btn-ghost" confirm="Hand the captaincy over?" /> : null}</> : null}</li>)}</ul>
        {captain && !locked ? (
          <>
            <form method="post" action={`${base(t)}/team/${myTeam.id}/invite`} class="inline-form lt-invite"><Csrf ctx={page} />
              <label for="lt-inv">Invite</label> <input id="lt-inv" name="username" required maxlength={40} placeholder="Username" data-member-autocomplete list="lt-inv-list" /><datalist id="lt-inv-list" />
              <select name="role" aria-label="As"><option value="player">as a player</option>{t.subsMax ? <option value="sub">as a substitute</option> : null}</select>
              <button class="btn btn-small">Invite</button></form>
            <p class="lt-team-actions">
              {!e || e.status === 'withdrawn' || e.status === 'rejected' ? (closed ? <span class="muted">{closed}</span> : <ActionButton ctx={page} action={`${base(t)}/team/${myTeam.id}/register`} label="Register the team" className="btn btn-primary btn-small" />)
                : <ActionButton ctx={page} action={`${base(t)}/withdraw`} label="Withdraw the team" className="btn btn-small btn-ghost" confirm="Withdraw your team from this tournament?" />}
              {' '}<ActionButton ctx={page} action={`${base(t)}/team/${myTeam.id}/disband`} label="Disband team" className="btn btn-small btn-ghost" confirm="Disband the team? This withdraws it from the tournament." />
            </p>
          </>
        ) : !locked ? <ActionButton ctx={page} action={`${base(t)}/team/${myTeam.id}/remove`} fields={{ userId: v.user.id }} label="Leave team" className="btn btn-small btn-ghost" confirm="Leave this team?" /> : null}
      </Box>
    );
  }

  function AttemptsTable({ t, names, tz }: { t: Tournament; names: Map<number, string>; tz: string }) {
    const cfg = withDefaults(t.config);
    return (async () => {
      const list = (await attemptsOf(t.id)).filter((a) => a.status !== 'rejected').reverse().slice(0, 50);
      return list.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">When</th><th scope="col">Entry</th><th scope="col">Result</th><th scope="col">Status</th></tr></thead><tbody>
        {list.map((a) => <tr><td><Time d={a.createdAt} tz={tz} mode="ago" /></td><td>{names.get(a.entryId)}</td><td>{formatValue(a.value, cfg.scoreUnit)}</td><td>{a.status === 'approved' ? <span class="tag tag-ok">Counted</span> : <span class="tag tag-held">Being checked</span>}</td></tr>)}
      </tbody></table></div> : <p class="muted">No attempts yet.</p>;
    })();
  }

  // ───────── registration and teams ─────────
  const act = (path: string, fn: (c: RequestContext, t: Tournament, v: Viewer) => Promise<string | void>) =>
    r.post(`/:slug/${path}`, async (c) => {
      const { t, v } = await h.load(c);
      if (!v.user) throw new ServiceError('Sign in first.', 401, 'login_required');
      try { const msg = await fn(c, t, v); if (msg) setFlash(c, { type: 'ok', text: msg }); }
      catch (e) { h.flash(c, e); }
      const back = c.req.header('referer');
      return c.redirect(back && back.includes(base(t)) ? new URL(back).pathname + (new URL(back).search ?? '') : base(t));
    });

  act('register', async (_c, t, v) => {
    await v.require(h.P.compete);
    const e = await registerSolo(t, v.user!.id, h.elig(t));
    await notifyUsers([v.user!.id], null, e.status === 'approved' ? `You’re registered for ${t.name}.` : `Your registration for ${t.name} is waiting for an organiser’s approval.`, base(t));
    if (e.status === 'pending') await (await import('./service.ts')).notifyStaff(t.id, v.user!.id, `${t.name}: ${v.user!.username} is waiting for approval.`, `${base(t)}/manage#registrations`, ['organiser']);
    return e.status === 'approved' ? 'You’re registered!' : 'Registered. An organiser will approve it.';
  });
  act('withdraw', async (_c, t, v) => {
    const e = await entryOfUser(t, v.user!.id);
    if (!e || !(ACTIVE_ENTRY as readonly string[]).includes(e.status)) throw new ServiceError('You’re not registered.', 404);
    if (e.teamId) { const team = await teamById(e.teamId); if (team?.captainId !== v.user!.id) throw new ServiceError('Only the captain can withdraw the team.', 403); }
    await withdrawEntry(t, e);
    return 'Withdrawn.';
  });
  act('checkin', async (_c, t, v) => {
    const e = await entryOfUser(t, v.user!.id);
    if (!e) throw new ServiceError('You’re not registered.', 404);
    if (e.teamId && !(await actorsOfEntry(e)).includes(v.user!.id)) throw new ServiceError('The team captain checks the team in.', 403);
    await checkIn(t, e);
    return 'Checked in. Good luck!';
  });
  act('team', async (c, t, v) => {
    await v.require(h.P.compete);
    const b = await form(c);
    const team = await createTeam(t, v.user!.id, str(b.name), str(b.tag));
    return `Team ${team.name} created. Invite your teammates.`;
  });
  const teamAct = (path: string, fn: (c: RequestContext, t: Tournament, v: Viewer, teamId: number) => Promise<string>) =>
    act(`team/:team/${path}`, async (c, t, v) => fn(c, t, v, int(c.req.param('team'))));
  const ownTeam = async (t: Tournament, v: Viewer, teamId: number, captainOnly = true) => {
    const team = await teamById(teamId);
    if (!team || team.tournamentId !== t.id) throw new ServiceError('Team not found.', 404);
    if (captainOnly && team.captainId !== v.user!.id && !(await h.can(v, t, 'participants'))) throw new ServiceError('Only the captain can do that.', 403);
    return team;
  };
  teamAct('invite', async (c, t, v, id) => {
    const team = await ownTeam(t, v, id);
    const b = await form(c);
    const u = await services.users.getByUsername(str(b.username).trim());
    if (!u) throw new ServiceError('There’s no member with that username.', 404);
    await inviteToTeam(t, team, u.id, str(b.role) === 'sub' ? 'sub' : 'player');
    await notifyUsers([u.id], v.user!.id, `${v.user!.username} invited you to ${team.name} for ${t.name}.`, base(t));
    return `Invited ${u.username}.`;
  });
  teamAct('answer', async (c, t, v, id) => {
    const team = await ownTeam(t, v, id, false);
    const accept = str((await form(c)).accept) === '1';
    await answerInvite(t, team, v.user!.id, accept);
    if (team.captainId) await notifyUsers([team.captainId], v.user!.id, `${v.user!.username} ${accept ? 'joined' : 'declined to join'} ${team.name}.`, base(t));
    return accept ? `You joined ${team.name}.` : 'Invitation declined.';
  });
  teamAct('remove', async (c, t, v, id) => {
    const userId = int(str((await form(c)).userId));
    const team = await ownTeam(t, v, id, userId !== v.user!.id);
    await removeFromTeam(t, team, userId, { byStaff: await h.can(v, t, 'participants') });
    return userId === v.user!.id ? `You left ${team.name}.` : 'Removed from the team.';
  });
  teamAct('captain', async (c, t, v, id) => {
    const team = await ownTeam(t, v, id);
    await setCaptain(team, int(str((await form(c)).userId)));
    return 'Captaincy handed over.';
  });
  teamAct('disband', async (_c, t, v, id) => {
    const team = await ownTeam(t, v, id);
    await disbandTeam(t, team, { byStaff: await h.can(v, t, 'participants') });
    return 'Team disbanded.';
  });
  teamAct('register', async (_c, t, v, id) => {
    await v.require(h.P.compete);
    const team = await ownTeam(t, v, id);
    const e = await registerTeam(t, team, h.elig(t));
    const roster = (await membersOf(team.id)).filter((m) => m.status === 'active').map((m) => m.userId);
    await notifyUsers(roster, v.user!.id, e.status === 'approved' ? `${team.name} is registered for ${t.name}.` : `${team.name}’s registration for ${t.name} is waiting for approval.`, base(t));
    return e.status === 'approved' ? `${team.name} is registered!` : 'Registered. An organiser will approve it.';
  });

  // ───────── matches ─────────
  const loadMatch = async (c: RequestContext) => {
    const x = await h.load(c);
    const m = await matchById(int(c.req.param('id')));
    if (!m || m.tournamentId !== x.t.id) throw new ServiceError('Match not found.', 404);
    return { ...x, m };
  };
  /** Which side of a head-to-head match the viewer acts for, if any. */
  const sideOf = async (m: Match, userId: number | null): Promise<'a' | 'b' | null> => {
    if (!userId) return null;
    for (const [side, id] of [['a', m.entryA], ['b', m.entryB]] as const) {
      if (id === null) continue;
      const e = (await db().select().from(entriesTable).where(eq(entriesTable.id, id)))[0];
      if (e && (await actorsOfEntry(e)).includes(userId)) return side;
    }
    return null;
  };

  r.get('/:slug/match/:id', async (c) => {
    const { t, v, page, m } = await loadMatch(c);
    const tz = h.tz(page);
    const names = await h.names(t);
    const staffScores = await h.can(v, t, 'scores');
    const staffDisputes = await h.can(v, t, 'disputes');
    const staffSchedule = await h.can(v, t, 'schedule');
    const reps = await reportsOf(m.id);
    const pending = reps.find((x) => x.status === 'pending');
    const all = await matchesOf(t.id);
    const rn = roundName(m, Math.max(0, ...all.filter((x) => x.bracket === 'W' && x.stageId === m.stageId).map((x) => x.round)), Math.max(0, ...all.filter((x) => x.bracket === 'L').map((x) => x.round)));
    const running = t.status === 'in_progress';
    const verField = <input type="hidden" name="version" value={String(m.version)} />;
    let main: Child;
    if (m.bracket === 'H') {
      const heat = await heatOf(m.id);
      const myEntry = v.user ? await entryOfUser(t, v.user.id) : null;
      const inHeat = !!myEntry && heat.some((x) => x.entryId === myEntry.id) && (await actorsOfEntry(myEntry)).includes(v.user!.id);
      const prefill = pending?.placements ?? Object.fromEntries(heat.map((x) => [String(x.entryId), x.placement ?? '']));
      main = (
        <>
          <Box title="Placings">
            <ol class="lt-heat-result">{[...heat].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99)).map((x) => <li class={x.placement === 1 ? 'is-winner' : ''}><strong>{names.get(x.entryId)}</strong>{x.placement ? <span> · {x.placement}. · {x.points} pts</span> : null}</li>)}</ol>
            {pending ? <Notice type="info">Placings were reported and are waiting for another player in the heat to confirm them.</Notice> : null}
            {m.status === 'disputed' ? <Notice type="warn">Players reported different placings. A referee will settle it.</Notice> : null}
          </Box>
          {running && m.status !== 'done' && (inHeat || staffScores || staffDisputes) && (m.status !== 'disputed' || staffDisputes) ? (
            <Box title={staffScores || staffDisputes ? 'Enter placings' : pending ? 'Confirm the placings' : 'Report placings'}>
              <form method="post" action={`${base(t)}/match/${m.id}/heat`} class="form-grid"><Csrf ctx={page} />
                <div class="lt-place-grid">{heat.map((x) => <div class="field"><label for={`pl-${x.entryId}`}>{names.get(x.entryId)}</label>
                  <select id={`pl-${x.entryId}`} name={`p_${x.entryId}`} required><option value="">Placing…</option>{heat.map((_, i) => <option value={String(i + 1)} selected={String(prefill[String(x.entryId)]) === String(i + 1)}>{i + 1}</option>)}</select></div>)}</div>
                <div class="form-actions"><button class="btn btn-primary btn-small">{staffScores || staffDisputes ? 'Save placings' : pending ? 'Confirm' : 'Report'}</button></div>
              </form>
            </Box>) : null}
        </>
      );
    } else {
      const side = await sideOf(m, v.user?.id ?? null);
      const canReport = running && !!side && ['ready', 'live', 'reported'].includes(m.status) && (!pending || pending.side === side);
      const canConfirm = running && !!side && pending && pending.side !== side && m.status === 'reported';
      const nameA = m.entryA !== null ? names.get(m.entryA) : 'TBD', nameB = m.entryB !== null ? names.get(m.entryB) : 'TBD';
      const ScoreForm = ({ action, label }: { action: string; label: string }) => (
        <form method="post" action={action} class="form-grid lt-score-form"><Csrf ctx={page} />{verField}
          <div class="lt-score-inputs">
            <div class="field"><label for={`sa-${action}`}>{nameA}</label><input id={`sa-${action}`} name="scoreA" type="number" min="0" max="9999" required inputmode="numeric" value={m.scoreA ?? pending?.scoreA ?? ''} /></div>
            <span class="lt-vs" aria-hidden="true">–</span>
            <div class="field"><label for={`sb-${action}`}>{nameB}</label><input id={`sb-${action}`} name="scoreB" type="number" min="0" max="9999" required inputmode="numeric" value={m.scoreB ?? pending?.scoreB ?? ''} /></div>
          </div>
          <p class="small muted">{m.bestOf > 1 ? `Games won: the winner has ${Math.ceil(m.bestOf / 2)}.` : 'The final score of the game.'}</p>
          <div class="form-actions"><button class="btn btn-primary btn-small">{label}</button></div>
        </form>
      );
      main = (
        <>
          <section class="lt-versus" aria-label="Score">
            <div class={`lt-vs-side ${m.winner !== null && m.winner === m.entryA ? 'is-winner' : ''}`}><span class="lt-vs-name">{nameA}</span><span class="lt-vs-score">{m.scoreA ?? (pending?.scoreA ?? '–')}</span></div>
            <span class="lt-vs-mid">{m.status === 'done' ? (m.isDraw ? 'Draw' : 'Final') : pending ? 'Reported' : 'vs'}</span>
            <div class={`lt-vs-side ${m.winner !== null && m.winner === m.entryB ? 'is-winner' : ''}`}><span class="lt-vs-name">{nameB}</span><span class="lt-vs-score">{m.scoreB ?? (pending?.scoreB ?? '–')}</span></div>
          </section>
          {m.status === 'disputed' ? <Notice type="warn" title="Disputed">{reps.filter((x) => x.status === 'disputed' && x.disputeReason).map((x) => <p>“{x.disputeReason}”</p>)}A referee will settle the result.</Notice> : null}
          {pending && m.status === 'reported' ? <Notice type="info">{pending.side === side ? 'You reported this score. Waiting for your opponent to confirm.' : `${pending.side === 'a' ? nameA : nameB} reported ${pending.scoreA}–${pending.scoreB}.`}</Notice> : null}
          {canConfirm ? <Box title="Is this the right score?">
            <ActionButton ctx={page} action={`${base(t)}/match/${m.id}/confirm`} label={`Confirm ${pending!.scoreA}–${pending!.scoreB}`} className="btn btn-primary btn-small" />
            <form method="post" action={`${base(t)}/match/${m.id}/dispute`} class="form-grid lt-dispute"><Csrf ctx={page} />
              <Field label="What’s wrong? (sent to the referees)" name="reason" required maxlength={300} />
              <div class="form-actions"><button class="btn btn-small">Dispute</button> <span class="small muted">or report the score you think is right below</span></div>
            </form>
          </Box> : null}
          {canReport || (canConfirm && side) ? <Box title={pending && pending.side === side ? 'Change your report' : 'Report the score'}><ScoreForm action={`${base(t)}/match/${m.id}/report`} label="Report score" /></Box> : null}
          {running && (staffScores || staffDisputes) && m.entryA !== null && m.entryB !== null && m.status !== 'void' && (m.status !== 'done' || staffDisputes) ? (
            <Box title={m.status === 'done' ? 'Correct the result (referee)' : m.status === 'disputed' ? 'Settle the dispute (referee)' : 'Enter the result (referee)'}>
              <ScoreForm action={`${base(t)}/match/${m.id}/override`} label={m.status === 'done' ? 'Correct result' : 'Save result'} />
              {m.status === 'done' ? <p class="small muted">Correcting a result works while the matches it fed haven’t been played.</p> : null}
            </Box>) : null}
        </>
      );
    }
    const staffBox = running && staffSchedule && m.status !== 'done' && m.status !== 'void' ? (
      <Box title="Schedule">
        <form method="post" action={`${base(t)}/match/${m.id}/schedule`} class="form-grid"><Csrf ctx={page} />
          <div class="field-row">
            <Field label={`Time (${tz})`} name="at" type="datetime-local" value={m.scheduledAt ? new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(m.scheduledAt).replace(' ', 'T') : ''} />
            <Field label="Station" name="station" value={m.station} maxlength={40} placeholder="e.g. Stage PC 2" />
          </div>
          <div class="form-actions"><button class="btn btn-small">Save</button>
            {m.bracket !== 'H' && (m.status === 'ready' || m.status === 'live') ? <> <button class="btn btn-small" name="live" value={m.status === 'live' ? '0' : '1'} formaction={`${base(t)}/match/${m.id}/live`}>{m.status === 'live' ? 'Not live any more' : 'Mark as live'}</button></> : null}</div>
        </form>
      </Box>) : null;
    const reportLog = reps.length && (await h.isStaff(v, t)) ? <Box title="Report history"><ul class="plain-list small">{reps.map((x) => <li><Time d={x.createdAt} tz={tz} /> · {x.side === 'staff' ? 'referee' : x.side.startsWith('e') ? names.get(int(x.side.slice(1))) : x.side === 'a' ? names.get(m.entryA ?? -1) : names.get(m.entryB ?? -1)}: {x.placements ? Object.entries(x.placements).map(([e, p]) => `${names.get(int(e))} ${p}`).join(', ') : `${x.scoreA ?? '?'}–${x.scoreB ?? '?'}`} · {x.status}{x.disputeReason ? ` (“${x.disputeReason}”)` : ''}</li>)}</ul></Box> : null;

    return ctx.render(c, `${m.code} · ${t.name}`, (
      <div class="lt-page">
        <p><a href={`${base(t)}?tab=bracket`}>← {t.name}</a></p>
        <h1 class="page-title">{rn} · {m.code}</h1>
        <p class="page-desc"><span class={`lt-ms lt-ms-${m.status}`}>{MATCH_STATUS[m.status]}</span>{m.bestOf > 1 ? ` · best of ${m.bestOf}` : ''}{m.scheduledAt ? <> · <Time d={m.scheduledAt} tz={tz} /></> : null}{m.station ? ` · ${m.station}` : ''}</p>
        {main}{staffBox}{reportLog}
      </div>
    ), { crumbs: [{ label: 'Tournaments', href: '/m/lan-tournaments' }, { label: t.name, href: base(t) }, { label: m.code }] });
  });

  const matchAct = (path: string, fn: (c: RequestContext, t: Tournament, v: Viewer, m: Match) => Promise<string>) =>
    r.post(`/:slug/match/:id/${path}`, async (c) => {
      const { t, v, m } = await loadMatch(c);
      if (!v.user) throw new ServiceError('Sign in first.', 401, 'login_required');
      const lim = await services.rateLimit(`lan-tournaments:${v.user.id}`, { max: 120, windowSec: 3600 });
      if (!lim.ok) throw new ServiceError('Too many score changes. Try again later.', 429);
      try { setFlash(c, { type: 'ok', text: await fn(c, t, v, m) }); } catch (e) { h.flash(c, e); }
      return c.redirect(`${base(t)}/match/${m.id}`);
    });
  const scores = async (c: RequestContext) => { const b = await form(c); return { o: { scoreA: Number(str(b.scoreA)), scoreB: Number(str(b.scoreB)) }, version: str(b.version) ? int(str(b.version)) : undefined, b }; };

  matchAct('report', async (c, t, v, m) => {
    const side = await sideOf(m, v.user!.id);
    if (!side) throw new ServiceError('Only the players in this match (or a referee) can report it.', 403);
    const { o, version } = await scores(c);
    const res = await reportScore(t, m, { userId: v.user!.id, side }, o, version);
    return res.state === 'final' ? 'Result confirmed by both sides.' : res.state === 'disputed' ? 'Your report doesn’t match your opponent’s, so the match is disputed. A referee will settle it.' : 'Score reported. Your opponent needs to confirm it.';
  });
  matchAct('confirm', async (_c, t, v, m) => {
    const side = await sideOf(m, v.user!.id);
    if (!side) throw new ServiceError('Only the players in this match can confirm it.', 403);
    await confirmReport(t, m, side, v.user!.id);
    return 'Result confirmed.';
  });
  matchAct('dispute', async (c, t, v, m) => {
    const side = await sideOf(m, v.user!.id);
    if (!side) throw new ServiceError('Only the players in this match can dispute it.', 403);
    await disputeReport(t, m, side, v.user!.id, str((await form(c)).reason));
    return 'Disputed. A referee will look at it.';
  });
  matchAct('heat', async (c, t, v, m) => {
    const b = await form(c);
    const placements = Object.fromEntries(Object.entries(b).filter(([k]) => /^p_\d+$/.test(k)).map(([k, val]) => [k.slice(2), Number(str(val))]));
    const staffMember = (await h.can(v, t, 'scores')) || (await h.can(v, t, 'disputes'));
    if (m.status === 'disputed' && !(await h.can(v, t, 'disputes'))) throw new ServiceError('A referee will settle this heat.', 403);
    const mine = await entryOfUser(t, v.user!.id);
    const state = await reportHeat(t, m, { userId: v.user!.id, entryId: mine && (await actorsOfEntry(mine)).includes(v.user!.id) ? mine.id : null, staff: staffMember }, placements);
    if (staffMember) await h.audit(v, 'heat.result', t, { match: m.code });
    return state === 'final' ? 'Placings saved.' : state === 'disputed' ? 'Your placings don’t match the reported ones, so the heat is disputed.' : 'Placings reported. Another player in the heat needs to confirm them.';
  });

  // ───────── time challenge ─────────
  act('attempt', async (c, t, v) => {
    const e = await entryOfUser(t, v.user!.id);
    if (!e || e.status !== 'approved') throw new ServiceError('You’re not in this challenge.', 403);
    const b = await form(c);
    const cfg = withDefaults(t.config);
    const value = parseValue(str(b.value), cfg.scoreUnit);
    if (value === null) throw new ServiceError(cfg.scoreUnit === 'time' ? 'Enter a time like 1:02.345.' : 'Enter a whole number.');
    await submitAttempt(t, e, value, str(b.proof), v.user!.id, false);
    return cfg.verifyAttempts ? 'Attempt submitted. A referee will check it.' : 'Attempt recorded.';
  });

  // ───────── spectator view and API ─────────
  async function LiveBoard({ t, tz }: { t: Tournament; tz: string }) {
    const names = await h.names(t);
    const live = await liveData(t);
    const st = await standings(t);
    const anns = (await announcementsOf(t.id)).slice(0, 2);
    const view = st.stages.find((s) => s.stage.status !== 'done') ?? st.stages.at(-1);
    const kind = view?.stage.kind ?? 'single_elim';
    return (
      <div class="lt-live-grid" data-live-board>
        <section class="lt-live-panel lt-live-now"><h2>Live now</h2><MatchList t={t} ms={live.active} names={names} tz={tz} empty="No matches in play." /></section>
        <section class="lt-live-panel"><h2>Up next</h2><MatchList t={t} ms={live.upcoming.slice(0, 6)} names={names} tz={tz} empty="Nothing scheduled." /></section>
        <section class="lt-live-panel lt-live-wide">{view && (kind === 'single_elim' || kind === 'double_elim') ? <><h2>{view.stage.name}</h2><Bracket t={t} view={view} names={names} tz={tz} /></>
          : view && kind === 'round_robin' ? <><h2>{view.stage.name}</h2><div class="lt-groups">{view.groups.map((g) => <StandingsTable table={g.table} names={names} kind="round_robin" cfg={t.config} caption={view.groups.length > 1 ? `Group ${g.label}` : undefined} />)}</div></>
          : <><h2>Standings</h2><StandingsTable table={st.overall} names={names} kind={kind} cfg={t.config} limit={12} /></>}</section>
        <section class="lt-live-panel"><h2>Recent results</h2><MatchList t={t} ms={live.recent.slice(0, 6)} names={names} tz={tz} empty="No results yet." /></section>
        <section class="lt-live-panel"><h2>Announcements</h2>{anns.length ? anns.map((a) => <div class="bb lt-ann"><Html html={renderBBCode(a.body, { embeds: false })} /></div>) : <p class="muted">None.</p>}</section>
        <div class="lt-live-progress" role="progressbar" aria-label="Matches played" aria-valuemin={0} aria-valuemax={100} aria-valuenow={live.progress}><span class={`lt-progress-bar lt-w-${Math.round(live.progress / 5) * 5}`} /></div>
      </div>
    );
  }

  r.get('/:slug/live', async (c) => {
    const { t, page } = await h.load(c);
    const tz = h.tz(page);
    return ctx.render(c, `${t.name} · live`, (
      <div class="lt-spectator" data-spectator data-refresh={`${base(t)}/live/board`}>
        <div class="lt-spectator-head">
          <div><p class="lt-kicker">{[t.game, FORMATS[t.format as FormatId]].filter(Boolean).join(' · ')}</p><h1 class="lt-title">{t.name}</h1><StatusTag t={t} /></div>
          <div class="lt-spectator-tools"><span class="small muted" data-updated>Updates every 10 seconds</span> <button type="button" class="btn btn-small" data-fullscreen hidden>Full screen</button> <a class="btn btn-small" href={base(t)}>Tournament page</a></div>
        </div>
        <div data-board>{await LiveBoard({ t, tz })}</div>
        <script src="/modules/lan-tournaments/tournaments.js" defer></script>
      </div>
    ), { crumbs: [{ label: 'Tournaments', href: '/m/lan-tournaments' }, { label: t.name, href: base(t) }, { label: 'Live' }], noPane: true });
  });
  r.get('/:slug/live/board', async (c) => {
    const { t, page } = await h.load(c);
    c.header('Cache-Control', 'no-store');
    return c.html(String(await LiveBoard({ t, tz: h.tz(page) })));
  });

  r.get('/:slug/data.json', async (c) => {
    const { t, staff } = await h.load(c);
    const names = await h.names(t);
    const st = ['in_progress', 'completed'].includes(t.status) ? await standings(t) : null;
    const ents = await entriesOf(t.id);
    return c.json({
      tournament: { slug: t.slug, name: t.name, game: t.game, platform: t.platform, format: t.format, status: t.status, statusLabel: STATUSES[t.status as Status], mode: t.mode, startsAt: t.startsAt, endsAt: t.endsAt, config: withDefaults(t.config) },
      entries: ents.filter((e) => e.status === 'approved' || (staff && e.status === 'pending')).map((e) => ({ id: e.id, name: e.name, status: e.status, seed: e.seed, checkedIn: !!e.checkedInAt, station: e.station })),
      matches: (st?.stages.flatMap((s) => s.matches) ?? []).map((m) => ({ id: m.id, code: m.code, stage: m.stageId, bracket: m.bracket, round: m.round, status: m.status, a: m.entryA, b: m.entryB, aName: m.entryA ? names.get(m.entryA) : null, bName: m.entryB ? names.get(m.entryB) : null, scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, scheduledAt: m.scheduledAt, station: m.station })),
      standings: st?.overall.map((s) => ({ place: s.place, entry: s.entry, name: names.get(s.entry), wins: s.wins, losses: s.losses, draws: s.draws, points: s.points })) ?? [],
    });
  });

  // ───────── profile ─────────
  ctx.register.profileSection({
    id: 'lan-tournaments', column: 'main', order: 45,
    async render({ user, ctx: page }) {
      const rows = await historyOf(user.id);
      if (!rows.length) return null;
      const titles = rows.filter((x) => x.r.place === 1).length, podiums = rows.filter((x) => x.r.place <= 3).length;
      const w = rows.reduce((s, x) => s + x.r.wins, 0), l = rows.reduce((s, x) => s + x.r.losses, 0);
      return (
        <Box title="Tournaments" headingLevel={3}>
          <p class="lt-profile-stats"><strong>{rows.length}</strong> played · <strong>{titles}</strong> won · <strong>{podiums}</strong> podiums · matches {w}–{l}</p>
          <ul class="plain-list lt-profile-list">{rows.slice(0, 8).map((x) => <li><span class={`lt-medal lt-medal-${x.r.place <= 3 ? x.r.place : 0}`}>{x.r.place}</span> <a href={`/m/lan-tournaments/${x.slug}`}>{x.name}</a>{x.r.teamName ? <span class="muted"> with {x.r.teamName}</span> : null}{x.at ? <span class="small muted"> · <Time d={x.at} tz={page.viewer.user?.timezone ?? 'UTC'} mode="date" /></span> : null}</li>)}</ul>
        </Box>
      );
    },
  });

  void Select; void inArray; void desc;
}
