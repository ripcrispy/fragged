import { and, eq, isNull, desc, sql, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { publish } from './events.ts';
import { getSetting } from './settings.ts';
import { sendMail } from './mailer.ts';

export const NOTIFICATION_KINDS = {
  friend_request: 'Friend requests',
  friend_accept: 'Accepted friend requests',
  message: 'New direct messages',
  reply: 'Replies to subscribed threads',
  mention: 'Mentions',
  quote: 'Quotes of your posts',
  profile_comment: 'Comments on your profile',
  reaction: 'Reactions to your posts',
  moderation: 'Moderation actions and account notices',
  security: 'Security events',
} as const;
/** Core kinds are typed; modules declare extra kinds in their manifest (`notificationKinds`). */
export type NotificationKind = keyof typeof NOTIFICATION_KINDS | (string & {});

/** Core + enabled-module notification kinds with labels. */
export async function allNotificationKinds(): Promise<Record<string, string>> {
  const { moduleNotificationKinds } = await import('../modules/runtime.ts');
  return { ...NOTIFICATION_KINDS, ...moduleNotificationKinds() };
}

/** Kinds that cannot be switched off (account safety). */
export const MANDATORY_KINDS: NotificationKind[] = ['moderation', 'security'];
/** Kinds where the actor's mute / block suppresses delivery. */
const SOCIAL_KINDS: NotificationKind[] = ['friend_request', 'friend_accept', 'message', 'reply', 'mention', 'quote', 'profile_comment', 'reaction'];

export async function preferenceFor(userId: number, kind: NotificationKind) {
  const [p] = await getDb().select().from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.userId, userId), eq(schema.notificationPreferences.kind, kind)));
  const defaults = { inApp: true, email: kind === 'security' || kind === 'moderation' };
  return p ? { inApp: p.inApp, email: p.email } : defaults;
}

/**
 * Create an in-app notification (and optionally an email) unless suppressed by preference,
 * mute or block. `text` must be plain text and spoiler-free (callers use bbcode.excerpt()).
 */
export async function notify(userId: number, kind: NotificationKind, actorId: number | null, text: string, url: string): Promise<boolean> {
  if (actorId === userId) return false;
  const db = getDb();
  if (actorId && SOCIAL_KINDS.includes(kind)) {
    const suppressed = await db.execute(sql`
      select 1 from user_mutes where muter_id = ${userId} and muted_id = ${actorId}
      union all select 1 from user_blocks where (blocker_id = ${userId} and blocked_id = ${actorId}) or (blocker_id = ${actorId} and blocked_id = ${userId})
      limit 1`);
    if (rowsOf(suppressed).length) return false;
  }
  const pref = await preferenceFor(userId, kind);
  const mandatory = MANDATORY_KINDS.includes(kind);
  if (!pref.inApp && !mandatory) return false;
  const [n] = await db.insert(schema.notifications).values({ userId, kind, actorId, text: text.slice(0, 300), url }).returning();
  publish(userId, 'notification', { id: n.id, kind, text: n.text, url, createdAt: n.createdAt });
  if (pref.email && (await getSetting('email_notifications_enabled'))) {
    const [u] = await db.select({ email: schema.users.email, verified: schema.users.emailVerifiedAt, s: schema.userSettings.emailNotifications })
      .from(schema.users).leftJoin(schema.userSettings, eq(schema.userSettings.userId, schema.users.id)).where(eq(schema.users.id, userId));
    if (u?.email && u.verified && (u.s || mandatory)) {
      await sendMail({ to: u.email, subject: `[Fragged] ${(await allNotificationKinds())[kind] ?? 'Notification'}`, text: `${text}\n\n${config.APP_URL}${url}\n\nManage notification settings: ${config.APP_URL}/settings/notifications` });
    }
  }
  return true;
}

export function rowsOf(r: any): any[] { return Array.isArray(r) ? r : r?.rows ?? []; }

export async function unreadCount(userId: number): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return r.n;
}

export async function listNotifications(userId: number, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(schema.notifications.userId, userId)];
  if (opts.before) conds.push(sql`${schema.notifications.id} < ${opts.before}`);
  return getDb().select().from(schema.notifications).where(and(...conds)).orderBy(desc(schema.notifications.id)).limit(limit);
}

export async function markRead(userId: number, ids: number[] | 'all') {
  const db = getDb();
  const cond = ids === 'all'
    ? and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt))
    : and(eq(schema.notifications.userId, userId), inArray(schema.notifications.id, ids.length ? ids : [-1]));
  await db.update(schema.notifications).set({ readAt: new Date() }).where(cond);
  publish(userId, 'notification_read', { ids });
}

export async function setPreferences(userId: number, prefs: Record<string, { inApp: boolean; email: boolean }>) {
  const db = getDb();
  for (const [kind, p] of Object.entries(prefs)) {
    if (!(kind in (await allNotificationKinds()))) continue;
    const mandatory = MANDATORY_KINDS.includes(kind as NotificationKind);
    await db.insert(schema.notificationPreferences).values({ userId, kind, inApp: mandatory ? true : p.inApp, email: p.email })
      .onConflictDoUpdate({ target: [schema.notificationPreferences.userId, schema.notificationPreferences.kind], set: { inApp: mandatory ? true : p.inApp, email: p.email } });
  }
}
