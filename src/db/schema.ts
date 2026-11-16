/**
 * Fragged Forums relational schema (PostgreSQL via Drizzle ORM).
 *
 * Conventions
 * - Internal integer IDs; public routes use slugs, usernames or random public IDs.
 * - Timestamps are `timestamptz`.
 * - Counters (post counts etc.) are denormalised and maintained inside transactions.
 * - Direct messages are append-only: a DB trigger (see migration 0001_custom) rejects
 *   UPDATE of content columns and all DELETEs on `direct_messages`.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, serial, integer, bigserial, bigint, text, varchar, boolean, timestamp, jsonb,
  primaryKey, uniqueIndex, index, date, customType,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();

// ───────────────────────────── Identity & access ─────────────────────────────

export const userGroups = pgTable('user_groups', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 60 }).notNull(),
  /** Display colour for usernames (validated hex) */
  color: varchar('color', { length: 9 }),
  /** Default user title for members of this group */
  userTitle: varchar('user_title', { length: 60 }),
  /** Map of permission key -> true */
  permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
  isStaff: boolean('is_staff').notNull().default(false),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  /** Higher priority group decides username colour / title */
  priority: integer('priority').notNull().default(0),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 32 }).notNull(),
  usernameLower: varchar('username_lower', { length: 32 }).notNull(),
  email: varchar('email', { length: 254 }),
  emailLower: varchar('email_lower', { length: 254 }),
  emailVerifiedAt: ts('email_verified_at'),
  passwordHash: text('password_hash'),
  primaryGroupId: integer('primary_group_id').notNull().references(() => userGroups.id),
  dateOfBirth: date('date_of_birth'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  postCount: integer('post_count').notNull().default(0),
  threadCount: integer('thread_count').notNull().default(0),
  reactionsReceived: integer('reactions_received').notNull().default(0),
  usernameChangedAt: ts('username_changed_at'),
  lastSeenAt: ts('last_seen_at'),
  termsAcceptedAt: ts('terms_accepted_at'),
  /** Closed accounts are anonymised; content is retained under "Former member" */
  closedAt: ts('closed_at'),
  createdAt: created(),
}, (t) => [
  uniqueIndex('users_username_lower_uq').on(t.usernameLower),
  uniqueIndex('users_email_lower_uq').on(t.emailLower),
  index('users_username_pattern_idx').using('btree', sql`${t.usernameLower} text_pattern_ops`),
]);

export const userGroupMemberships = pgTable('user_group_memberships', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').notNull().references(() => userGroups.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.userId, t.groupId] })]);

export const userProfiles = pgTable('user_profiles', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  avatarUploadId: integer('avatar_upload_id'),
  coverUploadId: integer('cover_upload_id'),
  coverPositionY: integer('cover_position_y').notNull().default(50),
  bio: text('bio').notNull().default(''),
  pronouns: varchar('pronouns', { length: 40 }),
  location: varchar('location', { length: 80 }),
  customTitle: varchar('custom_title', { length: 60 }),
  signature: text('signature').notNull().default(''),
  links: jsonb('links').$type<{ label: string; url: string }[]>().notNull().default([]),
  /** @deprecated moved to the profile-spotify module (mod_profile_spotify); kept for data migration */
  spotifyTrackUrl: text('spotify_track_url'),
  spotifyPlaylistUrl: text('spotify_playlist_url'),
  showSpotify: boolean('show_spotify').notNull().default(true),
  /** Validated #rrggbb or null for theme default */
  backgroundColor: varchar('background_color', { length: 7 }),
  topFriendsCount: integer('top_friends_count').notNull().default(0),
  showAchievements: boolean('show_achievements').notNull().default(true),
  showRecentActivity: boolean('show_recent_activity').notNull().default(true),
  /** who can see the profile body: everyone | members | friends */
  visibility: varchar('visibility', { length: 16 }).notNull().default('everyone'),
});

export const userSettings = pgTable('user_settings', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  theme: varchar('theme', { length: 24 }).notNull().default('classic'),
  profanityFilter: boolean('profanity_filter').notNull().default(true),
  showPresence: boolean('show_presence').notNull().default(true),
  discoverable: boolean('discoverable').notNull().default(true),
  /** everyone | friends | nobody */
  dmPolicy: varchar('dm_policy', { length: 16 }).notNull().default('everyone'),
  /** show | blur | hide */
  nsfwMode: varchar('nsfw_mode', { length: 8 }).notNull().default('blur'),
  triggerMode: varchar('trigger_mode', { length: 8 }).notNull().default('blur'),
  emailNotifications: boolean('email_notifications').notNull().default(false),
  friendsPaneCollapsed: boolean('friends_pane_collapsed').notNull().default(false),
  showSignatures: boolean('show_signatures').notNull().default(true),
  postsPerPage: integer('posts_per_page').notNull().default(20),
});

export const userSessions = pgTable('user_sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  remember: boolean('remember').notNull().default(false),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 300 }),
  /** Last time the user re-entered credentials; gates sensitive operations */
  reauthAt: ts('reauth_at'),
  createdAt: created(),
  lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
}, (t) => [index('user_sessions_user_idx').on(t.userId)]);

/** Verification, password reset and email-change tokens (hashed at rest). */
export const emailTokens = pgTable('email_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(), // verify | reset | email_change
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  newEmail: varchar('new_email', { length: 254 }),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

/** Security + authentication event log (logins, failures, linking, password changes). */
export const securityEvents = pgTable('security_events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: varchar('kind', { length: 40 }).notNull(),
  provider: varchar('provider', { length: 24 }),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 300 }),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: created(),
}, (t) => [index('security_events_user_idx').on(t.userId, t.createdAt), index('security_events_kind_idx').on(t.kind, t.createdAt)]);

/** Linked third-party identities. (provider, provider_subject) is the authoritative key. */
export const externalAccounts = pgTable('external_accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 24 }).notNull(),
  providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
  providerEmail: varchar('provider_email', { length: 254 }),
  providerEmailVerified: boolean('provider_email_verified').notNull().default(false),
  providerDisplayName: varchar('provider_display_name', { length: 120 }),
  /** Encrypted refresh token, only when a provider needs it (currently unused) */
  tokenMeta: jsonb('token_meta').$type<Record<string, unknown>>(),
  connectedAt: created(),
  lastAuthAt: ts('last_auth_at'),
}, (t) => [
  uniqueIndex('external_accounts_provider_subject_uq').on(t.provider, t.providerSubject),
  uniqueIndex('external_accounts_user_provider_uq').on(t.userId, t.provider),
]);

/** A verified external identity awaiting Fragged username selection. */
export const pendingRegistrations = pgTable('pending_registrations', {
  id: serial('id').primaryKey(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  provider: varchar('provider', { length: 24 }).notNull(),
  providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
  providerEmail: varchar('provider_email', { length: 254 }),
  providerEmailVerified: boolean('provider_email_verified').notNull().default(false),
  providerDisplayName: varchar('provider_display_name', { length: 120 }),
  returnTo: text('return_to'),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
});

/** Forum-scoped permission overrides for a group or a single user. */
export const permissionOverrides = pgTable('permission_overrides', {
  id: serial('id').primaryKey(),
  forumId: integer('forum_id').references(() => forums.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').references(() => userGroups.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** permission -> 'allow' | 'deny' */
  permissions: jsonb('permissions').$type<Record<string, 'allow' | 'deny'>>().notNull().default({}),
}, (t) => [index('permission_overrides_forum_idx').on(t.forumId)]);

// ─────────────────────────────────── Forum ───────────────────────────────────

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  description: text('description').notNull().default(''),
  displayOrder: integer('display_order').notNull().default(0),
  isHidden: boolean('is_hidden').notNull().default(false),
});

export const forums = pgTable('forums', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull().references(() => categories.id),
  parentForumId: integer('parent_forum_id'),
  name: varchar('name', { length: 80 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  description: text('description').notNull().default(''),
  /** Short notice shown above thread list / editor */
  rulesNotice: text('rules_notice').notNull().default(''),
  icon: varchar('icon', { length: 40 }),
  displayOrder: integer('display_order').notNull().default(0),
  isHidden: boolean('is_hidden').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  allowUserTags: boolean('allow_user_tags').notNull().default(true),
  threadCount: integer('thread_count').notNull().default(0),
  postCount: integer('post_count').notNull().default(0),
  lastThreadId: integer('last_thread_id'),
  lastPostId: integer('last_post_id'),
  lastPostAt: ts('last_post_at'),
  lastPostUserId: integer('last_post_user_id'),
}, (t) => [index('forums_category_idx').on(t.categoryId, t.displayOrder)]);

export const forumModerators = pgTable('forum_moderators', {
  forumId: integer('forum_id').notNull().references(() => forums.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.forumId, t.userId] })]);

export const threads = pgTable('threads', {
  id: serial('id').primaryKey(),
  forumId: integer('forum_id').notNull().references(() => forums.id),
  userId: integer('user_id').notNull().references(() => users.id),
  title: varchar('title', { length: 140 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull(),
  isSticky: boolean('is_sticky').notNull().default(false),
  isAnnouncement: boolean('is_announcement').notNull().default(false),
  isLocked: boolean('is_locked').notNull().default(false),
  isDeleted: boolean('is_deleted').notNull().default(false),
  /** visible | held (opening post awaiting moderation) */
  state: varchar('state', { length: 12 }).notNull().default('visible'),
  deletedById: integer('deleted_by_id'),
  /** set when this thread was merged into another */
  movedToThreadId: integer('moved_to_thread_id'),
  firstPostId: integer('first_post_id'),
  replyCount: integer('reply_count').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  /** highest post position used (post numbers are stable) */
  lastPosition: integer('last_position').notNull().default(0),
  lastPostId: integer('last_post_id'),
  lastPostAt: ts('last_post_at').notNull().defaultNow(),
  lastPostUserId: integer('last_post_user_id'),
  createdAt: created(),
  search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('english', coalesce(title, ''))`),
}, (t) => [
  index('threads_forum_list_idx').on(t.forumId, t.isDeleted, t.lastPostAt),
  index('threads_user_idx').on(t.userId),
  index('threads_search_idx').using('gin', t.search),
]);

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  threadId: integer('thread_id').notNull().references(() => threads.id),
  userId: integer('user_id').notNull().references(() => users.id),
  /** Post number within the thread (1 = opening post); stable */
  position: integer('position').notNull(),
  /** Original BBCode source; rendering applies filters at display time */
  body: text('body').notNull(),
  /** visible | held (awaiting moderation) */
  state: varchar('state', { length: 12 }).notNull().default('visible'),
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedById: integer('deleted_by_id'),
  deletedReason: text('deleted_reason'),
  editCount: integer('edit_count').notNull().default(0),
  editedAt: ts('edited_at'),
  editedById: integer('edited_by_id'),
  ip: varchar('ip', { length: 64 }),
  createdAt: created(),
  search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('english', coalesce(body, ''))`),
}, (t) => [
  index('posts_thread_pos_idx').on(t.threadId, t.position),
  index('posts_user_idx').on(t.userId, t.createdAt),
  index('posts_search_idx').using('gin', t.search),
]);

export const postRevisions = pgTable('post_revisions', {
  id: serial('id').primaryKey(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  editedById: integer('edited_by_id').notNull(),
  createdAt: created(),
}, (t) => [index('post_revisions_post_idx').on(t.postId)]);

export const postReactions = pgTable('post_reactions', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reaction: varchar('reaction', { length: 24 }).notNull(),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.postId, t.userId, t.reaction] })]);

export const tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 32 }).notNull(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  /** topic | warning (spoiler / nsfw / trigger warning / admin-defined) */
  kind: varchar('kind', { length: 12 }).notNull().default('topic'),
  /** official tags are admin-defined; others are member-created */
  isOfficial: boolean('is_official').notNull().default(false),
  /** disabled tags cannot be applied and are hidden */
  isDisabled: boolean('is_disabled').notNull().default(false),
  color: varchar('color', { length: 7 }),
  description: text('description').notNull().default(''),
  createdById: integer('created_by_id'),
  createdAt: created(),
});

export const threadTags = pgTable('thread_tags', {
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  tagId: integer('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.threadId, t.tagId] }), index('thread_tags_tag_idx').on(t.tagId)]);

export const threadSubscriptions = pgTable('thread_subscriptions', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.userId, t.threadId] }), index('thread_subscriptions_thread_idx').on(t.threadId)]);

export const forumSubscriptions = pgTable('forum_subscriptions', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  forumId: integer('forum_id').notNull().references(() => forums.id, { onDelete: 'cascade' }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.userId, t.forumId] })]);

export const threadBookmarks = pgTable('thread_bookmarks', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.userId, t.threadId] })]);

/** Per-user read marker for unread indicators. */
export const threadReads = pgTable('thread_reads', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  lastReadPosition: integer('last_read_position').notNull().default(0),
  readAt: ts('read_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.threadId] })]);

/** "Mark forum read": threads with last_post_at <= marked_at count as read. */
export const forumReads = pgTable('forum_reads', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  forumId: integer('forum_id').notNull().references(() => forums.id, { onDelete: 'cascade' }),
  markedAt: ts('marked_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.forumId] })]);

export const drafts = pgTable('drafts', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** e.g. thread:12 (new thread in forum 12) or reply:345 */
  key: varchar('key', { length: 40 }).notNull(),
  title: varchar('title', { length: 140 }),
  body: text('body').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

// ──────────────────────────────── Uploads ────────────────────────────────

/** Metadata for every validated, re-encoded image stored by Fragged. */
export const uploads = pgTable('uploads', {
  id: serial('id').primaryKey(),
  publicId: varchar('public_id', { length: 32 }).notNull().unique(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** avatar | cover | post | message | emoji */
  purpose: varchar('purpose', { length: 12 }).notNull(),
  storageKey: text('storage_key').notNull(),
  mime: varchar('mime', { length: 40 }).notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),
  animated: boolean('animated').notNull().default(false),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  originalName: varchar('original_name', { length: 200 }),
  createdAt: created(),
}, (t) => [index('uploads_user_idx').on(t.userId), index('uploads_sha_idx').on(t.sha256)]);

export const postAttachments = pgTable('post_attachments', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  uploadId: integer('upload_id').notNull().references(() => uploads.id),
}, (t) => [primaryKey({ columns: [t.postId, t.uploadId] })]);

// ─────────────────────────────── Community ───────────────────────────────

export const friendRequests = pgTable('friend_requests', {
  id: serial('id').primaryKey(),
  fromUserId: integer('from_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toUserId: integer('to_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** pending | accepted | declined | cancelled */
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  createdAt: created(),
  respondedAt: ts('responded_at'),
}, (t) => [
  // at most one pending request per ordered pair
  uniqueIndex('friend_requests_pending_uq').on(t.fromUserId, t.toUserId).where(sql`status = 'pending'`),
  index('friend_requests_to_idx').on(t.toUserId, t.status),
]);

/** Accepted friendship; stored once with user_low_id < user_high_id. */
export const friendships = pgTable('friendships', {
  userLowId: integer('user_low_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userHighId: integer('user_high_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.userLowId, t.userHighId] }), index('friendships_high_idx').on(t.userHighId)]);

export const userBlocks = pgTable('user_blocks', {
  blockerId: integer('blocker_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedId: integer('blocked_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('user_blocks_blocked_idx').on(t.blockedId)]);

export const userMutes = pgTable('user_mutes', {
  muterId: integer('muter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mutedId: integer('muted_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** also collapse their forum content for the muter */
  hideContent: boolean('hide_content').notNull().default(false),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.muterId, t.mutedId] })]);

export const profileComments = pgTable('profile_comments', {
  id: serial('id').primaryKey(),
  profileUserId: integer('profile_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  state: varchar('state', { length: 12 }).notNull().default('visible'),
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedById: integer('deleted_by_id'),
  createdAt: created(),
}, (t) => [index('profile_comments_profile_idx').on(t.profileUserId, t.createdAt)]);

export const topFriends = pgTable('top_friends', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId: integer('friend_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.position] }), uniqueIndex('top_friends_pair_uq').on(t.userId, t.friendId)]);

/**
 * Owned by the achievements module since SDK 1.0 (see modules/achievements). Kept here only because core
 * migration 0000 created it: removing it would make the next generated core migration drop the table.
 */
export const achievementDefinitions = pgTable('achievement_definitions', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 48 }).notNull().unique(),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description').notNull().default(''),
  /** threads | posts | reactions | community | account | contribution */
  category: varchar('category', { length: 24 }).notNull(),
  /** Built-in glyph name rendered from the local icon set */
  icon: varchar('icon', { length: 24 }).notNull().default('medal'),
  /** common | uncommon | rare | epic | legendary */
  rarity: varchar('rarity', { length: 12 }).notNull().default('common'),
  /** { metric: 'posts'|'threads'|'reactions_received'|'friends'|'account_days'|'profile_comments_received', threshold: n } or { manual: true } */
  criteria: jsonb('criteria').$type<{ metric?: string; threshold?: number; manual?: boolean }>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
});

export const userAchievements = pgTable('user_achievements', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  achievementId: integer('achievement_id').notNull().references(() => achievementDefinitions.id, { onDelete: 'cascade' }),
  awardedAt: created(),
  awardedById: integer('awarded_by_id'),
  revokedAt: ts('revoked_at'),
  revokedById: integer('revoked_by_id'),
  revokeReason: text('revoke_reason'),
}, (t) => [uniqueIndex('user_achievements_uq').on(t.userId, t.achievementId)]);

/** Custom emoji (staff-made or community-submitted). Only `approved` appear in the picker. */
export const communityEmoji = pgTable('community_emoji', {
  id: serial('id').primaryKey(),
  shortcode: varchar('shortcode', { length: 32 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  description: text('description').notNull().default(''),
  category: varchar('category', { length: 32 }).notNull().default('community'),
  keywords: text('keywords').notNull().default(''),
  uploadId: integer('upload_id').notNull().references(() => uploads.id),
  animated: boolean('animated').notNull().default(false),
  /** pending | approved | rejected | disabled */
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  submittedById: integer('submitted_by_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedById: integer('reviewed_by_id'),
  reviewedAt: ts('reviewed_at'),
  rejectionReason: text('rejection_reason'),
  usageCount: integer('usage_count').notNull().default(0),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  createdAt: created(),
}, (t) => [
  uniqueIndex('community_emoji_shortcode_live_uq').on(t.shortcode).where(sql`status in ('pending','approved')`),
  index('community_emoji_status_idx').on(t.status),
]);

// ─────────────────────────────── Messaging ───────────────────────────────

/** One-to-one conversation; the participant pair is unique (user_low_id < user_high_id). */
export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  publicId: varchar('public_id', { length: 24 }).notNull().unique(),
  userLowId: integer('user_low_id').notNull().references(() => users.id),
  userHighId: integer('user_high_id').notNull().references(() => users.id),
  lastMessageId: bigint('last_message_id', { mode: 'number' }),
  lastMessageAt: ts('last_message_at'),
  createdAt: created(),
}, (t) => [uniqueIndex('conversations_pair_uq').on(t.userLowId, t.userHighId)]);

/** Per-participant state: read marker (MessageReadState) and mute (ConversationMute). */
export const conversationParticipants = pgTable('conversation_participants', {
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  userId: integer('user_id').notNull().references(() => users.id),
  lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }).notNull().default(0),
  mutedAt: ts('muted_at'),
  joinedAt: created(),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] }), index('conversation_participants_user_idx').on(t.userId)]);

/**
 * Append-only for ordinary users. Enforced by trigger `direct_messages_append_only`.
 * Exceptional, audited staff handling may only set `hidden_*` columns; body is never rewritten.
 */
export const directMessages = pgTable('direct_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  senderId: integer('sender_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  /** client-generated idempotency key */
  clientNonce: varchar('client_nonce', { length: 64 }).notNull(),
  /** external links detected in the message (stored as references, never fetched) */
  links: jsonb('links').$type<string[]>().notNull().default([]),
  createdAt: created(),
  hiddenAt: ts('hidden_at'),
  hiddenById: integer('hidden_by_id'),
  hiddenReason: text('hidden_reason'),
}, (t) => [
  index('direct_messages_conv_idx').on(t.conversationId, t.id),
  uniqueIndex('direct_messages_nonce_uq').on(t.senderId, t.clientNonce),
]);

export const messageAttachments = pgTable('message_attachments', {
  messageId: bigint('message_id', { mode: 'number' }).notNull().references(() => directMessages.id),
  uploadId: integer('upload_id').notNull().references(() => uploads.id),
}, (t) => [primaryKey({ columns: [t.messageId, t.uploadId] })]);

// ─────────────────────── Notifications & moderation ───────────────────────

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** friend_request | friend_accept | message | reply | mention | quote | profile_comment | achievement | moderation | security */
  kind: varchar('kind', { length: 24 }).notNull(),
  actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
  /** Plain-text, spoiler-free summary */
  text: text('text').notNull(),
  url: text('url').notNull(),
  createdAt: created(),
  readAt: ts('read_at'),
}, (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 24 }).notNull(),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.userId, t.kind] })]);

export const reports = pgTable('reports', {
  id: serial('id').primaryKey(),
  reporterId: integer('reporter_id').references(() => users.id, { onDelete: 'set null' }),
  /** post | thread | profile_comment | user | message | emoji */
  targetType: varchar('target_type', { length: 20 }).notNull(),
  targetId: integer('target_id').notNull(),
  reason: varchar('reason', { length: 40 }).notNull(),
  details: text('details').notNull().default(''),
  /** open | resolved | dismissed */
  status: varchar('status', { length: 12 }).notNull().default('open'),
  handledById: integer('handled_by_id'),
  handledAt: ts('handled_at'),
  resolutionNote: text('resolution_note'),
  createdAt: created(),
}, (t) => [index('reports_status_idx').on(t.status, t.createdAt)]);

export const userWarnings = pgTable('user_warnings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuedById: integer('issued_by_id').notNull(),
  reason: text('reason').notNull(),
  points: integer('points').notNull().default(1),
  createdAt: created(),
  expiresAt: ts('expires_at'),
});

/** Suspensions (expires_at set) and bans (expires_at null). */
export const userBans = pgTable('user_bans', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuedById: integer('issued_by_id').notNull(),
  kind: varchar('kind', { length: 12 }).notNull(), // suspension | ban
  reason: text('reason').notNull(),
  createdAt: created(),
  expiresAt: ts('expires_at'),
  liftedAt: ts('lifted_at'),
  liftedById: integer('lifted_by_id'),
}, (t) => [index('user_bans_user_idx').on(t.userId)]);

export const moderatorNotes = pgTable('moderator_notes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull(),
  note: text('note').notNull(),
  createdAt: created(),
});

export const restrictedTerms = pgTable('restricted_terms', {
  id: serial('id').primaryKey(),
  pattern: text('pattern').notNull(),
  /** word | phrase | regex */
  matchType: varchar('match_type', { length: 8 }).notNull().default('word'),
  category: varchar('category', { length: 32 }).notNull().default('slur'),
  /** block | hold | flag | redact */
  action: varchar('action', { length: 8 }).notNull().default('block'),
  isActive: boolean('is_active').notNull().default(false),
  notes: text('notes').notNull().default(''),
  createdById: integer('created_by_id'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const restrictedTermMatches = pgTable('restricted_term_matches', {
  id: serial('id').primaryKey(),
  termId: integer('term_id').references(() => restrictedTerms.id, { onDelete: 'set null' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  contentType: varchar('content_type', { length: 20 }).notNull(),
  contentId: integer('content_id'),
  action: varchar('action', { length: 8 }).notNull(),
  excerpt: text('excerpt').notNull(),
  /** pending | upheld | false_positive */
  reviewStatus: varchar('review_status', { length: 16 }).notNull().default('pending'),
  reviewedById: integer('reviewed_by_id'),
  reviewedAt: ts('reviewed_at'),
  createdAt: created(),
}, (t) => [index('restricted_term_matches_status_idx').on(t.reviewStatus, t.createdAt)]);

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 48 }).notNull(),
  targetType: varchar('target_type', { length: 24 }),
  targetId: integer('target_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  ip: varchar('ip', { length: 64 }),
  createdAt: created(),
}, (t) => [
  index('audit_log_created_idx').on(t.createdAt), index('audit_log_target_idx').on(t.targetType, t.targetId),
  index('audit_log_actor_idx').on(t.actorId, t.createdAt), index('audit_log_action_idx').on(t.action, t.createdAt),
]);

// ─────────────────────────────── Platform ───────────────────────────────

export const staticPages = pgTable('static_pages', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 48 }).notNull().unique(),
  title: varchar('title', { length: 120 }).notNull(),
  body: text('body').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedById: integer('updated_by_id'),
});

export const rules = pgTable('rules', {
  id: serial('id').primaryKey(),
  section: varchar('section', { length: 80 }).notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  body: text('body').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
});

export const siteSettings = pgTable('site_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Minimal durable job queue for email and other async work. */
export const jobs = pgTable('jobs', {
  id: serial('id').primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  runAt: ts('run_at').notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  lockedAt: ts('locked_at'),
  doneAt: ts('done_at'),
  createdAt: created(),
}, (t) => [index('jobs_pending_idx').on(t.doneAt, t.runAt)]);

/** Shared rate-limit / de-duplication counters (fixed windows), used when running on a PostgreSQL server. */
export const rateLimitCounters = pgTable('rate_limit_counters', {
  key: varchar('key', { length: 200 }).notNull(),
  windowStart: ts('window_start').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limit_counters_window_idx').on(t.windowStart)]);

// ─────────────────────────────── Modules ───────────────────────────────

/** Installed-module state: enabled flag, validated settings, version seen (for onInstall / onUpgrade). */
export const moduleState = pgTable('module_state', {
  id: varchar('id', { length: 64 }).primaryKey(),
  version: varchar('version', { length: 32 }).notNull(),
  enabled: boolean('enabled').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  installedAt: ts('installed_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** SQL migrations applied per module (each module ships its own `migrations/*.sql`). */
export const moduleMigrations = pgTable('module_migrations', {
  moduleId: varchar('module_id', { length: 64 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  appliedAt: ts('applied_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.moduleId, t.name] })]);
