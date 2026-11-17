CREATE TABLE IF NOT EXISTS mod_polls_polls (
  id serial PRIMARY KEY,
  thread_id integer NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  question varchar(200) NOT NULL,
  max_choices integer NOT NULL DEFAULT 1 CHECK (max_choices >= 1 AND max_choices <= 10),
  results varchar(10) NOT NULL DEFAULT 'always',
  show_voters boolean NOT NULL DEFAULT false,
  allow_change boolean NOT NULL DEFAULT true,
  closes_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one poll per thread
  CONSTRAINT mod_polls_thread_uq UNIQUE (thread_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_polls_options (
  id serial PRIMARY KEY,
  poll_id integer NOT NULL REFERENCES mod_polls_polls(id) ON DELETE CASCADE,
  label varchar(120) NOT NULL,
  position integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_polls_options_poll_idx ON mod_polls_options (poll_id, position);
--> statement-breakpoint
-- one ballot per member per poll; erasing a member's data keeps the ballot but drops the link to them
CREATE TABLE IF NOT EXISTS mod_polls_ballots (
  id serial PRIMARY KEY,
  poll_id integer NOT NULL REFERENCES mod_polls_polls(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mod_polls_ballot_uq ON mod_polls_ballots (poll_id, user_id) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_polls_choices (
  ballot_id integer NOT NULL REFERENCES mod_polls_ballots(id) ON DELETE CASCADE,
  option_id integer NOT NULL REFERENCES mod_polls_options(id) ON DELETE CASCADE,
  PRIMARY KEY (ballot_id, option_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_polls_choices_option_idx ON mod_polls_choices (option_id);
