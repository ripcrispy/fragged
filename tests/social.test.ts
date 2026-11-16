import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, viewerFor, makeForum } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import * as R from '../src/services/relationships.ts';
import * as M from '../src/services/messages.ts';
import * as P from '../src/services/profiles.ts';
import { notify } from '../src/services/notifications.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { createThread, reply } from '../src/services/forums.ts';

beforeAll(setupDb);
afterAll(teardownDb);

async function befriend(a: number, b: number) {
  await R.sendFriendRequest(a, b);
  const { incoming } = await R.listFriendRequests(b);
  await R.respondToRequest(b, incoming.find((r) => r.fromUserId === a)!.id, 'accept');
}

describe('friend requests', () => {
  it('send / accept / remove, with no duplicates', async () => {
    const a = await makeUser(); const b = await makeUser();
    expect(await R.sendFriendRequest(a.id, b.id)).toBe('sent');
    await expect(R.sendFriendRequest(a.id, b.id)).rejects.toThrow(/already sent/);
    // reverse request auto-accepts instead of creating contradictory state
    expect(await R.sendFriendRequest(b.id, a.id)).toBe('accepted');
    expect(await R.areFriends(a.id, b.id)).toBe(true);
    await expect(R.sendFriendRequest(a.id, b.id)).rejects.toThrow(/already friends/);
    await R.removeFriend(a.id, b.id);
    expect(await R.areFriends(a.id, b.id)).toBe(false);
  });
  it('decline and cancel', async () => {
    const a = await makeUser(); const b = await makeUser();
    await R.sendFriendRequest(a.id, b.id);
    const { outgoing } = await R.listFriendRequests(a.id);
    await R.cancelRequest(a.id, outgoing[0].id);
    expect((await R.listFriendRequests(b.id)).incoming).toHaveLength(0);
    await R.sendFriendRequest(a.id, b.id);
    const { incoming } = await R.listFriendRequests(b.id);
    await expect(R.respondToRequest(a.id, incoming[0].id, 'accept')).rejects.toThrow(); // only recipient may respond
    await R.respondToRequest(b.id, incoming[0].id, 'decline');
    expect(await R.areFriends(a.id, b.id)).toBe(false);
  });
});

describe('blocking and muting', () => {
  it('block removes friendship and prevents requests, messages and comments', async () => {
    const a = await makeUser(); const b = await makeUser();
    await befriend(a.id, b.id);
    const conv = await M.openConversation(await viewerFor(a.id), b.id);
    await M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'before block', nonce: 'blk-nonce-1' });
    await R.block(b.id, a.id);
    expect(await R.areFriends(a.id, b.id)).toBe(false);
    await expect(R.sendFriendRequest(a.id, b.id)).rejects.toMatchObject({ code: 'blocked' });
    resetLimits();
    await expect(M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'after block', nonce: 'blk-nonce-2' })).rejects.toMatchObject({ code: 'cannot_message' });
    await expect(M.sendMessage(await viewerFor(b.id), conv.publicId, { body: 'blocker sending', nonce: 'blk-nonce-3' })).rejects.toMatchObject({ code: 'cannot_message' });
    await expect(P.addComment(await viewerFor(a.id), b.id, 'hi')).rejects.toMatchObject({ status: 403 });
    // history survives
    const h = await M.history(await viewerFor(a.id), conv.publicId);
    expect(h.messages.map((m) => m.body)).toEqual(['before block']);
    await R.unblock(b.id, a.id);
    resetLimits();
    await expect(M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'after unblock', nonce: 'blk-nonce-4' })).resolves.toBeTruthy();
  });

  it('mute suppresses notifications but does not block messages', async () => {
    const a = await makeUser(); const b = await makeUser();
    await R.mute(b.id, a.id);
    expect(await notify(b.id, 'mention', a.id, 'x', '/')).toBe(false);
    expect(await notify(b.id, 'security', null, 'security notices still arrive', '/')).toBe(true);
    const conv = await M.openConversation(await viewerFor(a.id), b.id);
    await expect(M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'muted but delivered', nonce: 'mute-nonce-1' })).resolves.toBeTruthy();
    const notes = await getDb().select().from(schema.notifications).where(and(eq(schema.notifications.userId, b.id), eq(schema.notifications.kind, 'message')));
    expect(notes).toHaveLength(0);
  });

  it('reply/mention notifications reach subscribers', async () => {
    const forum = await makeForum('Notify');
    const a = await makeUser(); const b = await makeUser();
    const { thread } = await createThread(await viewerFor(a.id), forum, { title: 'Subscribed', body: 'op body text' });
    resetLimits();
    await reply(await viewerFor(b.id), thread.id, `hey @${a.username} look`);
    const notes = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, a.id));
    expect(notes.map((n) => n.kind)).toContain('mention');
  });
});

describe('direct messages', () => {
  it('reuses conversations, is idempotent, ordered, and isolated', async () => {
    const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
    const va = await viewerFor(a.id);
    const c1 = await M.openConversation(va, b.id);
    const c2 = await M.openConversation(await viewerFor(b.id), a.id);
    expect(c1.id).toBe(c2.id);
    const m1 = await M.sendMessage(va, c1.publicId, { body: 'one', nonce: 'idem-nonce-1' });
    const dup = await M.sendMessage(va, c1.publicId, { body: 'one', nonce: 'idem-nonce-1' });
    expect(dup.duplicate).toBe(true); expect(dup.message.id).toBe(m1.message.id);
    await M.sendMessage(va, c1.publicId, { body: 'two', nonce: 'idem-nonce-2' });
    const h = await M.history(await viewerFor(b.id), c1.publicId);
    expect(h.messages.map((m) => m.body)).toEqual(['one', 'two']);
    await expect(M.history(await viewerFor(c.id), c1.publicId)).rejects.toMatchObject({ status: 404 });
    expect(await M.totalUnreadMessages(b.id)).toBe(2);
    await M.markConversationRead(await viewerFor(b.id), c1.publicId);
    expect(await M.totalUnreadMessages(b.id)).toBe(0);
  });

  it('cannot be edited or deleted, even directly in SQL', async () => {
    const a = await makeUser(); const b = await makeUser();
    const conv = await M.openConversation(await viewerFor(a.id), b.id);
    const { message } = await M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'permanent', nonce: 'perm-nonce-1' });
    await expect(getDb().update(schema.directMessages).set({ body: 'rewritten' }).where(eq(schema.directMessages.id, message.id))).rejects.toThrow();
    await expect(getDb().delete(schema.directMessages).where(eq(schema.directMessages.id, message.id))).rejects.toThrow();
    // staff hide is allowed (and audited) but keeps the original body
    const admin = await makeUser({ group: 'admin' });
    await M.staffHideMessage(await viewerFor(admin.id), message.id, 'Reported for harassment');
    const [row] = await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.id, message.id));
    expect(row.body).toBe('permanent'); expect(row.hiddenAt).toBeTruthy();
  });

  it('respects DM policy', async () => {
    const a = await makeUser(); const b = await makeUser();
    await getDb().update(schema.userSettings).set({ dmPolicy: 'friends' }).where(eq(schema.userSettings.userId, b.id));
    await expect(M.openConversation(await viewerFor(a.id), b.id)).rejects.toMatchObject({ code: 'cannot_message' });
    await befriend(a.id, b.id);
    await expect(M.openConversation(await viewerFor(a.id), b.id)).resolves.toBeTruthy();
  });

  it('stores external links as references only', async () => {
    const a = await makeUser(); const b = await makeUser();
    const conv = await M.openConversation(await viewerFor(a.id), b.id);
    const { message } = await M.sendMessage(await viewerFor(a.id), conv.publicId, { body: 'file: https://files.example.org/x.zip and javascript:alert(1)', nonce: 'link-nonce-1' });
    expect(message.links).toEqual(['https://files.example.org/x.zip']);
    expect(message.attachments).toHaveLength(0);
  });
});

describe('profiles', () => {
  it('profile comments are friends-only', async () => {
    const a = await makeUser(); const b = await makeUser();
    await expect(P.addComment(await viewerFor(a.id), b.id, 'hello')).rejects.toMatchObject({ status: 403 });
    await befriend(a.id, b.id);
    resetLimits();
    const c = await P.addComment(await viewerFor(a.id), b.id, 'hello friend');
    expect(c.state).toBe('visible');
    await P.removeComment(await viewerFor(b.id), c.id); // owner may remove
  });
  it('Top Friends: 0–5, friends only', async () => {
    const a = await makeUser(); const b = await makeUser(); const stranger = await makeUser();
    await befriend(a.id, b.id);
    await R.setTopFriends(a.id, 1, [b.id]);
    expect(await R.getTopFriends(a.id)).toEqual([b.id]);
    await expect(R.setTopFriends(a.id, 6, [b.id])).rejects.toThrow();
    await expect(R.setTopFriends(a.id, 2, [b.id, stranger.id])).rejects.toThrow(/accepted friends/);
    await expect(R.setTopFriends(a.id, 1, [b.id, stranger.id])).rejects.toThrow(/at most 1/);
  });
  it('validates colours and keeps pronouns optional', async () => {
    const a = await makeUser();
    const v = await viewerFor(a.id);
    const errs = await P.updateProfile(v, { backgroundColor: 'red;background:url(x)', pronouns: '' });
    expect(errs.backgroundColor).toBeTruthy();
    const ok = await P.updateProfile(v, { backgroundColor: '#123456' });
    expect(ok).toEqual({});
    const [p] = await getDb().select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, a.id));
    expect(p.backgroundColor).toBe('#123456'); expect(p.pronouns).toBeNull();
  });
  it('member search hides undiscoverable members except on exact match', async () => {
    const hidden = await makeUser({ username: 'ShyPerson' });
    await getDb().update(schema.userSettings).set({ discoverable: false }).where(eq(schema.userSettings.userId, hidden.id));
    const v = await viewerFor(null);
    expect((await P.searchMembers(v, { q: 'shyp' })).members.map((m) => m.username)).not.toContain('ShyPerson');
    expect((await P.searchMembers(v, { q: 'shyperson' })).members.map((m) => m.username)).toContain('ShyPerson');
  });
});
