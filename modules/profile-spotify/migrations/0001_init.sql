CREATE TABLE IF NOT EXISTS mod_profile_spotify (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  track_url text,
  playlist_url text,
  show boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- carry over links saved before this feature became a module
INSERT INTO mod_profile_spotify (user_id, track_url, playlist_url, show)
SELECT user_id, spotify_track_url, spotify_playlist_url, show_spotify FROM user_profiles
WHERE spotify_track_url IS NOT NULL OR spotify_playlist_url IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
