import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import type { Child } from 'hono/jsx';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, int, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, UserLink, Time, Notice, ActionButton, Html, EmptyState, Field, TextArea, Avatar } from '../web/components.tsx';
import { rendererFor } from '../web/content.ts';
import { getDb, schema } from '../db/client.ts';
import { getUserById, userCards, ServiceError, activeBan } from '../services/users.ts';
import * as Mod from '../services/moderation.ts';
import * as E from '../services/emoji.ts';
import { staffHideMessage, staffViewReportedMessage } from '../services/messages.ts';
import { approvePost, deletePost } from '../services/forums.ts';
import { numberFmt } from '../lib/time.ts';
import { moduleQueues } from '../web/extensions.tsx';

export const modRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';

const TABS: [string, string][] = [['/mod', 'Overview'], ['/mod/reports', 'Reports'], ['/mod/held', 'Held content'], ['/mod/terms', 'Term matches'], ['/mod/emoji', 'Emoji queue']];

async function modPage(c: C, title: string, body: Child) {
  const ctx = c.get('page');
  await ctx.viewer.require('mod.reports');
  return page(c, `Moderation — ${title}`, (
    <div class="settings-layout">
      <nav class="settings-nav box" aria-label="Moderation"><ul>{TABS.map(([h, l]) => <li><a href={h} class={ctx.path === h ? 'active' : ''} aria-current={ctx.path === h ? 'page' : undefined}>{l}</a></li>)}</ul></nav>
      <div class="settings-main"><h1 class="page-title">{title}</h1>{body}</div>
    </div>
  ), { crumbs: [{ label: 'Moderation', href: '/mod' }, { label: title }], noPane: true });
}

modRoutes.get('/mod', async (c) => {
  await c.get('viewer').require('mod.reports');
  const [reports, held, terms, emoji] = await Promise.all([Mod.reportQueue('open', 500), Mod.heldContent(), Mod.termMatches('pending'), E.emojiQueue('pending')]);
  const extra = await moduleQueues(c.get('viewer'));
  return modPage(c, 'Overview', (
    <div class="stats-row stats-cards">
      <a class="stat-card" href="/mod/reports"><span class="stat-value">{reports.length}</span><span class="stat-label">Open reports</span></a>
      <a class="stat-card" href="/mod/held"><span class="stat-value">{held.posts.length + held.comments.length}</span><span class="stat-label">Held posts & comments</span></a>
      <a class="stat-card" href="/mod/terms"><span class="stat-value">{terms.length}</span><span class="stat-label">Restricted-term matches to review</span></a>
      <a class="stat-card" href="/mod/emoji"><span class="stat-value">{emoji.length}</span><span class="stat-label">Emoji awaiting review</span></a>
      {extra.map((q) => <a class="stat-card" href={q.href}><span class="stat-value">{q.count}</span><span class="stat-label">{q.label}</span></a>)}
    </div>
  ));
});

modRoutes.get('/mod/reports', async (c) => {
  const ctx = c.get('page');
  const status = ['open', 'resolved', 'dismissed'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'open';
  const rows = await Mod.reportQueue(status);
  const targets = await Promise.all(rows.map((r) => Mod.describeTarget(r.r.targetType, r.r.targetId)));
  const owners = await userCards(targets.map((t) => t.ownerId!).filter(Boolean));
  return modPage(c, 'Reports', (
    <>
      <p class="tabs">{['open', 'resolved', 'dismissed'].map((s) => <a href={`/mod/reports?status=${s}`} class={s === status ? 'active' : ''}>{s}</a>)}</p>
      {rows.length ? <table class="data-table"><thead><tr><th>Reported</th><th>Target</th><th>Reason</th><th>By</th><th>Action</th></tr></thead><tbody>
        {rows.map(({ r, reporter }, i) => (
          <tr><td><Time d={r.createdAt} tz={tz(ctx)} mode="ago" /></td>
            <td>{targets[i].url ? <a href={targets[i].url!}>{targets[i].label}</a> : targets[i].label}{targets[i].ownerId ? <div class="small">Author: <UserLink user={owners.get(targets[i].ownerId!)} /> · <a href={`/mod/users/${targets[i].ownerId}`}>history</a></div> : null}</td>
            <td><strong>{Mod.REPORT_REASONS[r.reason as keyof typeof Mod.REPORT_REASONS] ?? r.reason}</strong>{r.details ? <div class="small">{r.details}</div> : null}</td>
            <td>{reporter ?? <span class="muted">deleted</span>}</td>
            <td>{r.status === 'open' ? <form method="post" action={`/mod/reports/${r.id}`} class="form-grid compact"><Csrf ctx={ctx} />
              <input name="note" placeholder="Resolution note" maxlength={500} aria-label="Resolution note" />
              <div><button name="status" value="resolved" class="btn btn-small btn-primary">Resolve</button> <button name="status" value="dismissed" class="btn btn-small">Dismiss</button></div></form>
              : <span class="muted small">{r.status} {r.resolutionNote ? `— ${r.resolutionNote}` : ''}</span>}</td></tr>
        ))}</tbody></table> : <EmptyState title="Nothing in this queue." />}
    </>
  ));
});
modRoutes.post('/mod/reports/:id', async (c) => {
  const b = await form(c);
  await Mod.resolveReport(c.get('viewer'), int(c.req.param('id')), str(b.status) === 'dismissed' ? 'dismissed' : 'resolved', str(b.note));
  setFlash(c, { type: 'ok', text: 'Report updated.' });
  return c.redirect('/mod/reports');
});

modRoutes.get('/mod/held', async (c) => {
  const ctx = c.get('page');
  await ctx.viewer.require('mod.posts');
  const { posts, comments } = await Mod.heldContent();
  const R = await rendererFor(ctx.viewer);
  const cards = await userCards(comments.map((x) => x.authorId));
  return modPage(c, 'Held content', (
    <>
      <Box title={`Posts awaiting approval (${posts.length})`}>
        {posts.length ? <ol class="mini-posts">{posts.map(({ p, t, u }) => (
          <li><div class="mini-head"><strong>{u}</strong> in <a href={`/p/${p.id}`}>{t.title}</a> · <Time d={p.createdAt} tz={tz(ctx)} mode="ago" /></div>
            <div class="bb mini-body"><Html html={R.post(p.body, { embeds: false })} /></div>
            <ActionButton ctx={ctx} action={`/p/${p.id}/approve`} label="Approve" className="btn btn-small btn-primary" />
            <ActionButton ctx={ctx} action={`/mod/held/${p.id}/reject`} label="Reject (delete)" className="btn btn-small btn-danger" /></li>))}</ol> : <p class="muted">None.</p>}
      </Box>
      <Box title={`Profile comments awaiting approval (${comments.length})`}>
        {comments.length ? <ol class="mini-posts">{comments.map((cm) => (
          <li><div class="mini-head"><UserLink user={cards.get(cm.authorId)} /> · <Time d={cm.createdAt} tz={tz(ctx)} mode="ago" /></div><div class="bb mini-body"><Html html={R.post(cm.body, { embeds: false })} /></div>
            <ActionButton ctx={ctx} action={`/mod/comments/${cm.id}`} fields={{ approve: 1 }} label="Approve" className="btn btn-small btn-primary" />
            <ActionButton ctx={ctx} action={`/mod/comments/${cm.id}`} fields={{ approve: 0 }} label="Reject" className="btn btn-small btn-danger" /></li>))}</ol> : <p class="muted">None.</p>}
      </Box>
    </>
  ));
});
modRoutes.post('/mod/held/:id/reject', async (c) => { await deletePost(c.get('viewer'), int(c.req.param('id')), 'Rejected by moderator'); setFlash(c, { type: 'ok', text: 'Post rejected.' }); return c.redirect('/mod/held'); });
modRoutes.post('/mod/comments/:id', async (c) => { await Mod.approveComment(c.get('viewer'), int(c.req.param('id')), str((await form(c)).approve) === '1'); return c.redirect('/mod/held'); });

modRoutes.get('/mod/terms', async (c) => {
  const ctx = c.get('page');
  await ctx.viewer.require('mod.terms_review');
  const status = ['pending', 'upheld', 'false_positive'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'pending';
  const rows = await Mod.termMatches(status);
  return modPage(c, 'Restricted-term matches', (
    <>
      <p>Automatic matches against the administrator's restricted-term list. Context matters — mark false positives so administrators can refine the list. Direct-message text is never stored here.</p>
      <p class="tabs">{['pending', 'upheld', 'false_positive'].map((s) => <a href={`/mod/terms?status=${s}`} class={s === status ? 'active' : ''}>{s.replace('_', ' ')}</a>)}</p>
      {rows.length ? <table class="data-table"><thead><tr><th>When</th><th>Member</th><th>Where</th><th>Category / action</th><th>Excerpt</th><th /></tr></thead><tbody>
        {rows.map(({ m, category, username }) => (
          <tr><td><Time d={m.createdAt} tz={tz(ctx)} mode="ago" /></td><td>{username ? <a href={`/mod/users/${m.userId}`}>{username}</a> : '—'}</td>
            <td>{m.contentType}{m.contentId && m.contentType === 'post' ? <> <a href={`/p/${m.contentId}`}>#{m.contentId}</a></> : null}</td>
            <td>{category ?? '—'} / <strong>{m.action}</strong></td><td class="small"><code>{m.excerpt}</code></td>
            <td>{m.reviewStatus === 'pending' ? <><ActionButton ctx={ctx} action={`/mod/terms/${m.id}`} fields={{ outcome: 'upheld' }} label="Uphold" className="btn btn-small" />
              <ActionButton ctx={ctx} action={`/mod/terms/${m.id}`} fields={{ outcome: 'false_positive' }} label="False positive" className="btn btn-small" /></> : null}</td></tr>))}
      </tbody></table> : <EmptyState title="Nothing to review." />}
    </>
  ));
});
modRoutes.post('/mod/terms/:id', async (c) => { await Mod.reviewTermMatch(c.get('viewer'), int(c.req.param('id')), str((await form(c)).outcome) === 'false_positive' ? 'false_positive' : 'upheld'); return c.redirect('/mod/terms'); });

modRoutes.get('/mod/emoji', async (c) => {
  const ctx = c.get('page');
  await ctx.viewer.require('mod.emoji');
  const status = ['pending', 'approved', 'rejected', 'disabled'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'pending';
  const rows = await E.emojiQueue(status);
  return modPage(c, 'Emoji queue', (
    <>
      <p class="tabs">{['pending', 'approved', 'rejected', 'disabled'].map((s) => <a href={`/mod/emoji?status=${s}`} class={s === status ? 'active' : ''}>{s}</a>)}</p>
      {rows.length ? <table class="data-table"><thead><tr><th>Preview</th><th>Shortcode</th><th>Details</th><th>Submitted</th><th>Decision</th></tr></thead><tbody>
        {rows.map(({ e, pid, w, h, bytes, submitter }) => (
          <tr><td><img src={`/media/${pid}`} alt="" width="48" height="48" class="emoji-review" /> <img src={`/media/${pid}`} alt="" width="22" height="22" /></td>
            <td><code>:{e.shortcode}:</code><div class="small">{e.name}</div></td>
            <td class="small">{w}×{h}, {numberFmt(Math.round(bytes / 100) / 10)} KB{e.animated ? ', animated' : ''}<div>{e.description}</div>{e.keywords ? <div class="muted">Keywords: {e.keywords}</div> : null}</td>
            <td class="small">{submitter ?? '—'} · <Time d={e.createdAt} tz={tz(ctx)} mode="ago" /></td>
            <td>{e.status === 'pending' ? <form method="post" action={`/mod/emoji/${e.id}`} class="form-grid compact"><Csrf ctx={ctx} />
              <input name="reason" placeholder="Rejection reason" maxlength={300} aria-label="Rejection reason" />
              <div><button name="decision" value="approve" class="btn btn-small btn-primary">Approve</button> <button name="decision" value="reject" class="btn btn-small btn-danger">Reject</button></div></form>
              : e.status === 'approved' ? <ActionButton ctx={ctx} action={`/mod/emoji/${e.id}`} fields={{ decision: 'disable' }} label="Disable" className="btn btn-small" />
              : e.status === 'disabled' ? <ActionButton ctx={ctx} action={`/mod/emoji/${e.id}`} fields={{ decision: 'enable' }} label="Re-enable" className="btn btn-small" /> : <span class="muted small">{e.rejectionReason}</span>}</td></tr>))}
      </tbody></table> : <EmptyState title="Nothing here." />}
    </>
  ));
});
modRoutes.post('/mod/emoji/:id', async (c) => {
  const b = await form(c);
  const d = str(b.decision) as 'approve' | 'reject' | 'disable' | 'enable';
  try { await E.reviewEmoji(c.get('viewer'), int(c.req.param('id')), d, str(b.reason)); setFlash(c, { type: 'ok', text: 'Emoji updated.' }); }
  catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/mod/emoji');
});

// ─────────────── member moderation ───────────────

modRoutes.get('/mod/users/:id', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  await v.require('mod.users');
  const user = await getUserById(int(c.req.param('id')));
  if (!user) throw new ServiceError('Member not found.', 404);
  const card = (await userCards([user.id])).get(user.id)!;
  const h = await Mod.moderationHistory(user.id);
  const ban = await activeBan(user.id);
  const staff = await userCards([...h.warnings.map((w) => w.issuedById), ...h.bans.map((b) => b.issuedById), ...h.notes.map((n) => n.authorId), ...h.actions.map((a) => a.actorId!).filter(Boolean)]);
  const canBan = await v.can('mod.ban');
  return modPage(c, `Member: ${user.username}`, (
    <>
      <Box title="Summary"><div class="member-cell"><Avatar user={card} size={48} /> <UserLink user={card} /> <span class="muted">· {card.groupName} · joined <Time d={user.createdAt} tz={tz(ctx)} mode="date" /> · {numberFmt(user.postCount)} posts</span></div>
        {ban ? <Notice type="error">Currently {ban.kind === 'ban' ? 'banned' : `suspended until ${ban.expiresAt?.toISOString().slice(0, 10)}`}: {ban.reason} <ActionButton ctx={ctx} action={`/mod/bans/${ban.id}/lift`} label="Lift" className="btn btn-small" /></Notice> : null}
      </Box>
      <div class="mod-forms">
        <Box title="Warn"><form method="post" action={`/mod/users/${user.id}/warn`} class="form-grid"><Csrf ctx={ctx} /><TextArea label="Reason (sent to the member)" name="reason" rows={2} required /><Field label="Points" name="points" type="number" value="1" /><Field label="Expires after (days, 0 = never)" name="days" type="number" value="90" /><button class="btn btn-small">Issue warning</button></form></Box>
        <Box title="Suspend or ban"><form method="post" action={`/mod/users/${user.id}/suspend`} class="form-grid"><Csrf ctx={ctx} /><TextArea label="Reason (sent to the member)" name="reason" rows={2} required />
          <Field label="Days (leave empty for permanent ban)" name="days" type="number" hint={canBan ? 'Permanent bans require the ban permission.' : 'You can issue temporary suspensions only.'} />
          <button class="btn btn-small btn-danger">Apply</button></form></Box>
        <Box title="Private note"><form method="post" action={`/mod/users/${user.id}/note`} class="form-grid"><Csrf ctx={ctx} /><TextArea label="Note (staff only)" name="note" rows={2} required /><button class="btn btn-small">Add note</button></form></Box>
      </div>
      <Box title="History">
        <h3>Warnings</h3>{h.warnings.length ? <ul class="plain-list">{h.warnings.map((w) => <li><Time d={w.createdAt} tz={tz(ctx)} mode="date" /> — {w.reason} ({w.points} pt) by <UserLink user={staff.get(w.issuedById)} /></li>)}</ul> : <p class="muted">None</p>}
        <h3>Suspensions & bans</h3>{h.bans.length ? <ul class="plain-list">{h.bans.map((b) => <li><Time d={b.createdAt} tz={tz(ctx)} mode="date" /> — {b.kind}: {b.reason} {b.expiresAt ? `(until ${b.expiresAt.toISOString().slice(0, 10)})` : '(permanent)'} by <UserLink user={staff.get(b.issuedById)} />{b.liftedAt ? <span class="muted"> · lifted</span> : null}</li>)}</ul> : <p class="muted">None</p>}
        <h3>Notes</h3>{h.notes.length ? <ul class="plain-list">{h.notes.map((n) => <li><Time d={n.createdAt} tz={tz(ctx)} mode="date" /> — {n.note} (<UserLink user={staff.get(n.authorId)} />)</li>)}</ul> : <p class="muted">None</p>}
        <h3>Audit trail</h3>{h.actions.length ? <ul class="plain-list small">{h.actions.map((a) => <li><Time d={a.createdAt} tz={tz(ctx)} /> — {a.action} by <UserLink user={a.actorId ? staff.get(a.actorId) : null} /></li>)}</ul> : <p class="muted">None</p>}
      </Box>
    </>
  ));
});
modRoutes.post('/mod/users/:id/warn', async (c) => { const b = await form(c); const id = int(c.req.param('id')); await Mod.warnUser(c.get('viewer'), id, str(b.reason), int(b.points, 1), int(b.days, 90)); setFlash(c, { type: 'ok', text: 'Warning issued.' }); return c.redirect(`/mod/users/${id}`); });
modRoutes.post('/mod/users/:id/suspend', async (c) => { const b = await form(c); const id = int(c.req.param('id')); const days = str(b.days).trim() ? int(b.days) : null; await Mod.suspendUser(c.get('viewer'), id, str(b.reason), days); setFlash(c, { type: 'ok', text: days ? 'Member suspended.' : 'Member banned.' }); return c.redirect(`/mod/users/${id}`); });
modRoutes.post('/mod/users/:id/note', async (c) => { const id = int(c.req.param('id')); await Mod.addNote(c.get('viewer'), id, str((await form(c)).note)); return c.redirect(`/mod/users/${id}`); });
modRoutes.post('/mod/bans/:id/lift', async (c) => { const uid = await Mod.liftBan(c.get('viewer'), int(c.req.param('id'))); setFlash(c, { type: 'ok', text: 'Restriction lifted.' }); return c.redirect(`/mod/users/${uid}`); });

// ─────────────── reported direct messages (audited exceptional process) ───────────────

modRoutes.get('/mod/messages/:id', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const { message, context } = await staffViewReportedMessage(v, int(c.req.param('id')));
  const cards = await userCards(context.map((m) => m.senderId));
  return modPage(c, 'Reported direct message', (
    <>
      <Notice type="warn">You are viewing private messages because of a report. This access is recorded in the audit log. Only the reported message and limited surrounding context are shown.</Notice>
      <ol class="msg-history">{context.map((m) => (
        <li class={`msg ${m.id === message.id ? 'is-reported' : ''}`}><div class="msg-meta"><UserLink user={cards.get(m.senderId)} /> <Time d={m.createdAt} tz={tz(ctx)} />{m.id === message.id ? <strong> — reported</strong> : null}{m.hiddenAt ? <em> (hidden)</em> : null}</div><div class="msg-body">{m.body}</div></li>))}</ol>
      {!message.hiddenAt ? <form method="post" action={`/mod/messages/${message.id}/hide`} class="form-grid"><Csrf ctx={ctx} />
        <TextArea label="Reason for hiding this message from both participants" name="reason" rows={2} required />
        <p class="field-hint">Hiding does not edit or delete the message; the original is retained for appeals and legal obligations.</p>
        <button class="btn btn-danger btn-small">Hide message</button></form> : <p class="muted">Hidden: {message.hiddenReason}</p>}
    </>
  ));
});
modRoutes.post('/mod/messages/:id/hide', async (c) => { const id = int(c.req.param('id')); await staffHideMessage(c.get('viewer'), id, str((await form(c)).reason)); setFlash(c, { type: 'ok', text: 'Message hidden.' }); return c.redirect(`/mod/messages/${id}`); });

export const _x = { desc, eq, getDb, schema, approvePost };
