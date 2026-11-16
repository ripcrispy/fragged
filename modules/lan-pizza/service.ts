import { database, services, pg, eq, and, asc, desc, inArray, sql, ServiceError } from '../../src/sdk/index.ts';

export const rounds = pg.pgTable('mod_lan_pizza_rounds', {
  id: pg.serial('id').primaryKey(),
  name: pg.varchar('name', { length: 120 }).notNull(),
  status: pg.varchar('status', { length: 12 }).notNull().default('draft'),
  closesAt: pg.timestamp('closes_at', { withTimezone: true }),
  notes: pg.text('notes').notNull().default(''),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const menu = pg.pgTable('mod_lan_pizza_menu', {
  id: pg.serial('id').primaryKey(),
  name: pg.varchar('name', { length: 80 }).notNull(),
  description: pg.varchar('description', { length: 200 }).notNull().default(''),
  category: pg.varchar('category', { length: 16 }).notNull().default('pizza'),
  priceCents: pg.integer('price_cents').notNull(),
  vegetarian: pg.boolean('vegetarian').notNull().default(false),
  vegan: pg.boolean('vegan').notNull().default(false),
  enabled: pg.boolean('enabled').notNull().default(true),
  displayOrder: pg.integer('display_order').notNull().default(0),
});
export const orders = pg.pgTable('mod_lan_pizza_orders', {
  id: pg.serial('id').primaryKey(),
  roundId: pg.integer('round_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  notes: pg.varchar('notes', { length: 300 }).notNull().default(''),
  totalCents: pg.integer('total_cents').notNull(),
  paid: pg.boolean('paid').notNull().default(false),
  paidAt: pg.timestamp('paid_at', { withTimezone: true }),
  paidBy: pg.integer('paid_by'),
  handedOut: pg.boolean('handed_out').notNull().default(false),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const items = pg.pgTable('mod_lan_pizza_items', {
  id: pg.serial('id').primaryKey(),
  orderId: pg.integer('order_id').notNull(),
  menuId: pg.integer('menu_id'),
  name: pg.varchar('name', { length: 80 }).notNull(),
  priceCents: pg.integer('price_cents').notNull(),
  qty: pg.integer('qty').notNull(),
});
export type Round = typeof rounds.$inferSelect;
export type MenuItem = typeof menu.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Item = typeof items.$inferSelect;

export const STATUSES = {
  draft: 'Draft (only organisers can see it)',
  open: 'Taking orders',
  closed: 'Orders closed — collecting cash',
  ordered: 'Ordered — on its way',
  delivered: 'Delivered',
} as const;
export type Status = keyof typeof STATUSES;
export const CATEGORIES: Record<string, string> = { pizza: 'Pizzas', side: 'Sides', drink: 'Drinks', dessert: 'Desserts' };
export const LIMITS = { maxQtyPerItem: 10, maxLines: 20, ordersPerHour: 30 };

const DEFAULT_MENU: { name: string; description: string; category: string; price: number; veg?: boolean; vegan?: boolean }[] = [
  { name: 'Margherita', description: 'Tomato, mozzarella, basil', category: 'pizza', price: 1100, veg: true },
  { name: 'Pepperoni', description: 'Tomato, mozzarella, pepperoni', category: 'pizza', price: 1300 },
  { name: 'Meat feast', description: 'Pepperoni, ham, sausage, beef', category: 'pizza', price: 1450 },
  { name: 'BBQ chicken', description: 'BBQ base, chicken, red onion, peppers', category: 'pizza', price: 1400 },
  { name: 'Ham & pineapple', description: 'The eternal debate', category: 'pizza', price: 1300 },
  { name: 'Veggie supreme', description: 'Peppers, onion, mushroom, olives, sweetcorn', category: 'pizza', price: 1300, veg: true },
  { name: 'Vegan garden', description: 'Vegan cheese, peppers, spinach, tomato', category: 'pizza', price: 1350, veg: true, vegan: true },
  { name: 'Garlic bread', description: '', category: 'side', price: 450, veg: true },
  { name: 'Fries', description: '', category: 'side', price: 350, veg: true, vegan: true },
  { name: 'Chicken wings (8)', description: '', category: 'side', price: 650 },
  { name: 'Can of soft drink', description: '', category: 'drink', price: 150, veg: true, vegan: true },
  { name: 'Bottle of water', description: '', category: 'drink', price: 100, veg: true, vegan: true },
  { name: 'Cookie dough dessert', description: '', category: 'dessert', price: 500, veg: true },
];

const db = () => database.db();

export async function seedMenu() {
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(menu);
  if (n > 0) return 0;
  await db().insert(menu).values(DEFAULT_MENU.map((m, i) => ({ name: m.name, description: m.description, category: m.category, priceCents: m.price, vegetarian: !!m.veg, vegan: !!m.vegan, displayOrder: i * 10 })));
  return DEFAULT_MENU.length;
}

export const listMenu = (all = false) => db().select().from(menu).where(all ? undefined : eq(menu.enabled, true)).orderBy(asc(menu.displayOrder), asc(menu.id));
export async function listRounds(includeDrafts: boolean) {
  const all = await db().select().from(rounds).orderBy(desc(rounds.createdAt), desc(rounds.id));
  return includeDrafts ? all : all.filter((r) => r.status !== 'draft');
}
export async function roundById(id: number) { return (await db().select().from(rounds).where(eq(rounds.id, id)))[0] ?? null; }

/** Why a member can't place or change an order right now (null when they can). */
export function closedReason(r: Round, now = new Date()): string | null {
  if (r.status === 'draft') return 'This pizza run isn’t open yet.';
  if (r.status !== 'open') return 'Orders are closed for this pizza run.';
  if (r.closesAt && now >= r.closesAt) return 'Orders closed at the deadline.';
  return null;
}

/** Human status: an "open" run whose deadline has passed reads as closed (organisers still move it on by hand). */
export function statusLabel(r: Round, now = new Date()): string {
  if (r.status === 'open' && r.closesAt && now >= r.closesAt) return 'Deadline passed — orders closed';
  return STATUSES[r.status as Status] ?? r.status;
}
export const isTakingOrders = (r: Round, now = new Date()) => !closedReason(r, now);

/** Parse a money amount typed by an organiser ("12", "12.5", "12.50", "12,50") into cents. */
export function parseMoney(raw: string): number | null {
  const m = /^\s*(\d{1,4})(?:[.,](\d{1,2}))?\s*$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
export const formatMoney = (cents: number, symbol: string) => `${symbol}${(cents / 100).toFixed(2)}`;

export async function orderOf(roundId: number, userId: number) {
  const [o] = await db().select().from(orders).where(and(eq(orders.roundId, roundId), eq(orders.userId, userId)));
  if (!o) return null;
  return { ...o, items: await db().select().from(items).where(eq(items.orderId, o.id)).orderBy(asc(items.id)) };
}

/** Place or replace a member's order for a round. Paid orders are locked: an organiser has to undo the payment first. */
export async function placeOrder(r: Round, userId: number, lines: { menuId: number; qty: number }[], notes: string, now = new Date()) {
  const closed = closedReason(r, now);
  if (closed) throw new ServiceError(closed, 403, 'orders_closed');
  const wanted = new Map<number, number>();
  for (const l of lines) {
    const q = Math.trunc(l.qty);
    if (!Number.isFinite(q) || q < 0 || q > LIMITS.maxQtyPerItem) throw new ServiceError(`Quantities must be between 0 and ${LIMITS.maxQtyPerItem}.`);
    if (q > 0) wanted.set(l.menuId, (wanted.get(l.menuId) ?? 0) + q);
  }
  if (!wanted.size) throw new ServiceError('Pick at least one item.');
  if (wanted.size > LIMITS.maxLines) throw new ServiceError('That’s a lot of different items — keep it under 20.');
  const menuRows = await db().select().from(menu).where(and(inArray(menu.id, [...wanted.keys()]), eq(menu.enabled, true)));
  if (menuRows.length !== wanted.size) throw new ServiceError('Something on your order is no longer on the menu — please check it again.');
  const existing = await orderOf(r.id, userId);
  if (existing?.paid) throw new ServiceError('Your order is already paid for. Ask an organiser if you need to change it.', 409, 'order_paid');
  const rl = await services.rateLimit(`pizza:order:${userId}`, { max: LIMITS.ordersPerHour, windowSec: 3600 });
  if (!rl.ok) throw new ServiceError('You’ve changed your order a lot — try again in a bit.', 429, 'rate_limited');
  const priced = menuRows.map((m) => ({ menuId: m.id, name: m.name, priceCents: m.priceCents, qty: wanted.get(m.id)! }));
  const total = priced.reduce((a, l) => a + l.priceCents * l.qty, 0);
  await db().transaction(async (tx) => {
    const [o] = await tx.insert(orders).values({ roundId: r.id, userId, notes: notes.slice(0, 300), totalCents: total })
      .onConflictDoUpdate({ target: [orders.roundId, orders.userId], set: { notes: notes.slice(0, 300), totalCents: total, updatedAt: new Date() }, where: sql`${orders.paid} = false` })
      .returning();
    // a concurrent payment between the check above and here leaves the paid order untouched
    if (!o) throw new ServiceError('Your order is already paid for. Ask an organiser if you need to change it.', 409, 'order_paid');
    await tx.delete(items).where(eq(items.orderId, o.id));
    await tx.insert(items).values(priced.map((l) => ({ orderId: o.id, ...l })));
  });
  return { total, lines: priced };
}

export async function cancelOrder(r: Round, userId: number) {
  const closed = closedReason(r);
  if (closed) throw new ServiceError(closed, 403, 'orders_closed');
  const o = await orderOf(r.id, userId);
  if (!o) return;
  if (o.paid) throw new ServiceError('Your order is already paid for. Ask an organiser to cancel it and refund you.', 409, 'order_paid');
  await db().delete(orders).where(and(eq(orders.id, o.id), eq(orders.paid, false)));
}

export async function ordersFor(roundId: number) {
  const os = await db().select().from(orders).where(eq(orders.roundId, roundId)).orderBy(asc(orders.createdAt));
  const its = os.length ? await db().select().from(items).where(inArray(items.orderId, os.map((o) => o.id))).orderBy(asc(items.id)) : [];
  return os.map((o) => ({ ...o, items: its.filter((i) => i.orderId === o.id) }));
}

/** What to ask the pizza place for: item counts, split into paid and not-yet-paid orders. */
export function kitchenSummary(list: Awaited<ReturnType<typeof ordersFor>>) {
  const by = new Map<string, { name: string; paid: number; unpaid: number }>();
  for (const o of list) for (const i of o.items) {
    const e = by.get(i.name) ?? { name: i.name, paid: 0, unpaid: 0 };
    if (o.paid) e.paid += i.qty; else e.unpaid += i.qty;
    by.set(i.name, e);
  }
  return [...by.values()].sort((a, b) => b.paid + b.unpaid - (a.paid + a.unpaid) || a.name.localeCompare(b.name));
}

export function moneySummary(list: Awaited<ReturnType<typeof ordersFor>>) {
  const collected = list.filter((o) => o.paid).reduce((a, o) => a + o.totalCents, 0);
  const outstanding = list.filter((o) => !o.paid).reduce((a, o) => a + o.totalCents, 0);
  return { orders: list.length, paidOrders: list.filter((o) => o.paid).length, collected, outstanding };
}

export async function setPaid(orderId: number, paid: boolean, by: number) {
  const [o] = await db().update(orders).set({ paid, paidAt: paid ? new Date() : null, paidBy: paid ? by : null, updatedAt: new Date() }).where(eq(orders.id, orderId)).returning();
  if (!o) throw new ServiceError('Order not found.', 404);
  return o;
}
export async function setHandedOut(orderId: number, handedOut: boolean) {
  const [o] = await db().update(orders).set({ handedOut, updatedAt: new Date() }).where(eq(orders.id, orderId)).returning();
  if (!o) throw new ServiceError('Order not found.', 404);
  return o;
}
export async function removeOrder(orderId: number) {
  const [o] = await db().delete(orders).where(eq(orders.id, orderId)).returning();
  if (!o) throw new ServiceError('Order not found.', 404);
  return o;
}

/** The newest round that isn't a draft or finished, for other modules (e.g. the LAN intranet). */
export async function currentSummary() {
  const [r] = await db().select().from(rounds).where(sql`${rounds.status} in ('open','closed','ordered')`).orderBy(desc(rounds.createdAt)).limit(1);
  if (!r) return null;
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.roundId, r.id));
  return { name: r.name, status: r.status as Status, statusLabel: statusLabel(r), closesAt: r.closesAt, orders: n, accepting: !closedReason(r), url: '/m/lan-pizza' };
}

/** Account closed: drop unpaid orders; paid ones stay (cash was handed over) but are no longer linked to visible identity. */
export async function forgetUser(userId: number) {
  await db().delete(orders).where(and(eq(orders.userId, userId), eq(orders.paid, false)));
}
