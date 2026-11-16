/**
 * Third-party authentication (OAuth 2.0 / OpenID Connect) via the `arctic` client library and
 * `jose` for ID-token verification.
 *
 * Security properties
 * Providers are supplied by modules (see modules/oauth-providers); this file owns the security-critical flow.
 *
 * - Authorization Code flow; PKCE where the provider supports it.
 * - `state` (CSRF) and `nonce` (replay) are random, stored in a short-lived HMAC-signed cookie,
 *   and verified on callback. Redirect URIs are exact: `${APP_URL}/auth/<provider>/callback`.
 * - ID tokens (Google, Apple) are verified against the provider JWKS: signature, issuer,
 *   audience, expiry and nonce.
 * - Minimal scopes (identity + email). Provider access tokens are used once to read the
 *   profile and are never stored or exposed to the browser; therefore nothing needs refreshing
 *   or revoking later.
 * - Identity key is (provider, subject). Emails are never used to merge accounts.
 * - Client secrets come only from environment variables and are never rendered or logged.
 */
import { generateCodeVerifier, generateState } from 'arctic';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { and, eq, sql, desc, gt } from 'drizzle-orm';
import { config } from '../config.ts';
import { registries } from '../modules/registry.ts';
import type { AuthProviderDef } from '../sdk/types.ts';
import { getDb, schema } from '../db/client.ts';
import { hmac, randomToken, safeEqual, sha256 } from '../lib/crypto.ts';
import { getSetting } from './settings.ts';
import { ServiceError, getUserById, type User } from './users.ts';
import { securityEvent } from './audit.ts';
import { notify } from './notifications.ts';
import { sendMail } from './mailer.ts';

export interface ProviderInfo { id: string; name: string; configured: boolean; enabled: boolean; pkce: boolean; formPost: boolean; envVars: string[] }
export interface Identity { provider: string; subject: string; email: string | null; emailVerified: boolean; displayName: string | null }

const redirectFor = (id: string) => `${config.APP_URL}/auth/${id}/callback`;

/** Verify an OIDC ID token: signature (JWKS), issuer, audience, expiry and nonce. Exposed to modules via the SDK. */
export async function verifyIdToken(token: string, opts: { jwks: Parameters<typeof jwtVerify>[1]; issuer: string | string[]; audience: string; nonce: string }) {
  const { payload } = await jwtVerify(token, opts.jwks as any, { issuer: opts.issuer, audience: opts.audience, clockTolerance: 30 });
  if (!payload.sub) throw new Error('ID token missing subject');
  if (payload.nonce === undefined) throw new Error('ID token missing nonce');
  if (!safeEqual(String(payload.nonce), opts.nonce)) throw new Error('ID token nonce mismatch');
  return payload;
}

/** GET a JSON profile endpoint with a bearer token (8 s timeout). Exposed to modules via the SDK. */
export async function fetchProfile(url: string, token: string, extraHeaders: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Fragged-Forums', ...extraHeaders }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Profile request failed (${r.status})`);
  return r.json() as Promise<any>;
}
export { createRemoteJWKSet };

/** Providers come from modules (ctx.register.authProvider); only enabled modules' providers are listed. */
export function providerImpl(id: string): AuthProviderDef | undefined { return registries.authProviders.get(id); }

export async function listProviders(): Promise<ProviderInfo[]> {
  const enabled = await getSetting('auth_providers');
  return registries.authProviders.active().map((p) => {
    let configured = false;
    try { configured = !!p.configured(); } catch { configured = false; }
    return { id: p.id, name: p.name, configured, enabled: configured && enabled[p.id] !== false, pkce: p.pkce, formPost: !!p.formPost, envVars: p.envVars ?? [] };
  });
}
export async function enabledProviders() { return (await listProviders()).filter((p) => p.enabled); }

// ─────────────── flow state (signed cookie) ───────────────

export interface FlowState { p: string; s: string; v: string; n: string; mode: 'login' | 'link'; uid?: number; r?: string; exp: number }

export function sealFlow(f: FlowState): string {
  const b = Buffer.from(JSON.stringify(f)).toString('base64url');
  return `${b}.${hmac('oauth:' + b)}`;
}
export function openFlow(cookie: string | undefined): FlowState | null {
  if (!cookie) return null;
  const [b, sig] = cookie.split('.');
  if (!b || !sig || !safeEqual(sig, hmac('oauth:' + b))) return null;
  try { const f = JSON.parse(Buffer.from(b, 'base64url').toString()) as FlowState; return f.exp > Date.now() ? f : null; } catch { return null; }
}

export async function beginFlow(providerId: string, mode: 'login' | 'link', opts: { userId?: number; returnTo?: string }) {
  const p = providerImpl(providerId);
  const info = (await listProviders()).find((x) => x.id === providerId);
  if (!p || !info?.enabled) throw new ServiceError('That sign-in method is not available.', 404);
  const state = generateState();
  const verifier = generateCodeVerifier();
  const nonce = randomToken(16);
  const url = p.authUrl(state, verifier, nonce, redirectFor(p.id));
  const flow: FlowState = { p: p.id, s: state, v: verifier, n: nonce, mode, uid: opts.userId, r: safeReturn(opts.returnTo), exp: Date.now() + 10 * 60_000 };
  return { url: url.toString(), cookie: sealFlow(flow), formPost: !!p.formPost };
}

export function safeReturn(r: string | undefined | null): string | undefined {
  if (!r) return undefined;
  return /^\/(?!\/)[\w\-./?=&%#~+]*$/.test(r) && !r.startsWith('/auth/') ? r : undefined;
}

export async function completeFlow(providerId: string, flow: FlowState | null, params: { code?: string; state?: string; error?: string; form?: Record<string, string> }): Promise<Identity> {
  if (params.error) throw new ServiceError(params.error === 'access_denied' ? 'Sign-in was cancelled.' : 'The provider reported an error. Please try again.', 400, 'provider_denied');
  if (!flow || flow.p !== providerId || !params.state || !safeEqual(flow.s, params.state)) throw new ServiceError('Your sign-in session expired or was invalid. Please try again.', 400, 'bad_state');
  if (!params.code) throw new ServiceError('Missing authorization code.', 400);
  const p = providerImpl(providerId)!;
  try {
    const id = await p.exchange({ code: params.code, verifier: flow.v, nonce: flow.n, redirectUri: redirectFor(p.id), form: params.form });
    if (!id?.subject) throw new Error('missing subject');
    // the identity always belongs to the provider core dispatched to — a module can't mint other providers' identities
    return { provider: providerId, subject: String(id.subject), email: id.email ?? null, emailVerified: !!id.emailVerified, displayName: id.displayName ?? null };
  } catch (e) {
    await securityEvent(null, 'oauth_failed', { provider: providerId, detail: { error: String((e as Error).message).slice(0, 200) } });
    throw new ServiceError(`We couldn't verify your ${p.name} sign-in. The service may be unavailable — please try again shortly.`, 502, 'provider_error');
  }
}

// ─────────────── account resolution ───────────────

export async function findLinked(provider: string, subject: string) {
  const [row] = await getDb().select().from(schema.externalAccounts).where(and(eq(schema.externalAccounts.provider, provider), eq(schema.externalAccounts.providerSubject, subject)));
  return row ?? null;
}

export async function touchLinked(id: number) {
  await getDb().update(schema.externalAccounts).set({ lastAuthAt: new Date() }).where(eq(schema.externalAccounts.id, id));
}

/** Create a pending registration for a verified identity with no Fragged account yet. */
export async function createPending(identity: Identity, returnTo?: string): Promise<string> {
  const token = randomToken(32);
  await getDb().insert(schema.pendingRegistrations).values({
    tokenHash: sha256(token), provider: identity.provider, providerSubject: identity.subject, providerEmail: identity.email?.toLowerCase() ?? null,
    providerEmailVerified: identity.emailVerified, providerDisplayName: identity.displayName?.slice(0, 120) ?? null, returnTo: returnTo ?? null, expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  return token;
}

export async function getPending(token: string | undefined) {
  if (!token) return null;
  const [row] = await getDb().select().from(schema.pendingRegistrations).where(and(eq(schema.pendingRegistrations.tokenHash, sha256(token)), gt(schema.pendingRegistrations.expiresAt, new Date())));
  return row ?? null;
}
export async function deletePending(id: number) { await getDb().delete(schema.pendingRegistrations).where(eq(schema.pendingRegistrations.id, id)); }

/** Suggest (never assign) an available username from the provider display name. */
export async function suggestUsername(displayName: string | null): Promise<string> {
  const { checkUsername } = await import('./users.ts');
  let base = (displayName ?? '').normalize('NFKD').replace(/[^\w.-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 18);
  if (base.length < 3) base = 'Member';
  if (!(await checkUsername(base))) return base;
  for (let i = 0; i < 8; i++) {
    const cand = `${base}${Math.floor(100 + Math.random() * 9000)}`;
    if (!(await checkUsername(cand))) return cand;
  }
  return '';
}

export async function linkIdentity(user: User, identity: Identity, info: { ip: string | null; userAgent: string | null }) {
  const existing = await findLinked(identity.provider, identity.subject);
  if (existing && existing.userId !== user.id) {
    await securityEvent(user.id, 'link_conflict', { ...info, provider: identity.provider });
    throw new ServiceError('That account is already connected to a different Fragged account. If you believe this is a mistake, sign in to the other account to disconnect it, or contact support from the Rules page.', 409, 'identity_in_use');
  }
  if (existing) return existing;
  const [mine] = await getDb().select().from(schema.externalAccounts).where(and(eq(schema.externalAccounts.userId, user.id), eq(schema.externalAccounts.provider, identity.provider)));
  if (mine) throw new ServiceError(`A different ${identity.provider} account is already connected. Disconnect it first.`, 409);
  const [row] = await getDb().insert(schema.externalAccounts).values({
    userId: user.id, provider: identity.provider, providerSubject: identity.subject, providerEmail: identity.email, providerEmailVerified: identity.emailVerified,
    providerDisplayName: identity.displayName?.slice(0, 120) ?? null, lastAuthAt: new Date(),
  }).returning();
  await securityEvent(user.id, 'provider_linked', { ...info, provider: identity.provider });
  await notify(user.id, 'security', null, `A ${identity.provider} sign-in was connected to your account.`, '/settings/security');
  if (user.email) await sendMail({ to: user.email, subject: 'New sign-in method connected', text: `A ${identity.provider} account was connected to ${user.username}. If this wasn't you, review your security settings: ${config.APP_URL}/settings/security` });
  return row;
}

export async function authMethods(userId: number) {
  const u = await getUserById(userId);
  const linked = await getDb().select().from(schema.externalAccounts).where(eq(schema.externalAccounts.userId, userId)).orderBy(schema.externalAccounts.connectedAt);
  return { hasPassword: !!u?.passwordHash, linked };
}

export async function unlinkIdentity(user: User, externalId: number, info: { ip: string | null; userAgent: string | null }) {
  const { hasPassword, linked } = await authMethods(user.id);
  const row = linked.find((l) => l.id === externalId);
  if (!row) throw new ServiceError('Connection not found.', 404);
  if ((hasPassword ? 1 : 0) + linked.length <= 1) throw new ServiceError('You cannot remove your only sign-in method. Add a password or connect another provider first.', 409, 'last_method');
  await getDb().delete(schema.externalAccounts).where(and(eq(schema.externalAccounts.id, externalId), eq(schema.externalAccounts.userId, user.id)));
  await securityEvent(user.id, 'provider_unlinked', { ...info, provider: row.provider });
  await notify(user.id, 'security', null, `Your ${row.provider} sign-in was disconnected.`, '/settings/security');
  if (user.email) await sendMail({ to: user.email, subject: 'Sign-in method removed', text: `The ${row.provider} sign-in was disconnected from ${user.username}. If this wasn't you, secure your account: ${config.APP_URL}/settings/security` });
}

export async function providerHealth() {
  const rows = (await getDb().execute(sql`
    select provider, kind, count(*)::int as n, max(created_at) as last from security_events
    where provider is not null and created_at > now() - interval '7 days' group by provider, kind`)) as any;
  return (rows.rows ?? rows) as { provider: string; kind: string; n: number; last: Date }[];
}

export const _x = { desc };
