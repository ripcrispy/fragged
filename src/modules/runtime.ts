/**
 * Module runtime: discovery, validation, dependency resolution, migrations, state and lifecycle.
 *
 * Boot sequence (src/server.ts and the test harness):
 *   loadModules()      once per process — validate manifests, resolve dependencies, run each available module's setup()
 *   syncModules(db)    per database — apply module migrations, create state rows, onInstall/onUpgrade, default grants
 *   startModules()     enabled modules' start()
 * createApp() then mounts module routes and assets behind an "is this module enabled?" guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { log } from '../lib/log.ts';
import { SDK_VERSION } from '../sdk/version.ts';
import type { ModuleDefinition, ModuleContext } from '../sdk/types.ts';
import type { Env } from '../web/ctx.ts';
import { registries, onAction, onFilter, setEnabledCheck, CORE } from './registry.ts';
import { onBus, send } from '../services/bus.ts';
import { installedModules } from '../generated/modules.ts';

export interface InstalledModule { def: ModuleDefinition; dir: string; source: 'local' | 'package' }

export interface LoadedModule {
  def: ModuleDefinition;
  dir: string;
  source: 'local' | 'package';
  available: boolean;
  /** why the module can't run (missing dependency, incompatible SDK, cycle, invalid manifest…) */
  problem: string | null;
  ctx: ModuleContext | null;
  routes: Hono<Env> | null;
  adminRoutes: Hono<Env> | null;
}

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
let modules: LoadedModule[] = [];
let order: string[] = [];
let loaded = false;
let enabledState = new Map<string, boolean>();
const exposed = new Map<string, object>();

const byId = (id: string) => modules.find((m) => m.def.id === id);
export function listModules(): LoadedModule[] { return modules; }
export function moduleOrder(): string[] { return order; }

/** Effective enabled = stored flag && available && every required dependency effectively enabled. */
export function isModuleEnabled(id: string, seen = new Set<string>()): boolean {
  const m = byId(id);
  if (!m || !m.available) return false;
  if (!(enabledState.get(id) ?? m.def.enabledByDefault !== false)) return false;
  if (seen.has(id)) return false;
  seen.add(id);
  return Object.keys(m.def.dependencies ?? {}).every((d) => isModuleEnabled(d, seen));
}
setEnabledCheck((owner) => owner === CORE || isModuleEnabled(owner));

// ───────────────────────────── validation & resolution ─────────────────────────────

export function validateManifest(def: ModuleDefinition): string | null {
  if (!def || typeof def !== 'object') return 'module does not export a definition';
  if (!ID_RE.test(def.id ?? '')) return `invalid id "${def.id}" (lowercase letters, digits and hyphens; 2–41 chars)`;
  if (!def.name) return 'missing name';
  if (!semver.valid(def.version ?? '')) return `invalid version "${def.version}"`;
  if (!def.sdk || !semver.validRange(def.sdk)) return `invalid sdk range "${def.sdk}"`;
  if (!semver.satisfies(SDK_VERSION, def.sdk)) return `needs SDK ${def.sdk}, this core provides ${SDK_VERSION}`;
  for (const [dep, range] of Object.entries({ ...def.dependencies, ...def.optionalDependencies })) {
    if (!ID_RE.test(dep)) return `invalid dependency id "${dep}"`;
    if (!semver.validRange(range)) return `invalid range "${range}" for dependency ${dep}`;
  }
  if (def.settings) {
    const r = def.settings.schema.safeParse(def.settings.defaults);
    if (!r.success) return 'settings defaults do not satisfy the settings schema';
  }
  return null;
}

/** Validate every module, resolve dependencies and compute a dependency-first order. Pure; exported for tests. */
export function resolve(installed: InstalledModule[]): { modules: LoadedModule[]; order: string[] } {
  const list: LoadedModule[] = [];
  for (const im of installed) {
    let problem = validateManifest(im.def);
    if (!problem && list.some((m) => m.def.id === im.def.id)) problem = `duplicate module id "${im.def.id}"`;
    list.push({ def: im.def, dir: im.dir, source: im.source, available: !problem, problem, ctx: null, routes: null, adminRoutes: null });
  }
  // dependencies must exist, be available and match the requested range (iterate until stable)
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of list.filter((x) => x.available)) {
      for (const [dep, range] of Object.entries(m.def.dependencies ?? {})) {
        const d = list.find((x) => x.def.id === dep);
        const problem = !d ? `requires module "${dep}" which is not installed`
          : !d.available ? `requires module "${dep}" which is unavailable (${d.problem})`
          : !semver.satisfies(d.def.version, range) ? `requires ${dep} ${range} but ${d.def.version} is installed` : null;
        if (problem) { m.available = false; m.problem = problem; changed = true; break; }
      }
    }
  }
  // topological order over required + optional dependencies (Kahn); leftovers form a cycle
  const avail = list.filter((m) => m.available);
  const edges = new Map(avail.map((m) => [m.def.id, Object.keys({ ...m.def.dependencies, ...m.def.optionalDependencies }).filter((d) => avail.some((a) => a.def.id === d))]));
  const out: string[] = [];
  const pending = new Set(edges.keys());
  while (pending.size) {
    const ready = [...pending].filter((id) => edges.get(id)!.every((d) => out.includes(d))).sort();
    if (!ready.length) break;
    for (const id of ready) { out.push(id); pending.delete(id); }
  }
  for (const id of pending) { const m = list.find((x) => x.def.id === id)!; m.available = false; m.problem = 'dependency cycle'; }
  return { modules: list, order: out };
}

// ───────────────────────────── context ─────────────────────────────

function settingsOf(def: ModuleDefinition, stored: Record<string, unknown> | undefined) {
  const merged = { ...(def.settings?.defaults ?? {}), ...(stored ?? {}) };
  if (!def.settings) return merged;
  const r = def.settings.schema.safeParse(merged);
  return r.success ? (r.data as Record<string, unknown>) : def.settings.defaults;
}

function makeContext(m: LoadedModule): ModuleContext {
  const id = m.def.id;
  const owner = id;
  const routes = new Hono<Env>();
  const adminRoutes = new Hono<Env>();
  m.routes = routes; m.adminRoutes = adminRoutes;
  const mlog = (lvl: 'debug' | 'info' | 'warn' | 'error') => (msg: string, f?: Record<string, unknown>) => log[lvl](msg, { module: id, ...f });
  return {
    id, version: m.def.version,
    log: { debug: mlog('debug'), info: mlog('info'), warn: mlog('warn'), error: mlog('error') },
    db: () => getDb(),
    isEnabled: () => isModuleEnabled(id),
    settings: {
      async get<T>() {
        const [row] = await getDb().select().from(schema.moduleState).where(eq(schema.moduleState.id, id));
        return settingsOf(m.def, row?.settings) as T;
      },
      async set(values) { await saveModuleSettings(id, values); },
    },
    hooks: {
      on: (name, handler, opts) => onAction(owner, name, handler, opts?.priority),
      filter: (name, handler, opts) => onFilter(owner, name, handler, opts?.priority),
    },
    routes, adminRoutes,
    register: {
      theme: (t) => registries.themes.add(owner, t),
      authProvider: (p) => registries.authProviders.add(owner, p),
      mediaProvider: (p) => registries.mediaProviders.add(owner, p),
      profileSection: (s) => registries.profileSections.add(owner, s),
      profileSettings: (s) => registries.profileSettings.add(owner, s),
      navItem: (n) => registries.navItems.add(owner, n),
      adminSection: (s) => registries.adminSections.add(owner, { ...s, href: `/admin/m/${id}/${s.slug}` }),
      modQueue: (q) => registries.modQueues.add(owner, { ...q, permission: q.permission }),
      adminUserPanel: (p) => registries.adminUserPanels.add(owner, p),
    },
    async render(c, title, body, opts) { const { page } = await import('../web/render.tsx'); return page(c as any, title, body, opts ?? {}); },
    async renderAdmin(c, title, permission, body) { const { adminShell } = await import('../routes/admin.tsx'); return adminShell(c as any, title, permission as any, body); },
    perm: (key) => `${id}.${key}`,
    expose: (api) => { exposed.set(id, api); },
    use: <T,>(other: string): T | null => {
      const declared = other in (m.def.dependencies ?? {}) || other in (m.def.optionalDependencies ?? {});
      if (!declared) { log.warn('module.use() of an undeclared module refused', { module: id, wanted: other }); return null; }
      return isModuleEnabled(other) ? ((exposed.get(other) as T) ?? null) : null;
    },
  };
}

// ───────────────────────────── boot ─────────────────────────────

/** Validate, resolve and run setup() for every available module. Idempotent per process. */
export async function loadModules(installed: InstalledModule[] = installedModules) {
  if (loaded) return;
  loaded = true;
  const r = resolve(installed);
  modules = r.modules; order = r.order;
  for (const m of modules.filter((x) => !x.available)) log.warn('module unavailable', { module: m.def?.id, problem: m.problem });
  for (const id of order) {
    const m = byId(id)!;
    m.ctx = makeContext(m);
    try { await m.def.setup?.(m.ctx); }
    catch (e) { m.available = false; m.problem = `setup failed: ${String((e as Error)?.message ?? e)}`; log.error('module setup failed', { module: id, error: String((e as Error)?.stack ?? e) }); }
  }
}

/** Apply migrations and reconcile state rows for the current database. */
export async function syncModules() {
  const db = getDb();
  for (const id of order) {
    const m = byId(id)!;
    if (!m.available) continue;
    try { await runMigrations(m); }
    catch (e) { m.available = false; m.problem = `migration failed: ${String((e as Error)?.message ?? e)}`; log.error('module migration failed', { module: id, error: String(e) }); continue; }
    const [row] = await db.select().from(schema.moduleState).where(eq(schema.moduleState.id, id));
    if (!row) {
      await db.insert(schema.moduleState).values({ id, version: m.def.version, enabled: m.def.enabledByDefault !== false, settings: {} }).onConflictDoNothing();
      await grantDefaultPermissions(m.def);
      await safely(m, 'onInstall', () => m.def.onInstall?.(m.ctx!));
    } else if (row.version !== m.def.version) {
      await db.update(schema.moduleState).set({ version: m.def.version, updatedAt: new Date() }).where(eq(schema.moduleState.id, id));
      await grantDefaultPermissions(m.def);
      await safely(m, 'onUpgrade', () => m.def.onUpgrade?.(m.ctx!, row.version));
    }
  }
  await refreshEnabled();
}

export async function startModules() {
  for (const id of order) if (isModuleEnabled(id)) { const m = byId(id)!; await safely(m, 'start', () => m.def.start?.(m.ctx!)); }
}
export async function stopModules() {
  for (const id of [...order].reverse()) if (isModuleEnabled(id)) { const m = byId(id)!; await safely(m, 'stop', () => m.def.stop?.(m.ctx!)); }
}

async function safely(m: LoadedModule, phase: string, fn: () => unknown) {
  try { await fn(); } catch (e) { log.error(`module ${phase} failed`, { module: m.def.id, error: String((e as Error)?.stack ?? e) }); }
}

export async function refreshEnabled() {
  const rows = await getDb().select({ id: schema.moduleState.id, enabled: schema.moduleState.enabled }).from(schema.moduleState);
  enabledState = new Map(rows.map((r) => [r.id, r.enabled]));
}
onBus('invalidate', (msg: { name: string }) => { if (msg.name === 'modules') void refreshEnabled().catch(() => {}); });

async function grantDefaultPermissions(def: ModuleDefinition) {
  const db = getDb();
  for (const [key, p] of Object.entries(def.permissions ?? {})) {
    const full = `${def.id}.${key}`;
    for (const slug of p.grantTo ?? []) {
      await db.execute(sql`update user_groups set permissions = permissions || jsonb_build_object(${full}::text, true)
        where slug = ${slug} and not (permissions ? ${full})`);
    }
  }
  const { invalidatePermissionCache } = await import('../services/permissions.ts');
  invalidatePermissionCache();
}

// ───────────────────────────── migrations ─────────────────────────────

async function runMigrations(m: LoadedModule) {
  if (!m.def.migrations) return;
  const dir = path.resolve(m.dir, m.def.migrations);
  if (!fs.existsSync(dir)) throw new Error(`migrations folder not found: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  const db = getDb();
  const done = new Set((await db.select({ name: schema.moduleMigrations.name }).from(schema.moduleMigrations).where(eq(schema.moduleMigrations.moduleId, m.def.id))).map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const statements = fs.readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    await db.transaction(async (tx) => {
      for (const st of statements) await tx.execute(sql.raw(st));
      await tx.insert(schema.moduleMigrations).values({ moduleId: m.def.id, name: f });
    });
    log.info('module migration applied', { module: m.def.id, file: f });
  }
}

// ───────────────────────────── enable / disable / settings ─────────────────────────────

export class ModuleStateError extends Error { constructor(message: string, public status = 409) { super(message); } }

/** Modules (enabled) that require `id`. */
export function dependents(id: string): string[] {
  return modules.filter((m) => m.available && Object.keys(m.def.dependencies ?? {}).includes(id) && isModuleEnabled(m.def.id)).map((m) => m.def.id);
}

export async function setModuleEnabled(id: string, enabled: boolean): Promise<void> {
  const m = byId(id);
  if (!m) throw new ModuleStateError('Unknown module.', 404);
  if (enabled) {
    if (!m.available) throw new ModuleStateError(`This module can't be enabled: ${m.problem}.`);
    const missing = Object.keys(m.def.dependencies ?? {}).filter((d) => !isModuleEnabled(d));
    if (missing.length) throw new ModuleStateError(`Enable ${missing.join(', ')} first — ${m.def.name} depends on ${missing.length === 1 ? 'it' : 'them'}.`);
    const clash = (m.def.conflicts ?? []).filter((x) => isModuleEnabled(x)).concat(modules.filter((o) => isModuleEnabled(o.def.id) && (o.def.conflicts ?? []).includes(id)).map((o) => o.def.id));
    if (clash.length) throw new ModuleStateError(`${m.def.name} conflicts with ${[...new Set(clash)].join(', ')}. Disable ${clash.length === 1 ? 'it' : 'them'} first.`);
  } else {
    const deps = dependents(id);
    if (deps.length) throw new ModuleStateError(`Disable ${deps.join(', ')} first — ${deps.length === 1 ? 'it depends' : 'they depend'} on ${m.def.name}.`);
  }
  if (isModuleEnabled(id) === enabled) return;
  await getDb().update(schema.moduleState).set({ enabled, updatedAt: new Date() }).where(eq(schema.moduleState.id, id));
  if (!enabled) await safely(m, 'stop', () => m.def.stop?.(m.ctx!));
  await refreshEnabled();
  send('invalidate', { name: 'modules' });
  await safely(m, enabled ? 'onEnable' : 'onDisable', () => (enabled ? m.def.onEnable : m.def.onDisable)?.(m.ctx!));
  if (enabled) await safely(m, 'start', () => m.def.start?.(m.ctx!));
}

export async function moduleSettings(id: string): Promise<Record<string, unknown>> {
  const m = byId(id);
  if (!m) throw new ModuleStateError('Unknown module.', 404);
  const [row] = await getDb().select().from(schema.moduleState).where(eq(schema.moduleState.id, id));
  return settingsOf(m.def, row?.settings);
}

export async function saveModuleSettings(id: string, values: Record<string, unknown>): Promise<void> {
  const m = byId(id);
  if (!m?.def.settings) throw new ModuleStateError('This module has no settings.', 404);
  const current = await moduleSettings(id);
  const r = m.def.settings.schema.safeParse({ ...current, ...values });
  if (!r.success) throw new ModuleStateError(r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '), 422);
  await getDb().update(schema.moduleState).set({ settings: r.data as Record<string, unknown>, updatedAt: new Date() }).where(eq(schema.moduleState.id, id));
}

/** Permissions declared by modules (for the admin permission editors). */
export function modulePermissions(): { key: string; label: string; module: string; enabled: boolean }[] {
  return modules.filter((m) => m.available).flatMap((m) => Object.entries(m.def.permissions ?? {}).map(([k, p]) => ({ key: `${m.def.id}.${k}`, label: p.label, module: m.def.name, enabled: isModuleEnabled(m.def.id) })));
}
/** Notification kinds declared by enabled modules. */
export function moduleNotificationKinds(): Record<string, string> {
  return Object.assign({}, ...modules.filter((m) => isModuleEnabled(m.def.id)).map((m) => m.def.notificationKinds ?? {}));
}

// ───────────────────────────── HTTP mounting ─────────────────────────────

/** Mount module routers and assets. Disabled modules answer 404, so toggling needs no restart. */
export function mountModules(app: Hono<Env>) {
  for (const m of modules) {
    if (!m.available) continue;
    const id = m.def.id;
    const guard = async (c: any, next: () => Promise<void>) => { if (!isModuleEnabled(id)) return c.notFound(); await next(); };
    if (m.routes) { app.use(`/m/${id}/*`, guard); app.use(`/m/${id}`, guard); app.route(`/m/${id}`, m.routes); }
    if (m.adminRoutes) {
      const adminGuard = async (c: any, next: () => Promise<void>) => { if (!isModuleEnabled(id)) return c.notFound(); await c.get('viewer').require('admin.access'); await next(); };
      app.use(`/admin/m/${id}/*`, adminGuard); app.use(`/admin/m/${id}`, adminGuard);
      app.route(`/admin/m/${id}`, m.adminRoutes);
    }
  }
  // static assets of enabled modules: /modules/<id>/<file> (no directory traversal, no listing)
  app.get('/modules/:id/:file{.+}', async (c) => {
    const m = byId(c.req.param('id'));
    if (!m?.def.assets || !isModuleEnabled(m.def.id)) return c.notFound();
    const root = path.resolve(m.dir, m.def.assets);
    const file = path.resolve(root, c.req.param('file'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return c.notFound();
    const types: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };
    const type = types[path.extname(file)];
    if (!type) return c.notFound();
    c.header('Content-Type', type);
    c.header('X-Content-Type-Options', 'nosniff');
    // versioned URLs (from moduleStylesheets/themeStylesheet) can be cached; plain ones revalidate so upgrades show at once
    c.header('Cache-Control', c.req.query('v') ? 'public, max-age=86400' : 'no-cache');
    return c.body(fs.readFileSync(file));
  });
}

/** Global stylesheets declared by enabled modules (manifest `styles`). */
export function moduleStylesheets(): string[] {
  return order.filter((id) => isModuleEnabled(id)).flatMap((id) => (byId(id)!.def.styles ?? []).map((f) => `/modules/${id}/${f}?v=${encodeURIComponent(byId(id)!.def.version)}`));
}

/** Stylesheets for the page: the active theme's sheet if a module provides it. */
export function themeStylesheet(themeId: string): string | null {
  const owner = registries.themes.ownerOf(themeId);
  const t = registries.themes.get(themeId);
  if (!owner || owner === CORE || !t?.stylesheet) return null;
  return `/modules/${owner}/${t.stylesheet}?v=${encodeURIComponent(byId(owner)?.def.version ?? '0')}`;
}

/** Test helper: forget loaded modules so a test can load a custom set. */
export function resetModulesForTests() {
  loaded = false; modules = []; order = []; enabledState = new Map(); exposed.clear();
  for (const r of Object.values(registries)) for (const e of r.entries()) if (e.owner !== CORE) r.removeOwner(e.owner);
}
