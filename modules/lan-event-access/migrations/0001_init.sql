CREATE TABLE IF NOT EXISTS mod_lan_event_access_attendees (
  id serial PRIMARY KEY,
  name varchar(80) NOT NULL,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0 AND amount_cents <= 10000000),
  method varchar(12) NOT NULL DEFAULT 'cash',
  note varchar(200) NOT NULL DEFAULT '',
  received_by integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_event_access_attendees_user_idx ON mod_lan_event_access_attendees (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_event_access_devices (
  id serial PRIMARY KEY,
  attendee_id integer NOT NULL REFERENCES mod_lan_event_access_attendees(id) ON DELETE CASCADE,
  mac varchar(17) NOT NULL,
  hostname varchar(80) NOT NULL DEFAULT '',
  ip varchar(45) NOT NULL DEFAULT '',
  backend varchar(20) NOT NULL,
  backend_ref varchar(120) NOT NULL DEFAULT '',
  status varchar(10) NOT NULL DEFAULT 'approving',
  approved_by integer,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_by integer,
  revoked_at timestamptz
);
--> statement-breakpoint
-- a device can be approved once at a time, and two desks can never hand out the same address
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_event_access_devices_mac_uq ON mod_lan_event_access_devices (mac) WHERE status IN ('approving', 'approved');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_event_access_devices_ip_uq ON mod_lan_event_access_devices (ip) WHERE status IN ('approving', 'approved') AND ip <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_event_access_devices_attendee_idx ON mod_lan_event_access_devices (attendee_id);
