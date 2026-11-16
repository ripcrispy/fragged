import { Hono } from 'hono';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, int, arr, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, UserLink, Avatar, Time, Notice, ActionButton, Html, EmptyState, Presence } from '../web/components.tsx';
import { rendererFor } from '../web/content.ts';
import * as M from '../services/messages.ts';
import { getUserByUsername, userCards, ServiceError } from '../services/users.ts';
import { hasBlocked, isBlockedEitherWay } from '../services/relationships.ts';
import { randomToken } from '../lib/crypto.ts';
import { resolveMedia } from '../lib/media.ts';
import { linkCardHtml, mediaEmbedHtml } from '../lib/bbcode.ts';

export const messageRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';
const need = (c: C) => { const v = c.get('viewer'); if (!v.user) throw new ServiceError('You need to be signed in to use messages.', 401, 'login_required'); return v; };

function ConversationList({ list, current }: { list: M.ConversationSummary[]; current?: string }) {
  if (!list.length) return <EmptyState title="No conversations yet.">Open a friend from the friends pane, or use <em>Message</em> on any member's profile.</EmptyState>;
  return (
    <ul class="conv-list" data-conv-list>
      {list.map((cv) => (
        <li class={`conv-item ${cv.unread ? 'is-unread' : ''} ${cv.publicId === current ? 'is-current' : ''}`} data-conv={cv.publicId}>
          <a href={`/messages/${cv.publicId}`} class="conv-link" aria-current={cv.publicId === current ? 'page' : undefined}>
            <img class="avatar" src={cv.other.avatarUrl} alt="" width="36" height="36" loading="lazy" />
            <span class="conv-text">
              <span class="conv-name">{cv.other.username} <Presence p={cv.other.presence} />{cv.muted ? <span class="muted small" title="Muted"> <span class="ico ico-mute" aria-hidden="true"></span></span> : null}{cv.blocked ? <span class="muted small"> (blocked)</span> : null}</span>
              <span class="conv-preview">{cv.previewFromMe ? 'You: ' : ''}{cv.preview}</span>
            </span>
            <span class="conv-meta">{cv.lastMessageAt ? <time datetime={cv.lastMessageAt.toISOString()}>{cv.lastMessageAt.toISOString().slice(0, 10)}</time> : null}{cv.unread ? <span class="badge">{cv.unread}<span class="sr-only"> unread</span></span> : null}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MessageAttachments({ m }: { m: M.MessageView }) {
  return <>
    {m.attachments.length ? <div class="msg-images">{m.attachments.map((a) => <a href={`/media/${a.publicId}`} data-lightbox><img src={`/media/${a.publicId}`} alt="Image attachment" loading="lazy" width={Math.min(240, a.width)} /></a>)}</div> : null}
    {m.links.length ? <div class="msg-links">{m.links.map((l) => { const r = resolveMedia(l); return r ? <Html html={r.embedUrl ? mediaEmbedHtml(r) : r.kind === 'file' ? linkCardHtml(r) : ''} /> : null; })}</div> : null}
  </>;
}

messageRoutes.get('/messages', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const q = (c.req.query('q') ?? '').slice(0, 32);
  const list = await M.listConversations(v, { q, limit: 100 });
  return page(c, 'Messages', (
    <>
      <h1 class="page-title">Messages</h1>
      <div class="messages-layout">
        <section class="box conv-panel" aria-label="Conversations">
          <div class="box-head"><h2 class="box-title">Conversations</h2></div>
          <form class="conv-search" method="get" action="/messages" role="search"><label for="cq" class="sr-only">Filter conversations</label><input id="cq" name="q" value={q} placeholder="Filter by username…" /><button class="btn btn-small">Filter</button></form>
          <ConversationList list={list} />
        </section>
        <section class="box conv-empty"><div class="box-body">
          <p>Select a conversation to read the full history.</p>
          <form method="post" action="/messages/new" class="inline-form"><Csrf ctx={ctx} />
            <label for="nm-user">Start a conversation with</label> <input id="nm-user" name="username" required maxlength={32} placeholder="Username" data-member-autocomplete list="nm-suggest" /><datalist id="nm-suggest" />
            <button class="btn btn-primary btn-small">Open</button></form>
          <p class="muted small">Direct messages are private between you and the other member. They are kept permanently and can't be edited or deleted — see the <a href="/pages/privacy">privacy policy</a>.</p>
        </div></section>
      </div>
    </>
  ), { crumbs: [{ label: 'Messages' }], noPane: true });
});

messageRoutes.post('/messages/new', async (c) => {
  const v = need(c);
  const b = await form(c);
  const u = await getUserByUsername(str(b.username));
  if (!u || u.closedAt) { setFlash(c, { type: 'error', text: 'No member with that username.' }); return c.redirect('/messages'); }
  try {
    const conv = await M.openConversation(v, u.id);
    return c.redirect(`/messages/${conv.publicId}`);
  } catch (e) { if (e instanceof ServiceError) { setFlash(c, { type: 'error', text: e.message }); return c.redirect('/messages'); } throw e; }
});

messageRoutes.get('/messages/:pid', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const pid = c.req.param('pid');
  const { conv, otherId, me } = await M.conversationFor(v, pid);
  const before = int(c.req.query('before')) || undefined;
  const { messages, hasMore } = await M.history(v, pid, { before, limit: 60 });
  const cards = await userCards([otherId, v.user!.id]);
  const other = cards.get(otherId)!;
  const list = await M.listConversations(v, { limit: 100 });
  const chk = await M.canMessage(v.user!.id, otherId, v);
  const iBlocked = await hasBlocked(v.user!.id, otherId);
  const R = await rendererFor(v);
  if (!before) await M.markConversationRead(v, pid);
  return page(c, `Conversation with ${other.username}`, (
    <>
      <div class="messages-layout">
        <section class="box conv-panel" aria-label="Conversations">
          <div class="box-head"><h2 class="box-title"><a href="/messages">Conversations</a></h2></div>
          <ConversationList list={list} current={pid} />
        </section>
        <section class="box conv-view" aria-label={`Conversation with ${other.username}`} data-conversation={pid} data-other-id={otherId}>
          <div class="box-head conv-head">
            <h1 class="box-title"><Avatar user={other} size={28} /> <UserLink user={other} /> <Presence p={other.presence} /></h1>
            <div class="box-actions conv-actions">
              <a class="btn btn-small btn-ghost" href={`/u/${encodeURIComponent(other.username)}`}>View profile</a>
              <ActionButton ctx={ctx} action={`/messages/${pid}/mute`} fields={{ on: me.mutedAt ? 0 : 1 }} label={me.mutedAt ? 'Unmute' : 'Mute'} className="btn btn-small btn-ghost" title="Muting stops notifications for this conversation. The other member can still send messages." />
              {iBlocked ? <ActionButton ctx={ctx} action={`/u/${encodeURIComponent(other.username)}/unblock`} label="Unblock" className="btn btn-small btn-ghost" />
                : <ActionButton ctx={ctx} action={`/u/${encodeURIComponent(other.username)}/block`} label="Block" className="btn btn-small btn-ghost" confirm={`Block ${other.username}? They won't be able to message you. This conversation's history is kept.`} />}
            </div>
          </div>
          <div class="box-body">
            {hasMore ? <p class="load-older"><a href={`/messages/${pid}?before=${messages[0]?.id}`}>Load older messages</a></p> : null}
            {before ? <p class="load-older"><a href={`/messages/${pid}`}>Jump to latest</a></p> : null}
            <ol class="msg-history" data-msg-history aria-live="polite">
              {messages.map((m) => {
                const mine = m.senderId === v.user!.id;
                const who = cards.get(m.senderId);
                return (
                  <li class={`msg ${mine ? 'mine' : 'theirs'}`} data-msg-id={m.id}>
                    <div class="msg-meta"><strong>{mine ? 'You' : who?.username}</strong> <Time d={m.createdAt} tz={tz(ctx)} /></div>
                    {m.hidden ? <div class="msg-body muted"><em>This message was removed by staff following a report.</em></div> : <>
                      {m.body ? <div class="msg-body bb"><Html html={R.message(m.body)} /></div> : null}
                      <MessageAttachments m={m} />
                    </>}
                    {!mine && !m.hidden ? <a class="msg-report" href={`/report?type=message&id=${m.id}`}>Report</a> : null}
                  </li>
                );
              })}
              {!messages.length ? <li class="muted">No messages yet. Say hello!</li> : null}
            </ol>
            {chk.ok ? (
              <form method="post" action={`/messages/${pid}/send`} class="msg-composer" data-msg-composer={pid}><Csrf ctx={ctx} />
                <input type="hidden" name="nonce" value={randomToken(12)} />
                <label for="mc-body" class="sr-only">Message</label>
                <textarea id="mc-body" name="body" rows={3} maxlength={4000} placeholder={`Message ${other.username}… (links to YouTube/Vimeo show a player; files must be shared as links)`} data-ed-text></textarea>
                <div class="composer-tools">
                  <button type="button" class="btn btn-small btn-ghost" data-emoji-toggle aria-expanded="false">☺</button>
                  <label class="btn btn-small btn-ghost" title="Attach image"><span class="ico ico-image" aria-hidden="true"></span><span class="sr-only">Attach image</span><input type="file" class="sr-only" accept="image/png,image/jpeg,image/webp,image/gif" data-msg-upload /></label>
                  <span class="composer-uploads" data-msg-uploads />
                  <button class="btn btn-primary btn-small">Send</button>
                </div>
              </form>
            ) : <Notice type="info">{chk.reason} You can still read your conversation history.</Notice>}
          </div>
        </section>
      </div>
    </>
  ), { crumbs: [{ label: 'Messages', href: '/messages' }, { label: other.username }], noPane: true });
});

messageRoutes.post('/messages/:pid/send', async (c) => {
  const v = need(c);
  const pid = c.req.param('pid');
  const b = await form(c);
  try { await M.sendMessage(v, pid, { body: str(b.body), nonce: str(b.nonce), uploads: arr(b.uploads) }); }
  catch (e) { if (e instanceof ServiceError && e.status < 500) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect(`/messages/${pid}`);
});

messageRoutes.post('/messages/:pid/mute', async (c) => {
  const v = need(c);
  const pid = c.req.param('pid');
  const on = str((await form(c)).on) === '1';
  await M.setConversationMute(v, pid, on);
  setFlash(c, { type: 'ok', text: on ? 'Conversation muted. You won’t be notified about new messages.' : 'Conversation unmuted.' });
  return c.redirect(`/messages/${pid}`);
});

export const _x = { isBlockedEitherWay, Box };
