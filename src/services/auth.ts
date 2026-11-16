import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { emit, applyFilters } from '../modules/registry.ts';
import { getDb, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { emailSchema, validatePassword } from '../lib/validate.ts';
import { isValidTimezone } from '../lib/time.ts';
import { checkUsername, createUser, getUserByLogin, getUserById, ServiceError, activeBan, type User } from './users.ts';
import { getSetting } from './settings.ts';
import { securityEvent } from './audit.ts';
import { sendMail } from './mailer.ts';
import { notify } from './notifications.ts';

export type Session = typeof schema.userSessions.$inferSelect;
export interface ReqInfo { ip: string | null; userAgent: string | null }

// ─────────────── sessions ───────────────

export async function createSession(userId: number, remember: boolean, info: ReqInfo, reauth = true): Promise<{ token: string; session: Session; maxAge: number }> {
  const days = remember ? await getSetting('remember_days') : await getSetting('session_days');
  const token = randomToken(32);
  const maxAge = days * 86400;
  const [session] = await getDb().insert(schema.userSessions).values({
    userId, tokenHash: sha256(token), remember, ip: info.ip, userAgent: info.userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + maxAge * 1000), reauthAt: reauth ? new Date() : null,
  }).returning();
  await getDb().update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, userId));
  return { token, session, maxAge };
}

export async function resolveSession(token: string | undefined): Promise<{ session: Session; user: User } | null> {
  if (!token || token.length > 100) return null;
  const db = getDb();
  const [row] = await db.select({ s: schema.userSessions, u: schema.users }).from(schema.userSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
    .where(and(eq(schema.userSessions.tokenHash, sha256(token)), isNull(schema.userSessions.revokedAt), gt(schema.userSessions.expiresAt, new Date())));
  if (!row || row.u.closedAt) return null;
  // sliding expiry + last-used, throttled to once a minute
  if (Date.now() - row.s.lastUsedAt.getTime() > 60_000) {
    const days = row.s.remember ? await getSetting('remember_days') : await getSetting('session_days');
    await db.update(schema.userSessions).set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + days * 86400_000) }).where(eq(schema.userSessions.id, row.s.id));
    await db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, row.u.id));
  }
  return { session: row.s, user: row.u };
}

export async function revokeSession(sessionId: number, userId?: number) {
  const cond = userId ? and(eq(schema.userSessions.id, sessionId), eq(schema.userSessions.userId, userId)) : eq(schema.userSessions.id, sessionId);
  await getDb().update(schema.userSessions).set({ revokedAt: new Date() }).where(cond);
}
export async function revokeAllSessions(userId: number, exceptSessionId?: number) {
  const cond = exceptSessionId
    ? and(eq(schema.userSessions.userId, userId), ne(schema.userSessions.id, exceptSessionId), isNull(schema.userSessions.revokedAt))
    : and(eq(schema.userSessions.userId, userId), isNull(schema.userSessions.revokedAt));
  await getDb().update(schema.userSessions).set({ revokedAt: new Date() }).where(cond);
}
export async function listSessions(userId: number) {
  return getDb().select().from(schema.userSessions)
    .where(and(eq(schema.userSessions.userId, userId), isNull(schema.userSessions.revokedAt), gt(schema.userSessions.expiresAt, new Date())))
    .orderBy(schema.userSessions.lastUsedAt);
}

/** Sensitive operations require credentials entered within the last N minutes. */
export async function isRecentlyAuthenticated(session: Session | null): Promise<boolean> {
  if (!session?.reauthAt) return false;
  const mins = await getSetting('reauth_minutes');
  return Date.now() - session.reauthAt.getTime() < mins * 60_000;
}
export async function markReauthenticated(sessionId: number) {
  await getDb().update(schema.userSessions).set({ reauthAt: new Date() }).where(eq(schema.userSessions.id, sessionId));
}

// ─────────────── email tokens ───────────────

async function issueToken(userId: number, kind: 'verify' | 'reset' | 'email_change', hours: number, newEmail?: string) {
  const token = randomToken(32);
  const db = getDb();
  // invalidate previous unused tokens of the same kind
  await db.update(schema.emailTokens).set({ usedAt: new Date() }).where(and(eq(schema.emailTokens.userId, userId), eq(schema.emailTokens.kind, kind), isNull(schema.emailTokens.usedAt)));
  await db.insert(schema.emailTokens).values({ userId, kind, tokenHash: sha256(token), newEmail: newEmail ?? null, expiresAt: new Date(Date.now() + hours * 3600_000) });
  return token;
}

async function consumeToken(token: string, kind: string) {
  const db = getDb();
  const [row] = await db.select().from(schema.emailTokens).where(and(eq(schema.emailTokens.tokenHash, sha256(token)), eq(schema.emailTokens.kind, kind), isNull(schema.emailTokens.usedAt), gt(schema.emailTokens.expiresAt, new Date())));
  if (!row) return null;
  const upd = await db.update(schema.emailTokens).set({ usedAt: new Date() }).where(and(eq(schema.emailTokens.id, row.id), isNull(schema.emailTokens.usedAt))).returning();
  return upd.length ? row : null;
}

export async function sendVerificationEmail(user: User) {
  if (!user.email) return;
  const token = await issueToken(user.id, 'verify', 48);
  const site = await getSetting('site_name');
  await sendMail({ to: user.email, subject: `Verify your ${site} email address`, text: `Hi ${user.username},\n\nConfirm your email address by opening this link:\n${config.APP_URL}/verify-email?token=${token}\n\nThe link expires in 48 hours. If you did not create an account, ignore this message.` }, { immediate: true });
}

export async function verifyEmail(token: string): Promise<User | null> {
  const row = await consumeToken(token, 'verify');
  if (!row) return null;
  await getDb().update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, row.userId));
  await securityEvent(row.userId, 'email_verified');
  return getUserById(row.userId);
}

// ─────────────── registration & login ───────────────

export interface RegisterInput { username: string; email: string; password: string; confirm: string; dateOfBirth?: string; timezone?: string; acceptTerms: boolean }

export function ageFrom(dob: string, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = new Date(dob + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d > now || d.getUTCFullYear() < 1900) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export async function validateRegistrationCommon(input: { username: string; dateOfBirth?: string; timezone?: string; acceptTerms: boolean }): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  const uErr = await checkUsername(input.username);
  if (uErr) errors.username = uErr;
  if (await getSetting('require_date_of_birth')) {
    const age = input.dateOfBirth ? ageFrom(input.dateOfBirth) : null;
    const min = await getSetting('minimum_age');
    if (age == null) errors.dateOfBirth = 'Enter a valid date of birth.';
    else if (age < min) errors.dateOfBirth = `You must be at least ${min} years old to join.`;
  }
  if (input.timezone && !isValidTimezone(input.timezone)) errors.timezone = 'Choose a valid timezone.';
  if (!input.acceptTerms) errors.acceptTerms = 'You must accept the Terms of Service and Community Rules.';
  return errors;
}

export async function register(input: RegisterInput, info: ReqInfo): Promise<{ user?: User; errors?: Record<string, string> }> {
  if (!(await getSetting('registration_open')) || !(await getSetting('allow_password_registration'))) throw new ServiceError('Registration is currently closed.', 403);
  const errors = await validateRegistrationCommon(input);
  const email = emailSchema.safeParse(input.email);
  if (!email.success) errors.email = 'Enter a valid email address.';
  else {
    const existing = await getUserByLogin(email.data);
    // Don't reveal whether an email exists beyond what is necessary: show a generic duplicate message.
    if (existing && existing.emailLower === email.data) errors.email = 'That email address cannot be used. If it is yours, try signing in or resetting your password.';
  }
  const pErr = validatePassword(input.password, { username: input.username, email: email.success ? email.data : undefined });
  if (pErr) errors.password = pErr;
  else if (input.password !== input.confirm) errors.confirm = 'Passwords do not match.';
  if (Object.keys(errors).length) return { errors };
  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await getDb().transaction(async (tx) => createUser({ username: input.username, email: email.data!, passwordHash, dateOfBirth: input.dateOfBirth || null, timezone: input.timezone || 'UTC' }, tx as any));
  } catch (e: any) {
    if (String(e?.cause?.message ?? e?.message).includes('unique')) return { errors: { username: 'That username or email is already in use.' } };
    throw e;
  }
  await securityEvent(user.id, 'register', { ...info, provider: 'password' });
  await emit('user.registered', { userId: user.id, provider: 'password' });
  if (await getSetting('require_email_verification')) await sendVerificationEmail(user);
  else await getDb().update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
  return { user };
}

export async function loginWithPassword(login: string, password: string, info: ReqInfo): Promise<{ user?: User; error?: string }> {
  const user = await getUserByLogin(login);
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || user.closedAt) {
    await securityEvent(user?.id ?? null, 'login_failed', { ...info, provider: 'password', detail: { login: login.slice(0, 64) } });
    return { error: 'Incorrect username/email or password.' };
  }
  await securityEvent(user.id, 'login', { ...info, provider: 'password' });
  await emit('user.loggedIn', { userId: user.id, provider: 'password' });
  return { user };
}

/** Banned users may sign in only to see their ban notice; enforcement happens via permissions. */
export async function banNotice(userId: number) { return activeBan(userId); }

// ─────────────── password reset / change ───────────────

export async function requestPasswordReset(login: string, info: ReqInfo) {
  const user = await getUserByLogin(login);
  // Always behave the same to the requester (no account enumeration).
  if (!user || !user.email || user.closedAt) return;
  const token = await issueToken(user.id, 'reset', 2);
  await securityEvent(user.id, 'password_reset_requested', info);
  await sendMail({ to: user.email, subject: 'Reset your Fragged password', text: `Someone (hopefully you) asked to reset the password for ${user.username}.\n\nReset it here (valid for 2 hours):\n${config.APP_URL}/reset-password?token=${token}\n\nIf this wasn't you, you can ignore this email. Your password will not change.` }, { immediate: true });
}

export async function resetPassword(token: string, password: string, confirm: string, info: ReqInfo): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(schema.emailTokens).where(and(eq(schema.emailTokens.tokenHash, sha256(token)), eq(schema.emailTokens.kind, 'reset'), isNull(schema.emailTokens.usedAt), gt(schema.emailTokens.expiresAt, new Date())));
  if (!row) return 'This reset link is invalid or has expired.';
  const user = await getUserById(row.userId);
  if (!user) return 'This reset link is invalid or has expired.';
  const err = validatePassword(password, { username: user.username, email: user.email ?? undefined });
  if (err) return err;
  if (password !== confirm) return 'Passwords do not match.';
  if (!(await consumeToken(token, 'reset'))) return 'This reset link is invalid or has expired.';
  // A successful reset via email also proves control of the address
  await db.update(schema.users).set({ passwordHash: await hashPassword(password), emailVerifiedAt: user.emailVerifiedAt ?? new Date() }).where(eq(schema.users.id, user.id));
  await revokeAllSessions(user.id);
  await securityEvent(user.id, 'password_reset', info);
  await notify(user.id, 'security', null, 'Your password was reset. All sessions were signed out.', '/settings/security');
  return null;
}

export async function changePassword(user: User, sessionId: number, current: string | null, next: string, confirm: string, info: ReqInfo): Promise<string | null> {
  if (user.passwordHash && !(await verifyPassword(current ?? '', user.passwordHash))) return 'Your current password is incorrect.';
  const err = validatePassword(next, { username: user.username, email: user.email ?? undefined });
  if (err) return err;
  if (next !== confirm) return 'Passwords do not match.';
  await getDb().update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, user.id));
  await revokeAllSessions(user.id, sessionId);
  await securityEvent(user.id, user.passwordHash ? 'password_changed' : 'password_added', info);
  await notify(user.id, 'security', null, user.passwordHash ? 'Your password was changed. Other sessions were signed out.' : 'A password was added to your account.', '/settings/security');
  if (user.email) await sendMail({ to: user.email, subject: 'Your Fragged password was changed', text: `The password for ${user.username} was changed. If this wasn't you, reset your password immediately: ${config.APP_URL}/forgot-password` });
  return null;
}

export async function requestEmailChange(user: User, newEmail: string, info: ReqInfo): Promise<string | null> {
  const parsed = emailSchema.safeParse(newEmail);
  if (!parsed.success) return 'Enter a valid email address.';
  const existing = await getUserByLogin(parsed.data);
  if (existing && existing.emailLower === parsed.data) return 'That email address cannot be used.';
  const token = await issueToken(user.id, 'email_change', 24, parsed.data);
  await sendMail({ to: parsed.data, subject: 'Confirm your new Fragged email address', text: `Confirm the new email address for ${user.username}:\n${config.APP_URL}/confirm-email-change?token=${token}\n\nValid for 24 hours.` }, { immediate: true });
  if (user.email) await sendMail({ to: user.email, subject: 'Email change requested', text: `A change of email address to ${parsed.data} was requested for ${user.username}. If this wasn't you, change your password now.` });
  await securityEvent(user.id, 'email_change_requested', { ...info, detail: { to: parsed.data } });
  return null;
}

export async function confirmEmailChange(token: string): Promise<string | null> {
  const row = await consumeToken(token, 'email_change');
  if (!row?.newEmail) return 'This confirmation link is invalid or has expired.';
  try {
    await getDb().update(schema.users).set({ email: row.newEmail, emailLower: row.newEmail.toLowerCase(), emailVerifiedAt: new Date() }).where(eq(schema.users.id, row.userId));
  } catch { return 'That email address is now in use by another account.'; }
  await securityEvent(row.userId, 'email_changed', { detail: { to: row.newEmail } });
  await notify(row.userId, 'security', null, 'Your email address was changed.', '/settings/security');
  return null;
}
