CREATE TABLE "module_migrations" (
	"module_id" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_migrations_module_id_name_pk" PRIMARY KEY("module_id","name")
);
--> statement-breakpoint
CREATE TABLE "module_state" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"version" varchar(32) NOT NULL,
	"enabled" boolean NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
