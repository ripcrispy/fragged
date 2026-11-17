/**
 * Server-side achievement evaluation. Metrics are computed from the database — client-submitted counts are
 * never trusted. A unique (user, achievement) index makes awards idempotent; revoked awards stay revoked
 * (no automatic re-award) and every manual award/revocation is audited.
 */
import { database, services, sql, eq, and, isNull, asc, ServiceError } from '../../src/sdk/index.ts';
import { achievementDefinitions as defs, userAchievements as awards } from './schema.ts';

export const METRICS = {
  posts: 'Replies and posts (excluding deleted)',
  threads: 'Threads started (excluding deleted)',
  reactions_received: 'Reactions received from other members',
  friends: 'Accepted friends',
  account_days: 'Days since joining',
  profile_comments_received: 'Profile comments received from friends',
} as const;

const db = () => database.db();
const rows = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

/** Counts other modules add through the exposed API (e.g. tournaments played). Values come from those modules' own data. */
export const moduleMetrics = new Map<string, { label: string; value(userId: number): Promise<number> }>();
export const allMetrics = (): Record<string, string> => ({ ...METRICS, ...Object.fromEntries([...moduleMetrics].map(([k, m]) => [k, m.label])) });

export async function metricValue(userId: number, metric: string): Promise<number> {
  const extra = moduleMetrics.get(metric);
  if (extra) return extra.value(userId);
  const one = async (q: any) => Number(rows(await db().execute(q))[0]?.n ?? 0);
  switch (metric) {
    // posts count only when ≥ 10 characters so one-word spam isn't rewarded
    case 'posts': return one(sql`select count(*)::int as n from posts where user_id = ${userId} and not is_deleted and state = 'visible' and length(body) >= 10`);
    case 'threads': return one(sql`select count(*)::int as n from threads where user_id = ${userId} and not is_deleted`);
    case 'reactions_received': return one(sql`select count(distinct (r.post_id, r.user_id))::int as n from post_reactions r join posts p on p.id = r.post_id where p.user_id = ${userId} and r.user_id <> ${userId} and not p.is_deleted`);
    case 'friends': return one(sql`select count(*)::int as n from friendships where user_low_id = ${userId} or user_high_id = ${userId}`);
    case 'account_days': return one(sql`select floor(extract(epoch from (now() - created_at)) / 86400)::int as n from users where id = ${userId}`);
    case 'profile_comments_received': return one(sql`select count(distinct author_id)::int as n from profile_comments where profile_user_id = ${userId} and not is_deleted and author_id <> ${userId}`);
  }
  return 0;
}

export async function evaluate(userId: number): Promise<string[]> {
  const all = await db().select().from(defs).where(eq(defs.isActive, true));
  const have = new Set((await db().select({ a: awards.achievementId }).from(awards).where(eq(awards.userId, userId))).map((h) => h.a));
  const cache = new Map<string, number>();
  const awarded: string[] = [];
  for (const d of all) {
    if (have.has(d.id) || d.criteria.manual || !d.criteria.metric || !d.criteria.threshold) continue;
    if (!cache.has(d.criteria.metric)) cache.set(d.criteria.metric, await metricValue(userId, d.criteria.metric));
    if ((cache.get(d.criteria.metric) ?? 0) < d.criteria.threshold) continue;
    const ins = await db().insert(awards).values({ userId, achievementId: d.id }).onConflictDoNothing().returning();
    if (ins.length) {
      awarded.push(d.key);
      await services.notify(userId, 'achievement', null, `Achievement unlocked: ${d.name}`, '/m/achievements');
    }
  }
  return awarded;
}

export async function award(adminId: number, userId: number, achievementId: number, ip?: string | null) {
  const [d] = await db().select().from(defs).where(eq(defs.id, achievementId));
  if (!d) throw new ServiceError('Achievement not found.', 404);
  await db().insert(awards).values({ userId, achievementId, awardedById: adminId }).onConflictDoUpdate({
    target: [awards.userId, awards.achievementId], set: { revokedAt: null, revokedById: null, revokeReason: null, awardedById: adminId, awardedAt: new Date() },
  });
  await services.audit(adminId, 'achievement.award', { type: 'user', id: userId }, { achievement: d.key }, ip);
  await services.notify(userId, 'achievement', null, `Achievement unlocked: ${d.name}`, '/m/achievements');
}

export async function revoke(adminId: number, userId: number, achievementId: number, reason: string, ip?: string | null) {
  const upd = await db().update(awards).set({ revokedAt: new Date(), revokedById: adminId, revokeReason: reason.slice(0, 500) })
    .where(and(eq(awards.userId, userId), eq(awards.achievementId, achievementId))).returning();
  if (!upd.length) throw new ServiceError('Award not found.', 404);
  await services.audit(adminId, 'achievement.revoke', { type: 'user', id: userId }, { achievementId, reason }, ip);
}

export async function earnedBy(userId: number) {
  return db().select({ a: defs, awardedAt: awards.awardedAt }).from(awards).innerJoin(defs, eq(defs.id, awards.achievementId))
    .where(and(eq(awards.userId, userId), isNull(awards.revokedAt))).orderBy(asc(defs.displayOrder));
}

export const DEFAULTS = [
  { key: 'first-thread', name: 'Conversation Starter', description: 'Started your first thread.', category: 'threads', icon: 'flag', rarity: 'common', criteria: { metric: 'threads', threshold: 1 } },
  { key: 'threads-25', name: 'Topic Machine', description: 'Started 25 threads.', category: 'threads', icon: 'stack', rarity: 'rare', criteria: { metric: 'threads', threshold: 25 } },
  { key: 'first-post', name: 'First Words', description: 'Made your first post.', category: 'posts', icon: 'quill', rarity: 'common', criteria: { metric: 'posts', threshold: 1 } },
  { key: 'posts-100', name: 'Centurion', description: 'Made 100 posts.', category: 'posts', icon: 'medal', rarity: 'uncommon', criteria: { metric: 'posts', threshold: 100 } },
  { key: 'posts-1000', name: 'Veteran Voice', description: 'Made 1,000 posts.', category: 'posts', icon: 'crown', rarity: 'epic', criteria: { metric: 'posts', threshold: 1000 } },
  { key: 'reactions-10', name: 'Crowd Pleaser', description: 'Received 10 reactions from other members.', category: 'reactions', icon: 'spark', rarity: 'common', criteria: { metric: 'reactions_received', threshold: 10 } },
  { key: 'reactions-250', name: 'Fan Favourite', description: 'Received 250 reactions from other members.', category: 'reactions', icon: 'star', rarity: 'rare', criteria: { metric: 'reactions_received', threshold: 250 } },
  { key: 'friends-5', name: 'Squad Up', description: 'Made 5 friends.', category: 'community', icon: 'people', rarity: 'common', criteria: { metric: 'friends', threshold: 5 } },
  { key: 'guestbook-5', name: 'Well Known', description: 'Received profile comments from 5 different friends.', category: 'community', icon: 'chat', rarity: 'uncommon', criteria: { metric: 'profile_comments_received', threshold: 5 } },
  { key: 'year-one', name: 'One Year In', description: 'Member for a year.', category: 'account', icon: 'cake', rarity: 'uncommon', criteria: { metric: 'account_days', threshold: 365 } },
  { key: 'helper', name: 'Community Helper', description: 'Recognised by staff for helping other members.', category: 'contribution', icon: 'shield', rarity: 'legendary', criteria: { manual: true } },
];
