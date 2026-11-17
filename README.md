<div align="center">

<img src="docs/assets/logo.png" alt="Fragged Forums" width="420">

**An open-source, retro-style forum and social platform on a modern stack.**

<!-- After publishing to GitHub, add the CI badge (replace OWNER/REPO):
[![CI](https://img.shields.io/github/actions/workflow/status/OWNER/REPO/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
-->
[![Licence: AGPL-3.0-or-later](https://img.shields.io/badge/licence-AGPL--3.0--or--later-e8772e)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![PostgreSQL 15+](https://img.shields.io/badge/PostgreSQL-15%2B-4169e1?logo=postgresql&logoColor=white)](docs/DEPLOYMENT.md)
[![Hono](https://img.shields.io/badge/Hono-SSR%20JSX-e36002?logo=hono&logoColor=white)](https://hono.dev)
<br>
[![Module SDK 1.0.0](https://img.shields.io/badge/module%20SDK-1.0.0-2f7a3e)](docs/MODULES.md)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG%202.1-AA-1f5a96)](docs/DESIGN.md)
[![Runs in 1 GB RAM](https://img.shields.io/badge/runs%20in-1%20GB%20RAM-a22846)](#requirements)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

[Features](#features) · [Screenshots](#screenshots) · [Requirements](#requirements) · [Quick start](#quick-start) · [Writing modules](docs/MODULES.md) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

</div>

---

Fragged Forums brings back the compact, information-dense layout of classic community forums (categories, forums,
threads, signatures, profiles with a personality). It adds the social features people expect now: friends, live
direct messages, reactions, community emoji, rich profiles and real moderation tools. It is server-rendered, works
without JavaScript, is accessible (WCAG 2.1 AA, checked in CI) and runs comfortably on modest hardware.

Everything optional is a **module**. Ten themes, sign-in providers, media embeds, achievements and even a LAN-party
toolkit plug in through a documented, versioned SDK, so you can add, replace or remove features without touching the
core.

> Licence: **AGPL-3.0-or-later**. If you run a modified version for others, you must offer them your source (set
> `SOURCE_URL`; see [Licence](#licence)).

## Features

**Core**
- Categories, forums and sub-forums; threads with stickies, announcements and locks; move, merge and
  split.
- BBCode editor with live preview, quotes, spoilers, code, colour, click-to-load media embeds and link cards.
- Tags and content-warning labels (spoilers, NSFW, sensitive topics) that readers opt into.
- Polls on threads, with single or multiple choice, closing times and hidden-until-voted results (`polls` module).
- Profiles with avatars, cover images, accent colour, signatures, Top Friends, friends-only comments and privacy
  controls.
- Friends, blocking and muting; a live friends pane with presence.
- Persistent direct messages in a bottom dock, with image attachments and per-conversation mute. Messages can't be
  edited; senders can erase them, except in a conversation under report.
- Your data: members download everything held about them as JSON, erase chosen parts, or delete their account.
  The last full administrator must hand over before leaving.
- Community emoji and GIF submissions with an approval queue.
- Notifications (in-app and real-time), subscriptions, bookmarks and full-text search.
- Moderation: reports, held-content queues, warnings, suspensions and bans, moderator notes, mandatory restricted
  terms, and an optional per-reader profanity mask.
- Administration: groups and permissions (global, per-forum, per-member), site settings, pages and rules, and a
  filterable audit log and security-event log.
- Security: CSP with nonces, CSRF and origin checks, scrypt password hashing, OAuth/OIDC with PKCE, rate limits
  and session management.
- Scales out: several instances coordinate through PostgreSQL (LISTEN/NOTIFY, shared rate limits). No Redis
  needed.

**Bundled modules** (each can be turned on or off in Admin › Modules)

| Module | What it adds | Default |
| --- | --- | --- |
| [`theme-pack`](modules/theme-pack) | Dark, Light and Frag themes (Classic and High Contrast are core) | on |
| [`retro-themes`](modules/retro-themes) | Millennium Desktop, Cartridge, Arcade Blue, LAN Party and Bulletin '06 themes | on |
| [`media-embeds`](modules/media-embeds) | YouTube, Vimeo and Spotify click-to-load embeds | on |
| [`profile-spotify`](modules/profile-spotify) | A Spotify track or playlist on member profiles | on |
| [`achievements`](modules/achievements) | Configurable badges awarded for activity | on |
| [`polls`](modules/polls) | Polls on forum threads: single or multiple choice, closing times, results after voting or closing | on |
| [`oauth-providers`](modules/oauth-providers) | Sign in with Google, Discord, Facebook, Apple, GitHub (when configured) | on |
| [`dev-auth`](modules/dev-auth) | A fake identity provider for testing sign-in flows (development only) | on |
| [`lan-seating`](modules/lan-seating) | LAN-party seat maps and seat booking | off |
| [`lan-bookings`](modules/lan-bookings) | LAN event bookings: custom booking types tied to the seat map, interest tracking, and a sticky forum announcement thread | off |
| [`lan-intranet`](modules/lan-intranet) | Event-day page: announcements, countdown, live game-server status, schedule, Wi-Fi | off |
| [`caffeine-tracker`](modules/caffeine-tracker) | A playful caffeine leaderboard, from "Decaf Ghost" to "GO TO HOSPITAL" | off |
| [`lan-pizza`](modules/lan-pizza) | Group food orders: members order, pay organisers in cash, organisers tick it off and order by hand | off |
| [`lan-event-access`](modules/lan-event-access) | Door-desk network access: confirm entry payment, then move the device from the staging DHCP range onto the LAN (OPNsense, pfSense) | off |

## Screenshots

<p align="center">
  <img src="docs/assets/screenshot-home.jpg" alt="Fragged Forums home page in the Classic theme: categories with forums, last-post column and the friends pane" width="860">
</p>
<p align="center">
  <img src="docs/assets/screenshot-themes.jpg" alt="The same thread in four themes: Frag, LAN Party, Millennium Desktop and Arcade Blue" width="860">
  <br><sub>One thread in four of the ten themes: Frag, LAN Party, Millennium Desktop and Arcade Blue.</sub>
</p>

<details>
<summary><strong>Profiles and messaging</strong> (3 screenshots)</summary>
<br>

**Profile**: avatar, cover, pronouns, statistics, achievements, LAN seat, Top Friends and profile comments.

<img src="docs/assets/profile.jpg" alt="A member profile with cover image, avatar, statistics, achievements, LAN seat, Top Friends, recent posts and profile comments" width="860">

**Chat dock**: start a conversation from the friends pane, and it opens in a dock that follows you around the site.

<img src="docs/assets/messages-dock.jpg" alt="The forum index with a direct-message window open in the bottom dock, showing a conversation with a file link card" width="860">

**Full conversation view**: history, link cards, click-to-load video embeds, emoji, image attachments, mute and block.

<img src="docs/assets/messages-conversation.jpg" alt="The messages page with the conversation list and a full conversation including a video embed and file link cards" width="860">

</details>

<details>
<summary><strong>LAN party toolkit</strong> (10 screenshots)</summary>
<br>

**LAN HQ intranet**: a countdown in the page banner, announcements, live game-server status, schedule, seat bookings, the pizza run, the caffeine leaderboard, Wi-Fi details and house rules.

<img src="docs/assets/lan-intranet-v2.jpg" alt="The LAN HQ page with a countdown to doors opening in the banner, announcements, game-server status, a row of schedule, seating and pizza-run cards, a row of caffeine leaderboard and Wi-Fi cards, and house rules" width="860">

**Seat booking**: click a free seat to book it. Friends are highlighted and organisers can reserve seats.

<img src="docs/assets/lan-seating.jpg" alt="An interactive seat map with booked, free, reserved and unavailable seats and a legend" width="860">

**LAN event bookings, announced in the forums**: a sticky thread with a live panel: the event rules and terms, the crew who'll be there, who has booked each booking type with their seat, what's on, the game servers and the seat map. Members can reply as usual.

<img src="docs/assets/lan-bookings-thread.jpg" alt="A sticky forum thread announcing Frag Night 01, with a live booking panel above the posts showing the event rules and terms, the event crew grouped by role, who has booked each booking type with their seat, the members who are interested, the sub-events, the game servers and a seat map with the high-speed row outlined" width="860">

**Booking page**: customisable booking types such as a standard seat, a high-speed network seat or a spectator ticket. Book a place and agree to the rules, or just register your interest.

<img src="docs/assets/lan-bookings-page.jpg" alt="The booking page for Frag Night 01 with booked and interested counts, the member's registered interest, cards for three booking types with prices and places left, the event rules and terms, and forms to book a place or update their interest" width="860">

**Organiser dashboard**: bookings and interest per booking type against the places available, and sign-ups per day.

<img src="docs/assets/lan-bookings-admin.jpg" alt="The LAN bookings organiser page with booked, interested, places and seats-picked totals, a demand bar per booking type, a chart of sign-ups per day for the last three weeks, and the booking page settings" width="860">

**Caffeine tracker**: log real drinks, watch your level decay, and top the leaderboard (responsibly).

<img src="docs/assets/lan-caffeine.jpg" alt="The caffeine tracker with your current level, a drink logging form and leaderboards with levels such as Buzzing and SEEING SOUND" width="860">

**Pizza orders**: members pick from the menu, then pay an organiser in cash.

<img src="docs/assets/lan-pizza.jpg" alt="The pizza ordering page with a menu grouped into pizzas, sides and drinks, vegetarian and vegan labels, and quantity boxes" width="860">

**Organiser view**: cash collected, the shopping list to phone through, and one-click payment and hand-out tracking.

<img src="docs/assets/lan-pizza-organiser.jpg" alt="The organiser screen for a pizza run with cash totals, a shopping list split by paid and unpaid, and an orders table with payment buttons" width="860">

**Event access door desk**: new devices wait on the staging network until the desk confirms payment, then one click moves them onto the LAN through your OPNsense or pfSense firewall. Booked members are listed with their booking, seat and whether they've arrived.

<img src="docs/assets/lan-event-access-desk-v2.jpg" alt="The Event access door desk with devices waiting on staging addresses, the members booked for Frag Night 01 with their booking type, price, seat and whether they have arrived and paid, approved devices with their LAN address and an On the LAN status, and attendee payments by card and cash" width="860">

**Approving a device**: pick a booked member to charge their booking price, or take the entry fee from a walk-in, then approve.

<img src="docs/assets/lan-event-access-approve-v2.jpg" alt="The approve-a-device form with the device's name, MAC and staging address, a booked member chosen under Who is this device for, their 30 pound booking price filled in, the payment method and a Payment received tick" width="860">

</details>

<details>
<summary><strong>Administration and moderation</strong> (5 screenshots)</summary>
<br>

**Admin dashboard**: site totals, open reports and active bans at a glance, plus the latest privileged actions.

<img src="docs/assets/admin-dashboard.jpg" alt="The admin dashboard with totals for members, threads, posts, direct messages, open reports, active bans and stored images, and a list of recent privileged actions with who did them" width="860">

**Audit log**: every privileged action by staff and modules, with who did it, what it affected, the details and the IP address. Filter by area, action, person, affected member or date (or click any filter icon in the table), use the quick filters, and download the results as CSV. Entries can't be edited or removed from here.

<img src="docs/assets/admin-audit-log.jpg" alt="The audit log with quick filters, filter fields for area, action, who did it, what was affected and dates, and a table of entries such as enabling a module, warning a member, locking a thread and LAN Event Access payments and approvals" width="860">

**Security events**: sign-ins and sign-outs, failed sign-ins, password resets and session activity, with the device and IP. Warnings are highlighted, and the last 24 hours are summarised at the top.

<img src="docs/assets/admin-security-events.jpg" alt="The security events log with a last-24-hours summary of sign-ins, failed sign-ins, sign-outs, password reset requests and sessions signed out, filters, and a table of events with the member, method, IP address and device; failed sign-ins are highlighted in red" width="860">

**Reports queue**: members report posts, threads, profiles and messages with a reason; moderators resolve or dismiss them with a note.

<img src="docs/assets/mod-reports.jpg" alt="The moderation reports queue with two open reports, each showing the reported post, its author, the reason and the member's note, who reported it, and resolve or dismiss buttons" width="860">

**Member moderation**: warn, suspend or ban a member and keep private staff notes, with their warnings, suspensions, notes and audit trail in one place.

<img src="docs/assets/mod-member.jpg" alt="The moderation page for a member with forms to warn, suspend or ban and add a private note, and a history showing a warning issued by a moderator and the matching audit-trail entry" width="860">

</details>

## Stack

Node 24 · TypeScript · [Hono](https://hono.dev) with server-rendered JSX · [Drizzle ORM](https://orm.drizzle.team) ·
PostgreSQL 17 (or embedded [PGlite](https://pglite.dev) for development and tests) · Server-Sent Events · sharp ·
arctic and jose (OAuth/OIDC) · zod · Vitest · Playwright and axe-core.

A single process, with no framework on the client (≈32 KB of progressive enhancement) and no build step in
development.

## Requirements

### Software

| | Minimum | Tested with |
| --- | --- | --- |
| Node.js | 22 | 24 LTS |
| PostgreSQL (production) | 15 | 17 |
| PostgreSQL (development and tests) | optional: an embedded PostgreSQL (PGlite) is used when `DATABASE_URL` isn't set | |
| Operating system | any 64-bit system that runs Node.js 22+ (Linux, macOS or Windows; x86-64 or ARM64) | Linux |
| Reverse proxy (production) | anything that terminates HTTPS and passes Server-Sent Events unbuffered (nginx, Caddy…) | nginx |
| SMTP server (production) | any provider, for verification, password-reset and security emails | |

Fragged Forums is a single Node.js process with no platform-specific code, so it runs wherever Node.js and PostgreSQL
do: a physical server, a virtual machine, a container, a cloud instance or your own computer. Use whatever
infrastructure you already have.

### Server hardware

| | Minimum (small community) | Recommended |
| --- | --- | --- |
| CPU | 2 cores, 64-bit | 4 cores |
| Memory (app + PostgreSQL + OS) | 1 GB | 2 GB or more |
| Disk | 2 GB free (app, dependencies, database), plus room for uploads | SSD with 10 GB+ free |

Measured on the production build: the app uses about **250 MB of memory idle and 290 MB under load**, the bundle is
2.5 MB, and runtime dependencies take about 85 MB. With 2,000 members, 240,000 posts and 119,000 direct messages,
a modest 4-core machine served most pages in **30–130 ms**. Several instances can share one PostgreSQL
database when you need more capacity (see [Deployment](docs/DEPLOYMENT.md)).

### Development extras

- About 250 MB for all dependencies (`npm install`).
- About 700 MB more for the Chromium build used by the browser tests (`npx playwright install chromium`).
  You only need it for `npm run test:e2e`, the accessibility audit and screenshots.

### Browsers

Every feature works with plain HTML forms, so the site stays usable without JavaScript. The interface is built from
standard HTML and CSS with no client framework. The automated browser and accessibility suites run in Chromium, at
desktop and phone sizes. Other current browsers (Firefox, Safari, Edge) are expected to work but aren't covered by
automated tests yet.

## Quick start

See [Requirements](#requirements). PostgreSQL is optional for development.

Clone the repository, then from its folder:

```bash
npm install
```

```bash
npm run seed
```

```bash
AUTH_DEV_PROVIDER=1 npm run dev
```

Open <http://localhost:3000>. Demo accounts share the password `fragged-demo-pass` (override with
`DEMO_PASSWORD`): `Overseer` (administrator), `Vexa` (moderator), `PixelWren`, `bitcrusher`, `Lowpoly_Lou`,
`NullSector`, `quietkeys`, `Marrow`, `gravwell`.

To try the LAN-party modules with sample data:

```bash
npx tsx scripts/demo-lan.ts
```

Without `DATABASE_URL`, data lives in an embedded PostgreSQL (PGlite) under `data/pglite`. Mail is written to
`data/mail/*.eml` when `SMTP_URL` isn't set. Copy [`.env.example`](.env.example) to `.env` for everything else.
Opening the dev server from another device on your network? Add its address to `ALLOWED_ORIGINS`.

## Documentation

| | |
| --- | --- |
| [Writing modules](docs/MODULES.md) | The module SDK: manifest, lifecycle, hooks, extension points, security rules |
| [Architecture](docs/ARCHITECTURE.md) | How the core is put together |
| [Deployment](docs/DEPLOYMENT.md) | Production setup: PostgreSQL, systemd, nginx, scaling, backups |
| [Policies](docs/POLICIES.md) | Content, moderation and privacy behaviour |
| [Design notes](docs/DESIGN.md) | Visual identity, themes and accessibility |
| [Feature checklist](docs/CHECKLIST.md) | Requirements and their status |
| [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md) | |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with reload |
| `npm run build` / `npm start` | Production bundle (`dist/server.js`, `public/js/app.js`) / run it |
| `npm test` | Unit and integration tests on embedded PostgreSQL |
| `npm run test:pg` | The same against a PostgreSQL server (`TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright browser suite, desktop and mobile |
| `node scripts/a11y-audit.mjs` | axe-core WCAG 2.1 AA audit across pages and themes (needs a seeded dev server) |
| `npm run typecheck` | TypeScript check |
| `npm run modules:sync` | Re-scan installed modules (runs automatically before dev, test and build) |
| `npm run seed` | Demo content (refuses in production) |
| `npm run create-admin -- <username> <email>` | Create or promote an administrator |
| `npm run db:generate` | Generate a core migration after editing `src/db/schema.ts` |
| `node scripts/screenshots.mjs <dir>` | Headless screenshots for visual QA (`THEMES=`, `PAGES=`, `MOBILE=1`) |

## Repository layout

```
src/            the core application
  sdk/          the public module SDK: the only API modules may import
  modules/      module runtime: loading, dependencies, migrations, registries, hooks
  services/     domain logic (the only layer that touches the database)
  routes/       HTTP handlers and pages
  web/          layout, components, themes, navigation
  client/       progressive-enhancement browser bundle
modules/        bundled optional modules, one folder each
drizzle/        core SQL migrations
tests/ e2e/     Vitest and Playwright suites
docs/           documentation
deploy/         systemd unit and nginx example
```

## Contributing

Bug reports, features, modules, themes and documentation fixes are all welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## Licence

Fragged Forums is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License](LICENSE), version 3 or (at your option) any later version.

In short: you may use, study, change and share it. If you run a **modified** version as a network service, you must
offer its users the source of your version. Set `SOURCE_URL` to where it can be downloaded and a "Source code" link
appears in the footer. Third-party modules bundled into a deployment should use an AGPL-compatible licence.

Fragged Forums is an independent project. Third-party names (Google, Discord, YouTube, Spotify, Minecraft and so on)
are used only to describe interoperability and belong to their owners. Caffeine figures in the caffeine tracker are
typical published values, and the module is for fun, not health advice.
