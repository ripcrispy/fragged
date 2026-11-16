import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import crypto from 'node:crypto';
import { config } from './config.ts';
import type { Env, C, PageCtx } from './web/ctx.ts';
import { COOKIE, secureCookies, takeFlash, wantsJson } from './web/ctx.ts';
import { resolveSession } from './services/auth.ts';
import { buildViewer } from './services/viewer.ts';
import { loadSettings } from './services/settings.ts';
import { ServiceError } from './services/users.ts';
import { isTheme } from './web/themes.ts';
import { headerCounts, page } from './web/render.tsx';
import { ErrorPage } from './web/layout.tsx';
import { randomToken, safeEqual } from './lib/crypto.ts';
import { log } from './lib/log.ts';
import { embedOrigins } from './lib/media.ts';

import { forumRoutes } from './routes/forums.tsx';
import { authRoutes } from './routes/auth.tsx';
import { memberRoutes } from './routes/members.tsx';
import { settingsRoutes } from './routes/settings.tsx';
import { messageRoutes } from './routes/messages.tsx';
import { apiRoutes } from './routes/api.ts';
import { miscRoutes } from './routes/misc.tsx';
import { modRoutes } from './routes/mod.tsx';
import { adminRoutes } from './routes/admin.tsx';
import { logRoutes } from './routes/admin-logs.tsx';
import { moduleAdminRoutes } from './routes/admin-modules.tsx';
import { mountModules } from './modules/runtime.ts';
import './web/core-nav.ts';
import { registries } from './modules/registry.ts';
import { moduleQueues } from './web/extensions.tsx';
import { mediaRoutes } from './routes/media.ts';

const CSRF_EXEMPT = new Set(['/auth/apple/callback']);

export function clientIp(c: C): string | null {
  if (config.TRUST_PROXY) {
    const xf = c.req.header('x-forwarded-for');
    if (xf) return xf.split(',')[0].trim().slice(0, 64);
  }
  const env = (c.env as any)?.incoming?.socket?.remoteAddress;
  return env ? String(env).slice(0, 64) : null;
}

export function createApp() {
  const app = new Hono<Env>();

  // ── security headers + CSP (per-request nonce) ──
  app.use('*', async (c, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    c.set('nonce', nonce);
    await next();
    if (c.req.path.startsWith('/media/')) return; // media sets its own strict headers
    c.header('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' https: data:",
      `frame-src ${embedOrigins().join(' ') || "'none'"}`,
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self' https://accounts.google.com https://discord.com https://www.facebook.com https://appleid.apple.com https://github.com",
      "frame-ancestors 'none'",
    ].join('; '));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProd) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  // ── request size limit (uploads are further limited per purpose) ──
  app.use('*', bodyLimit({ maxSize: 12 * 1024 * 1024, onError: (c) => c.text('Request too large', 413) }));

  // ── static assets (outside of the uploads directory) ──
  app.use('/css/*', serveStatic({ root: './public', onFound: (_p, c) => { c.header('Cache-Control', config.isProd ? 'public, max-age=86400' : 'no-cache'); } }));
  app.use('/js/*', serveStatic({ root: './public', onFound: (_p, c) => { c.header('Cache-Control', config.isProd ? 'public, max-age=86400' : 'no-cache'); } }));
  app.use('/img/*', serveStatic({ root: './public', onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=86400'); } }));
  app.get('/healthz', (c) => c.json({ ok: true }));

  // ── session, viewer, CSRF ──
  app.use('*', async (c, next) => {
    const ip = clientIp(c);
    const ua = c.req.header('user-agent')?.slice(0, 300) ?? null;
    const resolved = await resolveSession(getCookie(c, COOKIE.session));
    const guestTheme = getCookie(c, COOKIE.theme);
    const viewer = await buildViewer(resolved?.user ?? null, resolved?.session ?? null, ip, ua, isTheme(guestTheme) ? guestTheme : undefined);
    c.set('viewer', viewer);

    let csrf = getCookie(c, COOKIE.csrf);
    if (!csrf || csrf.length < 20) {
      csrf = randomToken(24);
      setCookie(c, COOKIE.csrf, csrf, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365 });
    }
    c.set('csrf', csrf);

    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !CSRF_EXEMPT.has(c.req.path)) {
      const origin = c.req.header('origin');
      if (origin && !config.allowedOrigins.has(origin)) {
        log.warn('blocked cross-origin request', { origin, path: c.req.path, allowed: [...config.allowedOrigins] });
        const msg = 'Cross-origin request blocked.';
        if (wantsJson(c)) return c.json({ error: msg, code: 'origin' }, 403);
        return c.text(`${msg} This site is configured for ${[...config.allowedOrigins].join(', ')}. If you reached it via another address, use one of those, or ask the administrator to add it to ALLOWED_ORIGINS.`, 403);
      }
      let token = c.req.header('x-csrf-token');
      if (!token) {
        const ct = c.req.header('content-type') ?? '';
        if (ct.includes('form')) {
          const body = await c.req.parseBody({ all: true }); // cached by Hono for later handlers
          token = typeof body._csrf === 'string' ? body._csrf : Array.isArray(body._csrf) ? String(body._csrf[0]) : undefined;
        }
      }
      if (!token || !safeEqual(token, csrf)) {
        if (wantsJson(c)) return c.json({ error: 'Your session expired. Reload the page and try again.', code: 'csrf' }, 403);
        return c.text('Your session expired or the form was submitted from another site. Go back, reload the page and try again.', 403);
      }
    }

    const settings = await loadSettings();
    const isStaffish = await viewer.can('admin.access');
    const canMod = await viewer.can('mod.reports');
    const ctx: PageCtx = {
      viewer, csrf, nonce: c.get('nonce'), path: c.req.path, url: new URL(c.req.url),
      site: { site_name: settings.site_name, site_tagline: settings.site_tagline, announcement: settings.announcement, show_online_list: settings.show_online_list, presence_enabled: settings.presence_enabled },
      theme: isTheme(viewer.settings.theme) ? viewer.settings.theme : 'classic',
      counts: viewer.user && !wantsJson(c) ? await headerCounts(viewer.user.id, canMod) : { notifications: 0, messages: 0, friendRequests: 0, modQueue: 0 },
      flash: wantsJson(c) || m !== 'GET' ? [] : takeFlash(c),
      isStaff: isStaffish || canMod,
      canAdmin: isStaffish,
      canMod,
    };
    if (viewer.user && !wantsJson(c) && registries.modQueues.active().length) {
      // module moderation queues add to the header badge
      for (const q of await moduleQueues(viewer)) ctx.counts.modQueue += q.count;
      ctx.canMod = ctx.canMod || (await moduleQueues(viewer)).length > 0;
    }
    c.set('page', ctx);

    // maintenance mode: staff and the login page keep working
    if (settings.maintenance_mode && !isStaffish && !['/login', '/logout'].includes(c.req.path) && !c.req.path.startsWith('/auth/')) {
      if (wantsJson(c)) return c.json({ error: settings.maintenance_message, code: 'maintenance' }, 503);
      return page(c, 'Maintenance', <ErrorPage ctx={ctx} status={503} title="Down for maintenance" message={settings.maintenance_message} loginForm={!viewer.user} />, { noPane: true, status: 503, crumbs: [{ label: 'Maintenance' }] }) as any;
    }
    await next();
  });

  app.route('/', mediaRoutes);
  app.route('/', apiRoutes);
  app.route('/', authRoutes);
  app.route('/', forumRoutes);
  app.route('/', memberRoutes);
  app.route('/', settingsRoutes);
  app.route('/', messageRoutes);
  app.route('/', miscRoutes);
  app.route('/', modRoutes);
  app.route('/', logRoutes);
  app.route('/', moduleAdminRoutes);
  app.route('/', adminRoutes);
  mountModules(app);

  app.notFound(async (c) => {
    if (wantsJson(c as C)) return c.json({ error: 'Not found' }, 404);
    const ctx = (c as C).get('page');
    if (!ctx) return c.text('Not found', 404);
    return page(c as C, 'Page not found', <ErrorPage ctx={ctx} status={404} title="Page not found" message="We couldn't find that page. It may have been moved, deleted or never existed." />, { noPane: true, status: 404, crumbs: [{ label: 'Page not found' }] });
  });

  app.onError(async (err, c) => {
    const cc = c as C;
    if (err instanceof ServiceError) {
      if (wantsJson(cc)) return c.json({ error: err.message, code: err.code }, err.status as any);
      const ctx = cc.get('page');
      if (!ctx) return c.text(err.message, err.status as any);
      const title = err.status === 401 ? 'Sign in required' : err.status === 403 ? 'Permission denied' : err.status === 404 ? 'Not found' : err.status === 429 ? 'Slow down' : 'Something went wrong';
      const msg = err.status === 401 ? `${err.message} If you don't have an account yet, you can register for free.` : err.message;
      return page(cc, title, <ErrorPage ctx={ctx} status={err.status} title={title} message={msg} loginForm={err.status === 401 || (err.status === 403 && !ctx.viewer.user)} />, { noPane: true, status: err.status, crumbs: [{ label: title }] });
    }
    log.error('unhandled error', { path: c.req.path, error: String(err?.stack ?? err) });
    if (wantsJson(cc)) return c.json({ error: 'Internal server error' }, 500);
    const ctx = cc.get('page');
    if (!ctx) return c.text('Internal server error', 500);
    return page(cc, 'Error', <ErrorPage ctx={ctx} status={500} title="Something went wrong" message="An unexpected error occurred. It has been logged; please try again." />, { noPane: true, status: 500, crumbs: [{ label: 'Error' }] });
  });

  return app;
}
