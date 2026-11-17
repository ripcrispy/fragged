/**
 * Extension registries and hook dispatch.
 *
 * Every registered item and handler is tagged with its owner ('core' or a module id). Lookups only return
 * items whose owner is currently enabled, so modules can be switched on/off at runtime without restarts.
 * This file has no dependencies on services so any part of core can import it.
 */
import type {
  ActionHooks, FilterHooks, ThemeDef, AuthProviderDef, MediaProviderDef, ProfileSection, ProfileSettingsSection,
  NavItem, AdminSection, ModQueueSource, AdminUserPanel, ThreadPanel, PersonalDataSource,
} from '../sdk/types.ts';
import { log } from '../lib/log.ts';

export const CORE = 'core';
let enabledCheck: (owner: string) => boolean = () => true;
/** Installed by the module runtime. */
export function setEnabledCheck(fn: (owner: string) => boolean) { enabledCheck = fn; }
export const ownerEnabled = (owner: string) => owner === CORE || enabledCheck(owner);

export interface Entry<T> { owner: string; value: T }

export class Registry<T extends { id?: string; slug?: string; href?: string }> {
  private items: Entry<T>[] = [];
  constructor(public readonly name: string, private readonly keyOf: (v: T) => string) {}
  add(owner: string, value: T) {
    const key = this.keyOf(value);
    const clash = this.items.find((e) => this.keyOf(e.value) === key && e.owner !== owner);
    if (clash) log.warn(`${this.name}: "${key}" from ${owner} shadows the one from ${clash.owner} while both are enabled`);
    this.items = this.items.filter((e) => !(e.owner === owner && this.keyOf(e.value) === key));
    this.items.push({ owner, value });
  }
  /** Active items (owners enabled). When several owners register the same key, the most recently registered wins. */
  active(): T[] {
    const seen = new Map<string, T>();
    for (const e of this.items) if (ownerEnabled(e.owner)) seen.set(this.keyOf(e.value), e.value);
    return [...seen.values()];
  }
  entries(): Entry<T>[] { return [...this.items]; }
  get(key: string): T | undefined { return this.active().find((v) => this.keyOf(v) === key); }
  ownerOf(key: string): string | undefined { return [...this.items].reverse().find((e) => this.keyOf(e.value) === key && ownerEnabled(e.owner))?.owner; }
  removeOwner(owner: string) { this.items = this.items.filter((e) => e.owner !== owner); }
}

export const registries = {
  themes: new Registry<ThemeDef>('themes', (t) => t.id),
  authProviders: new Registry<AuthProviderDef>('auth providers', (p) => p.id),
  mediaProviders: new Registry<MediaProviderDef>('media providers', (p) => p.id),
  profileSections: new Registry<ProfileSection>('profile sections', (s) => s.id),
  profileSettings: new Registry<ProfileSettingsSection>('profile settings', (s) => s.id),
  navItems: new Registry<NavItem>('navigation', (n) => `${n.area}:${n.href}`),
  adminSections: new Registry<AdminSection>('admin sections', (s) => s.href ?? s.slug),
  modQueues: new Registry<ModQueueSource>('moderation queues', (q) => q.id),
  adminUserPanels: new Registry<AdminUserPanel>('admin user panels', (p) => p.id),
  threadPanels: new Registry<ThreadPanel>('thread panels', (p) => p.id),
  personalData: new Registry<PersonalDataSource>('personal data', (p) => p.id),
};
/** Theme → owning module (for stylesheet inclusion) is available via registries.themes.ownerOf(id). */

// ───────────────────────────── hooks ─────────────────────────────

interface Handler { owner: string; priority: number; fn: (p: any) => any }
const actions = new Map<string, Handler[]>();
const filters = new Map<string, Handler[]>();
const SLOW_MS = 2000;

function add(map: Map<string, Handler[]>, name: string, h: Handler) {
  const list = map.get(name) ?? [];
  list.push(h);
  list.sort((a, b) => a.priority - b.priority);
  map.set(name, list);
}
export function onAction<K extends keyof ActionHooks>(owner: string, name: K, fn: (p: ActionHooks[K]) => void | Promise<void>, priority = 10) { add(actions, name, { owner, priority, fn }); }
export function onFilter<K extends keyof FilterHooks>(owner: string, name: K, fn: (v: FilterHooks[K]) => FilterHooks[K] | Promise<FilterHooks[K]>, priority = 10) { add(filters, name, { owner, priority, fn }); }

/**
 * Run action handlers in priority order. Errors are logged and never propagate to the caller, so a faulty
 * module cannot break posting, sign-in or messaging.
 */
export async function emit<K extends keyof ActionHooks>(name: K, payload: ActionHooks[K]): Promise<void> {
  for (const h of actions.get(name) ?? []) {
    if (!ownerEnabled(h.owner)) continue;
    const t = Date.now();
    try { await h.fn(payload); }
    catch (e) { log.error('hook handler failed', { hook: name, module: h.owner, error: String((e as Error)?.stack ?? e) }); }
    const ms = Date.now() - t;
    if (ms > SLOW_MS) log.warn('slow hook handler', { hook: name, module: h.owner, ms });
  }
}

/**
 * Run filter handlers in priority order, threading the value through. A handler may throw a `ServiceError`
 * (anything with a numeric `status`) to reject the operation — that propagates to the user. Any other error is
 * logged and that handler is skipped (fail-open), so a broken module can't block all posting.
 */
export async function applyFilters<K extends keyof FilterHooks>(name: K, value: FilterHooks[K]): Promise<FilterHooks[K]> {
  let v = value;
  for (const h of filters.get(name) ?? []) {
    if (!ownerEnabled(h.owner)) continue;
    try {
      const next = await h.fn({ ...v });
      if (next && typeof next === 'object') v = { ...v, ...next, userId: (v as any).userId, senderId: (v as any).senderId, authorId: (v as any).authorId } as FilterHooks[K];
    } catch (e) {
      if (typeof (e as any)?.status === 'number') throw e;
      log.error('filter handler failed; skipped', { hook: name, module: h.owner, error: String((e as Error)?.stack ?? e) });
    }
  }
  return v;
}

export function hookHandlers(): { name: string; kind: 'action' | 'filter'; owner: string; priority: number }[] {
  const out: { name: string; kind: 'action' | 'filter'; owner: string; priority: number }[] = [];
  for (const [name, list] of actions) for (const h of list) out.push({ name, kind: 'action', owner: h.owner, priority: h.priority });
  for (const [name, list] of filters) for (const h of list) out.push({ name, kind: 'filter', owner: h.owner, priority: h.priority });
  return out;
}

/** Test helper. */
export function resetHooks() { actions.clear(); filters.clear(); }
