/**
 * Real-time fan-out over Server-Sent Events, shared across app instances via the bus.
 *
 * - `publish()` sends a small event to a user; every instance delivers it to that user's local SSE sinks.
 * - Presence is cluster-wide: each instance knows its own connections, broadcasts changes immediately and a
 *   full snapshot every 20 s. Instances that stop heart-beating are forgotten after 60 s.
 * Messages are persisted before publishing, and clients re-sync over HTTP after reconnecting, so a dropped
 * event never loses data.
 */
import { INSTANCE_ID, onBus, send } from './bus.ts';

export interface Sink { send(event: string, data: unknown, id?: string): void; lastActive: number; idle: boolean }
export type Presence = 'online' | 'away' | 'offline';
type Live = Exclude<Presence, 'offline'>;

const sinks = new Map<number, Set<Sink>>();
const remote = new Map<string, { seen: number; users: Map<number, Live> }>();
const lastGlobal = new Map<number, Presence>();
type PresenceListener = (userId: number, p: Presence) => void;
const presenceListeners = new Set<PresenceListener>();

const rank: Record<Presence, number> = { offline: 0, away: 1, online: 2 };
const SNAPSHOT_MS = 20_000, EXPIRE_MS = 60_000, CHUNK = 300;

function localPresence(userId: number): Presence {
  const set = sinks.get(userId);
  if (!set || !set.size) return 'offline';
  for (const s of set) if (!s.idle) return 'online';
  return 'away';
}

export function presenceOf(userId: number): Presence {
  let best = localPresence(userId);
  const now = Date.now();
  for (const r of remote.values()) {
    if (now - r.seen > EXPIRE_MS) continue;
    const p = r.users.get(userId);
    if (p && rank[p] > rank[best]) best = p;
  }
  return best;
}

/** Recompute a user's cluster-wide presence and notify listeners if it changed. */
function recompute(userId: number) {
  const now = presenceOf(userId);
  if ((lastGlobal.get(userId) ?? 'offline') === now) return;
  if (now === 'offline') lastGlobal.delete(userId); else lastGlobal.set(userId, now);
  presenceListeners.forEach((fn) => fn(userId, now));
}

function localChanged(userId: number) {
  recompute(userId);
  send('presence', { u: userId, p: localPresence(userId) });
}

export function subscribe(userId: number, sink: Sink): () => void {
  let set = sinks.get(userId);
  if (!set) sinks.set(userId, (set = new Set()));
  set.add(sink);
  localChanged(userId);
  return () => {
    set!.delete(sink);
    if (set!.size === 0) sinks.delete(userId);
    localChanged(userId);
  };
}

export function publish(userId: number, event: string, data: unknown) {
  send('evt', { u: userId, e: event, d: data });
}

function deliverLocal(userId: number, event: string, data: unknown) {
  const set = sinks.get(userId);
  if (!set) return;
  for (const s of set) { try { s.send(event, data); } catch { /* sink closed */ } }
}

export function onlineUserIds(): number[] {
  const ids = new Set<number>(sinks.keys());
  const now = Date.now();
  for (const r of remote.values()) if (now - r.seen <= EXPIRE_MS) for (const u of r.users.keys()) ids.add(u);
  return [...ids];
}

export function onPresenceChange(fn: PresenceListener) { presenceListeners.add(fn); return () => presenceListeners.delete(fn); }

export function setIdle(userId: number, sink: Sink, idle: boolean) {
  if (sink.idle === idle) return;
  sink.idle = idle;
  localChanged(userId);
}

// ── bus wiring ──

onBus('evt', (m: { u: number; e: string; d: unknown }) => deliverLocal(m.u, m.e, m.d));

onBus('presence', (m: { u: number; p: Presence }, from) => {
  if (from === INSTANCE_ID) return; // already applied locally
  const r = remote.get(from) ?? { seen: Date.now(), users: new Map() };
  r.seen = Date.now();
  if (m.p === 'offline') r.users.delete(m.u); else r.users.set(m.u, m.p);
  remote.set(from, r);
  recompute(m.u);
});

onBus('presence_snapshot', (m: { reset: boolean; users: [number, Live][] }, from) => {
  if (from === INSTANCE_ID) return;
  const prev = remote.get(from);
  const touched = new Set<number>(m.reset && prev ? prev.users.keys() : []);
  const r = m.reset || !prev ? { seen: Date.now(), users: new Map<number, Live>() } : prev;
  r.seen = Date.now();
  for (const [u, p] of m.users) { r.users.set(u, p); touched.add(u); }
  remote.set(from, r);
  touched.forEach(recompute);
});

function broadcastSnapshot() {
  const users: [number, Live][] = [];
  for (const u of sinks.keys()) { const p = localPresence(u); if (p !== 'offline') users.push([u, p]); }
  if (!users.length) { send('presence_snapshot', { reset: true, users: [] }); return; }
  for (let i = 0; i < users.length; i += CHUNK) send('presence_snapshot', { reset: i === 0, users: users.slice(i, i + CHUNK) });
}

// a newly connected instance announces itself; everyone answers with a snapshot
onBus('presence_hello', (_m, from) => { if (from !== INSTANCE_ID) broadcastSnapshot(); });
onBus('bus_connected', () => { send('presence_hello', {}); broadcastSnapshot(); });

const timer = setInterval(() => {
  broadcastSnapshot();
  const now = Date.now();
  for (const [id, r] of remote) {
    if (now - r.seen > EXPIRE_MS) { remote.delete(id); r.users.forEach((_p, u) => recompute(u)); }
  }
}, SNAPSHOT_MS);
timer.unref();

export function resetEvents() { sinks.clear(); remote.clear(); lastGlobal.clear(); }
