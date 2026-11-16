# Spotify on profiles

Members can show a favourite Spotify **track** and **playlist** on their profile. These are links only: no Spotify
account connection and no API keys.

- **Where:** Settings › Profile (fields), profile side column (player)
- **Works with:** `media-embeds` (click-to-load player). Without it, plain links are shown.
- **Data:** `mod_profile_spotify` (user id, track URL, playlist URL). Removed when an account is closed.
- **Permissions / settings:** none
