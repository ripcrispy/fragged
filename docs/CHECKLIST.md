# Requirements checklist

Status key: ✅ implemented and tested · 🟡 implemented, partially tested or with known limits · ⛔ blocked · ⬜ not implemented.
"Tested" means covered by `npm test` (unit/integration/HTTP against real Postgres) unless noted "browser" (verified with the Playwright QA scripts).
Last updated: 2026-11-16 (session 5: Fragged Forums open-source release, module system, LAN modules).

## Verification snapshot

- `npm run typecheck`: clean. `npm run build` → `dist/server.js` boots and serves.
- `npm test` (embedded Postgres): 126 passed, 4 skipped (server-only shared-state tests). `npm run test:pg` (PostgreSQL 17 server): 130/130.
- `npm run test:e2e` (Playwright, desktop + Pixel 7): 12/12 — live messaging, live friends pane, keyboard emoji picker, reaction picker, content gates, click-to-load embeds, posting, themes, blocking, mobile drawer/navigation.
- `scripts/a11y-audit.mjs` (axe, WCAG 2.1 A/AA): 0 violations — 16 signed-in pages + an open conversation × 10 themes, 17 guest pages, 17 admin/moderation pages (including Admin › Modules and every LAN module page, with demo data).
- `scripts/cluster-check.mjs` (two app processes, one database): cross-instance messages, presence (online and offline), settings invalidation and shared login rate limit all verified.
- Load: 2,000 members / 20,000 threads / 240,000 posts / 119,000 DMs on a modest 4-core machine — most pages 30–130 ms, home ≈130–190 ms, broad full-text search ≈200–320 ms (`scripts/bulk-data.ts`, `scripts/perf-probe.sh`).

## 1–3 Identity, design system, navigation
| Requirement | Status | Notes |
| --- | --- | --- |
| Independent branding, original logo/assets/copy/seed content | ✅ | SVG mark, generated avatars/emoji, original rules & demo threads. Provider marks not bundled (see auth). |
| Traditional dense layout, breadcrumbs, tables, post rows | ✅ browser | |
| Five themes via central tokens, persisted per user, guest default/cookie | ✅ browser | Admin sets default theme. |
| Contrast-safe profile colour | ✅ | `profilePalette`, unit-tested ≥4.5:1. |
| Shared shell: header, nav, account menu, search, notifications, pane, dock, footer, toasts | ✅ browser | Dialogs: native `<dialog>` lightbox, `confirm()` for destructive actions. |
| Empty / error / permission-denied states | ✅ | 401 pages embed a sign-in form. Regression test asserts a single site shell on error pages. |

## 4 Forum
| Requirement | Status | Notes |
| --- | --- | --- |
| Admin-managed categories/forums/subforums, order, visibility, archive, notices, moderators, permissions | ✅ | Admin › Forums; per-forum group permission matrix. View denial on a parent forum (or a hidden category) cascades to its subforums. |
| Homepage: categories, last post, counts, unread, online list, stats, activity, announcements | ✅ | |
| Forum page: subforums, sort (5 keys), tag filter, stickies/announcements, unread, page shortcuts | ✅ | |
| Create/reply/edit (revisions)/delete/restore, quote, multi-quote, react, subscribe, bookmark, permalinks | ✅ | Multi-quote via localStorage + `?quote=` ids. |
| Lock/sticky/move/merge/split, mod tools audited | ✅ | |
| Drafts | ✅ | Autosave via API; restored on new-thread/reply pages. |
| Tags, member tag creation rules, restricted tag names, admin tag management | ✅ | |
| Spoiler/NSFW/TW + admin warning labels gate content; user hide/blur prefs; excerpts never show spoilers | ✅ | "Blur" = ask-before-showing gate. |
| Held-for-moderation posts/threads | ✅ | From restricted-term `hold`. |

## 5 Accounts & auth
| Requirement | Status | Notes |
| --- | --- | --- |
| Registration with validation, duplicates, DOB/min age (configurable), timezone, terms, honeypot, rate limit | ✅ | |
| Email verification + resend, password reset, email change verification | ✅ | Tokens hashed, single-use, expiring. |
| scrypt hashing, sessions (hashed tokens), remember-me, logout, session list/revoke, security events & emails | ✅ | |
| Login throttling (failures per IP and per account) | ✅ | Shared across instances on PostgreSQL. |
| Re-authentication for sensitive operations | ✅ | Password or linked provider. |
| Groups (6 defaults + custom), central permissions, forum/user overrides | ✅ | |
| OAuth/OIDC: Google, Discord, Facebook, Apple (+GitHub), PKCE where supported, state, nonce, ID-token verification | 🟡 | Full flow tested end-to-end with the dev provider; ID-token verification unit-tested with local keys. **Not tested against the real providers — ⛔ needs client credentials.** |
| Username selection after provider auth (suggest only), linking/unlinking, no email merges, last-method guard, identity uniqueness | ✅ | |
| Bans apply to provider logins | ✅ | |
| Admin provider toggles, redirect URIs, health/failure counts, audit | ✅ | Secrets env-only. |
| Licensed provider button artwork | ⛔ | Drop official marks into `public/img/providers/`; neutral buttons until then. |
| Provider token storage/refresh/revocation | ✅ by design | Tokens are used once and never stored, so nothing to refresh or revoke. |

## 6–9 Community, friends, messaging, profiles
| Requirement | Status | Notes |
| --- | --- | --- |
| Member directory, autocomplete, case-insensitive search, discoverability privacy, clickable usernames | ✅ | |
| Friends pane (presence, unread, filter, collapse, drawer on mobile) | ✅ e2e | Presence/unread update live; friendship changes re-render the pane from `GET /api/pane`. |
| Friend requests (send/accept/decline/cancel/remove), no contradictory state | ✅ | |
| Block / mute semantics, management page | ✅ | See POLICIES.md. |
| DM dock: open from pane, reuse tab, multiple tabs, overflow, minimise, close without deleting, persisted tabs | ✅ browser | |
| DM window: text, emoji, image attachments, link/video embeds, file links, timestamps, unread, block/mute, profile, full view | ✅ | |
| Messages page with conversation list, filter, unread, full history, pagination | ✅ | |
| Append-only messages (DB trigger), idempotent sends, ordering, reconnection resync | ✅ | |
| Read receipts | ⬜ | Deliberately omitted (spec: only if reliable + privacy-aware). Unread state is implemented. |
| Profiles: avatar/cover upload with validation, crop focus, cover position, bio, pronouns, links, Spotify, Top Friends 0–5, achievements, friends-only comments, colour | ✅ | Crop is a focus choice, not a free-form cropper. |
| Profile visibility (everyone/members/friends) | ✅ | |

## 10–15 Content systems
| Requirement | Status | Notes |
| --- | --- | --- |
| Optional profanity filter (display-only) vs mandatory restricted terms | ✅ | Normalisation handles case, accents, leetspeak, look-alikes, spaced letters. |
| Term actions block/hold/flag/redact, test tool, inactive-by-default, review queue, audited | ✅ | |
| Emoji picker (custom + standard + recent + search, keyboard nav) | ✅ | Standard emoji rely on the viewer's emoji font. |
| Community emoji submission → approval/rejection/disable, limits, duplicate detection, usage counts | ✅ | GIFs re-encoded to animated WebP. |
| YouTube/Vimeo/Spotify embeds via allowlisted resolver, click-to-load, fallback link | ✅ | Unavailable videos show the provider's own error inside the player; link remains. |
| BBCode editor, preview, uploads, safe server-side renderer | ✅ | XSS/URL tests in `tests/bbcode.test.ts`. |
| Notifications (all listed kinds), dropdown, history, read state, preferences, email, mute/block suppression | ✅ | Email requires SMTP_URL in production. |
| Search: posts, threads, members, tags, author, forum, dates, relevance/latest; DMs excluded | ✅ | Postgres full-text (English). |

## 16–17 Privacy, moderation, admin
| Requirement | Status | Notes |
| --- | --- | --- |
| Reports queue, warnings, suspensions, bans, notes, held content, term matches, emoji queue | ✅ | |
| Audited reported-DM review + hide | ✅ | |
| Admin: dashboard, forums, tags, users/groups/permissions, terms, emoji, achievements, rules & pages, settings (registration, uploads, security, maintenance, theme default, email), providers, audit & security logs | ✅ | |
| Audit log & security events: plain-language dropdown filters (area/type, action/event, who, affected item/member, importance, sign-in method, dates, IP, detail text), combinable with removable chips, quick presets, filter-by-this buttons, 24-hour overview, expandable details, CSV export (audited, formula-safe) | ✅ | `tests/logs.test.ts`; works without JavaScript; shareable URLs. |
| Account closure | ✅ | Full erasure is a manual admin process (documented). |

## 19–22 Security, accessibility, performance
| Requirement | Status | Notes |
| --- | --- | --- |
| CSP with nonces, no inline styles/scripts, frame allowlist, nosniff, frame-ancestors none, HSTS (prod) | ✅ | |
| CSRF (token + Origin), SameSite cookies, body limit, rate limits | ✅ | |
| SQL injection (parameterised Drizzle), XSS (escaping renderer), SSRF (no server-side fetching of user URLs) | ✅ | |
| Upload hardening (content sniffing, re-encode, metadata strip, bomb limits, served from outside web root with sandbox CSP) | ✅ | |
| Accessibility: semantic HTML, skip link, labels, focus rings, keyboard menus/picker, reduced motion, non-colour status | ✅ axe + e2e | axe clean in all themes; keyboard picker covered by e2e. A manual screen-reader pass is still recommended. |
| Indexed queries, batched user cards, cursor-paged messages | ✅ | Thread/forum listings use offset paging (fine at forum scale). |
| Multi-instance readiness | ✅ cluster-check | On PostgreSQL: LISTEN/NOTIFY bus for events, presence and cache invalidation; shared rate limits and view de-dup. |
| Object storage driver | ⬜ | Local disk driver behind a `storage` interface; several instances need a shared uploads directory. |

## Added in session 5
| Requirement | Status | Notes |
| --- | --- | --- |
| Rebrand to Fragged Forums, remove previous identity | ✅ | No previous-brand strings in tracked files. |
| Open-source licence | ✅ | AGPL-3.0-or-later (`LICENSE`, `package.json`); all runtime dependencies are MIT/ISC/Apache-2.0/0BSD/MIT-0/LGPL-3.0, which are compatible. `SOURCE_URL` footer link for §13. |
| Repository docs | ✅ | README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, issue forms (bug, feature, module/SDK proposal), PR template, docs/MODULES.md, a README per module. |
| Module system: manifest, deps/semver/conflicts, lifecycle, migrations, permissions, settings, hooks, extension points, inter-module APIs, live toggle across instances | ✅ | `tests/modules.test.ts` (resolution, lifecycle, live toggle, hook isolation/veto, settings validation, admin page, SDK import boundary, generated index). |
| Third-party npm modules | 🟡 | `fragged.config.json` + `fragged-forums/sdk`; verified manually with a throwaway package in dev and in the production bundle (single SDK instance). No automated test yet. |
| Core features extracted to modules | ✅ | theme-pack, media-embeds, profile-spotify, achievements, oauth-providers, dev-auth. |
| LAN party seat booking | ✅ browser | Layout parser, one seat per member, race-safe booking, reserved/blocked seats, booking windows, organiser assign/move, live map, table view. `tests/lan-modules.test.ts`. |
| LAN party intranet | ✅ browser | Configurable sections/order, announcements with schedule window, countdown, schedule, Wi-Fi/info BBCode, audience; TCP / Source A2S (challenge) / Minecraft SLP probes with timeouts and size caps (tested against local fake servers). |
| Pizza ordering | ✅ browser | Menu with diet labels, one editable order per member, price snapshots, paid-order lock (race-safe), cash tick-off with audit + notifications, shopping list (paid/unpaid), status flow with notifications, handed-out tracking, helper permission, intranet widget. |
| Retro themes | ✅ browser | Five themes; all pass the axe audit. |
| Caffeine tracker | ✅ browser | ~30 drinks with typical published caffeine values, absorption + half-life model, 9 playful levels to "GO TO HOSPITAL", now/24 h/event boards, opt-out, limits, rate limit, admin catalogue, disclaimer. |

## Added in session 4
- Rebuilt audit log and security event viewers (see Admin table above); new indexes on audit actor and action.

## Fixed in session 3
- Presence leak: a browser that disconnected while its event stream was starting (e.g. the redirect right after login) stayed "online" forever. Disconnect handling is now registered before subscribing.
- Reaction picker was clipped by the post box; it now opens upwards and fully visible.
- Buttons on header bars (Mute/Block/View profile in conversations) were unreadable in dark header themes.
- Links in posts/messages relied on colour alone; video "click to load" buttons had mismatched accessible names; file-type badges lacked contrast.
- Cross-origin check now supports an explicit `ALLOWED_ORIGINS` list (for LAN/hostname access) and logs rejected origins; wildcards are refused.
- Home statistics cached for 60 s; search result counts capped at "1,000+".

## Fixed in session 2
- Error pages (401/403/404/500/maintenance) rendered a second header and footer inside the page.
- Subforums did not inherit a parent forum's view denial; hidden categories didn't hide their forums from direct links.
- Images attached to deleted/held posts stayed viewable by members.
- Lifting a ban redirected to the unchecked `Referer` header.
- Login rate limit counted successful logins (locked out shared IPs); now failures only.
- Accessibility: badge/flag/rarity contrast, links distinguishable in running text, profile palette applied to all text tokens, ARIA roles on labelled containers, editor button names.

## Next tasks
1. Sign-in providers: obtain credentials and test Google/Discord/Facebook/Apple against the real services (deferred by the product owner).
2. Manual screen-reader pass (NVDA/VoiceOver) of posting, the dock and the emoji picker.
3. S3-compatible upload storage driver (only needed for multi-host deployments without a shared disk).
4. Push the repository to a Git host to activate the CI workflow in `.github/workflows/ci.yml`; enable private vulnerability reporting; set `SOURCE_URL`.
5. Automated test for an npm-packaged module (fixture package under `tests/fixtures`).
6. Optional: a `npm run module:new <id>` scaffold.
