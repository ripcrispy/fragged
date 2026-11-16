/**
 * Game-server status probes. Hosts and ports come only from organisers (lan-intranet.manage), never from members.
 * Every probe has a hard timeout and a response-size cap, and failures are reported as "offline", never thrown.
 */
import net from 'node:net';
import dgram from 'node:dgram';

export type ProbeKind = 'tcp' | 'source' | 'minecraft' | 'none';
export interface ServerStatus { online: boolean; latencyMs: number | null; players?: number; maxPlayers?: number; map?: string; name?: string; version?: string; error?: string; checkedAt: number }

const TIMEOUT = 2000;
const MAX_BYTES = 65_536;

export function probe(kind: ProbeKind, host: string, port: number): Promise<ServerStatus> {
  if (kind === 'tcp') return tcp(host, port);
  if (kind === 'source') return source(host, port);
  if (kind === 'minecraft') return minecraft(host, port);
  return Promise.resolve({ online: false, latencyMs: null, error: 'not monitored', checkedAt: Date.now() });
}

function tcp(host: string, port: number): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (st: Omit<ServerStatus, 'checkedAt'>) => { s.destroy(); resolve({ ...st, checkedAt: Date.now() }); };
    s.setTimeout(TIMEOUT, () => done({ online: false, latencyMs: null, error: 'timed out' }));
    s.once('connect', () => done({ online: true, latencyMs: Date.now() - t0 }));
    s.once('error', (e) => done({ online: false, latencyMs: null, error: (e as NodeJS.ErrnoException).code ?? 'unreachable' }));
  });
}

// ── Source engine A2S_INFO (UDP) ──
const A2S_INFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

export function parseA2SInfo(buf: Buffer): Partial<ServerStatus> | null {
  if (buf.length < 6 || buf.readInt32LE(0) !== -1 || buf[4] !== 0x49) return null;
  let i = 6; // header(4) + 'I'(1) + protocol(1)
  const str = () => { const end = buf.indexOf(0, i); if (end < 0) throw new Error('bad string'); const s = buf.toString('utf8', i, end); i = end + 1; return s; };
  try {
    const name = str(), map = str(); str(); str(); // folder, game
    i += 2; // app id
    const players = buf[i], maxPlayers = buf[i + 1];
    return { name: name.slice(0, 100), map: map.slice(0, 60), players, maxPlayers };
  } catch { return null; }
}

function source(host: string, port: number): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const t0 = Date.now();
    let settled = false;
    const done = (st: Omit<ServerStatus, 'checkedAt'>) => { if (settled) return; settled = true; clearTimeout(timer); sock.close(); resolve({ ...st, checkedAt: Date.now() }); };
    const timer = setTimeout(() => done({ online: false, latencyMs: null, error: 'no response' }), TIMEOUT);
    sock.on('error', (e) => done({ online: false, latencyMs: null, error: (e as NodeJS.ErrnoException).code ?? 'error' }));
    sock.on('message', (msg) => {
      if (msg.length > MAX_BYTES) return done({ online: false, latencyMs: null, error: 'oversized reply' });
      // newer servers answer with a challenge (0x41) that must be echoed back
      if (msg.length >= 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41) { sock.send(Buffer.concat([A2S_INFO, msg.subarray(5, 9)]), port, host); return; }
      const info = parseA2SInfo(msg);
      done(info ? { online: true, latencyMs: Date.now() - t0, ...info } : { online: true, latencyMs: Date.now() - t0, error: 'unrecognised reply' });
    });
    sock.send(A2S_INFO, port, host, (e) => { if (e) done({ online: false, latencyMs: null, error: 'send failed' }); });
  });
}

// ── Minecraft Server List Ping (TCP, protocol ≥ 1.7) ──
function varint(n: number): Buffer { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
function readVarint(buf: Buffer, off: number): [number, number] | null {
  let n = 0, shift = 0, i = off;
  while (i < buf.length && shift < 35) { const b = buf[i++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) return [n, i]; shift += 7; }
  return null;
}
const packet = (...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };

export function parseMinecraftStatus(buf: Buffer): Partial<ServerStatus> | null {
  const len = readVarint(buf, 0); if (!len) return null;
  const id = readVarint(buf, len[1]); if (!id || id[0] !== 0) return null;
  const sl = readVarint(buf, id[1]); if (!sl) return null;
  if (buf.length < sl[1] + sl[0]) return null;
  try {
    const j = JSON.parse(buf.toString('utf8', sl[1], sl[1] + sl[0]));
    const motd = typeof j.description === 'string' ? j.description : j.description?.text ?? '';
    return { players: j.players?.online, maxPlayers: j.players?.max, version: String(j.version?.name ?? '').slice(0, 40), name: String(motd).replace(/§./g, '').slice(0, 100) };
  } catch { return null; }
}

function minecraft(host: string, port: number): Promise<ServerStatus> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let data = Buffer.alloc(0);
    let settled = false;
    const done = (st: Omit<ServerStatus, 'checkedAt'>) => { if (settled) return; settled = true; s.destroy(); resolve({ ...st, checkedAt: Date.now() }); };
    s.setTimeout(TIMEOUT, () => done({ online: false, latencyMs: null, error: 'timed out' }));
    s.once('error', (e) => done({ online: false, latencyMs: null, error: (e as NodeJS.ErrnoException).code ?? 'unreachable' }));
    s.once('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      s.write(packet(varint(0), varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)));
      s.write(packet(varint(0)));
    });
    s.on('data', (chunk) => {
      data = Buffer.concat([data, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (data.length > MAX_BYTES) return done({ online: false, latencyMs: null, error: 'oversized reply' });
      const st = parseMinecraftStatus(data);
      if (st) done({ online: true, latencyMs: Date.now() - t0, ...st });
    });
  });
}
