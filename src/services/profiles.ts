import { and, desc, eq, sql, ilike, or, asc, inArray, isNull, gt } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { cleanLine, cleanText, parseHexColor } from '../lib/validate.ts';
import { safeUrl } from '../lib/media.ts';
import { excerpt } from '../lib/bbcode.ts';
import { ServiceError, getUserByUsername, type User, checkUsername, userCards } from './users.ts';
import { areFriends, isBlockedEitherWay, hasBlocked } from './relationships.ts';
import { notify } from './notifications.ts';
import { enforcePolicy } from './policy.ts';
import { audit, securityEvent } from './audit.ts';
import { rateLimit } from './forums.ts';
import { getSetting } from './settings.ts';
import { emit, applyFilters } from '../modules/registry.ts';
import { usernameKey } from '../lib/validate.ts';
import { viewableForumIds } from './permissions.ts';
import type { Viewer } from './viewer.ts';

export type ProfileComment = typeof schema.profileComments.$inferSelect;

/** Can the viewer see this member's profile body (beyond the basic header)? */
export async function profileAccess(v: Viewer, user: User): Promise<{ visible: boolean; reason?: string }> {
  if (user.closedAt) return { visible: false, reason: 'This account has been closed.' };
  if (v.user?.id === user.id || (await v.can('mod.users'))) return { visible: true };
  if (!(await v.can('member.view'))) return { visible: false, reason: 'Sign in to view member profiles.' };
  if (v.user && (await hasBlocked(user.id, v.user.id))) return { visible: false, reason: 'This profile is not available.' };
  const [p] = await getDb().select({ vis: schema.userProfiles.visibility }).from(schema.userProfiles).where(eq(schema.userProfiles.userId, user.id));
  const vis = p?.vis ?? 'everyone';
  if (vis === 'members' && !v.user) return { visible: false, reason: 'This member’s profile is visible to signed-in members only.' };
  if (vis === 'friends' && !(v.user && (await areFriends(v.user.id, user.id)))) return { visible: false, reason: 'This member’s profile is visible to their friends only.' };
  return { visible: true };
}

export interface ProfileUpdate {
  bio?: string; pronouns?: string; location?: string; customTitle?: string; signature?: string;
  links?: { label: string; url: string }[];
  backgroundColor?: string | null; showAchievements?: boolean; showRecentActivity?: boolean; visibility?: string; coverPositionY?: number;
}

export async function updateProfile(v: Viewer, input: ProfileUpdate): Promise<Record<string, string>> {
  const me = v.user!;
  await v.require('profile.customize');
  const errors: Record<string, string> = {};
  const patch: Partial<typeof schema.userProfiles.$inferInsert> = {};
  if (input.bio !== undefined) patch.bio = cleanText(input.bio, 3000);
  if (input.pronouns !== undefined) patch.pronouns = cleanLine(input.pronouns, 40) || null;
  if (input.location !== undefined) patch.location = cleanLine(input.location, 80) || null;
  if (input.customTitle !== undefined) {
    // custom user titles are a staff/established privilege to avoid impersonation
    patch.customTitle = (await v.can('user.change_username')) ? cleanLine(input.customTitle, 40) || null : undefined;
    if (patch.customTitle && /\b(admin|administrator|moderator|staff|official)\b/i.test(patch.customTitle) && !v.subject.isSuperAdmin) { errors.customTitle = 'That title is reserved for staff.'; delete patch.customTitle; }
  }
  if (input.signature !== undefined) {
    if (await v.can('user.signature')) {
      const sig = cleanText(input.signature, 600);
      if (sig.split('\n').length > 5) errors.signature = 'Signatures are limited to 5 lines.';
      else patch.signature = sig;
    }
  }
  if (input.links !== undefined) {
    const links: { label: string; url: string }[] = [];
    for (const l of input.links.slice(0, 5)) {
      if (!l.url.trim()) continue;
      const u = safeUrl(l.url);
      if (!u) { errors.links = `"${l.url.slice(0, 60)}" is not a valid http(s) link.`; continue; }
      links.push({ label: cleanLine(l.label, 40) || u.hostname, url: u.toString() });
    }
    patch.links = links;
  }
  if (input.backgroundColor !== undefined) {
    if (input.backgroundColor === null || input.backgroundColor === '') patch.backgroundColor = null;
    else { const c = parseHexColor(input.backgroundColor); if (!c) errors.backgroundColor = 'Choose a colour in #RRGGBB format.'; else patch.backgroundColor = c; }
  }
  if (input.showAchievements !== undefined) patch.showAchievements = input.showAchievements;
  if (input.showRecentActivity !== undefined) patch.showRecentActivity = input.showRecentActivity;
  if (input.visibility !== undefined) patch.visibility = ['everyone', 'members', 'friends'].includes(input.visibility) ? input.visibility : 'everyone';
  if (input.coverPositionY !== undefined) patch.coverPositionY = Math.max(0, Math.min(100, Math.round(input.coverPositionY)));
  // mandatory restricted-term policy on public profile text
  for (const field of ['bio', 'pronouns', 'location', 'customTitle', 'signature'] as const) {
    const val = patch[field];
    if (typeof val === 'string' && val) {
      try { const r = await enforcePolicy(val, { userId: me.id, contentType: 'profile' }); if (r.held) errors[field] = 'This text needs review by a moderator. Please rephrase it.'; }
      catch (e) { if (e instanceof ServiceError) errors[field] = e.message; else throw e; }
      if (errors[field]) delete patch[field];
    }
  }
  if (Object.keys(patch).length) await getDb().update(schema.userProfiles).set(patch).where(eq(schema.userProfiles.userId, me.id));
  return errors;
}

export async function setAvatar(userId: number, uploadId: number | null) {
  await getDb().update(schema.userProfiles).set({ avatarUploadId: uploadId }).where(eq(schema.userProfiles.userId, userId));
}
export async function setCover(userId: number, uploadId: number | null) {
  await getDb().update(schema.userProfiles).set({ coverUploadId: uploadId }).where(eq(schema.userProfiles.userId, userId));
}

// ─────────────── profile comments (friends only) ───────────────

export async function canComment(v: Viewer, profileUserId: number): Promise<{ ok: boolean; reason?: string }> {
  if (!v.user) return { ok: false, reason: 'Sign in to leave a comment.' };
  if (!(await v.can('profile.comment'))) return { ok: false, reason: 'You cannot leave profile comments.' };
  if (v.user.id === profileUserId) return { ok: true };
  if (await isBlockedEitherWay(v.user.id, profileUserId)) return { ok: false, reason: 'You cannot comment on this profile.' };
  if (!(await areFriends(v.user.id, profileUserId))) return { ok: false, reason: 'Only friends can comment on this profile.' };
  return { ok: true };
}

export async function addComment(v: Viewer, profileUserId: number, bodyIn: string): Promise<ProfileComment> {
  const chk = await canComment(v, profileUserId);
  if (!chk.ok) throw new ServiceError(chk.reason!, 403);
  await rateLimit(v, 'profile_comment');
  const filtered = await applyFilters('profile.comment.beforeSave', { body: cleanText(bodyIn, 2000), authorId: v.user!.id, profileUserId });
  const body = cleanText(filtered.body, 2000).trim();
  if (body.length < 1) throw new ServiceError('Comment is empty.');
  if (body.length > 1000) throw new ServiceError('Comments can be at most 1,000 characters.');
  const pol = await enforcePolicy(body, { userId: v.user!.id, contentType: 'profile_comment' });
  const [c] = await getDb().insert(schema.profileComments).values({ profileUserId, authorId: v.user!.id, body, state: pol.held ? 'held' : 'visible' }).returning();
  if (!pol.held) {
    const [owner] = await getDb().select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, profileUserId));
    await notify(profileUserId, 'profile_comment', v.user!.id, `${v.user!.username} commented on your profile: ${excerpt(body, 80)}`, `/u/${encodeURIComponent(owner.username)}#comments`);
    await emit('profile.commented', { profileUserId, authorId: v.user!.id, commentId: c.id });
  }
  return c;
}

export async function listComments(v: Viewer, profileUserId: number, page = 1) {
  const db = getDb();
  const perPage = 15;
  const mod = await v.can('mod.comments');
  const isOwner = v.user?.id === profileUserId;
  const conds = [eq(schema.profileComments.profileUserId, profileUserId), eq(schema.profileComments.isDeleted, false)];
  if (!mod) conds.push(or(eq(schema.profileComments.state, 'visible'), eq(schema.profileComments.authorId, v.user?.id ?? -1))!);
  // Block policy: comments by members the profile owner has blocked are hidden from everyone
  conds.push(sql`not exists (select 1 from user_blocks b where b.blocker_id = ${profileUserId} and b.blocked_id = ${schema.profileComments.authorId})`);
  // viewers don't see comments from members they have blocked
  if (v.user) conds.push(sql`not exists (select 1 from user_blocks b where b.blocker_id = ${v.user.id} and b.blocked_id = ${schema.profileComments.authorId})`);
  const where = and(...conds);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.profileComments).where(where);
  const pages = Math.max(1, Math.ceil(n / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await db.select().from(schema.profileComments).where(where).orderBy(desc(schema.profileComments.createdAt)).limit(perPage).offset((p - 1) * perPage);
  return { comments: rows, page: p, pages, total: n, canModerate: mod || isOwner };
}

export async function removeComment(v: Viewer, commentId: number) {
  const db = getDb();
  const [c] = await db.select().from(schema.profileComments).where(eq(schema.profileComments.id, commentId));
  if (!c || c.isDeleted) throw new ServiceError('Comment not found.', 404);
  const mod = await v.can('mod.comments');
  const owner = v.user?.id === c.profileUserId;
  const author = v.user?.id === c.authorId;
  if (!mod && !owner && !author) throw new ServiceError('You cannot remove this comment.', 403);
  await db.update(schema.profileComments).set({ isDeleted: true, deletedById: v.user!.id }).where(eq(schema.profileComments.id, commentId));
  if (mod && !owner && !author) await audit(v.user!.id, 'profile_comment.remove', { type: 'profile_comment', id: commentId }, { profileUserId: c.profileUserId }, v.ip);
}

// ─────────────── member directory & search ───────────────

export async function searchMembers(v: Viewer, opts: { q?: string; page?: number; sort?: 'username' | 'joined' | 'posts'; group?: string | null; perPage?: number }) {
  const db = getDb();
  const perPage = opts.perPage ?? 30;
  const q = (opts.q ?? '').trim().toLowerCase().slice(0, 32);
  const conds = [isNull(schema.users.closedAt)];
  // privacy: undiscoverable members only appear on exact username match
  if (q) {
    const esc = q.replace(/[%_\\]/g, '\\$&');
    conds.push(or(eq(schema.users.usernameLower, usernameKey(q)), and(sql`${schema.users.usernameLower} like ${'%' + esc + '%'}`, sql`coalesce((select discoverable from user_settings s where s.user_id = ${schema.users.id}), true)`))!);
  } else {
    conds.push(sql`coalesce((select discoverable from user_settings s where s.user_id = ${schema.users.id}), true)`);
  }
  if (opts.group) conds.push(sql`exists (select 1 from user_group_memberships m join user_groups g on g.id = m.group_id where m.user_id = ${schema.users.id} and g.slug = ${opts.group})`);
  if (v.user) conds.push(sql`not exists (select 1 from user_blocks b where b.blocker_id = ${schema.users.id} and b.blocked_id = ${v.user.id})`);
  const where = and(...conds);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(where);
  const pages = Math.max(1, Math.ceil(n / perPage));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const order = opts.sort === 'joined' ? [desc(schema.users.createdAt)] : opts.sort === 'posts' ? [desc(schema.users.postCount)] :
    q ? [sql`case when ${schema.users.usernameLower} = ${q} then 0 when ${schema.users.usernameLower} like ${q.replace(/[%_\\]/g, '\\$&') + '%'} then 1 else 2 end`, asc(schema.users.usernameLower)] : [asc(schema.users.usernameLower)];
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(where).orderBy(...order).limit(perPage).offset((page - 1) * perPage);
  const cards = await userCards(rows.map((r) => r.id));
  return { members: rows.map((r) => cards.get(r.id)!).filter(Boolean), page, pages, total: n };
}

/** Lightweight username autocomplete (prefix match, discoverable members). */
export async function autocomplete(v: Viewer, prefix: string, limit = 8) {
  const p = prefix.trim().toLowerCase().slice(0, 32);
  if (p.length < 2) return [];
  const esc = p.replace(/[%_\\]/g, '\\$&');
  const rows = await getDb().select({ id: schema.users.id, username: schema.users.username }).from(schema.users)
    .where(and(isNull(schema.users.closedAt), sql`${schema.users.usernameLower} like ${esc + '%'}`, or(eq(schema.users.usernameLower, p), sql`coalesce((select discoverable from user_settings s where s.user_id = ${schema.users.id}), true)`),
      v.user ? sql`not exists (select 1 from user_blocks b where b.blocker_id = ${schema.users.id} and b.blocked_id = ${v.user.id})` : sql`true`))
    .orderBy(asc(schema.users.usernameLower)).limit(limit);
  const cards = await userCards(rows.map((r) => r.id));
  return rows.map((r) => ({ username: r.username, avatarUrl: cards.get(r.id)?.avatarUrl, url: `/u/${encodeURIComponent(r.username)}` }));
}

export async function recentActivity(v: Viewer, userId: number, limit = 10) {
  const ids = await viewableForumIds(v.subject);
  if (!ids.length) return [];
  return getDb().select({ postId: schema.posts.id, body: schema.posts.body, createdAt: schema.posts.createdAt, threadId: schema.threads.id, title: schema.threads.title, slug: schema.threads.slug, position: schema.posts.position })
    .from(schema.posts).innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId))
    .where(and(eq(schema.posts.userId, userId), eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible'), eq(schema.threads.isDeleted, false), inArray(schema.threads.forumId, ids)))
    .orderBy(desc(schema.posts.createdAt)).limit(limit);
}

export async function changeUsername(v: Viewer, newName: string): Promise<string | null> {
  const me = v.user!;
  if (!(await v.can('user.change_username')) && !v.subject.isSuperAdmin) return 'You cannot change your username yet.';
  const days = await getSetting('username_change_days');
  if (me.usernameChangedAt && Date.now() - me.usernameChangedAt.getTime() < days * 86400_000) return `You can change your username once every ${days} days.`;
  const name = newName.trim();
  if (name === me.username) return null;
  const err = await checkUsername(name, me.id);
  if (err) return err;
  try { await enforcePolicy(name, { userId: me.id, contentType: 'username' }); } catch (e) { if (e instanceof ServiceError) return 'That username is not allowed.'; throw e; }
  await getDb().update(schema.users).set({ username: name, usernameLower: usernameKey(name), usernameChangedAt: new Date() }).where(eq(schema.users.id, me.id));
  await securityEvent(me.id, 'username_changed', { ip: v.ip, detail: { from: me.username, to: name } });
  await audit(me.id, 'user.rename', { type: 'user', id: me.id }, { from: me.username, to: name }, v.ip);
  return null;
}

export const _x = { ilike, gt, getUserByUsername };
