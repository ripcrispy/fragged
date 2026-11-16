import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { schema, setDb, closeDb, getDb } from '../src/db/client.ts';
import { ensureBootstrap } from '../src/db/bootstrap.ts';
import { invalidatePermissionCache } from '../src/services/permissions.ts';
import { invalidateSettings, setSetting } from '../src/services/settings.ts';
import { invalidatePolicy } from '../src/services/policy.ts';
import { invalidateEmoji } from '../src/services/emoji.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { createUser, getUserById } from '../src/services/users.ts';
import { buildViewer } from '../src/services/viewer.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { slugify } from '../src/lib/validate.ts';
import { createApp } from '../src/app.tsx';

let dropDb: (() => Promise<void>) | null = null;
export async function setupDb() {
  if (process.env.TEST_DATABASE_URL) {
    // real PostgreSQL: a private database per test file, cloned from the migrated template
    const pg = (await import('pg')).default;
    const { createDb } = await import('../src/db/client.ts');
    const { withDb } = await import('./global-setup.ts');
    const name = `fragged_test_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`create database "${name}" template fragged_test_tpl`);
    await admin.end();
    setDb(await createDb({ url: withDb(process.env.TEST_DATABASE_URL, name) }));
    dropDb = async () => { const a = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await a.connect(); await a.query(`drop database if exists "${name}" with (force)`); await a.end(); };
  } else {
    const snap = process.env.TEST_DB_SNAPSHOT!;
    const blob = new Blob([fs.readFileSync(snap)]);
    const client = new PGlite({ loadDataDir: blob });
    await client.waitReady;
    setDb({ db: drizzle(client, { schema }) as any, close: () => client.close() });
  }
  invalidatePermissionCache(); invalidateSettings(); invalidatePolicy(); invalidateEmoji(); resetLimits();
  await ensureBootstrap();
  const { loadModules, syncModules } = await import('../src/modules/runtime.ts');
  await loadModules();
  await syncModules();
  // tests exercise posting directly unless they opt into verification
  await setSetting('require_email_verification', false);
  await setSetting('require_date_of_birth', false);
}
export async function teardownDb() { await closeDb(); await dropDb?.(); dropDb = null; }

let n = 0;
export async function makeUser(opts: { username?: string; group?: string; password?: string; email?: string | null } = {}) {
  const username = opts.username ?? `user${++n}x${Math.floor(Math.random() * 1e4)}`;
  const u = await createUser({ username, email: opts.email === undefined ? `${username.toLowerCase()}@example.test` : opts.email, emailVerified: true, passwordHash: await hashPassword(opts.password ?? 'correct horse battery'), groupSlug: opts.group ?? 'member' });
  return u;
}
export async function viewerFor(userId: number | null) {
  const u = userId ? await getUserById(userId) : null;
  return buildViewer(u, null, '127.0.0.1', 'vitest');
}
export async function makeForum(name = 'Test Forum') {
  const db = getDb();
  const [c] = await db.insert(schema.categories).values({ name: 'Cat ' + name, slug: slugify('cat ' + name + Math.random()) }).returning();
  const [f] = await db.insert(schema.forums).values({ categoryId: c.id, name, slug: slugify(name + '-' + Math.floor(Math.random() * 1e6)) }).returning();
  return f;
}

/** Minimal cookie-jar HTTP client against the Hono app (no network). */
export function client(app = createApp()) {
  const jar = new Map<string, string>();
  let csrf = '';
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method: string, path: string, body?: Record<string, string | string[]> | FormData, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { cookie: cookieHeader(), ...headers };
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      if (!('_csrf' in body) && !headers['x-csrf-token']) p.append('_csrf', csrf);
      payload = p.toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await app.request(path, { method, headers: h, body: payload });
    for (const sc of (res.headers as any).getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const [k, ...rest] = pair.split('=');
      const v = rest.join('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v);
      if (k === 'ff_csrf') csrf = v;
    }
    const text = await res.text();
    const m = /name="csrf-token" content="([^"]+)"/.exec(text);
    if (m) csrf = m[1];
    return { status: res.status, text, headers: res.headers, location: res.headers.get('location') };
  }
  return {
    jar, get csrf() { return csrf; },
    get: (p: string) => req('GET', p),
    post: (p: string, body: Record<string, string | string[]> = {}, headers?: Record<string, string>) => req('POST', p, body, headers),
    postForm: (p: string, fd: FormData) => { fd.append('_csrf', csrf); return req('POST', p, fd); },
    json: async (method: string, p: string, body?: unknown) => {
      const res = await app.request(p, { method, headers: { cookie: cookieHeader(), 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    },
    async login(login: string, password = 'correct horse battery') {
      await req('GET', '/login');
      return req('POST', '/login', { login, password });
    },
  };
}
