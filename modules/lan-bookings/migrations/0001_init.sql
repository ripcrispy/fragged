CREATE TABLE IF NOT EXISTS mod_lan_bookings_events (
  event_id integer PRIMARY KEY REFERENCES mod_lan_seating_events(id) ON DELETE CASCADE,
  status varchar(12) NOT NULL DEFAULT 'draft',
  intro text NOT NULL DEFAULT '',
  require_booking boolean NOT NULL DEFAULT true,
  rules text NOT NULL DEFAULT '',
  panel_sections varchar(120) NOT NULL DEFAULT 'rules,crew,bookings,schedule,servers,seatmap',
  thread_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_bookings_events_thread_idx ON mod_lan_bookings_events (thread_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_bookings_types (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES mod_lan_bookings_events(event_id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  description varchar(300) NOT NULL DEFAULT '',
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0 AND price_cents <= 10000000),
  capacity integer CHECK (capacity IS NULL OR (capacity >= 0 AND capacity <= 100000)),
  seats text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_bookings_types_event_idx ON mod_lan_bookings_types (event_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_bookings_bookings (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES mod_lan_bookings_events(event_id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_id integer REFERENCES mod_lan_bookings_types(id) ON DELETE SET NULL,
  status varchar(12) NOT NULL DEFAULT 'interested',
  note varchar(200) NOT NULL DEFAULT '',
  terms_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- one booking (or expression of interest) per member per event
  CONSTRAINT mod_lan_bookings_user_uq UNIQUE (event_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_bookings_bookings_type_idx ON mod_lan_bookings_bookings (type_id);
--> statement-breakpoint
-- the event crew shown on the announcement thread: admins, moderators, LAN admins and volunteers who will be there
CREATE TABLE IF NOT EXISTS mod_lan_bookings_staff (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES mod_lan_bookings_events(event_id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(40) NOT NULL,
  note varchar(100) NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  CONSTRAINT mod_lan_bookings_staff_uq UNIQUE (event_id, user_id)
);
