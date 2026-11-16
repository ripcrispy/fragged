/**
 * Rate limiting and short-lived de-duplication.
 *
 * Two stores with the same semantics:
 * - memory (default; embedded database and tests): exact sliding window per process;
 * - shared (enabled at boot when running on a PostgreSQL server): counters in `rate_limit_counters`,
 *   approximating a sliding window from the current and previous fixed windows, so limits hold across
 *   every app instance.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.ts';

export interface Limit { max: number; windowSec: number }
export interface Result { ok: boolean; retryAfter: number }

const buckets = new Map<string, number[]>();
let shared = false;
export function useSharedLimits(on: boolean) { shared = on; }

function memory(key: string, limit: Limit, record: boolean, now = Date.now()): Result {
  const winMs = limit.windowSec * 1000;
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < winMs);
  if (arr.length >= limit.max) { buckets.set(key, arr); return { ok: false, retryAfter: Math.ceil((winMs - (now - arr[0])) / 1000) }; }
  if (record) arr.push(now);
  buckets.set(key, arr);
  return { ok: true, retryAfter: 0 };
}

async function sharedCheck(key: string, limit: Limit, record: boolean): Promise<Result> {
  const winMs = limit.windowSec * 1000;
  const now = Date.now();
  const cur = new Date(Math.floor(now / winMs) * winMs);
  const prev = new Date(cur.getTime() - winMs);
  const frac = (now - cur.getTime()) / winMs;
  const db = getDb();
  const rows = (await db.execute(sql`select window_start, count from rate_limit_counters where key = ${key} and window_start in (${cur}, ${prev})`)) as any;
  let curCount = 0, prevCount = 0;
  for (const r of rows.rows ?? rows) { if (new Date(r.window_start).getTime() === cur.getTime()) curCount = Number(r.count); else prevCount = Number(r.count); }
  const estimate = curCount + prevCount * (1 - frac);
  if (estimate >= limit.max) return { ok: false, retryAfter: Math.max(1, Math.ceil((winMs - (now - cur.getTime())) / 1000)) };
  if (record) await db.execute(sql`insert into rate_limit_counters (key, window_start, count) values (${key}, ${cur}, 1)
    on conflict (key, window_start) do update set count = rate_limit_counters.count + 1`);
  return { ok: true, retryAfter: 0 };
}

/** Record an attempt; ok=false when the limit has been reached. */
export async function hit(key: string, limit: Limit): Promise<Result> {
  return shared ? sharedCheck(key, limit, true) : memory(key, limit, true);
}
/** Check without recording (used where only failures should count, e.g. login). */
export async function peek(key: string, limit: Limit): Promise<Result> {
  return shared ? sharedCheck(key, limit, false) : memory(key, limit, false);
}

/** True the first time `key` is seen within roughly `ttlSec` (e.g. counting a thread view once per reader). */
export async function once(key: string, ttlSec: number): Promise<boolean> {
  if (!shared) {
    const r = memory('once:' + key, { max: 1, windowSec: ttlSec }, true);
    return r.ok;
  }
  const winMs = ttlSec * 1000;
  const cur = new Date(Math.floor(Date.now() / winMs) * winMs);
  const rows = (await getDb().execute(sql`insert into rate_limit_counters (key, window_start, count) values (${'once:' + key}, ${cur}, 1) on conflict do nothing returning 1 as inserted`)) as any;
  return (rows.rows ?? rows).length > 0;
}

export function resetLimits(prefix?: string) {
  if (!prefix) buckets.clear();
  else for (const k of buckets.keys()) if (k.startsWith(prefix)) buckets.delete(k);
}

/** Default limits; admins can override via the `rate_limits` site setting. */
export const DEFAULT_LIMITS: Record<string, Limit> = {
  login: { max: 8, windowSec: 600 },
  oauth_start: { max: 30, windowSec: 600 },
  register: { max: 5, windowSec: 3600 },
  password_reset: { max: 5, windowSec: 3600 },
  post: { max: 6, windowSec: 60 },
  thread: { max: 3, windowSec: 300 },
  message: { max: 30, windowSec: 60 },
  friend_request: { max: 20, windowSec: 3600 },
  profile_comment: { max: 10, windowSec: 600 },
  report: { max: 10, windowSec: 600 },
  upload: { max: 20, windowSec: 600 },
  search: { max: 30, windowSec: 60 },
  member_search: { max: 60, windowSec: 60 },
  emoji_submit: { max: 5, windowSec: 3600 },
  verify_resend: { max: 3, windowSec: 3600 },
};

// periodic cleanup of both stores
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3_600_000) buckets.delete(k);
  if (shared) void getDb().execute(sql`delete from rate_limit_counters where window_start < now() - interval '1 day'`).catch(() => {});
}, 600_000).unref();
