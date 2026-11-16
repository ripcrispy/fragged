# Contributing to Fragged Forums

Thanks for helping. This project is run by its community. Bug reports, fixes, features, modules, themes, docs and
design feedback are all valuable.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). **Security problems go through
[SECURITY.md](SECURITY.md), not public issues.**

## Ways to contribute

- **Report a bug** using the bug report template. Include steps to reproduce, what you expected and what happened.
- **Suggest a feature.** Say what problem it solves. Many features fit best as a module.
- **Build a module.** See [docs/MODULES.md](docs/MODULES.md). Modules can live in your own repository and be
  installed from npm. To add one to this repository, open a *module proposal* issue first.
- **Improve docs.** Small fixes can go straight to a pull request.

## Core or module?

Keep the core small. Something belongs in **core** when most communities need it, or when it is infrastructure that
modules build on (accounts, permissions, posting, messaging, moderation, the module runtime itself). Anything
optional, regional, event-specific, tied to a third-party service, or a matter of taste belongs in a **module**.

If a module needs something core doesn't offer yet (a new hook, extension point or SDK helper), propose that SDK
addition. It's usually a small, welcome change.

## Development setup

You need Node 22+ (24 recommended). PostgreSQL 17 is optional, because an embedded PostgreSQL (PGlite) is used otherwise.

```bash
npm install
```

```bash
npm run seed
```

```bash
AUTH_DEV_PROVIDER=1 npm run dev
```

To run the PostgreSQL-backed test suite, set `TEST_DATABASE_URL` in `.env` (a role that can create databases) and
run `npm run test:pg`. Browser tests need Chromium:

```bash
npx playwright install chromium
```

## Before you open a pull request

Run these. CI runs the same checks:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

For UI changes, also run the accessibility audit against a seeded dev server, and look at your change in at least
the Classic, Dark and High Contrast themes and at phone width:

```bash
node scripts/a11y-audit.mjs
```

```bash
THEMES=classic,dark,contrast PAGES=/your/page node scripts/screenshots.mjs data/shots
```

## Coding guidelines

- **TypeScript, strict mode.** No `any` in new public APIs.
- **Server-rendered first.** Every feature must work with plain HTML forms. JavaScript only enhances.
- **Layers:** routes call services; only services (and modules) touch the database. Throw `ServiceError` for
  user-facing errors.
- **Security:** check permissions on the server in every handler. Don't build HTML from strings. Use the query
  builder. Validate and cap all input. Rate-limit anything repeatable. No inline scripts or `style=""` (the CSP
  blocks them). Secrets come only from environment variables.
- **Accessibility:** semantic HTML, labelled controls, visible focus, WCAG AA contrast in every theme, and respect
  for `prefers-reduced-motion`.
- **Styling:** use the design tokens (`var(--surface)`, `var(--accent)`, …), never fixed colours, so every theme
  works.
- **Tests:** add or update tests for behaviour changes. Bug fixes should include a test that fails without the fix.
- **Database:** change `src/db/schema.ts` and run `npm run db:generate` for core migrations. Never edit a released
  migration. Modules use their own `migrations/` folder.
- **Module SDK:** changes to `src/sdk/` are public API. Additions are minor versions. Removals or changes are major
  versions and need a changelog entry with migration notes.
- **Original work only.** Don't copy code, artwork, text or branding from other forum software or communities.
  Contributions must be compatible with AGPL-3.0-or-later.
- Keep pull requests focused, and explain the *why* in the description.

## Commit messages and changelog

Write commit subjects in the imperative ("Add seat map export"). User-visible changes get a line under
**Unreleased** in [CHANGELOG.md](CHANGELOG.md).

## Licence of contributions

Fragged Forums is licensed under **AGPL-3.0-or-later**. By submitting a contribution you agree it is licensed under
the same terms, and that you have the right to submit it. No separate contributor agreement is required.
