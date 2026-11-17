# LAN event bookings

Take bookings for a LAN event and see how much interest there is before the day. Organisers set up booking types
(a standard seat, a high-speed network seat, a spectator ticket…), announce the event with a sticky forum thread,
and watch bookings and interest come in. Booking types can be tied to areas of the seat map, so only people who
booked a high-speed seat can pick a seat on the 10 Gb/s row.

- **Members:** `/m/lan-bookings` lists events taking bookings ("Book a LAN" in the main menu);
  `/m/lan-bookings/<event>` is the booking page
- **Admin:** Admin › LAN bookings
- **Needs:** `lan-seating` 1.1+ (an event's bookings and seat map share one event)
- **Works with:** `lan-intranet` 1.2+ (sub-events and game servers on the announcement thread) and
  `lan-event-access` 1.1+ (the door desk checks booked members in and charges their booking price)

## For organisers

1. Create the event and its seat map in **Admin › LAN seating**.
2. In **Admin › LAN bookings**, click **Set up bookings**. You get two example booking types and example rules.
3. Edit the **booking types**: name, price (paid at the door), number of places (empty for no limit), description,
   and optionally **seats on the map**: `A1-A8`, `B` (a whole row), `C-D` (rows C to D), `E3 E4`. A type with no
   seats listed covers every seat that no other type claims. Hide a type to stop new bookings without losing
   existing ones.
4. Write the **event rules and terms** (BBCode). Members must tick that they agree before they can book, and the
   time they agreed is recorded (it's in the CSV too).
5. Add the **event crew**: who will be there as Admin, Moderator, LAN admin, Volunteer or a role you type.
6. Set the status to **Open for bookings**, then **Announce in the forums**: choose the forum, edit the title and
   first post, and choose what the live panel shows.

### The announcement thread

The thread is posted as you, with all the usual forum checks, and made **sticky**. Members can reply as normal.
Admins and moderators control it with the normal moderator tools: lock, move, edit, delete. Above the posts it shows
a **live panel** that is rebuilt every time the page loads, so it never goes out of date:

| Section | Shows |
| --- | --- |
| Event rules and terms | The rules from the booking page |
| Event crew | Admins, moderators, LAN admins and volunteers at the event, grouped by role |
| Who's booked | Each booking type with its places, and who booked it with their seat; plus who is interested |
| What's on | Sub-events from the LAN intranet schedule, from 12 hours before the event starts until it ends |
| Game servers | The LAN intranet's game servers, with their status once the intranet is probing them |
| Seat map | A read-only seat map with booked seats and the seat areas of each booking type |

Tick or untick sections in **Announce in the forums** and use **Only update the panel sections** to change an
existing thread. The panel also has the member's own status and a **Book your place** button, plus **Manage
bookings** for organisers. Sub-events and game servers follow the LAN intranet's audience setting, so a
members-only intranet stays hidden from guests.

### Interest

The **Interest** box shows bookings and interest per type, with a demand bar against each type's places, and a chart
of sign-ups per day for the last three weeks. **Members** lists everyone with their type, seat and note:

- **Confirm booking** turns someone's interest into a booking, even when the type is full.
- **Remove** deletes a booking or interest (and frees their seat). The member is notified.
- **Download CSV** exports the list.

## For members

- **Book a place**: choose a booking type, agree to the rules and terms, and book. Then pick your seat on the
  seat map. When booking types have seat areas, you can only pick a seat in your type's area.
- **Register interest**: not ready to commit? Tell the organisers you're interested, optionally with the type you'd
  most likely book. It doesn't hold a place.
- Change your booking type at any time while bookings are open. If your new type doesn't include your seat, the seat
  is released and you're notified. Cancelling a booking frees your seat too.

## At the door

With `lan-event-access` on, its door desk shows who has booked the event being run, whether each of them has
arrived and paid, and lets the desk pick a booked member when approving their device. The member pays their booking
price and the payment is linked to their account. The module exposes `doorList()` for this.

## Tournaments

With `lan-tournaments` on, a tournament linked to the event can **require a booking**: only members with a booked
place can register. The module exposes `isBooked(eventId, userId)` and `hasBookings(eventId)` for this.

## Rules

- One booking or interest per member per event.
- Places can't be oversold: the booking type is locked while a place is taken.
- With **Members must book a place before picking a seat** on (the default), the seat map only lets members with a
  booking pick a seat. Organisers can always assign seats in Admin › LAN seating.
- 30 booking changes per hour per member.

| Permission | Default | Lets you |
| --- | --- | --- |
| `lan-bookings.view` | guests, members | see booking pages and the thread panel |
| `lan-bookings.book` | members | book places and register interest |
| `lan-bookings.manage` | administrators | set up bookings, types, rules, crew and announcement threads |

**Settings:** currency symbol (default `£`).

**Data:** `mod_lan_bookings_events`, `mod_lan_bookings_types`, `mod_lan_bookings_bookings`, `mod_lan_bookings_staff`.
Closing an account removes that member's bookings and crew entries. **Audit log:** `lan-bookings.setup`,
`.settings`, `.type.update`, `.announce`, `.crew.add`, `.crew.remove`, `.confirm` and `.remove`. **Notifications:**
`lan-bookings` (a seat released after a booking change, organiser confirmations and removals).
