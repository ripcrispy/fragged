/**
 * Centralised permission model.
 *
 * Effective permission for a viewer, optionally within a forum:
 *   1. Super-admin groups → everything.
 *   2. Base: allowed if ANY of the user's groups grants it (guests use the `guest` group).
 *   3. Forum group overrides: if any of the user's groups has an explicit 'allow' → allow,
 *      otherwise an explicit 'deny' from any group → deny.
 *   4. Forum moderators (forum_moderators) receive moderator permissions in that forum.
 *   5. Per-user overrides (global, then forum-specific) win over group settings.
 *   6. Active suspensions/bans strip every permission except read access.
 *   7. Unverified email (when verification is required) strips participation permissions.
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { onBus, send } from './bus.ts';

export const PERMISSIONS = {
  // reading
  'forum.view': 'View forums and threads',
  'member.view': 'View member profiles and directory',
  'search.use': 'Use search',
  // participation
  'thread.create': 'Start new threads',
  'post.reply': 'Reply to threads',
  'post.edit_own': 'Edit own posts',
  'post.delete_own': 'Delete own posts',
  'post.react': 'React to posts',
  'post.attach_images': 'Attach images to posts',
  'post.embed_media': 'Embed external media (YouTube etc.)',
  'tag.create': 'Create new member tags',
  'tag.apply': 'Apply tags to own threads',
  'profile.comment': 'Comment on friends’ profiles',
  'profile.customize': 'Upload avatar/cover and customise profile',
  'message.send': 'Send direct messages',
  'message.attach_images': 'Attach images to direct messages',
  'emoji.submit': 'Submit community emoji',
  'report.create': 'Report content',
  'user.change_username': 'Change own username',
  'user.signature': 'Use a signature',
  // moderation
  'mod.posts': 'Edit/delete/restore any post, view deleted posts',
  'mod.threads': 'Lock, sticky, move, merge, split threads',
  'mod.tags': 'Manage tags on any thread',
  'mod.reports': 'Handle reports',
  'mod.users': 'Warn and suspend users, add moderator notes',
  'mod.ban': 'Permanently ban users',
  'mod.comments': 'Moderate profile comments',
  'mod.emoji': 'Review emoji submissions',
  'mod.terms_review': 'Review restricted-term matches',
  'mod.messages': 'Exceptional audited direct-message handling',
  // administration
  'admin.access': 'Access the administration panel',
  'admin.forums': 'Manage categories and forums',
  'admin.users': 'Manage users and group membership',
  'admin.groups': 'Manage groups and permissions',
  'admin.terms': 'Manage restricted terms and profanity list',
  'admin.settings': 'Manage site settings, registration, uploads, security',
  'admin.emoji': 'Manage emoji library',
  'admin.pages': 'Manage rules and static pages',
  'admin.audit': 'View audit and security logs',
  'admin.auth': 'Manage authentication providers',
  'admin.modules': 'Enable, disable and configure modules',
} as const;
export type CorePerm = keyof typeof PERMISSIONS;
/** Core permissions are typed; module permissions are `<moduleId>.<key>` strings declared in module manifests. */
export type Perm = CorePerm | (string & {});

export const READ_PERMS: Perm[] = ['forum.view', 'member.view', 'search.use'];
export const MOD_PERMS: Perm[] = ['mod.posts', 'mod.threads', 'mod.tags', 'mod.reports', 'mod.comments'];
const PARTICIPATION: Perm[] = ['thread.create', 'post.reply', 'post.edit_own', 'post.delete_own', 'post.react', 'post.attach_images', 'post.embed_media', 'tag.create', 'tag.apply', 'profile.comment', 'profile.customize', 'message.send', 'message.attach_images', 'emoji.submit', 'user.change_username', 'user.signature'];

const all = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
const member: Perm[] = [...READ_PERMS, 'thread.create', 'post.reply', 'post.edit_own', 'post.delete_own', 'post.react', 'post.attach_images', 'post.embed_media', 'tag.apply', 'profile.comment', 'profile.customize', 'message.send', 'message.attach_images', 'report.create', 'user.signature'];
const established: Perm[] = [...member, 'tag.create', 'emoji.submit', 'user.change_username'];

export const DEFAULT_GROUPS = [
  { slug: 'guest', name: 'Guests', color: null, userTitle: null, permissions: all(['forum.view', 'member.view', 'search.use']), isStaff: false, isSuperAdmin: false, priority: 0, displayOrder: 0 },
  { slug: 'member', name: 'Registered Members', color: null, userTitle: 'Member', permissions: all(member), isStaff: false, isSuperAdmin: false, priority: 10, displayOrder: 1 },
  { slug: 'established', name: 'Established Members', color: '#2f6f3e', userTitle: 'Regular', permissions: all(established), isStaff: false, isSuperAdmin: false, priority: 20, displayOrder: 2 },
  { slug: 'contributor', name: 'Contributors', color: '#8a5a00', userTitle: 'Contributor', permissions: all(established), isStaff: false, isSuperAdmin: false, priority: 30, displayOrder: 3 },
  { slug: 'moderator', name: 'Moderators', color: '#1b6fb0', userTitle: 'Moderator', permissions: all([...established, ...MOD_PERMS, 'mod.users', 'mod.emoji', 'mod.terms_review']), isStaff: true, isSuperAdmin: false, priority: 80, displayOrder: 4 },
  { slug: 'admin', name: 'Administrators', color: '#b0261b', userTitle: 'Administrator', permissions: all(Object.keys(PERMISSIONS)), isStaff: true, isSuperAdmin: true, priority: 100, displayOrder: 5 },
] as const;

export type GroupRow = typeof schema.userGroups.$inferSelect;
type Override = typeof schema.permissionOverrides.$inferSelect;

let cache: { groups: GroupRow[]; overrides: Override[]; moderators: { forumId: number; userId: number }[]; at: number } | null = null;
export function invalidatePermissionCache() { cache = null; send('invalidate', { name: 'permissions' }); }
onBus('invalidate', (m: { name: string }) => { if (m.name === 'permissions') cache = null; });

export async function loadPermissionData() {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const db = getDb();
  const [groups, overrides, moderators] = await Promise.all([
    db.select().from(schema.userGroups),
    db.select().from(schema.permissionOverrides),
    db.select().from(schema.forumModerators),
  ]);
  cache = { groups, overrides, moderators, at: Date.now() };
  return cache;
}

export interface PermissionSubject {
  userId: number | null;
  groupIds: number[];
  isSuperAdmin: boolean;
  restricted: boolean; // banned / suspended
  unverified: boolean; // email verification pending and required
}

export async function guestGroupId(): Promise<number> {
  const d = await loadPermissionData();
  return d.groups.find((g) => g.slug === 'guest')!.id;
}

export function computePermission(subject: PermissionSubject, perm: Perm, forumId: number | null, data: NonNullable<typeof cache>): boolean {
  const isRead = (READ_PERMS as string[]).includes(perm);
  if (subject.restricted && !isRead) return false;
  if (subject.unverified && (PARTICIPATION as string[]).includes(perm)) return false;
  if (subject.isSuperAdmin) return true;
  const groups = data.groups.filter((g) => subject.groupIds.includes(g.id));
  let allowed = groups.some((g) => g.permissions[perm]);
  if (forumId != null) {
    const forumOv = data.overrides.filter((o) => o.forumId === forumId && o.groupId != null && subject.groupIds.includes(o.groupId));
    if (forumOv.some((o) => o.permissions[perm] === 'allow')) allowed = true;
    else if (forumOv.some((o) => o.permissions[perm] === 'deny')) allowed = false;
    if (subject.userId && (MOD_PERMS as string[]).includes(perm) && data.moderators.some((m) => m.forumId === forumId && m.userId === subject.userId)) allowed = true;
  }
  if (subject.userId) {
    const g = data.overrides.find((o) => o.forumId == null && o.userId === subject.userId);
    if (g?.permissions[perm]) allowed = g.permissions[perm] === 'allow';
    if (forumId != null) {
      const f = data.overrides.find((o) => o.forumId === forumId && o.userId === subject.userId);
      if (f?.permissions[perm]) allowed = f.permissions[perm] === 'allow';
    }
  }
  return allowed;
}

export async function can(subject: PermissionSubject, perm: Perm, forumId: number | null = null): Promise<boolean> {
  return computePermission(subject, perm, forumId, await loadPermissionData());
}

/** Forum IDs the subject may view (for listings, search and feeds). */
export async function viewableForumIds(subject: PermissionSubject): Promise<number[]> {
  const db = getDb();
  const data = await loadPermissionData();
  const rows = await db.select({ id: schema.forums.id, isHidden: schema.forums.isHidden, parentId: schema.forums.parentForumId, catHidden: schema.categories.isHidden })
    .from(schema.forums).innerJoin(schema.categories, eq(schema.categories.id, schema.forums.categoryId));
  const modView = subject.isSuperAdmin;
  const direct = new Map(rows.map((f) => [f.id, (!(f.isHidden || f.catHidden) || modView) && computePermission(subject, 'forum.view', f.id, data)]));
  // a subforum is only visible when every ancestor is visible (permissions cascade down the tree)
  const parent = new Map(rows.map((f) => [f.id, f.parentId]));
  const visible = (id: number, depth = 0): boolean => {
    if (!direct.get(id) || depth > 16) return false;
    const p = parent.get(id);
    return p == null || visible(p, depth + 1);
  };
  return rows.filter((f) => visible(f.id)).map((f) => f.id);
}

export async function groupBySlug(slug: string) {
  const d = await loadPermissionData();
  return d.groups.find((g) => g.slug === slug) ?? null;
}

export async function ensureDefaultGroups() {
  const db = getDb();
  for (const g of DEFAULT_GROUPS) {
    const existing = await db.select().from(schema.userGroups).where(eq(schema.userGroups.slug, g.slug));
    if (!existing.length) await db.insert(schema.userGroups).values({ ...g, permissions: { ...g.permissions }, isSystem: true });
  }
  invalidatePermissionCache();
}
