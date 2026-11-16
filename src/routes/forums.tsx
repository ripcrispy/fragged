import { Hono } from 'hono';
import { and, desc, eq, sql, isNull } from 'drizzle-orm';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, arr, int, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Breadcrumbs, Csrf, Pagination, TagPill, UserLink, Avatar, Time, Notice, ActionButton, Html, EmptyState, Presence, Field, Stat } from '../web/components.tsx';
import { Editor } from '../web/editor.tsx';
import { rendererFor } from '../web/content.ts';
import * as F from '../services/forums.ts';
import { getDb, schema } from '../db/client.ts';
import { userCards, ServiceError, type UserCard } from '../services/users.ts';
import { hiddenAuthorIds } from '../services/relationships.ts';
import { quoteFor } from '../lib/bbcode.ts';
import { numberFmt } from '../lib/time.ts';
import { getSetting } from '../services/settings.ts';
import { REPORT_REASONS } from '../services/moderation.ts';
import { rowsOf } from '../services/notifications.ts';

export const forumRoutes = new Hono<Env>();

const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';
const threadUrl = (t: { id: number; slug: string }, page?: number) => `/t/${t.id}-${t.slug}${page && page > 1 ? `?page=${page}` : ''}`;
const loginRedirect = (c: C) => c.redirect(`/login?returnTo=${encodeURIComponent(c.req.path)}`);

// ─────────────────────────── homepage ───────────────────────────

function ForumTable({ ctx, cats, cards }: { ctx: PageCtx; cats: Awaited<ReturnType<typeof F.forumIndex>>; cards: Map<number, UserCard> }) {
  return (
    <div class="table-wrap">
      <table class="forum-table">
        {cats.map(({ category, forums }) => (
          <tbody>
            <tr class="cat-head"><th colspan={2} scope="colgroup" id={`cat-${category.slug}`}><span class="cat-name">{category.name}</span>{category.description ? <span class="cat-desc"> — {category.description}</span> : null}</th>
              <th scope="col" class="col-last">Last Post</th><th scope="col" class="col-num">Threads</th><th scope="col" class="col-num">Posts</th></tr>
            {forums.map(({ forum, subforums, unread, lastThread }) => {
              const lp = forum.lastPostUserId ? cards.get(forum.lastPostUserId) : null;
              return (
                <tr class={`forum-row ${unread ? 'is-unread' : ''}`}>
                  <td class="forum-icon"><span class={`status-icon ${unread ? 'status-new' : 'status-old'} ${forum.isArchived ? 'status-archived' : ''}`} title={forum.isArchived ? 'Archived' : unread ? 'Contains unread posts' : 'No unread posts'}><span class="sr-only">{forum.isArchived ? 'Archived' : unread ? 'Unread posts' : 'No unread posts'}</span></span></td>
                  <td class="forum-info">
                    <h3 class="forum-title"><a href={`/f/${forum.slug}`}>{forum.name}</a>{unread ? <span class="new-flag">New</span> : null}</h3>
                    <p class="forum-desc">{forum.description}</p>
                    {subforums.length ? <p class="subforums"><span class="muted">Subforums:</span> {subforums.map((s, i) => <>{i ? ', ' : ''}<a href={`/f/${s.slug}`}>{s.name}</a></>)}</p> : null}
                  </td>
                  <td class="forum-last">
                    {lastThread && forum.lastPostAt ? (
                      <div class="lastpost">
                        <Avatar user={lp} size={32} />
                        <div class="lastpost-text">
                          <a class="lastpost-title" href={`/t/${lastThread.id}-${lastThread.slug}?goto=last`}>{lastThread.title}</a>
                          <span class="lastpost-meta">by <UserLink user={lp} />, <Time d={forum.lastPostAt} tz={tz(ctx)} mode="ago" /></span>
                        </div>
                      </div>
                    ) : <span class="muted">No posts yet</span>}
                  </td>
                  <td class="col-num">{numberFmt(forum.threadCount)}</td>
                  <td class="col-num">{numberFmt(forum.postCount)}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

async function indexData(c: C) {
  const v = c.get('viewer');
  const cats = await F.forumIndex(v);
  const ids = cats.flatMap((c) => c.forums.map((f) => f.forum.lastPostUserId)).filter((x): x is number => !!x);
  return { cats, cards: await userCards(ids) };
}

// Community statistics are site-wide and change slowly; recompute at most once a minute.
let statsCache: { at: number; value: { members: number; threads: number; posts: number } } | null = null;
async function communityStats() {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const r = rowsOf(await getDb().execute(sql`select (select count(*) from users where closed_at is null)::int as members,
    (select count(*) from threads where not is_deleted and state = 'visible')::int as threads,
    (select count(*) from posts where not is_deleted and state = 'visible')::int as posts`))[0];
  statsCache = { at: Date.now(), value: { members: Number(r.members), threads: Number(r.threads), posts: Number(r.posts) } };
  return statsCache.value;
}

forumRoutes.get('/', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const { cats, cards } = await indexData(c);
  const db = getDb();
  const stats = await communityStats();
  const [newest] = await db.select({ id: schema.users.id }).from(schema.users).where(isNull(schema.users.closedAt)).orderBy(desc(schema.users.createdAt)).limit(1);
  const newestCard = newest ? (await userCards([newest.id])).get(newest.id) : null;
  const recent = await F.recentThreads(v, { limit: 8 });
  const rcards = await userCards(recent.threads.map((t) => t.lastPostUserId!).filter(Boolean));
  const announcements = recent.threads.length ? await db.select().from(schema.threads).where(and(eq(schema.threads.isAnnouncement, true), eq(schema.threads.isDeleted, false))).orderBy(desc(schema.threads.createdAt)).limit(3) : [];
  return page(c, '', (
    <>
      <h1 class="sr-only">{ctx.site.site_name}</h1>
      {!v.user ? <div class="welcome box"><div class="box-body welcome-body">
        <div><strong>Welcome to {ctx.site.site_name}.</strong> Browse freely as a guest — <a href="/register">register</a> to post, add friends, message members and customise your profile.</div>
        <a href="/register" class="btn btn-primary">Join the community</a>
      </div></div> : null}
      {announcements.length ? <Box title="Announcements" className="announcements">
        <ul class="plain-list">{announcements.map((t) => <li><span class="tag tag-official">Announcement</span> <a href={threadUrl(t)}>{t.title}</a> <span class="muted"><Time d={t.createdAt} tz={tz(ctx)} mode="date" /></span></li>)}</ul>
      </Box> : null}
      {cats.length ? <ForumTable ctx={ctx} cats={cats} cards={cards} /> : <EmptyState title="No forums yet">{ctx.canAdmin ? <p><a href="/admin/forums">Create the first category and forum</a>.</p> : <p>Check back soon.</p>}</EmptyState>}
      <div class="home-lower">
        <Box title="Latest activity" actions={<a href="/whats-new">More…</a>}>
          {recent.threads.length ? <ul class="activity-list">{recent.threads.map((t) => (
            <li class={t.unread ? 'is-unread' : ''}>
              <a href={t.unread ? `/t/${t.id}-${t.slug}?goto=unread` : `${threadUrl(t)}?goto=last`} class="activity-title">{t.title}</a>
              {t.tags.filter((x) => x.kind === 'warning').map((tag) => <> <TagPill tag={tag} /></>)}
              <span class="muted"> — <UserLink user={rcards.get(t.lastPostUserId!)} />, <Time d={t.lastPostAt} tz={tz(ctx)} mode="ago" /></span>
            </li>))}</ul> : <p class="muted">Nothing here yet.</p>}
        </Box>
        <Box title="Community statistics">
          <div class="stats-row">
            <Stat label="Threads" value={numberFmt(Number(stats.threads))} />
            <Stat label="Posts" value={numberFmt(Number(stats.posts))} />
            <Stat label="Members" value={numberFmt(Number(stats.members))} />
          </div>
          {newestCard ? <p class="muted">Welcome to our newest member, <UserLink user={newestCard} />.</p> : null}
          {v.user ? <ActionButton ctx={ctx} action="/forums/mark-read" label="Mark all forums read" className="btn btn-small" /> : null}
        </Box>
      </div>
    </>
  ), { description: ctx.site.site_tagline });
});

forumRoutes.get('/forums', async (c) => {
  const ctx = c.get('page');
  const { cats, cards } = await indexData(c);
  return page(c, 'Forums', <><h1 class="page-title">Forums</h1><ForumTable ctx={ctx} cats={cats} cards={cards} /></>, { crumbs: [{ label: 'Forums' }] });
});

forumRoutes.post('/forums/mark-read', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const forums = await getDb().select({ id: schema.forums.id }).from(schema.forums);
  for (const f of forums) await F.markForumRead(v, f.id);
  setFlash(c, { type: 'ok', text: 'All forums marked as read.' });
  return c.redirect('/');
});

// ─────────────────────────── forum page ───────────────────────────

function ThreadRows({ ctx, threads, cards, showForum, forumNames }: { ctx: PageCtx; threads: F.ThreadRow[]; cards: Map<number, UserCard>; showForum?: boolean; forumNames?: Map<number, { name: string; slug: string }> }) {
  return <>{threads.map((t) => {
    if (t.hiddenReason) {
      return <tr class="thread-row thread-hidden"><td class="thread-icon" /><td colspan={4} class="muted">A thread marked {t.hiddenReason === 'nsfw' ? 'NSFW' : 'Trigger Warning'} is hidden by your <a href="/settings/preferences">content preferences</a>. <a href={threadUrl(t)}>Open anyway</a></td></tr>;
    }
    const starter = cards.get(t.userId);
    const last = t.lastPostUserId ? cards.get(t.lastPostUserId) : null;
    const pages = Math.max(1, Math.ceil((t.replyCount + 1) / 20));
    const status = [t.isAnnouncement ? 'announcement' : '', t.isSticky ? 'sticky' : '', t.isLocked ? 'locked' : '', t.unread ? 'unread' : '', t.replyCount >= 25 || t.viewCount >= 500 ? 'hot' : ''].filter(Boolean);
    const warns = t.tags.filter((x) => x.kind === 'warning');
    const topics = t.tags.filter((x) => x.kind !== 'warning');
    return (
      <tr class={`thread-row ${status.map((s) => 'is-' + s).join(' ')} ${t.isDeleted ? 'is-deleted' : ''} ${t.state === 'held' ? 'is-held' : ''}`}>
        <td class="thread-icon"><span class={`status-icon ${t.unread ? 'status-new' : 'status-old'} ${t.isLocked ? 'status-locked' : ''} ${t.replyCount >= 25 ? 'status-hot' : ''}`} title={status.join(', ') || 'No new posts'}><span class="sr-only">{status.join(', ') || 'No new posts'}</span></span></td>
        <td class="thread-info">
          <div class="thread-title-line">
            {t.isAnnouncement ? <span class="prefix prefix-announce">Announcement:</span> : t.isSticky ? <span class="prefix prefix-sticky">Sticky:</span> : null}
            {t.isLocked ? <span class="prefix prefix-locked" title="Locked"><span class="ico ico-lock" aria-hidden="true"></span><span class="sr-only">Locked</span></span> : null}
            {warns.map((w) => <><TagPill tag={w} /> </>)}
            <a class={`thread-title ${t.unread ? 'unread' : ''}`} href={threadUrl(t)}>{t.title}</a>
            {t.unread && t.firstUnreadPosition && t.firstUnreadPosition > 1 ? <a class="goto-unread" href={`/t/${t.id}-${t.slug}?goto=unread`} title="Go to first unread post">(new)</a> : null}
            {t.state === 'held' ? <span class="tag tag-held">Awaiting approval</span> : null}
            {t.isDeleted ? <span class="tag tag-deleted">Deleted</span> : null}
            {pages > 1 ? <span class="thread-pages">(Pages: {Array.from({ length: Math.min(pages, 4) }, (_, i) => i + 1).map((p) => <a href={threadUrl(t, p)}>{p}</a>)}{pages > 4 ? <>… <a href={threadUrl(t, pages)}>{pages}</a></> : null})</span> : null}
          </div>
          <div class="thread-meta">
            <UserLink user={starter} />, <Time d={t.createdAt} tz={tz(ctx)} mode="date" />
            {showForum && forumNames?.get(t.forumId) ? <> in <a href={`/f/${forumNames.get(t.forumId)!.slug}`}>{forumNames.get(t.forumId)!.name}</a></> : null}
            {topics.length ? <span class="thread-tags">{topics.map((tg) => <TagPill tag={tg} href={`?tag=${tg.slug}`} />)}</span> : null}
          </div>
        </td>
        <td class="thread-last">
          <a href={`/t/${t.id}-${t.slug}?goto=last`} class="lastpost-date"><Time d={t.lastPostAt} tz={tz(ctx)} mode="ago" /></a>
          <span class="lastpost-by">by <UserLink user={last} /></span>
        </td>
        <td class="col-num">{numberFmt(t.replyCount)}</td>
        <td class="col-num">{numberFmt(t.viewCount)}</td>
      </tr>
    );
  })}</>;
}

forumRoutes.get('/f/:slug', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const forum = await F.assertForumVisible(v, await F.forumBySlug(c.req.param('slug')));
  const sort = (['last_post', 'created', 'title', 'replies', 'views'].includes(c.req.query('sort') ?? '') ? c.req.query('sort') : 'last_post') as F.ThreadSort;
  const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';
  const tag = c.req.query('tag') || null;
  const res = await F.listThreads(v, forum, { page: int(c.req.query('page'), 1), sort, order, tag });
  const subs = await F.subforumsOf(v, forum);
  const { category, parents } = await F.forumTrail(forum);
  const all = [...res.pinned, ...res.threads];
  const cards = await userCards(all.flatMap((t) => [t.userId, t.lastPostUserId!]).concat(subs.map((s) => s.forum.lastPostUserId!)));
  const canPost = await v.can('thread.create', forum.id);
  const qs = (p: Record<string, string | number | null>) => {
    const u = new URLSearchParams();
    const merged = { sort, order, tag, ...p };
    for (const [k, val] of Object.entries(merged)) if (val != null && val !== '' && !(k === 'sort' && val === 'last_post') && !(k === 'order' && val === 'desc') && !(k === 'page' && String(val) === '1')) u.set(k, String(val));
    const s = u.toString();
    return `/f/${forum.slug}${s ? '?' + s : ''}`;
  };
  const SortTh = ({ k, label, cls }: { k: F.ThreadSort; label: string; cls?: string }) => {
    const activeSort = sort === k;
    const nextOrder = activeSort && order === 'desc' ? 'asc' : 'desc';
    return <th scope="col" class={cls} aria-sort={activeSort ? (order === 'asc' ? 'ascending' : 'descending') : undefined}><a href={qs({ sort: k, order: nextOrder, page: 1 })}>{label}{activeSort ? (order === 'asc' ? ' ▲' : ' ▼') : ''}</a></th>;
  };
  const tags = await F.allTags();
  return page(c, forum.name, (
    <>
      <div class="forum-header">
        <h1 class="page-title">{forum.name}</h1>
        {forum.description ? <p class="page-desc">{forum.description}</p> : null}
        {forum.rulesNotice ? <Notice type="info">{forum.rulesNotice}</Notice> : null}
        {forum.isArchived ? <Notice type="warn">This forum is archived. Threads remain readable but new posts are disabled.</Notice> : null}
      </div>
      {subs.length ? (
        <div class="table-wrap"><table class="forum-table subforum-table"><tbody>
          <tr class="cat-head"><th colspan={2}>Subforums</th><th class="col-last">Last Post</th><th class="col-num">Threads</th><th class="col-num">Posts</th></tr>
          {subs.map((s) => (
            <tr class={`forum-row ${s.unread ? 'is-unread' : ''}`}>
              <td class="forum-icon"><span class={`status-icon ${s.unread ? 'status-new' : 'status-old'}`}><span class="sr-only">{s.unread ? 'Unread posts' : 'No unread posts'}</span></span></td>
              <td class="forum-info"><h3 class="forum-title"><a href={`/f/${s.forum.slug}`}>{s.forum.name}</a></h3><p class="forum-desc">{s.forum.description}</p></td>
              <td class="forum-last">{s.lastThread ? <div class="lastpost-text"><a href={`/t/${s.lastThread.id}-${s.lastThread.slug}?goto=last`}>{s.lastThread.title}</a><span class="lastpost-meta">by <UserLink user={cards.get(s.forum.lastPostUserId!)} />, <Time d={s.forum.lastPostAt} tz={tz(ctx)} mode="ago" /></span></div> : <span class="muted">No posts yet</span>}</td>
              <td class="col-num">{numberFmt(s.forum.threadCount)}</td><td class="col-num">{numberFmt(s.forum.postCount)}</td>
            </tr>))}
        </tbody></table></div>
      ) : null}
      <div class="list-controls">
        {canPost && !forum.isArchived ? <a class="btn btn-primary" href={`/f/${forum.slug}/new`}>+ New Thread</a> : !v.user ? <a class="btn" href={`/login?returnTo=/f/${forum.slug}/new`}>Sign in to post</a> : null}
        <Pagination page={res.page} pages={res.pages} href={(p) => qs({ page: p })} label="Thread pages" />
      </div>
      {res.tag ? <Notice type="info">Showing threads tagged <TagPill tag={res.tag} />. <a href={qs({ tag: null, page: 1 })}>Clear filter</a></Notice> : null}
      <div class="table-wrap">
        <table class="thread-table">
          <caption class="sr-only">Threads in {forum.name}</caption>
          <thead><tr>
            <th scope="col" class="thread-icon"><span class="sr-only">Status</span></th>
            <SortTh k="title" label="Thread" /><SortTh k="last_post" label="Last Post" cls="col-last" /><SortTh k="replies" label="Replies" cls="col-num" /><SortTh k="views" label="Views" cls="col-num" />
          </tr></thead>
          <tbody>
            {res.pinned.length ? <ThreadRows ctx={ctx} threads={res.pinned} cards={cards} /> : null}
            {res.pinned.length && res.threads.length ? <tr class="separator-row"><td colspan={5}>Normal threads</td></tr> : null}
            <ThreadRows ctx={ctx} threads={res.threads} cards={cards} />
            {!all.length ? <tr><td colspan={5}><EmptyState title={res.tag ? 'No threads with this tag.' : 'No threads yet.'}>{canPost ? <p>Be the first — <a href={`/f/${forum.slug}/new`}>start a thread</a>.</p> : null}</EmptyState></td></tr> : null}
          </tbody>
        </table>
      </div>
      <div class="list-controls list-controls-bottom">
        <form class="inline-form forum-filters" method="get" action={`/f/${forum.slug}`}>
          <label for="ff-sort">Sort</label>
          <select id="ff-sort" name="sort">{[['last_post', 'Last post'], ['created', 'Thread start'], ['title', 'Title'], ['replies', 'Replies'], ['views', 'Views']].map(([k, l]) => <option value={k} selected={k === sort}>{l}</option>)}</select>
          <select name="order" aria-label="Order"><option value="desc" selected={order === 'desc'}>Descending</option><option value="asc" selected={order === 'asc'}>Ascending</option></select>
          <label for="ff-tag">Tag</label>
          <select id="ff-tag" name="tag"><option value="">Any</option>{tags.map((t) => <option value={t.slug} selected={t.slug === tag}>{t.name}</option>)}</select>
          <button class="btn btn-small">Show</button>
        </form>
        <Pagination page={res.page} pages={res.pages} href={(p) => qs({ page: p })} label="Thread pages" />
      </div>
      {v.user ? <p class="forum-tools"><ActionButton ctx={ctx} action={`/f/${forum.slug}/read`} label="Mark this forum read" className="link-btn" /></p> : null}
    </>
  ), { crumbs: [{ label: category.name, href: `/forums#cat-${category.slug}` }, ...parents.map((p) => ({ label: p.name, href: `/f/${p.slug}` })), { label: forum.name }] });
});

forumRoutes.post('/f/:slug/read', async (c) => {
  const v = c.get('viewer');
  const forum = await F.assertForumVisible(v, await F.forumBySlug(c.req.param('slug')));
  await F.markForumRead(v, forum.id);
  return c.redirect(`/f/${forum.slug}`);
});

// ─────────────────────────── new thread ───────────────────────────

async function TagPicker({ selected = [] as string[], forum }: { selected?: string[]; forum: F.Forum }) {
  const tags = await F.allTags();
  const warnings = tags.filter((t) => t.kind === 'warning');
  const topics = tags.filter((t) => t.kind !== 'warning' && t.isOfficial);
  const custom = selected.filter((s) => !tags.some((t) => t.name === s || t.slug === s));
  return (
    <fieldset class="field tag-picker">
      <legend>Tags and content labels</legend>
      <div class="warn-picks">
        {warnings.map((t) => <label class="check-chip"><input type="checkbox" name="tags" value={t.name} checked={selected.includes(t.name) || selected.includes(t.slug)} /> <TagPill tag={t} /></label>)}
      </div>
      <p class="field-hint">Use Spoiler, NSFW or Trigger Warning so members can choose before opening. Labels don't replace the rules — explicit or illegal content is still prohibited.</p>
      <div class="topic-picks">
        {topics.map((t) => <label class="check-chip"><input type="checkbox" name="tags" value={t.name} checked={selected.includes(t.name) || selected.includes(t.slug)} /> <TagPill tag={t} /></label>)}
      </div>
      {forum.allowUserTags ? <div class="field"><label for="f-newtags">Other tags (comma separated)</label><input id="f-newtags" name="newTags" value={custom.join(', ')} maxlength={200} placeholder="e.g. unity, level design" /></div> : null}
    </fieldset>
  );
}

function parseTags(body: Record<string, any>): string[] {
  return [...arr(body.tags), ...str(body.newTags).split(',').map((s) => s.trim()).filter(Boolean)];
}

async function newThreadPage(c: C, forum: F.Forum, values: { title?: string; body?: string; tags?: string[] } = {}, error?: string) {
  const ctx = c.get('page');
  const { category, parents } = await F.forumTrail(forum);
  const draft = !values.body ? await F.getDraft(ctx.viewer, `thread:${forum.id}`) : null;
  return page(c, `New thread in ${forum.name}`, (
    <Box title={`Post a new thread in ${forum.name}`}>
      {forum.rulesNotice ? <Notice type="info">{forum.rulesNotice}</Notice> : null}
      {error ? <Notice type="error">{error}</Notice> : null}
      <form method="post" action={`/f/${forum.slug}/new`} class="post-form" data-editor-form>
        <Csrf ctx={ctx} />
        <Field label="Title" name="title" value={values.title ?? draft?.title ?? ''} required maxlength={140} minlength={3} />
        <Editor ctx={ctx} value={values.body ?? draft?.body ?? ''} draftKey={`thread:${forum.id}`} />
        <TagPicker selected={values.tags ?? []} forum={forum} />
        <div class="form-actions"><button class="btn btn-primary">Post thread</button> <a href={`/f/${forum.slug}`}>Cancel</a></div>
      </form>
    </Box>
  ), { crumbs: [{ label: category.name, href: '/forums' }, ...parents.map((p) => ({ label: p.name, href: `/f/${p.slug}` })), { label: forum.name, href: `/f/${forum.slug}` }, { label: 'New thread' }], withPane: false, noPane: true });
}

forumRoutes.get('/f/:slug/new', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const forum = await F.assertForumVisible(v, await F.forumBySlug(c.req.param('slug')));
  await v.require('thread.create', forum.id);
  return newThreadPage(c, forum);
});

forumRoutes.post('/f/:slug/new', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const forum = await F.assertForumVisible(v, await F.forumBySlug(c.req.param('slug')));
  const body = await form(c);
  const values = { title: str(body.title), body: str(body.body), tags: parseTags(body) };
  try {
    const { thread } = await F.createThread(v, forum, { ...values, uploads: arr(body.uploads) });
    if (thread.state === 'held') setFlash(c, { type: 'info', text: 'Your thread has been submitted and is awaiting moderator approval.' });
    return c.redirect(threadUrl(thread));
  } catch (e) {
    if (e instanceof ServiceError && e.status < 500 && e.status !== 401) return newThreadPage(c, forum, values, e.message);
    throw e;
  }
});

// ─────────────────────────── thread page ───────────────────────────

forumRoutes.get('/t/:ref', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const m = /^(\d{1,10})(?:-([\w-]*))?$/.exec(c.req.param('ref'));
  if (!m) throw new ServiceError('Thread not found.', 404);
  const { thread, forum } = await F.loadThreadFor(v, parseInt(m[1], 10));
  if (thread.movedToThreadId) return c.redirect(`/t/${thread.movedToThreadId}`, 301);
  const goto = c.req.query('goto');
  if (goto === 'last' || goto === 'unread') {
    let target = thread.lastPostId;
    if (goto === 'unread' && v.user) {
      const [r] = await getDb().select().from(schema.threadReads).where(and(eq(schema.threadReads.userId, v.user.id), eq(schema.threadReads.threadId, thread.id)));
      const [p] = await getDb().select({ id: schema.posts.id }).from(schema.posts).where(and(eq(schema.posts.threadId, thread.id), sql`${schema.posts.position} > ${r?.lastReadPosition ?? 0}`, eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible'))).orderBy(schema.posts.position).limit(1);
      if (p) target = p.id;
    }
    if (target) return c.redirect(`/p/${target}`);
  }
  if (m[2] !== thread.slug) return c.redirect(threadUrl(thread, int(c.req.query('page'), 1)), 301);
  const res = await F.listPosts(v, thread, forum, int(c.req.query('page'), 1));
  const lastPos = res.posts.length ? Math.max(...res.posts.map((p) => p.position)) : 0;
  await F.recordView(v, thread, lastPos);
  const { category, parents } = await F.forumTrail(forum);
  const cards = await userCards(res.posts.map((p) => p.userId), { presenceFor: true });
  const tags = (await F.tagsForThreads([thread.id])).get(thread.id) ?? [];
  const flags = await F.threadFlags(v, thread.id);
  const R = await rendererFor(v);
  const hidden = v.user ? await hiddenAuthorIds(v.user.id) : { blocked: new Set<number>(), muted: new Set<number>() };
  const canReply = (await v.can('post.reply', forum.id)) && (!thread.isLocked || (await v.can('mod.threads', forum.id))) && !forum.isArchived;
  const canModThreads = await v.can('mod.threads', forum.id);
  const canEditOwn = await v.can('post.edit_own', forum.id);
  const canDeleteOwn = await v.can('post.delete_own', forum.id);
  const canReact = await v.can('post.react', forum.id);
  const canReport = await v.can('report.create');
  const canTag = (v.user?.id === thread.userId && (await v.can('tag.apply', forum.id))) || (await v.can('mod.tags', forum.id));
  const slugs = tags.map((t) => t.slug);
  // Built-in NSFW / TW labels follow the viewer's preference; Spoiler and admin-defined warning labels always gate.
  const customWarning = tags.find((t) => t.kind === 'warning' && !['nsfw', 'trigger-warning', 'spoiler'].includes(t.slug));
  const gate = (slugs.includes('nsfw') && v.settings.nsfwMode !== 'show') ? 'NSFW' : (slugs.includes('trigger-warning') && v.settings.triggerMode !== 'show') ? 'Trigger Warning' : slugs.includes('spoiler') ? 'Spoiler' : customWarning ? customWarning.name : null;
  const signatures = v.user ? v.settings.showSignatures : true;
  const draft = await F.getDraft(v, `reply:${thread.id}`);
  const pageHref = (p: number) => threadUrl(thread, p);

  const postsHtml = (
    <ol class="postlist" data-thread-id={thread.id}>
      {res.posts.map((p) => {
        const author = cards.get(p.userId);
        const isBlocked = hidden.blocked.has(p.userId);
        const isMuted = hidden.muted.has(p.userId);
        const own = v.user?.id === p.userId;
        const cls = `post ${p.isDeleted ? 'is-deleted' : ''} ${p.state === 'held' ? 'is-held' : ''} ${p.position === 1 ? 'is-op' : ''}`;
        const body = R.post(p.body);
        return (
          <li class={cls} id={`post-${p.id}`} data-post-id={p.id} data-author={author?.username}>
            <div class="post-head">
              <span class="post-date"><Time d={p.createdAt} tz={tz(ctx)} /></span>
              {p.editedAt ? <span class="post-edited" title={`Edited ${p.editCount} time(s)`}> · edited <Time d={p.editedAt} tz={tz(ctx)} mode="ago" />{(p.editCount > 0 && (own || res.mod)) ? <> (<a href={`/p/${p.id}/history`}>history</a>)</> : null}</span> : null}
              <a class="post-number" href={`/p/${p.id}`} aria-label={`Permalink to post ${p.position}`}>#{p.position}</a>
            </div>
            {(isBlocked || isMuted) && !res.mod ? (
              <details class="post-collapsed"><summary>Post from a member you have {isBlocked ? 'blocked' : 'muted'} — show anyway</summary><PostBody /></details>
            ) : <PostBody />}
          </li>
        );
        function PostBody() {
          return (
            <div class="post-row">
              <div class="post-author">
                <div class="author-name"><UserLink user={author} /> <Presence p={author?.presence} /></div>
                {author?.title ? <div class="author-title">{author.title}</div> : null}
                <Avatar user={author} size={96} />
                <dl class="author-stats">
                  {author && !author.closed ? <><dt>Joined</dt><dd><Time d={author.joinedAt} tz={tz(ctx)} mode="date" /></dd>
                  <dt>Posts</dt><dd>{numberFmt(author.postCount)}</dd>
                  {author.location ? <><dt>Location</dt><dd>{author.location}</dd></> : null}
                  {author.pronouns ? <><dt>Pronouns</dt><dd>{author.pronouns}</dd></> : null}</> : null}
                </dl>
              </div>
              <div class="post-main">
                {p.isDeleted ? <Notice type="warn">This post was deleted{p.deletedReason ? `: ${p.deletedReason}` : ''}. Only moderators can see it.</Notice> : null}
                {p.state === 'held' ? <Notice type="info">This post is awaiting moderator approval{own ? ' and is only visible to you and staff' : ''}.</Notice> : null}
                <div class="post-content bb"><Html html={body} /></div>
                {p.attachments.length ? <div class="post-attachments"><span class="muted">Attached images:</span>{p.attachments.map((a) => <a href={`/media/${a.publicId}`} data-lightbox><img src={`/media/${a.publicId}`} alt="Attachment" loading="lazy" width={Math.min(a.width, 200)} /></a>)}</div> : null}
                {signatures && author?.signature ? <div class="post-signature bb"><Html html={R.signature(author.signature)} /></div> : null}
                <div class="post-foot">
                  <div class="reactions" data-reactions={p.id} role="group" aria-label="Reactions">
                    {p.reactions.map((r) => {
                      const def = F.REACTIONS.find((x) => x.key === r.key)!;
                      return <span class={`reaction ${r.mine ? 'mine' : ''}`} title={def.label}><span class={`rx rx-${def.key}`} aria-hidden="true" /> {def.label} × <strong>{r.count}</strong></span>;
                    })}
                    {p.reactions.length ? <a href={`/p/${p.id}/reactions`} class="reaction-list-link">(list)</a> : null}
                  </div>
                  <div class="post-controls">
                    {canReact && !own && v.user && !p.isDeleted ? (
                      <details class="menu react-menu"><summary class="btn btn-small btn-ghost">React</summary>
                        <div class="menu-panel react-panel">{F.REACTIONS.map((r) => (
                          <form method="post" action={`/p/${p.id}/react`} class="inline-form" data-ajax="react"><Csrf ctx={ctx} /><input type="hidden" name="reaction" value={r.key} />
                            <button class="react-btn" title={r.label} aria-label={r.label}><span class={`rx rx-${r.key}`} aria-hidden="true" /> <span class="react-label">{r.label}</span></button></form>))}
                        </div></details>) : null}
                    {canReply && !p.isDeleted ? <a class="btn btn-small" href={`/t/${thread.id}/reply?quote=${p.id}`} data-quote={p.id}>Quote</a> : null}
                    {canReply && !p.isDeleted ? <button type="button" class="btn btn-small btn-ghost" data-multiquote={p.id} aria-pressed="false" title="Add to multi-quote">+Quote</button> : null}
                    {(own && canEditOwn) || res.mod ? <a class="btn btn-small btn-ghost" href={`/p/${p.id}/edit`}>Edit</a> : null}
                    {((own && canDeleteOwn) || res.mod) && !p.isDeleted ? <ActionButton ctx={ctx} action={`/p/${p.id}/delete`} label="Delete" className="btn btn-small btn-ghost" confirm="Delete this post?" /> : null}
                    {res.mod && p.isDeleted ? <ActionButton ctx={ctx} action={`/p/${p.id}/restore`} label="Restore" className="btn btn-small" /> : null}
                    {res.mod && p.state === 'held' ? <ActionButton ctx={ctx} action={`/p/${p.id}/approve`} label="Approve" className="btn btn-small btn-primary" /> : null}
                    {canReport && !own && v.user ? <a class="btn btn-small btn-ghost" href={`/report?type=post&id=${p.id}`}>Report</a> : null}
                    {canModThreads && p.position > 1 ? <label class="split-pick"><input type="checkbox" form="split-form" name="posts" value={p.id} /> <span class="sr-only">Select post {p.position} for split</span><span aria-hidden="true">✂</span></label> : null}
                  </div>
                </div>
              </div>
            </div>
          );
        }
      })}
    </ol>
  );

  return page(c, thread.title, (
    <>
      <div class="thread-header">
        <h1 class="page-title">{tags.filter((t) => t.kind === 'warning').map((t) => <><TagPill tag={t} /> </>)}{thread.title}</h1>
        <div class="thread-header-meta">
          {tags.filter((t) => t.kind !== 'warning').map((t) => <TagPill tag={t} href={`/f/${forum.slug}?tag=${t.slug}`} />)}
          {thread.isLocked ? <span class="tag tag-locked"><span class="ico ico-lock" aria-hidden="true"></span> Locked</span> : null}
          {thread.isSticky ? <span class="tag tag-official">Sticky</span> : null}
          {canTag ? <details class="menu inline-menu"><summary class="link-btn">Edit tags</summary><div class="menu-panel">
            <form method="post" action={`/t/${thread.id}/tags`} class="form-grid"><Csrf ctx={ctx} />
              <TagPicker selected={tags.map((t) => t.name)} forum={forum} />
              <button class="btn btn-small btn-primary">Save tags</button></form></div></details> : null}
        </div>
      </div>
      <div class="thread-controls">
        {canReply ? <a class="btn btn-primary" href={`/t/${thread.id}/reply`}>Reply</a> : thread.isLocked ? <span class="btn btn-disabled" aria-disabled="true"><span class="ico ico-lock" aria-hidden="true"></span> Locked</span> : !v.user ? <a class="btn" href={`/login?returnTo=${encodeURIComponent(threadUrl(thread))}`}>Sign in to reply</a> : null}
        {v.user ? <ActionButton ctx={ctx} action={`/t/${thread.id}/subscribe`} fields={{ on: flags.subscribed ? 0 : 1 }} label={flags.subscribed ? 'Unsubscribe' : 'Subscribe'} className="btn btn-ghost" /> : null}
        {v.user ? <ActionButton ctx={ctx} action={`/t/${thread.id}/bookmark`} fields={{ on: flags.bookmarked ? 0 : 1 }} label={flags.bookmarked ? '★ Bookmarked' : '☆ Bookmark'} className="btn btn-ghost" /> : null}
        {canReport && v.user && v.user.id !== thread.userId ? <a class="btn btn-ghost" href={`/report?type=thread&id=${thread.id}`}>Report thread</a> : null}
        <Pagination page={res.page} pages={res.pages} href={pageHref} label="Post pages" />
      </div>
      {canModThreads ? <ModTools ctx={ctx} thread={thread} forum={forum} /> : null}
      {gate ? (
        <details class="cw-gate" data-cw-gate={thread.id}>
          <summary><span class="cw-icon" aria-hidden="true">⚠</span> This thread is labelled <strong>{gate}</strong>. {gate === 'Spoiler' ? 'It may reveal plot details.' : 'It may contain content some members prefer not to see.'} <span class="btn btn-small">Show content</span></summary>
          {postsHtml}
        </details>
      ) : postsHtml}
      <div class="thread-controls thread-controls-bottom">
        <Pagination page={res.page} pages={res.pages} href={pageHref} label="Post pages" />
      </div>
      {canReply ? (
        <Box title="Quick reply" id="quick-reply">
          <form method="post" action={`/t/${thread.id}/reply`} class="post-form" data-editor-form>
            <Csrf ctx={ctx} />
            <Editor ctx={ctx} value={draft?.body ?? ''} draftKey={`reply:${thread.id}`} rows={6} id="qr-body" label="Your reply" />
            <div class="form-actions"><button class="btn btn-primary">Post reply</button> <a href={`/t/${thread.id}/reply`} data-multiquote-go>Go advanced / insert multi-quotes</a></div>
          </form>
        </Box>
      ) : thread.isLocked ? <Notice type="info">This thread is locked. New replies are disabled.</Notice> : null}
    </>
  ), { crumbs: [{ label: category.name, href: '/forums' }, ...parents.map((p) => ({ label: p.name, href: `/f/${p.slug}` })), { label: forum.name, href: `/f/${forum.slug}` }, { label: thread.title }] });
});

async function ModTools({ ctx, thread, forum }: { ctx: PageCtx; thread: F.Thread; forum: F.Forum }) {
  const forums = await F.forumsForMoveSelect(ctx.viewer);
  const canAnnounce = ctx.canAdmin;
  return (
    <details class="mod-tools box">
      <summary class="box-head"><span class="box-title">Moderator tools</span></summary>
      <div class="box-body mod-grid">
        <div class="mod-actions">
          <ActionButton ctx={ctx} action={`/t/${thread.id}/moderate`} fields={{ action: thread.isLocked ? 'unlock' : 'lock' }} label={thread.isLocked ? 'Unlock' : 'Lock'} className="btn btn-small" />
          <ActionButton ctx={ctx} action={`/t/${thread.id}/moderate`} fields={{ action: thread.isSticky ? 'unsticky' : 'sticky' }} label={thread.isSticky ? 'Unstick' : 'Make sticky'} className="btn btn-small" />
          {canAnnounce ? <ActionButton ctx={ctx} action={`/t/${thread.id}/moderate`} fields={{ action: thread.isAnnouncement ? 'unannounce' : 'announce' }} label={thread.isAnnouncement ? 'Remove announcement' : 'Make announcement'} className="btn btn-small" /> : null}
          <ActionButton ctx={ctx} action={`/t/${thread.id}/moderate`} fields={{ action: thread.isDeleted ? 'restore' : 'delete' }} label={thread.isDeleted ? 'Restore thread' : 'Delete thread'} className="btn btn-small btn-danger" confirm={thread.isDeleted ? undefined : 'Delete this thread?'} />
        </div>
        <form method="post" action={`/t/${thread.id}/move`} class="inline-form"><Csrf ctx={ctx} />
          <label for="mv-forum">Move to</label>
          <select id="mv-forum" name="forumId">{forums.map((f) => <option value={f.id} selected={f.id === forum.id}>{f.name}</option>)}</select>
          <button class="btn btn-small">Move</button></form>
        <form method="post" action={`/t/${thread.id}/merge`} class="inline-form"><Csrf ctx={ctx} />
          <label for="mg-target">Merge into thread #</label>
          <input id="mg-target" name="targetId" inputmode="numeric" pattern="\d+" size={8} required />
          <button class="btn btn-small" data-confirm="Merge this thread into the target? This cannot be undone automatically.">Merge</button></form>
        <form method="post" action={`/t/${thread.id}/split`} id="split-form" class="inline-form"><Csrf ctx={ctx} />
          <label for="sp-title">Split selected posts (✂) into new thread</label>
          <input id="sp-title" name="title" placeholder="New thread title" maxlength={140} required />
          <button class="btn btn-small">Split</button></form>
      </div>
    </details>
  );
}

// ─────────────────────────── reply page / actions ───────────────────────────

async function replyPage(c: C, threadId: number, values: { body?: string } = {}, error?: string) {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const { thread, forum } = await F.loadThreadFor(v, threadId);
  await v.require('post.reply', forum.id);
  let body = values.body;
  if (body == null) {
    const quoteIds = (c.req.query('quote') ?? '').split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0).slice(0, 10);
    const parts: string[] = [];
    for (const id of quoteIds) {
      try {
        const { post } = await F.loadPostFor(v, id);
        if (post.threadId !== thread.id || post.isDeleted) continue;
        const author = (await userCards([post.userId])).get(post.userId);
        parts.push(quoteFor(author?.username ?? 'Member', post.id, post.body));
      } catch { /* skip */ }
    }
    const draft = await F.getDraft(v, `reply:${thread.id}`);
    body = parts.join('\n') + (draft?.body ?? '');
  }
  // last few posts for context (reverse chronological)
  const recent = await getDb().select().from(schema.posts).where(and(eq(schema.posts.threadId, thread.id), eq(schema.posts.isDeleted, false), eq(schema.posts.state, 'visible'))).orderBy(desc(schema.posts.position)).limit(5);
  const cards = await userCards(recent.map((p) => p.userId));
  const R = await rendererFor(v);
  return page(c, `Reply to ${thread.title}`, (
    <>
      <Box title={<>Reply to thread: {thread.title}</>}>
        {error ? <Notice type="error">{error}</Notice> : null}
        {thread.isLocked ? <Notice type="warn">This thread is locked; only moderators can reply.</Notice> : null}
        <form method="post" action={`/t/${thread.id}/reply`} class="post-form" data-editor-form>
          <Csrf ctx={ctx} />
          <Editor ctx={ctx} value={body} draftKey={`reply:${thread.id}`} />
          <div class="form-actions"><button class="btn btn-primary">Post reply</button> <a href={threadUrl(thread)}>Cancel</a></div>
        </form>
      </Box>
      <Box title="Most recent posts (newest first)">
        <ol class="mini-posts">{recent.map((p) => <li><div class="mini-head"><UserLink user={cards.get(p.userId)} /> · #{p.position}</div><div class="bb mini-body"><Html html={R.post(p.body, { embeds: false })} /></div></li>)}</ol>
      </Box>
    </>
  ), { crumbs: [{ label: forum.name, href: `/f/${forum.slug}` }, { label: thread.title, href: threadUrl(thread) }, { label: 'Reply' }], noPane: true });
}

forumRoutes.get('/t/:id/reply', async (c) => {
  if (!c.get('viewer').user) return loginRedirect(c);
  return replyPage(c, int(c.req.param('id')));
});

forumRoutes.post('/t/:id/reply', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const id = int(c.req.param('id'));
  const body = await form(c);
  try {
    const post = await F.reply(v, id, str(body.body), arr(body.uploads));
    if (post.state === 'held') setFlash(c, { type: 'info', text: 'Your reply is awaiting moderator approval.' });
    return c.redirect(`/p/${post.id}`);
  } catch (e) {
    if (e instanceof ServiceError && e.status < 500 && e.status !== 401 && e.code !== 'locked') return replyPage(c, id, { body: str(body.body) }, e.message);
    throw e;
  }
});

forumRoutes.get('/p/:id', async (c) => {
  const v = c.get('viewer');
  const { post, thread, forum } = await F.loadPostFor(v, int(c.req.param('id')));
  const p = await F.pageOfPost(v, post, forum.id);
  return c.redirect(`${threadUrl(thread, p)}#post-${post.id}`);
});

async function editPage(c: C, postId: number, values?: { body: string; title?: string }, error?: string) {
  const ctx = c.get('page');
  const { post, thread, forum } = await F.loadPostFor(ctx.viewer, postId);
  const own = ctx.viewer.user?.id === post.userId;
  if (!own && !(await ctx.viewer.can('mod.posts', forum.id))) throw new ServiceError('You can only edit your own posts.', 403);
  return page(c, 'Edit post', (
    <Box title={`Edit post #${post.position} in “${thread.title}”`}>
      {error ? <Notice type="error">{error}</Notice> : null}
      {!own ? <Notice type="warn">You are editing another member's post as a moderator. This is recorded in the audit log.</Notice> : null}
      <form method="post" action={`/p/${post.id}/edit`} class="post-form" data-editor-form>
        <Csrf ctx={ctx} />
        {post.position === 1 ? <Field label="Thread title" name="title" value={values?.title ?? thread.title} required maxlength={140} /> : null}
        <Editor ctx={ctx} value={values?.body ?? post.body} />
        <div class="form-actions"><button class="btn btn-primary">Save changes</button> <a href={`/p/${post.id}`}>Cancel</a></div>
      </form>
    </Box>
  ), { crumbs: [{ label: forum.name, href: `/f/${forum.slug}` }, { label: thread.title, href: threadUrl(thread) }, { label: 'Edit post' }], noPane: true });
}

forumRoutes.get('/p/:id/edit', async (c) => { if (!c.get('viewer').user) return loginRedirect(c); return editPage(c, int(c.req.param('id'))); });
forumRoutes.post('/p/:id/edit', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const id = int(c.req.param('id'));
  const body = await form(c);
  try {
    await F.editPost(v, id, str(body.body), body.title != null ? str(body.title) : null);
    setFlash(c, { type: 'ok', text: 'Post updated.' });
    return c.redirect(`/p/${id}`);
  } catch (e) {
    if (e instanceof ServiceError && e.status === 400 || (e instanceof ServiceError && e.status === 422)) return editPage(c, id, { body: str(body.body), title: str(body.title) }, e.message);
    throw e;
  }
});

forumRoutes.post('/p/:id/delete', async (c) => {
  const v = c.get('viewer');
  const id = int(c.req.param('id'));
  const { thread, forum } = await F.loadPostFor(v, id);
  const body = await form(c);
  const r = await F.deletePost(v, id, str(body.reason));
  setFlash(c, { type: 'ok', text: r.threadDeleted ? 'Thread deleted.' : 'Post deleted.' });
  return c.redirect(r.threadDeleted ? `/f/${forum.slug}` : threadUrl(thread));
});
forumRoutes.post('/p/:id/restore', async (c) => { const id = int(c.req.param('id')); await F.restorePost(c.get('viewer'), id); setFlash(c, { type: 'ok', text: 'Post restored.' }); return c.redirect(`/p/${id}`); });
forumRoutes.post('/p/:id/approve', async (c) => { const id = int(c.req.param('id')); await F.approvePost(c.get('viewer'), id); setFlash(c, { type: 'ok', text: 'Post approved.' }); return c.redirect(c.req.header('referer')?.includes('/mod') ? '/mod/held' : `/p/${id}`); });

forumRoutes.post('/p/:id/react', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const id = int(c.req.param('id'));
  const body = await form(c);
  const r = await F.react(v, id, str(body.reaction));
  if ((c.req.header('accept') ?? '').includes('json')) {
    const { posts } = { posts: await F.decoratePosts(v, [(await F.postById(id))!]) };
    return c.json({ ok: true, active: r.active, reactions: posts[0].reactions.map((x) => ({ ...x, ...F.REACTIONS.find((d) => d.key === x.key) })) });
  }
  return c.redirect(`/p/${id}`);
});

forumRoutes.get('/p/:id/reactions', async (c) => {
  const v = c.get('viewer');
  const id = int(c.req.param('id'));
  const { thread } = await F.loadPostFor(v, id);
  const list = await F.reactionList(v, id);
  return page(c, 'Reactions', (
    <Box title="Reactions to this post">
      {list.length ? <table class="data-table"><thead><tr><th>Reaction</th><th>Member</th></tr></thead><tbody>{list.map((r) => { const d = F.REACTIONS.find((x) => x.key === r.reaction); return <tr><td><span class={`rx rx-${r.reaction}`} aria-hidden="true" /> {d?.label}</td><td><a href={`/u/${encodeURIComponent(r.username)}`}>{r.username}</a></td></tr>; })}</tbody></table> : <p class="muted">No reactions yet.</p>}
      <p><a href={`/p/${id}`}>Back to the post</a></p>
    </Box>
  ), { crumbs: [{ label: thread.title, href: threadUrl(thread) }, { label: 'Reactions' }], noPane: true });
});

forumRoutes.get('/p/:id/history', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const id = int(c.req.param('id'));
  const { post, thread, forum } = await F.loadPostFor(v, id);
  if (v.user?.id !== post.userId && !(await v.can('mod.posts', forum.id))) throw new ServiceError('Only the author and moderators can see edit history.', 403);
  const { revisions } = await F.postRevisions(v, id);
  const R = await rendererFor(v);
  const editors = await userCards(revisions.map((r) => r.editedById));
  return page(c, 'Edit history', (
    <Box title={`Edit history for post #${post.position}`}>
      <h3>Current version</h3>
      <div class="bb revision"><Html html={R.post(post.body, { embeds: false })} /></div>
      {revisions.map((r) => <><h3>Before edit by <UserLink user={editors.get(r.editedById)} /> on <Time d={r.createdAt} tz={tz(ctx)} /></h3><div class="bb revision"><Html html={R.post(r.body, { embeds: false })} /></div></>)}
      <p><a href={`/p/${id}`}>Back to the post</a></p>
    </Box>
  ), { crumbs: [{ label: thread.title, href: threadUrl(thread) }, { label: 'Edit history' }], noPane: true });
});

forumRoutes.post('/t/:id/subscribe', async (c) => { const v = c.get('viewer'); if (!v.user) return loginRedirect(c); const id = int(c.req.param('id')); const b = await form(c); await F.toggleSubscription(v, id, str(b.on) === '1'); setFlash(c, { type: 'ok', text: str(b.on) === '1' ? 'Subscribed — you will be notified about new replies.' : 'Unsubscribed.' }); return c.redirect(`/t/${id}`); });
forumRoutes.post('/t/:id/bookmark', async (c) => { const v = c.get('viewer'); if (!v.user) return loginRedirect(c); const id = int(c.req.param('id')); const b = await form(c); await F.toggleBookmark(v, id, str(b.on) === '1'); setFlash(c, { type: 'ok', text: str(b.on) === '1' ? 'Thread bookmarked.' : 'Bookmark removed.' }); return c.redirect(`/t/${id}`); });

forumRoutes.post('/t/:id/tags', async (c) => {
  const v = c.get('viewer');
  const id = int(c.req.param('id'));
  const thread = await F.threadById(id);
  if (!thread) throw new ServiceError('Thread not found.', 404);
  const b = await form(c);
  try { await F.setThreadTags(v, thread, parseTags(b)); setFlash(c, { type: 'ok', text: 'Tags updated.' }); }
  catch (e) { if (e instanceof ServiceError && e.status < 500) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect(`/t/${id}`);
});

forumRoutes.post('/t/:id/moderate', async (c) => {
  const v = c.get('viewer');
  const id = int(c.req.param('id'));
  const a = str((await form(c)).action);
  const map: Record<string, () => Promise<void>> = {
    lock: () => F.setThreadFlags(v, id, { isLocked: true }), unlock: () => F.setThreadFlags(v, id, { isLocked: false }),
    sticky: () => F.setThreadFlags(v, id, { isSticky: true }), unsticky: () => F.setThreadFlags(v, id, { isSticky: false }),
    announce: () => F.setThreadFlags(v, id, { isAnnouncement: true }), unannounce: () => F.setThreadFlags(v, id, { isAnnouncement: false }),
    delete: () => F.deleteThread(v, id), restore: () => F.deleteThread(v, id, true),
  };
  if (!map[a]) throw new ServiceError('Unknown action.');
  await map[a]();
  setFlash(c, { type: 'ok', text: 'Thread updated.' });
  return c.redirect(`/t/${id}`);
});
forumRoutes.post('/t/:id/move', async (c) => { const id = int(c.req.param('id')); await F.moveThread(c.get('viewer'), id, int((await form(c)).forumId)); setFlash(c, { type: 'ok', text: 'Thread moved.' }); return c.redirect(`/t/${id}`); });
forumRoutes.post('/t/:id/merge', async (c) => { const id = int(c.req.param('id')); const target = int((await form(c)).targetId); await F.mergeThreads(c.get('viewer'), id, target); setFlash(c, { type: 'ok', text: 'Threads merged.' }); return c.redirect(`/t/${target}`); });
forumRoutes.post('/t/:id/split', async (c) => {
  const id = int(c.req.param('id'));
  const b = await form(c);
  const t = await F.splitThread(c.get('viewer'), id, arr(b.posts).map((x) => parseInt(x, 10)), str(b.title));
  setFlash(c, { type: 'ok', text: 'Posts split into a new thread.' });
  return c.redirect(threadUrl(t));
});

// ─────────────────────────── What's New, bookmarks, subscriptions ───────────────────────────

async function threadListPage(c: C, title: string, threads: F.ThreadRow[], opts: { empty: string; pagination?: { page: number; pages: number; href: (p: number) => string }; intro?: any }) {
  const ctx = c.get('page');
  const cards = await userCards(threads.flatMap((t) => [t.userId, t.lastPostUserId!]));
  const forums = await getDb().select({ id: schema.forums.id, name: schema.forums.name, slug: schema.forums.slug }).from(schema.forums);
  const fmap = new Map(forums.map((f) => [f.id, f]));
  return page(c, title, (
    <>
      <h1 class="page-title">{title}</h1>
      {opts.intro}
      {opts.pagination ? <Pagination {...opts.pagination} /> : null}
      <div class="table-wrap"><table class="thread-table"><thead><tr><th class="thread-icon"><span class="sr-only">Status</span></th><th>Thread</th><th class="col-last">Last Post</th><th class="col-num">Replies</th><th class="col-num">Views</th></tr></thead>
        <tbody>{threads.length ? <ThreadRows ctx={ctx} threads={threads} cards={cards} showForum forumNames={fmap} /> : <tr><td colspan={5}><EmptyState title={opts.empty} /></td></tr>}</tbody></table></div>
      {opts.pagination ? <Pagination {...opts.pagination} /> : null}
    </>
  ), { crumbs: [{ label: title }] });
}

forumRoutes.get('/whats-new', async (c) => {
  const v = c.get('viewer');
  const unreadOnly = c.req.query('unread') === '1' && !!v.user;
  const p = int(c.req.query('page'), 1);
  const r = await F.recentThreads(v, { page: p, unreadOnly });
  return threadListPage(c, 'What’s New', r.threads, {
    empty: unreadOnly ? 'You’re all caught up.' : 'No recent activity.',
    pagination: { page: r.page, pages: r.pages, href: (n) => `/whats-new?page=${n}${unreadOnly ? '&unread=1' : ''}` },
    intro: v.user ? <p class="tabs"><a href="/whats-new" class={!unreadOnly ? 'active' : ''}>All recent</a> · <a href="/whats-new?unread=1" class={unreadOnly ? 'active' : ''}>Unread only</a></p> : null,
  });
});
forumRoutes.get('/bookmarks', async (c) => { const v = c.get('viewer'); if (!v.user) return loginRedirect(c); return threadListPage(c, 'Bookmarks', await F.listBookmarks(v), { empty: 'No bookmarked threads. Use ☆ Bookmark on any thread to save it here.' }); });
forumRoutes.get('/subscriptions', async (c) => { const v = c.get('viewer'); if (!v.user) return loginRedirect(c); return threadListPage(c, 'Subscribed threads', await F.listSubscriptions(v), { empty: 'You are not subscribed to any threads.' }); });

// ─────────────────────────── reporting ───────────────────────────

forumRoutes.get('/report', async (c) => {
  const ctx = c.get('page');
  if (!ctx.viewer.user) return loginRedirect(c);
  const type = c.req.query('type') ?? '';
  const id = int(c.req.query('id'));
  return page(c, 'Report content', (
    <Box title="Report content to the moderators">
      <p>Reports are private. The member you report is not told who reported them.</p>
      <form method="post" action="/report" class="form-grid"><Csrf ctx={ctx} />
        <input type="hidden" name="type" value={type} /><input type="hidden" name="id" value={String(id)} />
        <fieldset class="field"><legend>Reason</legend>{Object.entries(REPORT_REASONS).map(([k, l], i) => <label class="radio"><input type="radio" name="reason" value={k} required checked={i === 0} /> {l}</label>)}</fieldset>
        <div class="field"><label for="rp-details">Details (optional)</label><textarea id="rp-details" name="details" rows={4} maxlength={2000} /></div>
        <div class="form-actions"><button class="btn btn-primary">Send report</button> <a href="/" data-back>Cancel</a></div>
      </form>
    </Box>
  ), { crumbs: [{ label: 'Report' }], noPane: true });
});

forumRoutes.post('/report', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return loginRedirect(c);
  const b = await form(c);
  const { createReport } = await import('../services/moderation.ts');
  await createReport(v, { targetType: str(b.type), targetId: int(b.id), reason: str(b.reason), details: str(b.details) });
  if ((c.req.header('accept') ?? '').includes('json')) return c.json({ ok: true });
  setFlash(c, { type: 'ok', text: 'Thanks — your report was sent to the moderators.' });
  const back = str(b.type) === 'post' ? `/p/${int(b.id)}` : str(b.type) === 'thread' ? `/t/${int(b.id)}` : '/';
  return c.redirect(back);
});

export const _x = { Breadcrumbs, getSetting };
