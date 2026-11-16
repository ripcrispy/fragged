/**
 * Direct messaging.
 *
 * Rules
 * - Messages are append-only: there is no edit or delete operation for anyone in this service,
 *   and the database trigger rejects UPDATE of content and all DELETEs.
 * - Sender identity always comes from the authenticated viewer.
 * - Sending is idempotent per (sender, client nonce) — retries return the original message.
 * - Ordering is by the monotonically increasing message id; history uses id cursors.
 * - Closing a dock tab, unfriending, muting or blocking never removes history.
 * - Starting a conversation / sending requires: message.send permission, no block in either
 *   direction, the recipient's DM policy (everyone | friends | nobody), recipient not closed.
 * - Restricted terms: `block` and `hold` both prevent sending (DMs are never queued for staff
 *   reading); `flag` records the match without storing message text; `redact` masks on display.
 */
import { and, desc, eq, gt, lt, sql, inArray, ne, or, asc } from 'drizzle-orm';
import { emit, applyFilters } from '../modules/registry.ts';
import { getDb, schema } from '../db/client.ts';
import { publicId } from '../lib/crypto.ts';
import { cleanText } from '../lib/validate.ts';
import { extractUrls } from '../lib/media.ts';
import { excerpt } from '../lib/bbcode.ts';
import { ServiceError, getUserById, userCards } from './users.ts';
import { areFriends, isBlockedEitherWay, hasBlocked } from './relationships.ts';
import { notify } from './notifications.ts';
import { publish } from './events.ts';
import { audit } from './audit.ts';
import { rateLimit } from './forums.ts';
import { getSetting } from './settings.ts';
import { compileMatcher } from '../lib/filter.ts';
import type { Viewer } from './viewer.ts';

export type Conversation = typeof schema.conversations.$inferSelect;
export type DirectMessage = typeof schema.directMessages.$inferSelect;

const pair = (a: number, b: number) => (a < b ? [a, b] : [b, a]) as [number, number];

export async function canMessage(senderId: number, recipientId: number, v?: Viewer): Promise<{ ok: boolean; reason?: string }> {
  if (senderId === recipientId) return { ok: false, reason: 'You cannot message yourself.' };
  if (v && !(await v.can('message.send'))) return { ok: false, reason: v.ban ? 'Your account is restricted.' : v.subject.unverified ? 'Verify your email address to send messages.' : 'You do not have permission to send messages.' };
  const r = await getUserById(recipientId);
  if (!r || r.closedAt) return { ok: false, reason: 'This member is not available.' };
  if (await hasBlocked(senderId, recipientId)) return { ok: false, reason: 'You have blocked this member. Unblock them to send messages.' };
  if (await isBlockedEitherWay(senderId, recipientId)) return { ok: false, reason: 'You cannot message this member.' };
  const [s] = await getDb().select({ p: schema.userSettings.dmPolicy }).from(schema.userSettings).where(eq(schema.userSettings.userId, recipientId));
  const policy = s?.p ?? 'everyone';
  if (policy === 'nobody') return { ok: false, reason: 'This member is not accepting direct messages.' };
  if (policy === 'friends' && !(await areFriends(senderId, recipientId))) return { ok: false, reason: 'This member only accepts messages from friends.' };
  return { ok: true };
}

export async function findConversation(a: number, b: number): Promise<Conversation | null> {
  const [lo, hi] = pair(a, b);
  const [c] = await getDb().select().from(schema.conversations).where(and(eq(schema.conversations.userLowId, lo), eq(schema.conversations.userHighId, hi)));
  return c ?? null;
}

/** Reuse the existing conversation for a pair, or create it (requires permission to message). */
export async function openConversation(v: Viewer, otherId: number): Promise<Conversation> {
  const me = v.user!;
  const existing = await findConversation(me.id, otherId);
  if (existing) return existing;
  const chk = await canMessage(me.id, otherId, v);
  if (!chk.ok) throw new ServiceError(chk.reason!, 403, 'cannot_message');
  const [lo, hi] = pair(me.id, otherId);
  const db = getDb();
  return db.transaction(async (tx) => {
    const ins = await tx.insert(schema.conversations).values({ publicId: publicId(16), userLowId: lo, userHighId: hi }).onConflictDoNothing().returning();
    const conv = ins[0] ?? (await tx.select().from(schema.conversations).where(and(eq(schema.conversations.userLowId, lo), eq(schema.conversations.userHighId, hi))))[0];
    await tx.insert(schema.conversationParticipants).values([{ conversationId: conv.id, userId: lo }, { conversationId: conv.id, userId: hi }]).onConflictDoNothing();
    return conv;
  });
}

/** Load a conversation the viewer participates in. Non-participants get 404 (no existence leak). */
export async function conversationFor(v: Viewer, pid: string): Promise<{ conv: Conversation; otherId: number; me: typeof schema.conversationParticipants.$inferSelect }> {
  if (!v.user || !/^[A-Za-z0-9]{8,24}$/.test(pid)) throw new ServiceError('Conversation not found.', 404);
  const [conv] = await getDb().select().from(schema.conversations).where(eq(schema.conversations.publicId, pid));
  if (!conv || (conv.userLowId !== v.user.id && conv.userHighId !== v.user.id)) throw new ServiceError('Conversation not found.', 404);
  const [me] = await getDb().select().from(schema.conversationParticipants).where(and(eq(schema.conversationParticipants.conversationId, conv.id), eq(schema.conversationParticipants.userId, v.user.id)));
  return { conv, otherId: conv.userLowId === v.user.id ? conv.userHighId : conv.userLowId, me };
}

export interface MessageView { id: number; senderId: number; body: string; createdAt: Date; links: string[]; attachments: { publicId: string; width: number; height: number }[]; hidden: boolean; nonce: string }

async function decorate(rows: DirectMessage[]): Promise<MessageView[]> {
  if (!rows.length) return [];
  const att = await getDb().select({ messageId: schema.messageAttachments.messageId, publicId: schema.uploads.publicId, width: schema.uploads.width, height: schema.uploads.height })
    .from(schema.messageAttachments).innerJoin(schema.uploads, eq(schema.uploads.id, schema.messageAttachments.uploadId)).where(inArray(schema.messageAttachments.messageId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    id: r.id, senderId: r.senderId, createdAt: r.createdAt, links: r.links, nonce: r.clientNonce,
    hidden: !!r.hiddenAt,
    body: r.hiddenAt ? '' : r.body,
    attachments: r.hiddenAt ? [] : att.filter((a) => a.messageId === r.id).map(({ publicId, width, height }) => ({ publicId, width, height })),
  }));
}

export async function history(v: Viewer, pid: string, opts: { before?: number; after?: number; limit?: number } = {}) {
  const { conv } = await conversationFor(v, pid);
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const db = getDb();
  let rows: DirectMessage[];
  if (opts.after != null) {
    rows = await db.select().from(schema.directMessages).where(and(eq(schema.directMessages.conversationId, conv.id), gt(schema.directMessages.id, opts.after))).orderBy(asc(schema.directMessages.id)).limit(limit);
  } else {
    const conds = [eq(schema.directMessages.conversationId, conv.id)];
    if (opts.before) conds.push(lt(schema.directMessages.id, opts.before));
    rows = (await db.select().from(schema.directMessages).where(and(...conds)).orderBy(desc(schema.directMessages.id)).limit(limit)).reverse();
  }
  const hasMore = opts.after == null && rows.length === limit;
  return { messages: await decorate(rows), hasMore };
}

export async function sendMessage(v: Viewer, pid: string, input: { body: string; nonce: string; uploads?: string[] }): Promise<{ message: MessageView; duplicate: boolean }> {
  const me = v.user!;
  const { conv, otherId } = await conversationFor(v, pid);
  const nonce = String(input.nonce ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw new ServiceError('Invalid message identifier.');
  const db = getDb();
  // idempotency: a retry with the same nonce returns the stored message
  const [dup] = await db.select().from(schema.directMessages).where(and(eq(schema.directMessages.senderId, me.id), eq(schema.directMessages.clientNonce, nonce)));
  if (dup) {
    if (dup.conversationId !== conv.id) throw new ServiceError('Invalid message identifier.');
    return { message: (await decorate([dup]))[0], duplicate: true };
  }
  const chk = await canMessage(me.id, otherId, v);
  if (!chk.ok) throw new ServiceError(chk.reason!, 403, 'cannot_message');
  await rateLimit(v, 'message');
  const filtered = await applyFilters('message.beforeSend', { body: cleanText(input.body, 5000), senderId: me.id, recipientId: otherId });
  const body = cleanText(filtered.body, 5000).trim();
  const uploads = (input.uploads ?? []).slice(0, 10);
  if (!body && !uploads.length) throw new ServiceError('Message is empty.');
  if (body.length > 4000) throw new ServiceError('Messages can be at most 4,000 characters.');
  await enforceDmPolicy(me.id, body);
  let attach: (typeof schema.uploads.$inferSelect)[] = [];
  if (uploads.length) {
    if (!(await v.can('message.attach_images'))) throw new ServiceError('You cannot attach images to messages.', 403);
    const lim = ((await getSetting('upload_limits')).message as any).perMessage ?? 4;
    attach = await db.select().from(schema.uploads).where(and(inArray(schema.uploads.publicId, uploads), eq(schema.uploads.userId, me.id), eq(schema.uploads.purpose, 'message')));
    if (attach.length > lim) throw new ServiceError(`At most ${lim} images per message.`);
    // an upload can be attached to only one message
    if (attach.length) {
      const used = await db.select().from(schema.messageAttachments).where(inArray(schema.messageAttachments.uploadId, attach.map((a) => a.id)));
      if (used.length) throw new ServiceError('That image was already sent.');
    }
  }
  const links = extractUrls(body, 10);
  let msg: DirectMessage;
  try {
    msg = await db.transaction(async (tx) => {
      const [m] = await tx.insert(schema.directMessages).values({ conversationId: conv.id, senderId: me.id, body, clientNonce: nonce, links }).returning();
      if (attach.length) await tx.insert(schema.messageAttachments).values(attach.map((a) => ({ messageId: m.id, uploadId: a.id })));
      await tx.update(schema.conversations).set({ lastMessageId: m.id, lastMessageAt: m.createdAt }).where(eq(schema.conversations.id, conv.id));
      await tx.update(schema.conversationParticipants).set({ lastReadMessageId: m.id }).where(and(eq(schema.conversationParticipants.conversationId, conv.id), eq(schema.conversationParticipants.userId, me.id)));
      return m;
    });
  } catch (e: any) {
    // concurrent retry with same nonce
    const [again] = await db.select().from(schema.directMessages).where(and(eq(schema.directMessages.senderId, me.id), eq(schema.directMessages.clientNonce, nonce)));
    if (again) return { message: (await decorate([again]))[0], duplicate: true };
    throw e;
  }
  const view = (await decorate([msg]))[0];
  // a hint only (NOTIFY payloads are size-limited); clients fetch the message itself over HTTP
  const payload = { conversation: conv.publicId, message: { id: view.id, senderId: view.senderId, nonce: view.nonce, createdAt: view.createdAt }, from: { id: me.id, username: me.username } };
  publish(me.id, 'message', payload);
  publish(otherId, 'message', payload);
  await emit('message.sent', { conversationId: conv.id, messageId: view.id, senderId: me.id, recipientId: otherId });
  // in-app notification unless the recipient muted this conversation (or the sender)
  const [rp] = await db.select().from(schema.conversationParticipants).where(and(eq(schema.conversationParticipants.conversationId, conv.id), eq(schema.conversationParticipants.userId, otherId)));
  if (!rp?.mutedAt) {
    // collapse: only notify if there isn't already an unread message notification for this conversation
    const url = `/messages/${conv.publicId}`;
    const [open] = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.userId, otherId), eq(schema.notifications.url, url), sql`${schema.notifications.readAt} is null`)).limit(1);
    if (!open) await notify(otherId, 'message', me.id, `New message from ${me.username}: ${excerpt(body, 80) || '[image]'}`, url);
  }
  return { message: view, duplicate: false };
}

async function enforceDmPolicy(userId: number, body: string) {
  const terms = await getDb().select().from(schema.restrictedTerms).where(eq(schema.restrictedTerms.isActive, true));
  const m = compileMatcher(terms.map((t) => ({ id: t.id, pattern: t.pattern, matchType: t.matchType as any, action: t.action as any, category: t.category })));
  const matches = m.scan(body);
  if (!matches.length) return;
  const strongest = matches.some((x) => x.action === 'block' || x.action === 'hold') ? 'block' : matches.some((x) => x.action === 'flag') ? 'flag' : 'redact';
  if (strongest !== 'redact') {
    await getDb().insert(schema.restrictedTermMatches).values(matches.slice(0, 5).map((x) => ({ termId: x.termId, userId, contentType: 'message', action: strongest, excerpt: '[direct message — content not stored]', reviewStatus: strongest === 'block' ? 'upheld' : 'pending' })));
  }
  if (strongest === 'block') throw new ServiceError('Your message contains language that is not permitted by the community rules.', 422, 'restricted');
}

export async function markConversationRead(v: Viewer, pid: string, upTo?: number) {
  const { conv } = await conversationFor(v, pid);
  const target = Math.min(upTo ?? Number.MAX_SAFE_INTEGER, conv.lastMessageId ?? 0);
  await getDb().update(schema.conversationParticipants).set({ lastReadMessageId: sql`greatest(${schema.conversationParticipants.lastReadMessageId}, ${target})` })
    .where(and(eq(schema.conversationParticipants.conversationId, conv.id), eq(schema.conversationParticipants.userId, v.user!.id)));
  // clear the matching message notification
  await getDb().update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.userId, v.user!.id), eq(schema.notifications.url, `/messages/${conv.publicId}`), sql`${schema.notifications.readAt} is null`));
  publish(v.user!.id, 'read', { conversation: conv.publicId, upTo: target });
}

export async function setConversationMute(v: Viewer, pid: string, muted: boolean) {
  const { conv } = await conversationFor(v, pid);
  await getDb().update(schema.conversationParticipants).set({ mutedAt: muted ? new Date() : null })
    .where(and(eq(schema.conversationParticipants.conversationId, conv.id), eq(schema.conversationParticipants.userId, v.user!.id)));
}

export interface ConversationSummary {
  publicId: string; other: { id: number; username: string; avatarUrl: string; presence: string | null; color: string | null };
  lastMessageAt: Date | null; preview: string; previewFromMe: boolean; unread: number; muted: boolean; blocked: boolean;
}

/** All conversations for the Messages page / dock, most recent first. */
export async function listConversations(v: Viewer, opts: { q?: string; limit?: number; before?: Date } = {}): Promise<ConversationSummary[]> {
  const me = v.user!.id;
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 100);
  const conds = [eq(schema.conversationParticipants.userId, me), sql`${schema.conversations.lastMessageId} is not null`];
  if (opts.before) conds.push(lt(schema.conversations.lastMessageAt, opts.before));
  if (opts.q) {
    conds.push(sql`exists (select 1 from users u where u.id = case when ${schema.conversations.userLowId} = ${me} then ${schema.conversations.userHighId} else ${schema.conversations.userLowId} end and u.username_lower like ${'%' + opts.q.toLowerCase().replace(/[%_\\]/g, '\\$&') + '%'})`);
  }
  const rows = await db.select({ c: schema.conversations, p: schema.conversationParticipants }).from(schema.conversationParticipants)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.conversationParticipants.conversationId))
    .where(and(...conds)).orderBy(desc(schema.conversations.lastMessageAt)).limit(limit);
  if (!rows.length) return [];
  const others = rows.map((r) => (r.c.userLowId === me ? r.c.userHighId : r.c.userLowId));
  const cards = await userCards(others);
  const lastIds = rows.map((r) => r.c.lastMessageId!).filter(Boolean);
  const lastMsgs = await db.select().from(schema.directMessages).where(inArray(schema.directMessages.id, lastIds));
  const unread = await db.select({ cid: schema.directMessages.conversationId, n: sql<number>`count(*)::int` }).from(schema.directMessages)
    .innerJoin(schema.conversationParticipants, and(eq(schema.conversationParticipants.conversationId, schema.directMessages.conversationId), eq(schema.conversationParticipants.userId, me)))
    .where(and(inArray(schema.directMessages.conversationId, rows.map((r) => r.c.id)), ne(schema.directMessages.senderId, me), gt(schema.directMessages.id, schema.conversationParticipants.lastReadMessageId)))
    .groupBy(schema.directMessages.conversationId);
  const blocks = await db.select().from(schema.userBlocks).where(or(and(eq(schema.userBlocks.blockerId, me), inArray(schema.userBlocks.blockedId, others)), and(eq(schema.userBlocks.blockedId, me), inArray(schema.userBlocks.blockerId, others))));
  return rows.map((r, i) => {
    const oid = others[i];
    const card = cards.get(oid);
    const lm = lastMsgs.find((m) => m.id === r.c.lastMessageId);
    return {
      publicId: r.c.publicId,
      other: { id: oid, username: card?.username ?? 'Member', avatarUrl: card?.avatarUrl ?? '/img/default-avatar.svg', presence: card?.presence ?? null, color: card?.color ?? null },
      lastMessageAt: r.c.lastMessageAt,
      preview: lm ? (lm.hiddenAt ? '[message removed by staff]' : excerpt(lm.body, 80) || '[image]') : '',
      previewFromMe: lm?.senderId === me,
      unread: unread.find((u) => u.cid === r.c.id)?.n ?? 0,
      muted: !!r.p.mutedAt,
      blocked: blocks.some((b) => b.blockerId === oid || b.blockedId === oid),
    };
  });
}

export async function totalUnreadMessages(userId: number): Promise<number> {
  const rows = (await getDb().execute(sql`
    select count(*)::int as n from direct_messages m
    join conversation_participants p on p.conversation_id = m.conversation_id and p.user_id = ${userId}
    where m.sender_id <> ${userId} and m.id > p.last_read_message_id`)) as any;
  return Number((rows.rows ?? rows)[0]?.n ?? 0);
}

/** Unread count per other-user id (friends pane indicators). */
export async function unreadByUser(userId: number): Promise<Map<number, number>> {
  const rows = (await getDb().execute(sql`
    select m.sender_id as uid, count(*)::int as n from direct_messages m
    join conversation_participants p on p.conversation_id = m.conversation_id and p.user_id = ${userId}
    where m.sender_id <> ${userId} and m.id > p.last_read_message_id group by m.sender_id`)) as any;
  return new Map(((rows.rows ?? rows) as any[]).map((r) => [Number(r.uid), Number(r.n)]));
}

/**
 * Exceptional, audited staff handling: hides a single reported message from both participants.
 * The original body is retained unchanged (append-only) for legal/appeal review.
 */
export async function staffHideMessage(v: Viewer, messageId: number, reason: string) {
  await v.require('mod.messages');
  const r = cleanText(reason, 500).trim();
  if (r.length < 5) throw new ServiceError('A reason is required.');
  const [m] = await getDb().update(schema.directMessages).set({ hiddenAt: new Date(), hiddenById: v.user!.id, hiddenReason: r }).where(eq(schema.directMessages.id, messageId)).returning();
  if (!m) throw new ServiceError('Message not found.', 404);
  await audit(v.user!.id, 'message.hide', { type: 'message', id: messageId }, { reason: r, conversationId: m.conversationId }, v.ip);
}

/** Staff view of a reported message, with immediate context. Audited. */
export async function staffViewReportedMessage(v: Viewer, messageId: number) {
  await v.require('mod.messages');
  const db = getDb();
  const [m] = await db.select().from(schema.directMessages).where(eq(schema.directMessages.id, messageId));
  if (!m) throw new ServiceError('Message not found.', 404);
  const [rep] = await db.select().from(schema.reports).where(and(eq(schema.reports.targetType, 'message'), eq(schema.reports.targetId, messageId))).limit(1);
  if (!rep) throw new ServiceError('Only reported messages can be reviewed.', 403);
  const ctx = await db.select().from(schema.directMessages).where(and(eq(schema.directMessages.conversationId, m.conversationId), sql`${schema.directMessages.id} between ${messageId - 5} and ${messageId + 2}`)).orderBy(asc(schema.directMessages.id));
  await audit(v.user!.id, 'message.view_reported', { type: 'message', id: messageId }, { reportId: rep.id }, v.ip);
  return { message: m, context: ctx };
}
