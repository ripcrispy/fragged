import { and, eq, inArray, isNull, or, gt, sql } from 'drizzle-orm';
import { getDb, schema, type DB } from '../db/client.ts';
import { usernameKey, validateUsername } from '../lib/validate.ts';
import { groupBySlug, loadPermissionData, type GroupRow, type PermissionSubject, can as canPerm, type Perm } from './permissions.ts';
import { getSetting } from './settings.ts';
import { presenceOf, type Presence } from './events.ts';

export type User = typeof schema.users.$inferSelect;
export type Profile = typeof schema.userProfiles.$inferSelect;
export type UserSettingsRow = typeof schema.userSettings.$inferSelect;
export type Ban = typeof schema.userBans.$inferSelect;

export class ServiceError extends Error {
  constructor(message: string, public status = 400, public code = 'invalid') { super(message); }
}

export async function isUsernameAvailable(name: string, exceptUserId?: number): Promise<boolean> {
  const rows = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.usernameLower, usernameKey(name)));
  return rows.every((r) => r.id === exceptUserId);
}

export async function checkUsername(name: string, exceptUserId?: number): Promise<string | null> {
  const reserved = await getSetting('reserved_usernames');
  const err = validateUsername(name, reserved);
  if (err) return err;
  if (!(await isUsernameAvailable(name, exceptUserId))) return 'That username is already taken.';
  return null;
}

export async function createUser(input: {
  username: string; email: string | null; emailVerified?: boolean; passwordHash: string | null;
  dateOfBirth?: string | null; timezone?: string; groupSlug?: string;
}, tx: DB = getDb()): Promise<User> {
  const group = await groupBySlug(input.groupSlug ?? 'member');
  if (!group) throw new Error('member group missing');
  const defaultTheme = await getSetting('default_theme');
  const profanity = await getSetting('profanity_default');
  const [u] = await tx.insert(schema.users).values({
    username: input.username,
    usernameLower: usernameKey(input.username),
    email: input.email,
    emailLower: input.email?.toLowerCase() ?? null,
    emailVerifiedAt: input.emailVerified ? new Date() : null,
    passwordHash: input.passwordHash,
    primaryGroupId: group.id,
    dateOfBirth: input.dateOfBirth ?? null,
    timezone: input.timezone ?? 'UTC',
    termsAcceptedAt: new Date(),
  }).returning();
  await tx.insert(schema.userProfiles).values({ userId: u.id });
  await tx.insert(schema.userSettings).values({ userId: u.id, theme: defaultTheme, profanityFilter: profanity });
  await tx.insert(schema.userGroupMemberships).values({ userId: u.id, groupId: group.id });
  return u;
}

export async function getUserById(id: number): Promise<User | null> {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  return u ?? null;
}
export async function getUserByUsername(name: string): Promise<User | null> {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, usernameKey(name)));
  return u ?? null;
}
export async function getUserByLogin(login: string): Promise<User | null> {
  const l = login.trim().toLowerCase();
  const [u] = await getDb().select().from(schema.users).where(or(eq(schema.users.usernameLower, usernameKey(login.trim())), eq(schema.users.emailLower, l)));
  return u ?? null;
}

export async function activeBan(userId: number): Promise<Ban | null> {
  const [b] = await getDb().select().from(schema.userBans)
    .where(and(eq(schema.userBans.userId, userId), isNull(schema.userBans.liftedAt), or(isNull(schema.userBans.expiresAt), gt(schema.userBans.expiresAt, new Date()))))
    .orderBy(sql`${schema.userBans.expiresAt} desc nulls first`).limit(1);
  return b ?? null;
}

export async function userGroupIds(userId: number): Promise<number[]> {
  const rows = await getDb().select({ g: schema.userGroupMemberships.groupId }).from(schema.userGroupMemberships).where(eq(schema.userGroupMemberships.userId, userId));
  return rows.map((r) => r.g);
}

/** Display info for usernames everywhere (colour/title from highest-priority group). */
export interface UserCard {
  id: number; username: string; avatarUrl: string; color: string | null; groupId: number | null; title: string | null; groupName: string | null;
  isStaff: boolean; closed: boolean; joinedAt: Date; postCount: number; pronouns: string | null; location: string | null;
  signature: string; presence: Presence | null;
}

export function avatarUrl(publicId: string | null | undefined): string {
  return publicId ? `/media/${publicId}` : '/img/default-avatar.svg';
}

/** Batch-load user cards (avoids N+1 in thread pages and listings). */
export async function userCards(ids: number[], opts: { presenceFor?: boolean } = {}): Promise<Map<number, UserCard>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const out = new Map<number, UserCard>();
  if (!uniq.length) return out;
  const db = getDb();
  const rows = await db.select({ u: schema.users, p: schema.userProfiles, s: schema.userSettings, av: schema.uploads.publicId })
    .from(schema.users)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
    .leftJoin(schema.userSettings, eq(schema.userSettings.userId, schema.users.id))
    .leftJoin(schema.uploads, eq(schema.uploads.id, schema.userProfiles.avatarUploadId))
    .where(inArray(schema.users.id, uniq));
  const memberships = await db.select().from(schema.userGroupMemberships).where(inArray(schema.userGroupMemberships.userId, uniq));
  const { groups } = await loadPermissionData();
  const presenceEnabled = await getSetting('presence_enabled');
  for (const { u, p, s, av } of rows) {
    const gs = memberships.filter((m) => m.userId === u.id).map((m) => groups.find((g) => g.id === m.groupId)).filter(Boolean) as GroupRow[];
    const top = gs.sort((a, b) => b.priority - a.priority)[0];
    const closed = !!u.closedAt;
    out.set(u.id, {
      id: u.id,
      username: closed ? 'Former member' : u.username,
      avatarUrl: closed ? '/img/default-avatar.svg' : avatarUrl(av),
      color: closed ? null : top?.color ?? null,
      groupId: closed ? null : top?.id ?? null,
      title: closed ? null : p?.customTitle || top?.userTitle || null,
      groupName: top?.name ?? null,
      isStaff: !!top?.isStaff,
      closed,
      joinedAt: u.createdAt,
      postCount: u.postCount,
      pronouns: closed ? null : p?.pronouns ?? null,
      location: closed ? null : p?.location ?? null,
      signature: closed ? '' : p?.signature ?? '',
      presence: presenceEnabled && s?.showPresence && !closed ? presenceOf(u.id) : null,
    });
  }
  return out;
}

export async function userCard(id: number) { return (await userCards([id])).get(id) ?? null; }

export async function getProfile(userId: number): Promise<Profile> {
  const [p] = await getDb().select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
  return p;
}
export async function getUserSettings(userId: number): Promise<UserSettingsRow> {
  const [s] = await getDb().select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  return s;
}

export async function subjectFor(user: User | null): Promise<PermissionSubject> {
  const data = await loadPermissionData();
  if (!user) return { userId: null, groupIds: [data.groups.find((g) => g.slug === 'guest')!.id], isSuperAdmin: false, restricted: false, unverified: false };
  const groupIds = await userGroupIds(user.id);
  const ban = await activeBan(user.id);
  const requireVerify = await getSetting('require_email_verification');
  return {
    userId: user.id,
    groupIds,
    isSuperAdmin: data.groups.some((g) => groupIds.includes(g.id) && g.isSuperAdmin) && !ban,
    restricted: !!ban || !!user.closedAt,
    unverified: requireVerify && !!user.email && !user.emailVerifiedAt,
  };
}

export async function userCan(userId: number, perm: Perm, forumId: number | null = null) {
  return canPerm(await subjectFor(await getUserById(userId)), perm, forumId);
}

/** Automatic promotion to Established Members after a post threshold. */
export async function maybePromote(userId: number, tx: DB = getDb()) {
  const threshold = await getSetting('established_post_threshold');
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u || u.postCount < threshold) return;
  const est = await groupBySlug('established');
  if (!est) return;
  await tx.insert(schema.userGroupMemberships).values({ userId, groupId: est.id }).onConflictDoNothing();
}
