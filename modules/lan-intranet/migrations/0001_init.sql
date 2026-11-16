CREATE TABLE IF NOT EXISTS mod_lan_intranet_announcements (
  id serial PRIMARY KEY,
  title varchar(140) NOT NULL,
  body text NOT NULL DEFAULT '',
  level varchar(10) NOT NULL DEFAULT 'info',
  pinned boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_intranet_servers (
  id serial PRIMARY KEY,
  name varchar(80) NOT NULL,
  game varchar(80) NOT NULL DEFAULT '',
  host varchar(253) NOT NULL DEFAULT '',
  port integer NOT NULL DEFAULT 0,
  kind varchar(12) NOT NULL DEFAULT 'tcp',
  connect varchar(200) NOT NULL DEFAULT '',
  notes varchar(300) NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_intranet_schedule (
  id serial PRIMARY KEY,
  title varchar(140) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  location varchar(120) NOT NULL DEFAULT '',
  notes varchar(300) NOT NULL DEFAULT ''
);
