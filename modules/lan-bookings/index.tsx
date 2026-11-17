/** @jsxImportSource hono/jsx */
import {
  defineModule, z, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Time, Stat, EmptyState, UserLink,
  form, str, int, bool, setFlash, cleanLine, cleanText, services, ServiceError, database, eq, Html, renderBBCode,
  type ModuleContext, type RequestContext, type PageCtx, type Viewer,
} from '../../src/sdk/index.ts';
import {
  configs, types, bookings, STATUSES, configFor, configForThread, allConfigs, typesFor, bookingOf, setUp, counts, signupsByDay,
  bookPlace, registerInterest, cancel, seatAccess, seatZones, parseSeatSpec, parseMoney, formatMoney, forgetUser,
  PANEL_SECTIONS, CREW_ROLES, panelSectionsOf, crewFor, addCrew, removeCrew, type PanelSection,
  type SeatingApi, type SeatEventLite, type Status, type TypeCount,
} from './service.ts';

/** What this module reads from lan-intranet (optional). */
interface IntranetApi {
  schedule(viewer: Viewer, from: Date | null, to: Date | null): Promise<{ title: string; startsAt: Date; endsAt: Date | null; location: string; notes: string }[]>;
  servers(viewer: Viewer): Promise<{ name: string; game: string; notes: string; connect: string; online: boolean | null; label: string }[]>;
}

const settingsSchema = z.object({ currency: z.string().min(1).max(4) });
type Settings = z.infer<typeof settingsSchema>;
const db = () => database.db();
const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';
const ID = 'lan-bookings';

/** Bar sizes snap to 5% steps so they can be plain CSS classes (the CSP forbids inline styles). */
const step5 = (pct: number) => Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
/** Places left / capacity text for a type. */
const leftText = (t: TypeCount) => (t.left === null ? `${t.booked} booked` : t.left === 0 ? 'Fully booked' : `${t.left} of ${t.type.capacity} left`);

function defaultThreadBody(e: SeatEventLite, intro: string, list: TypeCount[], currency: string, tz: string, url: string) {
  const when = e.startsAt ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(e.startsAt) : 'Date to be announced';
  const lines = list.filter((t) => t.type.active).map((t) => `[*][b]${t.type.name}[/b]: ${formatMoney(t.type.priceCents, currency)}${t.type.capacity !== null ? ` (${t.type.capacity} places)` : ''}${t.type.description ? `. ${t.type.description}` : ''}`);
  return [
    `[b]${e.name}[/b]`,
    `${when}${e.location ? ` · ${e.location}` : ''}`,
    '',
    intro || 'Bookings are open! Grab your place, then pick your seat on the seat map.',
    '',
    lines.length ? `[b]Booking types[/b]\n[list]\n${lines.join('\n')}\n[/list]` : '',
    `[url=${url}]Book your place[/url]. Not sure yet? Register your interest on the same page so we know how many to plan for.`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export default defineModule({
  id: ID,
  name: 'LAN event bookings',
  version: '1.1.0',
  description: 'Bookings for LAN events with customisable booking types (standard seats, high-speed network seats, …). Organisers announce an event with a forum thread that links to the booking page, see the interest grow, and tie booking types to areas of the seat map.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.1.0',
  enabledByDefault: false,
  dependencies: { 'lan-seating': '^1.1.0' },
  optionalDependencies: { 'lan-intranet': '^1.2.0' },
  migrations: 'migrations',
  assets: 'public',
  styles: ['bookings.css'],
  permissions: {
    view: { label: 'See LAN event booking pages', grantTo: ['guest', 'member'] },
    book: { label: 'Book places and register interest in LAN events', grantTo: ['member'] },
    manage: { label: 'Set up LAN event bookings, booking types and announcement threads' },
  },
  notificationKinds: { 'lan-bookings': 'LAN event bookings: changes made by organisers' },
  settings: {
    schema: settingsSchema,
    defaults: { currency: '£' },
    fields: [{ key: 'currency', label: 'Currency symbol', type: 'string', maxLength: 4 }],
  },

  // the seat rules live in lan-seating's registry while this module runs
  async start(ctx) {
    const seating = ctx.use<SeatingApi>('lan-seating');
    seating?.setSeatPolicy(ID, {
      access: async (eventId, userId) => {
        const e = await seating.eventById(eventId);
        return seatAccess(seating, eventId, userId, e ? `/m/lan-bookings/${e.slug}` : '/m/lan-bookings');
      },
    });
  },
  async stop(ctx) { ctx.use<SeatingApi>('lan-seating')?.setSeatPolicy(ID, null); },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), book: ctx.perm('book'), manage: ctx.perm('manage') };
    const cfg = () => ctx.settings.get<Settings>();
    const seating = () => {
      const s = ctx.use<SeatingApi>('lan-seating');
      if (!s) throw new ServiceError('LAN seat booking is turned off.', 503);
      return s;
    };
    const flashOr = (c: RequestContext, e: unknown) => { if (e instanceof ServiceError && e.status < 500) setFlash(c, { type: 'error', text: e.message }); else throw e; };

    // For the door desk (lan-event-access): who has booked the event being run right now, or the next one.
    ctx.expose({
      async doorList() {
        const seat = ctx.use<SeatingApi>('lan-seating');
        if (!seat) return null;
        const open = (await allConfigs()).filter((x) => x.status !== 'draft');
        const evs = (await Promise.all(open.map((x) => seat.eventById(x.eventId)))).filter((e): e is SeatEventLite => !!e && e.status !== 'draft');
        if (!evs.length) return null;
        const now = Date.now();
        const endOf = (e: SeatEventLite) => (e.endsAt ?? (e.startsAt ? new Date(e.startsAt.getTime() + 2 * 86_400_000) : new Date(8.64e15))).getTime();
        const upcoming = evs.filter((e) => endOf(e) >= now - 12 * 3600_000).sort((a, b) => (a.startsAt?.getTime() ?? Infinity) - (b.startsAt?.getTime() ?? Infinity));
        const e = upcoming[0] ?? evs.sort((a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0))[0];
        const k = await counts(e.id);
        const cards = await services.users.cards(k.list.map((b) => b.userId));
        const seats = new Map((await seat.bookingsFor(e.id)).map((b) => [b.userId, b.seat]));
        const byType = new Map(k.perType.map((t) => [t.type.id, t.type]));
        return {
          event: { id: e.id, name: e.name, slug: e.slug, startsAt: e.startsAt },
          currency: (await cfg()).currency,
          bookings: k.list.filter((b) => cards.get(b.userId)).map((b) => {
            const t = b.typeId ? byType.get(b.typeId) : undefined;
            return { userId: b.userId, username: cards.get(b.userId)!.username, status: b.status as 'booked' | 'interested', typeName: t?.name ?? '', priceCents: t?.priceCents ?? 0, seat: seats.get(b.userId) ?? null, termsAccepted: !!b.termsAcceptedAt };
          }),
        };
      },
    });

    ctx.register.navItem({ href: '/m/lan-bookings', label: 'Book a LAN', icon: 'calendar', area: 'main', order: 64, visible: (v) => v.can(P.view) });
    ctx.register.adminSection({ slug: 'events', label: 'LAN bookings', permission: P.manage });
    ctx.hooks.on('user.closed', async ({ userId }) => { await forgetUser(userId); });

    // Events with bookings that a viewer may see (drafts only for organisers).
    const visibleEvents = async (v: Viewer) => {
      const manage = await v.can(P.manage);
      const byId = new Map((await allConfigs()).map((c) => [c.eventId, c]));
      const evs = await seating().listEvents(manage);
      return evs.filter((e) => byId.has(e.id) && (manage || byId.get(e.id)!.status !== 'draft')).map((e) => ({ e, c: byId.get(e.id)! }));
    };
    const loadPublic = async (c: RequestContext) => {
      const v = c.get('viewer'); await v.require(P.view);
      const e = await seating().eventBySlug(c.req.param('slug') ?? '');
      const conf = e ? await configFor(e.id) : null;
      if (!e || !conf || ((conf.status === 'draft' || e.status === 'draft') && !(await v.can(P.manage)))) throw new ServiceError('Event not found.', 404);
      return { e, conf };
    };

    // ── the live panel on the announcement thread; the posting admin chooses its sections ──
    const PANEL_NAMES = 60;
    ctx.register.threadPanel({
      id: 'lan-bookings', order: 10,
      async render({ viewer, thread, ctx: page }) {
        const conf = await configForThread(thread.id);
        if (!conf || !(await viewer.can(P.view))) return null;
        const manage = await viewer.can(P.manage);
        if (conf.status === 'draft' && !manage) return null;
        const e = await seating().eventById(conf.eventId);
        if (!e) return null;
        const show = panelSectionsOf(conf);
        const s = await cfg();
        const tz = tzOf(page);
        const k = await counts(e.id);
        const crew = show.has('crew') ? await crewFor(e.id) : [];
        const cards = await services.users.cards([...k.list.map((b) => b.userId), ...crew.map((m) => m.userId)]);
        const seats = new Map((await seating().bookingsFor(e.id)).map((b) => [b.userId, b.seat]));
        const mine = viewer.user ? await bookingOf(e.id, viewer.user.id) : null;
        const myType = mine?.typeId ? k.perType.find((t) => t.type.id === mine.typeId)?.type.name : null;
        const intranet = ctx.use<IntranetApi>('lan-intranet');
        // sub-events from 12 hours before doors open until the event ends (or three days after it starts)
        const from = e.startsAt ? new Date(e.startsAt.getTime() - 12 * 3600_000) : new Date();
        const to = e.endsAt ?? (e.startsAt ? new Date(e.startsAt.getTime() + 3 * 86_400_000) : null);
        const subEvents = show.has('schedule') && intranet ? await intranet.schedule(viewer, from, to) : [];
        const gameServers = show.has('servers') && intranet ? await intranet.servers(viewer) : [];
        const map = show.has('seatmap') ? await seating().mapView(e.id, page) : null;
        const booked = (typeId: number) => k.list.filter((b) => b.status === 'booked' && b.typeId === typeId)
          .sort((a, b) => (seats.get(a.userId) ?? '~').localeCompare(seats.get(b.userId) ?? '~', undefined, { numeric: true }));
        const interested = k.list.filter((b) => b.status === 'interested');
        const Who = ({ ids }: { ids: number[] }) => <>{ids.slice(0, PANEL_NAMES).map((id, i) => <>{i ? ', ' : ''}<UserLink user={cards.get(id)} />{seats.get(id) ? <span class="lb-seat"> {seats.get(id)}</span> : null}</>)}{ids.length > PANEL_NAMES ? <span class="muted"> and {ids.length - PANEL_NAMES} more</span> : null}</>;
        const roles = [...new Set(crew.map((m) => m.role))];
        return (
          <Box title={`Bookings: ${e.name}`} className="lb-panel" actions={manage ? <a class="btn btn-small" href={`/admin/m/lan-bookings/events/${e.id}`}>Manage bookings</a> : undefined}>
            <p class="lb-panel-meta">{e.startsAt ? <Time d={e.startsAt} tz={tz} /> : 'Date to be announced'}{e.location ? <> · {e.location}</> : null}
              {' · '}<strong>{k.booked}</strong> booked · <strong>{k.interested}</strong> interested · <strong>{seats.size}</strong> seats picked
              {conf.status !== 'open' ? <> · <span class="tag">{conf.status === 'closed' ? 'Bookings closed' : 'Draft'}</span></> : null}</p>
            <p class="lb-panel-cta">
              {mine ? <span>You’re <strong>{mine.status === 'booked' ? `booked${myType ? ` (${myType})` : ''}` : 'interested'}</strong>. </span> : null}
              <a class="btn btn-primary" href={`/m/lan-bookings/${e.slug}`}>{mine ? 'View your booking' : conf.status === 'open' ? 'Book your place' : 'See the booking page'}</a>
              {mine?.status === 'booked' ? <> <a class="btn" href={`/m/lan-seating/${e.slug}`}>{seats.get(viewer.user!.id) ? 'Change seat' : 'Pick your seat'}</a></> : null}
            </p>

            {show.has('rules') && conf.rules.trim() ? <details class="lb-section" open><summary>Event rules and terms</summary><div class="bb"><Html html={renderBBCode(conf.rules, { embeds: false })} /></div></details> : null}

            {show.has('crew') && crew.length ? <details class="lb-section" open><summary>Event crew ({crew.length})</summary>
              <dl class="lb-crew">{roles.map((r) => <><dt>{r}{crew.filter((m) => m.role === r).length > 1 && !/s$/i.test(r) ? 's' : ''}</dt>
                <dd>{crew.filter((m) => m.role === r).map((m, i) => <>{i ? ', ' : ''}<UserLink user={cards.get(m.userId)} />{m.note ? <span class="muted small"> ({m.note})</span> : null}</>)}</dd></>)}</dl>
            </details> : null}

            {show.has('bookings') ? <details class="lb-section" open><summary>Who’s booked</summary>
              <div class="table-wrap"><table class="data-table lb-who"><thead><tr><th>Booking type</th><th>Places</th><th>Who’s booked (seat)</th></tr></thead><tbody>
                {k.perType.filter((t) => t.type.active || t.booked).map((t) => { const ids = booked(t.type.id).map((b) => b.userId); return (
                  <tr><td><strong>{t.type.name}</strong><div class="muted small">{formatMoney(t.type.priceCents, s.currency)}</div></td>
                    <td class="nowrap">{t.booked}{t.type.capacity !== null ? ` / ${t.type.capacity}` : ''}{t.left === 0 ? <div><span class="tag">Full</span></div> : null}</td>
                    <td>{ids.length ? <Who ids={ids} /> : <span class="muted">Nobody yet</span>}</td></tr>); })}
                {interested.length ? <tr><td><strong>Interested</strong><div class="muted small">not booked yet</div></td><td>{interested.length}</td><td><Who ids={interested.map((b) => b.userId)} /></td></tr> : null}
              </tbody></table></div>
            </details> : null}

            {subEvents.length ? <details class="lb-section" open><summary>What’s on ({subEvents.length})</summary>
              <table class="data-table lb-schedule"><tbody>{subEvents.map((x) => <tr><td class="nowrap"><Time d={x.startsAt} tz={tz} />{x.endsAt ? <> – <Time d={x.endsAt} tz={tz} /></> : null}</td>
                <td><strong>{x.title}</strong>{x.location ? <div class="muted small">{x.location}</div> : null}{x.notes ? <div class="small">{x.notes}</div> : null}</td></tr>)}</tbody></table>
            </details> : null}

            {gameServers.length ? <details class="lb-section" open><summary>Game servers ({gameServers.length})</summary>
              <div class="table-wrap"><table class="data-table lb-servers"><thead><tr><th>Server</th><th>Game</th><th>Connect</th><th>Status</th></tr></thead><tbody>
                {gameServers.map((x) => <tr><td><strong>{x.name}</strong>{x.notes ? <div class="muted small">{x.notes}</div> : null}</td><td>{x.game}</td><td><span class="srv-connect">{x.connect}</span></td>
                  <td>{x.online === null ? <span class="muted small">Planned</span> : <span class={x.online ? 'tag tag-ok' : 'tag'}>{x.online ? 'Online' : 'Offline'}</span>}</td></tr>)}
              </tbody></table></div>
            </details> : null}

            {map ? <details class="lb-section lb-panel-map" open><summary>Seat map: {seats.size} seats taken</summary>{map}</details> : null}
          </Box>
        );
      },
    });

    // ── member pages ──
    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer'); await v.require(P.view);
      const page = c.get('page');
      const list = await visibleEvents(v);
      return ctx.render(c, 'LAN bookings', (
        <>
          <h1 class="page-title">LAN events</h1>
          {list.length ? <div class="lb-cards">{await Promise.all(list.map(async ({ e, c: conf }) => {
            const k = await counts(e.id);
            return <Box title={e.name}>
              <p>{e.startsAt ? <Time d={e.startsAt} tz={tzOf(page)} /> : 'Date to be announced'}{e.location ? <> · {e.location}</> : null}</p>
              <p><span class={`tag ${conf.status === 'open' ? 'tag-ok' : ''}`}>{STATUSES[conf.status as Status]}</span> <strong>{k.booked}</strong> booked · <strong>{k.interested}</strong> interested</p>
              <p><a class="btn btn-small btn-primary" href={`/m/lan-bookings/${e.slug}`}>{conf.status === 'open' ? 'Book or register interest' : 'View'}</a></p>
            </Box>;
          }))}</div> : <EmptyState title="No LAN events are taking bookings.">{await v.can(P.manage) ? <p><a href="/admin/m/lan-bookings/events">Set up bookings for an event</a>.</p> : <p>Keep an eye on the forums for the next one.</p>}</EmptyState>}
        </>
      ), { crumbs: [{ label: 'LAN bookings' }] });
    });

    ctx.routes.get('/:slug', async (c) => {
      const { e, conf } = await loadPublic(c);
      const v = c.get('viewer');
      const page = c.get('page');
      const s = await cfg();
      const k = await counts(e.id);
      const active = k.perType.filter((t) => t.type.active);
      const mine = v.user ? await bookingOf(e.id, v.user.id) : null;
      const canBook = v.user ? await v.can(P.book) : false;
      const open = conf.status === 'open';
      const seat = mine && v.user ? await seating().seatFor(e.id, v.user.id) : null;
      const zones = await seatZones(seating(), e.id);
      const myType = mine?.typeId ? k.perType.find((t) => t.type.id === mine.typeId)?.type : null;
      const typeOptions: [string, string][] = active.map((t) => [String(t.type.id), `${t.type.name} (${formatMoney(t.type.priceCents, s.currency)})`]);
      return ctx.render(c, e.name, (
        <>
          <h1 class="page-title">{e.name}</h1>
          <p class="page-desc">{e.startsAt ? <Time d={e.startsAt} tz={tzOf(page)} /> : 'Date to be announced'}{e.endsAt ? <> – <Time d={e.endsAt} tz={tzOf(page)} /></> : null}{e.location ? <> · {e.location}</> : null}</p>
          {conf.status === 'draft' ? <Notice type="warn">Draft: only organisers can see this page.</Notice> : null}
          {conf.intro ? <p class="lb-intro">{conf.intro}</p> : null}
          <div class="stats-row lb-stats">
            <Stat label="Booked" value={String(k.booked)} />
            <Stat label="Interested" value={String(k.interested)} />
            {conf.threadId ? <a class="stat lb-stat-link" href={`/t/${conf.threadId}`}><span class="stat-value">Discuss</span><span class="stat-label">Forum thread</span></a> : null}
          </div>

          {mine ? (
            <Box title="Your booking" className={`lb-mine ${mine.status === 'booked' ? 'is-booked' : 'is-interested'}`}>
              <p>{mine.status === 'booked'
                ? <>You’ve booked <strong>{myType?.name ?? 'a place'}</strong>{myType ? <> ({formatMoney(myType.priceCents, s.currency)}, paid at the door)</> : null}.</>
                : <>You’ve registered your interest{myType ? <> in <strong>{myType.name}</strong></> : null}. You haven’t booked a place yet.</>}</p>
              {mine.status === 'booked' ? <p>{seat ? <>Your seat: <strong>{seat}</strong>. <a href={`/m/lan-seating/${e.slug}`}>Change seat</a></> : <a class="btn btn-small btn-primary" href={`/m/lan-seating/${e.slug}`}>Pick your seat</a>}</p> : null}
              {conf.status !== 'draft' ? <ActionButton ctx={page} action={`/m/lan-bookings/${e.slug}/cancel`} label={mine.status === 'booked' ? 'Cancel my booking' : 'Withdraw my interest'} className="btn btn-small" confirm={mine.status === 'booked' ? `Cancel your booking${seat ? ` and give up seat ${seat}` : ''}?` : 'Withdraw your interest?'} /> : null}
            </Box>
          ) : null}

          <Box title="Booking types">
            {active.length ? <div class="lb-types">{active.map((t) => (
              <div class={`lb-type ${t.left === 0 ? 'is-full' : ''} ${myType?.id === t.type.id ? 'is-mine' : ''}`}>
                <h3>{t.type.name}</h3>
                <p class="lb-price">{formatMoney(t.type.priceCents, s.currency)}</p>
                {t.type.description ? <p>{t.type.description}</p> : null}
                {zones?.byType.get(t.type.id)?.size ? <p class="small muted">Seats {t.type.seats.toUpperCase()} on the seat map</p> : null}
                <p class="small"><strong>{leftText(t)}</strong>{t.interested ? <> · {t.interested} interested</> : null}</p>
              </div>))}</div> : <p class="muted">No booking types yet.</p>}
          </Box>

          {conf.rules.trim() ? <Box title="Event rules and terms" id="rules"><div class="bb"><Html html={renderBBCode(conf.rules, { embeds: false })} /></div></Box> : null}

          {!open ? <Notice type="info">{conf.status === 'closed' ? 'Bookings are closed.' : 'Bookings haven’t opened yet.'}</Notice>
            : !v.user ? <p><a class="btn btn-primary" href={`/login?returnTo=/m/lan-bookings/${e.slug}`}>Sign in to book</a></p>
            : !canBook ? <p class="muted">You can’t book places.</p>
            : active.length ? (
              <div class="lb-forms">
                {mine?.status !== 'booked' || active.length > 1 ? <Box title={mine?.status === 'booked' ? 'Change booking type' : 'Book a place'}>
                  <form method="post" action={`/m/lan-bookings/${e.slug}/book`} class="form-grid"><Csrf ctx={page} />
                    <fieldset class="lb-choice"><legend>Booking type</legend>
                      {active.map((t) => <label class="lb-radio"><input type="radio" name="typeId" value={String(t.type.id)} required checked={(mine?.typeId ?? active.find((x) => x.left !== 0)?.type.id) === t.type.id} disabled={t.left === 0 && myType?.id !== t.type.id} />
                        <span><strong>{t.type.name}</strong> · {formatMoney(t.type.priceCents, s.currency)} <span class="muted small">({leftText(t)})</span></span></label>)}
                    </fieldset>
                    <Field label="Note for the organisers (optional)" name="note" value={mine?.note ?? ''} maxlength={200} placeholder="Arriving late, bringing a friend…" />
                    {conf.rules.trim() ? <Checkbox label="I agree to the event rules and terms" name="terms" checked={!!mine?.termsAcceptedAt} hint="Shown above." /> : null}
                    <p class="small muted">Pay at the door when you arrive.</p>
                    <div class="form-actions"><button class="btn btn-primary">{mine?.status === 'booked' ? 'Change booking' : 'Book my place'}</button></div>
                  </form>
                </Box> : null}
                {mine?.status !== 'booked' ? <Box title="Not ready to book?">
                  <p>Register your interest so the organisers know how many to plan for. It doesn’t hold a place.</p>
                  <form method="post" action={`/m/lan-bookings/${e.slug}/interest`} class="form-grid"><Csrf ctx={page} />
                    <Select label="I’d most likely book" name="typeId" value={mine?.typeId ? String(mine.typeId) : ''} options={[['', 'Not sure yet'], ...typeOptions]} />
                    <div class="form-actions"><button class="btn">{mine ? 'Update my interest' : 'I’m interested'}</button></div>
                  </form>
                </Box> : null}
              </div>
            ) : null}
        </>
      ), { crumbs: [{ label: 'LAN bookings', href: '/m/lan-bookings' }, { label: e.name }] });
    });

    ctx.routes.post('/:slug/book', async (c) => {
      const { e } = await loadPublic(c);
      const v = c.get('viewer'); await v.require(P.book);
      const lim = await services.rateLimit(`lan-bookings:${v.user!.id}`, { max: 30, windowSec: 3600 });
      if (!lim.ok) { setFlash(c, { type: 'error', text: 'Too many booking changes. Try again later.' }); return c.redirect(`/m/lan-bookings/${e.slug}`); }
      const b = await form(c);
      try {
        await bookPlace(seating(), e.id, v.user!.id, int(str(b.typeId)), cleanLine(b.note, 200), { acceptedTerms: bool(b.terms) });
        const seat = await seating().seatFor(e.id, v.user!.id);
        setFlash(c, { type: 'ok', text: seat ? 'Booking updated.' : 'You’re booked! Now pick your seat.' });
        return c.redirect(seat ? `/m/lan-bookings/${e.slug}` : `/m/lan-seating/${e.slug}`);
      } catch (err) { flashOr(c, err); }
      return c.redirect(`/m/lan-bookings/${e.slug}`);
    });
    ctx.routes.post('/:slug/interest', async (c) => {
      const { e } = await loadPublic(c);
      const v = c.get('viewer'); await v.require(P.book);
      const b = await form(c);
      try {
        await registerInterest(e.id, v.user!.id, str(b.typeId) ? int(str(b.typeId)) : null, '');
        setFlash(c, { type: 'ok', text: 'Thanks! Your interest is noted.' });
      } catch (err) { flashOr(c, err); }
      return c.redirect(`/m/lan-bookings/${e.slug}`);
    });
    ctx.routes.post('/:slug/cancel', async (c) => {
      const { e } = await loadPublic(c);
      const v = c.get('viewer'); await v.require(P.book);
      try { const was = await cancel(seating(), e.id, v.user!.id); setFlash(c, { type: 'ok', text: was.status === 'booked' ? 'Your booking is cancelled.' : 'Your interest is withdrawn.' }); }
      catch (err) { flashOr(c, err); }
      return c.redirect(`/m/lan-bookings/${e.slug}`);
    });

    // ── organiser admin ──
    const adminEvent = async (c: RequestContext) => {
      await c.get('viewer').require(P.manage);
      const e = await seating().eventById(int(c.req.param('id')));
      if (!e) throw new ServiceError('Event not found.', 404);
      return e;
    };
    const back = (id: number) => `/admin/m/lan-bookings/events/${id}`;

    ctx.adminRoutes.get('/events', async (c) => {
      await c.get('viewer').require(P.manage);
      const page = c.get('page');
      const evs = await seating().listEvents(true);
      const byId = new Map((await allConfigs()).map((x) => [x.eventId, x]));
      return ctx.renderAdmin(c, 'LAN bookings', P.manage, (
        <>
          <p class="page-desc">Bookings are added to events from <a href="/admin/m/lan-seating/events">LAN seating</a>, so bookings and the seat map share one event.</p>
          <Box title="Events">
            {evs.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th>Event</th><th>When</th><th>Bookings</th><th /></tr></thead><tbody>
              {await Promise.all(evs.map(async (e) => {
                const conf = byId.get(e.id);
                const k = conf ? await counts(e.id) : null;
                return <tr><td><strong>{e.name}</strong></td><td><Time d={e.startsAt} tz={tzOf(page)} /></td>
                  <td>{conf && k ? <><span class={`tag ${conf.status === 'open' ? 'tag-ok' : ''}`}>{STATUSES[conf.status as Status]}</span> {k.booked} booked · {k.interested} interested</> : <span class="muted">Not set up</span>}</td>
                  <td class="lb-actions">{conf ? <a class="btn btn-small" href={back(e.id)}>Manage</a> : <ActionButton ctx={page} action={`/admin/m/lan-bookings/events/${e.id}/setup`} label="Set up bookings" className="btn btn-small btn-primary" />}</td></tr>;
              }))}
            </tbody></table></div> : <EmptyState title="No LAN events yet."><p><a href="/admin/m/lan-seating/events">Create an event in LAN seating</a> first.</p></EmptyState>}
          </Box>
        </>
      ));
    });

    ctx.adminRoutes.post('/events/:id/setup', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      await setUp(e.id);
      await services.audit(v.user!.id, 'lan-bookings.setup', { type: 'lan_event', id: e.id }, { name: e.name }, v.ip);
      setFlash(c, { type: 'ok', text: 'Bookings set up with two example booking types. Edit them, then open bookings and announce the event.' });
      return c.redirect(back(e.id));
    });

    ctx.adminRoutes.get('/events/:id', async (c) => {
      const e = await adminEvent(c);
      const conf = await configFor(e.id);
      if (!conf) return c.redirect('/admin/m/lan-bookings/events');
      const v = c.get('viewer');
      const page = c.get('page');
      const s = await cfg();
      const k = await counts(e.id);
      const all = await typesFor(e.id, true);
      const cards = await services.users.cards(k.list.map((b) => b.userId));
      const seats = new Map((await seating().bookingsFor(e.id)).map((b) => [b.userId, b.seat]));
      const codes = await seating().seatCodes(e.id);
      const days = signupsByDay(k.list);
      const peak = Math.max(1, ...days.map((d) => d.booked + d.interested));
      const totalCap = all.filter((t) => t.active).reduce<number | null>((n, t) => (n === null || t.capacity === null ? null : n + t.capacity), 0);
      const forums = await services.forums.postable(v);
      const url = `/m/lan-bookings/${e.slug}`;
      const typeName = new Map(all.map((t) => [t.id, t.name]));
      const crew = await crewFor(e.id);
      const crewCards = await services.users.cards(crew.map((m) => m.userId));
      const shown = panelSectionsOf(conf);
      const intranetOn = !!ctx.use<IntranetApi>('lan-intranet');
      return ctx.renderAdmin(c, `LAN bookings: ${e.name}`, P.manage, (
        <>
          <p><a href="/admin/m/lan-bookings/events">← All events</a> · <a href={url}>Booking page</a> · <a href={`/m/lan-seating/${e.slug}`}>Seat map</a>{conf.threadId ? <> · <a href={`/t/${conf.threadId}`}>Announcement thread</a></> : null}</p>

          <Box title="Interest">
            <div class="stats-row">
              <Stat label="Booked" value={String(k.booked)} />
              <Stat label="Interested" value={String(k.interested)} />
              <Stat label="Places" value={totalCap === null ? 'No limit' : String(totalCap)} />
              <Stat label="Seats picked" value={String(seats.size)} />
            </div>
            <div class="table-wrap"><table class="data-table lb-demand"><thead><tr><th>Booking type</th><th>Price</th><th>Booked</th><th>Interested</th><th class="lb-bar-col">Demand</th></tr></thead><tbody>
              {k.perType.map((t) => {
                const cap = t.type.capacity ?? Math.max(t.booked + t.interested, 1);
                const pb = Math.min(100, Math.round((t.booked / cap) * 100)), pi = Math.min(100 - pb, Math.round((t.interested / cap) * 100));
                return <tr class={t.type.active ? '' : 'muted'}><td><strong>{t.type.name}</strong>{t.type.active ? null : <span class="tag"> hidden</span>}</td><td>{formatMoney(t.type.priceCents, s.currency)}</td>
                  <td>{t.booked}{t.type.capacity !== null ? ` / ${t.type.capacity}` : ''}</td><td>{t.interested}</td>
                  <td><span class="lb-bar" role="img" aria-label={`${t.booked} booked and ${t.interested} interested${t.type.capacity !== null ? ` of ${t.type.capacity} places` : ''}`}><span class={`lb-bar-booked lb-w-${step5(pb)}`} /><span class={`lb-bar-interested lb-w-${step5(pi)}`} /></span></td></tr>;
              })}
              {k.undecided ? <tr><td><em>Interested, type not chosen</em></td><td /><td /><td>{k.undecided}</td><td /></tr> : null}
            </tbody></table></div>
            <h3 class="lb-h3">Sign-ups in the last 3 weeks</h3>
            <ol class="lb-days" aria-label="Sign-ups per day">{days.map((d) => <li title={`${d.day.toISOString().slice(0, 10)}: ${d.booked} booked, ${d.interested} interested`}>
              <span class={`lb-day-bar lb-h-${step5(((d.booked + d.interested) / peak) * 100)}`}><span class={`lb-day-booked lb-h-${step5(d.booked + d.interested ? (d.booked / (d.booked + d.interested)) * 100 : 0)}`} /></span>
              <span class="sr-only">{d.day.toISOString().slice(0, 10)}: {d.booked} booked, {d.interested} interested</span></li>)}</ol>
            <p class="small muted lb-legend"><span class="lb-key lb-key-booked" /> booked <span class="lb-key lb-key-interested" /> interested</p>
          </Box>

          <Box title="Booking page">
            <form method="post" action={`${back(e.id)}/settings`} class="form-grid"><Csrf ctx={page} />
              <Select label="Status" name="status" value={conf.status} options={Object.entries(STATUSES)} />
              <TextArea label="Introduction (optional)" name="intro" value={conf.intro} rows={3} maxlength={2000} hint="Shown at the top of the booking page and used in the announcement thread." />
              <TextArea label="Event rules and terms (BBCode)" name="rules" value={conf.rules} rows={10} maxlength={10000} hint="Shown on the booking page and in the announcement thread. Members must agree to them to book. Leave empty for none." />
              <Checkbox label="Members must book a place before picking a seat" name="requireBooking" checked={conf.requireBooking} hint="Seats on the map then follow each member’s booking type." />
              <div class="form-actions"><button class="btn btn-primary btn-small">Save</button></div>
            </form>
          </Box>

          <Box title="Booking types">
            <p class="small muted">Seats: leave empty for “any seat no other type claims”, or list seats from the map, e.g. <code>A1-A8</code>, <code>B</code> (a whole row), <code>C-D</code> (rows C to D), <code>E3 E4</code>.</p>
            {all.map((t) => (
              <form method="post" action={`${back(e.id)}/types/${t.id}`} class={`lb-type-form ${t.active ? '' : 'is-hidden'}`}><Csrf ctx={page} />
                <div class="field-row">
                  <Field label="Name" name="name" id={`t${t.id}-name`} value={t.name} required maxlength={60} />
                  <Field label={`Price (${s.currency})`} name="price" id={`t${t.id}-price`} value={(t.priceCents / 100).toFixed(2)} inputmode="decimal" maxlength={10} />
                  <Field label="Places (empty = no limit)" name="capacity" id={`t${t.id}-cap`} value={t.capacity === null ? '' : String(t.capacity)} inputmode="numeric" maxlength={6} />
                  <Field label="Order" name="order" id={`t${t.id}-order`} value={String(t.displayOrder)} inputmode="numeric" maxlength={5} />
                </div>
                <Field label="Description" name="description" id={`t${t.id}-desc`} value={t.description} maxlength={300} />
                <Field label={`Seats on the map${t.seats.trim() ? ` (${parseSeatSpec(t.seats, codes as Map<string, string>).seats.size} seats)` : ''}`} name="seats" id={`t${t.id}-seats`} value={t.seats} maxlength={300} placeholder="Any seat no other type claims" />
                <div class="form-actions"><button class="btn btn-small btn-primary">Save {t.name}</button>
                  <button class="btn btn-small" name="toggle" value="1">{t.active ? 'Hide from members' : 'Show to members'}</button></div>
              </form>))}
            <details class="lb-add"><summary>Add a booking type</summary>
              <form method="post" action={`${back(e.id)}/types/new`} class="form-grid"><Csrf ctx={page} />
                <div class="field-row">
                  <Field label="Name" name="name" id="nt-name" required maxlength={60} placeholder="e.g. Bring your own console" />
                  <Field label={`Price (${s.currency})`} name="price" id="nt-price" value="0.00" inputmode="decimal" maxlength={10} />
                  <Field label="Places (empty = no limit)" name="capacity" id="nt-cap" inputmode="numeric" maxlength={6} />
                </div>
                <Field label="Description" name="description" id="nt-desc" maxlength={300} />
                <Field label="Seats on the map (optional)" name="seats" id="nt-seats" maxlength={300} />
                <div class="form-actions"><button class="btn btn-small btn-primary">Add type</button></div>
              </form></details>
          </Box>

          <Box title={`Event crew (${crew.length})`}>
            <p class="small muted">Who will be at the event to help. Shown on the announcement thread for transparency.</p>
            {crew.length ? <table class="data-table"><thead><tr><th>Member</th><th>Role</th><th>Note</th><th /></tr></thead><tbody>
              {crew.map((m) => <tr><td><UserLink user={crewCards.get(m.userId)} /></td><td>{m.role}</td><td class="small">{m.note}</td>
                <td class="lb-actions"><ActionButton ctx={page} action={`${back(e.id)}/crew/${m.id}/remove`} label="Remove" className="btn btn-small btn-ghost" /></td></tr>)}
            </tbody></table> : <p class="muted">No crew listed yet.</p>}
            <form method="post" action={`${back(e.id)}/crew`} class="form-grid"><Csrf ctx={page} />
              <div class="field-row">
                <Field label="Member" name="username" id="crew-user" required maxlength={40} placeholder="Username" attrs={{ 'data-member-autocomplete': '', list: 'crew-user-list' }} />
                <Select label="Role" name="role" value="Volunteer" options={[...CREW_ROLES.map((r) => [r, r] as [string, string]), ['other', 'Other (type below)']]} />
                <Field label="Other role (optional)" name="customRole" id="crew-role" maxlength={40} placeholder="e.g. Tournament ref" />
              </div>
              <datalist id="crew-user-list" />
              <Field label="Note (optional)" name="note" id="crew-note" maxlength={100} placeholder="e.g. Saturday only, front desk" />
              <div class="form-actions"><button class="btn btn-small btn-primary">Add to crew</button></div>
            </form>
          </Box>

          <Box title="Announce in the forums">
            {conf.threadId ? <p>Announced in <a href={`/t/${conf.threadId}`}>this thread</a>. The thread shows a live booking panel with a link here. Posting again links the new thread instead.</p> : <p>Post a thread that links to the booking page. It shows a live booking panel at the top.</p>}
            {conf.status === 'draft' ? <Notice type="warn">Bookings are still a draft. Open them first, or members will see a thread for a page they can’t open.</Notice> : null}
            {forums.length ? <form method="post" action={`${back(e.id)}/announce`} class="form-grid"><Csrf ctx={page} />
              <div class="field-row">
                <Select label="Forum" name="forumId" value={String(forums[0].id)} options={forums.map((f) => [String(f.id), f.name])} />
                <Field label="Thread title" name="title" value={`Bookings open: ${e.name}`} required maxlength={140} />
              </div>
              <TextArea label="First post (BBCode)" name="body" value={defaultThreadBody(e, conf.intro, k.perType, s.currency, tzOf(page), url)} rows={10} maxlength={20000} />
              <fieldset class="lb-sections"><legend>The live panel at the top of the thread shows</legend>
                {(Object.entries(PANEL_SECTIONS) as [PanelSection, string][]).map(([key, label]) => <Checkbox label={label} name="sections" value={key} checked={shown.has(key)} />)}
                {!intranetOn ? <p class="small muted">Sub-events and game servers come from the LAN intranet module, which is turned off.</p> : null}
              </fieldset>
              <p class="small muted">The thread is made sticky and stays open for replies. Admins and moderators manage it with the usual moderator tools (lock, move, edit, delete). The panel updates itself, so it never goes out of date.</p>
              <div class="form-actions"><button class="btn btn-primary btn-small" name="action" value="post">Post thread</button>
                {conf.threadId ? <button class="btn btn-small" name="action" value="panel" formnovalidate>Only update the panel sections</button> : null}</div>
            </form> : <p class="muted">You can’t start threads in any forum.</p>}
          </Box>

          <Box title={`Members (${k.list.length})`} actions={k.list.length ? <a class="btn btn-small" href={`${back(e.id)}/export.csv`}>Download CSV</a> : undefined}>
            {k.list.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Status</th><th>Type</th><th>Seat</th><th>Note</th><th>Since</th><th /></tr></thead><tbody>
              {k.list.map((b) => <tr>
                <td><UserLink user={cards.get(b.userId)} /></td>
                <td><span class={`tag ${b.status === 'booked' ? 'tag-ok' : ''}`}>{b.status === 'booked' ? 'Booked' : 'Interested'}</span></td>
                <td>{b.typeId ? typeName.get(b.typeId) ?? '—' : <span class="muted">—</span>}</td>
                <td>{seats.get(b.userId) ?? <span class="muted">—</span>}</td>
                <td class="small">{b.note}</td>
                <td class="small"><Time d={b.createdAt} tz={tzOf(page)} mode="ago" /></td>
                <td class="lb-actions">
                  {b.status === 'interested' && b.typeId ? <ActionButton ctx={page} action={`${back(e.id)}/bookings/${b.id}/confirm`} label="Confirm booking" className="btn btn-small" title="Book this member a place, even if the type is full" /> : null}
                  <ActionButton ctx={page} action={`${back(e.id)}/bookings/${b.id}/remove`} label="Remove" className="btn btn-small btn-ghost" confirm={`Remove ${cards.get(b.userId)?.username ?? 'this member'}${seats.get(b.userId) ? ' and their seat' : ''}?`} />
                </td></tr>)}
            </tbody></table></div> : <p class="muted">Nobody has booked or registered interest yet.</p>}
          </Box>
        </>
      ));
    });

    ctx.adminRoutes.post('/events/:id/settings', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      const b = await form(c);
      const status = (str(b.status) in STATUSES ? str(b.status) : 'draft') as Status;
      await db().update(configs).set({ status, intro: cleanText(b.intro, 2000), rules: cleanText(b.rules, 10000), requireBooking: bool(b.requireBooking) }).where(eq(configs.eventId, e.id));
      await services.audit(v.user!.id, 'lan-bookings.settings', { type: 'lan_event', id: e.id }, { status }, v.ip);
      setFlash(c, { type: 'ok', text: 'Saved.' });
      return c.redirect(back(e.id));
    });

    const typeValues = async (b: Record<string, unknown>, eventId: number) => {
      const name = cleanLine(b.name, 60);
      if (name.length < 2) throw new ServiceError('Give the booking type a name.');
      const price = parseMoney(str(b.price) || '0');
      if (price === null) throw new ServiceError('Enter the price like 20.00.');
      const capRaw = str(b.capacity).trim();
      const capacity = capRaw === '' ? null : /^\d{1,6}$/.test(capRaw) ? Number(capRaw) : NaN;
      if (Number.isNaN(capacity)) throw new ServiceError('Places must be a whole number, or empty for no limit.');
      const seats = cleanLine(b.seats, 300);
      if (seats) {
        const r = parseSeatSpec(seats, (await seating().seatCodes(eventId)) as Map<string, string>);
        if (r.errors.length) throw new ServiceError(`Seats: ${r.errors.join(' ')}`);
      }
      return { name, priceCents: price, capacity, seats, description: cleanLine(b.description, 300) };
    };
    ctx.adminRoutes.post('/events/:id/types/new', async (c) => {
      const e = await adminEvent(c);
      if (!(await configFor(e.id))) return c.redirect('/admin/m/lan-bookings/events');
      try {
        const vals = await typeValues(await form(c), e.id);
        const order = Math.max(0, ...(await typesFor(e.id, true)).map((t) => t.displayOrder)) + 10;
        await db().insert(types).values({ ...vals, eventId: e.id, displayOrder: order });
        setFlash(c, { type: 'ok', text: `Added ${vals.name}.` });
      } catch (err) { flashOr(c, err); }
      return c.redirect(back(e.id));
    });
    ctx.adminRoutes.post('/events/:id/types/:typeId', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      const t = (await typesFor(e.id, true)).find((x) => x.id === int(c.req.param('typeId')));
      if (!t) throw new ServiceError('Booking type not found.', 404);
      const b = await form(c);
      try {
        if (str(b.toggle) === '1') {
          await db().update(types).set({ active: !t.active }).where(eq(types.id, t.id));
          setFlash(c, { type: 'ok', text: `${t.name} is now ${t.active ? 'hidden from' : 'shown to'} members. Existing bookings are kept.` });
        } else {
          const vals = await typeValues(b, e.id);
          const order = /^\d{1,5}$/.test(str(b.order)) ? Number(str(b.order)) : t.displayOrder;
          await db().update(types).set({ ...vals, displayOrder: order }).where(eq(types.id, t.id));
          setFlash(c, { type: 'ok', text: `Saved ${vals.name}.` });
        }
        await services.audit(v.user!.id, 'lan-bookings.type.update', { type: 'lan_booking_type', id: t.id }, { event: e.slug }, v.ip);
      } catch (err) { flashOr(c, err); }
      return c.redirect(back(e.id));
    });

    ctx.adminRoutes.post('/events/:id/announce', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      const b = await form(c);
      const raw = Array.isArray(b.sections) ? b.sections : b.sections ? [b.sections] : [];
      const sections = (Object.keys(PANEL_SECTIONS) as PanelSection[]).filter((k) => raw.map(String).includes(k)).join(',');
      await db().update(configs).set({ panelSections: sections }).where(eq(configs.eventId, e.id));
      if (str(b.action) === 'panel') { setFlash(c, { type: 'ok', text: 'Panel sections saved.' }); return c.redirect(back(e.id)); }
      try {
        const t = await services.forums.createThread(v, int(str(b.forumId)), { title: str(b.title), body: str(b.body) });
        await db().update(configs).set({ threadId: t.threadId }).where(eq(configs.eventId, e.id));
        // booking threads are always sticky; this needs thread-moderation rights in that forum
        const sticky = await services.forums.setSticky(v, t.threadId, true).then(() => true, () => false);
        await services.audit(v.user!.id, 'lan-bookings.announce', { type: 'thread', id: t.threadId }, { event: e.slug, sticky }, v.ip);
        const notes = [t.held ? 'It’s waiting for moderator approval.' : '', sticky ? '' : 'You can’t make threads sticky in that forum, so ask a moderator to pin it.'].filter(Boolean).join(' ');
        setFlash(c, { type: sticky ? 'ok' : 'error', text: `Thread posted.${notes ? ` ${notes}` : ''}` });
        return c.redirect(t.url);
      } catch (err) { flashOr(c, err); }
      return c.redirect(back(e.id));
    });

    ctx.adminRoutes.post('/events/:id/crew', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      const b = await form(c);
      try {
        if (!(await configFor(e.id))) throw new ServiceError('Set up bookings first.');
        const u = await services.users.getByUsername(cleanLine(b.username, 40));
        if (!u) throw new ServiceError('There’s no member with that username.');
        const role = str(b.role) === 'other' || cleanLine(b.customRole, 40) ? cleanLine(b.customRole, 40) : (CREW_ROLES as readonly string[]).includes(str(b.role)) ? str(b.role) : '';
        if (role.length < 2) throw new ServiceError('Choose a role, or type one under “Other role”.');
        await addCrew(e.id, u.id, role, cleanLine(b.note, 100));
        await services.audit(v.user!.id, 'lan-bookings.crew.add', { type: 'user', id: u.id }, { event: e.slug, role }, v.ip);
        setFlash(c, { type: 'ok', text: `${u.username} is on the crew as ${role}.` });
      } catch (err) { flashOr(c, err); }
      return c.redirect(back(e.id));
    });
    ctx.adminRoutes.post('/events/:id/crew/:sid/remove', async (c) => {
      const e = await adminEvent(c);
      const v = c.get('viewer');
      await removeCrew(e.id, int(c.req.param('sid')));
      await services.audit(v.user!.id, 'lan-bookings.crew.remove', { type: 'lan_event', id: e.id }, { staffId: int(c.req.param('sid')) }, v.ip);
      setFlash(c, { type: 'ok', text: 'Removed from the crew.' });
      return c.redirect(back(e.id));
    });

    const bookingAction = (path: string, fn: (c: RequestContext, e: SeatEventLite, bk: typeof bookings.$inferSelect, v: Viewer) => Promise<string>) =>
      ctx.adminRoutes.post(`/events/:id/bookings/:bid/${path}`, async (c) => {
        const e = await adminEvent(c);
        const v = c.get('viewer');
        const [bk] = await db().select().from(bookings).where(eq(bookings.id, int(c.req.param('bid'))));
        if (!bk || bk.eventId !== e.id) throw new ServiceError('Booking not found.', 404);
        try { setFlash(c, { type: 'ok', text: await fn(c, e, bk, v) }); } catch (err) { flashOr(c, err); }
        return c.redirect(back(e.id));
      });
    bookingAction('confirm', async (_c, e, bk, v) => {
      if (!bk.typeId) throw new ServiceError('This member hasn’t chosen a booking type.');
      await bookPlace(seating(), e.id, bk.userId, bk.typeId, bk.note, { asOrganiser: true });
      await services.notify(bk.userId, 'lan-bookings', v.user!.id, `An organiser confirmed your place at ${e.name}. Pick your seat!`, `/m/lan-bookings/${e.slug}`);
      await services.audit(v.user!.id, 'lan-bookings.confirm', { type: 'user', id: bk.userId }, { event: e.slug }, v.ip);
      return 'Booking confirmed.';
    });
    bookingAction('remove', async (_c, e, bk, v) => {
      await cancel(seating(), e.id, bk.userId, { asOrganiser: true });
      await seating().releaseSeat(e.id, bk.userId);
      await services.notify(bk.userId, 'lan-bookings', v.user!.id, `An organiser removed your ${bk.status === 'booked' ? 'booking' : 'interest'} for ${e.name}.`, `/m/lan-bookings/${e.slug}`);
      await services.audit(v.user!.id, 'lan-bookings.remove', { type: 'user', id: bk.userId }, { event: e.slug, status: bk.status }, v.ip);
      return 'Removed.';
    });

    ctx.adminRoutes.get('/events/:id/export.csv', async (c) => {
      const e = await adminEvent(c);
      const k = await counts(e.id);
      const cards = await services.users.cards(k.list.map((b) => b.userId));
      const seats = new Map((await seating().bookingsFor(e.id)).map((b) => [b.userId, b.seat]));
      const names = new Map(k.perType.map((t) => [t.type.id, t.type.name]));
      // quote every field and neutralise spreadsheet formulas
      const q = (x: unknown) => { let s = String(x ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
      const rows = [['member', 'status', 'type', 'seat', 'note', 'since', 'agreed_to_terms'], ...k.list.map((b) => [cards.get(b.userId)?.username ?? '', b.status, b.typeId ? names.get(b.typeId) ?? '' : '', seats.get(b.userId) ?? '', b.note, b.createdAt.toISOString(), b.termsAcceptedAt?.toISOString() ?? ''])];
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="${e.slug}-bookings.csv"`);
      return c.body(rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n');
    });

  },
});
