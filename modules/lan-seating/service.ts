import { database, services, pg, eq, and, desc, sql, ServiceError } from '../../src/sdk/index.ts';
import { parseLayout, capacity } from './layout.ts';

export const events = pg.pgTable('mod_lan_seating_events', {
  id: pg.serial('id').primaryKey(),
  slug: pg.varchar('slug', { length: 80 }).notNull(),
  name: pg.varchar('name', { length: 120 }).notNull(),
  location: pg.varchar('location', { length: 160 }).notNull().default(''),
  notes: pg.text('notes').notNull().default(''),
  layout: pg.text('layout').notNull(),
  status: pg.varchar('status', { length: 12 }).notNull().default('draft'),
  startsAt: pg.timestamp('starts_at', { withTimezone: true }),
  endsAt: pg.timestamp('ends_at', { withTimezone: true }),
  bookingOpensAt: pg.timestamp('booking_opens_at', { withTimezone: true }),
  bookingClosesAt: pg.timestamp('booking_closes_at', { withTimezone: true }),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const bookings = pg.pgTable('mod_lan_seating_bookings', {
  id: pg.serial('id').primaryKey(),
  eventId: pg.integer('event_id').notNull(),
  seat: pg.varchar('seat', { length: 8 }).notNull(),
  userId: pg.integer('user_id').notNull(),
  assignedBy: pg.integer('assigned_by'),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type SeatEvent = typeof events.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export const STATUSES = { draft: 'Draft (only organisers can see it)', open: 'Open for booking', closed: 'Booking closed', archived: 'Archived' } as const;

const db = () => database.db();

export async function eventBySlug(slug: string) { return (await db().select().from(events).where(eq(events.slug, slug)))[0] ?? null; }
export async function listEvents(includeDrafts: boolean) {
  const all = await db().select().from(events).orderBy(desc(events.startsAt), desc(events.id));
  return includeDrafts ? all : all.filter((e) => e.status !== 'draft');
}
export async function bookingsFor(eventId: number) { return db().select().from(bookings).where(eq(bookings.eventId, eventId)); }

/** Is self-service booking possible right now? Returns the reason when not. */
export function bookingClosedReason(e: SeatEvent, now = new Date()): string | null {
  if (e.status === 'draft') return 'This event is not published yet.';
  if (e.status !== 'open') return 'Booking is closed for this event.';
  if (e.bookingOpensAt && now < e.bookingOpensAt) return 'Booking hasn’t opened yet.';
  if (e.bookingClosesAt && now > e.bookingClosesAt) return 'Booking has closed.';
  return null;
}

/** Book (or move to) a seat. One seat per member; unique constraints make concurrent double-booking impossible. */
export async function book(e: SeatEvent, userId: number, seat: string, opts: { asOrganiser?: boolean; assignedBy?: number } = {}) {
  const layout = parseLayout(e.layout);
  const kind = layout.seats.get(seat);
  if (!kind) throw new ServiceError('That seat doesn’t exist.', 404);
  if (!opts.asOrganiser) {
    const closed = bookingClosedReason(e);
    if (closed) throw new ServiceError(closed, 403, 'booking_closed');
    if (kind !== 'seat') throw new ServiceError(kind === 'reserved' ? 'That seat is reserved — ask an organiser.' : 'That seat isn’t available.', 403);
  } else if (kind === 'blocked') throw new ServiceError('That seat is blocked in the layout.', 409);
  try {
    await db().transaction(async (tx) => {
      await tx.delete(bookings).where(and(eq(bookings.eventId, e.id), eq(bookings.userId, userId)));
      await tx.insert(bookings).values({ eventId: e.id, seat, userId, assignedBy: opts.assignedBy ?? null });
    });
  } catch (err: any) {
    if (String(err?.cause?.message ?? err?.message).includes('mod_lan_seating_seat_uq')) throw new ServiceError(`Seat ${seat} was just taken — pick another.`, 409, 'seat_taken');
    throw err;
  }
}

export async function release(e: SeatEvent, userId: number, opts: { asOrganiser?: boolean } = {}) {
  if (!opts.asOrganiser) { const closed = bookingClosedReason(e); if (closed) throw new ServiceError(closed, 403, 'booking_closed'); }
  await db().delete(bookings).where(and(eq(bookings.eventId, e.id), eq(bookings.userId, userId)));
}

/** Small summary for other modules (e.g. the LAN intranet page). */
export async function currentSummary() {
  const rows = await db().select().from(events).where(sql`${events.status} in ('open','closed')`).orderBy(desc(events.startsAt)).limit(1);
  const e = rows[0];
  if (!e) return null;
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.eventId, e.id));
  return { name: e.name, slug: e.slug, startsAt: e.startsAt, booked: n, capacity: capacity(parseLayout(e.layout)), url: `/m/lan-seating/${e.slug}` };
}

export async function seatOf(userId: number) {
  return db().select({ seat: bookings.seat, name: events.name, slug: events.slug, status: events.status }).from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId)).where(and(eq(bookings.userId, userId), sql`${events.status} in ('open','closed')`)).orderBy(desc(events.startsAt)).limit(1);
}

export async function notifyMoved(userId: number, actorId: number, e: SeatEvent, seat: string | null) {
  await services.notify(userId, 'lan-seating', actorId, seat ? `An organiser assigned you seat ${seat} at ${e.name}.` : `An organiser removed your seat at ${e.name}.`, `/m/lan-seating/${e.slug}`);
}
