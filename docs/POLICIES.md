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
- Retention: kept for the life of the service, except that a member may **erase messages they sent** from
  Settings › Your data. The trigger allows this only inside a transaction that has switched on erasure mode
  (`set_config('fragged.erasure', 'on', true)`, migration 0005), and only to blank the text and links or remove
  attachments; nothing can rewrite a message. Messages in a conversation with an **open report** are kept until
  the report is handled. Court orders and other legal obligations remain a manual administrator process.

## Your data: download, erase, delete account

Self-service at **Settings › Your data**. Every action requires recent re-authentication; erasing and deleting
also require typing the username. All three are recorded as security events (`data_exported`, `data_erased`,
`account_closed`) and erasure and deletion in the audit log.

- **Download** (5 per hour): a JSON file with the account, profile, settings, posts and threads, conversations,
  connections, uploads (as addresses), reactions, bookmarks, drafts, notifications, sessions, security events,
  reports made, warnings and bans, plus each module's data (`personalData` extension point). Password hashes and
  tokens are never included.
- **Erase** chosen parts while keeping the account: profile, posts and threads (posts show "Removed at the author's
  request"; threads with nobody else's posts are removed), sent DMs (see retention above), uploaded images (not
  community emoji or images in reported conversations), activity, connections and module data.
- **Delete account**: revokes sessions; clears email, password, date of birth, profile and sign-in identities;
  removes friendships; renames the account to `former-member-<id>`; optionally erases all content first.
- **Kept**: security events and the audit log, moderation records (warnings, bans, staff notes), reports made by
  other members, and records modules must keep (paid food orders; entry payments without the member's name).
- **The last full administrator can't delete their account.** The page offers a handover form that makes another
  active member with a verified email a full administrator (audited, and the member is notified). Closed and
  currently banned administrators don't count.

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
