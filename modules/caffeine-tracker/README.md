# Caffeine tracker

A playful LAN-party leaderboard. Members log what they drink from a catalogue of typical caffeine amounts, and an
estimate of the caffeine currently in their system decays over time. Levels run from **Decaf Ghost** through
**Buzzing** and **DANGEROUS** to **GO TO HOSPITAL**.

> Just for fun, not medical advice. The page says so, links the ~400 mg/day guideline, and shows a "drink water"
> notice at the danger levels.

- **Page:** `/m/caffeine-tracker`: your level, an 18-hour chart (12 h history plus a 6 h forecast), a log form and
  your recent drinks, plus leaderboards for *right now*, *last 24 hours*, *whole event* (or all time) and *drink of
  choice*
- **Profile:** current level (unless the member opted out)
- **Admin:** Admin › Caffeine drinks (add, edit mg, hide, reload defaults)
- **Navigation:** "Caffeine" in the main menu

| Permission | Default |
| --- | --- |
| `caffeine-tracker.view`: see leaderboards | guests, members |
| `caffeine-tracker.log`: log drinks | members |
| `caffeine-tracker.manage`: edit the drinks catalogue | administrators |

## The model

Each drink is absorbed linearly over the *absorption time* (default 30 min), then eliminated with first-order
kinetics using the configured *half-life* (default 5 h, typical for healthy adults is 3–7 h). The "right now" board
uses this estimate. The 24-hour and event boards total the milligrams logged.

The catalogue starts with about 30 common drinks (espresso 63 mg, brewed coffee 95 mg per 240 ml, Red Bull 80 mg per
250 ml, Monster 160 mg per 500 ml, Club-Mate 100 mg per 500 ml, cola, tea, tablets…) taken from typical label and
published values. Real products vary by brand, size and region, so admins can adjust them. Members can log "something
else" with the amount from the label (up to 500 mg per serving).

## Fair play and privacy

- Servings from 0.5 to 5, back-dating up to 24 h, at most 1,500 mg per entry, and 20 entries per hour.
- Members can remove their own entries and **hide themselves** from all leaderboards and their profile.
- Closing an account deletes that member's logs.

## Settings

Half-life (2–10 h), absorption time (0–120 min), event start and timezone (for the "whole event" board), and
leaderboard length.

**Data:** `mod_caffeine_drinks`, `mod_caffeine_logs`, `mod_caffeine_prefs`. **Exposes** `leaderboard(kind, limit)`
(used by `lan-intranet`).
