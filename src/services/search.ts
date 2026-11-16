/**
 * Global forum search (PostgreSQL full-text + trigram-free ILIKE for usernames).
 * Scope is limited to forums the viewer may read; held/deleted content is excluded.
 * Direct messages are never searched here.
 */
import { and, desc, eq, inArray, sql, gte, lte } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { excerpt } from '../lib/bbcode.ts';
import { viewableForumIds } from './permissions.ts';
import { getUserByUsername } from './users.ts';
import { rateLimit } from './forums.ts';
import type { Viewer } from './viewer.ts';

/** Result counts above this are reported as "1,000+" (and paging stops there). */
export const MAX_COUNTED = 1000;

export interface SearchQuery { q: string; type: 'posts' | 'threads'; author?: string; forum?: string; tag?: string; from?: string; to?: string; sort?: 'relevance' | 'latest'; page?: number }

export async function search(v: Viewer, sq: SearchQuery) {
  await v.require('search.use');
  await rateLimit(v, 'search');
  const db = getDb();
  const perPage = 25;
  const page = Math.max(1, sq.page ?? 1);
  let forumIds = await viewableForumIds(v.subject);
  if (sq.forum) {
    const [f] = await db.select().from(schema.forums).where(eq(schema.forums.slug, sq.forum));
    forumIds = f ? forumIds.filter((id) => id === f.id || false) : [];
  }
  if (!forumIds.length) return { results: [], total: 0, page, pages: 1 };
  const q = sq.q.trim().slice(0, 200);
  const tsq = q ? sql`websearch_to_tsquery('english', ${q})` : null;
  const conds: any[] = [inArray(schema.threads.forumId, forumIds), eq(schema.threads.isDeleted, false), eq(schema.threads.state, 'visible')];
  if (sq.author) {
    const u = await getUserByUsername(sq.author);
    conds.push(sq.type === 'threads' ? eq(schema.threads.userId, u?.id ?? -1) : eq(schema.posts.userId, u?.id ?? -1));
  }
  if (sq.tag) conds.push(sql`exists (select 1 from thread_tags tt join tags t on t.id = tt.tag_id where tt.thread_id = ${schema.threads.id} and t.slug = ${sq.tag})`);
  const dateCol = sq.type === 'threads' ? schema.threads.createdAt : schema.posts.createdAt;
  if (sq.from && /^\d{4}-\d{2}-\d{2}$/.test(sq.from)) conds.push(gte(dateCol, new Date(sq.from + 'T00:00:00Z')));
  if (sq.to && /^\d{4}-\d{2}-\d{2}$/.test(sq.to)) conds.push(lte(dateCol, new Date(sq.to + 'T23:59:59Z')));
  // spoiler-tagged threads never surface post excerpts
  if (sq.type === 'threads') {
    if (tsq) conds.push(sql`${schema.threads.search} @@ ${tsq}`);
    const where = and(...conds);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.threads).where(where);
    const order = tsq && sq.sort !== 'latest' ? [sql`ts_rank(${schema.threads.search}, ${tsq}) desc`, desc(schema.threads.lastPostAt)] : [desc(schema.threads.lastPostAt)];
    const rows = await db.select().from(schema.threads).where(where).orderBy(...order).limit(perPage).offset((page - 1) * perPage);
    return { results: rows.map((t) => ({ kind: 'thread' as const, thread: t, post: null, excerpt: '' })), total: n, page, pages: Math.max(1, Math.ceil(n / perPage)) };
  }
  conds.push(eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible'));
  if (tsq) conds.push(sql`${schema.posts.search} @@ ${tsq}`);
  const where = and(...conds);
  // counting every match of a broad query is the expensive part; stop at MAX_COUNTED and report "1,000+"
  const capped = db.select({ one: sql`1` }).from(schema.posts).innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId)).where(where).limit(MAX_COUNTED + 1).as('capped');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(capped);
  const order = tsq && sq.sort !== 'latest' ? [sql`ts_rank(${schema.posts.search}, ${tsq}) desc`, desc(schema.posts.createdAt)] : [desc(schema.posts.createdAt)];
  const rows = await db.select({ p: schema.posts, t: schema.threads }).from(schema.posts).innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId))
    .where(where).orderBy(...order).limit(perPage).offset((page - 1) * perPage);
  const spoilerThreads = new Set((await db.execute(sql`select tt.thread_id from thread_tags tt join tags t on t.id = tt.tag_id where t.slug = 'spoiler' and tt.thread_id in (${sql.join([...rows.map((r) => sql`${r.t.id}`), sql`-1`], sql`, `)})`) as any).rows?.map((r: any) => Number(r.thread_id)) ?? []);
  return {
    results: rows.map(({ p, t }) => ({ kind: 'post' as const, thread: t, post: p, excerpt: spoilerThreads.has(t.id) ? '[Excerpt hidden — thread is tagged Spoiler]' : excerpt(p.body, 240) })),
    total: n, page, pages: Math.max(1, Math.ceil(Math.min(n, MAX_COUNTED) / perPage)),
  };
}
