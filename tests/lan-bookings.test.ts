/** LAN event bookings: booking types, interest, seat rules through lan-seating, and the announcement thread panel. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, makeForum, client } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { setModuleEnabled, exposedApi } from '../src/modules/runtime.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { events as seatEvents, book as bookSeat, bookingsFor as seatBookings } from '../modules/lan-seating/service.ts';
import {
  parseSeatSpec, setUp, typesFor, types, configs, bookPlace, registerInterest, cancel, counts, bookingOf, signupsByDay, type SeatingApi,
} from '../modules/lan-bookings/service.ts';

const LAYOUT = 'SSSS\nSSSS\nSSXV';
let seating: SeatingApi;
let n = 0;
async function newEvent(over: Partial<typeof seatEvents.$inferInsert> = {}) {
  const [e] = await getDb().insert(seatEvents).values({ slug: `lb-${++n}`, name: `LAN ${n}`, layout: LAYOUT, status: 'open', startsAt: new Date(Date.now() + 7 * 86_400_000), ...over }).returning();
  await setUp(e.id);
  await getDb().update(configs).set({ status: 'open' }).where(eq(configs.eventId, e.id));
  return e;
}

beforeAll(async () => {
  await setupDb();
  for (const id of ['lan-seating', 'lan-intranet', 'lan-bookings', 'lan-event-access']) await setModuleEnabled(id, true);
  seating = exposedApi<SeatingApi>('lan-seating')!;
});
afterAll(teardownDb);

describe('audit log labels for module actions', () => {
  it('names module actions after the module', async () => {
    const { auditLabel } = await import('../src/web/log-labels.ts');
    expect(auditLabel('lan-event-access.approve')).toBe('LAN Event Access: Approve');
    expect(auditLabel('lan-bookings.crew.add')).toBe('LAN event bookings: Crew add');
    expect(auditLabel('user.suspend')).toBe('Suspended a member');
  });
});

describe('seat lists for booking types', () => {
  const codes = new Map(Object.entries({ A1: 'seat', A2: 'seat', A3: 'seat', B1: 'seat', B2: 'seat', C1: 'seat', C2: 'blocked', C3: 'reserved' }));
  it('understands seats, ranges and rows, and reports mistakes', () => {
    expect([...parseSeatSpec('A1-A2, C', codes).seats]).toEqual(['A1', 'A2', 'C1', 'C3']); // blocked C2 is skipped
    expect([...parseSeatSpec('a2-3 b1', codes).seats]).toEqual(['A2', 'A3', 'B1']);
    expect([...parseSeatSpec('A-B', codes).seats].sort()).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
    expect(parseSeatSpec('A1-B2', codes).errors[0]).toMatch(/one row/);
    expect(parseSeatSpec('Z9', codes).errors[0]).toMatch(/doesn’t match/);
    expect(parseSeatSpec('A1?', codes).errors[0]).toMatch(/isn’t a seat/);
  });
});

describe('bookings', () => {
  it('sets up default types and enforces capacity, terms and one booking per member', async () => {
    const e = await newEvent();
    const [standard, fast] = await typesFor(e.id);
    expect(standard.name).toBe('Standard seat');
    expect(fast.capacity).toBe(8);
    await getDb().update(types).set({ capacity: 1 }).where(eq(types.id, fast.id));
    const a = await makeUser(), b = await makeUser();
    await expect(bookPlace(seating, e.id, a.id, fast.id, '')).rejects.toThrow(/agree to the event rules/);
    await bookPlace(seating, e.id, a.id, fast.id, '', { acceptedTerms: true });
    expect((await bookingOf(e.id, a.id))!.termsAcceptedAt).toBeInstanceOf(Date);
    await expect(bookPlace(seating, e.id, b.id, fast.id, '', { acceptedTerms: true })).rejects.toThrow(/fully booked/);
    // the full type can still collect interest, and organisers can confirm past the limit
    await registerInterest(e.id, b.id, fast.id, '');
    await expect(registerInterest(e.id, a.id, null, '')).rejects.toThrow(/already booked/);
    await bookPlace(seating, e.id, b.id, fast.id, '', { asOrganiser: true });
    const k = await counts(e.id);
    expect(k.perType.find((t) => t.type.id === fast.id)).toMatchObject({ booked: 2, left: 0 });
    expect(signupsByDay(k.list).at(-1)!.booked).toBe(2);
  });

  it('never oversells the last place under concurrency', async () => {
    const e = await newEvent();
    const [, fast] = await typesFor(e.id);
    await getDb().update(types).set({ capacity: 1 }).where(eq(types.id, fast.id));
    const a = await makeUser(), b = await makeUser();
    const r = await Promise.allSettled([bookPlace(seating, e.id, a.id, fast.id, '', { acceptedTerms: true }), bookPlace(seating, e.id, b.id, fast.id, '', { acceptedTerms: true })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('ties booking types to seats on the map', async () => {
    const e = await newEvent();
    const [standard, fast] = await typesFor(e.id);
    await getDb().update(types).set({ seats: 'A' }).where(eq(types.id, fast.id)); // row A is the 10GbE row
    const ev = (await getDb().select().from(seatEvents).where(eq(seatEvents.id, e.id)))[0];
    const u = await makeUser();
    // no booking yet: seats need a place first
    await expect(bookSeat(ev, u.id, 'B1')).rejects.toThrow(/Book a place/);
    await bookPlace(seating, e.id, u.id, standard.id, '', { acceptedTerms: true });
    await expect(bookSeat(ev, u.id, 'A1')).rejects.toThrow(/for High-speed network seat bookings/);
    await bookSeat(ev, u.id, 'B1');
    // upgrading to the high-speed type releases the standard seat and tells the member
    await bookPlace(seating, e.id, u.id, fast.id, '', { acceptedTerms: true });
    expect((await seatBookings(e.id)).some((b) => b.userId === u.id)).toBe(false);
    const note = await getDb().select().from(schema.notifications).where(and(eq(schema.notifications.userId, u.id), eq(schema.notifications.kind, 'lan-bookings')));
    expect(note.length).toBe(1);
    await bookSeat(ev, u.id, 'A2');
    // cancelling the booking frees the seat
    await cancel(seating, e.id, u.id);
    expect((await seatBookings(e.id)).some((b) => b.userId === u.id)).toBe(false);
  });
});

describe('announcement thread over HTTP', () => {
  it('posts a sticky thread with a live panel that members can reply to and moderators control', async () => {
    resetLimits();
    const e = await newEvent({ name: 'Frag Night 99', location: 'Town hall' });
    const forum = await makeForum('LAN events');
    await makeUser({ username: 'LanBoss', group: 'admin' });
    const crewMate = await makeUser({ username: 'DeskHelper' });
    const mod = await makeUser({ username: 'LanMod', group: 'moderator' });
    const fan = await makeUser({ username: 'LanFan' });
    void mod;
    await getDb().execute(sql`insert into mod_lan_intranet_schedule (title, starts_at, location) values ('Rocket league cup', ${new Date(e.startsAt!.getTime() + 3 * 3600_000)}, 'Stage'), ('Last year''s party', ${new Date(Date.now() - 300 * 86_400_000)}, '')`);
    await getDb().execute(sql`insert into mod_lan_intranet_servers (name, game, host, port, kind, notes) values ('Arena #1', 'Arena shooter', '127.0.0.1', 1, 'none', '5v5')`);

    const boss = client(); await boss.login('LanBoss');
    const admin = await boss.get(`/admin/m/lan-bookings/events/${e.id}`);
    expect(admin.status).toBe(200);
    expect(admin.text).toContain('Announce in the forums');
    expect((await boss.post(`/admin/m/lan-bookings/events/${e.id}/crew`, { username: 'DeskHelper', role: 'Volunteer', note: 'front desk' })).status).toBe(302);
    await boss.post(`/admin/m/lan-bookings/events/${e.id}/crew`, { username: 'LanMod', role: 'other', customRole: 'Tournament ref' });

    // a member books (and agrees to the terms) before the thread goes up
    const fanC = client(); await fanC.login('LanFan');
    const [standard] = await typesFor(e.id);
    expect((await fanC.post(`/m/lan-bookings/${e.slug}/book`, { typeId: String(standard.id), terms: '1' })).status).toBe(302);
    const ev = (await getDb().select().from(seatEvents).where(eq(seatEvents.id, e.id)))[0];
    await bookSeat(ev, fan.id, 'B3');

    const posted = await boss.post(`/admin/m/lan-bookings/events/${e.id}/announce`, {
      forumId: String(forum.id), title: 'Bookings open: Frag Night 99', body: 'Come along! [url=/m/lan-bookings/x]Book[/url]', action: 'post',
      sections: ['rules', 'crew', 'bookings', 'schedule', 'servers', 'seatmap'],
    });
    expect(posted.location).toMatch(/^\/t\/\d+-/);
    const threadId = Number(/^\/t\/(\d+)/.exec(posted.location!)![1]);
    const [t] = await getDb().select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(t.isSticky).toBe(true);
    expect(t.isLocked).toBe(false);

    const view = (await fanC.get(posted.location!)).text;
    expect(view).toContain('Bookings: Frag Night 99');
    expect(view).toContain('Event rules and terms');
    expect(view).toContain('Volunteer');
    expect(view).toContain('DeskHelper');
    expect(view).toContain('Tournament ref');
    expect(view).toMatch(/LanFan<\/a>.*B3/s);           // who booked, with their seat
    expect(view).toContain('Rocket league cup');           // sub-event during the LAN
    expect(view).not.toContain('Last year');               // …but not old ones
    expect(view).toContain('Arena #1');                     // planned server
    expect(view).toContain('seatmap-embed');                // read-only seat map
    expect(view).toContain('View your booking');

    // members can still reply
    expect((await fanC.post(`/t/${threadId}/reply`, { body: 'Can’t wait!' })).status).toBe(302);
    const [{ c: replies }] = await getDb().select({ c: sql<number>`count(*)::int` }).from(schema.posts).where(eq(schema.posts.threadId, threadId));
    expect(replies).toBe(2);

    // moderators control it with the normal tools
    const modC = client(); await modC.login('LanMod');
    await modC.post(`/t/${threadId}/moderate`, { action: 'lock' });
    expect((await getDb().select().from(schema.threads).where(eq(schema.threads.id, threadId)))[0].isLocked).toBe(true);

    // the posting admin chooses the panel sections
    await boss.post(`/admin/m/lan-bookings/events/${e.id}/announce`, { action: 'panel', sections: ['bookings'] });
    const trimmed = (await fanC.get(posted.location!)).text;
    expect(trimmed).not.toContain('Event rules and terms');
    expect(trimmed).not.toContain('Tournament ref');
    expect(trimmed).toContain('LanFan');
    void crewMate;
  });

  it('keeps the organiser tools and thread posting away from members', async () => {
    const e = await newEvent();
    const forum = await makeForum('Members only');
    await makeUser({ username: 'JustAMember' });
    const m = client(); await m.login('JustAMember');
    expect((await m.get(`/admin/m/lan-bookings/events/${e.id}`)).status).toBe(403);
    await m.post(`/admin/m/lan-bookings/events/${e.id}/announce`, { forumId: String(forum.id), title: 'Fake bookings thread', body: 'x', action: 'post' });
    const [{ c: threads }] = await getDb().select({ c: sql<number>`count(*)::int` }).from(schema.threads).where(eq(schema.threads.forumId, forum.id));
    expect(threads).toBe(0);
    // the public page works for guests
    expect((await client().get(`/m/lan-bookings/${e.slug}`)).status).toBe(200);
  });
});

describe('door desk (lan-event-access)', () => {
  it('lists booked members, charges their booking price and marks them as arrived', async () => {
    resetLimits();
    const { saveModuleSettings } = await import('../src/modules/runtime.ts');
    const { resetDemo } = await import('../modules/lan-event-access/backends.ts');
    const { attendees } = await import('../modules/lan-event-access/service.ts');
    resetDemo();
    await saveModuleSettings('lan-event-access', { backend: 'demo', entryFee: '15.00' });
    // make this the event at the door: the soonest one that hasn't ended
    const e = await newEvent({ name: 'Door Night', startsAt: new Date(Date.now() + 3600_000) });
    const [, fast] = await typesFor(e.id);
    const guest = await makeUser({ username: 'DoorGuest' });
    await bookPlace(seating, e.id, guest.id, fast.id, '', { acceptedTerms: true });
    await makeUser({ username: 'DoorBoss', group: 'admin' });
    const boss = client(); await boss.login('DoorBoss');

    const desk = await boss.get('/admin/m/lan-event-access/desk');
    expect(desk.text).toContain('Booked for Door Night');
    expect(desk.text).toMatch(/DoorGuest[\s\S]*High-speed network seat[\s\S]*Not arrived/);
    const mac = decodeURIComponent(/approve\?mac=([0-9a-fA-F%]+)/.exec(desk.text)![1]);
    const form = await boss.get(`/admin/m/lan-event-access/desk/approve?mac=${encodeURIComponent(mac)}`);
    expect(form.text).toContain(`value="booking:${guest.id}"`);
    expect(form.text).toContain('data-price="30.00"');

    // empty amount: the booking price is charged, and the member is linked
    await boss.post('/admin/m/lan-event-access/desk/approve', { mac, attendee: `booking:${guest.id}`, amount: '', method: 'cash', paid: '1' });
    const [a] = await getDb().select().from(attendees).where(eq(attendees.userId, guest.id));
    expect(a).toMatchObject({ name: 'DoorGuest', amountCents: 3000, method: 'cash' });
    expect(a.note).toMatch(/Booked: High-speed network seat/);
    const after = await boss.get('/admin/m/lan-event-access/desk');
    expect(after.text).toMatch(/DoorGuest[\s\S]*Paid £30\.00 · 1 device/);
    expect(after.text).toContain('1 / 1');

    // paying twice is refused; their next device goes under "Already paid"
    const mac2 = decodeURIComponent(/approve\?mac=([0-9a-fA-F%]+)/.exec(after.text)![1]);
    await boss.post('/admin/m/lan-event-access/desk/approve', { mac: mac2, attendee: 'new', name: 'Again', username: 'DoorGuest', amount: '30', method: 'cash', paid: '1' });
    expect(await getDb().select().from(attendees).where(eq(attendees.userId, guest.id))).toHaveLength(1);
  });
});
