/**
 * Theme registry. Core ships Classic (default) and High Contrast; modules add more with
 * `ctx.register.theme({ id, name, scheme, description, stylesheet })`. Visual tokens for core themes live in
 * public/css/app.css; module themes ship their own stylesheet redefining the same tokens under [data-theme="<id>"].
 */
import { registries, CORE } from '../modules/registry.ts';
import type { ThemeDef } from '../sdk/types.ts';

registries.themes.add(CORE, { id: 'classic', name: 'Classic', scheme: 'light', description: 'The default: compact steel-grey forum layout with orange accents.' });
registries.themes.add(CORE, { id: 'contrast', name: 'High Contrast', scheme: 'dark', description: 'Maximum contrast and strong focus outlines for accessibility.' });

export const DEFAULT_THEME = 'classic';
/** Themes currently available (core + enabled modules), core first. */
export function themes(): ThemeDef[] {
  const all = registries.themes.active();
  return [...all.filter((t) => t.id === 'classic'), ...all.filter((t) => t.id !== 'classic' && t.id !== 'contrast'), ...all.filter((t) => t.id === 'contrast')];
}
export const themeById = (id: string | null | undefined) => (id ? registries.themes.get(id) : undefined);
export const isTheme = (t: string | undefined | null): t is string => !!themeById(t);
