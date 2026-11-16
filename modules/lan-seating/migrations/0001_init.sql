CREATE TABLE IF NOT EXISTS mod_lan_seating_events (
  id serial PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  location varchar(160) NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  layout text NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  booking_opens_at timestamptz,
  booking_closes_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_seating_bookings (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES mod_lan_seating_events(id) ON DELETE CASCADE,
  seat varchar(8) NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one person per seat and one seat per person: the database rejects double bookings even under concurrency
  CONSTRAINT mod_lan_seating_seat_uq UNIQUE (event_id, seat),
  CONSTRAINT mod_lan_seating_user_uq UNIQUE (event_id, user_id)
);
