# Architecture

## Why this stack

A traditional forum is mostly server-rendered pages with islands of interactivity (dock, friends pane, editor), and
it should run well on modest hardware and on whatever infrastructure people already have. So the app is a single TypeScript
process with no container or broker requirements:

- **Hono + `hono/jsx`** renders every page on the server (auto-escaped JSX). Every feature works as plain
  HTML forms; `src/client/main.ts` (≈32 KB minified, no framework) progressively enhances it.
- **Drizzle ORM + PostgreSQL.** Production uses `pg`; development and tests use **PGlite** (real Postgres
  compiled to WASM) so the same SQL, migrations, triggers and full-text search run everywhere.
- **SSE** (`/api/events`) for real-time messages, notifications and presence. Clients treat events as hints
  and re-sync over HTTP after reconnecting, so a dropped event never loses data.
- No microservices, no Redis, no queue broker: a Postgres-backed job table handles email.

## Layout

```
src/
  server.ts          process entry (migrate → bootstrap → load/sync/start modules → serve → job runner)
  app.tsx            Hono app: security headers/CSP nonce, body limit, sessions, CSRF, maintenance mode, module mounts, errors
  config.ts          zod-validated environment (refuses unsafe production config)
  db/schema.ts       core relational schema (single source of truth for core tables)
  db/client.ts       pg / PGlite handles + migrator
  db/bootstrap.ts    idempotent required data (groups, warning tags, rules, policy pages)
  sdk/               the public module SDK: types + the only import surface for modules (versioned, SDK_VERSION)
  modules/           module runtime (resolve, migrate, lifecycle, live enable/disable) and registries/hooks
  generated/         modules.ts: list of installed modules, written by scripts/sync-modules.mjs
  lib/               pure, unit-tested helpers: bbcode, media resolver, content filter, crypto, colour, rate limit
  services/          domain logic — the only core layer that touches the database
  routes/            HTTP handlers + page components (forums, auth, members, messages, settings, mod, admin, admin-modules, api, media)
  web/               layout shell, shared components, editor, theme registry, core navigation, page renderer
  client/            browser enhancement bundle
modules/             bundled optional modules (one folder each; see docs/MODULES.md)
drizzle/             core SQL migrations (0001 adds the append-only DM trigger)
public/              css (single token-driven stylesheet), built js, images
tests/ e2e/          vitest suites (unit + integration + HTTP) and Playwright browser suites
scripts/             build, sync-modules, seed, demo-lan, create-admin, dev-server, QA helpers
```

## Core and modules

The core owns identity, permissions, content, messaging, moderation and administration. Everything optional lives
in modules that talk to core only through `src/sdk` (enforced by a test):

- **Registries** (`modules/registry.ts`) hold everything modules contribute (themes, auth providers, media
  providers, profile sections, profile settings, nav items, admin sections, moderation queues, member admin panels),
  each tagged with its owner. Core registers its own entries the same way (owner `core`). Reads filter by the
  owner's *live* enabled state, so enabling or disabling a module needs no restart and propagates to every instance
  through the bus (`invalidate: modules`).
- **Hooks**: core emits actions after things happen (`post.created`, `user.closed`, …) and runs filters before
  content is saved (`post.beforeSave`, `message.beforeSend`, `profile.comment.beforeSave`). Action errors are
  isolated. Filters may veto with `ServiceError`, and filtered text still passes core validation and the restricted-terms
  check.
- **Runtime** (`modules/runtime.ts`): validates manifests, resolves dependencies (semver, optional deps, conflicts,
  cycles, SDK range), applies per-module SQL migrations (tracked in `module_migrations`), keeps `module_state`
  (enabled, settings, version → `onInstall`/`onUpgrade`), grants default permissions, mounts `/m/<id>`,
  `/admin/m/<id>` and `/modules/<id>/…` behind enabled checks, and runs `start`/`stop`.
- **Admin › Modules** shows status, dependencies, contributions and permissions, and edits settings (validated by
  each module's zod schema, audited).

See [MODULES.md](MODULES.md) for the developer guide.

## Request lifecycle

1. Security headers + per-request CSP nonce (`script-src 'self' 'nonce-…'`, no inline styles; frames limited to the embed allowlist).
2. 12 MB body limit.
3. Session cookie (`ff_session`, random 256-bit token; only its SHA-256 is stored) → `Viewer` (user, groups,
   permission subject, settings, active ban).
4. CSRF: every non-GET needs `_csrf` (form) or `X-CSRF-Token` (fetch) equal to the `ff_csrf` cookie, plus a
   matching `Origin` when present. Only `/auth/apple/callback` is exempt (cross-site form_post; protected by OAuth state).
5. `PageCtx` (counts, theme, flash) for rendering; maintenance mode short-circuit for non-staff.
6. Route → service. Services throw `ServiceError(status, code)`; HTML routes render friendly error pages
   (401 includes a sign-in panel, mirroring classic forum "no permission" pages); `/api/*` returns JSON.

## Permissions

`services/permissions.ts` is the single authority. Effective permission = super-admin bypass → OR of the
user's group permissions → forum group overrides (any Allow wins, else Deny) → forum-moderator assignment
(grants `mod.*` in that forum) → per-user overrides (global, then forum). Active suspensions/bans strip
everything except reading; unverified email (when required) strips participation. Every route and service
re-checks on the server; hidden buttons are only cosmetic.

## Content pipeline

- **Storage:** original BBCode is stored untouched.
- **Rendering** (`lib/bbcode.ts`): tokenise → tree of allowlisted tags → every text node escaped → URLs via
  `safeHref`/`safeUrl` → colours mapped to classes → embeds only via the media resolver. Unknown/broken tags
  render as text. Quotes nest at most 4 deep.
- **Media resolver** (`lib/media.ts`): asks the registered media providers (the `media-embeds` module ships
  YouTube, Vimeo and Spotify) for fixed embed URLs built from validated IDs, on the provider's declared origin only;
  rendered as click-to-load placeholders (no third-party request until the reader clicks); everything else is a
  link (files get a filename/domain card). Nothing is fetched server-side (no SSRF surface).
- **Policy** (`lib/filter.ts`, `services/policy.ts`): mandatory restricted terms are checked at submission
  (block / hold / flag) and redacted at display for everyone; the optional profanity mask is applied at
  display only for viewers who enabled it.
- **Excerpts** for notifications/search never include spoiler content.

## Messaging

`conversations` (unique user pair) → `conversation_participants` (read marker, mute) → `direct_messages`
(append-only, `(sender, client_nonce)` unique for idempotency, ids give total order) → `message_attachments`.
Sending persists first, then publishes to both users' SSE sinks. The dock keeps only *which tabs are open*
in localStorage; history always comes from the server.

## Scaling and shared state

On a PostgreSQL server, instances coordinate through the database (no Redis or broker):

- `services/bus.ts` — one dedicated `LISTEN fragged_bus` connection per instance; `send()` NOTIFYs every instance
  (including the sender). Payloads are hints under 8 KB; clients fetch real data over HTTP. Reconnects automatically.
- `services/events.ts` — SSE fan-out via the bus; presence is cluster-wide (immediate change broadcasts + a snapshot
  every 20 s; instances silent for 60 s are forgotten). Disconnects are detected from the request's abort signal.
- `lib/ratelimit.ts` — shared store in `rate_limit_counters` (sliding window approximated from two fixed windows);
  `once()` gives cross-instance de-duplication (thread views).
- Settings, permission, restricted-term and emoji caches broadcast an `invalidate` message on change.

With embedded PGlite everything falls back to in-process equivalents. Uploads use a `storage` interface with a
local-disk driver (`services/uploads.ts`); several instances need a shared directory, or an S3-compatible driver.
