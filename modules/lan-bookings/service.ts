import { database, services, pg, eq, and, asc, sql, inArray, ServiceError, type Child, type PageCtx } from '../../src/sdk/index.ts';

// ── what this module uses from lan-seating (its exposed API) ──
export interface SeatEventLite { id: number; slug: string; name: string; location: string; status: string; startsAt: Date | null; endsAt: Date | null }
export interface SeatingApi {
  eventById(id: number): Promise<SeatEventLite | null>;
  eventBySlug(slug: string): Promise<SeatEventLite | null>;
  listEvents(includeDrafts: boolean): Promise<SeatEventLite[]>;
  bookingsFor(eventId: number): Promise<{ userId: number; seat: string }[]>;
  seatCodes(eventId: number): Promise<Map<string, 'seat' | 'reserved' | 'blocked' | 'aisle' | 'table'>>;
  seatFor(eventId: number, userId: number): Promise<string | null>;
  releaseSeat(eventId: number, userId: number): Promise<void>;
  setSeatPolicy(owner: string, policy: { access(eventId: number, userId: number | null): Promise<unknown> } | null): void;
  mapView(eventId: number, page: PageCtx): Promise<Child | null>;
}

export const configs = pg.pgTable('mod_lan_bookings_events', {
  eventId: pg.integer('event_id').primaryKey(),
  status: pg.varchar('status', { length: 12 }).notNull().default('draft'),
  intro: pg.text('intro').notNull().default(''),
  requireBooking: pg.boolean('require_booking').notNull().default(true),
  rules: pg.text('rules').notNull().default(''),
  panelSections: pg.varchar('panel_sections', { length: 120 }).notNull().default('rules,crew,bookings,schedule,servers,seatmap'),
  threadId: pg.integer('thread_id'),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const types = pg.pgTable('mod_lan_bookings_types', {
  id: pg.serial('id').primaryKey(),
  eventId: pg.integer('event_id').notNull(),
  name: pg.varchar('name', { length: 60 }).notNull(),
  description: pg.varchar('description', { length: 300 }).notNull().default(''),
  priceCents: pg.integer('price_cents').notNull().default(0),
  capacity: pg.integer('capacity'),
  seats: pg.text('seats').notNull().default(''),
  displayOrder: pg.integer('display_order').notNull().default(0),
  active: pg.boolean('active').notNull().default(true),
});
export const bookings = pg.pgTable('mod_lan_bookings_bookings', {
  id: pg.serial('id').primaryKey(),
  eventId: pg.integer('event_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  typeId: pg.integer('type_id'),
  status: pg.varchar('status', { length: 12 }).notNull().default('interested'),
  note: pg.varchar('note', { length: 200 }).notNull().default(''),
  termsAcceptedAt: pg.timestamp('terms_accepted_at', { withTimezone: true }),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const staff = pg.pgTable('mod_lan_bookings_staff', {
  id: pg.serial('id').primaryKey(),
  eventId: pg.integer('event_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  role: pg.varchar('role', { length: 40 }).notNull(),
  note: pg.varchar('note', { length: 100 }).notNull().default(''),
  displayOrder: pg.integer('display_order').notNull().default(0),
});
export type Config = typeof configs.$inferSelect;
export type StaffMember = typeof staff.$inferSelect;

/** Sections of the live panel on the announcement thread, in display order. */
export const PANEL_SECTIONS = {
  rules: 'Event rules and terms',
  crew: 'Event crew (admins, moderators, volunteers)',
  bookings: 'Who has booked, by booking type',
  schedule: 'Sub-events from the LAN intranet schedule',
  servers: 'Game servers from the LAN intranet',
  seatmap: 'Seat map',
} as const;
export type PanelSection = keyof typeof PANEL_SECTIONS;
export const panelSectionsOf = (c: Config) => new Set(c.panelSections.split(',').filter((x): x is PanelSection => x in PANEL_SECTIONS));
export const CREW_ROLES = ['Admin', 'Moderator', 'LAN admin', 'Volunteer'] as const;
export type BookingType = typeof types.$inferSelect;
export type Booking = typeof bookings.$inferSelect;

export const STATUSES = { draft: 'Draft (only organisers can see it)', open: 'Open for bookings', closed: 'Bookings closed' } as const;
export type Status = keyof typeof STATUSES;
export const DEFAULT_TYPES = [
  { name: 'Standard seat', description: 'A seat with a wired gigabit connection.', priceCents: 2000, capacity: null, seats: '' },
  { name: 'High-speed network seat', description: 'A seat on the 10 Gb/s switch, for streamers and big downloads.', priceCents: 3000, capacity: 8, seats: '' },
];

export const DEFAULT_RULES = `[b]Booking and payment[/b]
[list]
[*]Your place is confirmed once you book here. Pay at the door when you arrive.
[*]Can't make it? Cancel your booking so someone else can have the place.
[/list]
[b]At the event[/b]
[list]
[*]Be kind. Harassment, cheating and hate speech get you removed without a refund.
[*]Only use your booked seat and network connection. Don't plug in extra switches or routers.
[*]No alcohol at the desks. Keep walkways clear of cables and bags.
[*]You're responsible for your own equipment.
[/list]`;

const db = () => database.db();

export function parseMoney(raw: string): number | null {
  const m = /^\s*(\d{1,5})(?:[.,](\d{1,2}))?\s*$/.exec(raw);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
}
export const formatMoney = (cents: number, symbol: string) => (cents ? `${symbol}${(cents / 100).toFixed(2)}` : 'Free');

// ── seat lists for booking types ──

/**
 * "A1-A8, B, C3 D-E": single seats, ranges within a row ("A1-A8" or "A1-8"), whole rows ("B") and row ranges
 * ("D-E"). Checked against the event's seat map; blocked seats are ignored.
 */
export function parseSeatSpec(spec: string, codes: Map<string, string>): { seats: Set<string>; errors: string[] } {
  const seats = new Set<string>();
  const errors: string[] = [];
  const rowOf = (code: string) => /^[A-Z]+/.exec(code)![0];
  const numOf = (code: string) => Number(/\d+$/.exec(code)![0]);
  const rowIndex = (row: string) => [...row].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const usable = [...codes].filter(([, k]) => k === 'seat' || k === 'reserved').map(([c]) => c);
  for (const tok of spec.toUpperCase().split(/[\s,;]+/).filter(Boolean).slice(0, 200)) {
    let m: RegExpExecArray | null;
    let hit: string[] = [];
    if ((m = /^([A-Z]{1,2})$/.exec(tok))) hit = usable.filter((c) => rowOf(c) === m![1]);
    else if ((m = /^([A-Z]{1,2})-([A-Z]{1,2})$/.exec(tok))) { const a = rowIndex(m[1]), b = rowIndex(m[2]); hit = usable.filter((c) => { const r = rowIndex(rowOf(c)); return r >= Math.min(a, b) && r <= Math.max(a, b); }); }
    else if ((m = /^([A-Z]{1,2})(\d{1,3})$/.exec(tok))) hit = usable.includes(tok) ? [tok] : [];
    else if ((m = /^([A-Z]{1,2})(\d{1,3})-(?:([A-Z]{1,2}))?(\d{1,3})$/.exec(tok))) {
      if (m[3] && m[3] !== m[1]) { errors.push(`“${tok}”: a range must stay in one row.`); continue; }
      const lo = Math.min(Number(m[2]), Number(m[4])), hi = Math.max(Number(m[2]), Number(m[4]));
      hit = usable.filter((c) => rowOf(c) === m![1] && numOf(c) >= lo && numOf(c) <= hi);
    } else { errors.push(`“${tok}” isn’t a seat, row or range.`); continue; }
    if (!hit.length) errors.push(`“${tok}” doesn’t match any seat on the map.`);
    for (const c of hit) seats.add(c);
  }
  return { seats, errors: errors.slice(0, 5) };
}

// ── reads ──

export async function configFor(eventId: number) { return (await db().select().from(configs).where(eq(configs.eventId, eventId)))[0] ?? null; }
export async function configForThread(threadId: number) { return (await db().select().from(configs).where(eq(configs.threadId, threadId)))[0] ?? null; }
export async function allConfigs() { return db().select().from(configs); }
export async function typesFor(eventId: number, includeInactive = false) {
  const list = await db().select().from(types).where(eq(types.eventId, eventId)).orderBy(asc(types.displayOrder), asc(types.id));
  return includeInactive ? list : list.filter((t) => t.active);
}
export async function bookingsForEvent(eventId: number) { return db().select().from(bookings).where(eq(bookings.eventId, eventId)).orderBy(asc(bookings.createdAt)); }
export async function bookingOf(eventId: number, userId: number) {
  return (await db().select().from(bookings).where(and(eq(bookings.eventId, eventId), eq(bookings.userId, userId))))[0] ?? null;
}

export async function setUp(eventId: number) {
  await db().insert(configs).values({ eventId, rules: DEFAULT_RULES }).onConflictDoNothing();
  if (!(await typesFor(eventId, true)).length) await db().insert(types).values(DEFAULT_TYPES.map((t, i) => ({ ...t, eventId, displayOrder: (i + 1) * 10 })));
  return (await configFor(eventId))!;
}

export interface TypeCount { type: BookingType; booked: number; interested: number; left: number | null }
export async function counts(eventId: number) {
  const [list, ts] = await Promise.all([bookingsForEvent(eventId), typesFor(eventId, true)]);
  const perType: TypeCount[] = ts.map((t) => {
    const booked = list.filter((b) => b.typeId === t.id && b.status === 'booked').length;
    return { type: t, booked, interested: list.filter((b) => b.typeId === t.id && b.status === 'interested').length, left: t.capacity === null ? null : Math.max(0, t.capacity - booked) };
  });
  return {
    perType,
    booked: list.filter((b) => b.status === 'booked').length,
    interested: list.filter((b) => b.status === 'interested').length,
    undecided: list.filter((b) => b.status === 'interested' && b.typeId === null).length,
    list,
  };
}

/** Sign-ups per day for the last `days` days (oldest first), for the interest chart. */
export function signupsByDay(list: Booking[], days = 21, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(start.getTime() + i * 86_400_000), booked: 0, interested: 0 }));
  for (const b of list) {
    const i = Math.floor((b.createdAt.getTime() - start.getTime()) / 86_400_000);
    if (i >= 0 && i < days) out[i][b.status === 'booked' ? 'booked' : 'interested']++;
  }
  return out;
}

// ── member actions ──

function closedReason(cfg: Config | null): string | null {
  if (!cfg || cfg.status === 'draft') return 'Bookings for this event haven’t opened yet.';
  if (cfg.status !== 'open') return 'Bookings for this event are closed.';
  return null;
}

/** Book a place of a given type. Capacity is checked under a row lock so two members can't take the last place. */
export async function bookPlace(seating: SeatingApi, eventId: number, userId: number, typeId: number, note: string, opts: { asOrganiser?: boolean; acceptedTerms?: boolean } = {}) {
  const cfg = await configFor(eventId);
  if (!opts.asOrganiser) {
    const why = closedReason(cfg); if (why) throw new ServiceError(why, 403);
    if (cfg!.rules.trim() && !opts.acceptedTerms) throw new ServiceError('Please agree to the event rules and terms to book.', 400, 'terms');
  }
  const accepted = opts.acceptedTerms ? { termsAcceptedAt: new Date() } : {};
  const before = await bookingOf(eventId, userId);
  await db().transaction(async (tx) => {
    const [t] = await tx.select().from(types).where(and(eq(types.id, typeId), eq(types.eventId, eventId))).for('update');
    if (!t || (!t.active && !opts.asOrganiser)) throw new ServiceError('That booking type isn’t available.', 404);
    if (t.capacity !== null && !opts.asOrganiser && !(before?.status === 'booked' && before.typeId === t.id)) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.typeId, t.id), eq(bookings.status, 'booked')));
      if (n >= t.capacity) throw new ServiceError(`${t.name} is fully booked. You can register your interest instead.`, 409, 'full');
    }
    await tx.insert(bookings).values({ eventId, userId, typeId: t.id, status: 'booked', note, ...accepted })
      .onConflictDoUpdate({ target: [bookings.eventId, bookings.userId], set: { typeId: t.id, status: 'booked', note, updatedAt: new Date(), ...accepted } });
  });
  await releaseSeatIfNotAllowed(seating, eventId, userId);
  return { changedFrom: before };
}

export async function registerInterest(eventId: number, userId: number, typeId: number | null, note: string) {
  const why = closedReason(await configFor(eventId));
  if (why) throw new ServiceError(why, 403);
  const before = await bookingOf(eventId, userId);
  if (before?.status === 'booked') throw new ServiceError('You’ve already booked a place. Cancel it first if you only want to register interest.', 409);
  if (typeId !== null && !(await typesFor(eventId)).some((t) => t.id === typeId)) throw new ServiceError('That booking type isn’t available.', 404);
  await db().insert(bookings).values({ eventId, userId, typeId, status: 'interested', note })
    .onConflictDoUpdate({ target: [bookings.eventId, bookings.userId], set: { typeId, status: 'interested', note, updatedAt: new Date() } });
}

export async function cancel(seating: SeatingApi, eventId: number, userId: number, opts: { asOrganiser?: boolean } = {}) {
  if (!opts.asOrganiser) {
    const cfg = await configFor(eventId);
    if (!cfg || cfg.status === 'draft') throw new ServiceError('Bookings for this event haven’t opened yet.', 403);
  }
  const b = await bookingOf(eventId, userId);
  if (!b) throw new ServiceError('There’s no booking to cancel.', 404);
  await db().delete(bookings).where(eq(bookings.id, b.id));
  // a cancelled place frees the seat too, when seats require a booking
  if (b.status === 'booked') await releaseSeatIfNotAllowed(seating, eventId, userId);
  return b;
}

// ── seat rules (registered with lan-seating) ──

/** Which seats each type covers, and the seats no type claims (open to any booking). */
export async function seatZones(seating: SeatingApi, eventId: number) {
  const ts = await typesFor(eventId, true);
  if (!ts.some((t) => t.seats.trim())) return null;
  const codes = await seating.seatCodes(eventId);
  const byType = new Map<number, Set<string>>();
  const zones = new Map<string, string>();
  for (const t of ts) {
    if (!t.seats.trim()) continue;
    const s = parseSeatSpec(t.seats, codes as Map<string, string>).seats;
    byType.set(t.id, s);
    for (const c of s) if (!zones.has(c)) zones.set(c, t.name);
  }
  const general = new Set([...codes].filter(([c, k]) => k === 'seat' && !zones.has(c)).map(([c]) => c));
  return { byType, zones, general };
}

export async function seatAccess(seating: SeatingApi, eventId: number, userId: number | null, bookingUrl: string) {
  const cfg = await configFor(eventId);
  if (!cfg || cfg.status === 'draft') return null;
  const z = await seatZones(seating, eventId);
  const zones = z?.zones ?? new Map<string, string>();
  if (userId === null) return { zones, allowed: null, blocked: null };
  const b = await bookingOf(eventId, userId);
  if (cfg.requireBooking && b?.status !== 'booked') return { zones, allowed: new Set<string>(), blocked: { text: 'Book a place before picking a seat.', href: bookingUrl } };
  if (!z || b?.status !== 'booked' || b.typeId === null) return { zones, allowed: z ? z.general : null, blocked: null };
  return { zones, allowed: z.byType.get(b.typeId) ?? z.general, blocked: null };
}

/** After a booking change: if the member's seat is no longer covered, release it and tell them. */
async function releaseSeatIfNotAllowed(seating: SeatingApi, eventId: number, userId: number) {
  const seat = await seating.seatFor(eventId, userId);
  if (!seat) return;
  const access = await seatAccess(seating, eventId, userId, '');
  if (!access || (!access.blocked && (!access.allowed || access.allowed.has(seat)))) return;
  await seating.releaseSeat(eventId, userId);
  const e = await seating.eventById(eventId);
  await services.notify(userId, 'lan-bookings', null, `Your seat ${seat} at ${e?.name ?? 'the LAN'} was released because your booking no longer includes it. Pick a new seat.`, e ? `/m/lan-seating/${e.slug}` : '/m/lan-bookings');
}

export async function forgetUser(userId: number) {
  await db().delete(bookings).where(eq(bookings.userId, userId));
  await db().delete(staff).where(eq(staff.userId, userId));
}

export async function crewFor(eventId: number) { return db().select().from(staff).where(eq(staff.eventId, eventId)).orderBy(asc(staff.displayOrder), asc(staff.id)); }
export async function addCrew(eventId: number, userId: number, role: string, note: string) {
  const order = Math.max(0, ...(await crewFor(eventId)).map((s) => s.displayOrder)) + 10;
  await db().insert(staff).values({ eventId, userId, role, note, displayOrder: order })
    .onConflictDoUpdate({ target: [staff.eventId, staff.userId], set: { role, note } });
}
export async function removeCrew(eventId: number, id: number) { await db().delete(staff).where(and(eq(staff.eventId, eventId), eq(staff.id, id))); }

export async function bookingsByIds(ids: number[]) { return ids.length ? db().select().from(bookings).where(inArray(bookings.id, ids)) : []; }
