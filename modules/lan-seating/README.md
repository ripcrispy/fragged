# LAN party seat booking

Draw a seat map for each LAN party and let attendees pick their seat. Organisers can reserve seats, assign and move
people, and open or close booking.

- **Pages:** `/m/lan-seating` (events), `/m/lan-seating/<event>` (live seat map, refreshed every 15 s while booking is
  open, plus a table view for screen readers)
- **Admin:** Admin › LAN seating (events, map editor with preview, bookings, assign or remove)
- **Navigation:** "Seating" in the main menu
- **Profile:** shows a member's seat for the current event

| Permission | Default |
| --- | --- |
| `lan-seating.view`: see seat maps | guests, members |
| `lan-seating.book`: book a seat | members |
| `lan-seating.manage`: create events, edit maps, assign seats | administrators |

## Seat-map format

One line per row: `S` seat, `V` reserved (organisers assign), `X` blocked, `.` aisle, `#` table or wall. Rows are
lettered A, B, C… and seats numbered left to right (counting S, V and X), so codes like `B4` stay stable when you
move aisles.

```
##########
SSSS..SSSS
SSSS..SSSS
VVVV..XXSS
```

## Rules

- One seat per member per event. Picking another seat moves you.
- Unique constraints make double-booking impossible, even with simultaneous clicks.
- Booking can be limited to an opening window. Draft events are visible only to organisers.
- If an organiser edits the map and a booked seat disappears, that booking is cancelled and the member is notified.
- Closing an account removes its bookings.

## For other modules

**Exposes** `currentSummary()`, `seatOf(userId)`, `seatFor(eventId, userId)`, `eventById(id)`, `eventBySlug(slug)`,
`listEvents(includeDrafts)`, `bookingsFor(eventId)`, `seatCodes(eventId)`, `releaseSeat(eventId, userId)`,
`mapView(eventId, page)` (a read-only seat map to embed) and `setSeatPolicy(owner, policy)`. Used by `lan-intranet`
and `lan-bookings`.

A **seat policy** decides which seats a member may book themselves: it returns seat areas to label on the map, the
seats the member may pick, or a reason they can't book yet. Policies are registered by modules that depend on
seating (seating never depends on them), from their `start()` and cleared in `stop()`. Organisers assigning seats are
never restricted.

**Data:** `mod_lan_seating_events`, `mod_lan_seating_bookings`.
