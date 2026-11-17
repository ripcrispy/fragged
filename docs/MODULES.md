# Writing modules

Fragged Forums keeps a small **core** (accounts, sessions, permissions, forums, threads, posts, profiles, friends,
direct messages, emoji, moderation, admin, search) and puts everything optional in **modules**. A module can add
pages, admin screens, permissions, settings, database tables, themes, sign-in providers, media embeds, profile
sections, navigation links and moderation queues. It can also react to (or veto) things that happen in core. You
never have to edit core files to do any of this.

This guide covers everything a module author needs. The bundled modules in [`modules/`](../modules) are working
examples. The smallest are `theme-pack` and `media-embeds`, and `lan-seating` and `caffeine-tracker` are complete
features.

- [Quick start](#quick-start)
- [Where modules live](#where-modules-live)
- [The manifest](#the-manifest)
- [Lifecycle](#lifecycle)
- [The SDK](#the-sdk)
- [Routes and pages](#routes-and-pages)
- [Database tables and migrations](#database-tables-and-migrations)
- [Permissions](#permissions)
- [Settings](#settings)
- [Hooks](#hooks)
- [Extension points](#extension-points)
- [Talking to other modules](#talking-to-other-modules)
- [Assets, styles and scripts](#assets-styles-and-scripts)
- [Security rules](#security-rules)
- [Compatibility and versioning](#compatibility-and-versioning)
- [Testing a module](#testing-a-module)
- [Publishing a module](#publishing-a-module)

## Quick start

Create `modules/hello-lan/index.tsx`:

```tsx
/** @jsxImportSource hono/jsx */
import { defineModule, Box, type ModuleContext } from '../../src/sdk/index.ts';

export default defineModule({
  id: 'hello-lan',
  name: 'Hello LAN',
  version: '1.0.0',
  description: 'Says hello on /m/hello-lan.',
  sdk: '^1.0.0',
  license: 'AGPL-3.0-or-later',
  permissions: { view: { label: 'See the hello page', grantTo: ['guest', 'member'] } },

  setup(ctx: ModuleContext) {
    const view = ctx.perm('view'); // → "hello-lan.view"
    ctx.register.navItem({ href: '/m/hello-lan', label: 'Hello', area: 'footer', order: 90 });
    ctx.routes.get('/', async (c) => {
      await c.get('viewer').require(view);
      return ctx.render(c, 'Hello', <Box title="Hello"><p>Hello from a module!</p></Box>);
    });
  },
});
```

Then:

```bash
npm run modules:sync
```

```bash
npm run dev
```

Open <http://localhost:3000/m/hello-lan>. The module appears in **Admin › Modules**, where it can be turned off and
on again without a restart. `npm run dev`, `npm test` and `npm run build` run `modules:sync` automatically. Run it
by hand only when the dev server is already running.

## Where modules live

| Kind | Location | Imports the SDK from |
| --- | --- | --- |
| Bundled (first-party, or your own fork) | `modules/<id>/index.ts` or `index.tsx` | `'../../src/sdk/index.ts'` |
| Third-party npm package | `node_modules/<package>`, listed in [`fragged.config.json`](../fragged.config.json) | `'fragged-forums/sdk'` |

`scripts/sync-modules.mjs` writes the list of installed modules to `src/generated/modules.ts`. That file is
committed, and CI fails if it is stale (`--check`).

To install a module from npm:

```bash
npm install some-fragged-module
```

Add `"some-fragged-module"` to the `modules` array in `fragged.config.json`, then run:

```bash
npm run modules:sync
```

Package modules are bundled into `dist/server.js` at build time, so they share the application's single SDK
instance. A package's default export must be the `defineModule(...)` result. Its folder is the base for
`migrations` and `assets`.

## The manifest

`defineModule()` takes the manifest and the lifecycle functions in one object. All manifest fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | ✓ | Lowercase kebab-case, unique (`^[a-z][a-z0-9-]{1,40}$`). It prefixes permissions (`<id>.<key>`), tables (`mod_<id>_*`, with dashes as underscores), routes (`/m/<id>`) and assets (`/modules/<id>/`). |
| `name`, `description` | ✓ | Shown in Admin › Modules. |
| `version` | ✓ | Semver. A change triggers `onUpgrade`. |
| `sdk` | ✓ | Semver range of the SDK you target, e.g. `"^1.0.0"`. |
| `author`, `license`, `homepage` | | Shown in Admin › Modules. |
| `dependencies` | | `{ "other-id": "^1.2.0" }`. These must be installed, compatible and enabled. They load first. |
| `optionalDependencies` | | Used when present and enabled. A wrong version is an error, a missing module is not. |
| `conflicts` | | Ids that can't be enabled at the same time. |
| `enabledByDefault` | | Default `true`. Use `false` for anything niche (all the LAN modules do). |
| `permissions` | | `{ key: { label, grantTo?: ['member', …] } }`. See [Permissions](#permissions). |
| `settings` | | `{ schema, defaults, fields }`. See [Settings](#settings). |
| `notificationKinds` | | `{ kind: 'Label shown in notification settings' }`. Required before you call `services.notify` with that kind. |
| `migrations` | | Folder of SQL migrations, relative to the module folder (usually `"migrations"`). |
| `assets` | | Folder served at `/modules/<id>/…` while enabled (usually `"public"`). |
| `styles` | | Stylesheets inside `assets` added to every page while enabled. |

At boot the runtime checks every manifest and resolves dependencies (missing modules, version ranges, cycles,
conflicts, duplicate ids, SDK range, settings defaults against their schema). A module that fails is marked
**Unavailable** with the reason and is skipped. Modules that depend on it are skipped too. The rest of the site keeps
running.

## Lifecycle

```
boot ─▶ setup()          every available module, in dependency order (enabled or not)
     ─▶ migrations       per database, before anything touches your tables
     ─▶ onInstall()      first time this installation sees the module
        onUpgrade(from)  the module's version changed since last boot
     ─▶ start()          enabled modules, once the app is ready

admin enables  ─▶ onEnable() ─▶ start()
admin disables ─▶ stop() ─▶ onDisable()
shutdown       ─▶ stop()     reverse dependency order
```

- **`setup(ctx)`** registers routes, hooks and extensions. It runs even for disabled modules, because enabled state
  is checked live on every request. That is why toggling a module needs no restart, and why it takes effect on
  every server instance immediately. Don't start timers or open connections here.
- **`start` / `stop`** are for background work such as timers, pollers and sockets (see `lan-intranet`). `stop`
  must undo everything `start` did.
- **`onInstall`** is for seeding data (see `caffeine-tracker`). **`onUpgrade`** is for data fixes that SQL can't
  do.
- Every hook runs inside a guard. An exception is logged with your module id and never takes the site down. A
  failing `setup` marks the module Unavailable.

**When a module is disabled**, its pages and assets return 404. Its links, profile sections, admin pages, themes,
providers and hook handlers disappear, and its stylesheets are no longer included. **Its data is kept.**
Re-enabling brings everything back.

## The SDK

Import only from the SDK: `src/sdk/index.ts`, or `fragged-forums/sdk` for packages. Core internals can change in
any release. The SDK follows semver (see [Compatibility](#compatibility-and-versioning)), and a test enforces the
boundary for bundled modules.

| Export | What it is |
| --- | --- |
| `defineModule`, `SDK_VERSION` | Typed identity function; current SDK version. |
| `ServiceError(message, status?, code?)` | Throw it for user-facing errors (400 by default). Routes render it as a friendly page or JSON. |
| `z` | zod, for settings schemas and input validation. |
| `pg`, `sql`, `eq`, `ne`, `and`, `or`, `not`, `asc`, `desc`, `inArray`, `isNull`, `isNotNull`, `gt`, `gte`, `lt`, `lte` | Drizzle schema builders (`pg.pgTable`, `pg.serial`, …) and query helpers. |
| `database.db()`, `database.coreTables` | The Drizzle handle (same as `ctx.db()`) and core table definitions. Treat core tables as **read-only**. Change core data through hooks or core flows. |
| `services.users.{getById,getByUsername,cards}` | Look members up. `cards(ids)` returns a `Map` of public display data. |
| `services.notify(userId, kind, actorId, text, url)` | In-app notification. Respects preferences, blocks and mutes. Declare `kind` in `notificationKinds`. |
| `services.audit(actorId, action, target, meta, ip)` | Audit-log entry. Name actions `<id>.<verb>`. |
| `services.rateLimit(key, { max, windowSec })` | Returns `{ ok, retryAfter }`. Shared across instances on PostgreSQL. |
| `services.push(userId, event)` | Real-time hint to a member's open tabs. |
| `services.coreSetting(key)` | Read a core site setting such as `site_name`. |
| `services.forums.{postable,createThread,setSticky}` | *(SDK 1.1)* Forums the viewer may start threads in; start a thread **as the viewer**; make it sticky. Every core check applies (permissions, posting policy, rate limits, restricted terms), so a module can't post where the member couldn't. See `lan-bookings`. |
| `oidc.{verifyIdToken,fetchProfile,createRemoteJWKSet}` | For sign-in provider modules. |
| `crypto.{hmac,sha256,safeEqual,randomToken}` | Keyed with the site's `APP_SECRET`. |
| `form`, `str`, `int`, `bool`, `arr`, `setFlash` | Read form bodies safely; one-shot flash messages. |
| `Box`, `Field`, `TextArea`, `Checkbox`, `Select`, `Notice`, `ActionButton`, `Csrf`, `UserLink`, `Avatar`, `Time`, `Html`, `EmptyState`, `Pagination`, `Stat`, `TagPill` | The UI kit used by core pages. Theme-aware and accessible. |
| `escapeHtml`, `renderBBCode`, `excerpt`, `mediaEmbedHtml`, `linkCardHtml`, `safeUrl`, `resolveMedia` | Content rendering. `renderBBCode` is the only safe way to turn member text into HTML. |
| `cleanLine`, `cleanText`, `slugify`, `parseHexColor` | Input normalisation. |
| `fmtDate`, `fmtDateTime`, `timeAgo`, `numberFmt`, `parseLocalDateTime`, `toLocalInput` | Time and number formatting (time-zone aware). |
| Types | `ModuleContext`, `ModuleDefinition`, `RequestContext`, `PageCtx`, `Viewer`, `User`, `UserCard`, `Child`, and every extension-point type. |

### `ModuleContext`

| Member | Use |
| --- | --- |
| `id`, `version`, `log` | `log.info/warn/error(msg, fields)` writes structured logs tagged with your module. |
| `db()` | Drizzle handle. |
| `isEnabled()` | Live enabled state. |
| `settings.get<T>()` / `settings.set(values)` | Validated settings, read from the database, so a change applies on every instance at once. |
| `hooks.on(name, fn, { priority })` / `hooks.filter(name, fn, { priority })` | See [Hooks](#hooks). |
| `routes` / `adminRoutes` | Hono routers mounted at `/m/<id>` and `/admin/m/<id>`. |
| `register.*` | See [Extension points](#extension-points). |
| `render(c, title, body, { crumbs, status })` | Full page in the site shell. |
| `renderAdmin(c, title, permission, body)` | Page in the admin shell (checks `permission`). |
| `perm(key)` | `"<id>.<key>"`. |
| `expose(api)` / `use<T>(id)` | See [Talking to other modules](#talking-to-other-modules). |

## Routes and pages

```tsx
ctx.routes.get('/:slug', async (c) => {
  const v = c.get('viewer');          // the signed-in member (or guest), with permissions
  await v.require(ctx.perm('view'));  // throws 401/403 properly
  const page = c.get('page');         // PageCtx: needed by <Csrf>, <ActionButton>, theme, flash
  return ctx.render(c, 'Title', <Box title="…">…</Box>, { crumbs: [{ label: 'Mine', href: '/m/mine' }, { label: 'Title' }] });
});

ctx.routes.post('/thing', async (c) => {
  const v = c.get('viewer'); await v.require(ctx.perm('edit'));
  const b = await form(c);                    // parsed body; CSRF was already verified
  try { /* … */ setFlash(c, { type: 'ok', text: 'Saved.' }); }
  catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/m/mine');               // POST → redirect → GET
});
```

Your routes already have sessions, CSRF verification, the origin check, security headers, maintenance mode and
error pages. Admin routes also require `admin.access`. Check your own permission inside each handler as well.

**Every form needs `<Csrf ctx={page} />`.** `<ActionButton>` adds it for you. `fetch` calls send the
`X-CSRF-Token` header (read it from `<meta name="csrf-token">`).

Pages must work without JavaScript. Use real forms and links, and enhance them with a script if you like.

## Database tables and migrations

Define tables with the SDK's `pg` builders and create them with SQL migrations in your `migrations` folder:

```
modules/my-mod/migrations/0001_init.sql
modules/my-mod/migrations/0002_add_index.sql
```

- File names must match `NNNN_name.sql`. They are applied once each, in order, and tracked in `module_migrations`.
- Separate statements with `--> statement-breakpoint` lines.
- Name tables `mod_<id>_<name>` (dashes become underscores). Use `IF NOT EXISTS` so a partly applied migration can be
  re-run safely.
- Reference `users(id) ON DELETE CASCADE` for per-member rows. Also handle the `user.closed` hook (accounts are
  closed and anonymised, not deleted).
- **Never alter or drop core tables.** Never edit a migration after you've released it. Add a new one instead.
- Migrations run whether or not the module is enabled, so schema and code always agree.

```ts
export const things = pg.pgTable('mod_my_mod_things', {
  id: pg.serial('id').primaryKey(),
  userId: pg.integer('user_id').notNull(),
  title: pg.varchar('title', { length: 120 }).notNull(),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

## Permissions

```ts
permissions: {
  view:   { label: 'See seat maps', grantTo: ['guest', 'member'] },
  book:   { label: 'Book a seat', grantTo: ['member'] },
  manage: { label: 'Manage LAN events' },          // nobody but admins until granted
},
```

Keys are namespaced to `<id>.<key>`. When the module is first installed, `grantTo` groups receive the permission.
Administrators can then change it per group, per forum or per member in **Admin › Groups & permissions**, which lists
module permissions next to core ones. Super-admins always pass. Suspended and banned members never pass anything
except reading.

Check permissions with `await viewer.require(key)` (throws) or `await viewer.can(key)` (boolean). Hiding a button
is not a permission check.

## Settings

```ts
settings: {
  schema: z.object({ title: z.string().min(1).max(80), refreshSeconds: z.number().int().min(10).max(600) }),
  defaults: { title: 'LAN Party HQ', refreshSeconds: 30 },
  fields: [
    { key: 'title', label: 'Page title', type: 'string', maxLength: 80 },
    { key: 'refreshSeconds', label: 'Refresh (seconds)', type: 'number', min: 10, max: 600 },
    { key: 'apiKey', label: 'API key', type: 'env', env: 'MY_MOD_API_KEY', hint: 'Set in the environment' },
  ],
},
```

Admin › Modules renders a form from `fields` (`boolean`, `number`, `string`, `url`, `text`, `select`, `env`). Saved
values are validated against `schema`. Invalid input is rejected with the zod message, and changes are audited.
`ctx.settings.get()` returns defaults merged with saved values.

**Secrets never go in settings.** Read them from environment variables. An `env` field only shows whether the
variable is set.

## Hooks

**Actions** tell you something happened. Handlers run in `priority` order (lower first, default 10). Errors are
logged and never reach the member.

| Action | Payload |
| --- | --- |
| `user.registered` | `{ userId, provider }` |
| `user.loggedIn` | `{ userId, provider }` |
| `user.closed` | `{ userId }`: delete or anonymise this member's module data |
| `thread.created` | `{ threadId, forumId, userId, postId }` |
| `post.created` | `{ postId, threadId, forumId, userId, position }` |
| `post.reacted` | `{ postId, authorId, userId, reaction, added }` |
| `friend.accepted` | `{ userId, friendId }` |
| `profile.commented` | `{ profileUserId, authorId, commentId }` |
| `message.sent` | `{ conversationId, messageId, senderId, recipientId }` |
| `report.created` | `{ reportId, targetType, targetId, reporterId }` |
| `audit.recorded` | `{ actorId, action, targetType, targetId }` |

**Filters** transform or veto content before it is saved. Return the (possibly changed) value. Throw `ServiceError`
to reject with a message the member sees. Other exceptions are logged and your filter is skipped, so a bug fails
open, not closed. Identity fields (`userId`, `senderId`, `authorId`, …) can't be changed. Only the body can.

| Filter | Value |
| --- | --- |
| `post.beforeSave` | `{ body, userId, forumId, kind: 'thread' \| 'reply' \| 'edit' }` |
| `message.beforeSend` | `{ body, senderId, recipientId }` |
| `profile.comment.beforeSave` | `{ body, authorId, profileUserId }` |

Filters run first. Core length and permission validation, then the mandatory restricted-terms check, run on the
**filtered** text, so a filter can't produce over-long or blocked content.

```ts
ctx.hooks.filter('post.beforeSave', (v) => {
  if (/\bfree nitro\b/i.test(v.body)) throw new ServiceError('That looks like a scam link.');
  return v;
});
ctx.hooks.on('user.closed', async ({ userId }) => { await ctx.db().delete(things).where(eq(things.userId, userId)); });
```

Need a hook that doesn't exist? Open a [module proposal](../.github/ISSUE_TEMPLATE/module_proposal.yml) issue. New
hooks are added in minor SDK releases.

## Extension points

All `ctx.register.*` calls are made in `setup()` and are active only while your module is enabled.

| Call | Adds | Example module |
| --- | --- | --- |
| `theme({ id, name, scheme, description, stylesheet })` | A theme in Preferences. The stylesheet sets design tokens under `[data-theme="<id>"]`. | `theme-pack`, `retro-themes` |
| `authProvider({ id, name, pkce, configured, authUrl, exchange, envVars })` | A sign-in provider. Core runs state, PKCE, nonce, linking and registration. You only talk to the identity provider. | `oauth-providers`, `dev-auth` |
| `mediaProvider({ id, name, embedOrigins, match })` | Recognises URLs and returns a fixed embed URL on a declared origin. The origins join the CSP `frame-src` while enabled. | `media-embeds` |
| `profileSection({ id, column: 'side' \| 'main', order, render })` | A box on profiles. Return `null` to show nothing. | `achievements`, `lan-seating` |
| `profileSettings({ id, order, render, save })` | Fields in Settings › Profile. `save` returns field errors. | `profile-spotify` |
| `navItem({ href, label, area: 'main' \| 'footer' \| 'user-menu', order, icon, visible })` | Navigation links. Core main links use orders 10–70. | all LAN modules |
| `adminSection({ slug, label, permission })` | An admin tab linking to `/admin/m/<id>/<slug>`. Serve the page from `ctx.adminRoutes`. | `achievements` |
| `modQueue({ id, label, href, permission, count })` | A queue in the moderation overview and the staff badge. | |
| `adminUserPanel({ id, title, permission, order, render })` | A panel on Admin › Users › member. | `achievements` |
| `threadPanel({ id, order, render })` | *(SDK 1.1)* A box above a thread's posts. `render({ viewer, thread, ctx })` returns `null` for threads it doesn't care about. | `lan-bookings` |
| `personalData({ id, label, export, erase })` | *(SDK 1.2)* Your module's share of a member's data. `export(userId)` returns JSON-ready data for their download in Settings › Your data; `erase(userId)` removes it (or anonymises records you must keep) when they ask. Every module that stores per-member data should register one. | all LAN modules, `achievements` |

Main-nav icons available: `home forums new search members messages rules calendar monitor cup seat pizza star`.

## Talking to other modules

A module may publish an API in `setup`:

```ts
ctx.expose({ currentSummary, seatOf });
```

Another module declares the dependency and uses it:

```ts
optionalDependencies: { 'lan-seating': '^1.0.0' },
// …
const seating = ctx.use<{ currentSummary(): Promise<Summary | null> }>('lan-seating'); // null when unavailable
```

`use()` returns `null` unless the target is installed, enabled, exposes something, **and** is declared in your
`dependencies` or `optionalDependencies`. Undeclared access is refused. Call `use()` at request time, not once in
`setup`, so it follows live enable/disable. Treat an exposed API like a public API: changing it in a
backwards-incompatible way is a major version bump.

## Assets, styles and scripts

Files in your `assets` folder are served at `/modules/<id>/<path>` while the module is enabled. Allowed types are
`.css .js .svg .png .webp .woff2 .json`. Paths are checked against traversal. List stylesheets in `styles` to
include them on every page.

**Caching:** stylesheets from `styles` and theme stylesheets are linked as `…?v=<module version>` and cached for a
day, so **bump your module's `version` when you change them**. Other asset URLs (for example a
`<script src="/modules/<id>/x.js">` in your page) are revalidated on every load.

The Content Security Policy is strict:

- **No inline scripts or `style=""` attributes.** Load JavaScript with `<script src="/modules/<id>/file.js" defer>`
  and style with classes.
- Style with the theme tokens (`var(--surface)`, `var(--text)`, `var(--accent)`, `var(--danger)`, `var(--border)`, …)
  so every theme works, including High Contrast. Check contrast with the a11y audit.
- Respect `prefers-reduced-motion` for animation.
- Frames are only allowed from media providers' declared `embedOrigins`.

## Security rules

Modules run inside the application with full database access. Administrators should install only modules they
trust, and the module page says so. For module authors:

1. **Check permissions in every handler** with `viewer.require()`, for GET and POST alike.
2. **Never build HTML from strings with member input.** Use JSX, which escapes automatically. For rich text use
   `renderBBCode`. `<Html>` is only for output of the SDK's own renderers.
3. **Use the query builder or `sql\`\`` templates.** Never concatenate SQL.
4. **Validate all input**: lengths, ranges and enums, with `cleanLine` and `cleanText` or zod. Cap list sizes.
5. **Rate-limit anything members can repeat** with `services.rateLimit`.
6. **Don't fetch member-supplied URLs server-side** (SSRF). If a module must contact hosts (like the game-server
   probes in `lan-intranet`), only organisers with a module permission may configure them. Use hard timeouts and
   response-size caps.
7. **Secrets come from environment variables**, never settings, the database or logs.
8. **Audit privileged actions** with `services.audit(actorId, '<id>.<verb>', …)`.
9. **Respect privacy.** Register `personalData` so members can download and erase your data, handle `user.closed`, honour blocks when showing member-to-member content, and give members
   an opt-out for anything public about them (see `caffeine-tracker`'s leaderboard opt-out).
10. Keep timers in `start`/`stop`, and call `unref()` so they don't keep the process alive.

## Compatibility and versioning

- `SDK_VERSION` (currently **1.2.0**) follows semver. 1.1 added `services.forums` and the `threadPanel` extension
  point; 1.2 added the `personalData` extension point. Modules using them declare `sdk: "^1.1.0"` or `"^1.2.0"`. **Minor** releases add exports, hooks or extension points.
  **Major** releases may remove or change them, and are announced in the [changelog](../CHANGELOG.md) with migration
  notes.
- Declare the range you tested against in `sdk` (e.g. `"^1.0.0"`). A module whose range doesn't match is shown as
  Unavailable rather than crashing.
- Version your module with semver too. Others depend on your id and version.
- Exposed APIs, permission keys, setting keys and table names are part of your public surface.

## Testing a module

The test helpers boot a fresh database with all modules loaded. Enable yours and exercise it:

```ts
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupDb, teardownDb, makeUser, client } from './helpers.ts';
import { setModuleEnabled } from '../src/modules/runtime.ts';

beforeAll(async () => { await setupDb(); await setModuleEnabled('hello-lan', true); });
afterAll(teardownDb);

it('renders for guests', async () => {
  const r = await client().get('/m/hello-lan');
  expect(r.status).toBe(200);
});
```

`client()` is a cookie-jar HTTP client with `login()` and automatic CSRF tokens. See
[`tests/lan-modules.test.ts`](../tests/lan-modules.test.ts) for logic tests, HTTP tests, permission checks and a
live disable. Before opening a pull request, also run `node scripts/a11y-audit.mjs` against a seeded dev server
with your pages added.

## Publishing a module

1. Name the package clearly, e.g. `fragged-module-<thing>`. Set `"type": "module"` and point `"exports"` at your
   entry file.
2. Import only from `fragged-forums/sdk`, and list your SDK range in the manifest.
3. Include a README with what the module does, its permissions, settings, environment variables and data it
   stores.
4. Choose a licence. Modules bundled into a deployment are distributed together with Fragged Forums
   (AGPL-3.0-or-later), so use an AGPL-compatible licence (MIT, Apache-2.0, GPL-3.0, AGPL-3.0, …).
5. To propose a module for this repository instead, open a module proposal issue first.
