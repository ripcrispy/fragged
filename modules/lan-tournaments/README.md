# LAN tournaments

Run gaming tournaments on the forum, from sign-up to final results: solo or team registration, every common
bracket format, score reporting with confirmation and disputes, a live spectator screen, results, a ranking
leaderboard and achievements. It works on its own, and ties into the LAN modules when they are enabled.
Every page works without JavaScript; scripts only add conveniences (auto-refresh, fullscreen, highlighting).

- [Installation](#installation)
- [Formats](#formats)
- [Running a tournament](#running-a-tournament)
- [Registration and teams](#registration-and-teams)
- [Matches, scores and disputes](#matches-scores-and-disputes)
- [Live view](#live-view)
- [Results, leaderboard and achievements](#results-leaderboard-and-achievements)
- [Permissions and roles](#permissions-and-roles)
- [LAN integration](#lan-integration)
- [Notifications](#notifications)
- [Templates and example configs](#templates-and-example-configs)
- [Pages and JSON endpoints](#pages-and-json-endpoints)
- [Privacy and data](#privacy-and-data)

## Installation

The module ships with Fragged Forums and is **off by default**.

1. Sign in as an administrator and open **Admin › Modules**.
2. Enable **LAN tournaments**. Its migrations run on enable; nothing else is needed.
3. Optionally enable `lan-seating`, `lan-bookings`, `lan-intranet` and `achievements` for the
   [LAN integration](#lan-integration) and badges. Each one is optional and can be turned on or off at any time.
4. Grant `lan-tournaments.create` to the groups who may organise tournaments (Admin › Groups & permissions).
   Members can see and enter tournaments by default.

**Requirements:** SDK `^1.4.0` (Fragged Forums with `media.upload`). Optional versions: `lan-seating ^1.2.0`,
`lan-bookings ^1.3.0`, `lan-intranet ^1.3.0`, `achievements ^1.2.0`.

**Upgrading or removing:** disabling the module hides its pages and stops reminders; data stays in its
`mod_lan_tournaments_*` tables until the module is uninstalled.

## Formats

| Format | How it works | Options |
| --- | --- | --- |
| Single elimination | Lose once and you're out. Byes go to the top seeds when the field isn't a power of two. | best-of, finals best-of, 3rd-place match |
| Double elimination | Winners' and losers' brackets and a grand final. | best-of, finals best-of, grand-final reset |
| Round robin | Everyone plays everyone once. Table by points, then score difference, then score for. | points for win / draw / loss, draws allowed |
| Swiss | A fixed number of rounds; each round pairs players on the same score who haven't met. Ranked by points, then Buchholz. | rounds (default ⌈log₂ entries⌉), points, draws |
| Group stage, then playoffs | Round-robin groups (snake-seeded), then the top N of each group go into a single- or double-elimination playoff, seeded so group winners avoid each other. | groups, advance per group, playoff type |
| Free-for-all heats | Racing or battle-royale style: heats of up to N entries over several rounds, points per placing. | rounds, heat size, points per place |
| Time or score challenge | Members submit their best time or score, optionally with proof; referees approve attempts. | higher or lower wins, points or time, attempts need approval |

Best-of can be 1, 3, 5 or 7. Seeding is by registration order, random or manual (seed numbers on the manage page).
The bracket engine (`formats.ts`) is pure and fully tested: byes and walkovers advance automatically, and
empty slots in the losers' bracket resolve themselves.

## Running a tournament

1. **Create** at **Tournaments › New tournament**, optionally starting from a [template](#templates-and-example-configs).
   The creator becomes the tournament's organiser. Set the game, platform, banner image, description and rules
   (BBCode), visibility, team size, entry cap, approval, check-in, LAN event and dates, and the format options.
2. **Statuses:** Draft → Registration open → Registration closed → In progress → Completed (or Cancelled). Drafts
   are only visible to staff. Tournaments can be archived to hide them from the listing.
3. **Registration:** members register or build a team; staff approve if approval is on, invite members, and can
   add a participant directly (skipping the window, cap and invitations).
4. **Participants:** set seeds and stations (PC or console names), check people in, and remove entries before
   the bracket is drawn.
5. **Bracket:** generate it once registration is closed. Before any result, staff can swap two entries or reset
   and regenerate. Swiss and free-for-all rounds and group playoffs are generated automatically as rounds finish.
6. **Schedule:** set a time and station per match, or schedule a whole round at once with a gap between matches.
   Mark matches live as they start.
7. **Results:** scores come in from players or staff (below). When the last match is final the tournament
   completes; staff review the standings and **publish results**, which records places and ranking points.

All staff actions are recorded in the site audit log (`lan-tournaments.*`).

## Registration and teams

- **Solo:** one click to register; withdraw any time before the bracket is generated.
- **Teams:** a member creates a team (name and tag), becoming captain, and invites members by name. Invitees
  accept or decline from their notifications. Pending invites count towards the team size, so a team can't be
  over-filled. Captains can hand over the captaincy, remove members and disband the team; then register the team
  once it has at least the minimum number of players. Substitutes up to the configured number are allowed.
- **Rules that apply:** registration window, entry cap (checked under a lock, so two people can't take the last
  place), invitation-only and private tournaments, approval, required LAN booking, and one entry per member per
  tournament (enforced in the database).
- **Check-in:** when required, players check in from the tournament page once check-in opens; staff can also
  check people in. Entries that don't check in are left out when the bracket is generated.

## Matches, scores and disputes

- **Reporting:** either side (a captain for teams) reports the score: games won for best-of-N, or the raw score
  for best-of-1. The other
  side **confirms** it, or **disputes** it with a reason. When both sides report the same result it is confirmed
  automatically; different results become a dispute.
- **Staff:** referees and organisers can report a final score directly, resolve disputes by setting the result,
  and **override** a finished match. An override is allowed while the matches that depend on it are unplayed;
  winners are re-routed through the bracket.
- **Free-for-all:** staff enter placings for each heat; points are added up into the table.
- **Time challenges:** members submit attempts with an optional proof link; with verification on, referees approve
  or reject each one. Staff end the challenge to finalise the ranking.
- **Safety:** results are written in a transaction that locks the stage's matches, and each form carries the
  match's version, so two people submitting at once can't corrupt the bracket. Duplicate submits are rejected.

## Live view

`/m/lan-tournaments/<slug>/live` is a spectator page for a big screen: current and next matches with stations,
the bracket or table, progress, and announcements. It refreshes every 10 seconds and has a fullscreen button.
On the tournament page, hovering an entry highlights all of its matches in the bracket.

## Results, leaderboard and achievements

- **Standings** per format (bracket depth for eliminations, points tables for round robin, swiss and heats, best
  attempt for challenges), with medals for the top three.
- **Publishing** stores each member's place and ranking points (configurable per place, plus participation points).
- **Leaderboard** at `/m/lan-tournaments/leaderboard`: points, titles, podiums, tournaments played and match record
  across all published tournaments.
- **Profiles** show a Tournaments section with titles, podiums and recent results.
- **Achievements** (with the `achievements` module): Bracket Rookie (first tournament), On the Podium (top 3),
  Champion (won one) and Tournament Veteran (10 played). The module also registers the metrics
  `tournaments_played`, `tournament_wins` and `tournament_podiums` for custom badges.

## Permissions and roles

Site-wide permissions (Admin › Groups & permissions):

| Permission | Default | Lets you |
| --- | --- | --- |
| `lan-tournaments.view` | guests, members | see tournaments, brackets and results |
| `lan-tournaments.compete` | members | register, run a team and report your own scores |
| `lan-tournaments.create` | administrators | create tournaments (you become their organiser) |
| `lan-tournaments.manage` | administrators | act as organiser on every tournament |
| `lan-tournaments.registrations` | administrators | approve and reject registrations, and invite, on any tournament |
| `lan-tournaments.participants` | administrators | manage participants, teams, seeds, stations and check-in on any tournament |
| `lan-tournaments.brackets` | administrators | generate and adjust brackets on any tournament |
| `lan-tournaments.schedule` | administrators | schedule matches on any tournament |
| `lan-tournaments.scores` | administrators | report and confirm scores as a referee on any tournament |
| `lan-tournaments.disputes` | administrators | resolve disputes and override results on any tournament |
| `lan-tournaments.publish` | administrators | publish results and announcements on any tournament |

Per-tournament roles, set on the manage page:

| Role | Can |
| --- | --- |
| **Organiser** | everything on that tournament: edit, status, registrations, participants, brackets, schedule, scores, disputes, publish |
| **Referee** | check people in, schedule matches, report and confirm scores, resolve disputes and override results |

Private tournaments are visible only to staff and invited members.

## LAN integration

All optional; each part switches on when the other module is enabled.

- **`lan-seating`:** link a tournament to a LAN event. The event shows on the tournament page, and staff can
  fill every entry's station from their booked seat in one click.
- **`lan-bookings`:** tick **Require a booking** so only members booked for the linked event can register.
- **`lan-intranet` (LAN HQ):** a **Tournaments** section shows live tournaments with progress, current and next
  matches; scheduled matches appear in the event schedule. Add the `tournaments` section in the intranet settings
  if your site has customised its section list.
- **Stations:** give each match a station (e.g. `Stage PC 1`) so players know where to sit.

## Notifications

Members get site notifications for: team invitations and replies, tournament invitations, registration approved
or rejected, registration closing, the tournament starting, a match being ready, scheduled or rescheduled, a
reminder 15 minutes before a scheduled match, a score to confirm, disputes (to staff), attempts reviewed, their
final place, cancellation, staff roles, and tournament announcements (to every participant).
Members choose how they receive them under the **Tournaments** notification kind.

## Templates and example configs

**New tournament** offers these templates; the same settings are in [`examples/`](examples) as JSON you can copy:

| Template | Format |
| --- | --- |
| [`cs2-5v5-double`](examples/cs2-5v5-double.json) | 5v5 shooter, double elimination, best-of-3 grand final with reset |
| [`fighting-1v1-single`](examples/fighting-1v1-single.json) | 1v1 fighting game, single elimination, best-of-3, 3rd-place match |
| [`rocket-groups`](examples/rocket-groups.json) | 3v3, two round-robin groups then a single-elimination playoff |
| [`chess-swiss`](examples/chess-swiss.json) | Swiss, five rounds, draws allowed |
| [`league-round-robin`](examples/league-round-robin.json) | Round-robin league, win 3 / draw 1 |
| [`kart-ffa`](examples/kart-ffa.json) | Free-for-all heats of 8 over three rounds |
| [`trackmania-time`](examples/trackmania-time.json) | Time challenge, lowest time wins, attempts verified |

The `config` object takes: `bestOf`, `finalBestOf`, `thirdPlace`, `grandFinalReset`, `swissRounds`, `groups`,
`advancePerGroup`, `playoff` (`single_elim` or `double_elim`), `ffaRounds`, `heatSize`, `ffaPoints` (points per
place), `points` (`{ win, draw, loss }`), `allowDraws`, `winCondition` (`higher` or `lower`), `scoreUnit`
(`points` or `time`), `verifyAttempts`, `seeding` (`registration`, `random` or `manual`), `rankingPoints`
(per final place) and `participationPoints`.

## Pages and JSON endpoints

| Path (under `/m/lan-tournaments`) | What |
| --- | --- |
| `/` | Listing with filters: upcoming and open, live now, finished, archived; by game |
| `/leaderboard` | Ranking points across published tournaments |
| `/new`, `/<slug>/edit` | Create and edit (organisers) |
| `/<slug>` | Tournament page with tabs: overview, bracket, matches, standings, participants, rules |
| `/<slug>/match/<id>` | Match page: score, reports, confirm and dispute, staff override |
| `/<slug>/live` | Spectator view |
| `/<slug>/manage` | Staff dashboard |
| `/admin/m/lan-tournaments/tournaments` | Admin list of every tournament, including drafts |

JSON (read-only, same visibility rules as the pages):

- `GET /m/lan-tournaments/api/tournaments`: `{ tournaments: [{ slug, name, game, platform, format, status, startsAt, entries, maxEntries, url }] }`
- `GET /m/lan-tournaments/<slug>/data.json`: `{ tournament, entries, matches, standings }`, for overlays and bots.

Other modules can use `ctx.use('lan-tournaments')` for `liveSummary(eventId)`, `schedule(from, to)` and
`historyCount(userId)`.

## Privacy and data

A member's registrations, team memberships, reports, attempts and results are part of their data download
(Settings › Your data). Erasing add-on data or closing the account removes the link to the member while keeping
brackets and results intact, so other players' records stay correct.

**Data:** `mod_lan_tournaments_tournaments`, `_staff`, `_teams`, `_team_members`, `_entries`, `_invites`,
`_stages`, `_matches`, `_heat_entries`, `_reports`, `_attempts`, `_announcements`, `_results`.
