/** @jsxImportSource hono/jsx */
import { defineModule, crypto, Box, Csrf, Field, Checkbox, Notice, form, str, bool, type AuthProviderDef, type Identity } from '../../src/sdk/index.ts';

/**
 * A local, simulated identity provider so the full OAuth flow (authorize page → signed code → callback →
 * username selection → linking) can be exercised without real credentials. Only works when AUTH_DEV_PROVIDER=1
 * and NODE_ENV is not "production" (core also refuses to start in production with that variable set).
 */
const active = () => process.env.AUTH_DEV_PROVIDER === '1' && process.env.NODE_ENV !== 'production';

/** "Authorization code": HMAC-signed identity bound to the PKCE challenge, valid for two minutes. */
export function issueDevCode(identity: Omit<Identity, 'provider'>, codeChallenge: string): string {
  const payload = Buffer.from(JSON.stringify({ ...identity, cc: codeChallenge, exp: Date.now() + 120_000 })).toString('base64url');
  return `${payload}.${crypto.hmac('devcode:' + payload)}`;
}
function verifyDevCode(code: string, verifier: string): Identity | null {
  const [payload, sig] = code.split('.');
  if (!payload || !sig || !crypto.safeEqual(sig, crypto.hmac('devcode:' + payload))) return null;
  const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (d.exp < Date.now() || d.cc !== crypto.sha256(verifier)) return null;
  return { provider: 'dev', subject: String(d.subject), email: d.email || null, emailVerified: !!d.emailVerified, displayName: d.displayName || null };
}

const provider: AuthProviderDef = {
  id: 'dev', name: 'Test identity provider', pkce: true, envVars: ['AUTH_DEV_PROVIDER=1 (development only)'],
  configured: active,
  authUrl(state, verifier, _nonce, redirect) {
    const url = new URL(redirect.replace(/\/auth\/dev\/callback$/, '/m/dev-auth/authorize'));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', crypto.sha256(verifier));
    return url;
  },
  async exchange({ code, verifier }) {
    const id = verifyDevCode(code, verifier);
    if (!id) throw new Error('Invalid authorization code');
    return id;
  },
};

export default defineModule({
  id: 'dev-auth',
  name: 'Test identity provider',
  version: '1.0.0',
  description: 'Simulated sign-in provider for development and automated tests. Inactive unless AUTH_DEV_PROVIDER=1 outside production.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  setup(ctx) {
    ctx.register.authProvider(provider);
    ctx.routes.get('/authorize', async (c) => {
      if (!active()) return c.notFound();
      const page = c.get('page');
      return ctx.render(c, 'Test identity provider', (
        <Box title="Test identity provider (development only)" className="auth-box">
          <Notice type="warn">This simulated provider exists only in development/test builds so sign-in flows can be exercised without real credentials.</Notice>
          <form method="post" action="/m/dev-auth/authorize" class="form-grid"><Csrf ctx={page} />
            <input type="hidden" name="state" value={c.req.query('state') ?? ''} /><input type="hidden" name="cc" value={c.req.query('code_challenge') ?? ''} />
            <Field label="Provider subject ID" name="subject" value="dev-user-1" required />
            <Field label="Email (optional)" name="email" type="email" value="" />
            <Checkbox label="Provider says the email is verified" name="emailVerified" />
            <Field label="Display name" name="displayName" value="Test Person" />
            <div class="form-actions"><button class="btn btn-primary" name="decision" value="allow">Authorize</button> <button class="btn" name="decision" value="deny">Deny</button></div>
          </form>
        </Box>
      ), { noPane: true });
    });
    ctx.routes.post('/authorize', async (c) => {
      if (!active()) return c.notFound();
      const b = await form(c);
      const state = encodeURIComponent(str(b.state));
      if (str(b.decision) === 'deny') return c.redirect(`/auth/dev/callback?error=access_denied&state=${state}`);
      const code = issueDevCode({ subject: str(b.subject), email: str(b.email) || null, emailVerified: bool(b.emailVerified), displayName: str(b.displayName) || null }, str(b.cc));
      return c.redirect(`/auth/dev/callback?code=${encodeURIComponent(code)}&state=${state}`);
    });
  },
});
