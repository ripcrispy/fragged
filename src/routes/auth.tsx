import { Hono } from 'hono';
import { emit, applyFilters } from '../modules/registry.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { COOKIE, form, str, bool, setFlash, secureCookies } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, Field, Notice, Select, Checkbox } from '../web/components.tsx';
import { LoginPanel } from '../web/layout.tsx';
import * as A from '../services/auth.ts';
import * as O from '../services/oauth.ts';
import { getSetting } from '../services/settings.ts';
import { ServiceError, createUser, getUserById, checkUsername, getUserByLogin } from '../services/users.ts';
import { securityEvent } from '../services/audit.ts';
import { hit, peek, DEFAULT_LIMITS } from '../lib/ratelimit.ts';
import { getDb, schema } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { emailSchema } from '../lib/validate.ts';
import { isValidTimezone } from '../lib/time.ts';

export const authRoutes = new Hono<Env>();

const info = (c: C) => ({ ip: c.get('viewer').ip, userAgent: c.get('viewer').userAgent });

async function throttle(c: C, action: keyof typeof DEFAULT_LIMITS, extraKey = '', record = true) {
  const r = await (record ? hit : peek)(`${action}:${c.get('viewer').ip}:${extraKey}`, DEFAULT_LIMITS[action]);
  if (!r.ok) throw new ServiceError(`Too many attempts. Please wait ${Math.ceil(r.retryAfter / 60)} minute(s) and try again.`, 429, 'rate_limited');
}

export async function startSession(c: C, userId: number, remember: boolean) {
  const { token, maxAge } = await A.createSession(userId, remember, info(c));
  setCookie(c, COOKIE.session, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureCookies(), ...(remember ? { maxAge } : {}) });
}

const TIMEZONES = (() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC']; } })();

const hasIcon = (id: string) => fs.existsSync(path.resolve('public/img/providers', `${id}.svg`));

export async function ProviderButtons({ ctx, mode, returnTo }: { ctx: PageCtx; mode: 'login' | 'register' | 'link'; returnTo?: string }) {
  const list = await O.enabledProviders();
  if (!list.length) return <></>;
  if (mode === 'register' && !(await getSetting('allow_oauth_registration'))) return <></>;
  return (
    <div class="providers">
      <p class="providers-label">{mode === 'link' ? 'Connect a sign-in provider' : mode === 'register' ? 'Or register with' : 'Or sign in with'}</p>
      <div class="provider-buttons">
        {list.map((p) => (
          <form method="post" action={`/auth/${p.id}`} class="inline-form" data-provider-form>
            <Csrf ctx={ctx} />
            <input type="hidden" name="mode" value={mode === 'link' ? 'link' : 'login'} />
            {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
            <button class={`btn provider-btn provider-${p.id}`} type="submit">
              {hasIcon(p.id) ? <img src={`/img/providers/${p.id}.svg`} alt="" width="18" height="18" /> : <span class="provider-glyph" aria-hidden="true">{p.name[0]}</span>}
              <span>{mode === 'link' ? `Connect ${p.name}` : `Continue with ${p.name}`}</span>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}

// ─────────────── login / logout ───────────────

authRoutes.get('/login', async (c) => {
  const ctx = c.get('page');
  if (ctx.viewer.user) return c.redirect(O.safeReturn(c.req.query('returnTo')) ?? '/');
  const returnTo = O.safeReturn(c.req.query('returnTo'));
  const err = c.req.query('error');
  return page(c, 'Sign in', (
    <Box title="Sign in to Fragged" className="auth-box">
      {err ? <Notice type="error">{err}</Notice> : null}
      <LoginPanel ctx={ctx} returnTo={returnTo} />
      <ProviderButtons ctx={ctx} mode="login" returnTo={returnTo} />
      <p class="auth-alt">New here? <a href="/register">Create an account</a>.</p>
    </Box>
  ), { crumbs: [{ label: 'Sign in' }], noPane: true });
});

authRoutes.post('/login', async (c) => {
  const ctx = c.get('page');
  const b = await form(c);
  const login = str(b.login).trim();
  const returnTo = O.safeReturn(str(b.returnTo)) ?? '/';
  // only failed attempts count towards the limit (per IP and per account name)
  try {
    await throttle(c, 'login', '', false);
    await throttle(c, 'login', login.toLowerCase(), false);
  } catch (e) {
    await securityEvent(null, 'login_throttled', { ...info(c), detail: { login: login.slice(0, 64) } });
    throw e;
  }
  const r = await A.loginWithPassword(login, str(b.password), info(c));
  if (!r.user) {
    await throttle(c, 'login'); await throttle(c, 'login', login.toLowerCase());
    return page(c, 'Sign in', (
      <Box title="Sign in to Fragged" className="auth-box">
        <LoginPanel ctx={ctx} returnTo={returnTo} error={r.error} login={login} />
        <ProviderButtons ctx={ctx} mode="login" returnTo={returnTo} />
      </Box>
    ), { crumbs: [{ label: 'Sign in' }], noPane: true, status: 401 });
  }
  await startSession(c, r.user.id, bool(b.remember));
  return c.redirect(returnTo);
});

authRoutes.post('/logout', async (c) => {
  const v = c.get('viewer');
  if (v.session) { await A.revokeSession(v.session.id); await securityEvent(v.user!.id, 'logout', info(c)); }
  deleteCookie(c, COOKIE.session, { path: '/' });
  return c.redirect('/');
});

// ─────────────── registration ───────────────

function TimezoneSelect({ value }: { value?: string }) {
  return (
    <div class="field">
      <label for="f-timezone">Timezone</label>
      <select id="f-timezone" name="timezone" data-detect-timezone>{TIMEZONES.map((t) => <option value={t} selected={t === (value || 'UTC')}>{t}</option>)}</select>
    </div>
  );
}

async function registerPage(c: C, values: Record<string, string> = {}, errors: Record<string, string> = {}) {
  const ctx = c.get('page');
  const open = await getSetting('registration_open');
  const pwAllowed = await getSetting('allow_password_registration');
  const needDob = await getSetting('require_date_of_birth');
  const minAge = await getSetting('minimum_age');
  return page(c, 'Register', (
    <Box title="Create your Fragged account" className="auth-box">
      {!open ? <Notice type="warn">Registration is currently closed.</Notice> : (
        <>
          <p>Registration is free. Please read the <a href="/rules" target="_blank">Community Rules</a> before joining.</p>
          {Object.keys(errors).length ? <Notice type="error" title="Please fix the highlighted fields.">{''}</Notice> : null}
          {pwAllowed ? (
            <form method="post" action="/register" class="form-grid" novalidate>
              <Csrf ctx={ctx} />
              <Field label="Username" name="username" value={values.username} error={errors.username} required maxlength={24} minlength={3} autocomplete="username" hint="3–24 characters: letters, numbers, _ . -  This is how you'll appear everywhere." attrs={{ 'data-username-check': '' }} />
              <Field label="Email address" name="email" type="email" value={values.email} error={errors.email} required autocomplete="email" hint="Used to verify your account and for password recovery. Never shown publicly." />
              <Field label="Password" name="password" type="password" error={errors.password} required minlength={10} autocomplete="new-password" hint="At least 10 characters. A passphrase works well." />
              <Field label="Confirm password" name="confirm" type="password" error={errors.confirm} required autocomplete="new-password" />
              {needDob ? <Field label="Date of birth" name="dateOfBirth" type="date" value={values.dateOfBirth} error={errors.dateOfBirth} required hint={`You must be at least ${minAge}. Your date of birth is never shown publicly.`} /> : null}
              <TimezoneSelect value={values.timezone} />
              {/* honeypot for naive bots */}
              <div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex={-1} autocomplete="off" /></label></div>
              <div class={`field field-check ${errors.acceptTerms ? 'has-error' : ''}`}>
                <label><input type="checkbox" name="acceptTerms" value="1" checked={values.acceptTerms === '1'} required /> I agree to the <a href="/pages/terms" target="_blank">Terms of Service</a> and <a href="/rules" target="_blank">Community Rules</a>, and have read the <a href="/pages/privacy" target="_blank">Privacy Policy</a>.</label>
                {errors.acceptTerms ? <div class="field-error">{errors.acceptTerms}</div> : null}
              </div>
              <div class="form-actions"><button class="btn btn-primary">Create account</button></div>
            </form>
          ) : <Notice type="info">Password registration is disabled. Use one of the providers below.</Notice>}
          <ProviderButtons ctx={ctx} mode="register" />
          <p class="auth-alt">Already a member? <a href="/login">Sign in</a>.</p>
        </>
      )}
    </Box>
  ), { crumbs: [{ label: 'Register' }], noPane: true, status: Object.keys(errors).length ? 422 : 200 });
}

authRoutes.get('/register', async (c) => (c.get('viewer').user ? c.redirect('/') : registerPage(c)));

authRoutes.post('/register', async (c) => {
  const b = await form(c);
  const values = { username: str(b.username).trim(), email: str(b.email).trim(), dateOfBirth: str(b.dateOfBirth), timezone: str(b.timezone), acceptTerms: bool(b.acceptTerms) ? '1' : '' };
  if (str(b.website)) { await securityEvent(null, 'register_honeypot', info(c)); return c.redirect('/'); }
  await throttle(c, 'register');
  const r = await A.register({ ...values, password: str(b.password), confirm: str(b.confirm), acceptTerms: bool(b.acceptTerms) }, info(c));
  if (r.errors) return registerPage(c, values, r.errors);
  await startSession(c, r.user!.id, false);
  setFlash(c, { type: 'ok', text: (await getSetting('require_email_verification')) ? `Welcome, ${r.user!.username}! Check your inbox for a verification link.` : `Welcome to Fragged, ${r.user!.username}!` });
  return c.redirect('/');
});

authRoutes.get('/verify-email', async (c) => {
  const u = await A.verifyEmail(c.req.query('token') ?? '');
  setFlash(c, u ? { type: 'ok', text: 'Thanks — your email address is verified.' } : { type: 'error', text: 'That verification link is invalid or has expired. You can request a new one.' });
  return c.redirect('/');
});

authRoutes.post('/verify-email/resend', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return c.redirect('/login');
  await throttle(c, 'verify_resend', String(v.user.id));
  if (!v.user.emailVerifiedAt) await A.sendVerificationEmail(v.user);
  setFlash(c, { type: 'ok', text: 'A new verification link has been sent.' });
  return c.redirect(c.req.header('referer')?.startsWith(config.APP_URL) ? new URL(c.req.header('referer')!).pathname : '/');
});

authRoutes.get('/confirm-email-change', async (c) => {
  const err = await A.confirmEmailChange(c.req.query('token') ?? '');
  setFlash(c, err ? { type: 'error', text: err } : { type: 'ok', text: 'Your email address was updated.' });
  return c.redirect(c.get('viewer').user ? '/settings/account' : '/login');
});

// ─────────────── password reset ───────────────

authRoutes.get('/forgot-password', async (c) => {
  const ctx = c.get('page');
  return page(c, 'Forgot password', (
    <Box title="Reset your password" className="auth-box">
      <p>Enter your username or email address. If an account with an email address matches, we'll send a reset link.</p>
      <form method="post" action="/forgot-password" class="form-grid"><Csrf ctx={ctx} />
        <Field label="Username or email" name="login" required maxlength={254} autocomplete="username" />
        <div class="form-actions"><button class="btn btn-primary">Send reset link</button></div>
      </form>
      <p class="muted">Signed up with Google, Discord, Facebook or Apple? Just sign in with that provider — you don't need a password.</p>
    </Box>
  ), { crumbs: [{ label: 'Forgot password' }], noPane: true });
});

authRoutes.post('/forgot-password', async (c) => {
  const b = await form(c);
  await throttle(c, 'password_reset');
  await A.requestPasswordReset(str(b.login), info(c));
  setFlash(c, { type: 'ok', text: 'If an account matches, a reset link is on its way. Check your inbox (and spam folder).' });
  return c.redirect('/login');
});

async function resetPage(c: C, token: string, error?: string) {
  const ctx = c.get('page');
  return page(c, 'Choose a new password', (
    <Box title="Choose a new password" className="auth-box">
      {error ? <Notice type="error">{error}</Notice> : null}
      <form method="post" action="/reset-password" class="form-grid"><Csrf ctx={ctx} />
        <input type="hidden" name="token" value={token} />
        <Field label="New password" name="password" type="password" required minlength={10} autocomplete="new-password" />
        <Field label="Confirm new password" name="confirm" type="password" required autocomplete="new-password" />
        <div class="form-actions"><button class="btn btn-primary">Set password</button></div>
      </form>
    </Box>
  ), { noPane: true, status: error ? 422 : 200 });
}
authRoutes.get('/reset-password', async (c) => resetPage(c, c.req.query('token') ?? ''));
authRoutes.post('/reset-password', async (c) => {
  const b = await form(c);
  await throttle(c, 'password_reset');
  const err = await A.resetPassword(str(b.token), str(b.password), str(b.confirm), info(c));
  if (err) return resetPage(c, str(b.token), err);
  setFlash(c, { type: 'ok', text: 'Your password was changed. Please sign in.' });
  return c.redirect('/login');
});

// ─────────────── re-authentication for sensitive operations ───────────────

authRoutes.get('/reauth', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  if (!v.user) return c.redirect('/login');
  const returnTo = O.safeReturn(c.req.query('returnTo')) ?? '/settings/security';
  const { hasPassword, linked } = await O.authMethods(v.user.id);
  const providers = (await O.enabledProviders()).filter((p) => linked.some((l) => l.provider === p.id));
  return page(c, 'Confirm it’s you', (
    <Box title="Confirm it's you" className="auth-box">
      <p>For your security, please confirm your identity before changing sign-in or account settings.</p>
      {c.req.query('error') ? <Notice type="error">{c.req.query('error')}</Notice> : null}
      {hasPassword ? (
        <form method="post" action="/reauth" class="form-grid"><Csrf ctx={ctx} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <Field label="Password" name="password" type="password" required autocomplete="current-password" />
          <div class="form-actions"><button class="btn btn-primary">Confirm</button></div>
        </form>
      ) : null}
      {providers.length ? <div class="providers"><p class="providers-label">{hasPassword ? 'Or confirm with' : 'Confirm with'}</p><div class="provider-buttons">
        {providers.map((p) => <form method="post" action={`/auth/${p.id}`} class="inline-form"><Csrf ctx={ctx} /><input type="hidden" name="mode" value="reauth" /><input type="hidden" name="returnTo" value={returnTo} /><button class={`btn provider-btn provider-${p.id}`}><span class="provider-glyph" aria-hidden="true">{p.name[0]}</span> {p.name}</button></form>)}
      </div></div> : null}
      {!hasPassword && !providers.length ? <Notice type="warn">No sign-in method is currently available to confirm your identity. Contact an administrator for help.</Notice> : null}
    </Box>
  ), { noPane: true });
});

authRoutes.post('/reauth', async (c) => {
  const v = c.get('viewer');
  if (!v.user || !v.session) return c.redirect('/login');
  const b = await form(c);
  const returnTo = O.safeReturn(str(b.returnTo)) ?? '/settings/security';
  await throttle(c, 'login', 'reauth:' + v.user.id);
  const { verifyPassword } = await import('../lib/crypto.ts');
  if (!(await verifyPassword(str(b.password), v.user.passwordHash))) {
    await securityEvent(v.user.id, 'reauth_failed', info(c));
    return c.redirect(`/reauth?returnTo=${encodeURIComponent(returnTo)}&error=${encodeURIComponent('Incorrect password.')}`);
  }
  await A.markReauthenticated(v.session.id);
  return c.redirect(returnTo);
});

// ─────────────── OAuth / OIDC ───────────────

function flowCookie(c: C, value: string, formPost: boolean) {
  // Apple returns via cross-site POST (form_post), which requires SameSite=None; Secure.
  const sameSite = formPost && secureCookies() ? 'None' : 'Lax';
  setCookie(c, COOKIE.oauth, value, { path: '/auth', httpOnly: true, secure: secureCookies(), sameSite, maxAge: 600 });
}

authRoutes.post('/auth/:provider', async (c) => {
  const v = c.get('viewer');
  const b = await form(c);
  let mode = str(b.mode) as 'login' | 'link' | 'reauth';
  const returnTo = str(b.returnTo) || undefined;
  if ((mode === 'link' || mode === 'reauth') && !v.user) return c.redirect('/login');
  if (mode === 'link' && !(await A.isRecentlyAuthenticated(v.session))) return c.redirect(`/reauth?returnTo=${encodeURIComponent('/settings/security')}`);
  if (mode !== 'link' && mode !== 'reauth') mode = 'login';
  await throttle(c, 'oauth_start');
  const flow = await O.beginFlow(c.req.param('provider'), mode === 'login' ? 'login' : 'link', { userId: v.user?.id, returnTo });
  // reauth reuses the "link" mode check (identity must belong to this user) but doesn't add a link
  const sealed = mode === 'reauth' ? O.sealFlow({ ...O.openFlow(flow.cookie)!, r: `reauth:${O.safeReturn(returnTo) ?? '/settings/security'}` }) : flow.cookie;
  flowCookie(c, sealed, flow.formPost);
  return c.redirect(flow.url);
});

async function callback(c: C) {
  const provider = c.req.param('provider')!;
  const v = c.get('viewer');
  let params: { code?: string; state?: string; error?: string; form?: Record<string, string> };
  if (c.req.method === 'POST') {
    const b = await c.req.parseBody();
    params = { code: str(b.code), state: str(b.state), error: str(b.error) || undefined, form: Object.fromEntries(Object.entries(b).map(([k, val]) => [k, str(val)])) };
  } else {
    params = { code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') };
  }
  const flow = O.openFlow(getCookie(c, COOKIE.oauth));
  deleteCookie(c, COOKIE.oauth, { path: '/auth' });
  let identity: O.Identity;
  try {
    identity = await O.completeFlow(provider, flow, params);
  } catch (e) {
    if (e instanceof ServiceError) {
      const dest = flow?.mode === 'link' ? '/settings/security' : '/login';
      if (dest === '/login') return c.redirect(`/login?error=${encodeURIComponent(e.message)}`);
      setFlash(c, { type: 'error', text: e.message });
      return c.redirect(dest);
    }
    throw e;
  }
  const linked = await O.findLinked(identity.provider, identity.subject);

  // Re-authentication via provider: identity must already belong to the signed-in user.
  if (flow!.r?.startsWith('reauth:')) {
    const back = flow!.r.slice(7);
    if (!v.user || !v.session || linked?.userId !== v.user.id) { setFlash(c, { type: 'error', text: 'That account is not connected to you.' }); return c.redirect('/reauth'); }
    await A.markReauthenticated(v.session.id);
    await O.touchLinked(linked.id);
    return c.redirect(back);
  }

  if (flow!.mode === 'link') {
    if (!v.user || v.user.id !== flow!.uid) { setFlash(c, { type: 'error', text: 'Your session changed during linking. Please try again.' }); return c.redirect('/settings/security'); }
    try {
      await O.linkIdentity(v.user, identity, info(c));
      setFlash(c, { type: 'ok', text: `${providerName(provider)} connected. You can now sign in with it.` });
    } catch (e) {
      if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e;
    }
    return c.redirect('/settings/security');
  }

  // login / register
  if (linked) {
    const user = await getUserById(linked.userId);
    if (!user || user.closedAt) return c.redirect(`/login?error=${encodeURIComponent('This account is closed.')}`);
    await O.touchLinked(linked.id);
    await securityEvent(user.id, 'login', { ...info(c), provider });
    await emit('user.loggedIn', { userId: user.id, provider });
    await startSession(c, user.id, true);
    return c.redirect(flow!.r ?? '/');
  }
  if (v.user) {
    // already signed in with a different account: don't silently link or switch
    setFlash(c, { type: 'error', text: `That ${providerName(provider)} account isn't connected to Fragged. To connect it to your account, use Settings › Security.` });
    return c.redirect('/settings/security');
  }
  if (!(await getSetting('registration_open')) || !(await getSetting('allow_oauth_registration'))) {
    return c.redirect(`/login?error=${encodeURIComponent('No Fragged account is connected to that sign-in, and new registrations are currently closed.')}`);
  }
  const token = await O.createPending(identity, flow!.r);
  setCookie(c, COOKIE.pending, token, { path: '/register', httpOnly: true, secure: secureCookies(), sameSite: 'Lax', maxAge: 1800 });
  await securityEvent(null, 'oauth_pending_registration', { ...info(c), provider });
  return c.redirect('/register/complete');
}
authRoutes.get('/auth/:provider/callback', callback);
authRoutes.post('/auth/:provider/callback', callback);

const providerName = (id: string) => O.providerImpl(id)?.name ?? id;

async function completePage(c: C, pending: NonNullable<Awaited<ReturnType<typeof O.getPending>>>, values: Record<string, string> = {}, errors: Record<string, string> = {}) {
  const ctx = c.get('page');
  const needDob = await getSetting('require_date_of_birth');
  const suggestion = values.username === undefined ? await O.suggestUsername(pending.providerDisplayName) : '';
  const emailTaken = pending.providerEmail ? !!(await getUserByLogin(pending.providerEmail)) : false;
  const askEmail = !pending.providerEmail || !pending.providerEmailVerified || emailTaken;
  return page(c, 'Choose your username', (
    <Box title="Almost there — choose your Fragged username" className="auth-box">
      <p>You signed in with <strong>{providerName(pending.provider)}</strong>. Your Fragged username is separate from your {providerName(pending.provider)} name and is how other members will see you.</p>
      {emailTaken ? <Notice type="info" title="An account may already exist.">If you already have a Fragged account, <a href="/login">sign in to it</a> and connect {providerName(pending.provider)} from Settings › Security instead. Accounts are never merged automatically.</Notice> : null}
      {Object.keys(errors).length ? <Notice type="error">Please fix the highlighted fields.</Notice> : null}
      <form method="post" action="/register/complete" class="form-grid"><Csrf ctx={ctx} />
        <Field label="Username" name="username" value={values.username ?? ''} error={errors.username} required maxlength={24} minlength={3} autocomplete="username" attrs={{ 'data-username-check': '' }}
          hint={suggestion ? `Suggestion: ${suggestion} (type it in if you like it — we won't pick it for you).` : '3–24 characters: letters, numbers, _ . -'} />
        {askEmail ? <Field label="Email address (optional, recommended)" name="email" type="email" value={values.email ?? ''} error={errors.email} autocomplete="email" hint="Lets you recover your account and receive security notices. We'll send a verification link." /> : <p class="muted">Email: {pending.providerEmail} (verified by {providerName(pending.provider)})</p>}
        {needDob ? <Field label="Date of birth" name="dateOfBirth" type="date" value={values.dateOfBirth} error={errors.dateOfBirth} required /> : null}
        <TimezoneSelect value={values.timezone} />
        <div class={`field field-check ${errors.acceptTerms ? 'has-error' : ''}`}>
          <label><input type="checkbox" name="acceptTerms" value="1" required /> I agree to the <a href="/pages/terms" target="_blank">Terms of Service</a> and <a href="/rules" target="_blank">Community Rules</a>.</label>
          {errors.acceptTerms ? <div class="field-error">{errors.acceptTerms}</div> : null}
        </div>
        <div class="form-actions"><button class="btn btn-primary">Complete registration</button> <a href="/register/cancel">Cancel</a></div>
      </form>
    </Box>
  ), { noPane: true, status: Object.keys(errors).length ? 422 : 200 });
}

authRoutes.get('/register/complete', async (c) => {
  const pending = await O.getPending(getCookie(c, COOKIE.pending));
  if (!pending) return c.redirect(`/login?error=${encodeURIComponent('Your registration session expired. Please sign in with your provider again.')}`);
  return completePage(c, pending);
});

authRoutes.get('/register/cancel', async (c) => {
  const pending = await O.getPending(getCookie(c, COOKIE.pending));
  if (pending) await O.deletePending(pending.id);
  deleteCookie(c, COOKIE.pending, { path: '/register' });
  return c.redirect('/');
});

authRoutes.post('/register/complete', async (c) => {
  const pending = await O.getPending(getCookie(c, COOKIE.pending));
  if (!pending) return c.redirect('/login');
  const b = await form(c);
  const values = { username: str(b.username).trim(), email: str(b.email).trim(), dateOfBirth: str(b.dateOfBirth), timezone: str(b.timezone) };
  await throttle(c, 'register');
  const errors = await A.validateRegistrationCommon({ ...values, acceptTerms: bool(b.acceptTerms) });
  // email: provider-verified address if it's free; otherwise optional user-entered address (needs verification)
  let email: string | null = null, verified = false;
  const providerEmailFree = pending.providerEmail ? !(await getUserByLogin(pending.providerEmail)) : false;
  if (pending.providerEmail && pending.providerEmailVerified && providerEmailFree) { email = pending.providerEmail; verified = true; }
  else if (values.email) {
    const p = emailSchema.safeParse(values.email);
    if (!p.success) errors.email = 'Enter a valid email address or leave it blank.';
    else if (await getUserByLogin(p.data)) errors.email = 'That email address cannot be used.';
    else email = p.data;
  }
  if (Object.keys(errors).length) return completePage(c, pending, values, errors);
  if (await O.findLinked(pending.provider, pending.providerSubject)) { await O.deletePending(pending.id); return c.redirect('/login?error=' + encodeURIComponent('That sign-in is already connected to an account. Please sign in.')); }
  const user = await getDb().transaction(async (tx) => {
    const u = await createUser({ username: values.username, email, emailVerified: verified, passwordHash: null, dateOfBirth: values.dateOfBirth || null, timezone: isValidTimezone(values.timezone) ? values.timezone : 'UTC' }, tx as any);
    await tx.insert(schema.externalAccounts).values({ userId: u.id, provider: pending.provider, providerSubject: pending.providerSubject, providerEmail: pending.providerEmail, providerEmailVerified: pending.providerEmailVerified, providerDisplayName: pending.providerDisplayName, lastAuthAt: new Date() });
    await tx.delete(schema.pendingRegistrations).where(eq(schema.pendingRegistrations.id, pending.id));
    return u;
  });
  deleteCookie(c, COOKIE.pending, { path: '/register' });
  await securityEvent(user.id, 'register', { ...info(c), provider: pending.provider });
  await emit('user.registered', { userId: user.id, provider: pending.provider });
  if (email && !verified) await A.sendVerificationEmail(user);
  await startSession(c, user.id, true);
  setFlash(c, { type: 'ok', text: `Welcome to Fragged, ${user.username}!` });
  return c.redirect(O.safeReturn(pending.returnTo) ?? '/');
});

export const _x = { Select, checkUsername };
