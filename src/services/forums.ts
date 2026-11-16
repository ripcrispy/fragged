import { and, asc, desc, eq, inArray, isNull, or, sql, gt, lt, ne, notInArray } from 'drizzle-orm';
import { getDb, schema, type DB } from '../db/client.ts';
import { analyse, excerpt } from '../lib/bbcode.ts';
import { cleanLine, cleanText, slugify } from '../lib/validate.ts';
import { hit, once, DEFAULT_LIMITS } from '../lib/ratelimit.ts';
import { getSetting } from './settings.ts';
import { ServiceError, getUserByUsername, maybePromote } from './users.ts';
import { viewableForumIds } from './permissions.ts';
import { notify } from './notifications.ts';
import { enforcePolicy, linkMatches } from './policy.ts';
import { audit } from './audit.ts';
import { emit, applyFilters } from '../modules/registry.ts';
import { isBlockedEitherWay } from './relationships.ts';
import type { Viewer } from './viewer.ts';

export type Forum = typeof schema.forums.$inferSelect;
export type Category = typeof schema.categories.$inferSelect;
export type Thread = typeof schema.threads.$inferSelect;
export type Post = typeof schema.posts.$inferSelect;
export type Tag = typeof schema.tags.$inferSelect;

export const REACTIONS = [
  { key: 'agree', label: 'Agree', glyph: '👍' },
  { key: 'disagree', label: 'Disagree', glyph: '👎' },
  { key: 'funny', label: 'Funny', glyph: '😂' },
  { key: 'informative', label: 'Informative', glyph: '💡' },
  { key: 'helpful', label: 'Helpful', glyph: '🛠️' },
  { key: 'creative', label: 'Creative', glyph: '🎨' },
  { key: 'winner', label: 'Winner', glyph: '🏆' },
  { key: 'friendly', label: 'Friendly', glyph: '💛' },
] as const;
const REACTION_KEYS = new Set<string>(REACTIONS.map((r) => r.key));

export const WARNING_TAGS = ['spoiler', 'nsfw', 'trigger-warning'];

export async function rateLimit(v: Viewer, action: keyof typeof DEFAULT_LIMITS) {
  const custom = (await getSetting('rate_limits'))[action];
  const limit = custom ?? DEFAULT_LIMITS[action];
  const key = `${action}:${v.user?.id ?? 'ip:' + v.ip}`;
  const r = await hit(key, limit);
  if (!r.ok) throw new ServiceError(`You're doing that too often. Try again in ${r.retryAfter} seconds.`, 429, 'rate_limited');
}

const isMod = (v: Viewer, forumId: number) => v.can('mod.posts', forumId);

// ─────────────────────────── structure ───────────────────────────

export async function forumBySlug(slug: string): Promise<Forum | null> {
  const [f] = await getDb().select().from(schema.forums).where(eq(schema.forums.slug, slug));
  return f ?? null;
}
export async function forumById(id: number): Promise<Forum | null> {
  const [f] = await getDb().select().from(schema.forums).where(eq(schema.forums.id, id));
  return f ?? null;
}

export async function assertForumVisible(v: Viewer, forum: Forum | null): Promise<Forum> {
  if (!forum) throw new ServiceError('Forum not found.', 404);
  if (forum.isHidden && !v.subject.isSuperAdmin) throw new ServiceError('Forum not found.', 404);
  // single source of truth: includes hidden categories and permissions inherited from parent forums
  if (!(await viewableForumIds(v.subject)).includes(forum.id)) throw new ServiceError(v.user ? 'You do not have permission to view this forum.' : 'You need to sign in to view this forum.', v.user ? 403 : 401, v.user ? 'forbidden' : 'login_required');
  return forum;
}

/** Ancestors for breadcrumbs: category, parent forums. */
export async function forumTrail(forum: Forum): Promise<{ category: Category; parents: Forum[] }> {
  const db = getDb();
  const [category] = await db.select().from(schema.categories).where(eq(schema.categories.id, forum.categoryId));
  const parents: Forum[] = [];
  let pid = forum.parentForumId;
  let guard = 0;
  while (pid && guard++ < 8) {
    const p = await forumById(pid);
    if (!p) break;
    parents.unshift(p);
    pid = p.parentForumId;
  }
  return { category, parents };
}

export interface ForumListing { forum: Forum; subforums: Forum[]; unread: boolean; lastThread: { id: number; title: string; slug: string } | null; viewing: number }

/** Homepage index: categories → forums (with subforums, latest activity, unread state). */
export async function forumIndex(v: Viewer): Promise<{ category: Category; forums: ForumListing[] }[]> {
  const db = getDb();
  const visible = new Set(await viewableForumIds(v.subject));
  const cats = await db.select().from(schema.categories).where(v.subject.isSuperAdmin ? sql`true` : eq(schema.categories.isHidden, false)).orderBy(asc(schema.categories.displayOrder), asc(schema.categories.id));
  const all = (await db.select().from(schema.forums).orderBy(asc(schema.forums.displayOrder), asc(schema.forums.id))).filter((f) => visible.has(f.id));
  const lastIds = all.map((f) => f.lastThreadId).filter((x): x is number => !!x);
  const lastThreads = lastIds.length ? await db.select({ id: schema.threads.id, title: schema.threads.title, slug: schema.threads.slug }).from(schema.threads).where(inArray(schema.threads.id, lastIds)) : [];
  const unread = await unreadForumIds(v, all.map((f) => f.id));
  const out = cats.map((category) => {
    const top = all.filter((f) => f.categoryId === category.id && !f.parentForumId);
    return {
      category,
      forums: top.map((forum) => {
        const subs = all.filter((s) => s.parentForumId === forum.id);
        // aggregate latest activity of subforums into the parent row
        let latest = forum;
        for (const s of subs) if (s.lastPostAt && (!latest.lastPostAt || s.lastPostAt > latest.lastPostAt)) latest = s;
        return {
          forum: { ...forum, threadCount: forum.threadCount + subs.reduce((a, s) => a + s.threadCount, 0), postCount: forum.postCount + subs.reduce((a, s) => a + s.postCount, 0), lastPostAt: latest.lastPostAt, lastPostUserId: latest.lastPostUserId, lastThreadId: latest.lastThreadId },
          subforums: subs,
          unread: unread.has(forum.id) || subs.some((s) => unread.has(s.id)),
          lastThread: lastThreads.find((t) => t.id === latest.lastThreadId) ?? null,
          viewing: 0,
        };
      }),
    };
  }).filter((c) => c.forums.length);
  return out;
}

const UNREAD_WINDOW_DAYS = 30;

async function unreadForumIds(v: Viewer, forumIds: number[]): Promise<Set<number>> {
  if (!v.user || !forumIds.length) return new Set();
  const uid = v.user.id;
  const rows = await getDb().execute(sql`
    select distinct t.forum_id from threads t
    left join thread_reads r on r.thread_id = t.id and r.user_id = ${uid}
    left join forum_reads fr on fr.forum_id = t.forum_id and fr.user_id = ${uid}
    where t.forum_id in (${sql.join(forumIds.map((i) => sql`${i}`), sql`, `)})
      and not t.is_deleted and t.state = 'visible'
      and t.last_post_at > now() - interval '${sql.raw(String(UNREAD_WINDOW_DAYS))} days'
      and t.last_post_at > ${v.user.createdAt}
      and (fr.marked_at is null or t.last_post_at > fr.marked_at)
      and (r.last_read_position is null or r.last_read_position < t.last_position)`);
  return new Set(((rows as any).rows ?? rows).map((r: any) => Number(r.forum_id)));
}

export async function markForumRead(v: Viewer, forumId: number) {
  if (!v.user) return;
  await getDb().insert(schema.forumReads).values({ userId: v.user.id, forumId, markedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.forumReads.userId, schema.forumReads.forumId], set: { markedAt: new Date() } });
}

// ─────────────────────────── thread listing ───────────────────────────

export type ThreadSort = 'last_post' | 'created' | 'title' | 'replies' | 'views';
export interface ThreadRow extends Thread { tags: Tag[]; unread: boolean; firstUnreadPosition: number | null; hiddenReason: 'nsfw' | 'trigger' | null }

export async function tagsForThreads(ids: number[]): Promise<Map<number, Tag[]>> {
  const map = new Map<number, Tag[]>();
  if (!ids.length) return map;
  const rows = await getDb().select({ threadId: schema.threadTags.threadId, tag: schema.tags }).from(schema.threadTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.threadTags.tagId)).where(and(inArray(schema.threadTags.threadId, ids), eq(schema.tags.isDisabled, false)));
  for (const r of rows) map.set(r.threadId, [...(map.get(r.threadId) ?? []), r.tag]);
  for (const [k, t] of map) map.set(k, t.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'warning' ? -1 : 1)));
  return map;
}

async function decorateThreads(v: Viewer, list: Thread[]): Promise<ThreadRow[]> {
  const tagMap = await tagsForThreads(list.map((t) => t.id));
  let reads = new Map<number, number>();
  let forumMarks = new Map<number, Date>();
  if (v.user && list.length) {
    const rr = await getDb().select().from(schema.threadReads).where(and(eq(schema.threadReads.userId, v.user.id), inArray(schema.threadReads.threadId, list.map((t) => t.id))));
    reads = new Map(rr.map((r) => [r.threadId, r.lastReadPosition]));
    const fm = await getDb().select().from(schema.forumReads).where(eq(schema.forumReads.userId, v.user.id));
    forumMarks = new Map(fm.map((r) => [r.forumId, r.markedAt]));
  }
  const cutoff = Date.now() - UNREAD_WINDOW_DAYS * 86400_000;
  return list.map((t) => {
    const tags = tagMap.get(t.id) ?? [];
    let unread = false, firstUnread: number | null = null;
    if (v.user) {
      const read = reads.get(t.id);
      const mark = forumMarks.get(t.forumId);
      const recent = t.lastPostAt.getTime() > cutoff && t.lastPostAt > v.user.createdAt && (!mark || t.lastPostAt > mark);
      if (recent && (read == null || read < t.lastPosition)) { unread = true; firstUnread = (read ?? 0) + 1; }
    }
    const slugs = tags.map((x) => x.slug);
    let hiddenReason: ThreadRow['hiddenReason'] = null;
    if (slugs.includes('nsfw') && v.settings.nsfwMode === 'hide') hiddenReason = 'nsfw';
    else if (slugs.includes('trigger-warning') && v.settings.triggerMode === 'hide') hiddenReason = 'trigger';
    return { ...t, tags, unread, firstUnreadPosition: firstUnread, hiddenReason };
  });
}

function visibleThreadCond(v: Viewer, canMod: boolean) {
  if (canMod) return sql`true`;
  const uid = v.user?.id ?? -1;
  return and(eq(schema.threads.isDeleted, false), or(eq(schema.threads.state, 'visible'), eq(schema.threads.userId, uid)));
}

export async function listThreads(v: Viewer, forum: Forum, opts: { page?: number; sort?: ThreadSort; order?: 'asc' | 'desc'; tag?: string | null; prefixUnread?: boolean }) {
  const db = getDb();
  const perPage = await getSetting('threads_per_page');
  const canMod = await v.can('mod.threads', forum.id);
  const conds = [eq(schema.threads.forumId, forum.id), visibleThreadCond(v, canMod), isNull(schema.threads.movedToThreadId)];
  let tagRow: Tag | null = null;
  if (opts.tag) {
    [tagRow] = await db.select().from(schema.tags).where(eq(schema.tags.slug, opts.tag));
    if (tagRow) conds.push(sql`exists (select 1 from thread_tags tt where tt.thread_id = ${schema.threads.id} and tt.tag_id = ${tagRow.id})`);
  }
  const where = and(...conds);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.threads).where(and(where, eq(schema.threads.isSticky, false), eq(schema.threads.isAnnouncement, false)));
  const pages = Math.max(1, Math.ceil(n / perPage));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const dir = opts.order === 'asc' ? asc : desc;
  const col = { last_post: schema.threads.lastPostAt, created: schema.threads.createdAt, title: schema.threads.title, replies: schema.threads.replyCount, views: schema.threads.viewCount }[opts.sort ?? 'last_post'] ?? schema.threads.lastPostAt;
  const pinned = page === 1 ? await db.select().from(schema.threads).where(and(where, or(eq(schema.threads.isSticky, true), eq(schema.threads.isAnnouncement, true)))).orderBy(desc(schema.threads.isAnnouncement), desc(schema.threads.lastPostAt)) : [];
  const rows = await db.select().from(schema.threads).where(and(where, eq(schema.threads.isSticky, false), eq(schema.threads.isAnnouncement, false)))
    .orderBy(dir(col), desc(schema.threads.id)).limit(perPage).offset((page - 1) * perPage);
  return { pinned: await decorateThreads(v, pinned), threads: await decorateThreads(v, rows), page, pages, total: n, perPage, tag: tagRow };
}

export async function subforumsOf(v: Viewer, forum: Forum): Promise<ForumListing[]> {
  const visible = new Set(await viewableForumIds(v.subject));
  const subs = (await getDb().select().from(schema.forums).where(eq(schema.forums.parentForumId, forum.id)).orderBy(asc(schema.forums.displayOrder))).filter((f) => visible.has(f.id));
  const lastIds = subs.map((f) => f.lastThreadId).filter((x): x is number => !!x);
  const lastThreads = lastIds.length ? await getDb().select({ id: schema.threads.id, title: schema.threads.title, slug: schema.threads.slug }).from(schema.threads).where(inArray(schema.threads.id, lastIds)) : [];
  const unread = await unreadForumIds(v, subs.map((s) => s.id));
  return subs.map((f) => ({ forum: f, subforums: [], unread: unread.has(f.id), lastThread: lastThreads.find((t) => t.id === f.lastThreadId) ?? null, viewing: 0 }));
}

/** What's New: recently active threads across forums the viewer may see. */
export async function recentThreads(v: Viewer, opts: { page?: number; limit?: number; unreadOnly?: boolean } = {}) {
  const ids = await viewableForumIds(v.subject);
  if (!ids.length) return { threads: [], page: 1, pages: 1 };
  const limit = opts.limit ?? 30;
  const page = Math.max(1, opts.page ?? 1);
  const rows = await getDb().select().from(schema.threads)
    .where(and(inArray(schema.threads.forumId, ids), eq(schema.threads.isDeleted, false), eq(schema.threads.state, 'visible'), isNull(schema.threads.movedToThreadId)))
    .orderBy(desc(schema.threads.lastPostAt)).limit(limit + 1).offset((page - 1) * limit);
  let list = await decorateThreads(v, rows.slice(0, limit));
  if (opts.unreadOnly) list = list.filter((t) => t.unread);
  return { threads: list, page, pages: rows.length > limit ? page + 1 : page };
}

// ─────────────────────────── tags ───────────────────────────

export async function allTags(includeDisabled = false) {
  return getDb().select().from(schema.tags).where(includeDisabled ? sql`true` : eq(schema.tags.isDisabled, false)).orderBy(asc(schema.tags.kind), asc(schema.tags.name));
}

const TAG_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '&+.-]{0,30}$/u;

/** Resolve tag names to tag ids, creating member tags when permitted. */
export async function resolveTags(v: Viewer, forum: Forum, names: string[], tx: DB = getDb()): Promise<number[]> {
  const max = await getSetting('max_tags_per_thread');
  const clean = [...new Set(names.map((n) => cleanLine(n, 32)).filter(Boolean))];
  if (clean.length > max + WARNING_TAGS.length) throw new ServiceError(`At most ${max} tags per thread.`);
  const ids: number[] = [];
  let topicCount = 0;
  for (const name of clean) {
    const slug = slugify(name, 40);
    const [existing] = await tx.select().from(schema.tags).where(eq(schema.tags.slug, slug));
    if (existing) {
      if (existing.isDisabled) throw new ServiceError(`The tag "${existing.name}" is not available.`);
      if (existing.kind !== 'warning' && ++topicCount > max) throw new ServiceError(`At most ${max} topic tags per thread.`);
      ids.push(existing.id);
      continue;
    }
    // new member-created tag
    if (!forum.allowUserTags) throw new ServiceError('This forum only allows predefined tags.');
    if (!(await v.can('tag.create', forum.id))) throw new ServiceError(`You can't create new tags yet. Choose from existing tags.`, 403);
    const minPosts = await getSetting('user_tag_min_posts');
    if ((v.user?.postCount ?? 0) < minPosts && !(await v.can('mod.tags', forum.id))) throw new ServiceError(`You need ${minPosts} posts before creating new tags.`, 403);
    if (!TAG_NAME_RE.test(name)) throw new ServiceError(`"${name}" is not a valid tag name.`);
    if (++topicCount > max) throw new ServiceError(`At most ${max} topic tags per thread.`);
    await enforcePolicy(name, { userId: v.user!.id, contentType: 'tag' });
    const [created] = await tx.insert(schema.tags).values({ name, slug, kind: 'topic', isOfficial: false, createdById: v.user!.id }).onConflictDoNothing().returning();
    const id = created?.id ?? (await tx.select().from(schema.tags).where(eq(schema.tags.slug, slug)))[0].id;
    ids.push(id);
  }
  return ids;
}

export async function setThreadTags(v: Viewer, thread: Thread, names: string[]) {
  const forum = (await forumById(thread.forumId))!;
  const own = v.user?.id === thread.userId && (await v.can('tag.apply', forum.id));
  if (!own && !(await v.can('mod.tags', forum.id))) throw new ServiceError('You cannot change tags on this thread.', 403);
  await getDb().transaction(async (tx) => {
    const ids = await resolveTags(v, forum, names, tx as any);
    await tx.delete(schema.threadTags).where(eq(schema.threadTags.threadId, thread.id));
    if (ids.length) await tx.insert(schema.threadTags).values(ids.map((tagId) => ({ threadId: thread.id, tagId })));
  });
  if (!own) await audit(v.user!.id, 'thread.tags', { type: 'thread', id: thread.id }, { tags: names }, v.ip);
}

// ─────────────────────────── threads & posts ───────────────────────────

export async function threadById(id: number): Promise<Thread | null> {
  const [t] = await getDb().select().from(schema.threads).where(eq(schema.threads.id, id));
  return t ?? null;
}

export async function loadThreadFor(v: Viewer, id: number): Promise<{ thread: Thread; forum: Forum }> {
  const thread = await threadById(id);
  if (!thread) throw new ServiceError('Thread not found.', 404);
  const forum = await assertForumVisible(v, await forumById(thread.forumId));
  const canMod = await v.can('mod.threads', forum.id) || await v.can('mod.posts', forum.id);
  if ((thread.isDeleted || (thread.state === 'held' && thread.userId !== v.user?.id)) && !canMod) throw new ServiceError('Thread not found.', 404);
  return { thread, forum };
}

async function postingChecks(v: Viewer, forum: Forum) {
  if (forum.isArchived && !(await v.can('mod.threads', forum.id))) throw new ServiceError('This forum is archived and no longer accepts new posts.', 403);
}

async function validateBody(v: Viewer, forumId: number, body: string, kind: 'thread' | 'reply' | 'edit') {
  // modules may transform or reject content (throwing ServiceError) before core validation
  const filtered = await applyFilters('post.beforeSave', { body: cleanText(body, 50_000), userId: v.user?.id ?? 0, forumId, kind });
  const text = cleanText(filtered.body, 50_000).trim();
  if (text.length < 2) throw new ServiceError('Your post is too short.');
  if (text.length > 30_000) throw new ServiceError('Your post is too long (30,000 characters maximum).');
  if (/\[(media|video|youtube)\]/i.test(text) && !(await v.can('post.embed_media', forumId))) throw new ServiceError('You cannot embed media in this forum.', 403);
  return text;
}

async function attachUploads(v: Viewer, postId: number, uploadIds: string[], tx: DB, forumId: number) {
  if (!uploadIds.length) return;
  if (!(await v.can('post.attach_images', forumId))) throw new ServiceError('You cannot attach images here.', 403);
  const limit = ((await getSetting('upload_limits')).post as any).perPost ?? 6;
  const rows = await tx.select().from(schema.uploads).where(and(inArray(schema.uploads.publicId, uploadIds.slice(0, 20)), eq(schema.uploads.userId, v.user!.id), eq(schema.uploads.purpose, 'post')));
  if (rows.length > limit) throw new ServiceError(`At most ${limit} images per post.`);
  if (rows.length) await tx.insert(schema.postAttachments).values(rows.map((u) => ({ postId, uploadId: u.id }))).onConflictDoNothing();
}

export interface NewThreadInput { title: string; body: string; tags?: string[]; uploads?: string[] }

export async function createThread(v: Viewer, forum: Forum, input: NewThreadInput): Promise<{ thread: Thread; post: Post }> {
  await assertForumVisible(v, forum);
  await v.require('thread.create', forum.id);
  await postingChecks(v, forum);
  await rateLimit(v, 'thread');
  const title = cleanLine(input.title, 140);
  if (title.length < 3) throw new ServiceError('Thread titles must be at least 3 characters.');
  const body = await validateBody(v, forum.id, input.body, 'thread');
  const user = v.user!;
  const p1 = await enforcePolicy(title, { userId: user.id, contentType: 'thread' });
  const p2 = await enforcePolicy(body, { userId: user.id, contentType: 'post' });
  const held = p1.held || p2.held;
  const result = await getDb().transaction(async (tx) => {
    const [thread] = await tx.insert(schema.threads).values({
      forumId: forum.id, userId: user.id, title, slug: slugify(title), state: held ? 'held' : 'visible', lastPosition: 1, lastPostAt: new Date(), lastPostUserId: user.id,
    }).returning();
    const [post] = await tx.insert(schema.posts).values({ threadId: thread.id, userId: user.id, position: 1, body, state: held ? 'held' : 'visible', ip: v.ip }).returning();
    await tx.update(schema.threads).set({ firstPostId: post.id, lastPostId: post.id }).where(eq(schema.threads.id, thread.id));
    if (input.tags?.length) {
      const tagIds = await resolveTags(v, forum, input.tags, tx as any);
      if (tagIds.length) await tx.insert(schema.threadTags).values(tagIds.map((tagId) => ({ threadId: thread.id, tagId })));
    }
    await attachUploads(v, post.id, input.uploads ?? [], tx as any, forum.id);
    await tx.insert(schema.threadSubscriptions).values({ userId: user.id, threadId: thread.id }).onConflictDoNothing();
    await tx.insert(schema.threadReads).values({ userId: user.id, threadId: thread.id, lastReadPosition: 1 }).onConflictDoNothing();
    if (!held) {
      await tx.update(schema.users).set({ postCount: sql`${schema.users.postCount} + 1`, threadCount: sql`${schema.users.threadCount} + 1` }).where(eq(schema.users.id, user.id));
      await tx.update(schema.forums).set({ threadCount: sql`${schema.forums.threadCount} + 1`, postCount: sql`${schema.forums.postCount} + 1`, lastThreadId: thread.id, lastPostId: post.id, lastPostAt: post.createdAt, lastPostUserId: user.id }).where(eq(schema.forums.id, forum.id));
    }
    await tx.delete(schema.drafts).where(and(eq(schema.drafts.userId, user.id), eq(schema.drafts.key, `thread:${forum.id}`)));
    return { thread: { ...thread, firstPostId: post.id, lastPostId: post.id }, post };
  });
  if (p1.decision.action || p2.decision.action) { await linkMatches(user.id, 'post', result.post.id); await linkMatches(user.id, 'thread', result.thread.id); }
  if (!held) {
    await afterPostSideEffects(v, result.thread, result.post);
    await emit('thread.created', { threadId: result.thread.id, forumId: forum.id, userId: user.id, postId: result.post.id });
    await emit('post.created', { postId: result.post.id, threadId: result.thread.id, forumId: forum.id, userId: user.id, position: 1 });
  }
  return result;
}

export async function reply(v: Viewer, threadId: number, bodyIn: string, uploads: string[] = []): Promise<Post> {
  const { thread, forum } = await loadThreadFor(v, threadId);
  await v.require('post.reply', forum.id);
  await postingChecks(v, forum);
  if (thread.isLocked && !(await v.can('mod.threads', forum.id))) throw new ServiceError('This thread is locked.', 403, 'locked');
  if (thread.isDeleted) throw new ServiceError('This thread has been deleted.', 403);
  await rateLimit(v, 'post');
  const body = await validateBody(v, forum.id, bodyIn, 'reply');
  const user = v.user!;
  const pol = await enforcePolicy(body, { userId: user.id, contentType: 'post' });
  const held = pol.held || thread.state === 'held';
  const post = await getDb().transaction(async (tx) => {
    // allocate the next stable post number atomically
    const [t] = await tx.update(schema.threads).set({ lastPosition: sql`${schema.threads.lastPosition} + 1` }).where(eq(schema.threads.id, thread.id)).returning({ pos: schema.threads.lastPosition });
    const [p] = await tx.insert(schema.posts).values({ threadId: thread.id, userId: user.id, position: t.pos, body, state: held ? 'held' : 'visible', ip: v.ip }).returning();
    await attachUploads(v, p.id, uploads, tx as any, forum.id);
    if (!held) {
      await tx.update(schema.threads).set({ replyCount: sql`${schema.threads.replyCount} + 1`, lastPostId: p.id, lastPostAt: p.createdAt, lastPostUserId: user.id }).where(eq(schema.threads.id, thread.id));
      await tx.update(schema.users).set({ postCount: sql`${schema.users.postCount} + 1` }).where(eq(schema.users.id, user.id));
      await tx.update(schema.forums).set({ postCount: sql`${schema.forums.postCount} + 1`, lastThreadId: thread.id, lastPostId: p.id, lastPostAt: p.createdAt, lastPostUserId: user.id }).where(eq(schema.forums.id, forum.id));
    }
    await tx.insert(schema.threadReads).values({ userId: user.id, threadId: thread.id, lastReadPosition: t.pos })
      .onConflictDoUpdate({ target: [schema.threadReads.userId, schema.threadReads.threadId], set: { lastReadPosition: sql`greatest(${schema.threadReads.lastReadPosition}, ${t.pos})`, readAt: new Date() } });
    await tx.delete(schema.drafts).where(and(eq(schema.drafts.userId, user.id), eq(schema.drafts.key, `reply:${thread.id}`)));
    return p;
  });
  if (pol.decision.action) await linkMatches(user.id, 'post', post.id);
  if (!held) {
    await afterPostSideEffects(v, thread, post);
    await emit('post.created', { postId: post.id, threadId: thread.id, forumId: forum.id, userId: user.id, position: post.position });
  }
  return post;
}

/** Notifications (subscribers, mentions, quotes), promotion and achievements after a visible post. */
async function afterPostSideEffects(v: Viewer, thread: Thread, post: Post) {
  const db = getDb();
  const author = v.user!;
  const facts = analyse(post.body);
  const notified = new Set<number>([author.id]);
  const short = excerpt(post.body, 100);
  const url = `/p/${post.id}`;
  const visibleTo = async (uid: number) => {
    const { userCan } = await import('./users.ts');
    return userCan(uid, 'forum.view', thread.forumId);
  };
  // quotes
  if (facts.quotedPostIds.length) {
    const quoted = await db.select({ userId: schema.posts.userId }).from(schema.posts).where(and(inArray(schema.posts.id, facts.quotedPostIds), eq(schema.posts.threadId, thread.id)));
    for (const q of quoted) {
      if (notified.has(q.userId)) continue;
      notified.add(q.userId);
      if (await visibleTo(q.userId)) await notify(q.userId, 'quote', author.id, `${author.username} quoted you in "${thread.title}": ${short}`, url);
    }
  }
  // mentions
  for (const name of facts.mentions.slice(0, 10)) {
    const u = await getUserByUsername(name);
    if (!u || notified.has(u.id) || u.closedAt) continue;
    notified.add(u.id);
    if (await visibleTo(u.id)) await notify(u.id, 'mention', author.id, `${author.username} mentioned you in "${thread.title}": ${short}`, url);
  }
  // subscribers
  if (post.position > 1) {
    const subs = await db.select({ userId: schema.threadSubscriptions.userId }).from(schema.threadSubscriptions).where(eq(schema.threadSubscriptions.threadId, thread.id));
    for (const s of subs) {
      if (notified.has(s.userId)) continue;
      notified.add(s.userId);
      if (await visibleTo(s.userId)) await notify(s.userId, 'reply', author.id, `${author.username} replied to "${thread.title}": ${short}`, url);
    }
  }
  await maybePromote(author.id);
}

export async function postById(id: number): Promise<Post | null> {
  const [p] = await getDb().select().from(schema.posts).where(eq(schema.posts.id, id));
  return p ?? null;
}

export async function loadPostFor(v: Viewer, id: number) {
  const post = await postById(id);
  if (!post) throw new ServiceError('Post not found.', 404);
  const { thread, forum } = await loadThreadFor(v, post.threadId);
  const mod = await isMod(v, forum.id);
  if ((post.isDeleted || (post.state === 'held' && post.userId !== v.user?.id)) && !mod) throw new ServiceError('Post not found.', 404);
  return { post, thread, forum, mod };
}

export interface PostView extends Post { attachments: { publicId: string; width: number; height: number }[]; reactions: { key: string; count: number; mine: boolean }[] }

export async function listPosts(v: Viewer, thread: Thread, forum: Forum, page: number) {
  const db = getDb();
  const perPage = v.user ? v.settings.postsPerPage : await getSetting('posts_per_page');
  const mod = await isMod(v, forum.id);
  const uid = v.user?.id ?? -1;
  const cond = mod ? eq(schema.posts.threadId, thread.id) : and(eq(schema.posts.threadId, thread.id), eq(schema.posts.isDeleted, false), or(eq(schema.posts.state, 'visible'), eq(schema.posts.userId, uid)));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.posts).where(cond);
  const pages = Math.max(1, Math.ceil(n / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await db.select().from(schema.posts).where(cond).orderBy(asc(schema.posts.position)).limit(perPage).offset((p - 1) * perPage);
  return { posts: await decoratePosts(v, rows), page: p, pages, total: n, perPage, mod };
}

export async function decoratePosts(v: Viewer, rows: Post[]): Promise<PostView[]> {
  const db = getDb();
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const att = await db.select({ postId: schema.postAttachments.postId, publicId: schema.uploads.publicId, width: schema.uploads.width, height: schema.uploads.height })
    .from(schema.postAttachments).innerJoin(schema.uploads, eq(schema.uploads.id, schema.postAttachments.uploadId)).where(inArray(schema.postAttachments.postId, ids));
  const reacts = await db.select({ postId: schema.postReactions.postId, reaction: schema.postReactions.reaction, n: sql<number>`count(*)::int`, mine: sql<boolean>`bool_or(${schema.postReactions.userId} = ${v.user?.id ?? -1})` })
    .from(schema.postReactions).where(inArray(schema.postReactions.postId, ids)).groupBy(schema.postReactions.postId, schema.postReactions.reaction);
  return rows.map((r) => ({
    ...r,
    attachments: att.filter((a) => a.postId === r.id).map(({ publicId, width, height }) => ({ publicId, width, height })),
    reactions: REACTIONS.map((x) => {
      const m = reacts.find((y) => y.postId === r.id && y.reaction === x.key);
      return { key: x.key, count: m?.n ?? 0, mine: !!m?.mine };
    }).filter((x) => x.count > 0),
  }));
}

/** Locate a post's page for permalinks. */
export async function pageOfPost(v: Viewer, post: Post, forumId: number): Promise<number> {
  const perPage = v.user ? v.settings.postsPerPage : await getSetting('posts_per_page');
  const mod = await isMod(v, forumId);
  const uid = v.user?.id ?? -1;
  const base = mod ? eq(schema.posts.threadId, post.threadId) : and(eq(schema.posts.threadId, post.threadId), eq(schema.posts.isDeleted, false), or(eq(schema.posts.state, 'visible'), eq(schema.posts.userId, uid)));
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.posts).where(and(base, lt(schema.posts.position, post.position)));
  return Math.floor(n / perPage) + 1;
}

export async function recordView(v: Viewer, thread: Thread, lastSeenPosition: number) {
  // one view per reader per thread per ~30 minutes (shared across instances when running on PostgreSQL)
  if (await once(`view:${v.user?.id ?? v.ip}:${thread.id}`, 1800)) {
    await getDb().update(schema.threads).set({ viewCount: sql`${schema.threads.viewCount} + 1` }).where(eq(schema.threads.id, thread.id));
  }
  if (v.user && lastSeenPosition > 0) {
    await getDb().insert(schema.threadReads).values({ userId: v.user.id, threadId: thread.id, lastReadPosition: lastSeenPosition })
      .onConflictDoUpdate({ target: [schema.threadReads.userId, schema.threadReads.threadId], set: { lastReadPosition: sql`greatest(${schema.threadReads.lastReadPosition}, ${lastSeenPosition})`, readAt: new Date() } });
  }
}

export async function editPost(v: Viewer, postId: number, bodyIn: string, title?: string | null) {
  const { post, thread, forum, mod } = await loadPostFor(v, postId);
  const own = v.user?.id === post.userId;
  if (!mod) {
    if (!own) throw new ServiceError('You can only edit your own posts.', 403);
    await v.require('post.edit_own', forum.id);
    if (thread.isLocked) throw new ServiceError('This thread is locked.', 403, 'locked');
    if (post.isDeleted) throw new ServiceError('This post has been deleted.', 403);
    const win = await getSetting('edit_window_minutes');
    if (win > 0 && Date.now() - post.createdAt.getTime() > win * 60_000) throw new ServiceError(`Posts can only be edited within ${win} minutes.`, 403);
  }
  const body = await validateBody(v, forum.id, bodyIn, 'edit');
  const pol = await enforcePolicy(body, { userId: v.user!.id, contentType: 'post', contentId: post.id });
  const db = getDb();
  await db.transaction(async (tx) => {
    if (body !== post.body) {
      await tx.insert(schema.postRevisions).values({ postId: post.id, body: post.body, editedById: v.user!.id });
      await tx.update(schema.posts).set({ body, editCount: post.editCount + 1, editedAt: new Date(), editedById: v.user!.id, state: pol.held && !mod ? 'held' : post.state }).where(eq(schema.posts.id, post.id));
    }
    if (title != null && post.position === 1) {
      const t = cleanLine(title, 140);
      if (t.length < 3) throw new ServiceError('Thread titles must be at least 3 characters.');
      if (t !== thread.title) {
        await enforcePolicy(t, { userId: v.user!.id, contentType: 'thread', contentId: thread.id });
        await tx.update(schema.threads).set({ title: t, slug: slugify(t) }).where(eq(schema.threads.id, thread.id));
      }
    }
  });
  if (!own) await audit(v.user!.id, 'post.edit', { type: 'post', id: post.id }, { threadId: thread.id }, v.ip);
  if (pol.held && !mod && post.state === 'visible') await recountThread(thread.id);
}

export async function postRevisions(v: Viewer, postId: number) {
  const { post } = await loadPostFor(v, postId);
  const revs = await getDb().select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, postId)).orderBy(desc(schema.postRevisions.createdAt));
  return { post, revisions: revs };
}

export async function deletePost(v: Viewer, postId: number, reason = '') {
  const { post, thread, forum, mod } = await loadPostFor(v, postId);
  const own = v.user?.id === post.userId;
  if (!mod) {
    if (!own) throw new ServiceError('You can only delete your own posts.', 403);
    await v.require('post.delete_own', forum.id);
    if (thread.isLocked) throw new ServiceError('This thread is locked.', 403, 'locked');
    const win = await getSetting('delete_window_minutes');
    if (win > 0 && Date.now() - post.createdAt.getTime() > win * 60_000) throw new ServiceError(`Posts can only be deleted within ${win} minutes of posting. Ask a moderator for help.`, 403);
    if (post.position === 1 && thread.replyCount > 0) throw new ServiceError('You cannot delete the opening post of a thread that has replies.', 403);
  }
  const db = getDb();
  await db.update(schema.posts).set({ isDeleted: true, deletedById: v.user!.id, deletedReason: cleanLine(reason, 300) || null }).where(eq(schema.posts.id, post.id));
  if (post.position === 1) await db.update(schema.threads).set({ isDeleted: true, deletedById: v.user!.id }).where(eq(schema.threads.id, thread.id));
  await recountThread(thread.id);
  await recountForum(forum.id);
  await recountUser(post.userId);
  if (!own || mod) await audit(v.user!.id, 'post.delete', { type: 'post', id: post.id }, { threadId: thread.id, reason, own }, v.ip);
  return { threadDeleted: post.position === 1 };
}

export async function restorePost(v: Viewer, postId: number) {
  const { post, thread, forum, mod } = await loadPostFor(v, postId);
  if (!mod) throw new ServiceError('You do not have permission to do that.', 403);
  const db = getDb();
  await db.update(schema.posts).set({ isDeleted: false, deletedById: null, deletedReason: null }).where(eq(schema.posts.id, post.id));
  if (post.position === 1) await db.update(schema.threads).set({ isDeleted: false, deletedById: null }).where(eq(schema.threads.id, thread.id));
  await recountThread(thread.id); await recountForum(forum.id); await recountUser(post.userId);
  await audit(v.user!.id, 'post.restore', { type: 'post', id: post.id }, {}, v.ip);
}

/** Approve a held post/thread. */
export async function approvePost(v: Viewer, postId: number) {
  const { post, thread, forum, mod } = await loadPostFor(v, postId);
  if (!mod) throw new ServiceError('You do not have permission to do that.', 403);
  const db = getDb();
  await db.update(schema.posts).set({ state: 'visible' }).where(eq(schema.posts.id, post.id));
  if (post.position === 1 && thread.state === 'held') {
    await db.update(schema.threads).set({ state: 'visible' }).where(eq(schema.threads.id, thread.id));
    await db.update(schema.posts).set({ state: 'visible' }).where(and(eq(schema.posts.threadId, thread.id), eq(schema.posts.state, 'held'), eq(schema.posts.userId, thread.userId)));
  }
  await recountThread(thread.id); await recountForum(forum.id); await recountUser(post.userId);
  await audit(v.user!.id, 'post.approve', { type: 'post', id: post.id }, {}, v.ip);
  await notify(post.userId, 'moderation', v.user!.id, `Your post in "${thread.title}" was approved.`, `/p/${post.id}`);
}

export async function react(v: Viewer, postId: number, reaction: string): Promise<{ active: boolean }> {
  const { post, forum } = await loadPostFor(v, postId);
  await v.require('post.react', forum.id);
  if (!REACTION_KEYS.has(reaction)) throw new ServiceError('Unknown reaction.');
  if (post.userId === v.user!.id) throw new ServiceError('You cannot react to your own post.');
  if (await isBlockedEitherWay(post.userId, v.user!.id)) throw new ServiceError('You cannot react to this post.', 403);
  const db = getDb();
  const del = await db.delete(schema.postReactions).where(and(eq(schema.postReactions.postId, postId), eq(schema.postReactions.userId, v.user!.id), eq(schema.postReactions.reaction, reaction))).returning();
  if (del.length) {
    await db.update(schema.users).set({ reactionsReceived: sql`greatest(0, ${schema.users.reactionsReceived} - 1)` }).where(eq(schema.users.id, post.userId));
    await emit('post.reacted', { postId, authorId: post.userId, userId: v.user!.id, reaction, added: false });
    return { active: false };
  }
  // at most 3 different reactions per member per post (prevents reaction spam)
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.postReactions).where(and(eq(schema.postReactions.postId, postId), eq(schema.postReactions.userId, v.user!.id)));
  if (n >= 3) throw new ServiceError('You can add at most 3 reactions to a post.');
  await db.insert(schema.postReactions).values({ postId, userId: v.user!.id, reaction }).onConflictDoNothing();
  await db.update(schema.users).set({ reactionsReceived: sql`${schema.users.reactionsReceived} + 1` }).where(eq(schema.users.id, post.userId));
  await emit('post.reacted', { postId, authorId: post.userId, userId: v.user!.id, reaction, added: true });
  return { active: true };
}

export async function reactionList(v: Viewer, postId: number) {
  await loadPostFor(v, postId);
  return getDb().select({ reaction: schema.postReactions.reaction, username: schema.users.username }).from(schema.postReactions)
    .innerJoin(schema.users, eq(schema.users.id, schema.postReactions.userId)).where(eq(schema.postReactions.postId, postId)).orderBy(schema.postReactions.reaction);
}

export async function toggleSubscription(v: Viewer, threadId: number, on: boolean) {
  await loadThreadFor(v, threadId);
  const db = getDb();
  if (on) await db.insert(schema.threadSubscriptions).values({ userId: v.user!.id, threadId }).onConflictDoNothing();
  else await db.delete(schema.threadSubscriptions).where(and(eq(schema.threadSubscriptions.userId, v.user!.id), eq(schema.threadSubscriptions.threadId, threadId)));
}
export async function toggleBookmark(v: Viewer, threadId: number, on: boolean) {
  await loadThreadFor(v, threadId);
  const db = getDb();
  if (on) await db.insert(schema.threadBookmarks).values({ userId: v.user!.id, threadId }).onConflictDoNothing();
  else await db.delete(schema.threadBookmarks).where(and(eq(schema.threadBookmarks.userId, v.user!.id), eq(schema.threadBookmarks.threadId, threadId)));
}
export async function threadFlags(v: Viewer, threadId: number) {
  if (!v.user) return { subscribed: false, bookmarked: false };
  const db = getDb();
  const [s] = await db.select().from(schema.threadSubscriptions).where(and(eq(schema.threadSubscriptions.userId, v.user.id), eq(schema.threadSubscriptions.threadId, threadId)));
  const [b] = await db.select().from(schema.threadBookmarks).where(and(eq(schema.threadBookmarks.userId, v.user.id), eq(schema.threadBookmarks.threadId, threadId)));
  return { subscribed: !!s, bookmarked: !!b };
}
export async function listBookmarks(v: Viewer) {
  const rows = await getDb().select({ t: schema.threads }).from(schema.threadBookmarks).innerJoin(schema.threads, eq(schema.threads.id, schema.threadBookmarks.threadId))
    .where(eq(schema.threadBookmarks.userId, v.user!.id)).orderBy(desc(schema.threadBookmarks.createdAt));
  const visible = new Set(await viewableForumIds(v.subject));
  return decorateThreads(v, rows.map((r) => r.t).filter((t) => visible.has(t.forumId) && !t.isDeleted));
}
export async function listSubscriptions(v: Viewer) {
  const rows = await getDb().select({ t: schema.threads }).from(schema.threadSubscriptions).innerJoin(schema.threads, eq(schema.threads.id, schema.threadSubscriptions.threadId))
    .where(eq(schema.threadSubscriptions.userId, v.user!.id)).orderBy(desc(schema.threads.lastPostAt));
  const visible = new Set(await viewableForumIds(v.subject));
  return decorateThreads(v, rows.map((r) => r.t).filter((t) => visible.has(t.forumId) && !t.isDeleted));
}

// ─────────────────────────── drafts ───────────────────────────

export async function saveDraft(v: Viewer, key: string, body: string, title?: string) {
  if (!/^(thread|reply):\d{1,10}$/.test(key)) throw new ServiceError('Invalid draft.');
  const b = cleanText(body, 30_000);
  const db = getDb();
  if (!b.trim() && !title?.trim()) { await db.delete(schema.drafts).where(and(eq(schema.drafts.userId, v.user!.id), eq(schema.drafts.key, key))); return; }
  await db.insert(schema.drafts).values({ userId: v.user!.id, key, body: b, title: title ? cleanLine(title, 140) : null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.drafts.userId, schema.drafts.key], set: { body: b, title: title ? cleanLine(title, 140) : null, updatedAt: new Date() } });
}
export async function getDraft(v: Viewer, key: string) {
  if (!v.user) return null;
  const [d] = await getDb().select().from(schema.drafts).where(and(eq(schema.drafts.userId, v.user.id), eq(schema.drafts.key, key)));
  return d ?? null;
}

// ─────────────────────────── moderation ───────────────────────────

async function requireThreadMod(v: Viewer, threadId: number) {
  const thread = await threadById(threadId);
  if (!thread) throw new ServiceError('Thread not found.', 404);
  await v.require('mod.threads', thread.forumId);
  return thread;
}

export async function setThreadFlags(v: Viewer, threadId: number, flags: { isLocked?: boolean; isSticky?: boolean; isAnnouncement?: boolean }) {
  const thread = await requireThreadMod(v, threadId);
  if (flags.isAnnouncement !== undefined && !v.subject.isSuperAdmin && !(await v.can('admin.forums'))) delete flags.isAnnouncement;
  await getDb().update(schema.threads).set(flags).where(eq(schema.threads.id, threadId));
  await audit(v.user!.id, 'thread.flags', { type: 'thread', id: threadId }, flags, v.ip);
  if (flags.isLocked !== undefined && thread.userId !== v.user!.id) await notify(thread.userId, 'moderation', v.user!.id, `Your thread "${thread.title}" was ${flags.isLocked ? 'locked' : 'unlocked'} by a moderator.`, `/t/${thread.id}-${thread.slug}`);
}

export async function moveThread(v: Viewer, threadId: number, toForumId: number) {
  const thread = await requireThreadMod(v, threadId);
  const target = await forumById(toForumId);
  if (!target) throw new ServiceError('Target forum not found.', 404);
  await v.require('mod.threads', target.id);
  await getDb().update(schema.threads).set({ forumId: target.id }).where(eq(schema.threads.id, threadId));
  await recountForum(thread.forumId); await recountForum(target.id);
  await audit(v.user!.id, 'thread.move', { type: 'thread', id: threadId }, { from: thread.forumId, to: target.id }, v.ip);
}

/** Merge `sourceId` into `targetId`: posts are re-numbered after the target's last post, ordered by time. */
export async function mergeThreads(v: Viewer, sourceId: number, targetId: number) {
  if (sourceId === targetId) throw new ServiceError('Choose a different thread to merge into.');
  const source = await requireThreadMod(v, sourceId);
  const target = await requireThreadMod(v, targetId);
  const db = getDb();
  await db.transaction(async (tx) => {
    const posts = await tx.select().from(schema.posts).where(eq(schema.posts.threadId, source.id)).orderBy(asc(schema.posts.createdAt));
    let pos = target.lastPosition;
    for (const p of posts) await tx.update(schema.posts).set({ threadId: target.id, position: ++pos }).where(eq(schema.posts.id, p.id));
    await tx.update(schema.threads).set({ lastPosition: pos }).where(eq(schema.threads.id, target.id));
    await tx.update(schema.threads).set({ isDeleted: true, movedToThreadId: target.id, replyCount: 0, deletedById: v.user!.id }).where(eq(schema.threads.id, source.id));
    await tx.execute(sql`insert into thread_subscriptions (user_id, thread_id) select user_id, ${target.id} from thread_subscriptions where thread_id = ${source.id} on conflict do nothing`);
  });
  await recountThread(target.id); await recountForum(source.forumId); await recountForum(target.forumId);
  await audit(v.user!.id, 'thread.merge', { type: 'thread', id: target.id }, { source: source.id }, v.ip);
}

/** Split selected posts into a new thread. */
export async function splitThread(v: Viewer, threadId: number, postIds: number[], title: string, toForumId?: number) {
  const thread = await requireThreadMod(v, threadId);
  const t = cleanLine(title, 140);
  if (t.length < 3) throw new ServiceError('Thread titles must be at least 3 characters.');
  const forumId = toForumId ?? thread.forumId;
  if (toForumId) await v.require('mod.threads', toForumId);
  const db = getDb();
  const posts = (await db.select().from(schema.posts).where(and(eq(schema.posts.threadId, thread.id), inArray(schema.posts.id, postIds.length ? postIds : [-1])))).sort((a, b) => a.position - b.position);
  if (!posts.length) throw new ServiceError('Select at least one post to split.');
  if (posts.some((p) => p.position === 1)) throw new ServiceError('The opening post cannot be split off.');
  const newThread = await db.transaction(async (tx) => {
    const [nt] = await tx.insert(schema.threads).values({ forumId, userId: posts[0].userId, title: t, slug: slugify(t), lastPosition: posts.length, lastPostAt: posts[posts.length - 1].createdAt, createdAt: posts[0].createdAt }).returning();
    let pos = 0;
    for (const p of posts) await tx.update(schema.posts).set({ threadId: nt.id, position: ++pos }).where(eq(schema.posts.id, p.id));
    await tx.update(schema.threads).set({ firstPostId: posts[0].id }).where(eq(schema.threads.id, nt.id));
    return nt;
  });
  await recountThread(thread.id); await recountThread(newThread.id); await recountForum(thread.forumId); if (forumId !== thread.forumId) await recountForum(forumId);
  await audit(v.user!.id, 'thread.split', { type: 'thread', id: thread.id }, { newThread: newThread.id, posts: posts.map((p) => p.id) }, v.ip);
  return newThread;
}

export async function deleteThread(v: Viewer, threadId: number, restore = false) {
  const thread = await requireThreadMod(v, threadId);
  await getDb().update(schema.threads).set({ isDeleted: !restore, deletedById: restore ? null : v.user!.id }).where(eq(schema.threads.id, threadId));
  await recountForum(thread.forumId);
  await recountUser(thread.userId);
  await audit(v.user!.id, restore ? 'thread.restore' : 'thread.delete', { type: 'thread', id: threadId }, {}, v.ip);
}

// ─────────────────────────── counters ───────────────────────────

export async function recountThread(threadId: number) {
  const db = getDb();
  const [agg] = await db.select({ n: sql<number>`count(*)::int`, maxPos: sql<number>`coalesce(max(${schema.posts.position}), 0)::int` }).from(schema.posts)
    .where(and(eq(schema.posts.threadId, threadId), eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible')));
  const [last] = await db.select().from(schema.posts).where(and(eq(schema.posts.threadId, threadId), eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible'))).orderBy(desc(schema.posts.position)).limit(1);
  const [first] = await db.select().from(schema.posts).where(eq(schema.posts.threadId, threadId)).orderBy(asc(schema.posts.position)).limit(1);
  const [{ maxAll }] = await db.select({ maxAll: sql<number>`coalesce(max(${schema.posts.position}), 0)::int` }).from(schema.posts).where(eq(schema.posts.threadId, threadId));
  await db.update(schema.threads).set({
    replyCount: Math.max(0, agg.n - 1), lastPostId: last?.id ?? null, lastPostAt: last?.createdAt ?? first?.createdAt ?? new Date(), lastPostUserId: last?.userId ?? null,
    firstPostId: first?.id ?? null, lastPosition: sql`greatest(${schema.threads.lastPosition}, ${maxAll})`,
  }).where(eq(schema.threads.id, threadId));
}

export async function recountForum(forumId: number) {
  const db = getDb();
  const rows = (await db.execute(sql`
    select count(*)::int as threads, coalesce(sum(reply_count + 1), 0)::int as posts from threads
    where forum_id = ${forumId} and not is_deleted and state = 'visible' and moved_to_thread_id is null`)) as any;
  const agg = (rows.rows ?? rows)[0];
  const [last] = await db.select().from(schema.threads).where(and(eq(schema.threads.forumId, forumId), eq(schema.threads.isDeleted, false), eq(schema.threads.state, 'visible'))).orderBy(desc(schema.threads.lastPostAt)).limit(1);
  await db.update(schema.forums).set({ threadCount: Number(agg.threads), postCount: Number(agg.posts), lastThreadId: last?.id ?? null, lastPostId: last?.lastPostId ?? null, lastPostAt: last?.lastPostAt ?? null, lastPostUserId: last?.lastPostUserId ?? null }).where(eq(schema.forums.id, forumId));
}

export async function recountUser(userId: number) {
  const db = getDb();
  const rows = (await db.execute(sql`select
    (select count(*) from posts p join threads t on t.id = p.thread_id where p.user_id = ${userId} and not p.is_deleted and p.state = 'visible' and not t.is_deleted)::int as posts,
    (select count(*) from threads where user_id = ${userId} and not is_deleted and state = 'visible')::int as threads`)) as any;
  const r = (rows.rows ?? rows)[0];
  await db.update(schema.users).set({ postCount: Number(r.posts), threadCount: Number(r.threads) }).where(eq(schema.users.id, userId));
}

export async function forumsForMoveSelect(v: Viewer) {
  const ids = await viewableForumIds(v.subject);
  return getDb().select({ id: schema.forums.id, name: schema.forums.name }).from(schema.forums).where(inArray(schema.forums.id, ids.length ? ids : [-1])).orderBy(schema.forums.categoryId, schema.forums.displayOrder);
}

export const _unused = { gt, ne, notInArray };
