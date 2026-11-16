import { Google, Discord, Facebook, Apple, GitHub } from 'arctic';
import { defineModule, oidc, type AuthProviderDef } from '../../src/sdk/index.ts';

/**
 * Sign in with Google, Discord, Facebook, Apple and GitHub.
 * Core runs the OAuth flow (state, PKCE, nonce, linking, username selection); this module only talks to the
 * identity providers. Credentials are read from environment variables and never stored or displayed.
 */
const env = (k: string) => process.env[k] || '';
const googleJwks = oidc.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = oidc.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const google: AuthProviderDef = {
  id: 'google', name: 'Google', pkce: true, envVars: ['OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET'],
  configured: () => !!(env('OAUTH_GOOGLE_CLIENT_ID') && env('OAUTH_GOOGLE_CLIENT_SECRET')),
  authUrl(state, verifier, nonce, redirect) {
    const url = new Google(env('OAUTH_GOOGLE_CLIENT_ID'), env('OAUTH_GOOGLE_CLIENT_SECRET'), redirect).createAuthorizationURL(state, verifier, ['openid', 'email', 'profile']);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('prompt', 'select_account');
    return url;
  },
  async exchange({ code, verifier, nonce, redirectUri }) {
    const tokens = await new Google(env('OAUTH_GOOGLE_CLIENT_ID'), env('OAUTH_GOOGLE_CLIENT_SECRET'), redirectUri).validateAuthorizationCode(code, verifier);
    const c = await oidc.verifyIdToken(tokens.idToken(), { jwks: googleJwks, issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env('OAUTH_GOOGLE_CLIENT_ID'), nonce });
    return { provider: 'google', subject: String(c.sub), email: (c.email as string) ?? null, emailVerified: c.email_verified === true, displayName: (c.name as string) ?? null };
  },
};

const discord: AuthProviderDef = {
  id: 'discord', name: 'Discord', pkce: true, envVars: ['OAUTH_DISCORD_CLIENT_ID', 'OAUTH_DISCORD_CLIENT_SECRET'],
  configured: () => !!(env('OAUTH_DISCORD_CLIENT_ID') && env('OAUTH_DISCORD_CLIENT_SECRET')),
  authUrl: (state, verifier, _n, redirect) => new Discord(env('OAUTH_DISCORD_CLIENT_ID'), env('OAUTH_DISCORD_CLIENT_SECRET'), redirect).createAuthorizationURL(state, verifier, ['identify', 'email']),
  async exchange({ code, verifier, redirectUri }) {
    const tokens = await new Discord(env('OAUTH_DISCORD_CLIENT_ID'), env('OAUTH_DISCORD_CLIENT_SECRET'), redirectUri).validateAuthorizationCode(code, verifier);
    const u = await oidc.fetchProfile('https://discord.com/api/v10/users/@me', tokens.accessToken());
    return { provider: 'discord', subject: String(u.id), email: u.email ?? null, emailVerified: u.verified === true, displayName: u.global_name ?? u.username ?? null };
  },
};

const facebook: AuthProviderDef = {
  id: 'facebook', name: 'Facebook', pkce: false, envVars: ['OAUTH_FACEBOOK_CLIENT_ID', 'OAUTH_FACEBOOK_CLIENT_SECRET'],
  configured: () => !!(env('OAUTH_FACEBOOK_CLIENT_ID') && env('OAUTH_FACEBOOK_CLIENT_SECRET')),
  authUrl: (state, _v, _n, redirect) => new Facebook(env('OAUTH_FACEBOOK_CLIENT_ID'), env('OAUTH_FACEBOOK_CLIENT_SECRET'), redirect).createAuthorizationURL(state, ['email', 'public_profile']),
  async exchange({ code, redirectUri }) {
    const tokens = await new Facebook(env('OAUTH_FACEBOOK_CLIENT_ID'), env('OAUTH_FACEBOOK_CLIENT_SECRET'), redirectUri).validateAuthorizationCode(code);
    const u = await oidc.fetchProfile('https://graph.facebook.com/v19.0/me?fields=id,name,email', tokens.accessToken());
    // Facebook does not assert email verification; treat as unverified.
    return { provider: 'facebook', subject: String(u.id), email: u.email ?? null, emailVerified: false, displayName: u.name ?? null };
  },
};

function appleClient(redirect: string) {
  const pem = env('OAUTH_APPLE_PRIVATE_KEY').replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return new Apple(env('OAUTH_APPLE_CLIENT_ID'), env('OAUTH_APPLE_TEAM_ID'), env('OAUTH_APPLE_KEY_ID'), new Uint8Array(Buffer.from(pem, 'base64')), redirect);
}
const apple: AuthProviderDef = {
  id: 'apple', name: 'Apple', pkce: false, formPost: true, envVars: ['OAUTH_APPLE_CLIENT_ID', 'OAUTH_APPLE_TEAM_ID', 'OAUTH_APPLE_KEY_ID', 'OAUTH_APPLE_PRIVATE_KEY'],
  configured: () => !!(env('OAUTH_APPLE_CLIENT_ID') && env('OAUTH_APPLE_TEAM_ID') && env('OAUTH_APPLE_KEY_ID') && env('OAUTH_APPLE_PRIVATE_KEY')),
  authUrl(state, _v, nonce, redirect) {
    const url = appleClient(redirect).createAuthorizationURL(state, ['name', 'email']);
    url.searchParams.set('response_mode', 'form_post');
    url.searchParams.set('nonce', nonce);
    return url;
  },
  async exchange({ code, nonce, redirectUri, form }) {
    const tokens = await appleClient(redirectUri).validateAuthorizationCode(code);
    const c = await oidc.verifyIdToken(tokens.idToken(), { jwks: appleJwks, issuer: 'https://appleid.apple.com', audience: env('OAUTH_APPLE_CLIENT_ID'), nonce });
    let name: string | null = null;
    try { const u = form?.user ? JSON.parse(form.user) : null; name = [u?.name?.firstName, u?.name?.lastName].filter(Boolean).join(' ') || null; } catch { /* name is optional */ }
    return { provider: 'apple', subject: String(c.sub), email: (c.email as string) ?? null, emailVerified: c.email_verified === true || c.email_verified === 'true', displayName: name };
  },
};

const github: AuthProviderDef = {
  id: 'github', name: 'GitHub', pkce: false, envVars: ['OAUTH_GITHUB_CLIENT_ID', 'OAUTH_GITHUB_CLIENT_SECRET'],
  configured: () => !!(env('OAUTH_GITHUB_CLIENT_ID') && env('OAUTH_GITHUB_CLIENT_SECRET')),
  authUrl: (state, _v, _n, redirect) => new GitHub(env('OAUTH_GITHUB_CLIENT_ID'), env('OAUTH_GITHUB_CLIENT_SECRET'), redirect).createAuthorizationURL(state, ['read:user', 'user:email']),
  async exchange({ code, redirectUri }) {
    const tokens = await new GitHub(env('OAUTH_GITHUB_CLIENT_ID'), env('OAUTH_GITHUB_CLIENT_SECRET'), redirectUri).validateAuthorizationCode(code);
    const u = await oidc.fetchProfile('https://api.github.com/user', tokens.accessToken());
    const emails = await oidc.fetchProfile('https://api.github.com/user/emails', tokens.accessToken()).catch(() => []);
    const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary) : null;
    return { provider: 'github', subject: String(u.id), email: primary?.email ?? null, emailVerified: !!primary?.verified, displayName: u.name ?? u.login ?? null };
  },
};

export default defineModule({
  id: 'oauth-providers',
  name: 'Social sign-in',
  version: '1.0.0',
  description: 'Sign in and register with Google, Discord, Facebook, Apple or GitHub. Each provider appears once its credentials are set in the environment.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  setup(ctx) {
    for (const p of [google, discord, facebook, apple, github]) ctx.register.authProvider(p);
  },
});
