# Deployment

## Requirements

- Node.js 22+ (developed on 24 LTS), PostgreSQL 15+.
- A reverse proxy terminating TLS (nginx, Caddy…). SSE needs buffering disabled for `/api/events`.
- Persistent disk (or object storage) for `DATA_DIR/uploads`.
- An SMTP provider for verification, password reset and security emails.

## Steps

1. `npm ci && npm run build`
2. Configure the environment from [`.env.example`](../.env.example). In production the app refuses to start
   without `DATABASE_URL`, a non-default `APP_SECRET`, or with `AUTH_DEV_PROVIDER` enabled.
3. `npm start` — migrations in `drizzle/` run automatically on boot, followed by idempotent bootstrap data.
4. `npm run create-admin -- <username> <email>` (set `ADMIN_PASSWORD` or note the printed one-time password).
5. Sign in, then in **Admin**: create categories/forums, review Rules & pages, set the minimum age for your
   jurisdiction, configure upload limits, add restricted terms (test them before activating), enable
   sign-in providers, and review **Admin › Modules** (enable only what you need).
6. Set `SOURCE_URL` (see [Source code](#source-code-agpl)).

A ready-made systemd unit (sandboxed, runs as an unprivileged `fragged` user) and nginx config are in
[`deploy/`](../deploy/).

## Running several instances

On a PostgreSQL server the app runs in **shared mode** automatically (boot log: `"shared":true`):
real-time events, presence, cache invalidation (settings, permissions, restricted terms, emoji) travel over
PostgreSQL `LISTEN/NOTIFY`, and rate limits / view de-duplication use the `rate_limit_counters` table. So you can
run several processes (same `APP_SECRET`, same database, shared `DATA_DIR/uploads` — e.g. one machine, or a shared
volume) behind the nginx upstream. Each instance keeps one extra database connection for listening.
`node scripts/cluster-check.mjs` verifies messaging, presence, settings and rate limits across two local instances
on ports 3401/3402.

Embedded PGlite (no `DATABASE_URL`) is single-instance only and is meant for development and tests.

### nginx snippet

```nginx
location /api/events { proxy_pass http://127.0.0.1:3000; proxy_buffering off; proxy_read_timeout 1h; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
location / { proxy_pass http://127.0.0.1:3000; client_max_body_size 12m; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
```

Set `TRUST_PROXY=1` so rate limits and logs use the client address.

## Origins (CSRF protection)

Every form post and API write must come from an allowed origin: `APP_URL`'s origin, plus any exact origins in
`ALLOWED_ORIGINS`. If you see "Cross-origin request blocked", the browser is using an address the server
wasn't told about — the server log line `blocked cross-origin request` shows the origin it received. Fix it by
setting `APP_URL` to the address people actually use (it's also used for email links and OAuth redirects) or by
adding the extra address to `ALLOWED_ORIGINS`. Do not disable the check.

For LAN testing of a development box, for example:

```bash
APP_URL=http://10.0.0.189:3000
ALLOWED_ORIGINS=http://localhost:3000,http://fragged:3000
```

## Sign-in providers

Register the redirect URI `${APP_URL}/auth/<provider>/callback` exactly (google, discord, facebook, apple, github).
Request only identity/email scopes. For Apple, use a Services ID as the client id, the team and key ids, and a
PKCS#8 key; Apple returns via cross-site POST, which requires HTTPS (the flow cookie is `SameSite=None; Secure`).
Place official sign-in button marks in `public/img/providers/<provider>.svg` following each provider's brand
guidelines (not bundled).

## Modules

Bundled modules live in `modules/`. Third-party modules are installed from npm and listed in `fragged.config.json`
(then `npm run build`; they are bundled into `dist/server.js`). Their SQL migrations run automatically on boot,
and new modules start in their `enabledByDefault` state. Enable, disable and configure modules in **Admin ›
Modules**. Changes apply to every instance immediately, without a restart, and disabling keeps the module's data.

Modules run with full access to the application and database, so install only modules you trust and review their
README for permissions, settings, environment variables and stored data. A module that fails to load is shown as
Unavailable with the reason, and the rest of the site keeps running. See [MODULES.md](MODULES.md).

## Source code (AGPL)

Fragged Forums is licensed under AGPL-3.0-or-later. If you modify it (core or bundled modules) and let people use it
over a network, you must offer them the corresponding source. Publish your version (a public Git repository is the
easy way), set `SOURCE_URL` to it, and a "Source code" link appears in every page footer.

## Backups & recovery

- **Database:** module tables (`mod_*`, plus `module_state` and `module_migrations`) live in the same database, so
  one dump covers everything. Nightly `pg_dump -Fc fragged > fragged-$(date +%F).dump`, plus WAL archiving / PITR if your host
  supports it. Restore with `pg_restore -d fragged --clean fragged-YYYY-MM-DD.dump`.
- **Uploads:** back up `DATA_DIR/uploads` alongside the database (keys are referenced from the `uploads` table).
- Test restores periodically into a staging environment.
- Logs are JSON lines on stdout; ship them to your log store.

## Operations

- Health check: `GET /healthz`.
- Maintenance mode: Admin › Site settings (staff keep access).
- Rate limits: Admin › Site settings › JSON overrides (keys: login, register, post, thread, message, upload,
  search, member_search, friend_request, profile_comment, report, emoji_submit, password_reset, verify_resend, oauth_start).
