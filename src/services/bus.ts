/**
 * Cross-instance message bus over PostgreSQL LISTEN/NOTIFY.
 *
 * When started (server boot with DATABASE_URL), every `send()` is NOTIFY'd on one channel and delivered to
 * every instance — including the sender — via its dedicated LISTEN connection. Without a bus (embedded
 * PGlite, tests) `send()` dispatches locally, so callers behave identically in both modes.
 *
 * Payloads are small hints (Postgres caps NOTIFY payloads at 8000 bytes); clients re-fetch authoritative
 * data over HTTP, so a missed notification never loses data.
 */
import crypto from 'node:crypto';
import { log } from '../lib/log.ts';

export const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
const CHANNEL = 'fragged_bus';
const MAX_PAYLOAD = 7900;

type Handler = (data: any, from: string) => void;
const handlers = new Map<string, Set<Handler>>();
let client: any = null;
let url: string | null = null;
let stopped = false;

export function onBus(kind: string, fn: Handler) {
  let set = handlers.get(kind);
  if (!set) handlers.set(kind, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

function dispatch(kind: string, data: unknown, from: string) {
  for (const fn of handlers.get(kind) ?? []) {
    try { fn(data, from); } catch (e) { log.error('bus handler failed', { kind, error: String(e) }); }
  }
}

export function busActive() { return !!client; }

export function send(kind: string, data: unknown) {
  if (!client) { dispatch(kind, data, INSTANCE_ID); return; }
  const payload = JSON.stringify({ k: kind, f: INSTANCE_ID, d: data });
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
    log.warn('bus payload too large; delivering locally only', { kind, bytes: Buffer.byteLength(payload) });
    dispatch(kind, data, INSTANCE_ID);
    return;
  }
  client.query('select pg_notify($1, $2)', [CHANNEL, payload]).catch((e: unknown) => {
    log.warn('bus notify failed; delivering locally', { kind, error: String(e) });
    dispatch(kind, data, INSTANCE_ID);
  });
}

async function connect() {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: url!, application_name: `fragged-bus-${INSTANCE_ID}` });
  c.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    try { const m = JSON.parse(msg.payload); dispatch(m.k, m.d, m.f); } catch { /* ignore malformed */ }
  });
  c.on('error', (e: unknown) => log.warn('bus connection error', { error: String(e) }));
  c.on('end', () => {
    if (client === c) client = null;
    if (!stopped) { log.warn('bus disconnected; reconnecting'); setTimeout(() => void connect().catch(() => {}), 2000); }
  });
  await c.connect();
  await c.query(`listen ${CHANNEL}`);
  client = c;
  dispatch('bus_connected', {}, INSTANCE_ID);
  log.info('bus listening', { instance: INSTANCE_ID });
}

export async function startBus(databaseUrl: string) {
  url = databaseUrl;
  stopped = false;
  await connect();
}

export async function stopBus() {
  stopped = true;
  const c = client;
  client = null;
  await c?.end().catch(() => {});
}
