CREATE TABLE IF NOT EXISTS mod_caffeine_drinks (
  id serial PRIMARY KEY,
  name varchar(80) NOT NULL,
  category varchar(24) NOT NULL DEFAULT 'other',
  serving_ml integer,
  caffeine_mg numeric(6,1) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  CONSTRAINT mod_caffeine_drinks_name_uq UNIQUE (name)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_caffeine_logs (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drink_id integer REFERENCES mod_caffeine_drinks(id) ON DELETE SET NULL,
  drink_name varchar(80) NOT NULL,
  servings numeric(4,1) NOT NULL,
  mg numeric(7,1) NOT NULL,
  consumed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_caffeine_logs_time_idx ON mod_caffeine_logs (consumed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_caffeine_logs_user_idx ON mod_caffeine_logs (user_id, consumed_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_caffeine_prefs (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hidden boolean NOT NULL DEFAULT false
);
