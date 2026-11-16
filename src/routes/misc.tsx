import { Hono } from 'hono';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, int, arr, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, Field, Pagination, UserLink, Time, Notice, Html, EmptyState, TagPill, Select } from '../web/components.tsx';
import { rendererFor } from '../web/content.ts';
import { getDb, schema } from '../db/client.ts';
import { userCards, ServiceError } from '../services/users.ts';
import { search, MAX_COUNTED } from '../services/search.ts';
import * as N from '../services/notifications.ts';
import * as E from '../services/emoji.ts';
import { fileToBuffer } from '../services/uploads.ts';
import { allTags } from '../services/forums.ts';
import { viewableForumIds } from '../services/permissions.ts';
import { numberFmt } from '../lib/time.ts';

export const miscRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';

miscRoutes.get('/rules', async (c) => {
  const ctx = c.get('page');
  const db = getDb();
  const rules = await db.select().from(schema.rules).orderBy(asc(schema.rules.displayOrder), asc(schema.rules.id));
  const [intro] = await db.select().from(schema.staticPages).where(eq(schema.staticPages.slug, 'rules-intro'));
  const R = await rendererFor(ctx.viewer);
  const sections = [...new Set(rules.map((r) => r.section))];
  return page(c, 'Community Rules', (
    <>
      <h1 class="page-title">Community Rules</h1>
      {intro ? <div class="box"><div class="box-body bb"><Html html={R.post(intro.body, { embeds: false })} /></div></div> : null}
      {sections.length > 1 ? <nav class="toc box" aria-label="Rule sections"><div class="box-body"><strong>Sections:</strong> {sections.map((s, i) => <>{i ? ' · ' : ''}<a href={`#rules-${i}`}>{s}</a></>)}</div></nav> : null}
      {sections.map((s, i) => (
        <Box title={s} id={`rules-${i}`}>
          <ol class="rules-list">{rules.filter((r) => r.section === s).map((r) => <li id={`rule-${r.id}`}><h3 class="rule-title">{r.title}</h3><div class="bb rule-body"><Html html={R.post(r.body, { embeds: false })} /></div></li>)}</ol>
        </Box>
      ))}
      {!rules.length ? <EmptyState title="No rules have been published yet." /> : null}
    </>
  ), { crumbs: [{ label: 'Rules' }] });
});

miscRoutes.get('/pages/:slug', async (c) => {
  const ctx = c.get('page');
  const [p] = await getDb().select().from(schema.staticPages).where(eq(schema.staticPages.slug, c.req.param('slug')));
  if (!p || p.slug === 'rules-intro') throw new ServiceError('Page not found.', 404);
  const R = await rendererFor(ctx.viewer);
  return page(c, p.title, (
    <Box title={p.title}><div class="bb static-page"><Html html={R.post(p.body, { embeds: false })} /></div><p class="muted small">Last updated <Time d={p.updatedAt} tz={tz(ctx)} mode="date" />.</p></Box>
  ), { crumbs: [{ label: p.title }] });
});

// ─────────────── search ───────────────

miscRoutes.get('/search', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  await v.require('search.use');
  const q = c.req.query();
  const type = q.type === 'threads' ? 'threads' : q.type === 'members' ? 'members' : 'posts';
  if (type === 'members') return c.redirect(`/members?q=${encodeURIComponent(q.q ?? '')}`);
  const hasQuery = !!(q.q || q.author || q.tag);
  const forums = await getDb().select({ id: schema.forums.id, name: schema.forums.name, slug: schema.forums.slug }).from(schema.forums).orderBy(schema.forums.categoryId, schema.forums.displayOrder);
  const visible = new Set(await viewableForumIds(v.subject));
  const tags = await allTags();
  let res: Awaited<ReturnType<typeof search>> | null = null;
  let err: string | null = null;
  if (hasQuery) {
    try { res = await search(v, { q: q.q ?? '', type, author: q.author || undefined, forum: q.forum || undefined, tag: q.tag || undefined, from: q.from, to: q.to, sort: q.sort === 'latest' ? 'latest' : 'relevance', page: int(q.page, 1) }); }
    catch (e) { if (e instanceof ServiceError && e.status === 429) err = e.message; else throw e; }
  }
  const cards = res ? await userCards(res.results.map((r) => (r.post ? r.post.userId : r.thread.userId))) : new Map();
  const href = (p: number) => `/search?${new URLSearchParams({ ...q, page: String(p) })}`;
  // member quick matches for the query
  let members: any[] = [];
  if (q.q && q.q.length >= 2 && !q.author) {
    const { searchMembers } = await import('../services/profiles.ts');
    members = (await searchMembers(v, { q: q.q, perPage: 5 })).members;
  }
  return page(c, 'Search', (
    <>
      <h1 class="page-title">Search</h1>
      <form method="get" action="/search" class="search-form box" role="search"><div class="box-body form-grid search-grid">
        <Field label="Keywords" name="q" value={q.q} maxlength={200} hint='Use quotes for phrases, - to exclude: "level design" -unity' />
        <Select label="Search in" name="type" value={type} options={[['posts', 'Posts'], ['threads', 'Thread titles'], ['members', 'Members']]} />
        <Field label="Posted by (username)" name="author" value={q.author} maxlength={32} attrs={{ 'data-member-autocomplete': '', list: 'author-suggest' }} />
        <datalist id="author-suggest" />
        <Select label="Forum" name="forum" value={q.forum ?? ''} options={[['', 'All forums'], ...forums.filter((f) => visible.has(f.id)).map((f) => [f.slug, f.name] as [string, string])]} />
        <Select label="Tag" name="tag" value={q.tag ?? ''} options={[['', 'Any tag'], ...tags.map((t) => [t.slug, t.name] as [string, string])]} />
        <Field label="From date" name="from" type="date" value={q.from} />
        <Field label="To date" name="to" type="date" value={q.to} />
        <Select label="Sort by" name="sort" value={q.sort ?? 'relevance'} options={[['relevance', 'Relevance'], ['latest', 'Newest first']]} />
        <div class="form-actions"><button class="btn btn-primary">Search</button></div>
      </div></form>
      {err ? <Notice type="error">{err}</Notice> : null}
      {members.length ? <Box title="Matching members"><p>{members.map((m, i) => <>{i ? ', ' : ''}<UserLink user={m} /></>)} — <a href={`/members?q=${encodeURIComponent(q.q)}`}>more</a></p></Box> : null}
      {res ? (
        <>
          <p class="muted">{res.total > MAX_COUNTED ? `${numberFmt(MAX_COUNTED)}+ results — add words or filters to narrow them down` : `${numberFmt(res.total)} result${res.total === 1 ? '' : 's'}`}. Direct messages are private and never included in search.</p>
          <Pagination page={res.page} pages={res.pages} href={href} />
          {res.results.length ? <ol class="search-results">{res.results.map((r) => (
            <li class="search-result">
              <div class="sr-title"><a href={r.post ? `/p/${r.post.id}` : `/t/${r.thread.id}-${r.thread.slug}`}>{r.thread.title}</a>{r.post ? <span class="muted"> · post #{r.post.position}</span> : null}</div>
              <div class="sr-meta"><UserLink user={cards.get(r.post ? r.post.userId : r.thread.userId)} /> · <Time d={r.post ? r.post.createdAt : r.thread.createdAt} tz={tz(ctx)} /></div>
              {r.excerpt ? <p class="sr-excerpt">{r.excerpt}</p> : null}
            </li>))}</ol> : <EmptyState title="No results.">Try fewer or different keywords.</EmptyState>}
          <Pagination page={res.page} pages={res.pages} href={href} />
        </>
      ) : null}
    </>
  ), { crumbs: [{ label: 'Search' }] });
});

// ─────────────── notifications ───────────────

miscRoutes.get('/notifications', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  if (!v.user) return c.redirect('/login?returnTo=/notifications');
  const before = int(c.req.query('before')) || undefined;
  const list = await N.listNotifications(v.user.id, { limit: 50, before });
  return page(c, 'Notifications', (
    <>
      <h1 class="page-title">Notifications</h1>
      <div class="list-controls">
        <form method="post" action="/notifications/read" class="inline-form"><Csrf ctx={ctx} /><input type="hidden" name="all" value="1" /><button class="btn btn-small">Mark all as read</button></form>
        <a href="/settings/notifications">Notification settings</a>
      </div>
      {list.length ? <ul class="notif-page-list">{list.map((n) => (
        <li class={`notif-item notif-${n.kind} ${n.readAt ? '' : 'is-unread'}`}>
          <a href={n.url}>{n.text}</a> <span class="muted"><Time d={n.createdAt} tz={tz(ctx)} mode="ago" /></span>
          {!n.readAt ? <form method="post" action="/notifications/read" class="inline-form"><Csrf ctx={ctx} /><input type="hidden" name="ids" value={String(n.id)} /><button class="link-btn">Mark read</button></form> : null}
        </li>))}</ul> : <EmptyState title="No notifications." />}
      {list.length === 50 ? <p><a href={`/notifications?before=${list[list.length - 1].id}`}>Older notifications</a></p> : null}
    </>
  ), { crumbs: [{ label: 'Notifications' }] });
});
miscRoutes.post('/notifications/read', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return c.redirect('/login');
  const b = await form(c);
  await N.markRead(v.user.id, str(b.all) === '1' ? 'all' : arr(b.ids).map((x) => parseInt(x, 10)).filter(Boolean));
  return c.redirect('/notifications');
});

// ─────────────── emoji ───────────────

miscRoutes.get('/emoji', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const list = await E.approvedEmoji();
  const mine = v.user ? await E.mySubmissions(v.user.id) : [];
  const canSubmit = await v.can('emoji.submit');
  const lim = (await import('../services/settings.ts')).getSetting;
  const limits = (await lim('upload_limits')).emoji;
  const cats = [...new Set(list.map((e) => e.category))];
  return page(c, 'Emoji', (
    <>
      <h1 class="page-title">Community emoji</h1>
      <p>Type <code>:shortcode:</code> in posts, comments and messages, or use the ☺ button in the editor. Standard Unicode emoji work everywhere too.</p>
      {cats.map((cat) => (
        <Box title={cat[0].toUpperCase() + cat.slice(1)}>
          <ul class="emoji-grid">{list.filter((e) => e.category === cat).map((e) => <li><img src={`/media/${e.pid}`} alt={`:${e.shortcode}:`} width="32" height="32" loading="lazy" /><code>:{e.shortcode}:</code><span class="muted small">{e.name}</span></li>)}</ul>
        </Box>
      ))}
      {!list.length ? <EmptyState title="No custom emoji yet." /> : null}
      {canSubmit ? (
        <Box title="Submit an emoji">
          <form method="post" action="/emoji/submit" enctype="multipart/form-data" class="form-grid"><Csrf ctx={ctx} />
            <Field label="Shortcode" name="shortcode" required maxlength={32} pattern="[a-z0-9_]{2,32}" hint="Lowercase letters, numbers and underscores, e.g. frag_wave" />
            <Field label="Name" name="name" required maxlength={60} />
            <Field label="Search keywords (optional)" name="keywords" maxlength={200} />
            <Field label="Description (optional)" name="description" maxlength={200} />
            <div class="field"><label for="f-emoji">Image</label><input id="f-emoji" type="file" name="file" accept="image/gif,image/png,image/webp" required />
              <div class="field-hint">GIF, PNG or WebP; at most {Math.round(limits.maxBytes / 1000)} KB, {limits.maxDim}×{limits.maxDim} px and {limits.maxFrames} animation frames. It will be resized to 128 px and reviewed by a moderator before appearing.</div></div>
            <p class="field-hint">Only submit images you made or have the right to share. No logos, real people's faces or anything against the rules.</p>
            <div class="form-actions"><button class="btn btn-primary">Submit for review</button></div>
          </form>
        </Box>
      ) : v.user ? <Notice type="info">Emoji submissions unlock once you become an Established Member.</Notice> : null}
      {mine.length ? <Box title="Your submissions"><table class="data-table"><thead><tr><th>Emoji</th><th>Status</th><th>Note</th></tr></thead><tbody>{mine.map(({ e, pid }) => <tr><td><img src={`/media/${pid}`} alt="" width="24" height="24" /> <code>:{e.shortcode}:</code></td><td><span class={`tag tag-status-${e.status}`}>{e.status}</span></td><td class="muted">{e.rejectionReason ?? ''}</td></tr>)}</tbody></table></Box> : null}
    </>
  ), { crumbs: [{ label: 'Emoji' }] });
});

miscRoutes.post('/emoji/submit', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return c.redirect('/login?returnTo=/emoji');
  const b = await form(c);
  try {
    const f = await fileToBuffer(b.file, 2_000_000);
    if (!f) throw new ServiceError('Choose an image.');
    await E.submitEmoji(v, { shortcode: str(b.shortcode), name: str(b.name), description: str(b.description), keywords: str(b.keywords), file: f.buf, fileName: f.name });
    setFlash(c, { type: 'ok', text: 'Thanks! Your emoji was submitted for review.' });
  } catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/emoji');
});

// Legacy URL: achievements moved into the achievements module.
miscRoutes.get('/achievements', (c) => c.redirect('/m/achievements', 301));

export const _x = { desc, TagPill };
