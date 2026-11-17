# Achievements

Badges awarded automatically for taking part (posts, threads, reactions received, friendships, profile comments,
account age) plus manual awards by staff.

- **Pages:** `/m/achievements` (catalogue), a box on profiles, a toggle in Settings › Profile to hide them
- **Admin:** Admin › Achievements (create and edit definitions, thresholds, icons), and a panel on Admin › Users ›
  member to award or revoke
- **Permission:** `achievements.manage`
- **Notifications:** `achievement` ("Achievements earned"), which members can turn off
- **Data:** `achievement_definitions`, `user_achievements`, `user_profiles.show_achievements` (kept from before the module system, so existing installs keep their data)
- **Hooks used:** `post.created`, `thread.created`, `post.reacted`, `friend.accepted`, `profile.commented`.
  Every criterion, including account age, is re-checked whenever one of these fires for a member.

**Other modules** can add their own metrics and badges through `ctx.use('achievements')`: `registerMetric(key,
label, value)`, `unregisterMetric(key)`, `addDefinitions(list)` (skips keys that exist, so admins' edits are kept)
and `evaluate(userId)`. `lan-tournaments` adds tournaments played, wins and podiums, with four badges.

Disabling the module hides everything and keeps earned
badges for when it's re-enabled.
