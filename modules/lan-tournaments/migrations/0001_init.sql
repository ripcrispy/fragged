CREATE TABLE IF NOT EXISTS mod_lan_tournaments_tournaments (
  id serial PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  game varchar(80) NOT NULL DEFAULT '',
  platform varchar(40) NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  rules text NOT NULL DEFAULT '',
  banner_url varchar(200),
  status varchar(20) NOT NULL DEFAULT 'draft',
  visibility varchar(10) NOT NULL DEFAULT 'public',
  archived boolean NOT NULL DEFAULT false,
  mode varchar(8) NOT NULL DEFAULT 'solo',
  team_min integer NOT NULL DEFAULT 1 CHECK (team_min >= 1 AND team_min <= 64),
  team_max integer NOT NULL DEFAULT 1 CHECK (team_max >= 1 AND team_max <= 64),
  subs_max integer NOT NULL DEFAULT 0 CHECK (subs_max >= 0 AND subs_max <= 16),
  max_entries integer CHECK (max_entries IS NULL OR (max_entries >= 2 AND max_entries <= 1024)),
  require_approval boolean NOT NULL DEFAULT false,
  require_checkin boolean NOT NULL DEFAULT false,
  require_booking boolean NOT NULL DEFAULT false,
  format varchar(20) NOT NULL DEFAULT 'single_elim',
  config jsonb NOT NULL DEFAULT '{}',
  lan_event_id integer,
  reg_opens_at timestamptz,
  reg_closes_at timestamptz,
  checkin_opens_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  results_published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_tournaments_event_idx ON mod_lan_tournaments_tournaments (lan_event_id);
--> statement-breakpoint
-- per-tournament roles: organisers run everything for their tournament, referees handle scores and disputes
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_staff (
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(10) NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_teams (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  tag varchar(8) NOT NULL DEFAULT '',
  captain_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_tournaments_team_name_uq ON mod_lan_tournaments_teams (tournament_id, lower(name));
--> statement-breakpoint
-- one team per member per tournament; invited members join when they accept
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_team_members (
  team_id integer NOT NULL REFERENCES mod_lan_tournaments_teams(id) ON DELETE CASCADE,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(10) NOT NULL DEFAULT 'player',
  status varchar(10) NOT NULL DEFAULT 'invited',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_tournaments_member_uq ON mod_lan_tournaments_team_members (tournament_id, user_id) WHERE status = 'active';
--> statement-breakpoint
-- a registration: a solo player or a team
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_entries (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  team_id integer REFERENCES mod_lan_tournaments_teams(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'pending',
  seed integer,
  checked_in_at timestamptz,
  station varchar(40) NOT NULL DEFAULT '',
  note varchar(200) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_tournaments_entry_user_uq ON mod_lan_tournaments_entries (tournament_id, user_id) WHERE user_id IS NOT NULL AND status <> 'withdrawn';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_lan_tournaments_entry_team_uq ON mod_lan_tournaments_entries (tournament_id, team_id) WHERE team_id IS NOT NULL AND status <> 'withdrawn';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_invites (
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_stages (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  kind varchar(20) NOT NULL,
  name varchar(60) NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  status varchar(10) NOT NULL DEFAULT 'active',
  CONSTRAINT mod_lan_tournaments_stage_uq UNIQUE (tournament_id, idx)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_matches (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  stage_id integer NOT NULL REFERENCES mod_lan_tournaments_stages(id) ON DELETE CASCADE,
  bracket varchar(8) NOT NULL DEFAULT 'W',
  round integer NOT NULL,
  position integer NOT NULL,
  code varchar(16) NOT NULL,
  best_of integer NOT NULL DEFAULT 1,
  entry_a integer REFERENCES mod_lan_tournaments_entries(id) ON DELETE SET NULL,
  entry_b integer REFERENCES mod_lan_tournaments_entries(id) ON DELETE SET NULL,
  a_from varchar(24),
  b_from varchar(24),
  score_a integer,
  score_b integer,
  winner integer,
  loser integer,
  is_draw boolean NOT NULL DEFAULT false,
  status varchar(10) NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  station varchar(40) NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  reminded_at timestamptz,
  CONSTRAINT mod_lan_tournaments_match_code_uq UNIQUE (stage_id, code)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_tournaments_matches_t_idx ON mod_lan_tournaments_matches (tournament_id, status);
--> statement-breakpoint
-- free-for-all heats: every entry in a heat gets a placing and points
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_heat_entries (
  match_id integer NOT NULL REFERENCES mod_lan_tournaments_matches(id) ON DELETE CASCADE,
  entry_id integer NOT NULL REFERENCES mod_lan_tournaments_entries(id) ON DELETE CASCADE,
  placement integer,
  points integer,
  PRIMARY KEY (match_id, entry_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_reports (
  id serial PRIMARY KEY,
  match_id integer NOT NULL REFERENCES mod_lan_tournaments_matches(id) ON DELETE CASCADE,
  side varchar(8) NOT NULL,
  score_a integer,
  score_b integer,
  placements jsonb,
  reported_by integer REFERENCES users(id) ON DELETE SET NULL,
  status varchar(10) NOT NULL DEFAULT 'pending',
  dispute_reason varchar(300) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_tournaments_reports_match_idx ON mod_lan_tournaments_reports (match_id, status);
--> statement-breakpoint
-- time challenges: each entry submits attempts; the best verified one counts
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_attempts (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  entry_id integer NOT NULL REFERENCES mod_lan_tournaments_entries(id) ON DELETE CASCADE,
  value integer NOT NULL,
  proof varchar(300) NOT NULL DEFAULT '',
  status varchar(10) NOT NULL DEFAULT 'pending',
  submitted_by integer REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_announcements (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- published final standings: one row per entry, plus each member of a team, for history and leaderboards
CREATE TABLE IF NOT EXISTS mod_lan_tournaments_results (
  id serial PRIMARY KEY,
  tournament_id integer NOT NULL REFERENCES mod_lan_tournaments_tournaments(id) ON DELETE CASCADE,
  entry_id integer REFERENCES mod_lan_tournaments_entries(id) ON DELETE SET NULL,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  name varchar(60) NOT NULL,
  team_name varchar(60) NOT NULL DEFAULT '',
  place integer NOT NULL,
  points integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  draws integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_tournaments_results_user_idx ON mod_lan_tournaments_results (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_tournaments_results_t_idx ON mod_lan_tournaments_results (tournament_id, place);
