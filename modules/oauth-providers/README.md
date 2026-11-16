# Sign-in providers

"Sign in with…" for **Google, Discord, Facebook, Apple and GitHub**. Each provider appears on the sign-in and
register pages only once its credentials are set. Core handles state, PKCE, nonce checks, account linking and
username selection. New accounts are never merged by email.

| Provider | Environment variables |
| --- | --- |
| Google | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET` |
| Discord | `OAUTH_DISCORD_CLIENT_ID`, `OAUTH_DISCORD_CLIENT_SECRET` |
| Facebook | `OAUTH_FACEBOOK_CLIENT_ID`, `OAUTH_FACEBOOK_CLIENT_SECRET` |
| Apple | `OAUTH_APPLE_CLIENT_ID`, `OAUTH_APPLE_TEAM_ID`, `OAUTH_APPLE_KEY_ID`, `OAUTH_APPLE_PRIVATE_KEY` |
| GitHub | `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` |

Register the redirect URI `${APP_URL}/auth/<provider>/callback` with each provider (for example
`https://forums.example.org/auth/google/callback`). Admins can switch individual providers off in **Admin ›
Sign-in providers**.

Secrets are read only from the environment, never stored in the database.
