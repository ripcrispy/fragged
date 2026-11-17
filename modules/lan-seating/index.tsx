/** @jsxImportSource hono/jsx */
import {
  defineModule, database, eq, and, inArray, sql, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, UserLink, Time, EmptyState,
  form, str, int, setFlash, cleanLine, cleanText, slugify, parseLocalDateTime, toLocalInput, services, ServiceError,
  type ModuleContext, type RequestContext, type PageCtx, type UserCard,
} from '../../src/sdk/index.ts';
import { parseLayout, capacity, rowLabel, type Layout } from './layout.ts';
import {
  events, bookings, eventBySlug, eventById, listEvents, bookingsFor, bookingClosedReason, book, release, currentSummary, seatOf, seatFor, notifyMoved,
  setSeatPolicy, seatAccess, STATUSES, type SeatEvent, type SeatAccess,
} from './service.ts';

const db = () => database.db();
const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';

const EXAMPLE = `##########
SSSS..SSSS
SSSS..SSSS
..........
SSSS..SSSS
VVVV..XXSS`;

async function friendIds(userId: number): Promise<Set<number>> {
  const f = database.coreTables.friendships;
  const rows = await db().select().from(f).where(sql`${f.userLowId} = ${userId} or ${f.userHighId} = ${userId}`);
  return new Set(rows.map((r) => (r.userLowId === userId ? r.userHighId : r.userLowId)));
}

const NO_ACCESS_RULES: SeatAccess = { zones: new Map(), allowed: null, blocked: null };
interface MapProps { page: PageCtx; e: SeatEvent; layout: Layout; taken: Map<string, UserCard>; mine: string | null; friends: Set<number>; canBook: boolean; organiser?: boolean; access?: SeatAccess }

/** The seat map. Interactive seats are real buttons in forms (works without JavaScript). */
function SeatMap({ page, e, layout, taken, mine, friends, canBook, access = NO_ACCESS_RULES }: MapProps) {
  return (
    <div class="seatmap-scroll">
      <div class="seatmap" data-cols={layout.width} role="group" aria-label={`Seat map for ${e.name}`}>
        {layout.rows.map((row, r) => (
          <div class="seat-row">
            <span class="seat-row-label" aria-hidden="true">{rowLabel(r)}</span>
            {row.map((cell) => {
              if (cell.kind === 'aisle') return <span class="seat seat-aisle" aria-hidden="true" />;
              if (cell.kind === 'table') return <span class="seat seat-table" aria-hidden="true" />;
              const code = cell.code!;
              const who = taken.get(code);
              const zone = access.zones.get(code);
              const zc = zone ? ' seat-zone' : '';
              const zl = zone ? ` (${zone})` : '';
              if (who) {
                const isMe = code === mine;
                const isFriend = friends.has(who.id);
                // accessible name starts with the visible seat code; initials are decorative
                return <a class={`seat seat-taken ${isMe ? 'seat-mine' : ''} ${isFriend ? 'seat-friend' : ''}`} href={`/u/${encodeURIComponent(who.username)}`} title={`${code}: ${who.username}`}>
                  <span class="seat-code">{code}</span><span class="seat-who" aria-hidden="true">{who.username.slice(0, 2)}</span>
                  <span class="sr-only">{isMe ? ', your seat' : `, taken by ${who.username}${isFriend ? ' (friend)' : ''}`}</span></a>;
              }
              if (cell.kind === 'blocked') return <span class="seat seat-blocked" title={`${code}: unavailable`} aria-label={`Seat ${code}, unavailable`}><span class="seat-code">{code}</span></span>;
              if (cell.kind === 'reserved') return <span class="seat seat-reserved" title={`${code}: reserved`} aria-label={`Seat ${code}, reserved for organisers to assign`}><span class="seat-code">{code}</span></span>;
              const mayBook = canBook && !access.blocked && (!access.allowed || access.allowed.has(code));
              if (!mayBook) return <span class={`seat seat-free${zc}`} title={`${code}: free${zl}`} aria-label={`Seat ${code}, free${zl}`}><span class="seat-code">{code}</span></span>;
              return (
                <form method="post" action={`/m/lan-seating/${e.slug}/book`} class="seat-form">
                  <Csrf ctx={page} /><input type="hidden" name="seat" value={code} />
                  <button class={`seat seat-free seat-bookable${zc}`} aria-label={`Seat ${code}${zl}, free — ${mine ? 'move here' : 'book this seat'}`} title={`Book ${code}${zl}`}><span class="seat-code">{code}</span></button>
                </form>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ zones }: { zones?: Map<string, string> }) {
  const names = [...new Set(zones?.values() ?? [])];
  return (
    <ul class="seat-legend" aria-label="Legend">
      <li><span class="seat seat-free" aria-hidden="true" /> Free</li>
      <li><span class="seat seat-taken" aria-hidden="true" /> Taken</li>
      <li><span class="seat seat-taken seat-friend" aria-hidden="true" /> Friend</li>
      <li><span class="seat seat-taken seat-mine" aria-hidden="true" /> You</li>
      <li><span class="seat seat-reserved" aria-hidden="true" /> Reserved</li>
      <li><span class="seat seat-blocked" aria-hidden="true" /> Unavailable</li>
      {names.length ? <li><span class="seat seat-free seat-zone" aria-hidden="true" /> {names.map((n) => (/seats$/i.test(n) ? n : /seat$/i.test(n) ? `${n}s` : `${n} seats`)).join(', ')}</li> : null}
    </ul>
  );
}

async function mapData(c: RequestContext | { get(k: 'page'): PageCtx }, e: SeatEvent) {
  const page = (c as { get(k: 'page'): PageCtx }).get('page');
  const v = page.viewer;
  const layout = parseLayout(e.layout);
  const list = await bookingsFor(e.id);
  const cards = await services.users.cards(list.map((b) => b.userId));
  const taken = new Map(list.map((b) => [b.seat, cards.get(b.userId)!]).filter(([, u]) => !!u) as [string, UserCard][]);
  const mine = v.user ? list.find((b) => b.userId === v.user!.id)?.seat ?? null : null;
  const friends = v.user ? await friendIds(v.user.id) : new Set<number>();
  const access = await seatAccess(e.id, v.user?.id ?? null);
  return { page, layout, list, taken, mine, friends, cards, access };
}

export default defineModule({
  id: 'lan-seating',
  name: 'LAN party seat booking',
  version: '1.1.0',
  description: 'Draw a seat map for each LAN party and let attendees book their seat. Organisers can reserve, assign and move seats. Other modules can limit which seats a member may book (lan-bookings uses this for booking types).',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  enabledByDefault: false,
  migrations: 'migrations',
  assets: 'public',
  styles: ['seating.css'],
  permissions: {
    view: { label: 'See LAN party seat maps', grantTo: ['guest', 'member'] },
    book: { label: 'Book a seat at LAN parties', grantTo: ['member'] },
    manage: { label: 'Create LAN events, edit seat maps and assign seats' },
  },
  notificationKinds: { 'lan-seating': 'Seat changes made by LAN organisers' },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), book: ctx.perm('book'), manage: ctx.perm('manage') };
    ctx.expose({
      currentSummary, seatOf, seatFor, eventById, eventBySlug, listEvents, bookingsFor,
      /** seat codes in the event's map with their kind */
      seatCodes: async (eventId: number) => { const e = await eventById(eventId); return e ? parseLayout(e.layout).seats : new Map(); },
      /** organiser-side release (no booking-window checks) */
      releaseSeat: async (eventId: number, userId: number) => { const e = await eventById(eventId); if (e) await release(e, userId, { asOrganiser: true }); },
      /** register or clear (null) a seat policy, keyed by the calling module's id */
      setSeatPolicy,
      /** read-only seat map (with legend) for embedding in another module's page, e.g. a forum thread panel */
      mapView: async (eventId: number, page: PageCtx) => {
        const e = await eventById(eventId);
        if (!e) return null;
        const d = await mapData({ get: () => page }, e);
        return <div class="seatmap-embed"><Legend zones={d.access.zones} /><SeatMap page={page} e={e} layout={d.layout} taken={d.taken} mine={d.mine} friends={d.friends} canBook={false} access={d.access} /></div>;
      },
    });
    ctx.register.navItem({ href: '/m/lan-seating', label: 'Seating', icon: 'seat', area: 'main', order: 65, visible: (v) => v.can(P.view) });
    ctx.register.adminSection({ slug: 'events', label: 'LAN seating', permission: P.manage });
    ctx.hooks.on('user.closed', async ({ userId }) => { await db().delete(bookings).where(eq(bookings.userId, userId)); });

    ctx.register.profileSection({
      id: 'lan-seat', column: 'side', order: 40,
      async render({ user }) {
        const [s] = await seatOf(user.id);
        return s ? <Box title="LAN seat" headingLevel={3}><p><a href={`/m/lan-seating/${s.slug}`}>{s.name}</a>: seat <strong>{s.seat}</strong></p></Box> : null;
      },
    });

    // ── public pages ──
    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer'); await v.require(P.view);
      const organiser = await v.can(P.manage);
      const list = await listEvents(organiser);
      const page = c.get('page');
      return ctx.render(c, 'LAN seating', (
        <>
          <h1 class="page-title">LAN party seating</h1>
          {list.length ? (
            <div class="table-wrap"><table class="data-table"><thead><tr><th>Event</th><th>When</th><th>Where</th><th>Seats</th><th>Status</th></tr></thead><tbody>
              {await Promise.all(list.map(async (e) => {
                const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.eventId, e.id));
                return <tr><td><a href={`/m/lan-seating/${e.slug}`}><strong>{e.name}</strong></a></td><td><Time d={e.startsAt} tz={tzOf(page)} /></td><td>{e.location}</td>
                  <td>{n} / {capacity(parseLayout(e.layout))}</td><td><span class={`tag ${e.status === 'open' ? 'tag-ok' : ''}`}>{STATUSES[e.status as keyof typeof STATUSES] ?? e.status}</span></td></tr>;
              }))}
            </tbody></table></div>
          ) : <EmptyState title="No LAN parties yet.">{organiser ? <p><a href="/admin/m/lan-seating/events">Create the first event</a>.</p> : <p>Check back soon.</p>}</EmptyState>}
        </>
      ), { crumbs: [{ label: 'LAN seating' }] });
    });

    const loadEvent = async (c: RequestContext) => {
      const v = c.get('viewer'); await v.require(P.view);
      const e = await eventBySlug(c.req.param('slug') ?? '');
      if (!e || (e.status === 'draft' && !(await v.can(P.manage)))) throw new ServiceError('Event not found.', 404);
      return e;
    };

    ctx.routes.get('/:slug', async (c) => {
      const e = await loadEvent(c);
      const d = await mapData(c, e);
      const v = d.page.viewer;
      const closed = bookingClosedReason(e);
      const canBook = !closed && (await v.can(P.book));
      const cap = capacity(d.layout);
      const rows = [...d.layout.seats.entries()].filter(([, k]) => k !== 'blocked');
      return ctx.render(c, e.name, (
        <>
          <h1 class="page-title">{e.name}</h1>
          <p class="page-desc">{e.location ? <>{e.location} · </> : null}<Time d={e.startsAt} tz={tzOf(d.page)} />{e.endsAt ? <> – <Time d={e.endsAt} tz={tzOf(d.page)} /></> : null}</p>
          {e.notes ? <Notice type="info">{e.notes}</Notice> : null}
          <div class="seat-summary">
            <span><strong>{d.list.length}</strong> of {cap} seats booked</span>
            {d.mine ? <span>Your seat: <strong>{d.mine}</strong></span> : null}
            {d.mine && !closed ? <ActionButton ctx={d.page} action={`/m/lan-seating/${e.slug}/release`} label="Give up my seat" className="btn btn-small" confirm="Give up your seat?" /> : null}
            {closed ? <span class="muted">{closed}</span> : !v.user ? <a href={`/login?returnTo=/m/lan-seating/${e.slug}`}>Sign in to book a seat</a> : !canBook ? <span class="muted">You can't book seats.</span>
              : d.access.blocked ? <span>{d.access.blocked.text}{d.access.blocked.href ? <> <a href={d.access.blocked.href}>Book a place</a></> : null}</span>
              : <span class="muted">Choose a free seat to {d.mine ? 'move' : 'book it'}{d.access.allowed ? ' (highlighted seats are the ones your booking includes)' : ''}.</span>}
          </div>
          <Legend zones={d.access.zones} />
          <div data-seatmap data-seatmap-live={!closed ? `/m/lan-seating/${e.slug}/map` : undefined}>
            <SeatMap page={d.page} e={e} layout={d.layout} taken={d.taken} mine={d.mine} friends={d.friends} canBook={canBook} access={d.access} />
          </div>
          <details class="seat-list"><summary>Seat list (table view)</summary>
            <table class="data-table"><thead><tr><th>Seat</th><th>Status</th></tr></thead><tbody>
              {rows.map(([code, kind]) => { const u = d.taken.get(code); return <tr><td>{code}</td><td>{u ? <UserLink user={u} /> : kind === 'reserved' ? 'Reserved' : 'Free'}</td></tr>; })}
            </tbody></table>
          </details>
          <script src="/modules/lan-seating/seating.js" defer></script>
        </>
      ), { crumbs: [{ label: 'LAN seating', href: '/m/lan-seating' }, { label: e.name }] });
    });

    // map fragment for live refresh while booking is open
    ctx.routes.get('/:slug/map', async (c) => {
      const e = await loadEvent(c);
      const d = await mapData(c, e);
      const canBook = !bookingClosedReason(e) && (await d.page.viewer.can(P.book));
      c.header('Cache-Control', 'no-store');
      return c.html(String(await (<SeatMap page={d.page} e={e} layout={d.layout} taken={d.taken} mine={d.mine} friends={d.friends} canBook={canBook} access={d.access} />)));
    });

    ctx.routes.post('/:slug/book', async (c) => {
      const e = await loadEvent(c);
      const v = c.get('viewer'); await v.require(P.book);
      const seat = str((await form(c)).seat).toUpperCase();
      try { await book(e, v.user!.id, seat); setFlash(c, { type: 'ok', text: `You're in seat ${seat}. See you there!` }); }
      catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect(`/m/lan-seating/${e.slug}`);
    });
    ctx.routes.post('/:slug/release', async (c) => {
      const e = await loadEvent(c);
      const v = c.get('viewer'); await v.require(P.book);
      try { await release(e, v.user!.id); setFlash(c, { type: 'ok', text: 'Your seat is free again.' }); }
      catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect(`/m/lan-seating/${e.slug}`);
    });

    // ── organiser admin ──
    const EventForm = ({ page, e, error }: { page: PageCtx; e?: SeatEvent; error?: string }) => {
      const tz = tzOf(page);
      const preview = parseLayout(e?.layout ?? EXAMPLE);
      return (
        <form method="post" action={e ? `/admin/m/lan-seating/events/${e.id}` : '/admin/m/lan-seating/events/new'} class="form-grid"><Csrf ctx={page} />
          {error ? <Notice type="error">{error}</Notice> : null}
          <div class="field-row"><Field label="Event name" name="name" value={e?.name} required maxlength={120} /><Field label="Location" name="location" value={e?.location} maxlength={160} /></div>
          <div class="field-row">
            <Field label={`Starts (${tz})`} name="startsAt" type="datetime-local" value={toLocalInput(e?.startsAt, tz)} />
            <Field label={`Ends (${tz})`} name="endsAt" type="datetime-local" value={toLocalInput(e?.endsAt, tz)} />
          </div>
          <div class="field-row">
            <Field label={`Booking opens (${tz}, optional)`} name="bookingOpensAt" type="datetime-local" value={toLocalInput(e?.bookingOpensAt, tz)} />
            <Field label={`Booking closes (${tz}, optional)`} name="bookingClosesAt" type="datetime-local" value={toLocalInput(e?.bookingClosesAt, tz)} />
            <Select label="Status" name="status" value={e?.status ?? 'draft'} options={Object.entries(STATUSES)} />
          </div>
          <TextArea label="Notes shown above the map (optional)" name="notes" value={e?.notes} rows={2} maxlength={2000} />
          <div class="field">
            <label for="f-layout">Seat map</label>
            <textarea id="f-layout" name="layout" rows={10} class="layout-input" spellcheck={false} aria-describedby="layout-help">{e?.layout ?? EXAMPLE}</textarea>
            <div class="field-hint" id="layout-help">One line per row. <code>S</code> seat · <code>V</code> reserved (organisers assign) · <code>X</code> blocked · <code>.</code> aisle · <code>#</code> table/wall. Rows are lettered A, B, C…; seats numbered left to right.</div>
          </div>
          {e ? <div><p class="muted small">Current map preview ({capacity(preview)} seats):</p><Legend /><SeatMap page={page} e={e} layout={preview} taken={new Map()} mine={null} friends={new Set()} canBook={false} /></div> : null}
          <div class="form-actions"><button class="btn btn-primary">{e ? 'Save event' : 'Create event'}</button></div>
        </form>
      );
    };

    const values = (b: Record<string, unknown>, tz: string) => {
      const name = cleanLine(b.name, 120);
      if (name.length < 2) throw new ServiceError('Give the event a name.');
      const layout = cleanText(b.layout, 6000).toUpperCase();
      const parsed = parseLayout(layout);
      if (parsed.errors.length) throw new ServiceError(`Seat map: ${parsed.errors.join(' ')}`);
      const status = Object.keys(STATUSES).includes(str(b.status)) ? str(b.status) : 'draft';
      const d = (k: string) => (str(b[k]) ? parseLocalDateTime(str(b[k]), tz) : null);
      return { name, location: cleanLine(b.location, 160), notes: cleanText(b.notes, 2000), layout, status, startsAt: d('startsAt'), endsAt: d('endsAt'), bookingOpensAt: d('bookingOpensAt'), bookingClosesAt: d('bookingClosesAt') };
    };

    ctx.adminRoutes.get('/events', async (c) => {
      await c.get('viewer').require(P.manage);
      const page = c.get('page');
      const list = await listEvents(true);
      return ctx.renderAdmin(c, 'LAN seating', P.manage, (
        <>
          <Box title="Events">{list.length ? <ul class="plain-list lan-event-list">{list.map((e) => <li><a href={`/admin/m/lan-seating/events/${e.id}`}><strong>{e.name}</strong></a> <span class="muted">· {STATUSES[e.status as keyof typeof STATUSES]} · <Time d={e.startsAt} tz={tzOf(page)} /></span> · <a href={`/m/lan-seating/${e.slug}`}>view map</a></li>)}</ul> : <p class="muted">No events yet.</p>}</Box>
          <Box title="New event"><EventForm page={page} /></Box>
        </>
      ));
    });
    ctx.adminRoutes.post('/events/new', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      try {
        const vals = values(await form(c), tzOf(c.get('page')));
        let slug = slugify(vals.name, 70);
        if (await eventBySlug(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
        const [e] = await db().insert(events).values({ ...vals, slug }).returning();
        await services.audit(v.user!.id, 'lan-seating.event.create', { type: 'lan_event', id: e.id }, { name: e.name }, v.ip);
        setFlash(c, { type: 'ok', text: 'Event created.' });
        return c.redirect(`/admin/m/lan-seating/events/${e.id}`);
      } catch (err) { if (err instanceof ServiceError) { setFlash(c, { type: 'error', text: err.message }); return c.redirect('/admin/m/lan-seating/events'); } throw err; }
    });

    const loadById = async (c: RequestContext) => {
      await c.get('viewer').require(P.manage);
      const [e] = await db().select().from(events).where(eq(events.id, int(c.req.param('id'))));
      if (!e) throw new ServiceError('Event not found.', 404);
      return e;
    };
    ctx.adminRoutes.get('/events/:id', async (c) => {
      const e = await loadById(c);
      const d = await mapData(c, e);
      return ctx.renderAdmin(c, `LAN seating: ${e.name}`, P.manage, (
        <>
          <p><a href="/admin/m/lan-seating/events">← All events</a> · <a href={`/m/lan-seating/${e.slug}`}>View public map</a></p>
          <Box title="Event & seat map"><EventForm page={d.page} e={e} /></Box>
          <Box title={`Bookings (${d.list.length} / ${capacity(d.layout)})`}>
            <form method="post" action={`/admin/m/lan-seating/events/${e.id}/assign`} class="inline-form"><Csrf ctx={d.page} />
              <label for="as-user">Assign member</label> <input id="as-user" name="username" required placeholder="Username" data-member-autocomplete list="as-user-list" /><datalist id="as-user-list" />
              <label for="as-seat">to seat</label> <input id="as-seat" name="seat" required maxlength={8} class="input-narrow" placeholder="B4" />
              <button class="btn btn-small btn-primary">Assign</button></form>
            {d.list.length ? <table class="data-table"><thead><tr><th>Seat</th><th>Member</th><th>Booked</th><th /></tr></thead><tbody>
              {[...d.list].sort((a, b) => a.seat.localeCompare(b.seat, undefined, { numeric: true })).map((b) => (
                <tr><td>{b.seat}</td><td><UserLink user={d.cards.get(b.userId)} />{b.assignedBy ? <span class="muted small"> (assigned)</span> : null}</td><td><Time d={b.createdAt} tz={tzOf(d.page)} mode="ago" /></td>
                  <td><ActionButton ctx={d.page} action={`/admin/m/lan-seating/events/${e.id}/remove`} fields={{ userId: b.userId }} label="Remove" className="btn btn-small" confirm={`Remove ${d.cards.get(b.userId)?.username} from seat ${b.seat}?`} /></td></tr>))}
            </tbody></table> : <p class="muted">No bookings yet.</p>}
          </Box>
        </>
      ));
    });
    ctx.adminRoutes.post('/events/:id', async (c) => {
      const e = await loadById(c);
      const v = c.get('viewer');
      try {
        const vals = values(await form(c), tzOf(c.get('page')));
        // seats that disappear from the new layout lose their bookings (members are told)
        const keep = parseLayout(vals.layout).seats;
        const orphaned = (await bookingsFor(e.id)).filter((b) => !keep.has(b.seat) || keep.get(b.seat) === 'blocked');
        await db().update(events).set(vals).where(eq(events.id, e.id));
        if (orphaned.length) {
          await db().delete(bookings).where(and(eq(bookings.eventId, e.id), inArray(bookings.id, orphaned.map((o) => o.id))));
          for (const o of orphaned) await notifyMoved(o.userId, v.user!.id, { ...e, ...vals }, null);
        }
        await services.audit(v.user!.id, 'lan-seating.event.update', { type: 'lan_event', id: e.id }, { removedBookings: orphaned.length }, v.ip);
        setFlash(c, { type: 'ok', text: orphaned.length ? `Saved. ${orphaned.length} booking(s) on removed seats were cancelled and those members notified.` : 'Saved.' });
      } catch (err) { if (err instanceof ServiceError) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect(`/admin/m/lan-seating/events/${e.id}`);
    });
    ctx.adminRoutes.post('/events/:id/assign', async (c) => {
      const e = await loadById(c);
      const v = c.get('viewer');
      const b = await form(c);
      const u = await services.users.getByUsername(str(b.username));
      const seat = str(b.seat).trim().toUpperCase();
      try {
        if (!u) throw new ServiceError('No member with that username.');
        await book(e, u.id, seat, { asOrganiser: true, assignedBy: v.user!.id });
        await notifyMoved(u.id, v.user!.id, e, seat);
        await services.audit(v.user!.id, 'lan-seating.assign', { type: 'user', id: u.id }, { event: e.slug, seat }, v.ip);
        setFlash(c, { type: 'ok', text: `${u.username} is now in seat ${seat}.` });
      } catch (err) { if (err instanceof ServiceError) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect(`/admin/m/lan-seating/events/${e.id}`);
    });
    ctx.adminRoutes.post('/events/:id/remove', async (c) => {
      const e = await loadById(c);
      const v = c.get('viewer');
      const userId = int((await form(c)).userId);
      await release(e, userId, { asOrganiser: true });
      await notifyMoved(userId, v.user!.id, e, null);
      await services.audit(v.user!.id, 'lan-seating.remove', { type: 'user', id: userId }, { event: e.slug }, v.ip);
      return c.redirect(`/admin/m/lan-seating/events/${e.id}`);
    });
  },
});
