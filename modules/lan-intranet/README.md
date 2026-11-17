# LAN party intranet

An event-day landing page ("LAN HQ") for the big screen and everyone's laptops: announcements, a countdown, live
game-server status, the schedule, Wi-Fi details, house rules, and widgets from the other LAN modules.

- **Page:** `/m/lan-intranet` (`/m/lan-intranet/status.json` for live server status)
- **Admin:** Admin › LAN intranet (announcements, game servers, schedule). Look and layout are in Admin › Modules ›
  LAN party intranet › Settings.
- **Permission:** `lan-intranet.manage`
- **Works with:** `lan-seating` (seats booked meter), `lan-pizza` (current pizza run and deadline) and
  `caffeine-tracker` (top 5 most caffeinated)

## Settings

| Setting | Notes |
| --- | --- |
| Title, tagline | Shown in the banner |
| Doors open | `YYYY-MM-DDTHH:MM` in the event timezone. Empty hides the countdown. |
| Event timezone | e.g. `Europe/London` |
| Wi-Fi, info and house rules | BBCode |
| Sections | Comma-separated order: `announcements,countdown,servers,schedule,seating,pizza,caffeine,wifi,info`. Remove one to hide it. |
| Audience | Everyone, or signed-in members only |
| Refresh | How often servers are probed and the page updates (10–600 s) |

## Game-server status

Each server has a probe type:

| Type | Shows |
| --- | --- |
| TCP port check | online and latency |
| Source engine (A2S_INFO over UDP, with challenge support) | players, max players, map, server name |
| Minecraft (Server List Ping) | players, max players, version, MOTD |
| Not monitored | just the connect details |

Probes run on the server every *refresh* seconds while the module is enabled, with a 2-second timeout and a 64 KB
reply cap. Only organisers with `lan-intranet.manage` can add hosts, which matters because the server connects to
them.

**Exposes** `schedule(viewer, from, to)` and `servers(viewer)` to other modules (`lan-bookings` shows them on its
announcement thread). Both follow the audience setting.

**Data:** `mod_lan_intranet_announcements`, `mod_lan_intranet_servers`, `mod_lan_intranet_schedule`.
