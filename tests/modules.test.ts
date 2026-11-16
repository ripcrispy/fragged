/** Module system: resolution, lifecycle, live enable/disable, hooks, settings, permissions, assets, SDK boundary. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolve, loadModules, syncModules, setModuleEnabled, isModuleEnabled, saveModuleSettings, moduleSettings, resetModulesForTests, type InstalledModule } from '../src/modules/runtime.ts';
import type { ModuleDefinition } from '../src/sdk/types.ts';
import { ServiceError } from '../src/services/users.ts';

const base = (over: Partial<ModuleDefinition>): ModuleDefinition => ({ id: 'x', name: 'X', version: '1.0.0', description: '', sdk: '^1.0.0', ...over });
const im = (def: ModuleDefinition, dir = 'tests/fixtures/test-modules'): InstalledModule => ({ def, dir: path.resolve(dir), source: 'local' });

describe('resolution (pure)', () => {
  it('orders dependencies first and flags problems precisely', () => {
    const r = resolve([
      im(base({ id: 'addon', dependencies: { core1: '^1.0.0' }, optionalDependencies: { extra: '^2.0.0' } })),
      im(base({ id: 'core1' })),
      im(base({ id: 'extra', version: '2.1.0' })),
      im(base({ id: 'needs-missing', dependencies: { ghost: '*' } })),
      im(base({ id: 'old-range', dependencies: { core1: '^2.0.0' } })),
      im(base({ id: 'future', sdk: '^9.0.0' })),
      im(base({ id: 'Bad_Id' })),
      im(base({ id: 'core1' })),
      im(base({ id: 'cyc-a', dependencies: { 'cyc-b': '*' } })),
      im(base({ id: 'cyc-b', dependencies: { 'cyc-a': '*' } })),
      im(base({ id: 'transitive', dependencies: { 'needs-missing': '*' } })),
    ]);
    const p = (id: string) => r.modules.find((m) => m.def.id === id && (id !== 'core1' || m.available))!;
    expect(r.order.indexOf('core1')).toBeLessThan(r.order.indexOf('addon'));
    expect(r.order.indexOf('extra')).toBeLessThan(r.order.indexOf('addon'));
    expect(p('needs-missing').problem).toMatch(/not installed/);
    expect(p('old-range').problem).toMatch(/requires core1 \^2.0.0 but 1.0.0/);
    expect(p('future').problem).toMatch(/needs SDK \^9.0.0/);
    expect(r.modules.find((m) => m.def.id === 'Bad_Id')!.problem).toMatch(/invalid id/);
    expect(r.modules.filter((m) => m.def.id === 'core1')[1].problem).toMatch(/duplicate/);
    expect(p('cyc-a').problem).toBe('dependency cycle');
    expect(p('transitive').problem).toMatch(/unavailable/);
  });
  it('rejects settings defaults that fail their schema', () => {
    const r = resolve([im(base({ id: 'bad-settings', settings: { schema: z.object({ n: z.number().min(5) }), defaults: { n: 1 }, fields: [] } }))]);
    expect(r.modules[0].problem).toMatch(/settings defaults/);
  });
});

describe('runtime with test modules', () => {
  const calls: string[] = [];
  let createApp: typeof import('../src/app.tsx').createApp;
  let helpers: typeof import('./helpers.ts');

  const testBase = base({ id: 'test-base', name: 'Test base', enabledByDefault: true });
  const testAddon = base({
    id: 'test-addon', name: 'Test addon', dependencies: { 'test-base': '^1.0.0' },
    setup(ctx) { ctx.routes.get('/', (c) => c.text('addon page')); ctx.register.navItem({ href: '/m/test-addon', label: 'Addon link', area: 'footer', order: 99 }); },
  });
  const testHooks = base({
    id: 'test-hooks', name: 'Test hooks', migrations: 'migrations', assets: 'public',
    permissions: { moderate: { label: 'Test permission', grantTo: ['member'] } },
    settings: { schema: z.object({ greeting: z.string().min(2).max(20), limit: z.number().int().min(1).max(10) }), defaults: { greeting: 'hi', limit: 3 }, fields: [] },
    async onInstall(ctx) { calls.push('install'); await ctx.db().execute(sql`insert into mod_test_hooks_counter (kind) values ('installed')`); },
    setup(ctx) {
      calls.push('setup');
      ctx.hooks.on('post.created', () => { throw new Error('boom from a faulty module'); });
      ctx.hooks.on('post.created', ({ postId }) => { calls.push(`post:${postId}`); });
      ctx.hooks.filter('post.beforeSave', (v) => {
        if (v.body.includes('forbidden-by-module')) throw new ServiceError('Rejected by test module', 422, 'module_rule');
        if (v.body.includes('shout')) return { ...v, body: v.body.toUpperCase(), userId: 999999 };
        return v;
      });
    },
  });
  const testBroken = base({ id: 'test-broken', name: 'Broken', setup() { throw new Error('setup exploded'); } });

  beforeAll(async () => {
    resetModulesForTests();
    await loadModules([im(testBase), im(testAddon), im(testHooks), im(testBroken)]);
    helpers = await import('./helpers.ts');
    await helpers.setupDb();          // loadModules inside is a no-op now (already loaded); syncModules runs for our modules
    await syncModules();
    createApp = (await import('../src/app.tsx')).createApp;
  });
  afterAll(async () => { await helpers.teardownDb(); resetModulesForTests(); });

  it('runs setup and onInstall once, applies migrations once, and marks failing modules unavailable', async () => {
    const { listModules } = await import('../src/modules/runtime.ts');
    expect(calls.filter((c) => c === 'setup')).toHaveLength(1);
    expect(calls.filter((c) => c === 'install')).toHaveLength(1);
    await syncModules();
    expect(calls.filter((c) => c === 'install')).toHaveLength(1);
    const { getDb } = await import('../src/db/client.ts');
    const rows = (await getDb().execute(sql`select count(*)::int as n from module_migrations where module_id = 'test-hooks'`)) as any;
    expect(Number((rows.rows ?? rows)[0].n)).toBe(1);
    expect(listModules().find((m) => m.def.id === 'test-broken')!.problem).toMatch(/setup failed: setup exploded/);
    expect(isModuleEnabled('test-broken')).toBe(false);
  });

  it('grants declared permissions to the requested groups on install', async () => {
    const { getDb, schema } = await import('../src/db/client.ts');
    const [g] = await getDb().select().from(schema.userGroups).where(eq(schema.userGroups.slug, 'member'));
    expect(g.permissions['test-hooks.moderate']).toBe(true);
  });

  it('enforces dependencies when enabling and disabling', async () => {
    expect(isModuleEnabled('test-addon')).toBe(true);
    await expect(setModuleEnabled('test-base', false)).rejects.toThrow(/Disable test-addon first/);
    await setModuleEnabled('test-addon', false);
    await setModuleEnabled('test-base', false);
    await expect(setModuleEnabled('test-addon', true)).rejects.toThrow(/Enable test-base first/);
    await setModuleEnabled('test-base', true);
    await setModuleEnabled('test-addon', true);
    await expect(setModuleEnabled('test-broken', true)).rejects.toThrow(/can't be enabled/);
  });

  it('toggles routes, links and assets live, without a restart', async () => {
    const app = createApp();
    const c = helpers.client(app);
    expect((await c.get('/m/test-addon')).text).toBe('addon page');
    expect((await c.get('/rules')).text).toContain('Addon link');
    expect((await c.get('/modules/test-hooks/test.css')).status).toBe(200);
    expect((await c.get('/modules/test-hooks/../migrations/0001_init.sql')).status).toBe(404);
    expect((await c.get('/modules/test-hooks/%2e%2e%2fmigrations%2f0001_init.sql')).status).toBe(404);
    await setModuleEnabled('test-addon', false);
    await setModuleEnabled('test-hooks', false);
    expect((await c.get('/m/test-addon')).status).toBe(404);
    expect((await c.get('/rules')).text).not.toContain('Addon link');
    expect((await c.get('/modules/test-hooks/test.css')).status).toBe(404);
    await setModuleEnabled('test-addon', true);
    await setModuleEnabled('test-hooks', true);
    expect((await c.get('/m/test-addon')).status).toBe(200);
  });

  it('isolates failing hook handlers, lets filters veto or transform, and protects identity fields', async () => {
    const forum = await helpers.makeForum('Hooks');
    const u = await helpers.makeUser();
    const F = await import('../src/services/forums.ts');
    const { resetLimits } = await import('../src/lib/ratelimit.ts');
    const { post } = await F.createThread(await helpers.viewerFor(u.id), forum, { title: 'Hooked', body: 'a normal post' });
    expect(calls).toContain(`post:${post.id}`); // the throwing handler before it didn't stop this one
    resetLimits();
    await expect(F.createThread(await helpers.viewerFor(u.id), forum, { title: 'Nope', body: 'forbidden-by-module text' })).rejects.toMatchObject({ code: 'module_rule' });
    resetLimits();
    const loud = await F.createThread(await helpers.viewerFor(u.id), forum, { title: 'Loud', body: 'please shout this' });
    expect(loud.post.body).toBe('PLEASE SHOUT THIS');
    expect(loud.post.userId).toBe(u.id);
    // disabled module: its filter no longer applies
    await setModuleEnabled('test-hooks', false);
    resetLimits();
    const quiet = await F.createThread(await helpers.viewerFor(u.id), forum, { title: 'Quiet', body: 'please shout this' });
    expect(quiet.post.body).toBe('please shout this');
    await setModuleEnabled('test-hooks', true);
  });

  it('validates module settings against the schema', async () => {
    expect(await moduleSettings('test-hooks')).toEqual({ greeting: 'hi', limit: 3 });
    await expect(saveModuleSettings('test-hooks', { limit: 50 })).rejects.toThrow(/limit/);
    await saveModuleSettings('test-hooks', { greeting: 'hello' });
    expect(await moduleSettings('test-hooks')).toEqual({ greeting: 'hello', limit: 3 });
  });

  it('admin modules page is admin-only and toggles are audited', async () => {
    const app = createApp();
    await helpers.makeUser({ username: 'ModAdmin', group: 'admin' });
    await helpers.makeUser({ username: 'ModMember' });
    const m = helpers.client(app); await m.login('ModMember');
    expect((await m.get('/admin/modules')).status).toBe(403);
    const a = helpers.client(app); await a.login('ModAdmin');
    const page = await a.get('/admin/modules');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Test addon');
    expect(page.text).toContain('setup failed: setup exploded');
    // blocked: test-addon still depends on test-base
    const blocked = await a.post('/admin/modules/test-base/disable');
    expect(blocked.status).toBe(302);
    expect(isModuleEnabled('test-base')).toBe(true);
    await a.post('/admin/modules/test-addon/disable');
    expect(isModuleEnabled('test-addon')).toBe(false);
    const { getDb, schema } = await import('../src/db/client.ts');
    const log = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'module.disable'));
    expect(log.length).toBe(1);
  });
});

describe('repository conventions', () => {
  it('first-party modules only import the SDK (or npm packages / their own files)', () => {
    const root = path.resolve('modules');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
            const spec = m[1];
            if (!spec.startsWith('.')) continue;
            const target = path.resolve(path.dirname(p), spec);
            const moduleDir = path.join(root, path.relative(root, p).split(path.sep)[0]);
            const ok = target.startsWith(moduleDir + path.sep) || target === path.resolve('src/sdk/index.ts');
            if (!ok) offenders.push(`${path.relative(process.cwd(), p)} → ${spec}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
  it('the generated module index is up to date', () => {
    expect(() => execFileSync(process.execPath, ['scripts/sync-modules.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
