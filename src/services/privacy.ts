/**
 * Members' own data: download everything we hold about them, erase parts of it while keeping the account, and
 * delete the account. Modules join in through the `personalData` extension point (export + erase).
 *
 * Kept on purpose, and explained on the page: the audit log and security events (needed to investigate abuse and
 * account takeovers), moderation records about the member, reports other members made, and payment records that
 * modules must keep (they anonymise them instead).
 */
import { and, eq, inArray, or, sql, desc, asc, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { registries, emit } from '../modules/registry.ts';
import { log } from '../lib/log.ts';
import { ServiceError } from './users.ts';
import { audit, securityEvent } from './audit.ts';
import { storage } from './uploads.ts';
import { recountThread, recountForum, recountUser } from './forums.ts';
import { invalidatePermissionCache } from './permissions.ts';
import type { Viewer } from './viewer.ts';

export const ERASE_PARTS = {
  profile: { label: 'Profile', hint: 'Bio, signature, pronouns, location, title, links, avatar, cover image and Top Friends, plus comments on your profile and comments you left on others.' },
  posts: { label: 'Forum posts and threads', hint: 'Every post you wrote is removed and shows as “Removed at the author’s request”. Threads you started are removed if nobody else replied.' },
  messages: { label: 'Direct messages you sent', hint: 'The text and attachments of messages you sent are removed from both sides of the conversation. Messages in a conversation someone has reported are kept until moderators have reviewed it.' },
  uploads: { label: 'Uploaded images', hint: 'Images you uploaded are deleted from the server. Community emoji other members use are kept.' },
  activity: { label: 'Activity', hint: 'Reactions, bookmarks, subscriptions, drafts, notifications, read markers and notification preferences.' },
  connections: { label: 'Friends and blocks', hint: 'Friends, friend requests, blocks and mutes.' },
  modules: { label: 'LAN and add-on data', hint: 'Bookings, seats, food orders, drinks logged, achievements and other add-on data. Records organisers must keep, such as paid food orders and entry payments, stay as records (entry payments without your name).' },
} as const;
export type ErasePart = keyof typeof ERASE_PARTS;
export const ALL_PARTS = Object.keys(ERASE_PARTS) as ErasePart[];

const db = () => getDb();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ───────────────────────────── export ─────────────────────────────

/** Everything we hold about a member, as a plain JSON-ready object. Secrets (password hash, tokens) are left out. */
export async function exportUserData(userId: number) {
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new ServiceError('Member not found.', 404);
  const [profile] = await db().select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
  const [settings] = await db().select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  const groups = await db().select({ name: schema.userGroups.name, slug: schema.userGroups.slug }).from(schema.userGroupMemberships)
    .innerJoin(schema.userGroups, eq(schema.userGroups.id, schema.userGroupMemberships.groupId)).where(eq(schema.userGroupMemberships.userId, userId));

  const threads = await db().select().from(schema.threads).where(eq(schema.threads.userId, userId)).orderBy(asc(schema.threads.id));
  const posts = await db().select({ p: schema.posts, title: schema.threads.title }).from(schema.posts)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId)).where(eq(schema.posts.userId, userId)).orderBy(asc(schema.posts.id));
  const reactions = await db().select().from(schema.postReactions).where(eq(schema.postReactions.userId, userId));
  const uploads = await db().select().from(schema.uploads).where(eq(schema.uploads.userId, userId)).orderBy(asc(schema.uploads.id));

  const convIds = (await db().select({ id: schema.conversationParticipants.conversationId }).from(schema.conversationParticipants)
    .where(eq(schema.conversationParticipants.userId, userId))).map((r) => r.id);
  const messages = convIds.length ? await db().select().from(schema.directMessages).where(inArray(schema.directMessages.conversationId, convIds)).orderBy(asc(schema.directMessages.id)) : [];
  const convs = convIds.length ? await db().select().from(schema.conversations).where(inArray(schema.conversations.id, convIds)) : [];

  const friendships = await db().select().from(schema.friendships).where(or(eq(schema.friendships.userLowId, userId), eq(schema.friendships.userHighId, userId)));
  const requests = await db().select().from(schema.friendRequests).where(or(eq(schema.friendRequests.fromUserId, userId), eq(schema.friendRequests.toUserId, userId)));
  const blocks = await db().select().from(schema.userBlocks).where(eq(schema.userBlocks.blockerId, userId));
  const mutes = await db().select().from(schema.userMutes).where(eq(schema.userMutes.muterId, userId));
  const top = await db().select().from(schema.topFriends).where(eq(schema.topFriends.userId, userId)).orderBy(asc(schema.topFriends.position));
  const commentsWritten = await db().select().from(schema.profileComments).where(eq(schema.profileComments.authorId, userId));
  const commentsReceived = await db().select().from(schema.profileComments).where(eq(schema.profileComments.profileUserId, userId));

  // usernames for everyone mentioned, so the file reads without our database
  const others = new Set<number>();
  for (const f of friendships) others.add(f.userLowId === userId ? f.userHighId : f.userLowId);
  for (const r of requests) others.add(r.fromUserId === userId ? r.toUserId : r.fromUserId);
  for (const x of [...blocks.map((b) => b.blockedId), ...mutes.map((m) => m.mutedId), ...top.map((t) => t.friendId), ...messages.map((m) => m.senderId),
    ...commentsWritten.map((c) => c.profileUserId), ...commentsReceived.map((c) => c.authorId), ...convs.flatMap((c) => [c.userLowId, c.userHighId])]) others.add(x);
  others.delete(userId);
  const names = new Map(others.size ? (await db().select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, [...others]))).map((r) => [r.id, r.username]) : []);
  const who = (id: number | null) => (id === null ? null : id === userId ? u.username : names.get(id) ?? `member #${id}`);

  const modules: Record<string, { label: string; data: unknown }> = {};
  for (const m of registries.personalData.active()) {
    try { modules[m.id] = { label: m.label, data: await m.export(userId) }; }
    catch (e) { log.error('personal data export failed', { module: m.id, error: String(e) }); modules[m.id] = { label: m.label, data: { error: 'This add-on could not export its data. Please ask an administrator.' } }; }
  }

  return {
    about: 'Everything Fragged Forums holds about your account, in JSON. Times are UTC.',
    generatedAt: new Date().toISOString(),
    account: {
      id: u.id, username: u.username, email: u.email, emailVerified: !!u.emailVerifiedAt, timezone: u.timezone, dateOfBirth: u.dateOfBirth,
      joined: iso(u.createdAt), lastSeen: iso(u.lastSeenAt), usernameChanged: iso(u.usernameChangedAt), termsAccepted: iso(u.termsAcceptedAt),
      postCount: u.postCount, threadCount: u.threadCount, groups: groups.map((g) => g.name), hasPassword: !!u.passwordHash,
    },
    profile: profile ? { ...profile, userId: undefined } : null,
    settings: settings ? { ...settings, userId: undefined } : null,
    notificationPreferences: await db().select({ kind: schema.notificationPreferences.kind, inApp: schema.notificationPreferences.inApp, email: schema.notificationPreferences.email }).from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userId)),
    signInProviders: (await db().select().from(schema.externalAccounts).where(eq(schema.externalAccounts.userId, userId))).map((x) => ({ provider: x.provider, email: x.providerEmail, name: x.providerDisplayName, connected: iso(x.connectedAt), lastUsed: iso(x.lastAuthAt) })),
    sessions: (await db().select().from(schema.userSessions).where(eq(schema.userSessions.userId, userId)).orderBy(desc(schema.userSessions.createdAt)))
      .map((s) => ({ started: iso(s.createdAt), lastUsed: iso(s.lastUsedAt), expires: iso(s.expiresAt), signedOut: iso(s.revokedAt), ip: s.ip, device: s.userAgent })),
    securityEvents: (await db().select().from(schema.securityEvents).where(eq(schema.securityEvents.userId, userId)).orderBy(desc(schema.securityEvents.createdAt)))
      .map((e) => ({ when: iso(e.createdAt), event: e.kind, method: e.provider, ip: e.ip, device: e.userAgent })),
    threadsStarted: threads.map((t) => ({ id: t.id, title: t.title, url: `/t/${t.id}-${t.slug}`, created: iso(t.createdAt), deleted: t.isDeleted })),
    posts: posts.map(({ p, title }) => ({ id: p.id, thread: title, url: `/p/${p.id}`, written: iso(p.createdAt), edited: iso(p.editedAt), deleted: p.isDeleted, body: p.body })),
    reactions: reactions.map((r) => ({ post: `/p/${r.postId}`, reaction: r.reaction, when: iso(r.createdAt) })),
    bookmarks: (await db().select().from(schema.threadBookmarks).where(eq(schema.threadBookmarks.userId, userId))).map((b) => ({ thread: `/t/${b.threadId}`, when: iso(b.createdAt) })),
    subscriptions: {
      threads: (await db().select().from(schema.threadSubscriptions).where(eq(schema.threadSubscriptions.userId, userId))).map((s) => `/t/${s.threadId}`),
      forums: (await db().select().from(schema.forumSubscriptions).where(eq(schema.forumSubscriptions.userId, userId))).map((s) => s.forumId),
    },
    drafts: (await db().select().from(schema.drafts).where(eq(schema.drafts.userId, userId))).map((d) => ({ where: d.key, title: d.title, body: d.body, saved: iso(d.updatedAt) })),
    uploads: uploads.map((x) => ({ url: `/media/${x.publicId}`, purpose: x.purpose, originalName: x.originalName, width: x.width, height: x.height, bytes: x.bytes, uploaded: iso(x.createdAt) })),
    friends: friendships.map((f) => ({ member: who(f.userLowId === userId ? f.userHighId : f.userLowId), since: iso(f.createdAt) })),
    friendRequests: requests.map((r) => ({ from: who(r.fromUserId), to: who(r.toUserId), status: r.status, sent: iso(r.createdAt), answered: iso(r.respondedAt) })),
    topFriends: top.map((t) => who(t.friendId)),
    blocked: blocks.map((b) => ({ member: who(b.blockedId), since: iso(b.createdAt) })),
    muted: mutes.map((m) => ({ member: who(m.mutedId), hideContent: m.hideContent, since: iso(m.createdAt) })),
    profileComments: {
      written: commentsWritten.map((c) => ({ on: who(c.profileUserId), body: c.body, when: iso(c.createdAt), deleted: c.isDeleted })),
      received: commentsReceived.map((c) => ({ from: who(c.authorId), body: c.body, when: iso(c.createdAt), deleted: c.isDeleted })),
    },
    conversations: convs.map((c) => ({
      with: who(c.userLowId === userId ? c.userHighId : c.userLowId),
      messages: messages.filter((m) => m.conversationId === c.id).map((m) => ({ from: who(m.senderId), sent: iso(m.createdAt), body: m.body, hiddenByModerators: !!m.hiddenAt })),
    })),
    notifications: (await db().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)).orderBy(desc(schema.notifications.createdAt)).limit(1000))
      .map((n) => ({ when: iso(n.createdAt), kind: n.kind, text: n.text, url: n.url, read: iso(n.readAt) })),
    reportsYouMade: (await db().select().from(schema.reports).where(eq(schema.reports.reporterId, userId))).map((r) => ({ what: `${r.targetType} #${r.targetId}`, reason: r.reason, details: r.details, status: r.status, when: iso(r.createdAt) })),
    warnings: (await db().select().from(schema.userWarnings).where(eq(schema.userWarnings.userId, userId))).map((w) => ({ reason: w.reason, points: w.points, issued: iso(w.createdAt), expires: iso(w.expiresAt) })),
    suspensionsAndBans: (await db().select().from(schema.userBans).where(eq(schema.userBans.userId, userId))).map((b) => ({ kind: b.kind, reason: b.reason, from: iso(b.createdAt), until: iso(b.expiresAt), lifted: iso(b.liftedAt) })),
    addOns: modules,
  };
}

// ───────────────────────────── erase ─────────────────────────────

/** Conversations with an open report: their messages are evidence and stay until moderators finish. */
async function reportedConversationIds(): Promise<Set<number>> {
  const open = await db().select({ id: schema.reports.targetId }).from(schema.reports).where(and(eq(schema.reports.targetType, 'message'), eq(schema.reports.status, 'open')));
  if (!open.length) return new Set();
  return new Set((await db().select({ c: schema.directMessages.conversationId }).from(schema.directMessages).where(inArray(schema.directMessages.id, open.map((r) => r.id)))).map((r) => r.c));
}

/**
 * Direct messages are append-only (migration 0001). Only a transaction that switches on erasure mode may blank a
 * message's text or remove its attachments (migration 0005); this is the one place that does.
 */
async function inErasureMode<T>(fn: (tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('fragged.erasure', 'on', true)`);
    return fn(tx);
  });
}

async function removeUploads(ids: number[]) {
  if (!ids.length) return 0;
  // community emoji are used by everyone, and images in reported conversations are evidence, so both stay
  const keep = new Set((await db().select({ id: schema.communityEmoji.uploadId }).from(schema.communityEmoji).where(inArray(schema.communityEmoji.uploadId, ids))).map((r) => r.id));
  const reported = [...await reportedConversationIds()];
  if (reported.length) {
    for (const r of await db().select({ id: schema.messageAttachments.uploadId }).from(schema.messageAttachments)
      .innerJoin(schema.directMessages, eq(schema.directMessages.id, schema.messageAttachments.messageId))
      .where(and(inArray(schema.messageAttachments.uploadId, ids), inArray(schema.directMessages.conversationId, reported)))) keep.add(r.id);
  }
  const gone = ids.filter((id) => !keep.has(id));
  if (!gone.length) return 0;
  const rows = await db().select().from(schema.uploads).where(inArray(schema.uploads.id, gone));
  await db().delete(schema.postAttachments).where(inArray(schema.postAttachments.uploadId, gone));
  await inErasureMode((tx) => tx.delete(schema.messageAttachments).where(inArray(schema.messageAttachments.uploadId, gone)));
  await db().update(schema.userProfiles).set({ avatarUploadId: null }).where(inArray(schema.userProfiles.avatarUploadId, gone));
  await db().update(schema.userProfiles).set({ coverUploadId: null }).where(inArray(schema.userProfiles.coverUploadId, gone));
  await db().delete(schema.uploads).where(inArray(schema.uploads.id, gone));
  for (const r of rows) await storage.remove(r.storageKey).catch((e) => log.warn('upload file removal failed', { key: r.storageKey, error: String(e) }));
  return gone.length;
}

/** Erase the chosen parts of a member's data. The account itself stays. Returns what was removed, for the message. */
export async function eraseUserData(userId: number, parts: Set<ErasePart>, info: { ip: string | null; userAgent?: string | null }) {
  const done: Record<string, number> = {};
  const uid = userId;

  if (parts.has('profile')) {
    await db().update(schema.userProfiles).set({ bio: '', signature: '', pronouns: null, location: null, customTitle: null, links: [], spotifyTrackUrl: null, spotifyPlaylistUrl: null, avatarUploadId: null, coverUploadId: null, backgroundColor: null }).where(eq(schema.userProfiles.userId, uid));
    await db().delete(schema.topFriends).where(eq(schema.topFriends.userId, uid));
    const c = await db().delete(schema.profileComments).where(or(eq(schema.profileComments.authorId, uid), eq(schema.profileComments.profileUserId, uid))).returning({ id: schema.profileComments.id });
    done.profileComments = c.length;
  }

  if (parts.has('posts')) {
    const mine = await db().select({ id: schema.posts.id, threadId: schema.posts.threadId }).from(schema.posts).where(eq(schema.posts.userId, uid));
    const ids = mine.map((p) => p.id);
    if (ids.length) {
      await db().delete(schema.postRevisions).where(inArray(schema.postRevisions.postId, ids));
      await db().delete(schema.postAttachments).where(inArray(schema.postAttachments.postId, ids));
      await db().delete(schema.postReactions).where(inArray(schema.postReactions.postId, ids));
      await db().update(schema.posts).set({ body: '', isDeleted: true, deletedById: uid, deletedReason: 'Removed at the author’s request', ip: null }).where(inArray(schema.posts.id, ids));
    }
    // threads they started with nobody else's posts in them disappear; threads with replies stay for the others
    const started = await db().select({ id: schema.threads.id, forumId: schema.threads.forumId }).from(schema.threads).where(eq(schema.threads.userId, uid));
    for (const t of started) {
      const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.posts).where(and(eq(schema.posts.threadId, t.id), sql`${schema.posts.userId} <> ${uid}`));
      if (n === 0) await db().update(schema.threads).set({ isDeleted: true, deletedById: uid }).where(eq(schema.threads.id, t.id));
    }
    const threadIds = [...new Set([...mine.map((p) => p.threadId), ...started.map((t) => t.id)])];
    const forumIds = new Set<number>(started.map((t) => t.forumId));
    if (threadIds.length) for (const t of await db().select({ forumId: schema.threads.forumId }).from(schema.threads).where(inArray(schema.threads.id, threadIds))) forumIds.add(t.forumId);
    for (const t of threadIds) await recountThread(t);
    for (const f of forumIds) await recountForum(f);
    await recountUser(uid);
    done.posts = ids.length;
  }

  if (parts.has('messages')) {
    const reported = await reportedConversationIds();
    const sent = await db().select({ id: schema.directMessages.id, conv: schema.directMessages.conversationId }).from(schema.directMessages)
      .where(and(eq(schema.directMessages.senderId, uid), sql`${schema.directMessages.body} <> ''`));
    const ids = sent.filter((m) => !reported.has(m.conv)).map((m) => m.id);
    if (ids.length) {
      await inErasureMode(async (tx) => {
        await tx.delete(schema.messageAttachments).where(inArray(schema.messageAttachments.messageId, ids));
        await tx.update(schema.directMessages).set({ body: '', links: [], hiddenAt: new Date(), hiddenReason: 'Deleted by the sender' }).where(inArray(schema.directMessages.id, ids));
      });
    }
    done.messages = ids.length;
    done.messagesKept = sent.length - ids.length;
  }

  if (parts.has('uploads')) {
    const ids = (await db().select({ id: schema.uploads.id }).from(schema.uploads).where(eq(schema.uploads.userId, uid))).map((r) => r.id);
    done.uploads = await removeUploads(ids);
  }

  if (parts.has('activity')) {
    const reacted = await db().delete(schema.postReactions).where(eq(schema.postReactions.userId, uid)).returning({ postId: schema.postReactions.postId });
    done.reactions = reacted.length;
    for (const t of [schema.threadBookmarks, schema.threadSubscriptions, schema.forumSubscriptions, schema.threadReads, schema.forumReads, schema.drafts, schema.notifications, schema.notificationPreferences] as const) {
      await db().delete(t).where(eq((t as any).userId, uid));
    }
    // keep other members' "reactions received" totals honest
    if (reacted.length) await db().execute(sql`update users u set reactions_received = (select count(*) from post_reactions r join posts p on p.id = r.post_id where p.user_id = u.id) where u.id in (select distinct p.user_id from posts p where p.id in (${sql.join(reacted.map((r) => sql`${r.postId}`), sql`, `)}))`);
  }

  if (parts.has('connections')) {
    await db().delete(schema.friendships).where(or(eq(schema.friendships.userLowId, uid), eq(schema.friendships.userHighId, uid)));
    await db().delete(schema.friendRequests).where(or(eq(schema.friendRequests.fromUserId, uid), eq(schema.friendRequests.toUserId, uid)));
    await db().delete(schema.topFriends).where(or(eq(schema.topFriends.userId, uid), eq(schema.topFriends.friendId, uid)));
    await db().delete(schema.userBlocks).where(eq(schema.userBlocks.blockerId, uid));
    await db().delete(schema.userMutes).where(eq(schema.userMutes.muterId, uid));
  }

  if (parts.has('modules')) {
    for (const m of registries.personalData.active()) {
      if (!m.erase) continue;
      try { await m.erase(uid); } catch (e) { log.error('personal data erase failed', { module: m.id, error: String(e) }); throw new ServiceError(`${m.label} couldn’t erase its data. Nothing else was skipped; please try again or ask an administrator.`, 500); }
    }
  }

  await securityEvent(uid, 'data_erased', { ip: info.ip, userAgent: info.userAgent ?? null, detail: { parts: [...parts] } });
  await audit(uid, 'user.erase_data', { type: 'user', id: uid }, { parts: [...parts], ...done }, info.ip);
  return done;
}

// ───────────────────────────── full administrators ─────────────────────────────

async function superAdminGroupIds() {
  return (await db().select({ id: schema.userGroups.id }).from(schema.userGroups).where(eq(schema.userGroups.isSuperAdmin, true))).map((g) => g.id);
}
/** Active (not closed, not banned) members with full administrator access. */
export async function activeSuperAdminIds(): Promise<number[]> {
  const gids = await superAdminGroupIds();
  if (!gids.length) return [];
  const rows = await db().selectDistinct({ id: schema.users.id }).from(schema.users)
    .leftJoin(schema.userGroupMemberships, eq(schema.userGroupMemberships.userId, schema.users.id))
    .where(and(isNull(schema.users.closedAt), or(inArray(schema.userGroupMemberships.groupId, gids), inArray(schema.users.primaryGroupId, gids))));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const now = new Date();
  const banned = new Set((await db().select({ id: schema.userBans.userId }).from(schema.userBans)
    .where(and(inArray(schema.userBans.userId, ids), isNull(schema.userBans.liftedAt), or(isNull(schema.userBans.expiresAt), sql`${schema.userBans.expiresAt} > ${now}`)))).map((r) => r.id));
  return ids.filter((id) => !banned.has(id));
}
/** True when this member is a full administrator and nobody else is. */
export async function isLastSuperAdmin(userId: number) {
  const ids = await activeSuperAdminIds();
  return ids.includes(userId) && ids.length === 1;
}

/** A full administrator hands full access to another member (e.g. before deleting their own account). */
export async function grantSuperAdmin(v: Viewer, username: string) {
  if (!v.user || !v.subject.isSuperAdmin) throw new ServiceError('Only full administrators can do this.', 403);
  const name = username.trim().toLowerCase();
  const [target] = await db().select().from(schema.users).where(eq(schema.users.usernameLower, name));
  if (!target || target.closedAt) throw new ServiceError('There’s no active member with that username.', 404);
  if (target.id === v.user.id) throw new ServiceError('Choose someone other than yourself.');
  const [group] = await db().select().from(schema.userGroups).where(eq(schema.userGroups.isSuperAdmin, true)).orderBy(desc(schema.userGroups.priority)).limit(1);
  if (!group) throw new ServiceError('There’s no administrator group.', 500);
  if ((await activeSuperAdminIds()).includes(target.id)) throw new ServiceError(`${target.username} is already a full administrator.`, 409);
  if (!target.emailVerifiedAt) throw new ServiceError(`${target.username} hasn’t verified their email address yet, so they couldn’t recover the account if needed.`, 409);
  await db().insert(schema.userGroupMemberships).values({ userId: target.id, groupId: group.id }).onConflictDoNothing();
  invalidatePermissionCache();
  await audit(v.user.id, 'user.groups', { type: 'user', id: target.id }, { added: group.slug, reason: 'administrator handover' }, v.ip);
  return target;
}

// ───────────────────────────── delete account ─────────────────────────────

/** Delete (close and anonymise) an account, optionally erasing the member's content first. */
export async function deleteAccount(v: Viewer, opts: { eraseContent: boolean }) {
  const uid = v.user!.id;
  if (await isLastSuperAdmin(uid)) throw new ServiceError('You’re the only full administrator. Make another member a full administrator before deleting your account.', 409, 'last_admin');
  if (opts.eraseContent) await eraseUserData(uid, new Set(ALL_PARTS), { ip: v.ip, userAgent: v.userAgent });
  await db().transaction(async (tx) => {
    await tx.update(schema.users).set({ closedAt: new Date(), email: null, emailLower: null, passwordHash: null, dateOfBirth: null, username: `former-member-${uid}`, usernameLower: `former-member-${uid}` }).where(eq(schema.users.id, uid));
    await tx.update(schema.userProfiles).set({ bio: '', signature: '', pronouns: null, location: null, customTitle: null, links: [], spotifyTrackUrl: null, spotifyPlaylistUrl: null, avatarUploadId: null, coverUploadId: null, backgroundColor: null }).where(eq(schema.userProfiles.userId, uid));
    await tx.delete(schema.externalAccounts).where(eq(schema.externalAccounts.userId, uid));
    await tx.delete(schema.friendships).where(or(eq(schema.friendships.userLowId, uid), eq(schema.friendships.userHighId, uid)));
    await tx.update(schema.userSessions).set({ revokedAt: new Date() }).where(eq(schema.userSessions.userId, uid));
  });
  await emit('user.closed', { userId: uid });
  await securityEvent(uid, 'account_closed', { ip: v.ip, detail: { erasedContent: opts.eraseContent } });
  await audit(uid, 'user.close', { type: 'user', id: uid }, { erasedContent: opts.eraseContent }, v.ip);
}
