/** @jsxImportSource hono/jsx */
/** Organiser pages: create and edit, the management dashboard, and every staff action. All audited. */
import {
  Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Time, UserLink, Stat, EmptyState,
  form, str, int, bool, arr, setFlash, parseLocalDateTime, toLocalInput, services, media, database, eq, ServiceError,
  type ModuleContext, type RequestContext, type Viewer, type PageCtx,
} from '../../src/sdk/index.ts';
import { FORMATS, withDefaults, formatValue, type FormatId, type FormatConfig } from './formats.ts';
import {
  STATUSES, VISIBILITY, ROLES, entriesOf, counted, teamsOf, membersOf, invitesOf, staffOf, createTournament, updateTournament, setStatus, setArchived, deleteTournament,
  setStaff, reviewEntry, withdrawEntry, invite, uninvite, checkIn, setSeedsAndStations, registerSolo, registerTeam, teamById, announce, announcementsOf,
  notifyEntry, notifyParticipants, notifyUsers, entryById, type TournamentInput, type Status, type Role,
} from './service.ts';
import {
  generateBracket, resetBracket, swapEntries, scheduleRound, scheduleMatch, setLive, matchesOf, matchById, stagesOf, attemptsOf, reviewAttempt, endChallenge,
  publishResults, cancelNotice, seededEntries, standings,
} from './matches.ts';
import { TEMPLATES, templateByKey } from './templates.ts';
import { StatusTag, MATCH_STATUS, base } from './ui.tsx';
import type { Helpers } from './context.ts';
import { tournaments, type Tournament } from './schema.ts';

const list = (raw: string) => raw.split(/[\s,;]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
const optInt = (raw: unknown) => { const s = str(raw).trim(); return s === '' ? null : Number(s); };

/** Read the create/edit form into validated-ready input (validation itself is in service.validateTournament). */
function readForm(b: Record<string, unknown>, tz: string): TournamentInput {
  const d = (k: string) => (str(b[k]) ? parseLocalDateTime(str(b[k]), tz) : null);
  const n = (k: string, dflt: number) => { const s = str(b[k]).trim(); return s === '' ? dflt : Number(s); };
  const config: Partial<FormatConfig> = {
    bestOf: n('bestOf', 1), finalBestOf: n('finalBestOf', n('bestOf', 1)), thirdPlace: bool(b.thirdPlace), grandFinalReset: bool(b.grandFinalReset),
    groups: n('groups', 2), advancePerGroup: n('advancePerGroup', 2), playoff: str(b.playoff) === 'double_elim' ? 'double_elim' : 'single_elim',
    ffaRounds: n('ffaRounds', 3), heatSize: n('heatSize', 8), points: { win: n('pWin', 3), draw: n('pDraw', 1), loss: n('pLoss', 0) }, allowDraws: bool(b.allowDraws),
    winCondition: str(b.winCondition) === 'lower' ? 'lower' : 'higher', scoreUnit: str(b.scoreUnit) === 'time' ? 'time' : 'points', verifyAttempts: bool(b.verifyAttempts),
    seeding: (['registration', 'random', 'manual'] as const).find((x) => x === str(b.seeding)) ?? 'registration', participationPoints: n('participationPoints', 0),
  };
  if (str(b.swissRounds).trim()) config.swissRounds = n('swissRounds', 3);
  if (str(b.ffaPoints).trim()) config.ffaPoints = list(str(b.ffaPoints));
  if (str(b.rankingPoints).trim()) config.rankingPoints = list(str(b.rankingPoints));
  return {
    name: str(b.name), game: str(b.game), platform: str(b.platform), description: str(b.description), rules: str(b.rules),
    visibility: (str(b.visibility) || 'public') as TournamentInput['visibility'], mode: str(b.mode) === 'team' ? 'team' : 'solo',
    teamMin: n('teamMin', 1), teamMax: n('teamMax', 1), subsMax: n('subsMax', 0), maxEntries: optInt(b.maxEntries),
    requireApproval: bool(b.requireApproval), requireCheckin: bool(b.requireCheckin), requireBooking: bool(b.requireBooking),
    format: (str(b.format) || 'single_elim') as FormatId, config, lanEventId: optInt(b.lanEventId) || null,
    regOpensAt: d('regOpensAt'), regClosesAt: d('regClosesAt'), checkinOpensAt: d('checkinOpensAt'), startsAt: d('startsAt'), endsAt: d('endsAt'),
  };
}

export function registerManage(ctx: ModuleContext, h: Helpers) {
  const r = ctx.routes;

  async function TournamentForm({ page, t, values, events, action }: { page: PageCtx; t?: Tournament; values: Partial<TournamentInput>; events: { id: number; name: string }[]; action: string }) {
    const tz = h.tz(page);
    const c = withDefaults(values.config ?? {});
    const started = !!t && ['in_progress', 'completed'].includes(t.status);
    const dt = (k: keyof TournamentInput) => toLocalInput((values[k] as Date | null) ?? null, tz);
    return (
      <form method="post" action={action} class="form-grid lt-form" enctype="multipart/form-data" data-lt-form><Csrf ctx={page} />
        <fieldset class="lt-fs"><legend>Basics</legend>
          <Field label="Name" name="name" value={values.name ?? ''} required maxlength={120} />
          <div class="field-row"><Field label="Game" name="game" value={values.game ?? ''} maxlength={80} placeholder="e.g. Counter-Strike 2" /><Field label="Platform" name="platform" value={values.platform ?? ''} maxlength={40} placeholder="PC, PS5, Switch…" /></div>
          <TextArea label="Description (BBCode)" name="description" value={values.description ?? ''} rows={4} maxlength={10000} />
          <TextArea label="Rules (BBCode)" name="rules" value={values.rules ?? ''} rows={6} maxlength={20000} />
          <div class="field"><label for="f-banner">Banner image (optional)</label><input id="f-banner" type="file" name="banner" accept="image/png,image/jpeg,image/webp,image/gif" /><div class="field-hint">Shown cropped to 1600×500. {t?.bannerUrl ? 'Leave empty to keep the current banner.' : ''}</div></div>
          {t?.bannerUrl ? <Checkbox label="Remove the current banner" name="removeBanner" /> : null}
        </fieldset>
        <fieldset class="lt-fs"><legend>Who can play</legend>
          <div class="field-row">
            <Select label="Visibility" name="visibility" value={values.visibility ?? 'public'} options={Object.entries(VISIBILITY)} />
            <Select label="Players" name="mode" value={values.mode ?? 'solo'} options={[['solo', 'Solo players'], ['team', 'Teams']]} />
            <Field label="Places (empty = no limit)" name="maxEntries" type="number" value={values.maxEntries ? String(values.maxEntries) : ''} attrs={{ min: '2', max: '1024' }} />
          </div>
          <div class="field-row" data-show-mode="team">
            <Field label="Players per team: minimum" name="teamMin" type="number" value={String(values.teamMin ?? 5)} attrs={{ min: '1', max: '64' }} />
            <Field label="maximum" name="teamMax" type="number" value={String(values.teamMax ?? 5)} attrs={{ min: '1', max: '64' }} />
            <Field label="Substitutes allowed" name="subsMax" type="number" value={String(values.subsMax ?? 1)} attrs={{ min: '0', max: '16' }} />
          </div>
          <Checkbox label="An organiser approves each registration" name="requireApproval" checked={!!values.requireApproval} />
          <Checkbox label="Players must check in before the bracket is drawn" name="requireCheckin" checked={!!values.requireCheckin} hint="Only checked-in entries are put in the bracket." />
          {events.length ? <Select label="LAN event (optional)" name="lanEventId" value={values.lanEventId ? String(values.lanEventId) : ''} options={[['', 'Not part of a LAN event'], ...events.map((e) => [String(e.id), e.name] as [string, string])]} hint="Shows the tournament on the event’s LAN HQ page and lets you use seats as stations." /> : null}
          {events.length ? <Checkbox label="Players must have a booked place at the LAN event" name="requireBooking" checked={!!values.requireBooking} hint="Uses LAN event bookings. Every team member needs a booking." /> : null}
        </fieldset>
        <fieldset class="lt-fs"><legend>Format</legend>
          {started ? <Notice type="info">The format can’t change once the bracket exists.</Notice> : null}
          <div class="field-row">
            <Select label="Format" name="format" value={values.format ?? 'single_elim'} options={Object.entries(FORMATS)} />
            <Select label="Seeding" name="seeding" value={c.seeding} options={[['registration', 'Order of registration'], ['random', 'Random draw'], ['manual', 'Manual seeds (set on the manage page)']]} />
          </div>
          <div class="field-row" data-show-format="single_elim double_elim round_robin swiss groups_playoffs">
            <Select label="Matches are best of" name="bestOf" value={String(c.bestOf)} options={[['1', '1'], ['3', '3'], ['5', '5'], ['7', '7']]} />
            <Select label="Finals are best of" name="finalBestOf" value={String(c.finalBestOf)} options={[['1', '1'], ['3', '3'], ['5', '5'], ['7', '7']]} />
            <Select label="In a best of 1, who wins?" name="winCondition" value={c.winCondition} options={[['higher', 'Higher score'], ['lower', 'Lower score']]} />
          </div>
          <div data-show-format="single_elim"><Checkbox label="Play a 3rd-place match" name="thirdPlace" checked={c.thirdPlace} /></div>
          <div data-show-format="double_elim groups_playoffs"><Checkbox label="Grand-final reset (the losers’-bracket finalist must win twice)" name="grandFinalReset" checked={c.grandFinalReset} /></div>
          <div class="field-row" data-show-format="groups_playoffs">
            <Field label="Groups" name="groups" type="number" value={String(c.groups)} attrs={{ min: '2', max: '32' }} />
            <Field label="Through from each group" name="advancePerGroup" type="number" value={String(c.advancePerGroup)} attrs={{ min: '1', max: '16' }} />
            <Select label="Playoffs" name="playoff" value={c.playoff} options={[['single_elim', 'Single elimination'], ['double_elim', 'Double elimination']]} />
          </div>
          <div class="field-row" data-show-format="swiss"><Field label="Swiss rounds (empty = automatic)" name="swissRounds" type="number" value={values.config?.swissRounds ? String(values.config.swissRounds) : ''} attrs={{ min: '1', max: '15' }} /></div>
          <div class="field-row" data-show-format="round_robin swiss groups_playoffs">
            <Field label="Points for a win" name="pWin" type="number" value={String(c.points.win)} attrs={{ min: '-100', max: '100' }} />
            <Field label="draw" name="pDraw" type="number" value={String(c.points.draw)} attrs={{ min: '-100', max: '100' }} />
            <Field label="loss" name="pLoss" type="number" value={String(c.points.loss)} attrs={{ min: '-100', max: '100' }} />
          </div>
          <div data-show-format="round_robin swiss groups_playoffs"><Checkbox label="Allow draws" name="allowDraws" checked={c.allowDraws} hint="Only in leagues, groups and swiss; elimination matches always need a winner." /></div>
          <div class="field-row" data-show-format="ffa">
            <Field label="Rounds" name="ffaRounds" type="number" value={String(c.ffaRounds)} attrs={{ min: '1', max: '20' }} />
            <Field label="Players per heat" name="heatSize" type="number" value={String(c.heatSize)} attrs={{ min: '2', max: '64' }} />
            <Field label="Points per placing (1st, 2nd, …)" name="ffaPoints" value={c.ffaPoints.join(', ')} maxlength={300} />
          </div>
          <div class="field-row" data-show-format="time_trial">
            <Select label="Results are" name="scoreUnit" value={c.scoreUnit} options={[['time', 'Times (lower is better unless set below)'], ['points', 'Scores']]} />
            <Select label="Who wins?" name="winCondition_tt" value={c.winCondition} options={[['lower', 'Lowest'], ['higher', 'Highest']]} />
          </div>
          <div data-show-format="time_trial"><Checkbox label="A referee checks every attempt before it counts" name="verifyAttempts" checked={c.verifyAttempts} /></div>
        </fieldset>
        <fieldset class="lt-fs"><legend>Ranking points</legend>
          <div class="field-row">
            <Field label="Points for 1st, 2nd, 3rd, …" name="rankingPoints" value={c.rankingPoints.join(', ')} maxlength={300} hint="Added to the tournament leaderboard when results are published." />
            <Field label="Points for taking part" name="participationPoints" type="number" value={String(c.participationPoints)} attrs={{ min: '0', max: '100000' }} />
          </div>
        </fieldset>
        <fieldset class="lt-fs"><legend>Dates ({tz})</legend>
          <div class="field-row"><Field label="Registration opens" name="regOpensAt" type="datetime-local" value={dt('regOpensAt')} /><Field label="Registration closes" name="regClosesAt" type="datetime-local" value={dt('regClosesAt')} /><Field label="Check-in opens" name="checkinOpensAt" type="datetime-local" value={dt('checkinOpensAt')} /></div>
          <div class="field-row"><Field label="Starts" name="startsAt" type="datetime-local" value={dt('startsAt')} /><Field label="Ends" name="endsAt" type="datetime-local" value={dt('endsAt')} /></div>
        </fieldset>
        <div class="form-actions"><button class="btn btn-primary">{t ? 'Save changes' : 'Create tournament'}</button>{t ? <a href={`${base(t)}/manage`}> Cancel</a> : null}</div>
        <script src="/modules/lan-tournaments/tournaments.js" defer></script>
      </form>
    );
  }

  const eventsList = async () => { const s = h.seating(); return s ? (await s.listEvents(true)).map((e) => ({ id: e.id, name: e.name })) : []; };
  const banner = async (c: RequestContext, v: Viewer, b: Record<string, unknown>) => {
    const f = b.banner;
    if (!f || typeof f !== 'object') return undefined;
    return (await media.upload(v, f, 'cover'))?.url;
  };
  const fixTimeTrialWin = (input: TournamentInput, b: Record<string, unknown>) => {
    if (input.format === 'time_trial') input.config.winCondition = str(b.winCondition_tt) === 'higher' ? 'higher' : 'lower';
    return input;
  };

  // ───────── create ─────────
  r.get('/new', async (c) => {
    const v = c.get('viewer');
    if (!v.user) return c.redirect('/login?returnTo=/m/lan-tournaments/new');
    if (!(await h.canCreate(v))) throw new ServiceError('You can’t create tournaments.', 403);
    const page = c.get('page');
    const tpl = templateByKey(c.req.query('template') ?? '');
    const values: Partial<TournamentInput> = { visibility: 'public', mode: 'solo', format: 'single_elim', config: {}, ...(tpl?.values ?? {}), name: tpl ? '' : '' };
    return h.render(c, 'New tournament', (
      <>
        <h1 class="page-title">New tournament</h1>
        <Box title="Start from a template">
          <form method="get" action="/m/lan-tournaments/new" class="inline-form"><label for="lt-tpl">Template</label> <select id="lt-tpl" name="template"><option value="">Blank</option>{TEMPLATES.map((x) => <option value={x.key} selected={tpl?.key === x.key}>{x.label}</option>)}</select> <button class="btn btn-small">Use</button></form>
          {tpl ? <p class="small muted">{tpl.summary}</p> : <ul class="plain-list small lt-tpl-list">{TEMPLATES.map((x) => <li><a href={`/m/lan-tournaments/new?template=${x.key}`}>{x.label}</a>: {x.summary}</li>)}</ul>}
        </Box>
        <Box title="Tournament">{await TournamentForm({ page, values, events: await eventsList(), action: '/m/lan-tournaments/new' })}</Box>
      </>
    ), [{ label: 'New' }]);
  });
  r.post('/new', async (c) => {
    const v = c.get('viewer');
    if (!(await h.canCreate(v))) throw new ServiceError('You can’t create tournaments.', 403);
    const page = c.get('page');
    const b = await form(c);
    const input = fixTimeTrialWin(readForm(b, h.tz(page)), b);
    try {
      const t = await createTournament(input, v.user!.id);
      const url = await banner(c, v, b);
      if (url) await database.db().update(tournaments).set({ bannerUrl: url }).where(eq(tournaments.id, t.id));
      await h.audit(v, 'create', t, { name: t.name, format: t.format });
      setFlash(c, { type: 'ok', text: 'Tournament created as a draft. Open registration when you’re ready.' });
      return c.redirect(`${base(t)}/manage`);
    } catch (e) {
      if (!(e instanceof ServiceError) || e.status >= 500) throw e;
      return h.render(c, 'New tournament', (<><h1 class="page-title">New tournament</h1><Notice type="error">{e.message}</Notice><Box title="Tournament">{await TournamentForm({ page, values: input, events: await eventsList(), action: '/m/lan-tournaments/new' })}</Box></>), [{ label: 'New' }], 400);
    }
  });

  // ───────── edit ─────────
  r.get('/:slug/edit', async (c) => {
    const { t, v, page } = await h.load(c);
    await h.require(v, t, 'edit');
    return h.render(c, `Edit ${t.name}`, (<><h1 class="page-title">Edit {t.name}</h1><Box title="Tournament">{await TournamentForm({ page, t, values: t as unknown as TournamentInput, events: await eventsList(), action: `${base(t)}/edit` })}</Box></>), [{ label: t.name, href: base(t) }, { label: 'Edit' }]);
  });
  r.post('/:slug/edit', async (c) => {
    const { t, v, page } = await h.load(c);
    await h.require(v, t, 'edit');
    const b = await form(c);
    const input = fixTimeTrialWin(readForm(b, h.tz(page)), b);
    try {
      const { changedTimes } = await updateTournament(t, input);
      const url = await banner(c, v, b);
      if (url || bool(b.removeBanner)) await database.db().update(tournaments).set({ bannerUrl: url ?? null }).where(eq(tournaments.id, t.id));
      await h.audit(v, 'edit', t);
      if (changedTimes && t.status !== 'draft') await notifyParticipants(t.id, v.user!.id, `${t.name}: the schedule has changed.`, base(t));
      setFlash(c, { type: 'ok', text: 'Saved.' });
      return c.redirect(`${base(t)}/manage`);
    } catch (e) {
      if (!(e instanceof ServiceError) || e.status >= 500) throw e;
      return h.render(c, `Edit ${t.name}`, (<><h1 class="page-title">Edit {t.name}</h1><Notice type="error">{e.message}</Notice><Box title="Tournament">{await TournamentForm({ page, t, values: input, events: await eventsList(), action: `${base(t)}/edit` })}</Box></>), [{ label: t.name, href: base(t) }, { label: 'Edit' }], 400);
    }
  });

  // ───────── dashboard ─────────
  r.get('/:slug/manage', async (c) => {
    const { t, v, page, staff } = await h.load(c);
    if (!staff) throw new ServiceError('You don’t help run this tournament.', 403);
    const tz = h.tz(page);
    const can = Object.fromEntries(await Promise.all((['edit', 'registrations', 'participants', 'checkin', 'brackets', 'schedule', 'scores', 'disputes', 'publish'] as const).map(async (a) => [a, await h.can(v, t, a)] as const))) as Record<string, boolean>;
    const all = await entriesOf(t.id);
    const names = await h.names(t);
    const cards = await services.users.cards([...all.map((e) => e.userId).filter((x): x is number => !!x), ...(await staffOf(t.id)).map((s) => s.userId), ...(await invitesOf(t.id)).map((i) => i.userId)]);
    const pending = all.filter((e) => e.status === 'pending');
    const active = all.filter((e) => e.status === 'approved');
    const ms = await matchesOf(t.id);
    const sts = await stagesOf(t.id);
    const disputed = ms.filter((m) => m.status === 'disputed');
    const awaiting = ms.filter((m) => m.status === 'reported');
    const atts = t.format === 'time_trial' ? (await attemptsOf(t.id)).filter((a) => a.status === 'pending') : [];
    const st = sts.length ? await standings(t) : null;
    const plays = ['registration_open', 'registration_closed'].includes(t.status) ? await seededEntries(t) : [];
    const seating = h.seating();
    const event = t.lanEventId && seating ? await seating.eventById(t.lanEventId) : null;
    const nextStatus: [Status, string][] = ({ draft: [['registration_open', 'Open registration']], registration_open: [['registration_closed', 'Close registration'], ['draft', 'Back to draft']], registration_closed: [['registration_open', 'Re-open registration']], cancelled: [['draft', 'Restore as draft']] } as Record<string, [Status, string][]>)[t.status] ?? [];
    const rounds = [...new Set(ms.filter((m) => !['done', 'void'].includes(m.status)).map((m) => `${m.stageId}|${m.bracket}|${m.round}`))];
    const staffList = await staffOf(t.id);
    const invs = await invitesOf(t.id);
    const teams = t.mode === 'team' ? await teamsOf(t.id) : [];

    return h.render(c, `Manage ${t.name}`, (
      <div class="lt-page lt-manage">
        <p><a href={base(t)}>← Tournament page</a>{t.status === 'in_progress' ? <> · <a href={`${base(t)}/live`}>Spectator view</a></> : null}</p>
        <h1 class="page-title">Manage {t.name}</h1>
        <div class="stats-row">
          <Stat label="Status" value={STATUSES[t.status as Status]} />
          <Stat label={t.mode === 'team' ? 'Teams' : 'Players'} value={`${counted(all).length}${t.maxEntries ? ` / ${t.maxEntries}` : ''}`} />
          <Stat label="Waiting for approval" value={String(pending.length)} />
          <Stat label="Checked in" value={`${active.filter((e) => e.checkedInAt).length} / ${active.length}`} />
          <Stat label="Disputes" value={String(disputed.length)} />
        </div>

        {can.edit ? <Box title="Tournament" id="status">
          <p><StatusTag t={t} /> {t.lanEventId && event ? <>· part of <a href={`/m/lan-seating/${event.slug}`}>{event.name}</a></> : null}</p>
          <p class="lt-btn-row">
            <a class="btn btn-small" href={`${base(t)}/edit`}>Edit settings</a>
            {nextStatus.map(([to, label]) => <ActionButton ctx={page} action={`${base(t)}/manage/status`} fields={{ to }} label={label} className={`btn btn-small ${to === 'registration_open' ? 'btn-primary' : ''}`} confirm={to === 'registration_closed' ? 'Close registration and tell everyone registered?' : undefined} />)}
            {!['completed', 'cancelled'].includes(t.status) ? <ActionButton ctx={page} action={`${base(t)}/manage/status`} fields={{ to: 'cancelled' }} label="Cancel tournament" className="btn btn-small btn-ghost" confirm="Cancel this tournament and tell everyone registered?" /> : null}
            <ActionButton ctx={page} action={`${base(t)}/manage/archive`} fields={{ on: t.archived ? '0' : '1' }} label={t.archived ? 'Unarchive' : 'Archive'} className="btn btn-small btn-ghost" />
            <ActionButton ctx={page} action={`${base(t)}/manage/delete`} label="Delete" className="btn btn-small btn-danger" confirm="Delete this tournament, its bracket and its results permanently?" />
          </p>
        </Box> : null}

        {can.registrations ? <Box title={`Registrations (${pending.length} waiting)`} id="registrations">
          {pending.length ? <ul class="plain-list">{pending.map((e) => <li><strong>{e.name}</strong> <span class="small muted"><Time d={e.createdAt} tz={tz} mode="ago" /></span>{' '}
            <ActionButton ctx={page} action={`${base(t)}/manage/entry/${e.id}/review`} fields={{ approve: '1' }} label="Approve" className="btn btn-small btn-primary" />{' '}
            <ActionButton ctx={page} action={`${base(t)}/manage/entry/${e.id}/review`} fields={{ approve: '0' }} label="Reject" className="btn btn-small btn-ghost" /></li>)}</ul> : <p class="muted">Nobody is waiting for approval.</p>}
          <h3 class="lt-h3">Add a participant</h3>
          <form method="post" action={`${base(t)}/manage/add`} class="inline-form"><Csrf ctx={page} />
            {t.mode === 'solo' ? <><label for="lt-add">Member</label> <input id="lt-add" name="username" required maxlength={40} placeholder="Username" data-member-autocomplete list="lt-add-list" /><datalist id="lt-add-list" /></>
              : <><label for="lt-addt">Team</label> <select id="lt-addt" name="teamId">{teams.map((x) => <option value={String(x.id)}>{x.name}</option>)}</select></>}
            <button class="btn btn-small">Add</button> <span class="small muted">Skips the registration window, places and invitations.</span></form>
          {t.visibility !== 'public' ? <>
            <h3 class="lt-h3">Invitations ({invs.length})</h3>
            {invs.length ? <ul class="plain-list">{invs.map((i) => <li><UserLink user={cards.get(i.userId)} /> <ActionButton ctx={page} action={`${base(t)}/manage/uninvite`} fields={{ userId: i.userId }} label="Remove" className="btn btn-small btn-ghost" /></li>)}</ul> : null}
            <form method="post" action={`${base(t)}/manage/invite`} class="inline-form"><Csrf ctx={page} /><label for="lt-invu">Invite</label> <input id="lt-invu" name="username" required maxlength={40} placeholder="Username" data-member-autocomplete list="lt-invu-list" /><datalist id="lt-invu-list" /> <button class="btn btn-small">Invite</button></form>
          </> : null}
        </Box> : null}

        {can.participants || can.checkin ? <Box title={`Participants (${active.length})`} id="participants">
          {active.length ? <form method="post" action={`${base(t)}/manage/participants`}><Csrf ctx={page} />
            <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">{t.mode === 'team' ? 'Team' : 'Player'}</th>{can.participants ? <><th scope="col">Seed</th><th scope="col">Station</th></> : null}<th scope="col">Check-in</th>{can.participants ? <th scope="col" /> : null}</tr></thead><tbody>
              {active.map((e) => <tr><td><strong>{e.name}</strong></td>
                {can.participants ? <><td><label class="sr-only" for={`seed-${e.id}`}>Seed for {e.name}</label><input id={`seed-${e.id}`} class="input-narrow" name={`seed_${e.id}`} type="number" min="1" max="1024" value={e.seed ? String(e.seed) : ''} /></td>
                  <td><label class="sr-only" for={`st-${e.id}`}>Station for {e.name}</label><input id={`st-${e.id}`} name={`station_${e.id}`} maxlength={40} value={e.station} /></td></> : null}
                <td>{e.checkedInAt ? <span class="tag tag-ok">In</span> : <span class="muted">—</span>} <button class="btn btn-small btn-ghost" name="toggleCheckin" value={String(e.id)} formaction={`${base(t)}/manage/checkin`}>{e.checkedInAt ? 'Undo' : 'Check in'}</button></td>
                {can.participants ? <td><button class="btn btn-small btn-ghost" name="entryId" value={String(e.id)} formaction={`${base(t)}/manage/remove`} data-confirm={`Remove ${e.name} from the tournament?`}>Remove</button></td> : null}</tr>)}
            </tbody></table></div>
            {can.participants ? <div class="form-actions"><button class="btn btn-small btn-primary">Save seeds and stations</button>{event ? <> <button class="btn btn-small" formaction={`${base(t)}/manage/stations`}>Use LAN seats as stations</button></> : null}</div> : null}
          </form> : <p class="muted">No approved participants yet.</p>}
        </Box> : null}

        {can.edit ? <Box title="Staff" id="staff">
          <ul class="plain-list">{staffList.map((s) => <li><UserLink user={cards.get(s.userId)} /> · {ROLES[s.role as Role]} <ActionButton ctx={page} action={`${base(t)}/manage/staff`} fields={{ userId: s.userId, role: '' }} label="Remove" className="btn btn-small btn-ghost" /></li>)}</ul>
          <form method="post" action={`${base(t)}/manage/staff`} class="inline-form"><Csrf ctx={page} /><label for="lt-staff">Add</label> <input id="lt-staff" name="username" required maxlength={40} placeholder="Username" data-member-autocomplete list="lt-staff-list" /><datalist id="lt-staff-list" />
            <select name="role" aria-label="Role"><option value="referee">as a referee</option><option value="organiser">as an organiser</option></select> <button class="btn btn-small">Add</button></form>
          <p class="small muted">Organisers can do everything in this tournament. Referees report and confirm scores, settle disputes, schedule matches and check players in.</p>
        </Box> : null}

        {can.brackets ? <Box title="Bracket" id="bracket">
          {!sts.length ? (['registration_open', 'registration_closed'].includes(t.status) ? <>
            <p>{plays.length} {t.requireCheckin ? 'checked-in, ' : ''}approved {t.mode === 'team' ? 'teams' : 'players'} will be drawn ({withDefaults(t.config).seeding === 'random' ? 'random draw' : withDefaults(t.config).seeding === 'manual' ? 'by seed' : 'in order of registration'}): {plays.map((e) => e.name).join(', ') || 'nobody yet'}.</p>
            <ActionButton ctx={page} action={`${base(t)}/manage/generate`} label={t.format === 'time_trial' ? 'Start the challenge' : 'Generate the bracket and start'} className="btn btn-primary btn-small" confirm="Close registration and start the tournament?" />
          </> : <p class="muted">Open registration first.</p>) : <>
            <p>{sts.map((s) => `${s.name}: ${s.status === 'done' ? 'finished' : 'in play'}`).join(' · ')}</p>
            {t.status === 'in_progress' && t.format !== 'time_trial' ? <form method="post" action={`${base(t)}/manage/swap`} class="inline-form"><Csrf ctx={page} />
              <label for="lt-sx">Swap</label> <select id="lt-sx" name="x">{active.map((e) => <option value={String(e.id)}>{e.name}</option>)}</select>
              <label for="lt-sy">with</label> <select id="lt-sy" name="y">{active.map((e) => <option value={String(e.id)}>{e.name}</option>)}</select>
              <button class="btn btn-small">Swap</button> <span class="small muted">Both must be waiting in unplayed matches.</span></form> : null}
            {t.format === 'time_trial' && t.status === 'in_progress' ? <ActionButton ctx={page} action={`${base(t)}/manage/end-challenge`} label="End the challenge" className="btn btn-small" confirm="Stop taking attempts?" /> : null}
            <form method="post" action={`${base(t)}/manage/reset`} class="inline-form lt-reset"><Csrf ctx={page} /><label class="check-inline"><input type="checkbox" name="force" value="1" /> Reset even though matches were played</label> <button class="btn btn-small btn-danger" data-confirm="Throw the bracket away and go back to registration closed?">Reset bracket</button></form>
          </>}
        </Box> : null}

        {can.schedule && rounds.length ? <Box title="Schedule a round" id="schedule">
          <form method="post" action={`${base(t)}/manage/schedule`} class="form-grid"><Csrf ctx={page} />
            <div class="field-row">
              <Select label="Round" name="round" value={rounds[0]} options={rounds.map((k) => { const [sid, br, rd] = k.split('|'); const s = sts.find((x) => String(x.id) === sid); const what = br === 'W' || br === 'S' ? `round ${rd}` : br === 'L' ? `losers’ round ${rd}` : br === 'H' ? `heats, round ${rd}` : br === 'GF' ? (rd === '1' ? 'grand final' : 'grand final reset') : br === '3RD' ? '3rd-place match' : `group ${br}, round ${rd}`; return [k, `${s?.name ?? ''}: ${what}`] as [string, string]; })} />
              <Field label={`First match at (${tz})`} name="start" type="datetime-local" required />
              <Field label="Minutes between matches" name="every" type="number" value="30" attrs={{ min: '1', max: '600' }} />
              <Field label="Matches at once" name="parallel" type="number" value="4" attrs={{ min: '1', max: '64' }} />
            </div>
            <div class="form-actions"><button class="btn btn-small btn-primary">Schedule round</button> <span class="small muted">Players are told the new times. Set single matches on the match page.</span></div>
          </form>
        </Box> : null}

        {can.disputes || can.scores ? <Box title={`Disputes and reports (${disputed.length + awaiting.length})`} id="disputes">
          {disputed.length + awaiting.length ? <ul class="plain-list">{[...disputed, ...awaiting].map((m) => <li><span class={`lt-ms lt-ms-${m.status}`}>{MATCH_STATUS[m.status]}</span> <a href={`${base(t)}/match/${m.id}`}>{m.code}</a>: {names.get(m.entryA ?? -1) ?? (m.bracket === 'H' ? 'heat' : 'TBD')}{m.entryB ? ` vs ${names.get(m.entryB)}` : ''}</li>)}</ul> : <p class="muted">Nothing needs a referee right now.</p>}
        </Box> : null}

        {t.format === 'time_trial' && (can.scores || can.disputes) ? <Box title={`Attempts to check (${atts.length})`} id="attempts">
          {atts.length ? <ul class="plain-list">{atts.map((a) => <li><strong>{names.get(a.entryId)}</strong>: {formatValue(a.value, withDefaults(t.config).scoreUnit)}{a.proof ? <> · <span class="small">{a.proof}</span></> : null}{' '}
            <ActionButton ctx={page} action={`${base(t)}/manage/attempt/${a.id}`} fields={{ approve: '1' }} label="Approve" className="btn btn-small btn-primary" />{' '}
            <ActionButton ctx={page} action={`${base(t)}/manage/attempt/${a.id}`} fields={{ approve: '0' }} label="Reject" className="btn btn-small btn-ghost" /></li>)}</ul> : <p class="muted">No attempts waiting.</p>}
          {t.status === 'in_progress' ? <form method="post" action={`${base(t)}/manage/attempt`} class="inline-form"><Csrf ctx={page} />
            <label for="lt-ae">Record for</label> <select id="lt-ae" name="entryId">{active.map((e) => <option value={String(e.id)}>{e.name}</option>)}</select>
            <label for="lt-av">result</label> <input id="lt-av" name="value" required maxlength={12} class="input-narrow" placeholder={withDefaults(t.config).scoreUnit === 'time' ? '1:02.345' : '1200'} /> <button class="btn btn-small">Record</button></form> : null}
        </Box> : null}

        {can.publish ? <Box title="Announcements" id="announcements">
          <form method="post" action={`${base(t)}/manage/announce`} class="form-grid"><Csrf ctx={page} />
            <TextArea label="Announcement (BBCode). Everyone registered is notified." name="body" rows={3} maxlength={4000} required />
            <div class="form-actions"><button class="btn btn-small btn-primary">Post announcement</button></div></form>
          {(await announcementsOf(t.id)).slice(0, 5).map((a) => <p class="small"><Time d={a.createdAt} tz={tz} mode="ago" />: {a.body.slice(0, 140)}</p>)}
        </Box> : null}

        {can.publish && t.status === 'in_progress' ? <Box title="Results" id="results">
          {st?.finished ? <p>Every match has a result. Publishing completes the tournament, stores the standings and ranking points, and tells everyone where they finished.</p> : <Notice type="info">Not every match has a result yet.</Notice>}
          <form method="post" action={`${base(t)}/manage/publish`} class="inline-form"><Csrf ctx={page} />
            {!st?.finished ? <label class="check-inline"><input type="checkbox" name="force" value="1" /> Publish anyway with the current standings</label> : null}
            <button class="btn btn-primary btn-small" data-confirm="Publish the final standings and complete the tournament?">Publish results</button></form>
        </Box> : null}
        <script src="/modules/lan-tournaments/tournaments.js" defer></script>
      </div>
    ), [{ label: t.name, href: base(t) }, { label: 'Manage' }]);
  });

  // ───────── staff actions ─────────
  const staffAct = (path: string, action: Parameters<Helpers['can']>[2], fn: (c: RequestContext, t: Tournament, v: Viewer, b: Record<string, unknown>) => Promise<string>, anchor = '') =>
    r.post(`/:slug/manage/${path}`, async (c) => {
      const { t, v } = await h.load(c);
      await h.require(v, t, action);
      const b = await form(c);
      try { setFlash(c, { type: 'ok', text: await fn(c, t, v, b) }); } catch (e) { h.flash(c, e); }
      return c.redirect(path === 'delete' ? '/m/lan-tournaments' : `${base(t)}/manage${anchor}`);
    });
  const userByName = async (raw: unknown) => {
    const u = await services.users.getByUsername(str(raw).trim());
    if (!u) throw new ServiceError('There’s no member with that username.', 404);
    return u;
  };

  staffAct('status', 'edit', async (_c, t, v, b) => {
    const to = str(b.to) as Status;
    await setStatus(t, to);
    await h.audit(v, 'status', t, { from: t.status, to });
    if (to === 'registration_closed') await notifyParticipants(t.id, v.user!.id, `${t.name}: registration has closed. The bracket comes next.`, base(t));
    if (to === 'registration_open' && t.status === 'draft') { /* published */ }
    if (to === 'cancelled') await cancelNotice(t, v.user!.id);
    return `Now: ${STATUSES[to]}.`;
  }, '#status');
  staffAct('archive', 'edit', async (_c, t, v, b) => { const on = str(b.on) === '1'; await setArchived(t, on); await h.audit(v, on ? 'archive' : 'unarchive', t); return on ? 'Archived.' : 'Unarchived.'; });
  staffAct('delete', 'edit', async (_c, t, v) => { await h.audit(v, 'delete', t, { name: t.name }); await deleteTournament(t); return 'Tournament deleted.'; });

  staffAct('entry/:id/review', 'registrations', async (c, t, v, b) => {
    const e = await entryById(int(c.req.param('id')));
    if (!e || e.tournamentId !== t.id) throw new ServiceError('Registration not found.', 404);
    const approve = str(b.approve) === '1';
    await reviewEntry(e, approve);
    await h.audit(v, approve ? 'entry.approve' : 'entry.reject', t, { entry: e.name });
    await notifyEntry(e, v.user!.id, approve ? `You’re in! Your registration for ${t.name} was approved.` : `Your registration for ${t.name} wasn’t accepted.`, base(t));
    return approve ? `${e.name} approved.` : `${e.name} rejected.`;
  }, '#registrations');
  staffAct('add', 'registrations', async (_c, t, v, b) => {
    if (t.mode === 'solo') { const u = await userByName(b.username); await registerSolo(t, u.id, h.elig(t), { bypass: true }); await notifyUsers([u.id], v.user!.id, `An organiser registered you for ${t.name}.`, base(t)); await h.audit(v, 'entry.add', t, { user: u.username }); return `${u.username} added.`; }
    const team = await teamById(int(str(b.teamId)));
    if (!team || team.tournamentId !== t.id) throw new ServiceError('Team not found.', 404);
    await registerTeam(t, team, h.elig(t), { bypass: true });
    await h.audit(v, 'entry.add', t, { team: team.name });
    return `${team.name} added.`;
  }, '#registrations');
  staffAct('invite', 'registrations', async (_c, t, v, b) => { const u = await userByName(b.username); await invite(t, u.id, v.user!.id); await notifyUsers([u.id], v.user!.id, `You’re invited to ${t.name}.`, base(t)); await h.audit(v, 'invite', t, { user: u.username }); return `${u.username} invited.`; }, '#registrations');
  staffAct('uninvite', 'registrations', async (_c, t, v, b) => { await uninvite(t, int(str(b.userId))); await h.audit(v, 'uninvite', t, { userId: int(str(b.userId)) }); return 'Invitation removed.'; }, '#registrations');

  staffAct('participants', 'participants', async (_c, t, v, b) => {
    const changes = (await entriesOf(t.id)).filter((e) => `seed_${e.id}` in b).map((e) => ({ entryId: e.id, seed: optInt(b[`seed_${e.id}`]), station: str(b[`station_${e.id}`]) }));
    await setSeedsAndStations(t, changes);
    await h.audit(v, 'participants', t, { changed: changes.length });
    return 'Seeds and stations saved.';
  }, '#participants');
  staffAct('stations', 'participants', async (_c, t, v) => {
    const s = h.seating();
    if (!s || !t.lanEventId) throw new ServiceError('This tournament isn’t linked to a LAN event with a seat map.', 409);
    let n = 0;
    for (const e of (await entriesOf(t.id)).filter((x) => x.status === 'approved')) {
      const who = e.userId ?? (e.teamId ? (await teamById(e.teamId))?.captainId : null);
      const seat = who ? await s.seatFor(t.lanEventId, who) : null;
      if (seat) { await setSeedsAndStations(t, [{ entryId: e.id, seed: e.seed, station: `Seat ${seat}` }]); n++; }
    }
    await h.audit(v, 'stations.from_seats', t, { filled: n });
    return n ? `Stations filled from ${n} seat bookings.` : 'Nobody has booked a seat yet.';
  }, '#participants');
  staffAct('checkin', 'checkin', async (_c, t, v, b) => {
    const e = await entryById(int(str(b.toggleCheckin)));
    if (!e || e.tournamentId !== t.id) throw new ServiceError('Participant not found.', 404);
    await checkIn(t, e, { byStaff: true, undo: !!e.checkedInAt });
    await h.audit(v, e.checkedInAt ? 'checkin.undo' : 'checkin', t, { entry: e.name });
    return e.checkedInAt ? `${e.name} is no longer checked in.` : `${e.name} checked in.`;
  }, '#participants');
  staffAct('remove', 'participants', async (_c, t, v, b) => {
    const e = await entryById(int(str(b.entryId)));
    if (!e || e.tournamentId !== t.id) throw new ServiceError('Participant not found.', 404);
    if (t.status === 'in_progress') throw new ServiceError('Remove players from matches by entering results (e.g. a forfeit) once the bracket exists.', 409);
    await withdrawEntry(t, e, { byStaff: true });
    await h.audit(v, 'entry.remove', t, { entry: e.name });
    await notifyEntry(e, v.user!.id, `An organiser removed you from ${t.name}.`, base(t));
    return `${e.name} removed.`;
  }, '#participants');
  staffAct('staff', 'edit', async (_c, t, v, b) => {
    const role = str(b.role);
    if (!role) { await setStaff(t, int(str(b.userId)), null); await h.audit(v, 'staff.remove', t, { userId: int(str(b.userId)) }); return 'Removed from staff.'; }
    if (!(role in ROLES)) throw new ServiceError('Choose a role.');
    const u = await userByName(b.username);
    await setStaff(t, u.id, role as Role);
    await notifyUsers([u.id], v.user!.id, `You’re now ${role === 'organiser' ? 'an organiser' : 'a referee'} for ${t.name}.`, `${base(t)}/manage`);
    await h.audit(v, 'staff.add', t, { user: u.username, role });
    return `${u.username} is now ${ROLES[role as Role].toLowerCase()}.`;
  }, '#staff');

  staffAct('generate', 'brackets', async (_c, t, v) => {
    const ready = await generateBracket(t);
    await h.audit(v, 'bracket.generate', t, { format: t.format });
    await notifyParticipants(t.id, v.user!.id, `${t.name} has started! ${t.format === 'time_trial' ? 'Submit your attempts on the tournament page.' : 'Check the bracket for your first match.'}`, `${base(t)}?tab=bracket`);
    return `Started. ${ready.length} match${ready.length === 1 ? ' is' : 'es are'} ready to play.`;
  }, '#bracket');
  staffAct('reset', 'brackets', async (_c, t, v, b) => { await resetBracket(t, { force: bool(b.force) }); await h.audit(v, 'bracket.reset', t, { force: bool(b.force) }); await notifyParticipants(t.id, v.user!.id, `${t.name}: the bracket was reset. A new one will be drawn.`, base(t)); return 'Bracket reset.'; }, '#bracket');
  staffAct('swap', 'brackets', async (_c, t, v, b) => { await swapEntries(t, int(str(b.x)), int(str(b.y))); await h.audit(v, 'bracket.swap', t, { x: int(str(b.x)), y: int(str(b.y)) }); return 'Swapped.'; }, '#bracket');
  staffAct('end-challenge', 'brackets', async (_c, t, v) => { await endChallenge(t); await h.audit(v, 'challenge.end', t); return 'The challenge has ended. Publish the results when you’re ready.'; }, '#results');

  staffAct('schedule', 'schedule', async (_c, t, v, b) => {
    const [sid, br, rd] = str(b.round).split('|');
    const start = str(b.start) ? parseLocalDateTime(str(b.start), h.tz((_c as RequestContext).get('page'))) : null;
    if (!start) throw new ServiceError('Choose when the first match starts.');
    const ms = await scheduleRound(t, int(sid), int(rd), br || null, start, int(str(b.every)) || 30, int(str(b.parallel)) || 1);
    await h.audit(v, 'schedule.round', t, { stage: int(sid), bracket: br, round: int(rd), matches: ms.length });
    for (const m of ms) for (const id of [m.entryA, m.entryB]) { const e = id ? await entryById(id) : null; if (e) await notifyEntry(e, v.user!.id, `${t.name}: ${m.code} is scheduled.`, `${base(t)}/match/${m.id}`); }
    return `${ms.length} match${ms.length === 1 ? '' : 'es'} scheduled.`;
  }, '#schedule');

  staffAct('attempt/:id', 'scores', async (c, t, v, b) => { await reviewAttempt(t, int(c.req.param('id')), str(b.approve) === '1', v.user!.id); await h.audit(v, 'attempt.review', t, { attempt: int(c.req.param('id')), approve: str(b.approve) === '1' }); return 'Done.'; }, '#attempts');
  staffAct('attempt', 'scores', async (_c, t, v, b) => {
    const e = await entryById(int(str(b.entryId)));
    if (!e || e.tournamentId !== t.id) throw new ServiceError('Participant not found.', 404);
    const { parseValue } = await import('./formats.ts');
    const val = parseValue(str(b.value), withDefaults(t.config).scoreUnit);
    if (val === null) throw new ServiceError('That isn’t a valid result.');
    const { submitAttempt } = await import('./matches.ts');
    await submitAttempt(t, e, val, 'Recorded by a referee', v.user!.id, true);
    await h.audit(v, 'attempt.record', t, { entry: e.name, value: val });
    return `Recorded for ${e.name}.`;
  }, '#attempts');

  staffAct('announce', 'publish', async (_c, t, v, b) => { await announce(t, str(b.body), v.user!.id); await h.audit(v, 'announce', t); return 'Announcement posted.'; }, '#announcements');
  staffAct('publish', 'publish', async (_c, t, v, b) => {
    const res = await publishResults(t, v.user!.id, { force: bool(b.force) });
    await h.audit(v, 'results.publish', t, { rows: res.rows, force: bool(b.force) });
    return 'Results published. The tournament is complete.';
  });

  // per-match staff actions (from the match page)
  const matchStaff = (path: string, action: Parameters<Helpers['can']>[2], fn: (t: Tournament, v: Viewer, m: NonNullable<Awaited<ReturnType<typeof matchById>>>, b: Record<string, unknown>, c: RequestContext) => Promise<string>) =>
    r.post(`/:slug/match/:id/${path}`, async (c) => {
      const { t, v } = await h.load(c);
      await h.require(v, t, action);
      const m = await matchById(int(c.req.param('id')));
      if (!m || m.tournamentId !== t.id) throw new ServiceError('Match not found.', 404);
      const b = await form(c);
      try { setFlash(c, { type: 'ok', text: await fn(t, v, m, b, c) }); } catch (e) { h.flash(c, e); }
      return c.redirect(`${base(t)}/match/${m.id}`);
    });
  matchStaff('override', 'disputes', async (t, v, m, b) => {
    const { overrideResult } = await import('./matches.ts');
    const before = m.status;
    await overrideResult(t, m, { scoreA: Number(str(b.scoreA)), scoreB: Number(str(b.scoreB)) }, str(b.version) ? int(str(b.version)) : undefined);
    await h.audit(v, before === 'done' ? 'result.correct' : before === 'disputed' ? 'dispute.resolve' : 'result.enter', t, { match: m.code, score: `${str(b.scoreA)}-${str(b.scoreB)}` });
    if (before === 'disputed') for (const id of [m.entryA, m.entryB]) { const e = id ? await entryById(id) : null; if (e) await notifyEntry(e, v.user!.id, `${t.name}: a referee settled ${m.code} at ${str(b.scoreA)}–${str(b.scoreB)}.`, `${base(t)}/match/${m.id}`); }
    return before === 'done' ? 'Result corrected.' : 'Result saved.';
  });
  matchStaff('schedule', 'schedule', async (t, v, m, b, c) => {
    const at = str(b.at) ? parseLocalDateTime(str(b.at), h.tz(c.get('page'))) : null;
    const changed = await scheduleMatch(t, m, at, str(b.station));
    await h.audit(v, 'schedule.match', t, { match: m.code, at: at?.toISOString() ?? null, station: str(b.station) });
    if (changed) for (const id of [m.entryA, m.entryB]) { const e = id ? await entryById(id) : null; if (e) await notifyEntry(e, v.user!.id, `${t.name}: ${m.code} has a new time.`, `${base(t)}/match/${m.id}`); }
    return 'Saved.';
  });
  matchStaff('live', 'schedule', async (t, v, m, b) => { await setLive(m, str(b.live) === '1'); await h.audit(v, str(b.live) === '1' ? 'match.live' : 'match.unlive', t, { match: m.code }); return str(b.live) === '1' ? 'Match is live.' : 'Match is no longer live.'; });

  // ───────── admin overview ─────────
  ctx.register.adminSection({ slug: 'tournaments', label: 'Tournaments', permission: h.P.create });
  ctx.adminRoutes.get('/tournaments', async (c) => {
    const v = c.get('viewer');
    if (!(await h.canCreate(v)) && !(await v.can(h.P.manage))) await v.require(h.P.create);
    const page = c.get('page');
    const { listAll } = await import('./service.ts');
    const rows = await listAll();
    return ctx.renderAdmin(c, 'Tournaments', h.P.create, (
      <>
        <p><a class="btn btn-primary btn-small" href="/m/lan-tournaments/new">New tournament</a> <a class="btn btn-small" href="/m/lan-tournaments">Public listing</a></p>
        <Box title="All tournaments">{rows.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Tournament</th><th scope="col">Status</th><th scope="col">Starts</th><th scope="col">Entries</th><th scope="col" /></tr></thead><tbody>
          {await Promise.all(rows.map(async (t) => <tr><td><a href={base(t)}>{t.name}</a><div class="small muted">{t.game} · {FORMATS[t.format as FormatId]}</div></td><td><StatusTag t={t} /></td><td>{t.startsAt ? <Time d={t.startsAt} tz={h.tz(page)} /> : '—'}</td><td>{counted(await entriesOf(t.id)).length}{t.maxEntries ? ` / ${t.maxEntries}` : ''}</td><td>{(await h.isStaff(v, t)) ? <a class="btn btn-small" href={`${base(t)}/manage`}>Manage</a> : null}</td></tr>))}
        </tbody></table></div> : <EmptyState title="No tournaments yet." />}</Box>
      </>
    ));
  });

  void arr; void membersOf;
}
