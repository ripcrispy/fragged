/** Members' data: download, erase, delete account, and the last-full-administrator rule. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, makeForum, client, viewerFor } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { setModuleEnabled } from '../src/modules/runtime.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import * as F from '../src/services/forums.ts';
import * as M from '../src/services/messages.ts';
import { sendFriendRequest } from '../src/services/relationships.ts';
import * as Privacy from '../src/services/privacy.ts';
import { listDrinks, logDrink, logs as caffeineLogs } from '../modules/caffeine-tracker/service.ts';

beforeAll(async () => {
  await setupDb();
  await setModuleEnabled('caffeine-tracker', true);
});
afterAll(teardownDb);

/** A member with a thread, a reply in someone else's thread, a DM, a friend and a drink logged. */
async function busyMember(name: string) {
  resetLimits();
  const forum = await makeForum(`Forum ${name}`);
  const me = await makeUser({ username: name });
  const other = await makeUser();
  const { thread: alone } = await F.createThread(await viewerFor(me.id), forum, { title: `${name} talks alone`, body: 'Only I posted here.' });
  const { thread: shared } = await F.createThread(await viewerFor(other.id), forum, { title: `Shared by ${name}`, body: 'Somebody else started this.' });
  await F.reply(await viewerFor(me.id), shared.id, `My reply as ${name}`);
  const { thread: mineWithReplies } = await F.createThread(await viewerFor(me.id), forum, { title: `${name} asks a question`, body: 'Anyone?' });
  await F.reply(await viewerFor(other.id), mineWithReplies.id, 'I can help!');
  const conv = await M.openConversation(await viewerFor(me.id), other.id);
  await M.sendMessage(await viewerFor(me.id), conv.publicId, { body: `Secret plans from ${name}`, nonce: `n-${name}` });
  await M.sendMessage(await viewerFor(other.id), conv.publicId, { body: 'Got it', nonce: `r-${name}` });
  await sendFriendRequest(me.id, other.id);
  await sendFriendRequest(other.id, me.id); // accepts
  await getDb().update(schema.userProfiles).set({ bio: `I am ${name}`, location: 'Somewhere' }).where(eq(schema.userProfiles.userId, me.id));
  const drink = (await listDrinks())[0];
  await logDrink(me.id, { drinkId: drink.id, servings: 1, minutesAgo: 10 });
  return { me, other, alone, shared, mineWithReplies, conv };
}

describe('download your data', () => {
  it('exports account, content, messages, connections and add-on data, without secrets', async () => {
    const { me } = await busyMember('ExportMe');
    const c = client(); await c.login('ExportMe');
    const res = await c.post('/settings/data/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="fragged-data-ExportMe-\d{4}-\d{2}-\d{2}\.json"/);
    const data = JSON.parse(res.text);
    expect(data.account).toMatchObject({ id: me.id, username: 'ExportMe', email: 'exportme@example.test' });
    expect(data.profile.bio).toBe('I am ExportMe');
    expect(data.posts.map((p: any) => p.body)).toEqual(expect.arrayContaining(['Only I posted here.', 'My reply as ExportMe', 'Anyone?']));
    expect(data.conversations[0].messages.map((m: any) => m.body)).toEqual(['Secret plans from ExportMe', 'Got it']);
    expect(data.friends).toHaveLength(1);
    expect(data.addOns['caffeine-tracker'].data.drinks).toHaveLength(1);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(res.text).not.toMatch(/passwordHash|tokenHash|\$argon2|\$scrypt/);
    const [ev] = await getDb().select().from(schema.securityEvents).where(and(eq(schema.securityEvents.userId, me.id), eq(schema.securityEvents.kind, 'data_exported')));
    expect(ev).toBeTruthy();
  });

  it('is rate limited and needs a signed-in member', async () => {
    resetLimits();
    await makeUser({ username: 'ExportALot' });
    const c = client(); await c.login('ExportALot');
    for (let i = 0; i < 5; i++) expect((await c.post('/settings/data/export')).status).toBe(200);
    expect((await c.post('/settings/data/export')).location).toBe('/settings/data');
    expect((await client().get('/settings/data')).status).toBe(401);
  });
});

describe('delete your data', () => {
  it('erases the chosen parts and keeps the account and other members’ content', async () => {
    const { me, other, alone, shared, mineWithReplies } = await busyMember('EraseMe');
    const c = client(); await c.login('EraseMe');
    // the typed username must match
    await c.post('/settings/data/erase', { parts: ['posts'], confirmName: 'nope' });
    expect((await getDb().select().from(schema.posts).where(eq(schema.posts.userId, me.id))).every((p) => !p.isDeleted)).toBe(true);

    await c.post('/settings/data/erase', { parts: ['profile', 'posts', 'messages', 'connections', 'activity', 'modules'], confirmName: 'EraseMe' });
    const posts = await getDb().select().from(schema.posts).where(eq(schema.posts.userId, me.id));
    expect(posts.length).toBe(3);
    expect(posts.every((p) => p.isDeleted && p.body === '' && p.deletedReason === 'Removed at the author’s request')).toBe(true);
    const threads = new Map((await getDb().select().from(schema.threads).where(inArray(schema.threads.id, [alone.id, shared.id, mineWithReplies.id]))).map((t) => [t.id, t]));
    expect(threads.get(alone.id)!.isDeleted).toBe(true);           // nobody else posted
    expect(threads.get(mineWithReplies.id)!.isDeleted).toBe(false); // the reply stays for others
    expect(threads.get(shared.id)!.isDeleted).toBe(false);
    const theirs = await getDb().select().from(schema.posts).where(eq(schema.posts.userId, other.id));
    expect(theirs.every((p) => !p.isDeleted)).toBe(true);

    const msgs = await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.senderId, me.id));
    expect(msgs.every((m) => m.body === '' && m.hiddenAt)).toBe(true);
    expect((await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.senderId, other.id)))[0].body).toBe('Got it');
    expect(await getDb().select().from(schema.friendships).where(eq(schema.friendships.userLowId, Math.min(me.id, other.id)))).toHaveLength(0);
    expect((await getDb().select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, me.id)))[0].bio).toBe('');
    expect(await getDb().select().from(caffeineLogs).where(eq(caffeineLogs.userId, me.id))).toHaveLength(0);

    // still a working account
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, me.id));
    expect(u.closedAt).toBeNull();
    expect((await c.get('/settings/data')).status).toBe(200);
    const audit = await getDb().select().from(schema.auditLog).where(and(eq(schema.auditLog.actorId, me.id), eq(schema.auditLog.action, 'user.erase_data')));
    expect(audit).toHaveLength(1);
  });
});

describe('direct messages stay append-only outside erasure', () => {
  it('blocks edits and deletes, and erasure mode only allows blanking', async () => {
    const { me } = await busyMember('AppendOnly');
    const [m] = await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.senderId, me.id));
    await expect(getDb().update(schema.directMessages).set({ body: '' }).where(eq(schema.directMessages.id, m.id))).rejects.toThrow();
    await expect(getDb().delete(schema.directMessages).where(eq(schema.directMessages.id, m.id))).rejects.toThrow();
    await expect(getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('fragged.erasure', 'on', true)`);
      await tx.update(schema.directMessages).set({ body: 'rewritten history' }).where(eq(schema.directMessages.id, m.id));
    })).rejects.toThrow();
    // the setting is transaction-local: it doesn't leak to later statements
    await expect(getDb().update(schema.directMessages).set({ body: '' }).where(eq(schema.directMessages.id, m.id))).rejects.toThrow();
    expect((await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.id, m.id)))[0].body).toBe('Secret plans from AppendOnly');
  });

  it('keeps messages in a reported conversation', async () => {
    const { me, other, conv } = await busyMember('Reported');
    const [theirs] = await getDb().select().from(schema.directMessages).where(eq(schema.directMessages.senderId, other.id));
    const [c0] = await getDb().select().from(schema.conversations).where(eq(schema.conversations.publicId, conv.publicId));
    await getDb().insert(schema.reports).values({ reporterId: me.id, targetType: 'message', targetId: theirs.id, reason: 'harassment', details: '' });
    const done = await Privacy.eraseUserData(me.id, new Set(['messages']), { ip: null });
    expect(done).toMatchObject({ messages: 0, messagesKept: 1 });
    const mine = await getDb().select().from(schema.directMessages).where(and(eq(schema.directMessages.senderId, me.id), eq(schema.directMessages.conversationId, c0.id)));
    expect(mine[0].body).toBe('Secret plans from Reported');
  });
});

describe('delete your account', () => {
  it('anonymises the account, signs it out, and can erase content too', async () => {
    const { me } = await busyMember('LeaveMe');
    const c = client(); await c.login('LeaveMe');
    const r = await c.post('/settings/data/delete-account', { confirmName: 'LeaveMe', erase: '1' });
    expect(r.location).toBe('/');
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, me.id));
    expect(u).toMatchObject({ username: `former-member-${me.id}`, email: null, passwordHash: null });
    expect(u.closedAt).toBeInstanceOf(Date);
    expect((await getDb().select().from(schema.posts).where(eq(schema.posts.userId, me.id))).every((p) => p.isDeleted)).toBe(true);
    expect((await c.get('/settings/data')).status).toBe(401); // signed out
    expect((await client().login('LeaveMe')).location ?? '').not.toBe('/');
  });

  it('keeps posts when the member doesn’t ask to erase them, and the old close-account form still works', async () => {
    const { me } = await busyMember('KeepPosts');
    const c = client(); await c.login('KeepPosts');
    await c.post('/settings/account/close', { confirmName: 'KeepPosts' });
    expect((await getDb().select().from(schema.users).where(eq(schema.users.id, me.id)))[0].closedAt).toBeInstanceOf(Date);
    expect((await getDb().select().from(schema.posts).where(eq(schema.posts.userId, me.id))).some((p) => !p.isDeleted)).toBe(true);
  });
});

describe('the last full administrator', () => {
  it('must hand over before deleting their account', async () => {
    // make sure our administrator really is the only one
    const admin = await makeUser({ username: 'OnlyBoss', group: 'admin' });
    for (const id of await Privacy.activeSuperAdminIds()) if (id !== admin.id) await getDb().update(schema.users).set({ closedAt: new Date() }).where(eq(schema.users.id, id));
    expect(await Privacy.isLastSuperAdmin(admin.id)).toBe(true);
    const next = await makeUser({ username: 'NextBoss' });

    const c = client(); await c.login('OnlyBoss');
    const page = await c.get('/settings/data');
    expect(page.text).toContain('You’re the only full administrator');
    expect(page.text).not.toContain('Delete my account');
    // the form is hidden, and the server refuses too
    await c.post('/settings/data/delete-account', { confirmName: 'OnlyBoss' });
    expect((await getDb().select().from(schema.users).where(eq(schema.users.id, admin.id)))[0].closedAt).toBeNull();

    // members can't make themselves administrators through the handover form
    const sneaky = client(); await sneaky.login('NextBoss');
    await sneaky.post('/settings/data/handover', { username: 'NextBoss' });
    expect(await Privacy.activeSuperAdminIds()).toEqual([admin.id]);

    await c.post('/settings/data/handover', { username: 'NextBoss' });
    expect((await Privacy.activeSuperAdminIds()).sort()).toEqual([admin.id, next.id].sort());
    const note = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, next.id));
    expect(note.some((n) => /full administrator/.test(n.text))).toBe(true);
    expect((await c.get('/settings/data')).text).toContain('Delete my account');

    await c.post('/settings/data/delete-account', { confirmName: 'OnlyBoss' });
    expect((await getDb().select().from(schema.users).where(eq(schema.users.id, admin.id)))[0].closedAt).toBeInstanceOf(Date);
    // now NextBoss is the last one and is protected in turn
    expect(await Privacy.isLastSuperAdmin(next.id)).toBe(true);
  });

  it('doesn’t count closed or banned administrators', async () => {
    const a = await makeUser({ group: 'admin' });
    const b = await makeUser({ group: 'admin' });
    for (const id of await Privacy.activeSuperAdminIds()) if (id !== a.id && id !== b.id) await getDb().update(schema.users).set({ closedAt: new Date() }).where(eq(schema.users.id, id));
    expect(await Privacy.isLastSuperAdmin(a.id)).toBe(false);
    await getDb().insert(schema.userBans).values({ userId: b.id, issuedById: a.id, kind: 'ban', reason: 'test' });
    expect(await Privacy.isLastSuperAdmin(a.id)).toBe(true);
    await expect(Privacy.deleteAccount(await viewerFor(a.id), { eraseContent: false })).rejects.toThrow(/only full administrator/);
  });
});
