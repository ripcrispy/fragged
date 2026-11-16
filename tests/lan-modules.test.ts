/** The bundled LAN-party modules: seat booking, intranet (server probes) and caffeine tracker. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { setupDb, teardownDb, makeUser, client } from './helpers.ts';
import { getDb } from '../src/db/client.ts';
import { setModuleEnabled } from '../src/modules/runtime.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { parseLayout, capacity, rowLabel } from '../modules/lan-seating/layout.ts';
import { events, book, release, bookingsFor } from '../modules/lan-seating/service.ts';
import { parseA2SInfo, parseMinecraftStatus, probe } from '../modules/lan-intranet/probes.ts';
import { mgAt, levelFor, LEVELS } from '../modules/caffeine-tracker/model.ts';
import { listDrinks, logDrink, leaderboard, setHidden, currentFor } from '../modules/caffeine-tracker/service.ts';
import { rounds as pizzaRounds, listMenu, placeOrder, cancelOrder, orderOf, ordersFor, setPaid, kitchenSummary, moneySummary, parseMoney, menu as pizzaMenu } from '../modules/lan-pizza/service.ts';
import { eq, and } from 'drizzle-orm';
import { schema } from '../src/db/client.ts';

beforeAll(async () => {
  await setupDb();
  for (const id of ['lan-seating', 'caffeine-tracker', 'lan-pizza', 'lan-intranet']) await setModuleEnabled(id, true);
});
afterAll(teardownDb);

describe('lan-seating', () => {
  it('parses seat maps with stable codes and reports mistakes', () => {
    const l = parseLayout('####\nSS.S\nVX.S\n');
    expect([...l.seats.keys()]).toEqual(['B1', 'B2', 'B3', 'C1', 'C2', 'C3']);
    expect(l.seats.get('C1')).toBe('reserved');
    expect(l.seats.get('C2')).toBe('blocked');
    expect(capacity(l)).toBe(5);
    expect(l.errors).toEqual([]);
    expect(parseLayout('SSQ').errors[0]).toMatch(/Unknown character "Q"/);
    expect(parseLayout('....\n####').errors[0]).toMatch(/no seats/);
    expect(rowLabel(0)).toBe('A'); expect(rowLabel(25)).toBe('Z'); expect(rowLabel(26)).toBe('AA');
  });

  it('allows one seat per member and never double-books a seat', async () => {
    const [e] = await getDb().insert(events).values({ slug: 'lan-1', name: 'LAN One', layout: 'SSS\nVXS', status: 'open' }).returning();
    const a = await makeUser(), b = await makeUser(), c = await makeUser();
    await book(e, a.id, 'A1');
    await book(e, a.id, 'A2'); // moving frees A1
    expect((await bookingsFor(e.id)).map((x) => x.seat)).toEqual(['A2']);
    await expect(book(e, b.id, 'A2')).rejects.toThrow(/just taken/);
    await expect(book(e, b.id, 'B1')).rejects.toThrow(/reserved/);
    await expect(book(e, b.id, 'B2')).rejects.toThrow(/isn’t available/);
    await expect(book(e, b.id, 'Z9')).rejects.toThrow(/doesn’t exist/);
    // concurrent attempts at the same seat: exactly one wins
    const results = await Promise.allSettled([book(e, b.id, 'A3'), book(e, c.id, 'A3')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // organisers may assign reserved seats
    await book(e, c.id, 'B1', { asOrganiser: true, assignedBy: a.id });
    await release(e, a.id);
    expect((await bookingsFor(e.id)).map((x) => x.seat).sort()).toEqual(['A3', 'B1']);
  });

  it('respects draft/closed status over HTTP', async () => {
    await getDb().insert(events).values({ slug: 'secret-lan', name: 'Secret', layout: 'SS', status: 'draft' });
    await getDb().insert(events).values({ slug: 'closed-lan', name: 'Closed', layout: 'SS', status: 'closed' });
    await makeUser({ username: 'SeatMember' });
    const cl = client(); await cl.login('SeatMember');
    expect((await cl.get('/m/lan-seating')).status).toBe(200);
    expect((await cl.get('/m/lan-seating/secret-lan')).status).toBe(404);
    const page = await cl.get('/m/lan-seating/closed-lan');
    expect(page.status).toBe(200);
    await cl.post('/m/lan-seating/closed-lan/book', { seat: 'A1' });
    expect((await cl.get('/m/lan-seating/closed-lan')).text).toMatch(/Booking is closed/);
  });

  it('disappears entirely when disabled', async () => {
    const cl = client();
    await setModuleEnabled('lan-seating', false);
    expect((await cl.get('/m/lan-seating')).status).toBe(404);
    expect((await cl.get('/modules/lan-seating/seating.css')).status).toBe(404);
    await setModuleEnabled('lan-seating', true);
    expect((await cl.get('/m/lan-seating')).status).toBe(200);
  });
});

describe('lan-intranet probes', () => {
  const a2s = () => {
    const s = (t: string) => Buffer.from(t + '\0', 'utf8');
    return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), s('Frag Night #1'), s('de_test'), s('cstrike'), s('Counter-Strike'), Buffer.from([0x0a, 0x00, 7, 16, 0])]);
  };
  const mc = (obj: unknown) => {
    const json = Buffer.from(JSON.stringify(obj));
    const vi = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
    const body = Buffer.concat([vi(0), vi(json.length), json]);
    return Buffer.concat([vi(body.length), body]);
  };

  it('parses Source A2S_INFO replies and rejects junk', () => {
    expect(parseA2SInfo(a2s())).toMatchObject({ name: 'Frag Night #1', map: 'de_test', players: 7, maxPlayers: 16 });
    expect(parseA2SInfo(Buffer.from('hello world'))).toBeNull();
    expect(parseA2SInfo(a2s().subarray(0, 12))).toBeNull();
  });

  it('parses Minecraft status, stripping formatting codes', () => {
    expect(parseMinecraftStatus(mc({ version: { name: '1.21' }, players: { online: 3, max: 20 }, description: { text: '§aBlock §lparty' } })))
      .toMatchObject({ players: 3, maxPlayers: 20, version: '1.21', name: 'Block party' });
    expect(parseMinecraftStatus(mc({ version: { name: '1.21' } }).subarray(0, 8))).toBeNull();
  });

  it('probes TCP and UDP servers with timeouts, never throwing', async () => {
    const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await probe('tcp', '127.0.0.1', port)).toMatchObject({ online: true });
    srv.close();
    expect((await probe('tcp', '127.0.0.1', port)).online).toBe(false);

    const udp = dgram.createSocket('udp4');
    let challenged = false;
    udp.on('message', (msg, rinfo) => {
      // first answer with a challenge, then with the info once it is echoed back
      if (!challenged) { challenged = true; udp.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]), rinfo.port, rinfo.address); return; }
      expect(msg.subarray(-4)).toEqual(Buffer.from([1, 2, 3, 4]));
      udp.send(a2s(), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    const st = await probe('source', '127.0.0.1', udp.address().port);
    udp.close();
    expect(st).toMatchObject({ online: true, players: 7, map: 'de_test' });
  }, 10_000);

  it('renders the intranet page with widgets from the other LAN modules', async () => {
    const r = await client().get('/m/lan-intranet');
    expect(r.status).toBe(200);
    expect(r.text).toContain('LAN Party HQ');
    expect(r.text).toContain('Most caffeinated right now');
  });
});

describe('caffeine-tracker', () => {
  const o = { halfLifeHours: 5, absorptionMinutes: 30 };
  it('models absorption and half-life decay', () => {
    const t = new Date('2026-01-01T12:00:00Z');
    const dose = [{ mg: 200, at: t }];
    expect(mgAt(dose, t, o)).toBe(0);
    expect(mgAt(dose, new Date(t.getTime() + 15 * 60_000), o)).toBeGreaterThan(90);
    expect(mgAt(dose, new Date(t.getTime() + 15 * 60_000), o)).toBeLessThan(101);
    const after5h = mgAt(dose, new Date(t.getTime() + (5 * 60 + 15) * 60_000), o);
    expect(after5h).toBeCloseTo(100, 0); // one half-life after the absorption midpoint
    expect(mgAt(dose, new Date(t.getTime() - 60_000), o)).toBe(0); // future doses don't count
  });

  it('has playful, ordered levels', () => {
    expect(LEVELS.map((l) => l.min)).toEqual([...LEVELS.map((l) => l.min)].sort((a, b) => a - b));
    expect(levelFor(0).name).toBe('Decaf Ghost');
    expect(levelFor(450).name).toBe('DANGEROUS');
    expect(levelFor(900).name).toBe('GO TO HOSPITAL');
  });

  it('seeds a catalogue with real-world caffeine values', async () => {
    const list = await listDrinks();
    expect(list.length).toBeGreaterThan(20);
    expect(list.find((d) => d.name === 'Espresso (single shot)')?.caffeineMg).toBe(63);
    expect(list.find((d) => d.name === 'Red Bull')?.caffeineMg).toBe(80);
  });

  it('logs drinks with limits and ranks members, honouring opt-out', async () => {
    resetLimits();
    const list = await listDrinks();
    const espresso = list.find((d) => d.name.startsWith('Espresso (double'))!;
    const a = await makeUser({ username: 'CafA' }), b = await makeUser({ username: 'CafB' }), h = await makeUser({ username: 'CafHidden' });
    await logDrink(a.id, { drinkId: espresso.id, servings: 3, minutesAgo: 60 });
    await logDrink(b.id, { drinkId: espresso.id, servings: 1, minutesAgo: 60 });
    await logDrink(h.id, { drinkId: espresso.id, servings: 5, minutesAgo: 60 });
    await setHidden(h.id, true);
    await expect(logDrink(a.id, { drinkId: espresso.id, servings: 9, minutesAgo: 0 })).rejects.toThrow(/Servings/);
    await expect(logDrink(a.id, { drinkId: espresso.id, servings: 1, minutesAgo: 60 * 30 })).rejects.toThrow(/24 hours/);
    await expect(logDrink(a.id, { drinkId: 'custom', servings: 1, minutesAgo: 0, customName: 'Mystery', customMg: 5000 })).rejects.toThrow(/between 1 and 500/);
    await logDrink(a.id, { drinkId: 'custom', servings: 1, minutesAgo: 0, customName: 'Local brew', customMg: 120 });

    const now = await leaderboard('now', 10, o);
    expect(now.map((r) => r.username)).toEqual(['CafA', 'CafB']);
    expect(now[0].level.tone).not.toBe('calm');
    const day = await leaderboard('day', 10, o);
    expect(day[0]).toMatchObject({ username: 'CafA', mg: 126 * 3 + 120, drinks: 2 });
    expect((await currentFor(h.id, o)).mg).toBeGreaterThan(400);
  });

  it('rate-limits logging', async () => {
    resetLimits();
    const u = await makeUser();
    const [d] = await listDrinks();
    for (let i = 0; i < 20; i++) await logDrink(u.id, { drinkId: d.id, servings: 0.5, minutesAgo: 0 });
    await expect(logDrink(u.id, { drinkId: d.id, servings: 0.5, minutesAgo: 0 })).rejects.toThrow(/Easy there/);
  });

  it('works over HTTP: log, see it, remove it', async () => {
    resetLimits();
    await makeUser({ username: 'CafHttp' });
    const cl = client(); await cl.login('CafHttp');
    const [d] = await listDrinks();
    const r = await cl.post('/m/caffeine-tracker/log', { drink: String(d.id), servings: '2', ago: '30' });
    expect(r.status).toBe(302);
    const page = await cl.get('/m/caffeine-tracker');
    expect(page.text).toContain('estimated in your system');
    expect(page.text).toMatch(/class="caf-chart"/);
    const id = /\/m\/caffeine-tracker\/log\/(\d+)\/delete/.exec(page.text)![1];
    // another member can't delete it
    await makeUser({ username: 'CafOther' });
    const other = client(); await other.login('CafOther');
    await other.post(`/m/caffeine-tracker/log/${id}/delete`);
    expect((await cl.get('/m/caffeine-tracker')).text).toContain(`/log/${id}/delete`);
    await cl.post(`/m/caffeine-tracker/log/${id}/delete`);
    expect((await cl.get('/m/caffeine-tracker')).text).not.toContain(`/log/${id}/delete`);
    // guests see boards but no form
    const g = await client().get('/m/caffeine-tracker');
    expect(g.status).toBe(200);
    expect(g.text).not.toContain('action="/m/caffeine-tracker/log"');
  });
});

describe('lan-pizza', () => {
  const newRound = async (over: Partial<typeof pizzaRounds.$inferInsert> = {}) =>
    (await getDb().insert(pizzaRounds).values({ name: 'Test run', status: 'open', ...over }).returning())[0];

  it('parses prices typed by organisers', () => {
    expect(parseMoney('12')).toBe(1200);
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('12,50')).toBe(1250);
    expect(parseMoney(' 0.99 ')).toBe(99);
    expect(parseMoney('12.505')).toBeNull();
    expect(parseMoney('-3')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });

  it('takes, replaces and validates orders with prices snapshotted from the menu', async () => {
    resetLimits();
    const r = await newRound();
    const m = await listMenu();
    const [marg, pep] = [m.find((x) => x.name === 'Margherita')!, m.find((x) => x.name === 'Pepperoni')!];
    const u = await makeUser();
    const first = await placeOrder(r, u.id, [{ menuId: marg.id, qty: 2 }, { menuId: pep.id, qty: 0 }], 'no basil');
    expect(first.total).toBe(marg.priceCents * 2);
    await placeOrder(r, u.id, [{ menuId: pep.id, qty: 1 }], '');
    const o = (await orderOf(r.id, u.id))!;
    expect(o.items.map((i) => [i.name, i.qty])).toEqual([['Pepperoni', 1]]);
    expect(o.totalCents).toBe(pep.priceCents);
    // later price change doesn't touch the placed order
    await getDb().update(pizzaMenu).set({ priceCents: 9999 }).where(eq(pizzaMenu.id, pep.id));
    expect((await orderOf(r.id, u.id))!.totalCents).toBe(pep.priceCents);
    await getDb().update(pizzaMenu).set({ priceCents: pep.priceCents }).where(eq(pizzaMenu.id, pep.id));

    await expect(placeOrder(r, u.id, [], '')).rejects.toThrow(/at least one/);
    await expect(placeOrder(r, u.id, [{ menuId: marg.id, qty: 11 }], '')).rejects.toThrow(/between 0 and 10/);
    await expect(placeOrder(r, u.id, [{ menuId: 999999, qty: 1 }], '')).rejects.toThrow(/no longer on the menu/);
    const closed = await newRound({ status: 'closed' });
    await expect(placeOrder(closed, u.id, [{ menuId: marg.id, qty: 1 }], '')).rejects.toThrow(/closed/);
    const late = await newRound({ closesAt: new Date(Date.now() - 60_000) });
    await expect(placeOrder(late, u.id, [{ menuId: marg.id, qty: 1 }], '')).rejects.toThrow(/deadline/);
  });

  it('locks paid orders and summarises cash and the shopping list', async () => {
    resetLimits();
    const r = await newRound();
    const m = await listMenu();
    const marg = m.find((x) => x.name === 'Margherita')!;
    const a = await makeUser(), b = await makeUser(), staff = await makeUser({ group: 'admin' });
    await placeOrder(r, a.id, [{ menuId: marg.id, qty: 2 }], '');
    await placeOrder(r, b.id, [{ menuId: marg.id, qty: 1 }], '');
    const oa = (await orderOf(r.id, a.id))!;
    await setPaid(oa.id, true, staff.id);
    await expect(placeOrder(r, a.id, [{ menuId: marg.id, qty: 5 }], '')).rejects.toThrow(/already paid/);
    await expect(cancelOrder(r, a.id)).rejects.toThrow(/already paid/);
    const list = await ordersFor(r.id);
    expect(moneySummary(list)).toEqual({ orders: 2, paidOrders: 1, collected: marg.priceCents * 2, outstanding: marg.priceCents });
    expect(kitchenSummary(list)).toEqual([{ name: 'Margherita', paid: 2, unpaid: 1 }]);
    await cancelOrder(r, b.id);
    expect(await orderOf(r.id, b.id)).toBeNull();
  });

  it('works over HTTP with the right permissions, and notifies when food arrives', async () => {
    resetLimits();
    const r = await newRound({ name: 'HTTP run' });
    const marg = (await listMenu()).find((x) => x.name === 'Margherita')!;
    await makeUser({ username: 'PizzaEater' }); await makeUser({ username: 'PizzaBoss', group: 'admin' });
    const eater = client(); await eater.login('PizzaEater');
    const page = await eater.get('/m/lan-pizza');
    expect(page.status).toBe(200);
    expect(page.text).toContain(`name="qty_${marg.id}"`);
    expect((await eater.post(`/m/lan-pizza/${r.id}/order`, { [`qty_${marg.id}`]: '3', notes: 'extra crispy' })).status).toBe(302);
    expect((await eater.get('/m/lan-pizza')).text).toMatch(/Not paid yet/);
    // members can't reach the organiser screens or tick their own payment
    expect((await eater.get(`/admin/m/lan-pizza/runs/${r.id}`)).status).toBe(403);
    const order = (await ordersFor(r.id))[0];
    await eater.post(`/admin/m/lan-pizza/orders/${order.id}/paid`, { paid: '1' });
    expect((await orderOf(r.id, order.userId))!.paid).toBe(false);

    const boss = client(); await boss.login('PizzaBoss');
    const admin = await boss.get(`/admin/m/lan-pizza/runs/${r.id}`);
    expect(admin.status).toBe(200);
    expect(admin.text).toContain('Shopping list');
    await boss.post(`/admin/m/lan-pizza/orders/${order.id}/paid`, { paid: '1' });
    expect((await orderOf(r.id, order.userId))!.paid).toBe(true);
    for (const status of ['closed', 'ordered', 'delivered']) await boss.post(`/admin/m/lan-pizza/runs/${r.id}/status`, { status });
    const notes = await getDb().select().from(schema.notifications).where(and(eq(schema.notifications.userId, order.userId), eq(schema.notifications.kind, 'lan-pizza')));
    expect(notes.length).toBeGreaterThanOrEqual(2); // payment received + food arrived

    // guests can look but not order
    const g = await client().get('/m/lan-pizza');
    expect(g.status).toBe(200);
    expect(g.text).not.toContain('name="qty_');
  });

  it('shows a pizza widget on the intranet', async () => {
    await newRound({ name: 'Widget run' });
    expect((await client().get('/m/lan-intranet')).text).toContain('Pizza run');
  });
});

describe('lan-pizza status labels', () => {
  it('reports an open run past its deadline as closed', async () => {
    const { statusLabel, isTakingOrders } = await import('../modules/lan-pizza/service.ts');
    const base = { id: 1, name: 'x', notes: '', createdAt: new Date() };
    const past = { ...base, status: 'open', closesAt: new Date(Date.now() - 1000) };
    const future = { ...base, status: 'open', closesAt: new Date(Date.now() + 3600_000) };
    expect(statusLabel(past)).toMatch(/Deadline passed/);
    expect(isTakingOrders(past)).toBe(false);
    expect(statusLabel(future)).toBe('Taking orders');
    expect(isTakingOrders(future)).toBe(true);
    expect(statusLabel({ ...base, status: 'delivered', closesAt: null })).toBe('Delivered');
  });
});
