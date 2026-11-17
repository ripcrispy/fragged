import { Hono } from 'hono';
import { and, asc, desc, eq, sql, isNull, or, inArray } from 'drizzle-orm';
import type { Child } from 'hono/jsx';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, int, bool, arr, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, Field, TextArea, Checkbox, Select, Notice, ActionButton, Time, UserLink, EmptyState, Pagination, Stat, TagPill } from '../web/components.tsx';
import { getDb, schema } from '../db/client.ts';
import { PERMISSIONS, invalidatePermissionCache, loadPermissionData, type Perm, type CorePerm } from '../services/permissions.ts';
import { modulePermissions } from '../modules/runtime.ts';
import { registries } from '../modules/registry.ts';
import { adminUserPanels } from '../web/extensions.tsx';
import { auditLabel, humanise, TARGET_TYPES } from '../web/log-labels.ts';

/** Core permissions plus those declared by installed modules (grouped by module for display). */
export function permissionCatalog(): { key: string; label: string; group: string }[] {
  return [...Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label: label as string, group: 'Core' })), ...modulePermissions().map((p) => ({ key: p.key, label: p.label, group: p.module }))];
}
import { loadSettings, setSetting, SETTING_DEFAULTS, type SettingKey } from '../services/settings.ts';
import { audit } from '../services/audit.ts';
import { ServiceError, userCards, getUserById } from '../services/users.ts';
import { cleanLine, cleanText, slugify, parseHexColor } from '../lib/validate.ts';
import { listProviders, providerHealth } from '../services/oauth.ts';
import { config } from '../config.ts';
import * as Mod from '../services/moderation.ts';
import { testTerm, invalidatePolicy, validateRegex } from '../services/policy.ts';
import * as E from '../services/emoji.ts';
import { fileToBuffer } from '../services/uploads.ts';
import { themes, isTheme } from '../web/themes.ts';
import { numberFmt } from '../lib/time.ts';
import { recountForum } from '../services/forums.ts';
import { rowsOf } from '../services/notifications.ts';

export const adminRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';

const TABS: [string, string, Perm][] = [
  ['/admin', 'Dashboard', 'admin.access'], ['/admin/forums', 'Forums', 'admin.forums'], ['/admin/tags', 'Tags', 'admin.forums'], ['/admin/users', 'Users', 'admin.users'],
  ['/admin/groups', 'Groups & permissions', 'admin.groups'], ['/admin/terms', 'Restricted terms', 'admin.terms'], ['/admin/emoji', 'Emoji', 'admin.emoji'],
  ['/admin/pages', 'Rules & pages', 'admin.pages'], ['/admin/settings', 'Site settings', 'admin.settings'],
  ['/admin/modules', 'Modules', 'admin.modules'], ['/admin/auth', 'Sign-in providers', 'admin.auth'], ['/admin/audit', 'Audit log', 'admin.audit'], ['/admin/security', 'Security events', 'admin.audit'],
];

async function adminPage(c: C, title: string, perm: Perm, body: Child) {
  const ctx = c.get('page');
  await ctx.viewer.require('admin.access');
  await ctx.viewer.require(perm);
  const tabs = [];
  for (const t of TABS) if (await ctx.viewer.can(t[2])) tabs.push(t);
  for (const sec of registries.adminSections.active()) if (await ctx.viewer.can(sec.permission)) tabs.push([sec.href!, sec.label, sec.permission as Perm]);
  return page(c, `Admin — ${title}`, (
    <div class="settings-layout admin-layout">
      <nav class="settings-nav box" aria-label="Administration"><ul>{tabs.map(([h, l]) => <li><a href={h} class={ctx.path === h ? 'active' : ''} aria-current={ctx.path === h ? 'page' : undefined}>{l}</a></li>)}</ul></nav>
      <div class="settings-main"><h1 class="page-title">{title}</h1>{body}</div>
    </div>
  ), { crumbs: [{ label: 'Administration', href: '/admin' }, { label: title }], noPane: true });
}
/** The admin page shell (navigation + permission check), shared with the log viewers. */
export const adminShell = (c: C, title: string, perm: Perm, body: Child) => adminPage(c, title, perm, body);
const guard = async (c: C, perm: Perm) => { const v = c.get('viewer'); await v.require('admin.access'); await v.require(perm); return v; };

// ─────────────── dashboard ───────────────

adminRoutes.get('/admin', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.access');
  const db = getDb();
  const s = rowsOf(await db.execute(sql`select
    (select count(*) from users)::int as users, (select count(*) from users where created_at > now() - interval '7 days')::int as new_users,
    (select count(*) from threads where not is_deleted)::int as threads, (select count(*) from posts where not is_deleted)::int as posts,
    (select count(*) from posts where created_at > now() - interval '1 day')::int as posts_day, (select count(*) from direct_messages)::int as messages,
    (select count(*) from reports where status = 'open')::int as reports, (select count(*) from user_bans where lifted_at is null and (expires_at is null or expires_at > now()))::int as bans,
    (select count(*) from uploads)::int as uploads, (select coalesce(sum(bytes),0)::bigint from uploads) as upload_bytes`))[0];
  const recent = await db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(10);
  const actors = await userCards(recent.map((r) => r.actorId!).filter(Boolean));
  const settings = await loadSettings();
  return adminPage(c, 'Dashboard', 'admin.access', (
    <>
      {settings.maintenance_mode ? <Notice type="warn">Maintenance mode is ON. Only staff can use the site.</Notice> : null}
      <div class="stats-row stats-cards">
        <Stat label="Members" value={numberFmt(Number(s.users))} /><Stat label="New this week" value={numberFmt(Number(s.new_users))} />
        <Stat label="Threads" value={numberFmt(Number(s.threads))} /><Stat label="Posts" value={numberFmt(Number(s.posts))} />
        <Stat label="Posts today" value={numberFmt(Number(s.posts_day))} /><Stat label="Direct messages" value={numberFmt(Number(s.messages))} />
        <Stat label="Open reports" value={<a href="/mod/reports">{s.reports}</a>} /><Stat label="Active bans" value={s.bans} />
        <Stat label="Images stored" value={`${numberFmt(Number(s.uploads))} (${(Number(s.upload_bytes) / 1e6).toFixed(1)} MB)`} />
      </div>
      <Box title="Recent privileged actions" actions={<a href="/admin/audit">Full audit log</a>}>
        <table class="data-table"><tbody>{recent.map((r) => <tr><td><Time d={r.createdAt} tz={tz(ctx)} mode="ago" /></td><td><UserLink user={r.actorId ? actors.get(r.actorId) : null} /></td><td>{auditLabel(r.action)}<div class="small muted"><code>{r.action}</code></div></td><td class="small muted">{r.targetType ? `${TARGET_TYPES[r.targetType] ?? humanise(r.targetType)}${r.targetId ? ` #${r.targetId}` : ''}` : ''}</td></tr>)}</tbody></table>
      </Box>
    </>
  ));
});

// ─────────────── forums & categories ───────────────

adminRoutes.get('/admin/forums', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.forums');
  const db = getDb();
  const cats = await db.select().from(schema.categories).orderBy(asc(schema.categories.displayOrder));
  const forums = await db.select().from(schema.forums).orderBy(asc(schema.forums.displayOrder));
  const mods = await db.select().from(schema.forumModerators);
  const modCards = await userCards(mods.map((m) => m.userId));
  const ForumForm = ({ f }: { f?: typeof forums[number] }) => (
    <form method="post" action={f ? `/admin/forums/${f.id}` : '/admin/forums/new'} class="form-grid admin-forum-form"><Csrf ctx={ctx} />
      <div class="field-row">
        <Field label="Name" name="name" value={f?.name} required maxlength={80} />
        <Field label="Slug (URL)" name="slug" value={f?.slug} maxlength={80} hint="Leave blank to generate" />
        <Field label="Order" name="displayOrder" type="number" value={String(f?.displayOrder ?? 0)} />
      </div>
      <Field label="Description" name="description" value={f?.description} maxlength={300} />
      <div class="field-row">
        <Select label="Category" name="categoryId" value={String(f?.categoryId ?? cats[0]?.id ?? '')} options={cats.map((c) => [String(c.id), c.name])} />
        <Select label="Parent forum (subforum of)" name="parentForumId" value={String(f?.parentForumId ?? '')} options={[['', '— none —'], ...forums.filter((x) => x.id !== f?.id && !x.parentForumId).map((x) => [String(x.id), x.name] as [string, string])]} />
        <Field label="Icon key (optional)" name="icon" value={f?.icon} maxlength={40} />
      </div>
      <TextArea label="Forum notice / posting rules" name="rulesNotice" value={f?.rulesNotice} rows={2} />
      <div class="field-row">
        <Checkbox label="Hidden (staff only)" name="isHidden" checked={f?.isHidden} />
        <Checkbox label="Archived (read-only)" name="isArchived" checked={f?.isArchived} />
        <Checkbox label="Members may create new tags" name="allowUserTags" checked={f ? f.allowUserTags : true} />
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-small">{f ? 'Save forum' : 'Create forum'}</button>{f ? <> <a href={`/admin/forums/${f.id}/permissions`}>Permissions</a> · <a href={`/f/${f.slug}`}>View</a></> : null}</div>
    </form>
  );
  return adminPage(c, 'Forums', 'admin.forums', (
    <>
      <Box title="Categories">
        <table class="data-table"><thead><tr><th>Name</th><th>Slug</th><th>Order</th><th>Hidden</th><th /></tr></thead><tbody>
          {cats.map((cat) => <tr><td colspan={5}><form method="post" action={`/admin/categories/${cat.id}`} class="inline-form"><Csrf ctx={ctx} />
            <input name="name" value={cat.name} aria-label="Name" required maxlength={80} /><input name="slug" value={cat.slug} aria-label="Slug" maxlength={80} /><input name="description" value={cat.description} aria-label="Description" placeholder="Description" />
            <input name="displayOrder" type="number" value={String(cat.displayOrder)} aria-label="Order" class="input-narrow" /><label><input type="checkbox" name="isHidden" value="1" checked={cat.isHidden} /> hidden</label>
            <button class="btn btn-small">Save</button></form>
            {!forums.some((f) => f.categoryId === cat.id) ? <ActionButton ctx={ctx} action={`/admin/categories/${cat.id}/delete`} label="Delete" className="btn btn-small btn-danger" confirm="Delete this empty category?" /> : null}</td></tr>)}
        </tbody></table>
        <form method="post" action="/admin/categories/new" class="inline-form"><Csrf ctx={ctx} /><input name="name" placeholder="New category name" required maxlength={80} aria-label="New category name" /><input name="description" placeholder="Description" aria-label="Description" /><button class="btn btn-small btn-primary">Add category</button></form>
      </Box>
      {cats.map((cat) => (
        <Box title={`Forums in ${cat.name}`}>
          {forums.filter((f) => f.categoryId === cat.id).map((f) => (
            <details class="admin-forum"><summary><strong>{f.parentForumId ? '↳ ' : ''}{f.name}</strong> <span class="muted">/{f.slug} · {f.threadCount} threads · {f.postCount} posts{f.isHidden ? ' · hidden' : ''}{f.isArchived ? ' · archived' : ''}</span></summary>
              <ForumForm f={f} />
              <div class="forum-mods"><strong>Moderators:</strong> {mods.filter((m) => m.forumId === f.id).map((m) => <span class="chip"><UserLink user={modCards.get(m.userId)} /> <ActionButton ctx={ctx} action={`/admin/forums/${f.id}/moderators/remove`} fields={{ userId: m.userId }} label="×" className="link-btn" title="Remove moderator" /></span>)}
                <form method="post" action={`/admin/forums/${f.id}/moderators`} class="inline-form"><Csrf ctx={ctx} /><input name="username" placeholder="Username" required aria-label="Moderator username" /><button class="btn btn-small">Add moderator</button></form></div>
              {f.threadCount === 0 ? <ActionButton ctx={ctx} action={`/admin/forums/${f.id}/delete`} label="Delete empty forum" className="btn btn-small btn-danger" confirm="Delete this forum?" /> : null}
              <ActionButton ctx={ctx} action={`/admin/forums/${f.id}/recount`} label="Recount" className="btn btn-small" />
            </details>
          ))}
        </Box>
      ))}
      {cats.length ? <Box title="Create a forum"><ForumForm /></Box> : <Notice type="info">Create a category first.</Notice>}
    </>
  ));
});

function forumValues(b: Record<string, any>) {
  const name = cleanLine(b.name, 80);
  if (name.length < 2) throw new ServiceError('Forum name is required.');
  return {
    name, slug: slugify(str(b.slug) || name, 80), description: cleanLine(b.description, 300), categoryId: int(b.categoryId), parentForumId: int(b.parentForumId) || null,
    displayOrder: int(b.displayOrder), icon: cleanLine(b.icon, 40) || null, rulesNotice: cleanText(b.rulesNotice, 2000), isHidden: bool(b.isHidden), isArchived: bool(b.isArchived), allowUserTags: bool(b.allowUserTags),
  };
}
adminRoutes.post('/admin/forums/new', async (c) => { const v = await guard(c, 'admin.forums'); const vals = forumValues(await form(c)); const [f] = await getDb().insert(schema.forums).values(vals).returning(); invalidatePermissionCache(); await audit(v.user!.id, 'forum.create', { type: 'forum', id: f.id }, { name: f.name }, v.ip); setFlash(c, { type: 'ok', text: 'Forum created.' }); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/forums/:id', async (c) => { const v = await guard(c, 'admin.forums'); const id = int(c.req.param('id')); const vals = forumValues(await form(c)); if (vals.parentForumId === id) vals.parentForumId = null; await getDb().update(schema.forums).set(vals).where(eq(schema.forums.id, id)); invalidatePermissionCache(); await audit(v.user!.id, 'forum.update', { type: 'forum', id }, vals, v.ip); setFlash(c, { type: 'ok', text: 'Forum saved.' }); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/forums/:id/delete', async (c) => {
  const v = await guard(c, 'admin.forums'); const id = int(c.req.param('id'));
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.threads).where(eq(schema.threads.forumId, id));
  if (n > 0) throw new ServiceError('Only empty forums can be deleted. Move or delete its threads first.');
  await getDb().update(schema.forums).set({ parentForumId: null }).where(eq(schema.forums.parentForumId, id));
  await getDb().delete(schema.forums).where(eq(schema.forums.id, id)); await audit(v.user!.id, 'forum.delete', { type: 'forum', id }, {}, v.ip); return c.redirect('/admin/forums');
});
adminRoutes.post('/admin/forums/:id/recount', async (c) => { await guard(c, 'admin.forums'); await recountForum(int(c.req.param('id'))); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/forums/:id/moderators', async (c) => {
  const v = await guard(c, 'admin.forums'); const id = int(c.req.param('id'));
  const { getUserByUsername } = await import('../services/users.ts');
  const u = await getUserByUsername(str((await form(c)).username));
  if (!u) throw new ServiceError('No member with that username.');
  await getDb().insert(schema.forumModerators).values({ forumId: id, userId: u.id }).onConflictDoNothing();
  invalidatePermissionCache(); await audit(v.user!.id, 'forum.moderator_add', { type: 'forum', id }, { userId: u.id }, v.ip); return c.redirect('/admin/forums');
});
adminRoutes.post('/admin/forums/:id/moderators/remove', async (c) => { const v = await guard(c, 'admin.forums'); const id = int(c.req.param('id')); const uid = int((await form(c)).userId); await getDb().delete(schema.forumModerators).where(and(eq(schema.forumModerators.forumId, id), eq(schema.forumModerators.userId, uid))); invalidatePermissionCache(); await audit(v.user!.id, 'forum.moderator_remove', { type: 'forum', id }, { userId: uid }, v.ip); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/categories/new', async (c) => { const v = await guard(c, 'admin.forums'); const b = await form(c); const name = cleanLine(b.name, 80); if (!name) throw new ServiceError('Name required.'); const [cat] = await getDb().insert(schema.categories).values({ name, slug: slugify(name), description: cleanLine(b.description, 300), displayOrder: 99 }).returning(); await audit(v.user!.id, 'category.create', { type: 'category', id: cat.id }, { name }, v.ip); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/categories/:id', async (c) => { const v = await guard(c, 'admin.forums'); const b = await form(c); const id = int(c.req.param('id')); const name = cleanLine(b.name, 80); await getDb().update(schema.categories).set({ name, slug: slugify(str(b.slug) || name), description: cleanLine(b.description, 300), displayOrder: int(b.displayOrder), isHidden: bool(b.isHidden) }).where(eq(schema.categories.id, id)); await audit(v.user!.id, 'category.update', { type: 'category', id }, {}, v.ip); return c.redirect('/admin/forums'); });
adminRoutes.post('/admin/categories/:id/delete', async (c) => { const v = await guard(c, 'admin.forums'); const id = int(c.req.param('id')); const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.forums).where(eq(schema.forums.categoryId, id)); if (n) throw new ServiceError('Category is not empty.'); await getDb().delete(schema.categories).where(eq(schema.categories.id, id)); await audit(v.user!.id, 'category.delete', { type: 'category', id }, {}, v.ip); return c.redirect('/admin/forums'); });

// forum permission overrides (group matrix)
adminRoutes.get('/admin/forums/:id/permissions', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.groups');
  const id = int(c.req.param('id'));
  const [forum] = await getDb().select().from(schema.forums).where(eq(schema.forums.id, id));
  if (!forum) throw new ServiceError('Forum not found.', 404);
  const { groups, overrides } = await loadPermissionData();
  const forumPerms = (Object.keys(PERMISSIONS) as CorePerm[]).filter((p) => !p.startsWith('admin.') && !['member.view', 'search.use', 'profile.comment', 'profile.customize', 'message.send', 'message.attach_images', 'emoji.submit', 'user.change_username', 'user.signature', 'mod.users', 'mod.ban', 'mod.emoji', 'mod.terms_review', 'mod.messages', 'mod.comments'].includes(p));
  return adminPage(c, `Permissions: ${forum.name}`, 'admin.groups', (
    <form method="post" action={`/admin/forums/${id}/permissions`}><Csrf ctx={ctx} />
      <p>Override group permissions for this forum. "Inherit" uses the group's global setting. If any of a member's groups is set to Allow, they're allowed; otherwise Deny wins.</p>
      <div class="table-wrap"><table class="data-table perm-matrix"><thead><tr><th>Permission</th>{groups.map((g) => <th>{g.name}</th>)}</tr></thead><tbody>
        {forumPerms.map((p) => <tr><td>{PERMISSIONS[p]}<div class="muted small"><code>{p}</code></div></td>{groups.map((g) => {
          const ov = overrides.find((o) => o.forumId === id && o.groupId === g.id)?.permissions[p] ?? '';
          return <td><select name={`p:${g.id}:${p}`} aria-label={`${g.name}: ${p}`}><option value="" selected={!ov}>Inherit ({g.permissions[p] ? 'yes' : 'no'})</option><option value="allow" selected={ov === 'allow'}>Allow</option><option value="deny" selected={ov === 'deny'}>Deny</option></select></td>;
        })}</tr>)}
      </tbody></table></div>
      <div class="form-actions"><button class="btn btn-primary">Save forum permissions</button></div>
    </form>
  ));
});
adminRoutes.post('/admin/forums/:id/permissions', async (c) => {
  const v = await guard(c, 'admin.groups');
  const id = int(c.req.param('id'));
  const b = await form(c);
  const { groups } = await loadPermissionData();
  const db = getDb();
  for (const g of groups) {
    const perms: Record<string, 'allow' | 'deny'> = {};
    for (const p of Object.keys(PERMISSIONS)) { const val = str(b[`p:${g.id}:${p}`]); if (val === 'allow' || val === 'deny') perms[p] = val; }
    await db.delete(schema.permissionOverrides).where(and(eq(schema.permissionOverrides.forumId, id), eq(schema.permissionOverrides.groupId, g.id)));
    if (Object.keys(perms).length) await db.insert(schema.permissionOverrides).values({ forumId: id, groupId: g.id, permissions: perms });
  }
  invalidatePermissionCache();
  await audit(v.user!.id, 'forum.permissions', { type: 'forum', id }, {}, v.ip);
  setFlash(c, { type: 'ok', text: 'Forum permissions saved.' });
  return c.redirect(`/admin/forums/${id}/permissions`);
});

// ─────────────── tags ───────────────

adminRoutes.get('/admin/tags', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.forums');
  const tags = await getDb().select({ t: schema.tags, n: sql<number>`(select count(*) from thread_tags tt where tt.tag_id = ${schema.tags.id})::int` }).from(schema.tags).orderBy(asc(schema.tags.kind), asc(schema.tags.name));
  return adminPage(c, 'Tags & content labels', 'admin.forums', (
    <>
      <p>Official tags appear as choices when posting. Warning tags (Spoiler, NSFW, Trigger Warning and your own) gate thread content until a reader opts in. Member-created tags can be disabled if they're abusive or spammy.</p>
      <table class="data-table"><thead><tr><th>Tag</th><th>Kind</th><th>Official</th><th>Disabled</th><th>Threads</th><th /></tr></thead><tbody>
        {tags.map(({ t, n }) => <tr><td colspan={6}><form method="post" action={`/admin/tags/${t.id}`} class="inline-form"><Csrf ctx={ctx} />
          <TagPill tag={t} /> <input name="name" value={t.name} maxlength={32} aria-label="Name" />
          <select name="kind" aria-label="Kind"><option value="topic" selected={t.kind === 'topic'}>topic</option><option value="warning" selected={t.kind === 'warning'}>warning</option></select>
          <label><input type="checkbox" name="isOfficial" value="1" checked={t.isOfficial} /> official</label>
          <label><input type="checkbox" name="isDisabled" value="1" checked={t.isDisabled} /> disabled</label>
          <span class="muted">{n} threads</span> <button class="btn btn-small">Save</button></form></td></tr>)}
      </tbody></table>
      <form method="post" action="/admin/tags/new" class="inline-form"><Csrf ctx={ctx} /><input name="name" placeholder="New tag" required maxlength={32} aria-label="New tag name" />
        <select name="kind" aria-label="Kind"><option value="topic">topic</option><option value="warning">warning</option></select><button class="btn btn-small btn-primary">Add official tag</button></form>
    </>
  ));
});
adminRoutes.post('/admin/tags/new', async (c) => { const v = await guard(c, 'admin.forums'); const b = await form(c); const name = cleanLine(b.name, 32); if (!name) throw new ServiceError('Name required.'); const [t] = await getDb().insert(schema.tags).values({ name, slug: slugify(name, 40), kind: str(b.kind) === 'warning' ? 'warning' : 'topic', isOfficial: true, createdById: v.user!.id }).onConflictDoNothing().returning(); if (t) await audit(v.user!.id, 'tag.create', { type: 'tag', id: t.id }, { name }, v.ip); return c.redirect('/admin/tags'); });
adminRoutes.post('/admin/tags/:id', async (c) => { const v = await guard(c, 'admin.forums'); const b = await form(c); const id = int(c.req.param('id')); await getDb().update(schema.tags).set({ name: cleanLine(b.name, 32), kind: str(b.kind) === 'warning' ? 'warning' : 'topic', isOfficial: bool(b.isOfficial), isDisabled: bool(b.isDisabled) }).where(eq(schema.tags.id, id)); await audit(v.user!.id, 'tag.update', { type: 'tag', id }, {}, v.ip); return c.redirect('/admin/tags'); });

// ─────────────── users ───────────────

adminRoutes.get('/admin/users', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.users');
  const q = (c.req.query('q') ?? '').toLowerCase().trim();
  const pageNo = int(c.req.query('page'), 1);
  const db = getDb();
  const cond = q ? or(sql`${schema.users.usernameLower} like ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}`, eq(schema.users.emailLower, q)) : sql`true`;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(cond);
  const rows = await db.select().from(schema.users).where(cond).orderBy(desc(schema.users.createdAt)).limit(50).offset((pageNo - 1) * 50);
  const cards = await userCards(rows.map((r) => r.id));
  return adminPage(c, 'Users', 'admin.users', (
    <>
      <form method="get" action="/admin/users" class="inline-form"><label for="au-q">Search username or exact email</label> <input id="au-q" name="q" value={q} /> <button class="btn btn-small">Search</button></form>
      <Pagination page={pageNo} pages={Math.max(1, Math.ceil(n / 50))} href={(p) => `/admin/users?q=${encodeURIComponent(q)}&page=${p}`} />
      <table class="data-table"><thead><tr><th>User</th><th>Email</th><th>Group</th><th>Joined</th><th>Posts</th><th /></tr></thead><tbody>
        {rows.map((u) => <tr><td><UserLink user={cards.get(u.id)} />{u.closedAt ? <span class="tag">closed</span> : null}</td><td class="small">{u.email ?? '—'} {u.email ? (u.emailVerifiedAt ? '✓' : '(unverified)') : ''}</td><td>{cards.get(u.id)?.groupName}</td><td><Time d={u.createdAt} tz={tz(ctx)} mode="date" /></td><td>{u.postCount}</td><td><a href={`/admin/users/${u.id}`}>Manage</a></td></tr>)}
      </tbody></table>
    </>
  ));
});

adminRoutes.get('/admin/users/:id', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.users');
  const user = await getUserById(int(c.req.param('id')));
  if (!user) throw new ServiceError('User not found.', 404);
  const { groups, overrides } = await loadPermissionData();
  const memberships = await getDb().select().from(schema.userGroupMemberships).where(eq(schema.userGroupMemberships.userId, user.id));
  const defs = await getDb().select().from(schema.achievementDefinitions).orderBy(asc(schema.achievementDefinitions.displayOrder));
  const awards = await getDb().select().from(schema.userAchievements).where(eq(schema.userAchievements.userId, user.id));
  const linked = await getDb().select().from(schema.externalAccounts).where(eq(schema.externalAccounts.userId, user.id));
  const userOv = overrides.find((o) => o.forumId == null && o.userId === user.id)?.permissions ?? {};
  const card = (await userCards([user.id])).get(user.id)!;
  const isSuper = ctx.viewer.subject.isSuperAdmin;
  return adminPage(c, `User: ${user.username}`, 'admin.users', (
    <>
      <Box title="Account"><dl class="kv"><dt>Username</dt><dd><UserLink user={card} /></dd><dt>Email</dt><dd>{user.email ?? '—'} {user.email && !user.emailVerifiedAt ? <ActionButton ctx={ctx} action={`/admin/users/${user.id}/verify`} label="Mark verified" className="btn btn-small" /> : null}</dd>
        <dt>Sign-in</dt><dd>{user.passwordHash ? 'password' : ''}{linked.map((l) => ` · ${l.provider}`)}</dd><dt>Joined</dt><dd><Time d={user.createdAt} tz={tz(ctx)} /></dd><dt>Last seen</dt><dd><Time d={user.lastSeenAt} tz={tz(ctx)} mode="ago" /></dd></dl>
        <p><a href={`/mod/users/${user.id}`}>Moderation history, warnings and suspensions →</a></p></Box>
      <Box title="Groups">
        <form method="post" action={`/admin/users/${user.id}/groups`} class="form-grid"><Csrf ctx={ctx} />
          {groups.filter((g) => g.slug !== 'guest').map((g) => <Checkbox label={`${g.name}${g.isSuperAdmin ? ' (full access)' : ''}`} name="groups" value={String(g.id)} checked={memberships.some((m) => m.groupId === g.id)} />)}
          <Select label="Primary group" name="primary" value={String(user.primaryGroupId)} options={groups.filter((g) => g.slug !== 'guest').map((g) => [String(g.id), g.name])} />
          {!isSuper ? <p class="field-hint">Only full administrators can grant or remove administrator groups.</p> : null}
          <button class="btn btn-primary btn-small">Save groups</button>
        </form>
      </Box>
      <Box title="Per-user permission overrides">
        <form method="post" action={`/admin/users/${user.id}/permissions`}><Csrf ctx={ctx} />
          <div class="table-wrap"><table class="data-table"><tbody>{permissionCatalog().filter((x) => !x.key.startsWith('admin.')).map(({ key: p, label, group }) => <tr><td>{label} <code class="small">{p}</code>{group !== 'Core' ? <span class="tag">{group}</span> : null}</td><td>
            <select name={`p:${p}`} aria-label={p}><option value="">Inherit</option><option value="allow" selected={userOv[p] === 'allow'}>Allow</option><option value="deny" selected={userOv[p] === 'deny'}>Deny</option></select></td></tr>)}</tbody></table></div>
          <button class="btn btn-small btn-primary">Save overrides</button>
        </form>
      </Box>
      {await adminUserPanels({ viewer: ctx.viewer, user, ctx })}
    </>
  ));
});
adminRoutes.post('/admin/users/:id/verify', async (c) => { const v = await guard(c, 'admin.users'); const id = int(c.req.param('id')); await getDb().update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, id)); await audit(v.user!.id, 'user.verify_email', { type: 'user', id }, {}, v.ip); return c.redirect(`/admin/users/${id}`); });
adminRoutes.post('/admin/users/:id/groups', async (c) => {
  const v = await guard(c, 'admin.users');
  const id = int(c.req.param('id'));
  const b = await form(c);
  const { groups } = await loadPermissionData();
  const want = new Set(arr(b.groups).map((x) => parseInt(x, 10)));
  const current = new Set((await getDb().select().from(schema.userGroupMemberships).where(eq(schema.userGroupMemberships.userId, id))).map((m) => m.groupId));
  if (!v.subject.isSuperAdmin) {
    for (const g of groups.filter((g) => g.isSuperAdmin)) { if (current.has(g.id)) want.add(g.id); else want.delete(g.id); }
  }
  if (id === v.user!.id && groups.some((g) => g.isSuperAdmin && current.has(g.id) && !want.has(g.id))) throw new ServiceError('You cannot remove your own administrator access.');
  let primary = int(b.primary);
  if (!want.has(primary)) primary = [...want][0] ?? groups.find((g) => g.slug === 'member')!.id;
  want.add(primary);
  await getDb().transaction(async (tx) => {
    await tx.delete(schema.userGroupMemberships).where(eq(schema.userGroupMemberships.userId, id));
    await tx.insert(schema.userGroupMemberships).values([...want].filter((g) => groups.some((x) => x.id === g && x.slug !== 'guest')).map((groupId) => ({ userId: id, groupId })));
    await tx.update(schema.users).set({ primaryGroupId: primary }).where(eq(schema.users.id, id));
  });
  await audit(v.user!.id, 'user.groups', { type: 'user', id }, { groups: [...want], primary }, v.ip);
  setFlash(c, { type: 'ok', text: 'Groups saved.' });
  return c.redirect(`/admin/users/${id}`);
});
adminRoutes.post('/admin/users/:id/permissions', async (c) => {
  const v = await guard(c, 'admin.groups');
  const id = int(c.req.param('id'));
  const b = await form(c);
  const perms: Record<string, 'allow' | 'deny'> = {};
  for (const { key: p } of permissionCatalog()) { if (p.startsWith('admin.')) continue; const val = str(b[`p:${p}`]); if (val === 'allow' || val === 'deny') perms[p] = val; }
  await getDb().delete(schema.permissionOverrides).where(and(isNull(schema.permissionOverrides.forumId), eq(schema.permissionOverrides.userId, id)));
  if (Object.keys(perms).length) await getDb().insert(schema.permissionOverrides).values({ userId: id, permissions: perms });
  invalidatePermissionCache();
  await audit(v.user!.id, 'user.permissions', { type: 'user', id }, perms, v.ip);
  return c.redirect(`/admin/users/${id}`);
});

// ─────────────── groups ───────────────

adminRoutes.get('/admin/groups', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.groups');
  const { groups } = await loadPermissionData();
  const counts = await getDb().select({ g: schema.userGroupMemberships.groupId, n: sql<number>`count(*)::int` }).from(schema.userGroupMemberships).groupBy(schema.userGroupMemberships.groupId);
  const edit = groups.find((g) => g.id === int(c.req.query('edit')));
  const isSuper = ctx.viewer.subject.isSuperAdmin;
  return adminPage(c, 'Groups & permissions', 'admin.groups', (
    <>
      <table class="data-table"><thead><tr><th>Group</th><th>Title</th><th>Colour</th><th>Members</th><th>Staff</th><th /></tr></thead><tbody>
        {groups.sort((a, b) => a.displayOrder - b.displayOrder).map((g) => <tr><td><span class={`username gc gc-${g.id}`}>{g.name}</span> <code class="small">{g.slug}</code></td><td>{g.userTitle}</td><td>{g.color ?? '—'}</td><td>{counts.find((x) => x.g === g.id)?.n ?? 0}</td><td>{g.isSuperAdmin ? 'full access' : g.isStaff ? 'yes' : ''}</td><td><a href={`/admin/groups?edit=${g.id}`}>Edit</a></td></tr>)}
      </tbody></table>
      {edit ? (
        <Box title={`Edit group: ${edit.name}`}>
          {edit.isSuperAdmin && !isSuper ? <Notice type="warn">Only full administrators can change this group.</Notice> : (
            <form method="post" action={`/admin/groups/${edit.id}`} class="form-grid"><Csrf ctx={ctx} />
              <div class="field-row"><Field label="Name" name="name" value={edit.name} required maxlength={60} /><Field label="Default user title" name="userTitle" value={edit.userTitle} maxlength={60} /><Field label="Username colour (#rrggbb)" name="color" value={edit.color} maxlength={7} /></div>
              <div class="field-row"><Field label="Display order" name="displayOrder" type="number" value={String(edit.displayOrder)} /><Field label="Priority (decides colour/title)" name="priority" type="number" value={String(edit.priority)} /><Checkbox label="Staff group" name="isStaff" checked={edit.isStaff} /></div>
              <fieldset class="field perm-grid"><legend>Global permissions</legend>
                {permissionCatalog().map(({ key: p, label, group }) => <label class="check-inline"><input type="checkbox" name="perm" value={p} checked={!!edit.permissions[p] || edit.isSuperAdmin} disabled={edit.isSuperAdmin} /> {label} <code class="small">{p}</code>{group !== 'Core' ? <span class="tag">{group}</span> : null}</label>)}
              </fieldset>
              {edit.isSuperAdmin ? <p class="field-hint">This group has full access; individual permissions don't apply.</p> : null}
              <div class="form-actions"><button class="btn btn-primary">Save group</button></div>
            </form>
          )}
        </Box>
      ) : null}
      <Box title="Create a custom group">
        <form method="post" action="/admin/groups/new" class="inline-form"><Csrf ctx={ctx} /><input name="name" placeholder="Group name" required maxlength={60} aria-label="Group name" /><button class="btn btn-small btn-primary">Create (copies Registered Member permissions)</button></form>
      </Box>
    </>
  ));
});
adminRoutes.post('/admin/groups/new', async (c) => {
  const v = await guard(c, 'admin.groups');
  const name = cleanLine((await form(c)).name, 60);
  if (!name) throw new ServiceError('Name required.');
  const { groups } = await loadPermissionData();
  const base = groups.find((g) => g.slug === 'member')!;
  const [g] = await getDb().insert(schema.userGroups).values({ name, slug: slugify(name, 40) + '-' + Date.now().toString(36).slice(-4), permissions: base.permissions, priority: 15, displayOrder: 50 }).returning();
  invalidatePermissionCache();
  await audit(v.user!.id, 'group.create', { type: 'group', id: g.id }, { name }, v.ip);
  return c.redirect(`/admin/groups?edit=${g.id}`);
});
adminRoutes.post('/admin/groups/:id', async (c) => {
  const v = await guard(c, 'admin.groups');
  const id = int(c.req.param('id'));
  const { groups } = await loadPermissionData();
  const g = groups.find((x) => x.id === id);
  if (!g) throw new ServiceError('Group not found.', 404);
  if (g.isSuperAdmin && !v.subject.isSuperAdmin) throw new ServiceError('Only full administrators can change this group.', 403);
  const b = await form(c);
  const known = new Set(permissionCatalog().map((x) => x.key));
  const perms = Object.fromEntries(arr(b.perm).filter((p) => known.has(p)).map((p) => [p, true]));
  const color = str(b.color) ? parseHexColor(str(b.color)) : null;
  if (str(b.color) && !color) throw new ServiceError('Colour must be #rrggbb.');
  await getDb().update(schema.userGroups).set({ name: cleanLine(b.name, 60), userTitle: cleanLine(b.userTitle, 60) || null, color, displayOrder: int(b.displayOrder), priority: int(b.priority), isStaff: bool(b.isStaff), ...(g.isSuperAdmin ? {} : { permissions: perms }) }).where(eq(schema.userGroups.id, id));
  invalidatePermissionCache();
  await audit(v.user!.id, 'group.update', { type: 'group', id }, { permissions: Object.keys(perms) }, v.ip);
  setFlash(c, { type: 'ok', text: 'Group saved.' });
  return c.redirect(`/admin/groups?edit=${id}`);
});

// ─────────────── restricted terms ───────────────

adminRoutes.get('/admin/terms', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.terms');
  const terms = await getDb().select().from(schema.restrictedTerms).orderBy(asc(schema.restrictedTerms.category), asc(schema.restrictedTerms.id));
  const settings = await loadSettings();
  const testPattern = c.req.query('tp');
  const testResult = testPattern ? testTerm({ pattern: testPattern, matchType: (c.req.query('tm') as any) || 'word', action: 'flag', category: 'test' }, (c.req.query('ts') ?? '').split('\n').slice(0, 20)) : null;
  const regexErr = testPattern && c.req.query('tm') === 'regex' ? validateRegex(testPattern) : null;
  return adminPage(c, 'Restricted terms', 'admin.terms', (
    <>
      <Notice type="info" title="Mandatory policy layer.">Active terms apply to every member, regardless of their optional profanity filter. They're checked on submission (block / hold for moderation / flag for review) and redacted on display. Matching is case- and accent-insensitive and handles common substitutions (0→o, 1→i, $→s, spaced letters). <strong>Word</strong> terms only match whole words to limit false positives. New terms start inactive — test them first.</Notice>
      <Box title="Test a term before activating">
        <form method="get" action="/admin/terms" class="form-grid">
          <div class="field-row"><Field label="Pattern" name="tp" value={testPattern} maxlength={200} /><Select label="Match type" name="tm" value={c.req.query('tm') ?? 'word'} options={[['word', 'Whole word'], ['phrase', 'Phrase'], ['regex', 'Regular expression']]} /></div>
          <TextArea label="Sample texts (one per line)" name="ts" value={c.req.query('ts')} rows={4} />
          <button class="btn btn-small">Run test</button>
        </form>
        {regexErr ? <Notice type="error">{regexErr}</Notice> : null}
        {testResult ? <table class="data-table"><tbody>{testResult.map((r) => <tr><td>{r.sample}</td><td>{r.matches.length ? <strong class="text-danger">matches: {r.matches.join(', ')}</strong> : <span class="muted">no match</span>}</td></tr>)}</tbody></table> : null}
      </Box>
      <Box title={`Terms (${terms.length})`}>
        <details><summary>Show the term list (sensitive)</summary>
          <table class="data-table"><thead><tr><th>Pattern</th><th>Type</th><th>Category</th><th>Action</th><th>Active</th><th>Notes</th><th /></tr></thead><tbody>
            {terms.map((t) => <tr><td colspan={7}><form method="post" action={`/admin/terms/${t.id}`} class="inline-form"><Csrf ctx={ctx} />
              <input name="pattern" value={t.pattern} required maxlength={200} aria-label="Pattern" />
              <select name="matchType" aria-label="Type">{['word', 'phrase', 'regex'].map((m) => <option selected={m === t.matchType}>{m}</option>)}</select>
              <input name="category" value={t.category} maxlength={32} aria-label="Category" class="input-narrow" />
              <select name="action" aria-label="Action">{['block', 'hold', 'flag', 'redact'].map((m) => <option selected={m === t.action}>{m}</option>)}</select>
              <label><input type="checkbox" name="isActive" value="1" checked={t.isActive} /> active</label>
              <input name="notes" value={t.notes} placeholder="notes" aria-label="Notes" />
              <button class="btn btn-small">Save</button></form>
              <ActionButton ctx={ctx} action={`/admin/terms/${t.id}/delete`} label="Delete" className="btn btn-small btn-danger" confirm="Delete this term?" /></td></tr>)}
          </tbody></table>
        </details>
        <form method="post" action="/admin/terms/new" class="inline-form add-term"><Csrf ctx={ctx} />
          <input name="pattern" placeholder="Term or pattern" required maxlength={200} aria-label="New pattern" />
          <select name="matchType" aria-label="Type"><option>word</option><option>phrase</option><option>regex</option></select>
          <input name="category" placeholder="category (slur, harassment…)" maxlength={32} aria-label="Category" />
          <select name="action" aria-label="Action"><option value="block">block</option><option value="hold">hold</option><option value="flag">flag</option><option value="redact">redact</option></select>
          <label><input type="checkbox" name="isActive" value="1" /> activate now</label>
          <button class="btn btn-small btn-primary">Add term</button>
        </form>
      </Box>
      <Box title="Optional profanity list">
        <p>Masked only for members who keep the profanity filter switched on (default: {settings.profanity_default ? 'on' : 'off'}). Not a moderation tool — use restricted terms for prohibited language.</p>
        <form method="post" action="/admin/terms/profanity" class="form-grid"><Csrf ctx={ctx} />
          <TextArea label="Words (one per line)" name="words" value={settings.profanity_words.join('\n')} rows={8} />
          <Checkbox label="Filter is on by default for new members" name="profanityDefault" checked={settings.profanity_default} />
          <button class="btn btn-small btn-primary">Save profanity list</button>
        </form>
      </Box>
    </>
  ));
});
const termInput = (b: Record<string, any>) => ({ pattern: str(b.pattern), matchType: str(b.matchType), category: str(b.category), action: str(b.action), isActive: bool(b.isActive), notes: str(b.notes) });
adminRoutes.post('/admin/terms/new', async (c) => { await Mod.saveTerm(c.get('viewer'), termInput(await form(c))); setFlash(c, { type: 'ok', text: 'Term added.' }); return c.redirect('/admin/terms'); });
adminRoutes.post('/admin/terms/profanity', async (c) => {
  const v = await guard(c, 'admin.terms');
  const b = await form(c);
  const words = [...new Set(str(b.words).split('\n').map((w) => w.trim().toLowerCase()).filter((w) => w && w.length <= 40))].slice(0, 2000);
  await setSetting('profanity_words', words);
  await setSetting('profanity_default', bool(b.profanityDefault));
  invalidatePolicy();
  await audit(v.user!.id, 'profanity.update', {}, { count: words.length }, v.ip);
  setFlash(c, { type: 'ok', text: 'Profanity list saved.' });
  return c.redirect('/admin/terms');
});
adminRoutes.post('/admin/terms/:id', async (c) => { await Mod.saveTerm(c.get('viewer'), { ...termInput(await form(c)), id: int(c.req.param('id')) }); setFlash(c, { type: 'ok', text: 'Term saved.' }); return c.redirect('/admin/terms'); });
adminRoutes.post('/admin/terms/:id/delete', async (c) => { await Mod.deleteTerm(c.get('viewer'), int(c.req.param('id'))); return c.redirect('/admin/terms'); });

// ─────────────── emoji library ───────────────

adminRoutes.get('/admin/emoji', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.emoji');
  const approved = await E.emojiQueue('approved');
  return adminPage(c, 'Emoji', 'admin.emoji', (
    <>
      <p>Review member submissions in the <a href="/mod/emoji">emoji queue</a>. Staff uploads here are approved immediately.</p>
      <Box title="Add an official emoji">
        <form method="post" action="/admin/emoji" enctype="multipart/form-data" class="form-grid"><Csrf ctx={ctx} />
          <div class="field-row"><Field label="Shortcode" name="shortcode" required maxlength={32} /><Field label="Name" name="name" required maxlength={60} /><Field label="Category" name="category" value="fragged" maxlength={32} /></div>
          <Field label="Keywords" name="keywords" maxlength={200} />
          <div class="field"><label for="ae-file">Image (GIF/PNG/WebP)</label><input id="ae-file" type="file" name="file" accept="image/gif,image/png,image/webp" required /></div>
          <button class="btn btn-primary btn-small">Add emoji</button>
        </form>
      </Box>
      <Box title={`Library (${approved.length})`}><ul class="emoji-grid">{approved.map(({ e, pid }) => <li><img src={`/media/${pid}`} alt="" width="32" height="32" /><code>:{e.shortcode}:</code><span class="small muted">used {e.usageCount}×</span><ActionButton ctx={ctx} action={`/mod/emoji/${e.id}`} fields={{ decision: 'disable' }} label="Disable" className="link-btn" /></li>)}</ul></Box>
    </>
  ));
});
adminRoutes.post('/admin/emoji', async (c) => {
  const v = await guard(c, 'admin.emoji');
  const b = await form(c);
  try {
    const f = await fileToBuffer(b.file, 2_000_000);
    if (!f) throw new ServiceError('Choose an image.');
    await E.submitEmoji(v, { shortcode: str(b.shortcode), name: str(b.name), keywords: str(b.keywords), file: f.buf, fileName: f.name }, { autoApprove: true, category: cleanLine(b.category, 32) || 'fragged' });
    setFlash(c, { type: 'ok', text: 'Emoji added.' });
  } catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/admin/emoji');
});

// ─────────────── rules & pages ───────────────

adminRoutes.get('/admin/pages', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.pages');
  const pages = await getDb().select().from(schema.staticPages).orderBy(asc(schema.staticPages.slug));
  const rules = await getDb().select().from(schema.rules).orderBy(asc(schema.rules.displayOrder));
  return adminPage(c, 'Rules & pages', 'admin.pages', (
    <>
      <Box title="Community rules">
        {rules.map((r) => <details class="admin-forum"><summary>{r.section} › <strong>{r.title}</strong></summary>
          <form method="post" action={`/admin/rules/${r.id}`} class="form-grid"><Csrf ctx={ctx} /><div class="field-row"><Field label="Section" name="section" value={r.section} required /><Field label="Title" name="title" value={r.title} required /><Field label="Order" name="displayOrder" type="number" value={String(r.displayOrder)} /></div>
            <TextArea label="Body (BBCode)" name="body" value={r.body} rows={4} /><div class="form-actions"><button class="btn btn-small btn-primary">Save</button></div></form>
          <ActionButton ctx={ctx} action={`/admin/rules/${r.id}/delete`} label="Delete rule" className="btn btn-small btn-danger" confirm="Delete this rule?" /></details>)}
        <h3>Add a rule</h3>
        <form method="post" action="/admin/rules/new" class="form-grid"><Csrf ctx={ctx} /><div class="field-row"><Field label="Section" name="section" required /><Field label="Title" name="title" required /><Field label="Order" name="displayOrder" type="number" value="100" /></div><TextArea label="Body (BBCode)" name="body" rows={3} /><button class="btn btn-small btn-primary">Add rule</button></form>
      </Box>
      <Box title="Static pages">
        {pages.map((p) => <details class="admin-forum"><summary><strong>{p.title}</strong> <span class="muted">/pages/{p.slug}</span></summary>
          <form method="post" action={`/admin/pages/${p.id}`} class="form-grid"><Csrf ctx={ctx} /><Field label="Title" name="title" value={p.title} required /><TextArea label="Body (BBCode)" name="body" value={p.body} rows={12} /><button class="btn btn-small btn-primary">Save page</button></form></details>)}
        <h3>New page</h3>
        <form method="post" action="/admin/pages/new" class="form-grid"><Csrf ctx={ctx} /><div class="field-row"><Field label="Slug" name="slug" required maxlength={48} /><Field label="Title" name="title" required /></div><TextArea label="Body (BBCode)" name="body" rows={4} /><button class="btn btn-small btn-primary">Create page</button></form>
      </Box>
    </>
  ));
});
adminRoutes.post('/admin/rules/new', async (c) => { const v = await guard(c, 'admin.pages'); const b = await form(c); const [r] = await getDb().insert(schema.rules).values({ section: cleanLine(b.section, 80), title: cleanLine(b.title, 120), body: cleanText(b.body, 10000), displayOrder: int(b.displayOrder) }).returning(); await audit(v.user!.id, 'rule.create', { type: 'rule', id: r.id }, {}, v.ip); return c.redirect('/admin/pages'); });
adminRoutes.post('/admin/rules/:id', async (c) => { const v = await guard(c, 'admin.pages'); const b = await form(c); const id = int(c.req.param('id')); await getDb().update(schema.rules).set({ section: cleanLine(b.section, 80), title: cleanLine(b.title, 120), body: cleanText(b.body, 10000), displayOrder: int(b.displayOrder) }).where(eq(schema.rules.id, id)); await audit(v.user!.id, 'rule.update', { type: 'rule', id }, {}, v.ip); return c.redirect('/admin/pages'); });
adminRoutes.post('/admin/rules/:id/delete', async (c) => { const v = await guard(c, 'admin.pages'); const id = int(c.req.param('id')); await getDb().delete(schema.rules).where(eq(schema.rules.id, id)); await audit(v.user!.id, 'rule.delete', { type: 'rule', id }, {}, v.ip); return c.redirect('/admin/pages'); });
adminRoutes.post('/admin/pages/new', async (c) => { const v = await guard(c, 'admin.pages'); const b = await form(c); const [p] = await getDb().insert(schema.staticPages).values({ slug: slugify(str(b.slug), 48), title: cleanLine(b.title, 120), body: cleanText(b.body, 50000), updatedById: v.user!.id }).returning(); await audit(v.user!.id, 'page.create', { type: 'page', id: p.id }, { slug: p.slug }, v.ip); return c.redirect('/admin/pages'); });
adminRoutes.post('/admin/pages/:id', async (c) => { const v = await guard(c, 'admin.pages'); const b = await form(c); const id = int(c.req.param('id')); await getDb().update(schema.staticPages).set({ title: cleanLine(b.title, 120), body: cleanText(b.body, 50000), updatedAt: new Date(), updatedById: v.user!.id }).where(eq(schema.staticPages.id, id)); await audit(v.user!.id, 'page.update', { type: 'page', id }, {}, v.ip); return c.redirect('/admin/pages'); });

// ─────────────── site settings ───────────────

adminRoutes.get('/admin/settings', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.settings');
  const s = await loadSettings();
  const lim = s.upload_limits;
  return adminPage(c, 'Site settings', 'admin.settings', (
    <form method="post" action="/admin/settings" class="form-grid settings-form"><Csrf ctx={ctx} />
      <Box title="General" headingLevel={2}>
        <Field label="Site name" name="site_name" value={s.site_name} maxlength={60} />
        <Field label="Tagline" name="site_tagline" value={s.site_tagline} maxlength={120} />
        <Field label="Announcement banner (blank for none)" name="announcement" value={s.announcement} maxlength={300} />
        <Select label="Default theme (guests and new members)" name="default_theme" value={s.default_theme} options={themes().map((t) => [t.id, t.name])} />
        <Checkbox label="Maintenance mode (only staff can use the site)" name="maintenance_mode" checked={s.maintenance_mode} />
        <Field label="Maintenance message" name="maintenance_message" value={s.maintenance_message} maxlength={300} />
      </Box>
      <Box title="Registration" headingLevel={2}>
        <Checkbox label="Registration open" name="registration_open" checked={s.registration_open} />
        <Checkbox label="Allow username + password registration" name="allow_password_registration" checked={s.allow_password_registration} />
        <Checkbox label="Allow registration through sign-in providers" name="allow_oauth_registration" checked={s.allow_oauth_registration} />
        <Checkbox label="Require email verification before posting" name="require_email_verification" checked={s.require_email_verification} />
        <Checkbox label="Ask for date of birth" name="require_date_of_birth" checked={s.require_date_of_birth} />
        <Field label="Minimum age" name="minimum_age" type="number" value={String(s.minimum_age)} hint="Set according to your jurisdiction and policy (e.g. 13, 16 or 18)." />
        <TextArea label="Reserved usernames (one per line, in addition to built-in staff/system names)" name="reserved_usernames" value={s.reserved_usernames.join('\n')} rows={3} />
        <Field label="Days between username changes" name="username_change_days" type="number" value={String(s.username_change_days)} />
        <Field label="Posts required for Established Member" name="established_post_threshold" type="number" value={String(s.established_post_threshold)} />
      </Box>
      <Box title="Content" headingLevel={2}>
        <div class="field-row"><Field label="Threads per page" name="threads_per_page" type="number" value={String(s.threads_per_page)} /><Field label="Posts per page (guests)" name="posts_per_page" type="number" value={String(s.posts_per_page)} /></div>
        <div class="field-row"><Field label="Own-post edit window (minutes, 0 = unlimited)" name="edit_window_minutes" type="number" value={String(s.edit_window_minutes)} /><Field label="Own-post delete window (minutes, 0 = unlimited)" name="delete_window_minutes" type="number" value={String(s.delete_window_minutes)} /></div>
        <div class="field-row"><Field label="Max topic tags per thread" name="max_tags_per_thread" type="number" value={String(s.max_tags_per_thread)} /><Field label="Posts needed to create tags" name="user_tag_min_posts" type="number" value={String(s.user_tag_min_posts)} /></div>
      </Box>
      <Box title="Upload policy (images only — video and file uploads are not supported)" headingLevel={2}>
        {(['avatar', 'cover', 'post', 'message', 'emoji'] as const).map((k) => <div class="field-row"><strong class="input-label-inline">{k}</strong>
          <Field label="Max KB" name={`ul_${k}_kb`} type="number" value={String(Math.round(lim[k].maxBytes / 1000))} /><Field label="Max px (each side)" name={`ul_${k}_dim`} type="number" value={String(lim[k].maxDim)} />
          {k === 'emoji' ? <Field label="Max frames" name="ul_emoji_frames" type="number" value={String(lim.emoji.maxFrames)} /> : null}
          {k === 'post' ? <Field label="Images per post" name="ul_post_count" type="number" value={String(lim.post.perPost)} /> : null}
          {k === 'message' ? <Field label="Images per message" name="ul_message_count" type="number" value={String(lim.message.perMessage)} /> : null}</div>)}
      </Box>
      <Box title="Privacy, notifications & security" headingLevel={2}>
        <Checkbox label="Presence (online status) enabled" name="presence_enabled" checked={s.presence_enabled} />
        <Checkbox label="Show 'Online now' list" name="show_online_list" checked={s.show_online_list} />
        <Checkbox label="Email notifications enabled" name="email_notifications_enabled" checked={s.email_notifications_enabled} />
        <div class="field-row"><Field label="Session length (days)" name="session_days" type="number" value={String(s.session_days)} /><Field label="Remember-me length (days)" name="remember_days" type="number" value={String(s.remember_days)} /><Field label="Re-authentication window (minutes)" name="reauth_minutes" type="number" value={String(s.reauth_minutes)} /></div>
        <TextArea label="Rate-limit overrides (JSON: {&quot;post&quot;:{&quot;max&quot;:6,&quot;windowSec&quot;:60}})" name="rate_limits" value={JSON.stringify(s.rate_limits)} rows={3} />
        <p class="field-hint">Email transport: {config.SMTP_URL ? 'SMTP configured via SMTP_URL.' : 'not configured — mail is written to DATA_DIR/mail (development).'}</p>
      </Box>
      <div class="form-actions"><button class="btn btn-primary">Save all settings</button></div>
    </form>
  ));
});
adminRoutes.post('/admin/settings', async (c) => {
  const v = await guard(c, 'admin.settings');
  const b = await form(c);
  const n = (k: string, min: number, max: number) => Math.min(max, Math.max(min, int(b[k], min)));
  let rl: Record<string, { max: number; windowSec: number }> = {};
  try { const parsed = JSON.parse(str(b.rate_limits) || '{}'); for (const [k, val] of Object.entries(parsed as any)) { const x = val as any; if (Number.isInteger(x?.max) && Number.isInteger(x?.windowSec) && x.max > 0 && x.windowSec > 0) rl[k] = { max: x.max, windowSec: x.windowSec }; } } catch { throw new ServiceError('Rate-limit overrides must be valid JSON.'); }
  const values: Partial<Record<SettingKey, any>> = {
    site_name: cleanLine(b.site_name, 60) || SETTING_DEFAULTS.site_name, site_tagline: cleanLine(b.site_tagline, 120), announcement: cleanLine(b.announcement, 300),
    default_theme: isTheme(str(b.default_theme)) ? str(b.default_theme) : 'classic', maintenance_mode: bool(b.maintenance_mode), maintenance_message: cleanLine(b.maintenance_message, 300),
    registration_open: bool(b.registration_open), allow_password_registration: bool(b.allow_password_registration), allow_oauth_registration: bool(b.allow_oauth_registration),
    require_email_verification: bool(b.require_email_verification), require_date_of_birth: bool(b.require_date_of_birth), minimum_age: n('minimum_age', 0, 21),
    reserved_usernames: str(b.reserved_usernames).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 500), username_change_days: n('username_change_days', 0, 3650), established_post_threshold: n('established_post_threshold', 0, 100000),
    threads_per_page: n('threads_per_page', 5, 100), posts_per_page: n('posts_per_page', 5, 100), edit_window_minutes: n('edit_window_minutes', 0, 525600), delete_window_minutes: n('delete_window_minutes', 0, 525600),
    max_tags_per_thread: n('max_tags_per_thread', 0, 10), user_tag_min_posts: n('user_tag_min_posts', 0, 10000),
    upload_limits: {
      avatar: { maxBytes: n('ul_avatar_kb', 50, 20000) * 1000, maxDim: n('ul_avatar_dim', 64, 10000) },
      cover: { maxBytes: n('ul_cover_kb', 50, 30000) * 1000, maxDim: n('ul_cover_dim', 256, 12000) },
      post: { maxBytes: n('ul_post_kb', 50, 30000) * 1000, maxDim: n('ul_post_dim', 256, 12000), perPost: n('ul_post_count', 0, 20) },
      message: { maxBytes: n('ul_message_kb', 50, 30000) * 1000, maxDim: n('ul_message_dim', 256, 12000), perMessage: n('ul_message_count', 0, 10) },
      emoji: { maxBytes: n('ul_emoji_kb', 10, 2000) * 1000, maxDim: n('ul_emoji_dim', 32, 1024), maxFrames: n('ul_emoji_frames', 1, 500) },
    },
    presence_enabled: bool(b.presence_enabled), show_online_list: bool(b.show_online_list), email_notifications_enabled: bool(b.email_notifications_enabled),
    session_days: n('session_days', 1, 30), remember_days: n('remember_days', 1, 365), reauth_minutes: n('reauth_minutes', 1, 240), rate_limits: rl,
  };
  for (const [k, val] of Object.entries(values)) await setSetting(k as SettingKey, val);
  await audit(v.user!.id, 'settings.update', {}, { keys: Object.keys(values) }, v.ip);
  setFlash(c, { type: 'ok', text: 'Settings saved.' });
  return c.redirect('/admin/settings');
});

// ─────────────── sign-in providers ───────────────

adminRoutes.get('/admin/auth', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.auth');
  const providers = await listProviders();
  const health = await providerHealth();
  return adminPage(c, 'Sign-in providers', 'admin.auth', (
    <>
      <Notice type="info">Client IDs and secrets are read from environment variables (or your secrets manager) and are never shown here or logged. Register each provider's redirect URI exactly as listed.</Notice>
      <form method="post" action="/admin/auth" class="form-grid"><Csrf ctx={ctx} />
        <table class="data-table"><thead><tr><th>Provider</th><th>Credentials</th><th>Redirect URI</th><th>Last 7 days</th><th>Enabled</th></tr></thead><tbody>
          {providers.map((p) => {
            const h = health.filter((x) => x.provider === p.id);
            const ok = h.find((x) => x.kind === 'login')?.n ?? 0;
            const failed = health.filter((x) => x.provider === p.id && x.kind === 'oauth_failed').reduce((a, x) => a + x.n, 0);
            return <tr><td><strong>{p.name}</strong>{p.pkce ? <span class="tag">PKCE</span> : null}</td>
              <td>{p.configured ? <span class="tag tag-ok">configured</span> : <span class="tag tag-held">not configured</span>}<div class="small muted"><code>{p.envVars.join(', ') || '—'}</code></div></td>
              <td><code class="small">{config.APP_URL}/auth/{p.id}/callback</code></td>
              <td class="small">{ok} sign-ins · {failed ? <strong class="text-danger">{failed} failures</strong> : '0 failures'}</td>
              <td><input type="checkbox" name="enabled" value={p.id} checked={p.enabled || (!p.configured && false)} disabled={!p.configured} aria-label={`Enable ${p.name}`} /></td></tr>;
          })}
        </tbody></table>
        <button class="btn btn-primary btn-small">Save</button>
      </form>
      <p><a href="/admin/security?kind=oauth_failed">View authentication failures</a> · <a href="/admin/security">All security events</a></p>
    </>
  ));
});
adminRoutes.post('/admin/auth', async (c) => {
  const v = await guard(c, 'admin.auth');
  const on = new Set(arr((await form(c)).enabled));
  const providers = await listProviders();
  const map: Record<string, boolean> = {};
  for (const p of providers) map[p.id] = on.has(p.id);
  await setSetting('auth_providers', map);
  await audit(v.user!.id, 'auth.providers', {}, map, v.ip);
  setFlash(c, { type: 'ok', text: 'Provider settings saved.' });
  return c.redirect('/admin/auth');
});

// ─────────────── logs ───────────────

// Audit log and security events live in admin-logs.tsx

export const _x = { inArray, EmptyState };
