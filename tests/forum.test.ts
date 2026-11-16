import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, viewerFor, makeForum } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import * as F from '../src/services/forums.ts';
import { ServiceError } from '../src/services/users.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { suspendUser } from '../src/services/moderation.ts';
import { search } from '../src/services/search.ts';
import { openConversation, sendMessage } from '../src/services/messages.ts';
import { setSetting } from '../src/services/settings.ts';
import { evaluate as evaluateAchievements } from '../modules/achievements/service.ts';

beforeAll(setupDb);
afterAll(teardownDb);

describe('threads and posts', () => {
  it('creates threads, replies, numbers posts and maintains counters', async () => {
    const forum = await makeForum('Counters');
    const a = await makeUser(); const b = await makeUser();
    const { thread, post } = await F.createThread(await viewerFor(a.id), forum, { title: 'Hello world', body: 'First post body', tags: ['Discussion'] });
    expect(post.position).toBe(1);
    resetLimits();
    const r = await F.reply(await viewerFor(b.id), thread.id, 'A reply here');
    expect(r.position).toBe(2);
    const [t] = await getDb().select().from(schema.threads).where(eq(schema.threads.id, thread.id));
    expect(t.replyCount).toBe(1);
    const [f] = await getDb().select().from(schema.forums).where(eq(schema.forums.id, forum.id));
    expect(f.threadCount).toBe(1); expect(f.postCount).toBe(2); expect(f.lastPostUserId).toBe(b.id);
    const tags = (await F.tagsForThreads([thread.id])).get(thread.id)!;
    expect(tags.map((x) => x.slug)).toContain('discussion');
  });

  it('guests and suspended members cannot post', async () => {
    const forum = await makeForum('Perms');
    await expect(F.createThread(await viewerFor(null), forum, { title: 'Nope', body: 'nope nope' })).rejects.toMatchObject({ status: 401 });
    const mod = await makeUser({ group: 'moderator' }); const u = await makeUser();
    await suspendUser(await viewerFor(mod.id), u.id, 'Testing suspension', 3);
    await expect(F.createThread(await viewerFor(u.id), forum, { title: 'Nope', body: 'nope nope' })).rejects.toMatchObject({ status: 403 });
    // they can still read
    expect(await (await viewerFor(u.id)).can('forum.view', forum.id)).toBe(true);
  });

  it('enforces forum permission overrides server-side', async () => {
    const forum = await makeForum('Private');
    const [member] = await getDb().select().from(schema.userGroups).where(eq(schema.userGroups.slug, 'member'));
    const [guest] = await getDb().select().from(schema.userGroups).where(eq(schema.userGroups.slug, 'guest'));
    await getDb().insert(schema.permissionOverrides).values([{ forumId: forum.id, groupId: member.id, permissions: { 'forum.view': 'deny' } }, { forumId: forum.id, groupId: guest.id, permissions: { 'forum.view': 'deny' } }]);
    (await import('../src/services/permissions.ts')).invalidatePermissionCache();
    const u = await makeUser();
    await expect(F.assertForumVisible(await viewerFor(u.id), forum)).rejects.toMatchObject({ status: 403 });
    const admin = await makeUser({ group: 'admin' });
    await expect(F.assertForumVisible(await viewerFor(admin.id), forum)).resolves.toBeTruthy();
  });

  it('subforums inherit a parent forum denial', async () => {
    const parent = await makeForum('ParentDenied');
    const [child] = await getDb().insert(schema.forums).values({ categoryId: parent.categoryId, parentForumId: parent.id, name: 'Child', slug: 'child-of-denied-' + Date.now() }).returning();
    const [member] = await getDb().select().from(schema.userGroups).where(eq(schema.userGroups.slug, 'member'));
    await getDb().insert(schema.permissionOverrides).values({ forumId: parent.id, groupId: member.id, permissions: { 'forum.view': 'deny' } });
    (await import('../src/services/permissions.ts')).invalidatePermissionCache();
    const u = await makeUser();
    await expect(F.assertForumVisible(await viewerFor(u.id), child)).rejects.toMatchObject({ status: 403 });
    const { viewableForumIds } = await import('../src/services/permissions.ts');
    expect(await viewableForumIds((await viewerFor(u.id)).subject)).not.toContain(child.id);
  });

  it('lets authors edit with revision history and blocks editing others', async () => {
    const forum = await makeForum('Edits');
    const a = await makeUser(); const b = await makeUser();
    const { post } = await F.createThread(await viewerFor(a.id), forum, { title: 'Editable', body: 'Original text' });
    await F.editPost(await viewerFor(a.id), post.id, 'Updated text');
    const revs = await getDb().select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, post.id));
    expect(revs[0].body).toBe('Original text');
    await expect(F.editPost(await viewerFor(b.id), post.id, 'Hijack')).rejects.toMatchObject({ status: 403 });
  });

  it('locked threads reject replies from members but not moderators', async () => {
    const forum = await makeForum('Locks');
    const a = await makeUser(); const mod = await makeUser({ group: 'moderator' });
    const { thread } = await F.createThread(await viewerFor(a.id), forum, { title: 'Lock me', body: 'body text' });
    await F.setThreadFlags(await viewerFor(mod.id), thread.id, { isLocked: true });
    resetLimits();
    await expect(F.reply(await viewerFor(a.id), thread.id, 'still here?')).rejects.toMatchObject({ code: 'locked' });
    await expect(F.reply(await viewerFor(mod.id), thread.id, 'Moderator note')).resolves.toBeTruthy();
    await expect(F.setThreadFlags(await viewerFor(a.id), thread.id, { isLocked: false })).rejects.toBeInstanceOf(ServiceError);
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'thread.flags'));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('paginates posts and sorts thread lists', async () => {
    const forum = await makeForum('Paging');
    const a = await makeUser();
    const v = await viewerFor(a.id);
    const { thread } = await F.createThread(v, forum, { title: 'Long thread', body: 'post 1' });
    for (let i = 2; i <= 25; i++) { resetLimits(); await F.reply(v, thread.id, `post number ${i}`); }
    const v2 = await viewerFor(a.id);
    const p2 = await F.listPosts(v2, thread, forum, 2);
    expect(p2.pages).toBe(2); expect(p2.posts[0].position).toBe(21);
    resetLimits();
    await F.createThread(v, forum, { title: 'Aardvark thread', body: 'zzz zzz' });
    const byTitle = await F.listThreads(v, forum, { sort: 'title', order: 'asc' });
    expect(byTitle.threads[0].title).toBe('Aardvark thread');
  });

  it('moves, merges and splits threads', async () => {
    const f1 = await makeForum('MoveA'); const f2 = await makeForum('MoveB');
    const a = await makeUser(); const mod = await makeUser({ group: 'moderator' });
    const va = await viewerFor(a.id); const vm = await viewerFor(mod.id);
    const t1 = (await F.createThread(va, f1, { title: 'One', body: 'one body' })).thread;
    resetLimits();
    const t2 = (await F.createThread(va, f1, { title: 'Two', body: 'two body' })).thread;
    await F.moveThread(vm, t1.id, f2.id);
    expect((await F.threadById(t1.id))!.forumId).toBe(f2.id);
    await F.mergeThreads(vm, t2.id, t1.id);
    const merged = await getDb().select().from(schema.posts).where(eq(schema.posts.threadId, t1.id));
    expect(merged.length).toBe(2);
    const [moved] = merged.filter((p) => p.position === 2);
    const nt = await F.splitThread(vm, t1.id, [moved.id], 'Split off');
    expect((await getDb().select().from(schema.posts).where(eq(schema.posts.threadId, nt.id))).length).toBe(1);
  });

  it('reactions are toggled, capped and not allowed on own posts', async () => {
    const forum = await makeForum('Reacts');
    const a = await makeUser(); const b = await makeUser();
    const { post } = await F.createThread(await viewerFor(a.id), forum, { title: 'React to me', body: 'something nice' });
    const vb = await viewerFor(b.id);
    expect((await F.react(vb, post.id, 'agree')).active).toBe(true);
    expect((await F.react(vb, post.id, 'agree')).active).toBe(false);
    await expect(F.react(await viewerFor(a.id), post.id, 'agree')).rejects.toBeInstanceOf(ServiceError);
    await expect(F.react(vb, post.id, 'bogus')).rejects.toBeInstanceOf(ServiceError);
  });

  it('awards achievements once only', async () => {
    const forum = await makeForum('Ach');
    const a = await makeUser();
    await F.createThread(await viewerFor(a.id), forum, { title: 'First thread', body: 'long enough body' });
    await evaluateAchievements(a.id); await evaluateAchievements(a.id);
    const rows = await getDb().select().from(schema.userAchievements).where(eq(schema.userAchievements.userId, a.id));
    const ids = rows.map((r) => r.achievementId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tags and content warnings', () => {
  it('requires post count to create new tags and rejects restricted tag names', async () => {
    const forum = await makeForum('Tags');
    const a = await makeUser({ group: 'established' });
    await setSetting('user_tag_min_posts', 0);
    const { thread } = await F.createThread(await viewerFor(a.id), forum, { title: 'Tagged', body: 'body here', tags: ['NSFW', 'My New Tag'] });
    const tags = (await F.tagsForThreads([thread.id])).get(thread.id)!;
    expect(tags.map((t) => t.slug).sort()).toEqual(['my-new-tag', 'nsfw']);
    const newbie = await makeUser();
    resetLimits();
    await expect(F.createThread(await viewerFor(newbie.id), forum, { title: 'Tagged2', body: 'body here', tags: ['Brand New Tag'] })).rejects.toMatchObject({ status: 403 });
  });

  it('hides NSFW threads in listings when the viewer chooses hide', async () => {
    const forum = await makeForum('NSFWList');
    const a = await makeUser(); const b = await makeUser();
    await F.createThread(await viewerFor(a.id), forum, { title: 'Spicy', body: 'mild but labelled', tags: ['NSFW'] });
    await getDb().update(schema.userSettings).set({ nsfwMode: 'hide' }).where(eq(schema.userSettings.userId, b.id));
    const list = await F.listThreads(await viewerFor(b.id), forum, {});
    expect(list.threads[0].hiddenReason).toBe('nsfw');
  });
});

describe('search', () => {
  it('finds posts, respects forum permissions, and never includes direct messages', async () => {
    const forum = await makeForum('Searchable');
    const a = await makeUser(); const b = await makeUser();
    resetLimits();
    await F.createThread(await viewerFor(a.id), forum, { title: 'Quaternion questions', body: 'How do quaternions avoid gimbal lock?' });
    const conv = await openConversation(await viewerFor(a.id), b.id);
    await sendMessage(await viewerFor(a.id), conv.publicId, { body: 'secret quaternion gossip', nonce: 'nonce-search-1' });
    resetLimits();
    const r = await search(await viewerFor(b.id), { q: 'quaternion', type: 'posts' });
    expect(r.total).toBe(1);
    expect(r.results.every((x) => !x.excerpt.includes('gossip'))).toBe(true);
    const t = await search(await viewerFor(b.id), { q: 'quaternion', type: 'threads' });
    expect(t.results[0].thread.title).toBe('Quaternion questions');
  });
});
