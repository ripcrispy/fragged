# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).
The module SDK has its own version (`SDK_VERSION`, see [docs/MODULES.md](docs/MODULES.md#compatibility-and-versioning)).

## Unreleased

### Added
- **Open-source release as Fragged Forums**, licensed AGPL-3.0-or-later, with contributor docs, a security policy
  and issue templates.
- **Module system and SDK 1.0.0**: a versioned public SDK; module manifests with dependencies, optional dependencies,
  conflicts and SDK ranges; lifecycle (`setup`, `start`, `stop`, `onInstall`, `onUpgrade`, `onEnable`, `onDisable`);
  per-module SQL migrations, permissions, validated settings, notification kinds and static assets; action and
  filter hooks; extension points for themes, sign-in providers, media providers, profile sections, profile
  settings, navigation, admin pages, moderation queues and member admin panels; inter-module APIs
  (`expose`/`use`); and Admin › Modules to enable, disable and configure modules live on every instance.
- Third-party modules from npm via `fragged.config.json` (import the SDK as `fragged-forums/sdk`).
- `SOURCE_URL` setting that adds a "Source code" footer link (AGPL §13).
- Bundled modules extracted from the core: `theme-pack`, `media-embeds`, `profile-spotify`, `achievements`,
  `oauth-providers`, `dev-auth`.
- New LAN-party modules: `lan-seating` (seat maps and booking), `lan-intranet` (announcements, countdown,
  game-server status, schedule, Wi-Fi), `caffeine-tracker` (caffeine leaderboard with half-life decay) and
  `lan-pizza` (group food orders paid in cash, with payment tracking, shopping list and arrival notifications).
- `lan-bookings` module: bookings for LAN events with customisable booking types (e.g. standard and high-speed
  network seats) tied to areas of the seat map, interest tracking with a demand dashboard and CSV export, event
  rules and terms members agree to, an event crew list, and a sticky forum announcement thread with a live panel
  (rules, crew, who has booked with their seat, sub-events, game servers and the seat map). The LAN Event Access door
  desk lists booked members, checks them in and charges their booking price.
- **SDK 1.1.0**: `services.forums` (start threads and make them sticky as the viewer, with every core check) and
  the `threadPanel` extension point.
- `lan-seating` 1.1.0: seat policies other modules can register, plus more of its API exposed. `lan-intranet` 1.2.0
  exposes its schedule and game servers.
- `lan-event-access` module: a door desk that records entry payments and approves attendees' devices on the
  firewall, moving them from a staging DHCP range to the LAN. Supports OPNsense (Kea, Dnsmasq, legacy ISC via a
  firewall alias) and pfSense (REST API package), with a demo mode.
- `retro-themes` module: Millennium Desktop, Cartridge, Arcade Blue, LAN Party and Bulletin '06 themes.
- `pizza` main-navigation icon.

- Main navigation moves links that don't fit on one line into an accessible **More** menu (phones keep the
  hamburger menu).
- README logo (`docs/assets/logo.svg`) and screenshots.

### Fixed
- The "Sticky:" label in thread lists now meets colour-contrast requirements on the highlighted row.
- Theme preview in Settings › Preferences now works for themes provided by modules, and updates the light/dark scheme.
- Browsers could keep old scripts and stylesheets after an upgrade: core assets are now versioned by content hash and
  module stylesheets by module version.
- "Create an account" button in the guest Community pane is aligned with the text.

### Changed
- Achievements, the Dark, Light and Frag themes, media embeds, Spotify-on-profile and third-party sign-in now ship
  as modules. Behaviour is unchanged when they are enabled (the default). `/achievements` redirects to
  `/m/achievements`.
- OAuth provider credentials are read by the `oauth-providers` module from the same `OAUTH_*` environment
  variables.
