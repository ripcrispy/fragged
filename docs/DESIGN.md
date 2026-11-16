# Design notes

## References (internal guidance only)

The archived forum pages were used solely to understand generic layout conventions; no assets, copy, names
or user content were reused, and Fragged is not presented as related to them. Observed conventions adopted:

- Dark header band with logo left and an inline sign-in form right; a separate light navigation bar of
  icon + label links; a breadcrumb strip.
- Forum index as one table per category: status icon · forum (title, description, subforums) · last post
  (avatar, thread title, author, time) · threads · posts.
- Thread lists as tables: status icon · title + starter + page shortcuts · last post · replies · views;
  stickies grouped first; pagination with a "Page x of y" label.
- Posts as rows: thin header (date, post number permalink) · author panel left (name coloured by group, title,
  avatar, join date, post count) · content right · footer with reaction tallies and Reply/Quote/Edit/Report.
- "Not logged in / no permission" page that embeds a sign-in form.

Assumptions where references don't show behaviour: unread logic (30-day window, per-thread read marker +
per-forum "mark read"), click-to-load embeds, drafts, and everything social (pane, dock, profiles) are original
designs that reuse the same table/box language.

## Tokens & themes

All colours, fonts, radii and shadows are CSS custom properties defined once per theme under
`[data-theme="…"]`; components (core and modules) only reference tokens. Classic and High Contrast are core
(`public/css/app.css`); Light, Dark and Frag come from the `theme-pack` module (`modules/theme-pack/public/themes.css`);
Millennium Desktop, Cartridge, Arcade Blue, LAN Party and Bulletin '06 come from `retro-themes`. Themes evoke eras with
original styling only (no logos, product names or trade dress),
and any module can register more (see [MODULES.md](MODULES.md#extension-points)). Dark-scheme tweaks key off
`[data-scheme="dark"]`, so new dark themes inherit them. Themes: **Classic**
(default; steel-grey with orange accent, Verdana/Tahoma at 13px), **Light**, **Dark**, **High Contrast**
(black/white/yellow, thick focus rings, underlined links), **Frag** (gunmetal plates, SVG-noise texture,
hazard-stripe header, condensed uppercase headings, orange/yellow accents).

Profile background colours never become arbitrary CSS: a validated `#rrggbb` is turned into a palette by
`profilePalette()` (text forced to black/white with ≥4.5:1 against the background and ≥7:1 against panels;
mid-tones are nudged until that holds). The palette is emitted into a nonce'd `<style>` and scoped to
`.profile-page`; navigation, notices and dialogs are unaffected.

Username colours per group come from admin-validated hex values emitted as `.gc-<id>` classes (lightened in
dark themes, replaced by the link colour in High Contrast). Icons are original inline SVG / CSS masks so they
render identically without an emoji font.

## Responsive

- Main navigation: links that don't fit on one line move into a **More** dropdown (client-side, recalculated on resize,
  font load and theme change; without JavaScript the bar wraps instead).
- ≥ 1100px: full layout with 230px friends pane.
- ≤ 900px: pane becomes an off-canvas drawer (Esc closes), index hides the last-post column, two-column pages stack.
- ≤ 640px: hamburger navigation, posts stack (compact author strip), thread tables collapse to rows,
  DM buttons open the full-screen conversation route instead of the dock.
