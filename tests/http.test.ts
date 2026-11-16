/** End-to-end HTTP tests through the real Hono app (sessions, CSRF, OAuth, rendering, access control). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { setupDb, teardownDb, makeUser, makeForum, client, viewerFor } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { sentMail } from '../src/services/mailer.ts';
import { createThread } from '../src/services/forums.ts';
import { openConversation } from '../src/services/messages.ts';
import { suspendUser } from '../src/services/moderation.ts';
import { setSetting } from '../src/services/settings.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { verifyIdToken } from '../src/services/oauth.ts';

beforeAll(setupDb);
afterAll(teardownDb);

describe('pages', () => {
  it('renders the main pages', async () => {
    const forum = await makeForum('Rendered');
    const u = await makeUser({ username: 'RenderUser' });
    await createThread(await viewerFor(u.id), forum, { title: 'Hello <b>there</b>', body: '<script>alert(1)</script> [spoiler]hidden ending[/spoiler]' });
    const c = client();
    for (const p of ['/', '/forums', `/f/${forum.slug}`, '/whats-new', '/members', '/rules', '/login', '/register', '/u/RenderUser', '/emoji', '/m/achievements', '/pages/privacy']) {
      const r = await c.get(p);
      expect(r.status, p).toBe(200);
    }
    const thread = await c.get(`/f/${forum.slug}`);
    expect(thread.text).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
    const [t] = await getDb().select().from(schema.threads).where(eq(schema.threads.forumId, forum.id));
    const page = await c.get(`/t/${t.id}-${t.slug}`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('<script>alert(1)</script>');
    expect(page.text).toContain('class="bb-spoiler"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
    expect((await c.get('/does-not-exist')).status).toBe(404);
    // legacy URL from before achievements became a module
    const legacy = await c.get('/achievements');
    expect(legacy.status).toBe(301); expect(legacy.location).toBe('/m/achievements');
  });

  it('renders error pages inside exactly one site shell', async () => {
    const c = client();
    for (const [path, status] of [['/settings', 401], ['/messages', 401], ['/admin', 401], ['/no-such-page', 404], ['/t/999999', 404]] as const) {
      const r = await c.get(path);
      expect(r.status, path).toBe(status);
      expect(r.text.match(/class="site-header"/g)?.length, path).toBe(1);
      expect(r.text.match(/class="site-footer"/g)?.length, path).toBe(1);
      expect(r.text.match(/<html/g)?.length, path).toBe(1);
    }
    await makeUser({ username: 'ShellCheck' });
    await c.login('ShellCheck');
    const forbidden = await c.get('/admin');
    expect(forbidden.status).toBe(403);
    expect(forbidden.text.match(/class="site-header"/g)?.length).toBe(1);
  });

  it('gates threads with built-in and admin-defined warning labels', async () => {
    const forum = await makeForum('Gated');
    await getDb().insert(schema.tags).values({ name: 'Flashing Lights', slug: 'flashing-lights', kind: 'warning', isOfficial: true });
    const u = await makeUser();
    resetLimits();
    const { thread } = await createThread(await viewerFor(u.id), forum, { title: 'Strobe test', body: 'video with strobes', tags: ['Flashing Lights'] });
    const page = await client().get(`/t/${thread.id}-${thread.slug}`);
    expect(page.text).toContain('class="cw-gate"');
    expect(page.text).toContain('<strong>Flashing Lights</strong>');
  });
});

describe('auth over HTTP', () => {
  it('accepts only configured origins', async () => {
    const { parseAllowedOrigins } = await import('../src/config.ts');
    const set = parseAllowedOrigins('http://10.0.0.189:3000', 'http://localhost:3000, http://fragged:3000');
    expect([...set]).toEqual(['http://10.0.0.189:3000', 'http://localhost:3000', 'http://fragged:3000']);
    expect(() => parseAllowedOrigins('http://a.test', '*')).toThrow();
    expect(() => parseAllowedOrigins('http://a.test', 'http://*.example.com')).toThrow();
    expect(() => parseAllowedOrigins('http://a.test', 'http://evil.example/path')).toThrow();
    const c = client();
    await c.get('/login');
    const blocked = await c.post('/login', { login: 'x', password: 'y' }, { origin: 'http://evil.example' });
    expect(blocked.status).toBe(403);
    expect(blocked.text).toContain('Cross-origin request blocked');
    const ok = await c.post('/login', { login: 'nobody-here', password: 'wrong password' }, { origin: 'http://localhost:3000' });
    expect(ok.status).toBe(401); // passed the origin + CSRF checks, failed credentials
  });

  it('rejects POSTs without a CSRF token', async () => {
    const c = client();
    await c.get('/login');
    const r = await c.post('/login', { login: 'x', password: 'y', _csrf: 'wrong' });
    expect(r.status).toBe(403);
  });

  it('registers, verifies email, logs out and in, and resets password', async () => {
    await setSetting('require_email_verification', true);
    const c = client();
    await c.get('/register');
    const r = await c.post('/register', { username: 'NewbieOne', email: 'newbie@example.test', password: 'a long passphrase here', confirm: 'a long passphrase here', acceptTerms: '1', timezone: 'UTC' });
    expect(r.status).toBe(302);
    const mail = sentMail.find((m) => m.to === 'newbie@example.test')!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    await c.get(`/verify-email?token=${token}`);
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, 'newbieone'));
    expect(u.emailVerifiedAt).toBeTruthy();
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    // duplicate username rejected
    const c2 = client(); await c2.get('/register');
    const dup = await c2.post('/register', { username: 'newbieone', email: 'other@example.test', password: 'a long passphrase here', confirm: 'a long passphrase here', acceptTerms: '1' });
    expect(dup.status).toBe(422);
    expect(dup.text).toContain('already taken');
    // login with email
    await c.post('/logout');
    resetLimits();
    const li = await c.login('newbie@example.test', 'a long passphrase here');
    expect(li.status).toBe(302);
    const bad = await c.login('newbie@example.test', 'wrong password!!');
    expect(bad.status).toBe(401);
    // reset
    await c.get('/forgot-password');
    await c.post('/forgot-password', { login: 'NewbieOne' });
    const reset = sentMail.filter((m) => m.subject.includes('Reset')).pop()!;
    const rt = /token=([\w-]+)/.exec(reset.text)![1];
    await c.get(`/reset-password?token=${rt}`);
    const rr = await c.post('/reset-password', { token: rt, password: 'brand new passphrase', confirm: 'brand new passphrase' });
    expect(rr.location).toBe('/login');
    // token single-use
    const again = await c.post('/reset-password', { token: rt, password: 'brand new passphrase', confirm: 'brand new passphrase' });
    expect(again.text).toContain('invalid or has expired');
    await setSetting('require_email_verification', false);
  });

  it('throttles repeated failed logins', async () => {
    resetLimits();
    const c = client();
    await c.get('/login');
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await c.post('/login', { login: 'ghost', password: 'nope nope nope' })).status;
    expect(last).toBe(429);
    resetLimits();
  });
});

describe('OAuth (dev provider round-trip)', () => {
  async function oauthLogin(c: ReturnType<typeof client>, subject: string, email = '', verified = false) {
    await c.get('/login');
    const start = await c.post('/auth/dev', { mode: 'login' });
    const url = new URL(start.location!);
    const state = url.searchParams.get('state')!;
    const cc = url.searchParams.get('code_challenge')!;
    await c.get(url.pathname + url.search);
    const auth = await c.post(url.pathname, { state, cc, subject, email, ...(verified ? { emailVerified: '1' } : {}), displayName: 'Provider Name', decision: 'allow' });
    return c.get(new URL(auth.location!, 'http://localhost').pathname + new URL(auth.location!, 'http://localhost').search);
  }

  it('registers via provider with explicit username selection, then logs in again', async () => {
    resetLimits();
    const c = client();
    const cb = await oauthLogin(c, 'subj-100', 'prov@example.test', true);
    expect(cb.location).toBe('/register/complete');
    const page = await c.get('/register/complete');
    expect(page.text).toContain('Suggestion:');
    // no account is created until the user picks a username
    expect((await getDb().select().from(schema.externalAccounts).where(eq(schema.externalAccounts.providerSubject, 'subj-100'))).length).toBe(0);
    const done = await c.post('/register/complete', { username: 'ChosenName', acceptTerms: '1', timezone: 'UTC' });
    expect(done.status).toBe(302);
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, 'chosenname'));
    expect(u.passwordHash).toBeNull(); expect(u.emailVerifiedAt).toBeTruthy();
    const c2 = client();
    const again = await oauthLogin(c2, 'subj-100');
    expect(again.location).toBe('/');
  });

  it('never merges by email, refuses identity reuse, and protects the last sign-in method', async () => {
    resetLimits();
    const existing = await makeUser({ username: 'HasPassword', email: 'same@example.test' });
    const c = client();
    const cb = await oauthLogin(c, 'subj-200', 'same@example.test', true);
    expect(cb.location).toBe('/register/complete');
    const page = await c.get('/register/complete');
    expect(page.text).toContain('never merged automatically');
    // completes as a separate account without the colliding email
    await c.post('/register/complete', { username: 'SeparatePerson', acceptTerms: '1' });
    const [sep] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, 'separateperson'));
    expect(sep.id).not.toBe(existing.id); expect(sep.email).toBeNull();
    // that provider-only user cannot unlink their only method
    const [ext] = await getDb().select().from(schema.externalAccounts).where(eq(schema.externalAccounts.userId, sep.id));
    const { unlinkIdentity, linkIdentity } = await import('../src/services/oauth.ts');
    await expect(unlinkIdentity(sep, ext.id, { ip: null, userAgent: null })).rejects.toMatchObject({ code: 'last_method' });
    // the same identity cannot be linked to another account
    await expect(linkIdentity(existing, { provider: 'dev', subject: 'subj-200', email: null, emailVerified: false, displayName: null }, { ip: null, userAgent: null })).rejects.toMatchObject({ code: 'identity_in_use' });
  });

  it('handles denied consent and bad state', async () => {
    resetLimits();
    const c = client();
    await c.get('/login');
    const start = await c.post('/auth/dev', { mode: 'login' });
    const state = new URL(start.location!).searchParams.get('state')!;
    const denied = await c.get(`/auth/dev/callback?error=access_denied&state=${state}`);
    expect(decodeURIComponent(denied.location!)).toContain('cancelled');
    const forged = await client().get('/auth/dev/callback?code=abc&state=forged');
    expect(decodeURIComponent(forged.location!)).toContain('expired or was invalid');
  });

  it('banned accounts stay restricted when signing in via a provider', async () => {
    resetLimits();
    const c = client();
    await oauthLogin(c, 'subj-300');
    await c.post('/register/complete', { username: 'SoonBanned', acceptTerms: '1' });
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, 'soonbanned'));
    const mod = await makeUser({ group: 'admin' });
    await suspendUser(await viewerFor(mod.id), u.id, 'Ban test reason', null);
    const c2 = client();
    await oauthLogin(c2, 'subj-300');
    const home = await c2.get('/');
    expect(home.text).toContain('Your account is banned');
    const forum = await makeForum('BanForum');
    const r = await c2.get(`/f/${forum.slug}/new`);
    expect(r.status).toBe(403);
  });

  it('verifies ID token signature, issuer, audience and nonce', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const mk = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://issuer.test').setAudience('client-1').setSubject('abc').setExpirationTime('5m').setIssuedAt().sign(privateKey);
    const opts = { jwks, issuer: 'https://issuer.test', audience: 'client-1', nonce: 'n-1' };
    await expect(verifyIdToken(await mk({ nonce: 'n-1' }), opts)).resolves.toMatchObject({ sub: 'abc' });
    await expect(verifyIdToken(await mk({ nonce: 'other' }), opts)).rejects.toThrow(/nonce/);
    await expect(verifyIdToken(await mk({}), opts)).rejects.toThrow(/nonce/);
    await expect(verifyIdToken(await mk({ nonce: 'n-1' }), { ...opts, audience: 'client-2' })).rejects.toThrow();
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ nonce: 'n-1' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://issuer.test').setAudience('client-1').setSubject('abc').setExpirationTime('5m').sign(other.privateKey);
    await expect(verifyIdToken(forged, opts)).rejects.toThrow();
  });
});

describe('access isolation over HTTP', () => {
  it('direct messages are only visible to participants', async () => {
    resetLimits();
    const a = await makeUser({ username: 'DmAlice' }); const b = await makeUser({ username: 'DmBob' }); const eve = await makeUser({ username: 'DmEve' });
    const conv = await openConversation(await viewerFor(a.id), b.id);
    const ca = client(); await ca.login('DmAlice');
    const sent = await ca.json('POST', `/api/conversations/${conv.publicId}/messages`, { body: 'for bob only', nonce: 'http-nonce-1' });
    expect(sent.status).toBe(201);
    const again = await ca.json('POST', `/api/conversations/${conv.publicId}/messages`, { body: 'for bob only', nonce: 'http-nonce-1' });
    expect(again.status).toBe(200); expect(again.body.duplicate).toBe(true);
    const ce = client(); await ce.login('DmEve');
    expect((await ce.json('GET', `/api/conversations/${conv.publicId}`)).status).toBe(404);
    expect((await ce.get(`/messages/${conv.publicId}`)).status).toBe(404);
    const cb = client(); await cb.login('DmBob');
    const view = await cb.json('GET', `/api/conversations/${conv.publicId}`);
    expect(view.body.messages[0].html).toContain('for bob only');
    expect(view.body.messages[0].senderId).toBe(a.id);
    // there is no edit/delete endpoint
    expect((await ca.json('DELETE', `/api/conversations/${conv.publicId}/messages`)).status).toBe(404);
    expect((await ca.json('PUT', `/api/conversations/${conv.publicId}/messages`, { body: 'x' })).status).toBe(404);
    void eve;
  });

  it('opening a DM twice reuses the conversation', async () => {
    resetLimits();
    const a = await makeUser({ username: 'ReuseA' }); const b = await makeUser({ username: 'ReuseB' });
    const ca = client(); await ca.login('ReuseA');
    const one = await ca.json('POST', '/api/dm/open', { userId: b.id });
    const two = await ca.json('POST', '/api/dm/open', { username: 'ReuseB' });
    expect(one.body.publicId).toBe(two.body.publicId);
    void a;
  });

  it('message image uploads are private to participants', async () => {
    resetLimits();
    const sharp = (await import('sharp')).default;
    const a = await makeUser({ username: 'ImgA' }); const b = await makeUser({ username: 'ImgB' }); await makeUser({ username: 'ImgEve' });
    const conv = await openConversation(await viewerFor(a.id), b.id);
    const ca = client(); await ca.login('ImgA');
    const fd = new FormData();
    fd.append('purpose', 'message');
    fd.append('file', new Blob([await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f00' } }).png().toBuffer()], { type: 'image/png' }), 'x.png');
    const up = await ca.postForm('/api/uploads', fd);
    const pid = JSON.parse(up.text).publicId;
    await ca.json('POST', `/api/conversations/${conv.publicId}/messages`, { body: '', nonce: 'img-nonce-1', uploads: [pid] });
    const cb = client(); await cb.login('ImgB');
    expect((await cb.get(`/media/${pid}`)).status).toBe(200);
    const ce = client(); await ce.login('ImgEve');
    expect((await ce.get(`/media/${pid}`)).status).toBe(404);
    expect((await client().get(`/media/${pid}`)).status).toBe(404);
  });

  it('images on deleted posts are hidden from members but not moderators', async () => {
    resetLimits();
    const sharp = (await import('sharp')).default;
    const forum = await makeForum('ImgDel');
    await makeUser({ username: 'PostImgA' }); await makeUser({ username: 'PostImgReader' }); await makeUser({ username: 'PostImgMod', group: 'moderator' });
    const ca = client(); await ca.login('PostImgA');
    const fd = new FormData(); fd.append('purpose', 'post');
    fd.append('file', new Blob([await sharp({ create: { width: 30, height: 30, channels: 3, background: '#0f0' } }).png().toBuffer()], { type: 'image/png' }), 'p.png');
    const pid = JSON.parse((await ca.postForm('/api/uploads', fd)).text).publicId;
    const [author] = await getDb().select().from(schema.users).where(eq(schema.users.usernameLower, 'postimga'));
    const { post } = await createThread(await viewerFor(author.id), forum, { title: 'Image post', body: `[img]/media/${pid}[/img]`, uploads: [pid] });
    const reader = client(); await reader.login('PostImgReader');
    expect((await reader.get(`/media/${pid}`)).status).toBe(200);
    await getDb().update(schema.posts).set({ isDeleted: true }).where(eq(schema.posts.id, post.id));
    expect((await reader.get(`/media/${pid}`)).status).toBe(404);
    const mod = client(); await mod.login('PostImgMod');
    expect((await mod.get(`/media/${pid}`)).status).toBe(200);
    expect((await ca.get(`/media/${pid}`)).status).toBe(200);
  });

  it('admin and moderation areas are server-protected', async () => {
    resetLimits();
    await makeUser({ username: 'PlainMember' });
    const c = client(); await c.login('PlainMember');
    for (const p of ['/admin', '/admin/terms', '/admin/settings', '/mod', '/mod/reports']) expect((await c.get(p)).status, p).toBe(403);
    const r = await c.post('/admin/settings', { site_name: 'pwned' });
    expect(r.status).toBe(403);
    await makeUser({ username: 'ModOnly', group: 'moderator' });
    const m = client(); await m.login('ModOnly');
    expect((await m.get('/mod')).status).toBe(200);
    expect((await m.get('/admin/terms')).status).toBe(403);
  });
});
