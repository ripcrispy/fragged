# Product policies (as implemented)

These are the rules the code enforces. User-facing wording lives in the seeded **Privacy Policy**, **Terms**
and **Community Rules** pages (editable in Admin › Rules & pages).

## Relationships

| State | Representation | Effect |
| --- | --- | --- |
| Pending request | `friend_requests.status = 'pending'` (unique per ordered pair) | Sending a request to someone who already requested you accepts theirs instead of creating a second one. |
| Friends | one `friendships` row (low id, high id) | Enables friends-only profile comments, friends-only DMs, Top Friends. |
| Block | `user_blocks` (directional) | Takes precedence over everything below. |
| Mute | `user_mutes` (directional) | Notifications only (+ optional content collapse). |

**Blocking** (either direction) prevents new friend requests, new DMs (both ways), profile comments, reactions
between the two, and mention/quote/reply/message notifications. Blocking removes the friendship, cancels
pending requests both ways and removes each from the other's Top Friends. Existing **conversation history is
kept** and readable by both; the composer shows why sending is disabled. The blocker sees the blocked member's
posts collapsed; comments by the blocked member on the blocker's profile are hidden. The blocked member is not
notified (they see generic "cannot message this member" wording). Unblocking does not restore the friendship.

**Muting** suppresses notifications from that member (and optionally collapses their content for the muter).
It does not stop them messaging; the UI says so. Conversation-level mute does the same for one conversation.

## Direct messages

- Sent messages cannot be edited or deleted by anyone through the application; a database trigger rejects
  content UPDATEs and all DELETEs on `direct_messages` and `message_attachments`.
- Closing a dock tab, removing a friend, muting or blocking never removes history.
- Staff can read a DM only when it has been **reported**, through `/mod/messages/:id` (permission
  `mod.messages`, administrators by default), which shows the reported message plus limited context and is
  audit-logged. Staff may **hide** that message from both participants (audited, reason required); the
  original text is retained.
- Restricted terms: `block`/`hold` both prevent sending (DMs are never queued for staff reading); `flag`
  records a match *without* storing message text; `redact` masks on display.
- Retention: kept for the life of the service. Legal obligations (erasure requests, court orders) override
  this; such handling is a manual, documented administrator process (direct database work, recorded in the
  audit log) — the product does not promise absolute permanence.

## Account closure

Self-service at Settings › Account (requires re-authentication + typing the username). It revokes sessions,
clears email/password/profile/avatar/cover/links, deletes linked sign-in identities and friendships, and renames
the account to `former-member-<id>`; content displays as "Former member". Posts and DMs remain so threads and
conversations stay coherent. Full erasure requests are handled manually by administrators.

## Moderation & audit

Every privileged action writes `audit_log` (actor, action, target, detail, IP): post/thread moderation, forum
and permission changes, group membership, settings, sign-in provider toggles, emoji decisions, term
changes (without the sensitive term text), achievement awards/revocations, warnings, suspensions, bans, notes
and DM reviews. Security events (logins, failures, resets, provider link/unlink, session revocations) are in
`security_events`.

## Sign-in identities

The identity key is `(provider, provider_subject)` (unique). Emails are never used to merge accounts; when a
provider email matches an existing account, the user is told to sign in and link from settings. An identity
can belong to one account only. The last remaining sign-in method cannot be removed. Linking requires recent
re-authentication. Bans/suspensions apply regardless of sign-in method. Provider usernames are only offered as
a *suggestion*; the user must type their Fragged username.

## Uploads

Images only (PNG/JPEG/WebP/GIF), decoded and re-encoded to WebP with metadata stripped, size/dimension/frame
limits configurable per purpose (avatar, cover, post, message, emoji). SVG/HTML are rejected. Videos and
general files are never uploaded — they are shared as external links and shown as clearly-labelled external
content.
