import { database, services, pg, eq, and, gte, desc, asc, sql, ServiceError } from '../../src/sdk/index.ts';
import { mgAt, levelFor, DEFAULT_DRINKS, type ModelOptions, type Level } from './model.ts';

export const drinks = pg.pgTable('mod_caffeine_drinks', {
  id: pg.serial('id').primaryKey(),
  name: pg.varchar('name', { length: 80 }).notNull(),
  category: pg.varchar('category', { length: 24 }).notNull().default('other'),
  servingMl: pg.integer('serving_ml'),
  caffeineMg: pg.numeric('caffeine_mg', { precision: 6, scale: 1, mode: 'number' }).notNull(),
  enabled: pg.boolean('enabled').notNull().default(true),
  displayOrder: pg.integer('display_order').notNull().default(0),
});
export const logs = pg.pgTable('mod_caffeine_logs', {
  id: pg.serial('id').primaryKey(),
  userId: pg.integer('user_id').notNull(),
  drinkId: pg.integer('drink_id'),
  drinkName: pg.varchar('drink_name', { length: 80 }).notNull(),
  servings: pg.numeric('servings', { precision: 4, scale: 1, mode: 'number' }).notNull(),
  mg: pg.numeric('mg', { precision: 7, scale: 1, mode: 'number' }).notNull(),
  consumedAt: pg.timestamp('consumed_at', { withTimezone: true }).notNull(),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const prefs = pg.pgTable('mod_caffeine_prefs', {
  userId: pg.integer('user_id').primaryKey(),
  hidden: pg.boolean('hidden').notNull().default(false),
});
export type Drink = typeof drinks.$inferSelect;
export type LogRow = typeof logs.$inferSelect;

export const CATEGORIES: Record<string, string> = { coffee: 'Coffee', tea: 'Tea', mate: 'Mate', energy: 'Energy drinks', soda: 'Soft drinks', tablet: 'Tablets & powders', snack: 'Chocolate & snacks', other: 'Other' };
/** Look back this far when computing current levels (≈10 half-lives at 5 h — anything older is negligible). */
const LOOKBACK_MS = 48 * 3600_000;
export const LIMITS = { maxServings: 5, maxCustomMg: 500, maxPerLogMg: 1500, maxBackdateMin: 24 * 60, logsPerHour: 20 };

const db = () => database.db();

export async function seedDrinks() {
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(drinks);
  if (n > 0) return 0;
  await db().insert(drinks).values(DEFAULT_DRINKS.map((d, i) => ({ name: d.name, category: d.category, servingMl: d.servingMl, caffeineMg: d.mg, displayOrder: i * 10 }))).onConflictDoNothing();
  return DEFAULT_DRINKS.length;
}

export const listDrinks = (all = false) => db().select().from(drinks).where(all ? undefined : eq(drinks.enabled, true)).orderBy(asc(drinks.displayOrder), asc(drinks.name));

export interface LogInput { drinkId: number | 'custom'; servings: number; minutesAgo: number; customName?: string; customMg?: number }

export async function logDrink(userId: number, input: LogInput, now = new Date()) {
  const servings = Math.round(input.servings * 2) / 2;
  if (!(servings >= 0.5 && servings <= LIMITS.maxServings)) throw new ServiceError(`Servings must be between 0.5 and ${LIMITS.maxServings}.`);
  const minutesAgo = Math.trunc(input.minutesAgo);
  if (!(minutesAgo >= 0 && minutesAgo <= LIMITS.maxBackdateMin)) throw new ServiceError('You can only log drinks from the last 24 hours.');
  let name: string; let perServing: number; let drinkId: number | null = null;
  if (input.drinkId === 'custom') {
    name = (input.customName ?? '').trim().slice(0, 80);
    perServing = Number(input.customMg);
    if (name.length < 2) throw new ServiceError('Name your custom drink.');
    if (!(perServing > 0 && perServing <= LIMITS.maxCustomMg)) throw new ServiceError(`Custom drinks need a caffeine amount between 1 and ${LIMITS.maxCustomMg} mg (check the label).`);
  } else {
    const [d] = await db().select().from(drinks).where(and(eq(drinks.id, input.drinkId), eq(drinks.enabled, true)));
    if (!d) throw new ServiceError('Pick a drink from the list.');
    name = d.name; perServing = d.caffeineMg; drinkId = d.id;
  }
  const mg = Math.round(perServing * servings * 10) / 10;
  if (mg > LIMITS.maxPerLogMg) throw new ServiceError('That is a lot of caffeine for one entry — log it in parts, if you really must.');
  const rl = await services.rateLimit(`caffeine:log:${userId}`, { max: LIMITS.logsPerHour, windowSec: 3600 });
  if (!rl.ok) throw new ServiceError('Easy there — you have logged a lot of drinks this hour. Try again later.', 429, 'rate_limited');
  const consumedAt = new Date(now.getTime() - minutesAgo * 60_000);
  const [row] = await db().insert(logs).values({ userId, drinkId, drinkName: name, servings, mg, consumedAt }).returning();
  return row;
}

export async function deleteLog(userId: number, id: number) {
  const r = await db().delete(logs).where(and(eq(logs.id, id), eq(logs.userId, userId))).returning({ id: logs.id });
  if (!r.length) throw new ServiceError('Entry not found.', 404);
}

export async function recentLogs(userId: number, since: Date) {
  return db().select().from(logs).where(and(eq(logs.userId, userId), gte(logs.consumedAt, since))).orderBy(desc(logs.consumedAt));
}

export async function isHidden(userId: number) {
  const [p] = await db().select().from(prefs).where(eq(prefs.userId, userId));
  return p?.hidden ?? false;
}
export async function setHidden(userId: number, hidden: boolean) {
  await db().insert(prefs).values({ userId, hidden }).onConflictDoUpdate({ target: prefs.userId, set: { hidden } });
}

export async function currentFor(userId: number, o: ModelOptions, now = new Date()) {
  const rows = await recentLogs(userId, new Date(now.getTime() - LOOKBACK_MS));
  const doses = rows.map((r) => ({ mg: r.mg, at: r.consumedAt }));
  const mg = mgAt(doses, now, o);
  return { mg, level: levelFor(mg), doses, rows };
}

export type BoardKind = 'now' | 'day' | 'event';
export interface BoardRow { userId: number; username: string; mg: number; drinks: number; level: Level }

/** Leaderboards. Members who opted out are excluded. `since` is the start of the event for the 'event' board. */
export async function leaderboard(kind: BoardKind, limit: number, o: ModelOptions, opts: { since?: Date | null; now?: Date } = {}): Promise<BoardRow[]> {
  const now = opts.now ?? new Date();
  const from = kind === 'now' ? new Date(now.getTime() - LOOKBACK_MS) : kind === 'day' ? new Date(now.getTime() - 24 * 3600_000) : opts.since ?? new Date(0);
  const rows = await db().select({ userId: logs.userId, mg: logs.mg, at: logs.consumedAt }).from(logs)
    .leftJoin(prefs, eq(prefs.userId, logs.userId))
    .where(and(gte(logs.consumedAt, from), sql`${logs.consumedAt} <= ${now}`, sql`coalesce(${prefs.hidden}, false) = false`));
  const by = new Map<number, { mg: number; at: Date }[]>();
  for (const r of rows) { const l = by.get(r.userId) ?? []; l.push({ mg: r.mg, at: r.at }); by.set(r.userId, l); }
  const scored = [...by.entries()].map(([userId, doses]) => ({
    userId, drinks: doses.length,
    mg: kind === 'now' ? mgAt(doses, now, o) : doses.reduce((a, d) => a + d.mg, 0),
  })).filter((r) => r.mg >= 1).sort((a, b) => b.mg - a.mg).slice(0, Math.max(1, Math.min(100, limit)));
  const cards = await services.users.cards(scored.map((s) => s.userId));
  return scored.filter((s) => cards.get(s.userId)).map((s) => ({ ...s, username: cards.get(s.userId)!.username, level: levelFor(kind === 'now' ? s.mg : 0) }));
}

export async function topDrinks(since: Date, limit = 5) {
  return db().select({ name: logs.drinkName, n: sql<number>`count(*)::int`, mg: sql<number>`sum(${logs.mg})::float` }).from(logs)
    .where(gte(logs.consumedAt, since)).groupBy(logs.drinkName).orderBy(desc(sql`count(*)`)).limit(limit);
}

export async function forgetUser(userId: number) {
  await db().delete(logs).where(eq(logs.userId, userId));
  await db().delete(prefs).where(eq(prefs.userId, userId));
}
