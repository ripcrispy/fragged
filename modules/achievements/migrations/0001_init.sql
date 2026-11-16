-- Installations created before achievements became a module already have these tables (core migration 0000);
-- IF NOT EXISTS makes this a no-op there and creates them on new installations.
CREATE TABLE IF NOT EXISTS "achievement_definitions" (
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
CREATE TABLE IF NOT EXISTS "user_achievements" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"achievement_id" integer NOT NULL REFERENCES "achievement_definitions"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_by_id" integer,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" integer,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_achievements_uq" ON "user_achievements" USING btree ("user_id","achievement_id");
