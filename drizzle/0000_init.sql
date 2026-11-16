CREATE TABLE "achievement_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(48) NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" varchar(24) NOT NULL,
	"icon" varchar(24) DEFAULT 'medal' NOT NULL,
	"rarity" varchar(12) DEFAULT 'common' NOT NULL,
	"criteria" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "achievement_definitions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_id" integer,
	"action" varchar(48) NOT NULL,
	"target_type" varchar(24),
	"target_id" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_emoji" (
	"id" serial PRIMARY KEY NOT NULL,
	"shortcode" varchar(32) NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" varchar(32) DEFAULT 'community' NOT NULL,
	"keywords" text DEFAULT '' NOT NULL,
	"upload_id" integer NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"submitted_by_id" integer,
	"reviewed_by_id" integer,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"last_read_message_id" bigint DEFAULT 0 NOT NULL,
	"muted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" varchar(24) NOT NULL,
	"user_low_id" integer NOT NULL,
	"user_high_id" integer NOT NULL,
	"last_message_id" bigint,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"body" text NOT NULL,
	"client_nonce" varchar(64) NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by_id" integer,
	"hidden_reason" text
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"user_id" integer NOT NULL,
	"key" varchar(40) NOT NULL,
	"title" varchar(140),
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"new_email" varchar(254),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "email_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "external_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"provider_email" varchar(254),
	"provider_email_verified" boolean DEFAULT false NOT NULL,
	"provider_display_name" varchar(120),
	"token_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_auth_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "forum_moderators" (
	"forum_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "forum_moderators_forum_id_user_id_pk" PRIMARY KEY("forum_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "forum_reads" (
	"user_id" integer NOT NULL,
	"forum_id" integer NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_reads_user_id_forum_id_pk" PRIMARY KEY("user_id","forum_id")
);
--> statement-breakpoint
CREATE TABLE "forum_subscriptions" (
	"user_id" integer NOT NULL,
	"forum_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_subscriptions_user_id_forum_id_pk" PRIMARY KEY("user_id","forum_id")
);
--> statement-breakpoint
CREATE TABLE "forums" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"parent_forum_id" integer,
	"name" varchar(80) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules_notice" text DEFAULT '' NOT NULL,
	"icon" varchar(40),
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"allow_user_tags" boolean DEFAULT true NOT NULL,
	"thread_count" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"last_thread_id" integer,
	"last_post_id" integer,
	"last_post_at" timestamp with time zone,
	"last_post_user_id" integer,
	CONSTRAINT "forums_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_user_id" integer NOT NULL,
	"to_user_id" integer NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"user_low_id" integer NOT NULL,
	"user_high_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_user_low_id_user_high_id_pk" PRIMARY KEY("user_low_id","user_high_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"message_id" bigint NOT NULL,
	"upload_id" integer NOT NULL,
	CONSTRAINT "message_attachments_message_id_upload_id_pk" PRIMARY KEY("message_id","upload_id")
);
--> statement-breakpoint
CREATE TABLE "moderator_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notification_preferences_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"actor_id" integer,
	"text" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_registrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"provider_email" varchar(254),
	"provider_email_verified" boolean DEFAULT false NOT NULL,
	"provider_display_name" varchar(120),
	"return_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_registrations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "permission_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"forum_id" integer,
	"group_id" integer,
	"user_id" integer,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_attachments" (
	"post_id" integer NOT NULL,
	"upload_id" integer NOT NULL,
	CONSTRAINT "post_attachments_post_id_upload_id_pk" PRIMARY KEY("post_id","upload_id")
);
--> statement-breakpoint
CREATE TABLE "post_reactions" (
	"post_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"reaction" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_reactions_post_id_user_id_reaction_pk" PRIMARY KEY("post_id","user_id","reaction")
);
--> statement-breakpoint
CREATE TABLE "post_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"body" text NOT NULL,
	"edited_by_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"position" integer NOT NULL,
	"body" text NOT NULL,
	"state" varchar(12) DEFAULT 'visible' NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_by_id" integer,
	"deleted_reason" text,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"edited_at" timestamp with time zone,
	"edited_by_id" integer,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "profile_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_user_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"body" text NOT NULL,
	"state" varchar(12) DEFAULT 'visible' NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reporter_id" integer,
	"target_type" varchar(20) NOT NULL,
	"target_id" integer NOT NULL,
	"reason" varchar(40) NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"handled_by_id" integer,
	"handled_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restricted_term_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"term_id" integer,
	"user_id" integer,
	"content_type" varchar(20) NOT NULL,
	"content_id" integer,
	"action" varchar(8) NOT NULL,
	"excerpt" text NOT NULL,
	"review_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restricted_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"match_type" varchar(8) DEFAULT 'word' NOT NULL,
	"category" varchar(32) DEFAULT 'slur' NOT NULL,
	"action" varchar(8) DEFAULT 'block' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"section" varchar(80) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"kind" varchar(40) NOT NULL,
	"provider" varchar(24),
	"ip" varchar(64),
	"user_agent" varchar(300),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "static_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(48) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" integer,
	CONSTRAINT "static_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"slug" varchar(40) NOT NULL,
	"kind" varchar(12) DEFAULT 'topic' NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"color" varchar(7),
	"description" text DEFAULT '' NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "thread_bookmarks" (
	"user_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_bookmarks_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "thread_reads" (
	"user_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"last_read_position" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_reads_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "thread_subscriptions" (
	"user_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_subscriptions_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "thread_tags" (
	"thread_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "thread_tags_thread_id_tag_id_pk" PRIMARY KEY("thread_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"forum_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"title" varchar(140) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"is_sticky" boolean DEFAULT false NOT NULL,
	"is_announcement" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"state" varchar(12) DEFAULT 'visible' NOT NULL,
	"deleted_by_id" integer,
	"moved_to_thread_id" integer,
	"first_post_id" integer,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_position" integer DEFAULT 0 NOT NULL,
	"last_post_id" integer,
	"last_post_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_post_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "top_friends" (
	"user_id" integer NOT NULL,
	"friend_id" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "top_friends_user_id_position_pk" PRIMARY KEY("user_id","position")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" varchar(32) NOT NULL,
	"user_id" integer,
	"purpose" varchar(12) NOT NULL,
	"storage_key" text NOT NULL,
	"mime" varchar(40) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"original_name" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"achievement_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_by_id" integer,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" integer,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "user_bans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"issued_by_id" integer NOT NULL,
	"kind" varchar(12) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by_id" integer
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"blocker_id" integer NOT NULL,
	"blocked_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "user_group_memberships" (
	"user_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	CONSTRAINT "user_group_memberships_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(40) NOT NULL,
	"name" varchar(60) NOT NULL,
	"color" varchar(9),
	"user_title" varchar(60),
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_staff" boolean DEFAULT false NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_mutes" (
	"muter_id" integer NOT NULL,
	"muted_id" integer NOT NULL,
	"hide_content" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mutes_muter_id_muted_id_pk" PRIMARY KEY("muter_id","muted_id")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"avatar_upload_id" integer,
	"cover_upload_id" integer,
	"cover_position_y" integer DEFAULT 50 NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"pronouns" varchar(40),
	"location" varchar(80),
	"custom_title" varchar(60),
	"signature" text DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spotify_track_url" text,
	"spotify_playlist_url" text,
	"show_spotify" boolean DEFAULT true NOT NULL,
	"background_color" varchar(7),
	"top_friends_count" integer DEFAULT 0 NOT NULL,
	"show_achievements" boolean DEFAULT true NOT NULL,
	"show_recent_activity" boolean DEFAULT true NOT NULL,
	"visibility" varchar(16) DEFAULT 'everyone' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"remember" boolean DEFAULT false NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(300),
	"reauth_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"theme" varchar(24) DEFAULT 'classic' NOT NULL,
	"profanity_filter" boolean DEFAULT true NOT NULL,
	"show_presence" boolean DEFAULT true NOT NULL,
	"discoverable" boolean DEFAULT true NOT NULL,
	"dm_policy" varchar(16) DEFAULT 'everyone' NOT NULL,
	"nsfw_mode" varchar(8) DEFAULT 'blur' NOT NULL,
	"trigger_mode" varchar(8) DEFAULT 'blur' NOT NULL,
	"email_notifications" boolean DEFAULT false NOT NULL,
	"friends_pane_collapsed" boolean DEFAULT false NOT NULL,
	"show_signatures" boolean DEFAULT true NOT NULL,
	"posts_per_page" integer DEFAULT 20 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_warnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"issued_by_id" integer NOT NULL,
	"reason" text NOT NULL,
	"points" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(32) NOT NULL,
	"username_lower" varchar(32) NOT NULL,
	"email" varchar(254),
	"email_lower" varchar(254),
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"primary_group_id" integer NOT NULL,
	"date_of_birth" date,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"thread_count" integer DEFAULT 0 NOT NULL,
	"reactions_received" integer DEFAULT 0 NOT NULL,
	"username_changed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"terms_accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_emoji" ADD CONSTRAINT "community_emoji_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_emoji" ADD CONSTRAINT "community_emoji_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_low_id_users_id_fk" FOREIGN KEY ("user_low_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_high_id_users_id_fk" FOREIGN KEY ("user_high_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_moderators" ADD CONSTRAINT "forum_moderators_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_moderators" ADD CONSTRAINT "forum_moderators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_reads" ADD CONSTRAINT "forum_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_reads" ADD CONSTRAINT "forum_reads_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_subscriptions" ADD CONSTRAINT "forum_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_subscriptions" ADD CONSTRAINT "forum_subscriptions_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_low_id_users_id_fk" FOREIGN KEY ("user_low_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_high_id_users_id_fk" FOREIGN KEY ("user_high_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_direct_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."direct_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderator_notes" ADD CONSTRAINT "moderator_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_reactions" ADD CONSTRAINT "post_reactions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_reactions" ADD CONSTRAINT "post_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_comments" ADD CONSTRAINT "profile_comments_profile_user_id_users_id_fk" FOREIGN KEY ("profile_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_comments" ADD CONSTRAINT "profile_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_term_matches" ADD CONSTRAINT "restricted_term_matches_term_id_restricted_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."restricted_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_term_matches" ADD CONSTRAINT "restricted_term_matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_bookmarks" ADD CONSTRAINT "thread_bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_bookmarks" ADD CONSTRAINT "thread_bookmarks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_subscriptions" ADD CONSTRAINT "thread_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_subscriptions" ADD CONSTRAINT "thread_subscriptions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_friends" ADD CONSTRAINT "top_friends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_friends" ADD CONSTRAINT "top_friends_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_achievement_definitions_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievement_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_memberships" ADD CONSTRAINT "user_group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_memberships" ADD CONSTRAINT "user_group_memberships_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_muter_id_users_id_fk" FOREIGN KEY ("muter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_muted_id_users_id_fk" FOREIGN KEY ("muted_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warnings" ADD CONSTRAINT "user_warnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_group_id_user_groups_id_fk" FOREIGN KEY ("primary_group_id") REFERENCES "public"."user_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_emoji_shortcode_live_uq" ON "community_emoji" USING btree ("shortcode") WHERE status in ('pending','approved');--> statement-breakpoint
CREATE INDEX "community_emoji_status_idx" ON "community_emoji" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversation_participants_user_idx" ON "conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_pair_uq" ON "conversations" USING btree ("user_low_id","user_high_id");--> statement-breakpoint
CREATE INDEX "direct_messages_conv_idx" ON "direct_messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_messages_nonce_uq" ON "direct_messages" USING btree ("sender_id","client_nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_provider_subject_uq" ON "external_accounts" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_user_provider_uq" ON "external_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "forums_category_idx" ON "forums" USING btree ("category_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_requests_pending_uq" ON "friend_requests" USING btree ("from_user_id","to_user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "friend_requests_to_idx" ON "friend_requests" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "friendships_high_idx" ON "friendships" USING btree ("user_high_id");--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("done_at","run_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "permission_overrides_forum_idx" ON "permission_overrides" USING btree ("forum_id");--> statement-breakpoint
CREATE INDEX "post_revisions_post_idx" ON "post_revisions" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "posts_thread_pos_idx" ON "posts" USING btree ("thread_id","position");--> statement-breakpoint
CREATE INDEX "posts_user_idx" ON "posts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_search_idx" ON "posts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "profile_comments_profile_idx" ON "profile_comments" USING btree ("profile_user_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "restricted_term_matches_status_idx" ON "restricted_term_matches" USING btree ("review_status","created_at");--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "security_events_kind_idx" ON "security_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "thread_subscriptions_thread_idx" ON "thread_subscriptions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_tags_tag_idx" ON "thread_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "threads_forum_list_idx" ON "threads" USING btree ("forum_id","is_deleted","last_post_at");--> statement-breakpoint
CREATE INDEX "threads_user_idx" ON "threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "threads_search_idx" ON "threads" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "top_friends_pair_uq" ON "top_friends" USING btree ("user_id","friend_id");--> statement-breakpoint
CREATE INDEX "uploads_user_idx" ON "uploads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "uploads_sha_idx" ON "uploads" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievements_uq" ON "user_achievements" USING btree ("user_id","achievement_id");--> statement-breakpoint
CREATE INDEX "user_bans_user_idx" ON "user_bans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uq" ON "users" USING btree ("username_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree ("email_lower");--> statement-breakpoint
CREATE INDEX "users_username_pattern_idx" ON "users" USING btree ("username_lower" text_pattern_ops);