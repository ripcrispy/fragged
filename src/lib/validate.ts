import { z } from 'zod';

export const USERNAME_MIN = 3, USERNAME_MAX = 24;
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

/** Names that can never be registered (impersonation / system). Extended by admin "reserved names" setting. */
export const BUILTIN_RESERVED = ['admin', 'administrator', 'root', 'system', 'moderator', 'mod', 'staff', 'support', 'fragged', 'official', 'security', 'help', 'null', 'undefined', 'anonymous', 'guest', 'former-member', 'deleted', 'everyone', 'here', 'webmaster', 'postmaster', 'abuse', 'noreply', 'no-reply'];

/** Normalise for uniqueness + reserved checks: case-fold, NFKC, strip separators, map confusables. */
export function usernameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}
export function confusableKey(name: string): string {
  return usernameKey(name).replace(/[._-]/g, '').replace(/0/g, 'o').replace(/[1l|]/g, 'i').replace(/5/g, 's').replace(/3/g, 'e').replace(/4/g, 'a');
}

export function validateUsername(name: string, reserved: string[] = []): string | null {
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return `Usernames must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(name)) return 'Usernames may contain letters, numbers, underscores, dots and hyphens, and must start with a letter or number.';
  if (/[._-]{2,}/.test(name)) return 'Usernames cannot contain repeated punctuation.';
  const ck = confusableKey(name);
  const all = [...BUILTIN_RESERVED, ...reserved].map(confusableKey);
  if (all.some((r) => r && (ck === r || (r.length >= 5 && ck.includes(r))))) return 'That username is reserved.';
  return null;
}

export function validatePassword(pw: string, ctx: { username?: string; email?: string } = {}): string | null {
  if (pw.length < 10) return 'Passwords must be at least 10 characters.';
  if (pw.length > 200) return 'Passwords must be at most 200 characters.';
  const lower = pw.toLowerCase();
  if (ctx.username && lower.includes(ctx.username.toLowerCase())) return 'Passwords must not contain your username.';
  if (ctx.email && lower.includes(ctx.email.toLowerCase().split('@')[0])) return 'Passwords must not contain your email address.';
  if (/^(.)\1+$/.test(pw) || ['password123', '1234567890', 'qwertyuiop'].includes(lower)) return 'That password is too easy to guess.';
  return null;
}

export const emailSchema = z.string().trim().toLowerCase().max(254).email();

export function slugify(s: string, max = 60): string {
  const slug = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return slug || 'thread';
}

/** #rgb / #rrggbb only */
export function parseHexColor(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + [...v.slice(1)].map((c) => c + c).join('');
  return null;
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Collapse whitespace and strip control characters from single-line input. */
export function cleanLine(s: unknown, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Multi-line text: normalise newlines, strip control chars except \n and \t, cap length. */
export function cleanText(s: unknown, max: number): string {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max);
}
