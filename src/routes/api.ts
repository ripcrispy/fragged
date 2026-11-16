/**
 * JSON API used by the client script (dock, friends pane, editor, notifications) and SSE stream.
 * All endpoints derive identity from the session cookie; POSTs require the CSRF header.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Env, C } from '../web/ctx.ts';
import { form, str, int, arr } from '../web/ctx.ts';
import * as M from '../services/messages.ts';
import * as N from '../services/notifications.ts';
import { getUserByUsername, getUserById, userCards, ServiceError } from '../services/users.ts';
import { friendIds, hasBlocked, mute, unmute, hasMuted, block, unblock, isBlockedEitherWay } from '../services/relationships.ts';
import { subscribe, setIdle, publish, onPresenceChange, type Sink } from '../services/events.ts';
import { saveUpload, fileToBuffer } from '../services/uploads.ts';
import { rateLimit, saveDraft } from '../services/forums.ts';
import { approvedEmoji, countUsage } from '../services/emoji.ts';
import { autocomplete } from '../services/profiles.ts';
import { rendererFor } from '../web/content.ts';
import { getDb, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { getSetting } from '../services/settings.ts';
import { analyse } from '../lib/bbcode.ts';
import { checkUsername } from '../services/users.ts';

export const apiRoutes = new Hono<Env>();

const need = (c: C) => {
  const v = c.get('viewer');
  if (!v.user) throw new ServiceError('Sign in required.', 401, 'login_required');
  return v;
};

function serialiseMessage(m: M.MessageView, renderBody: (s: string) => string) {
  return { id: m.id, senderId: m.senderId, createdAt: m.createdAt, nonce: m.nonce, hidden: m.hidden, html: m.hidden ? '' : renderBody(m.body), attachments: m.attachments, links: m.links };
}

// ─────────────── conversations ───────────────

apiRoutes.get('/api/conversations', async (c) => {
  const v = need(c);
  const list = await M.listConversations(v, { q: c.req.query('q') ?? undefined, limit: 50 });
  return c.json({ conversations: list, unread: await M.totalUnreadMessages(v.user!.id) });
});

/** Open (or reuse) the conversation with a member — used by the friends pane / profile buttons. */
apiRoutes.post('/api/dm/open', async (c) => {
  const v = need(c);
  const b = await form(c);
  const other = b.userId ? await getUserById(int(b.userId)) : await getUserByUsername(str(b.username));
  if (!other || other.closedAt) throw new ServiceError('Member not found.', 404);
  const conv = await M.openConversation(v, other.id);
  const card = (await userCards([other.id])).get(other.id)!;
  const me = await getDb().select().from(schema.conversationParticipants).where(eq(schema.conversationParticipants.conversationId, conv.id));
  const mine = me.find((p) => p.userId === v.user!.id);
  return c.json({ publicId: conv.publicId, other: { id: other.id, username: card.username, avatarUrl: card.avatarUrl, presence: card.presence }, muted: !!mine?.mutedAt });
});

apiRoutes.get('/api/conversations/:pid', async (c) => {
  const v = need(c);
  const pid = c.req.param('pid');
  const { otherId, me } = await M.conversationFor(v, pid);
  const before = int(c.req.query('before')) || undefined;
  const after = c.req.query('after') != null ? int(c.req.query('after')) : undefined;
  const h = await M.history(v, pid, { before, after, limit: int(c.req.query('limit'), 30) });
  const R = await rendererFor(v);
  const card = (await userCards([otherId])).get(otherId)!;
  const chk = await M.canMessage(v.user!.id, otherId, v);
  return c.json({
    publicId: pid,
    other: { id: otherId, username: card.username, avatarUrl: card.avatarUrl, presence: card.presence, profileUrl: `/u/${encodeURIComponent(card.username)}` },
    muted: !!me.mutedAt, blocked: await hasBlocked(v.user!.id, otherId), canSend: chk.ok, cannotSendReason: chk.reason ?? null,
    messages: h.messages.map((m) => serialiseMessage(m, R.message)), hasMore: h.hasMore, lastReadMessageId: me.lastReadMessageId,
  });
});

apiRoutes.post('/api/conversations/:pid/messages', async (c) => {
  const v = need(c);
  const b = await form(c);
  const r = await M.sendMessage(v, c.req.param('pid'), { body: str(b.body), nonce: str(b.nonce), uploads: arr(b.uploads) });
  const R = await rendererFor(v);
  await countUsage(analyse(str(b.body)).emoji);
  return c.json({ message: serialiseMessage(r.message, R.message), duplicate: r.duplicate }, r.duplicate ? 200 : 201);
});

apiRoutes.post('/api/conversations/:pid/read', async (c) => {
  const v = need(c);
  const b = await form(c);
  await M.markConversationRead(v, c.req.param('pid'), b.upTo ? int(b.upTo) : undefined);
  return c.json({ ok: true, unread: await M.totalUnreadMessages(v.user!.id) });
});

apiRoutes.post('/api/conversations/:pid/mute', async (c) => {
  const v = need(c);
  const on = str((await form(c)).on) === '1';
  await M.setConversationMute(v, c.req.param('pid'), on);
  return c.json({ ok: true, muted: on });
});

/** Block / unblock from inside a message window. */
apiRoutes.post('/api/conversations/:pid/block', async (c) => {
  const v = need(c);
  const { otherId } = await M.conversationFor(v, c.req.param('pid'));
  const on = str((await form(c)).on) === '1';
  if (on) await block(v.user!.id, otherId); else await unblock(v.user!.id, otherId);
  return c.json({ ok: true, blocked: on });
});

apiRoutes.get('/api/messages/unread', async (c) => c.json({ unread: await M.totalUnreadMessages(need(c).user!.id) }));

// ─────────────── friends pane ───────────────

apiRoutes.get('/api/friends', async (c) => {
  const v = need(c);
  const ids = await friendIds(v.user!.id);
  const cards = await userCards(ids);
  const unread = await M.unreadByUser(v.user!.id);
  return c.json({ friends: ids.map((id) => cards.get(id)).filter((x) => x && !x.closed).map((f) => ({ id: f!.id, username: f!.username, avatarUrl: f!.avatarUrl, presence: f!.presence, unread: unread.get(f!.id) ?? 0, profileUrl: `/u/${encodeURIComponent(f!.username)}` })) });
});

/** HTML fragment of the friends list, used to refresh the pane live after friendship changes. */
apiRoutes.get('/api/pane', async (c) => {
  need(c);
  const { paneData } = await import('../web/render.tsx');
  const { FriendsPaneBody } = await import('../web/layout.tsx');
  const pane = await paneData(c.get('page'));
  const online = pane.friends.filter((f) => f.card.presence === 'online' || f.card.presence === 'away').length;
  c.header('X-Online-Count', String(online));
  c.header('X-Request-Count', String(pane.requests));
  return c.html(String(await (FriendsPaneBody({ pane }) as any)));
});

apiRoutes.post('/api/preferences/pane', async (c) => {
  const v = need(c);
  const collapsed = str((await form(c)).collapsed) === '1';
  await getDb().update(schema.userSettings).set({ friendsPaneCollapsed: collapsed }).where(eq(schema.userSettings.userId, v.user!.id));
  return c.json({ ok: true });
});

apiRoutes.post('/api/members/:id/mute', async (c) => {
  const v = need(c);
  const id = int(c.req.param('id'));
  const on = str((await form(c)).on) === '1';
  if (on) await mute(v.user!.id, id); else await unmute(v.user!.id, id);
  return c.json({ ok: true, muted: await hasMuted(v.user!.id, id) });
});

// ─────────────── notifications ───────────────

apiRoutes.get('/api/notifications', async (c) => {
  const v = need(c);
  const list = await N.listNotifications(v.user!.id, { limit: 15 });
  return c.json({ notifications: list.map((n) => ({ id: n.id, kind: n.kind, text: n.text, url: n.url, createdAt: n.createdAt, read: !!n.readAt })), unread: await N.unreadCount(v.user!.id) });
});

apiRoutes.post('/api/notifications/read', async (c) => {
  const v = need(c);
  const b = await form(c);
  await N.markRead(v.user!.id, str(b.all) === '1' ? 'all' : arr(b.ids).map((x) => parseInt(x, 10)).filter(Boolean));
  return c.json({ ok: true, unread: await N.unreadCount(v.user!.id) });
});

// ─────────────── editor helpers ───────────────

apiRoutes.post('/api/preview', async (c) => {
  const v = need(c);
  const body = str((await form(c)).body).slice(0, 30000);
  const R = await rendererFor(v);
  return c.json({ html: R.post(body) });
});

apiRoutes.post('/api/drafts', async (c) => {
  const v = need(c);
  const b = await form(c);
  await saveDraft(v, str(b.key), str(b.body), b.title != null ? str(b.title) : undefined);
  return c.json({ ok: true, savedAt: new Date() });
});

apiRoutes.get('/api/emoji', async (c) => {
  const list = await approvedEmoji();
  c.header('Cache-Control', 'private, max-age=60');
  return c.json({ emoji: list.map((e) => ({ shortcode: e.shortcode, name: e.name, category: e.category, keywords: e.keywords, url: `/media/${e.pid}`, animated: e.animated })) });
});

apiRoutes.get('/api/members/autocomplete', async (c) => {
  const v = c.get('viewer');
  await v.require('member.view');
  await rateLimit(v, 'member_search');
  return c.json({ members: await autocomplete(v, c.req.query('q') ?? '') });
});

apiRoutes.get('/api/username-available', async (c) => {
  const v = c.get('viewer');
  await rateLimit(v, 'member_search');
  const name = (c.req.query('u') ?? '').trim();
  const err = await checkUsername(name, v.user?.id);
  return c.json({ ok: !err, message: err ?? 'Available' });
});

/** Image upload for posts and direct messages (videos and other files are not accepted). */
apiRoutes.post('/api/uploads', async (c) => {
  const v = need(c);
  const b = await form(c);
  const purpose = str(b.purpose);
  if (purpose !== 'post' && purpose !== 'message') throw new ServiceError('Invalid upload purpose.');
  await v.require(purpose === 'post' ? 'post.attach_images' : 'message.attach_images');
  await rateLimit(v, 'upload');
  const limits = (await getSetting('upload_limits'))[purpose];
  const f = await fileToBuffer(b.file, limits.maxBytes + 1);
  if (!f) throw new ServiceError('Choose an image to upload.');
  const up = await saveUpload(v.user!.id, purpose, f.buf, f.name);
  return c.json({ publicId: up.publicId, url: `/media/${up.publicId}`, width: up.width, height: up.height }, 201);
});

// ─────────────── real-time stream (SSE) ───────────────

apiRoutes.get('/api/events', async (c) => {
  const v = need(c);
  const userId = v.user!.id;
  const signal = c.req.raw.signal;
  const socket = (c.env as any)?.incoming?.socket;
  // friends are loaded before the stream starts, so nothing below awaits between subscribing and wiring up
  // disconnect handling (a disconnect during an await would otherwise leak a permanent "online" subscription)
  const friends = new Set(await friendIds(userId));
  return streamSSE(c, async (stream) => {
    let alive = true;
    let seq = 0;
    const sinkKey = c.get('csrf') + ':' + userId;
    const sink: Sink = {
      lastActive: Date.now(), idle: false,
      send: (event, data) => { if (alive) void stream.writeSSE({ event, data: JSON.stringify(data), id: String(++seq) }).catch(() => cleanup()); },
    };
    let unsub = () => {};
    let offPresence = () => {};
    const cleanup = () => {
      if (!alive) return;
      alive = false;
      unsub(); offPresence();
      if (sinks.get(sinkKey) === sink) sinks.delete(sinkKey);
    };
    // register every disconnect signal first, then subscribe synchronously
    stream.onAbort(cleanup);
    signal?.addEventListener('abort', cleanup, { once: true });
    socket?.once?.('close', cleanup);
    if (signal?.aborted || socket?.destroyed) return;
    unsub = subscribe(userId, sink);
    offPresence = onPresenceChange((uid, p) => { if (friends.has(uid)) sink.send('presence', { userId: uid, presence: p }); });
    sinks.set(sinkKey, sink);
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ userId, retry: 3000 }), retry: 3000 } as any).catch(cleanup);
    while (alive) {
      await stream.sleep(25_000);
      if (alive) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(cleanup);
    }
  });
});

const sinks = new Map<string, Sink>();
/** Client reports idle/active (tab hidden for a while) to drive away status. */
apiRoutes.post('/api/presence', async (c) => {
  const v = need(c);
  const idle = str((await form(c)).idle) === '1';
  const sink = sinks.get(c.get('csrf') + ':' + v.user!.id);
  if (sink) setIdle(v.user!.id, sink, idle);
  return c.json({ ok: true });
});

export const _x = { publish, isBlockedEitherWay };
