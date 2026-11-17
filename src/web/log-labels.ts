/**
 * Human-readable names for audit-log actions and security-event kinds, grouped into categories so the log
 * viewers can offer plain-language dropdowns. Codes that aren't listed fall back to a readable version of the
 * code itself, so new actions still display sensibly.
 */
import { listModules } from '../modules/runtime.ts';

export interface LabelDef { label: string; category: string; severity?: 'info' | 'notice' | 'warning' }

export const AUDIT_CATEGORIES: Record<string, string> = {
  content: 'Posts & threads',
  members: 'Member moderation',
  reports: 'Reports & review queues',
  messages: 'Direct-message review',
  structure: 'Forums, tags & pages',
  access: 'Groups & permissions',
  policy: 'Restricted terms & filters',
  community: 'Emoji & achievements',
  config: 'Site & sign-in settings',
  account: 'Account self-service',
};

export const AUDIT_ACTIONS: Record<string, LabelDef> = {
  'post.edit': { label: 'Edited another member’s post', category: 'content' },
  'post.delete': { label: 'Deleted a post', category: 'content' },
  'post.restore': { label: 'Restored a deleted post', category: 'content' },
  'post.approve': { label: 'Approved a held post', category: 'content' },
  'thread.flags': { label: 'Locked / stickied / announced a thread', category: 'content' },
  'thread.move': { label: 'Moved a thread', category: 'content' },
  'thread.merge': { label: 'Merged threads', category: 'content' },
  'thread.split': { label: 'Split a thread', category: 'content' },
  'thread.delete': { label: 'Deleted a thread', category: 'content' },
  'thread.restore': { label: 'Restored a thread', category: 'content' },
  'thread.tags': { label: 'Changed a thread’s tags', category: 'content' },
  'profile_comment.remove': { label: 'Removed a profile comment', category: 'content' },
  'profile_comment.approve': { label: 'Approved a held profile comment', category: 'content' },
  'profile_comment.reject': { label: 'Rejected a held profile comment', category: 'content' },
  'user.warn': { label: 'Warned a member', category: 'members' },
  'user.suspend': { label: 'Suspended a member', category: 'members' },
  'user.ban': { label: 'Banned a member', category: 'members' },
  'user.unban': { label: 'Lifted a suspension or ban', category: 'members' },
  'user.note': { label: 'Added a moderator note', category: 'members' },
  'user.verify_email': { label: 'Marked a member’s email verified', category: 'members' },
  'report.resolved': { label: 'Resolved a report', category: 'reports' },
  'report.dismissed': { label: 'Dismissed a report', category: 'reports' },
  'term_match.review': { label: 'Reviewed a restricted-term match', category: 'reports' },
  'emoji.approve': { label: 'Approved an emoji', category: 'reports' },
  'emoji.reject': { label: 'Rejected an emoji', category: 'reports' },
  'emoji.disable': { label: 'Disabled an emoji', category: 'community' },
  'emoji.enable': { label: 'Re-enabled an emoji', category: 'community' },
  'emoji.create': { label: 'Added an official emoji', category: 'community' },
  'message.view_reported': { label: 'Viewed a reported direct message', category: 'messages' },
  'message.hide': { label: 'Hid a reported direct message', category: 'messages' },
  'forum.create': { label: 'Created a forum', category: 'structure' },
  'forum.update': { label: 'Edited a forum', category: 'structure' },
  'forum.delete': { label: 'Deleted a forum', category: 'structure' },
  'forum.moderator_add': { label: 'Added a forum moderator', category: 'structure' },
  'forum.moderator_remove': { label: 'Removed a forum moderator', category: 'structure' },
  'category.create': { label: 'Created a category', category: 'structure' },
  'category.update': { label: 'Edited a category', category: 'structure' },
  'category.delete': { label: 'Deleted a category', category: 'structure' },
  'tag.create': { label: 'Created a tag', category: 'structure' },
  'tag.update': { label: 'Edited a tag', category: 'structure' },
  'rule.create': { label: 'Added a rule', category: 'structure' },
  'rule.update': { label: 'Edited a rule', category: 'structure' },
  'rule.delete': { label: 'Deleted a rule', category: 'structure' },
  'page.create': { label: 'Created a page', category: 'structure' },
  'page.update': { label: 'Edited a page', category: 'structure' },
  'forum.permissions': { label: 'Changed forum permissions', category: 'access' },
  'group.create': { label: 'Created a group', category: 'access' },
  'group.update': { label: 'Edited a group', category: 'access' },
  'user.groups': { label: 'Changed a member’s groups', category: 'access' },
  'user.permissions': { label: 'Changed a member’s permission overrides', category: 'access' },
  'term.create': { label: 'Added a restricted term', category: 'policy' },
  'term.update': { label: 'Edited a restricted term', category: 'policy' },
  'term.delete': { label: 'Deleted a restricted term', category: 'policy' },
  'profanity.update': { label: 'Updated the profanity list', category: 'policy' },
  'achievement.create': { label: 'Created an achievement', category: 'community' },
  'achievement.update': { label: 'Edited an achievement', category: 'community' },
  'achievement.award': { label: 'Awarded an achievement', category: 'community' },
  'achievement.revoke': { label: 'Revoked an achievement', category: 'community' },
  'settings.update': { label: 'Changed site settings', category: 'config' },
  'auth.providers': { label: 'Changed sign-in providers', category: 'config' },
  'audit.export': { label: 'Downloaded the audit log', category: 'config' },
  'module.enable': { label: 'Enabled a module', category: 'config' },
  'module.disable': { label: 'Disabled a module', category: 'config' },
  'module.settings': { label: 'Changed module settings', category: 'config' },
  'security.export': { label: 'Downloaded security events', category: 'config' },
  'user.rename': { label: 'Changed username', category: 'account' },
  'user.close': { label: 'Deleted their account', category: 'account' },
  'user.erase_data': { label: 'Erased their data', category: 'account' },
};

export const SECURITY_CATEGORIES: Record<string, string> = {
  signin: 'Sign-in',
  failures: 'Failed or blocked attempts',
  account: 'Account changes',
  providers: 'Connected providers',
  sessions: 'Sessions',
};

export const SECURITY_KINDS: Record<string, LabelDef> = {
  login: { label: 'Signed in', category: 'signin', severity: 'info' },
  logout: { label: 'Signed out', category: 'signin', severity: 'info' },
  register: { label: 'Registered', category: 'signin', severity: 'info' },
  oauth_pending_registration: { label: 'Provider sign-in awaiting username', category: 'signin', severity: 'info' },
  login_failed: { label: 'Failed sign-in', category: 'failures', severity: 'warning' },
  login_throttled: { label: 'Sign-in blocked by rate limit', category: 'failures', severity: 'warning' },
  reauth_failed: { label: 'Failed identity confirmation', category: 'failures', severity: 'warning' },
  oauth_failed: { label: 'Provider sign-in failed', category: 'failures', severity: 'warning' },
  register_honeypot: { label: 'Bot registration blocked', category: 'failures', severity: 'notice' },
  link_conflict: { label: 'Provider already linked elsewhere', category: 'failures', severity: 'warning' },
  email_verified: { label: 'Verified email', category: 'account', severity: 'info' },
  email_change_requested: { label: 'Requested email change', category: 'account', severity: 'notice' },
  email_changed: { label: 'Changed email', category: 'account', severity: 'notice' },
  password_reset_requested: { label: 'Requested password reset', category: 'account', severity: 'notice' },
  password_reset: { label: 'Reset password via email', category: 'account', severity: 'notice' },
  password_changed: { label: 'Changed password', category: 'account', severity: 'notice' },
  password_added: { label: 'Added a password', category: 'account', severity: 'notice' },
  username_changed: { label: 'Changed username', category: 'account', severity: 'notice' },
  account_closed: { label: 'Deleted account', category: 'account', severity: 'notice' },
  data_exported: { label: 'Downloaded their data', category: 'account', severity: 'notice' },
  data_erased: { label: 'Erased their data', category: 'account', severity: 'notice' },
  provider_linked: { label: 'Connected a sign-in provider', category: 'providers', severity: 'notice' },
  provider_unlinked: { label: 'Disconnected a sign-in provider', category: 'providers', severity: 'notice' },
  session_revoked: { label: 'Signed out a session', category: 'sessions', severity: 'info' },
  sessions_revoked: { label: 'Signed out all other sessions', category: 'sessions', severity: 'notice' },
};

export const TARGET_TYPES: Record<string, string> = {
  user: 'Member', post: 'Post', thread: 'Thread', forum: 'Forum', category: 'Category', tag: 'Tag', group: 'Group',
  term: 'Restricted term', term_match: 'Term match', report: 'Report', emoji: 'Emoji', achievement: 'Achievement',
  page: 'Page', rule: 'Rule', message: 'Direct message', profile_comment: 'Profile comment',
};

export const PROVIDER_NAMES: Record<string, string> = { password: 'Password', google: 'Google', discord: 'Discord', facebook: 'Facebook', apple: 'Apple', github: 'GitHub', dev: 'Test provider' };

export function humanise(code: string): string {
  const s = code.replace(/[._-]+/g, ' ').trim().replace(/\blan\b/gi, 'LAN');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Module actions are named `<module id>.<verb>`: show them as "<module name>: <verb>". */
function moduleActionLabel(code: string): string | null {
  const dot = code.indexOf('.');
  if (dot < 1) return null;
  const m = listModules().find((x) => x.def.id === code.slice(0, dot));
  return m ? `${m.def.name}: ${humanise(code.slice(dot + 1))}` : null;
}
export const auditLabel = (code: string) => AUDIT_ACTIONS[code]?.label ?? moduleActionLabel(code) ?? humanise(code);
export const securityLabel = (code: string) => SECURITY_KINDS[code]?.label ?? humanise(code);

/** Codes belonging to a category (includes uncatalogued codes seen in the data whose prefix matches nothing → "other"). */
export function codesInCategory(defs: Record<string, LabelDef>, category: string): string[] {
  return Object.entries(defs).filter(([, d]) => d.category === category).map(([k]) => k);
}
