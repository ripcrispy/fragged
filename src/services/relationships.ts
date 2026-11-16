/**
 * Friendships, friend requests, blocks and mutes.
 *
 * Block policy (documented in docs/POLICIES.md):
 * - Blocking takes precedence over every other relationship state.
 * - Blocking removes an existing friendship and cancels pending requests in both directions,
 *   and removes each from the other's Top Friends.
 * - Either direction of block prevents: new friend requests, new direct messages, new profile
 *   comments, @mention/quote/reply notifications between the two.
 * - Existing conversation history is preserved (append-only) and remains readable by both
 *   participants; the composer is disabled while a block exists.
 * - The blocker sees the blocked member's forum posts collapsed ("content from a blocked member").
 *   Existing profile comments by the blocked member on the blocker's profile are hidden from view.
 * - The blocked member is never notified.
 *
 * Mute only suppresses notifications from that member (and optionally collapses their content
 * for the muter). It does not stop them sending messages.
 */
import { and, eq, or, inArray, sql, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { ServiceError, getUserById } from './users.ts';
import { notify } from './notifications.ts';
import { publish } from './events.ts';
import { emit } from '../modules/registry.ts';

const pair = (a: number, b: number) => (a < b ? { userLowId: a, userHighId: b } : { userLowId: b, userHighId: a });

export async function areFriends(a: number, b: number): Promise<boolean> {
  if (a === b) return false;
  const p = pair(a, b);
  const rows = await getDb().select().from(schema.friendships).where(and(eq(schema.friendships.userLowId, p.userLowId), eq(schema.friendships.userHighId, p.userHighId)));
  return rows.length > 0;
}

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(a: number, b: number): Promise<boolean> {
  const rows = await getDb().select().from(schema.userBlocks).where(or(
    and(eq(schema.userBlocks.blockerId, a), eq(schema.userBlocks.blockedId, b)),
    and(eq(schema.userBlocks.blockerId, b), eq(schema.userBlocks.blockedId, a)),
  ));
  return rows.length > 0;
}
export async function hasBlocked(blocker: number, blocked: number): Promise<boolean> {
  const rows = await getDb().select().from(schema.userBlocks).where(and(eq(schema.userBlocks.blockerId, blocker), eq(schema.userBlocks.blockedId, blocked)));
  return rows.length > 0;
}
export async function hasMuted(muter: number, muted: number): Promise<boolean> {
  const rows = await getDb().select().from(schema.userMutes).where(and(eq(schema.userMutes.muterId, muter), eq(schema.userMutes.mutedId, muted)));
  return rows.length > 0;
}

/** IDs the viewer has blocked or muted-with-hide (for collapsing content). */
export async function hiddenAuthorIds(viewerId: number): Promise<{ blocked: Set<number>; muted: Set<number> }> {
  const db = getDb();
  const [b, m] = await Promise.all([
    db.select({ id: schema.userBlocks.blockedId }).from(schema.userBlocks).where(eq(schema.userBlocks.blockerId, viewerId)),
    db.select({ id: schema.userMutes.mutedId }).from(schema.userMutes).where(and(eq(schema.userMutes.muterId, viewerId), eq(schema.userMutes.hideContent, true))),
  ]);
  return { blocked: new Set(b.map((r) => r.id)), muted: new Set(m.map((r) => r.id)) };
}

export async function friendIds(userId: number): Promise<number[]> {
  const rows = await getDb().select().from(schema.friendships).where(or(eq(schema.friendships.userLowId, userId), eq(schema.friendships.userHighId, userId)));
  return rows.map((r) => (r.userLowId === userId ? r.userHighId : r.userLowId));
}

export type RelationState = 'self' | 'friends' | 'request_sent' | 'request_received' | 'blocked' | 'blocked_by' | 'none';

export async function relationState(viewerId: number, otherId: number): Promise<RelationState> {
  if (viewerId === otherId) return 'self';
  if (await hasBlocked(viewerId, otherId)) return 'blocked';
  if (await hasBlocked(otherId, viewerId)) return 'blocked_by';
  if (await areFriends(viewerId, otherId)) return 'friends';
  const reqs = await pendingBetween(viewerId, otherId);
  if (reqs.some((r) => r.fromUserId === viewerId)) return 'request_sent';
  if (reqs.some((r) => r.fromUserId === otherId)) return 'request_received';
  return 'none';
}

async function pendingBetween(a: number, b: number) {
  return getDb().select().from(schema.friendRequests).where(and(eq(schema.friendRequests.status, 'pending'), or(
    and(eq(schema.friendRequests.fromUserId, a), eq(schema.friendRequests.toUserId, b)),
    and(eq(schema.friendRequests.fromUserId, b), eq(schema.friendRequests.toUserId, a)),
  )));
}

export async function sendFriendRequest(fromId: number, toId: number): Promise<'sent' | 'accepted'> {
  if (fromId === toId) throw new ServiceError('You cannot add yourself as a friend.');
  const target = await getUserById(toId);
  if (!target || target.closedAt) throw new ServiceError('Member not found.', 404);
  // Do not reveal a block to the blocked party: same generic message either way.
  if (await isBlockedEitherWay(fromId, toId)) throw new ServiceError('You cannot send a friend request to this member.', 403, 'blocked');
  if (await areFriends(fromId, toId)) throw new ServiceError('You are already friends.');
  const pending = await pendingBetween(fromId, toId);
  if (pending.some((r) => r.fromUserId === fromId)) throw new ServiceError('You have already sent a friend request to this member.');
  const incoming = pending.find((r) => r.fromUserId === toId);
  if (incoming) {
    // A request in the other direction exists: sending one back accepts it (no contradictory state).
    await respondToRequest(fromId, incoming.id, 'accept');
    return 'accepted';
  }
  const from = await getUserById(fromId);
  await getDb().insert(schema.friendRequests).values({ fromUserId: fromId, toUserId: toId });
  await notify(toId, 'friend_request', fromId, `${from!.username} sent you a friend request.`, '/friends');
  publish(toId, 'friends', { type: 'request' });
  return 'sent';
}

export async function respondToRequest(userId: number, requestId: number, action: 'accept' | 'decline'): Promise<void> {
  const db = getDb();
  const [req] = await db.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, requestId));
  if (!req || req.toUserId !== userId || req.status !== 'pending') throw new ServiceError('Friend request not found.', 404);
  if (action === 'accept' && (await isBlockedEitherWay(req.fromUserId, req.toUserId))) throw new ServiceError('You cannot accept this request.', 403);
  await db.transaction(async (tx) => {
    const upd = await tx.update(schema.friendRequests).set({ status: action === 'accept' ? 'accepted' : 'declined', respondedAt: new Date() })
      .where(and(eq(schema.friendRequests.id, requestId), eq(schema.friendRequests.status, 'pending'))).returning();
    if (!upd.length) throw new ServiceError('Friend request not found.', 404);
    if (action === 'accept') await tx.insert(schema.friendships).values(pair(req.fromUserId, req.toUserId)).onConflictDoNothing();
  });
  if (action === 'accept') {
    const me = await getUserById(userId);
    await notify(req.fromUserId, 'friend_accept', userId, `${me!.username} accepted your friend request.`, `/u/${encodeURIComponent(me!.username)}`);
    publish(req.fromUserId, 'friends', { type: 'accepted' });
    publish(userId, 'friends', { type: 'accepted' });
    await emit('friend.accepted', { userId: req.fromUserId, friendId: userId });
  }
  // Declines are silent to the requester (their request simply stays unanswered → removed)
}

export async function cancelRequest(userId: number, requestId: number) {
  const upd = await getDb().update(schema.friendRequests).set({ status: 'cancelled', respondedAt: new Date() })
    .where(and(eq(schema.friendRequests.id, requestId), eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.status, 'pending'))).returning();
  if (!upd.length) throw new ServiceError('Friend request not found.', 404);
  publish(upd[0].toUserId, 'friends', { type: 'cancelled' });
}

export async function removeFriend(userId: number, otherId: number) {
  const p = pair(userId, otherId);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(schema.friendships).where(and(eq(schema.friendships.userLowId, p.userLowId), eq(schema.friendships.userHighId, p.userHighId)));
    await tx.delete(schema.topFriends).where(or(
      and(eq(schema.topFriends.userId, userId), eq(schema.topFriends.friendId, otherId)),
      and(eq(schema.topFriends.userId, otherId), eq(schema.topFriends.friendId, userId)),
    ));
  });
  // Message history is intentionally untouched.
  publish(otherId, 'friends', { type: 'removed' });
}

export async function block(blockerId: number, blockedId: number) {
  if (blockerId === blockedId) throw new ServiceError('You cannot block yourself.');
  const target = await getUserById(blockedId);
  if (!target) throw new ServiceError('Member not found.', 404);
  const p = pair(blockerId, blockedId);
  await getDb().transaction(async (tx) => {
    await tx.insert(schema.userBlocks).values({ blockerId, blockedId }).onConflictDoNothing();
    await tx.delete(schema.friendships).where(and(eq(schema.friendships.userLowId, p.userLowId), eq(schema.friendships.userHighId, p.userHighId)));
    await tx.update(schema.friendRequests).set({ status: 'cancelled', respondedAt: new Date() }).where(and(eq(schema.friendRequests.status, 'pending'), or(
      and(eq(schema.friendRequests.fromUserId, blockerId), eq(schema.friendRequests.toUserId, blockedId)),
      and(eq(schema.friendRequests.fromUserId, blockedId), eq(schema.friendRequests.toUserId, blockerId)),
    )));
    await tx.delete(schema.topFriends).where(or(
      and(eq(schema.topFriends.userId, blockerId), eq(schema.topFriends.friendId, blockedId)),
      and(eq(schema.topFriends.userId, blockedId), eq(schema.topFriends.friendId, blockerId)),
    ));
  });
  // conversation views of both participants need to refresh their composer state
  publish(blockerId, 'relationship', { userId: blockedId });
  publish(blockedId, 'relationship', { userId: blockerId });
}

export async function unblock(blockerId: number, blockedId: number) {
  await getDb().delete(schema.userBlocks).where(and(eq(schema.userBlocks.blockerId, blockerId), eq(schema.userBlocks.blockedId, blockedId)));
  publish(blockerId, 'relationship', { userId: blockedId });
  publish(blockedId, 'relationship', { userId: blockerId });
}

export async function mute(muterId: number, mutedId: number, hideContent = false) {
  if (muterId === mutedId) throw new ServiceError('You cannot mute yourself.');
  await getDb().insert(schema.userMutes).values({ muterId, mutedId, hideContent }).onConflictDoUpdate({ target: [schema.userMutes.muterId, schema.userMutes.mutedId], set: { hideContent } });
}
export async function unmute(muterId: number, mutedId: number) {
  await getDb().delete(schema.userMutes).where(and(eq(schema.userMutes.muterId, muterId), eq(schema.userMutes.mutedId, mutedId)));
}

export async function listFriendRequests(userId: number) {
  const db = getDb();
  const incoming = await db.select().from(schema.friendRequests).where(and(eq(schema.friendRequests.toUserId, userId), eq(schema.friendRequests.status, 'pending'))).orderBy(desc(schema.friendRequests.createdAt));
  const outgoing = await db.select().from(schema.friendRequests).where(and(eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.status, 'pending'))).orderBy(desc(schema.friendRequests.createdAt));
  return { incoming, outgoing };
}

export async function listBlocksAndMutes(userId: number) {
  const db = getDb();
  const blocks = await db.select().from(schema.userBlocks).where(eq(schema.userBlocks.blockerId, userId));
  const mutes = await db.select().from(schema.userMutes).where(eq(schema.userMutes.muterId, userId));
  return { blocks, mutes };
}

// ─────────────── Top Friends ───────────────

export async function getTopFriends(userId: number): Promise<number[]> {
  const db = getDb();
  const [profile] = await db.select({ n: schema.userProfiles.topFriendsCount }).from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
  const n = profile?.n ?? 0;
  if (!n) return [];
  const rows = await db.select().from(schema.topFriends).where(eq(schema.topFriends.userId, userId)).orderBy(schema.topFriends.position);
  const friends = new Set(await friendIds(userId));
  return rows.filter((r) => friends.has(r.friendId)).slice(0, n).map((r) => r.friendId);
}

export async function setTopFriends(userId: number, count: number, ids: number[]) {
  if (!Number.isInteger(count) || count < 0 || count > 5) throw new ServiceError('Top Friends can show between 1 and 5 friends (or be turned off).');
  const chosen = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (chosen.length > count) throw new ServiceError(`You can choose at most ${count} Top Friends.`);
  const friends = new Set(await friendIds(userId));
  if (chosen.some((id) => !friends.has(id))) throw new ServiceError('Top Friends must be accepted friends.');
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.userProfiles).set({ topFriendsCount: count }).where(eq(schema.userProfiles.userId, userId));
    await tx.delete(schema.topFriends).where(eq(schema.topFriends.userId, userId));
    if (chosen.length) await tx.insert(schema.topFriends).values(chosen.map((friendId, i) => ({ userId, friendId, position: i + 1 })));
  });
}

export async function friendCount(userId: number): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.friendships).where(or(eq(schema.friendships.userLowId, userId), eq(schema.friendships.userHighId, userId)));
  return r.n;
}

export async function blockedSetFor(userId: number, others: number[]): Promise<Set<number>> {
  if (!others.length) return new Set();
  const rows = await getDb().select().from(schema.userBlocks).where(or(
    and(eq(schema.userBlocks.blockerId, userId), inArray(schema.userBlocks.blockedId, others)),
    and(eq(schema.userBlocks.blockedId, userId), inArray(schema.userBlocks.blockerId, others)),
  ));
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}
