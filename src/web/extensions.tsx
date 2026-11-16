/** Rendering helpers for module-provided UI (profile sections, profile settings, navigation). */
import type { Child } from 'hono/jsx';
import { registries } from '../modules/registry.ts';
import { log } from '../lib/log.ts';
import type { ProfileSectionArgs, NavItem } from '../sdk/types.ts';
import type { Viewer } from '../services/viewer.ts';

/** A module's UI must never break a core page: failures are logged and the section is skipped. */
async function guarded<T>(what: string, fn: () => T | Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { log.error('module UI failed', { what, error: String((e as Error)?.stack ?? e) }); return null; }
}

/** Profile sections for one column, split around a core slot position. */
export async function profileSections(args: ProfileSectionArgs, column: 'side' | 'main'): Promise<{ order: number; node: Child }[]> {
  const out: { order: number; node: Child }[] = [];
  for (const s of registries.profileSections.active().filter((x) => x.column === column)) {
    const node = await guarded(`profile section ${s.id}`, () => s.render(args));
    if (node) out.push({ order: s.order, node });
  }
  return out.sort((a, b) => a.order - b.order);
}
export const between = (list: { order: number; node: Child }[], min: number, max: number) => list.filter((x) => x.order >= min && x.order < max).map((x) => x.node);

export async function profileSettingsFields(viewer: Viewer, errors: Record<string, string>): Promise<Child[]> {
  const out: Child[] = [];
  for (const s of registries.profileSettings.active().sort((a, b) => a.order - b.order)) {
    const node = await guarded(`profile settings ${s.id}`, () => s.render({ viewer, errors }));
    if (node) out.push(node);
  }
  return out;
}

export async function saveProfileSettings(viewer: Viewer, form: Record<string, unknown>): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const s of registries.profileSettings.active()) {
    const r = await guarded(`profile settings save ${s.id}`, () => s.save({ viewer, form }));
    if (r === null) errors[`_${s.id}`] = 'Some settings could not be saved. Please try again.';
    else Object.assign(errors, r);
  }
  return errors;
}

/** Navigation items from core and enabled modules for one area, visible to this viewer. */
export async function navItems(viewer: Viewer, area: NavItem['area']): Promise<NavItem[]> {
  const items = registries.navItems.active().filter((n) => n.area === area).sort((a, b) => a.order - b.order);
  const out: NavItem[] = [];
  for (const n of items) if (!n.visible || (await guarded(`nav ${n.href}`, () => n.visible!(viewer)))) out.push(n);
  return out;
}

/** Module moderation queues the viewer may act on, with their current counts. */
export async function moduleQueues(viewer: Viewer): Promise<{ id: string; label: string; href: string; count: number }[]> {
  const out: { id: string; label: string; href: string; count: number }[] = [];
  for (const q of registries.modQueues.active()) {
    if (!(await viewer.can(q.permission))) continue;
    const n = await guarded(`mod queue ${q.id}`, () => q.count());
    out.push({ id: q.id, label: q.label, href: q.href, count: n ?? 0 });
  }
  return out;
}

/** Extra panels on Admin › Users › <member>. */
export async function adminUserPanels(args: { viewer: Viewer; user: import('../sdk/types.ts').User; ctx: import('./ctx.ts').PageCtx }): Promise<Child[]> {
  const out: Child[] = [];
  for (const p of registries.adminUserPanels.active().sort((a, b) => a.order - b.order)) {
    if (!(await args.viewer.can(p.permission))) continue;
    const node = await guarded(`admin user panel ${p.id}`, () => p.render(args));
    if (node) out.push(node);
  }
  return out;
}
