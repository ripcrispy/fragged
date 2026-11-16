import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { hmac, safeEqual } from '../lib/crypto.ts';
import type { Viewer } from '../services/viewer.ts';
import type { Settings } from '../services/settings.ts';
import type { NavItem } from '../sdk/types.ts';

export interface Flash { type: 'ok' | 'error' | 'info'; text: string }

export interface PageCtx {
  viewer: Viewer;
  csrf: string;
  nonce: string;
  path: string;
  url: URL;
  site: Pick<Settings, 'site_name' | 'site_tagline' | 'announcement' | 'show_online_list' | 'presence_enabled'>;
  theme: string;
  counts: { notifications: number; messages: number; friendRequests: number; modQueue: number };
  flash: Flash[];
  isStaff: boolean;
  canAdmin: boolean;
  canMod: boolean;
  /** extra <style nonce> CSS scoped to the page (validated profile colours only) */
  pageStyle?: string;
  /** navigation from core + enabled modules, resolved per request */
  nav?: { main: NavItem[]; footer: NavItem[]; userMenu: NavItem[] };
}

export type Env = { Variables: { viewer: Viewer; csrf: string; nonce: string; page: PageCtx } };
export type C = Context<Env>;

export const COOKIE = { session: 'ff_session', csrf: 'ff_csrf', flash: 'ff_flash', theme: 'ff_theme', oauth: 'ff_oauth', pending: 'ff_pending' } as const;
export const secureCookies = () => config.APP_URL.startsWith('https://');

export function setFlash(c: C, f: Flash) {
  const cur = readFlashRaw(c);
  cur.push(f);
  const b = Buffer.from(JSON.stringify(cur.slice(-3))).toString('base64url');
  setCookie(c, COOKIE.flash, `${b}.${hmac('flash:' + b)}`, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureCookies(), maxAge: 60 });
}
function readFlashRaw(c: C): Flash[] {
  const v = getCookie(c, COOKIE.flash);
  if (!v) return [];
  const [b, s] = v.split('.');
  if (!b || !s || !safeEqual(s, hmac('flash:' + b))) return [];
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return []; }
}
export function takeFlash(c: C): Flash[] {
  const f = readFlashRaw(c);
  if (f.length) deleteCookie(c, COOKIE.flash, { path: '/' });
  return f;
}

export function wantsJson(c: C): boolean {
  return c.req.path.startsWith('/api/') || (c.req.header('accept') ?? '').includes('application/json');
}

/** Parse a form body into string fields (+ File values kept as-is). */
export async function form(c: C): Promise<Record<string, any>> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const body = await c.req.parseBody({ all: true });
  return body as Record<string, any>;
}
export const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : typeof v === 'string' ? v : String(v));
export const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);
export const bool = (v: unknown): boolean => ['1', 'on', 'true', 'yes'].includes(str(v));
export const int = (v: unknown, d = 0): number => { const n = parseInt(str(v), 10); return Number.isFinite(n) ? n : d; };
