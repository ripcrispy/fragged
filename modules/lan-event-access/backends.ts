/**
 * Firewall / DHCP connectors for LAN Event Access.
 *
 * Every connector does the same four things against a different API:
 *   leases()        devices that currently hold a DHCP lease (the door desk shows the ones in the staging range)
 *   reservations()  entries in the "approved" section (reservations, host entries, static mappings or alias entries)
 *   approve()       add one device to the approved section
 *   revoke()        remove it again
 * plus apply(), which makes the DHCP server pick up the change.
 *
 * The firewall URL comes from module settings (organisers only) and the credentials from environment variables.
 * Every request has a hard timeout and a response-size cap, and errors become a FirewallError with a message the
 * desk can act on. Nothing here talks to hosts supplied by members.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

export const BACKENDS = {
  demo: 'Demo (simulated firewall, for trying the module out)',
  'opnsense-kea': 'OPNsense: Kea DHCP (reservations)',
  'opnsense-dnsmasq': 'OPNsense: Dnsmasq DNS & DHCP (host entries)',
  'opnsense-isc': 'OPNsense: ISC DHCP, legacy (firewall alias)',
  pfsense: 'pfSense: REST API package (DHCP static mappings)',
} as const;
export type BackendId = keyof typeof BACKENDS;

export interface Lease { mac: string; ip: string; hostname: string; iface: string }
export interface Reservation { ref: string; mac: string; ip: string; hostname: string }
export interface ApproveInput { mac: string; ip: string; hostname: string; description: string }
export interface Backend {
  id: BackendId;
  label: string;
  /** true: approval gives the device a new address from the approved range. false: the device keeps its lease address. */
  assignsAddress: boolean;
  leases(): Promise<Lease[]>;
  reservations(): Promise<Reservation[]>;
  /** Returns a reference stored with the device (a UUID, an IP…), used to revoke it later. */
  approve(d: ApproveInput): Promise<string>;
  revoke(d: { mac: string; ip: string; ref: string }): Promise<void>;
  apply(): Promise<void>;
}

export interface BackendConfig {
  backend: BackendId;
  firewallUrl: string;
  verifyTls: boolean;
  approvedRange: string;
  pfsenseInterface: string;
  iscAlias: string;
  stagingRange: string;
}

export class FirewallError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

// ── addresses ──

export function normaliseMac(raw: string): string | null {
  const hex = String(raw ?? '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || !/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
export const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export interface Range { start: number; end: number }
/** "10.0.1.10-10.0.1.250", "10.0.1.0/24" (network and broadcast excluded) or a single address. */
export function parseRange(raw: string): Range | null {
  const s = String(raw ?? '').trim();
  const dash = /^(\S+)\s*-\s*(\S+)$/.exec(s);
  if (dash) {
    const a = ipToInt(dash[1]), b = ipToInt(dash[2]);
    return a !== null && b !== null && a <= b && b - a <= 65_535 ? { start: a, end: b } : null;
  }
  const cidr = /^(\S+)\/(\d{1,2})$/.exec(s);
  if (cidr) {
    const base = ipToInt(cidr[1]), bits = Number(cidr[2]);
    if (base === null || bits < 16 || bits > 30) return null;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    const net = (base & mask) >>> 0;
    return { start: net + 1, end: net + 2 ** (32 - bits) - 2 };
  }
  const one = ipToInt(s);
  return one === null ? null : { start: one, end: one };
}
/** Whether an address is inside a subnet such as "10.10.0.0/23" (any prefix length). */
export function inCidr(ip: string, cidr: string): boolean {
  const m = /^(\S+)\/(\d{1,2})$/.exec(String(cidr ?? '').trim());
  const n = ipToInt(ip), base = m ? ipToInt(m[1]) : null, bits = m ? Number(m[2]) : -1;
  if (n === null || base === null || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}
export function inRange(ip: string, r: Range | null): boolean {
  const n = ipToInt(ip);
  return r !== null && n !== null && n >= r.start && n <= r.end;
}
/** First address in the range that isn't taken. */
export function allocate(r: Range, taken: Set<string>): string | null {
  for (let n = r.start; n <= r.end; n++) { const ip = intToIp(n); if (!taken.has(ip)) return ip; }
  return null;
}

/** DHCP-safe hostname: letters, digits and dashes, starting with a letter or digit, at most 63 characters. */
export function safeHostname(raw: string, mac: string): string {
  const h = String(raw ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 63).replace(/-+$/, '');
  return h || `lan-${mac.replace(/:/g, '').slice(-6)}`;
}

// ── HTTP ──

const TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;

interface Conn { base: string; auth: Record<string, string>; verifyTls: boolean }

function connFor(cfg: BackendConfig, authStyle: 'basic' | 'pfsense'): Conn {
  const key = process.env.LAN_EVENT_ACCESS_API_KEY ?? '';
  const secret = process.env.LAN_EVENT_ACCESS_API_SECRET ?? '';
  if (!cfg.firewallUrl) throw new FirewallError('Set the firewall address in the module settings first.', 503);
  if (!key) throw new FirewallError('Set LAN_EVENT_ACCESS_API_KEY in the server environment first.', 503);
  let auth: Record<string, string>;
  if (authStyle === 'pfsense' && !secret) auth = { 'x-api-key': key };
  else {
    if (!secret) throw new FirewallError('Set LAN_EVENT_ACCESS_API_SECRET in the server environment first.', 503);
    auth = { authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64') };
  }
  return { base: cfg.firewallUrl.replace(/\/+$/, ''), auth, verifyTls: cfg.verifyTls };
}

let caCache: { file: string; ca: Buffer } | null = null;
function customCa(): Buffer | undefined {
  const file = process.env.LAN_EVENT_ACCESS_CA_FILE;
  if (!file) return undefined;
  if (caCache?.file !== file) caCache = { file, ca: fs.readFileSync(file) };
  return caCache.ca;
}

function friendlyNetError(e: NodeJS.ErrnoException, base: string): FirewallError {
  const code = e.code ?? '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
    return new FirewallError(`The firewall's TLS certificate isn't trusted (${code}). Set LAN_EVENT_ACCESS_CA_FILE to its CA certificate, or turn off certificate checking in the module settings on a trusted network.`);
  }
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return new FirewallError(`The firewall at ${base} didn't answer within ${TIMEOUT_MS / 1000} seconds.`, 504);
  return new FirewallError(`Couldn't reach the firewall at ${base} (${code || e.message}).`);
}

export async function request(conn: Conn, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const url = new URL(conn.base + path);
  const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!mod) throw new FirewallError('The firewall address must start with https:// or http://.', 400);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method,
      headers: { accept: 'application/json', ...conn.auth, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
      ...(url.protocol === 'https:' ? { rejectUnauthorized: conn.verifyTls, ca: customCa() } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new FirewallError('The firewall sent a reply that was too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) return reject(new FirewallError(`The firewall rejected the API credentials (HTTP ${status}). Check LAN_EVENT_ACCESS_API_KEY / LAN_EVENT_ACCESS_API_SECRET and that the key may use the DHCP${path.includes('alias') ? ' and firewall alias' : ''} API.`));
        if (status === 404) return reject(new FirewallError(`The firewall doesn't have ${path.split('?')[0]} (HTTP 404). Is the right DHCP server selected in the settings, and is it installed${path.startsWith('/api/v2/') ? ' (pfSense needs the REST API package)' : ''}?`));
        if (status >= 400) return reject(new FirewallError(`The firewall returned HTTP ${status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ''}.`));
        if (json === null) return reject(new FirewallError('The firewall sent a reply that isn’t JSON. Check the firewall address.'));
        resolve(json);
      });
      res.on('error', (e) => reject(friendlyNetError(e, conn.base)));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (e) => reject(e instanceof FirewallError ? e : friendlyNetError(e as NodeJS.ErrnoException, conn.base)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── helpers for OPNsense's MVC API ──

const rowsOf = (r: any): any[] => (Array.isArray(r?.rows) ? r.rows : Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : []);
const ALL = '?current=1&rowCount=-1&searchPhrase=';
const firstIp = (v: unknown) => String(v ?? '').split(/[,\s]+/).find((x) => ipToInt(x) !== null) ?? '';
const macsOf = (v: unknown) => String(v ?? '').split(/[,\s]+/).map(normaliseMac).filter((x): x is string => !!x);

function checkSaved(r: any, what: string): string {
  if (r?.result === 'saved' && r.uuid) return String(r.uuid);
  const v = r?.validations && typeof r.validations === 'object' ? Object.values(r.validations).flat().map(String).join(' ') : '';
  throw new FirewallError(`The firewall didn't save the ${what}${v ? `: ${v.slice(0, 300)}` : '.'}`, 409);
}
function cleanLeases(list: Lease[]): Lease[] {
  return list.filter((l) => l.mac && l.ip).map((l) => ({ ...l, hostname: l.hostname.slice(0, 80), iface: l.iface.slice(0, 40) }));
}

// ── OPNsense: Kea DHCPv4 ──

function opnsenseKea(cfg: BackendConfig): Backend {
  const conn = () => connFor(cfg, 'basic');
  const reservations = async (): Promise<(Reservation & { subnet: string })[]> =>
    rowsOf(await request(conn(), 'GET', `/api/kea/dhcpv4/searchReservation${ALL}`)).map((r) => ({
      ref: String(r.uuid ?? ''), mac: normaliseMac(r.hw_address) ?? '', ip: firstIp(r.ip_address), hostname: String(r.hostname ?? ''), subnet: String(r.subnet ?? ''),
    }));
  return {
    id: 'opnsense-kea', label: BACKENDS['opnsense-kea'], assignsAddress: true,
    async leases() {
      return cleanLeases(rowsOf(await request(conn(), 'GET', `/api/kea/leases4/search${ALL}`)).map((r) => ({
        mac: normaliseMac(r.hwaddr) ?? '', ip: firstIp(r.address), hostname: String(r.hostname ?? ''), iface: String(r.if_descr || r.if || ''),
      })));
    },
    reservations,
    async approve(d) {
      const subnets = rowsOf(await request(conn(), 'GET', `/api/kea/dhcpv4/searchSubnet${ALL}`));
      const subnet = subnets.find((s) => inCidr(d.ip, String(s.subnet ?? '')));
      if (!subnet?.uuid) throw new FirewallError(`No Kea subnet contains ${d.ip}. Check “Approved address range” in the settings against Services › Kea DHCP › Subnets.`, 409);
      const existing = (await reservations()).find((r) => r.mac === d.mac);
      if (existing) {
        if (existing.ip === d.ip) return existing.ref;
        throw new FirewallError(`This device already has a Kea reservation (${existing.ip || 'no address'}). Remove it on the firewall first.`, 409);
      }
      return checkSaved(await request(conn(), 'POST', '/api/kea/dhcpv4/addReservation', {
        reservation: { subnet: String(subnet.uuid), ip_address: d.ip, hw_address: d.mac, hostname: d.hostname, description: d.description },
      }), 'Kea reservation');
    },
    async revoke(d) {
      let ref = d.ref;
      if (!ref) ref = (await reservations()).find((r) => r.mac === d.mac)?.ref ?? '';
      if (!ref) return; // already gone
      const r = await request(conn(), 'POST', `/api/kea/dhcpv4/delReservation/${encodeURIComponent(ref)}`, {});
      if (r?.result && r.result !== 'deleted' && r.result !== 'not found') throw new FirewallError('The firewall didn’t delete the Kea reservation.', 409);
    },
    async apply() { await request(conn(), 'POST', '/api/kea/service/reconfigure', {}); },
  };
}

// ── OPNsense: Dnsmasq ──

function opnsenseDnsmasq(cfg: BackendConfig): Backend {
  const conn = () => connFor(cfg, 'basic');
  const reservations = async (): Promise<Reservation[]> =>
    rowsOf(await request(conn(), 'GET', `/api/dnsmasq/settings/searchHost${ALL}`)).flatMap((r) =>
      macsOf(r.hwaddr).map((mac) => ({ ref: String(r.uuid ?? ''), mac, ip: firstIp(r.ip), hostname: String(r.host ?? '') })));
  return {
    id: 'opnsense-dnsmasq', label: BACKENDS['opnsense-dnsmasq'], assignsAddress: true,
    async leases() {
      return cleanLeases(rowsOf(await request(conn(), 'GET', `/api/dnsmasq/leases/search${ALL}`)).map((r) => ({
        mac: normaliseMac(r.hwaddr) ?? '', ip: firstIp(r.address), hostname: String(r.hostname ?? '').replace(/^\*$/, ''), iface: String(r.if_descr || r.if || ''),
      })));
    },
    reservations,
    async approve(d) {
      const existing = (await reservations()).find((r) => r.mac === d.mac);
      if (existing) {
        if (existing.ip === d.ip) return existing.ref;
        throw new FirewallError(`This device already has a Dnsmasq host entry (${existing.ip || 'no address'}). Remove it on the firewall first.`, 409);
      }
      return checkSaved(await request(conn(), 'POST', '/api/dnsmasq/settings/addHost', {
        host: { host: d.hostname, ip: d.ip, hwaddr: d.mac, descr: d.description },
      }), 'Dnsmasq host entry');
    },
    async revoke(d) {
      const ref = d.ref || ((await reservations()).find((r) => r.mac === d.mac)?.ref ?? '');
      if (!ref) return;
      const r = await request(conn(), 'POST', `/api/dnsmasq/settings/delHost/${encodeURIComponent(ref)}`, {});
      if (r?.result && r.result !== 'deleted' && r.result !== 'not found') throw new FirewallError('The firewall didn’t delete the Dnsmasq host entry.', 409);
    },
    async apply() { await request(conn(), 'POST', '/api/dnsmasq/service/reconfigure', {}); },
  };
}

// ── OPNsense: ISC DHCP (legacy) — no static-mapping API, so approval uses an External firewall alias ──

function opnsenseIsc(cfg: BackendConfig): Backend {
  const conn = () => connFor(cfg, 'basic');
  const alias = () => {
    if (!/^[A-Za-z0-9_]{1,31}$/.test(cfg.iscAlias)) throw new FirewallError('Set a valid firewall alias name (letters, digits and _) in the settings.', 400);
    return encodeURIComponent(cfg.iscAlias);
  };
  return {
    id: 'opnsense-isc', label: BACKENDS['opnsense-isc'], assignsAddress: false,
    async leases() {
      const rows = rowsOf(await request(conn(), 'GET', `/api/dhcpv4/leases/searchLease${ALL}`));
      return cleanLeases(rows.filter((r) => r.type !== 'static' && (!r.state || r.state === 'active')).map((r) => ({
        mac: normaliseMac(r.mac) ?? '', ip: firstIp(r.address), hostname: String(r.hostname ?? ''), iface: String(r.if_descr || r.if || ''),
      })));
    },
    async reservations() {
      const r = await request(conn(), 'GET', `/api/firewall/alias_util/list/${alias()}`);
      return rowsOf(r).map((x) => firstIp(typeof x === 'string' ? x : x.ip ?? x.address)).filter(Boolean).map((ip) => ({ ref: ip, mac: '', ip, hostname: '' }));
    },
    async approve(d) {
      const r = await request(conn(), 'POST', `/api/firewall/alias_util/add/${alias()}`, { address: d.ip });
      if (r?.status && r.status !== 'done') throw new FirewallError(`The firewall didn’t add ${d.ip} to the ${cfg.iscAlias} alias (${String(r.status).slice(0, 100)}). It must be an alias of type “External (advanced)”.`, 409);
      return d.ip;
    },
    async revoke(d) {
      const ip = d.ref || d.ip;
      if (ip) await request(conn(), 'POST', `/api/firewall/alias_util/delete/${alias()}`, { address: ip });
    },
    async apply() { /* alias table changes are live immediately */ },
  };
}

// ── pfSense: pfSense-pkg-RESTAPI v2 ──

function pfsense(cfg: BackendConfig): Backend {
  const conn = () => connFor(cfg, 'pfsense');
  const iface = () => {
    if (!/^[a-z0-9_]{1,32}$/i.test(cfg.pfsenseInterface)) throw new FirewallError('Set the pfSense interface (for example “lan” or “opt1”) in the settings.', 400);
    return cfg.pfsenseInterface;
  };
  const mappings = async () =>
    rowsOf(await request(conn(), 'GET', `/api/v2/services/dhcp_server/static_mappings?parent_id=${encodeURIComponent(iface())}&limit=0`))
      .filter((r) => r.parent_id === undefined || String(r.parent_id) === iface());
  return {
    id: 'pfsense', label: BACKENDS.pfsense, assignsAddress: true,
    async leases() {
      const rows = rowsOf(await request(conn(), 'GET', '/api/v2/status/dhcp_server/leases?limit=0'));
      return cleanLeases(rows.filter((r) => !r.active_status || /active/i.test(String(r.active_status))).map((r) => ({
        mac: normaliseMac(r.mac) ?? '', ip: firstIp(r.ip), hostname: String(r.hostname ?? ''), iface: String(r.descr || r.if || ''),
      })));
    },
    async reservations() {
      return (await mappings()).map((r) => ({ ref: String(r.id ?? ''), mac: normaliseMac(r.mac) ?? '', ip: firstIp(r.ipaddr), hostname: String(r.hostname ?? '') }));
    },
    async approve(d) {
      const existing = (await mappings()).find((r) => normaliseMac(r.mac) === d.mac);
      if (existing) {
        if (firstIp(existing.ipaddr) === d.ip) return d.mac;
        throw new FirewallError(`This device already has a static mapping on ${iface()} (${firstIp(existing.ipaddr) || 'no address'}). Remove it on the firewall first.`, 409);
      }
      await request(conn(), 'POST', '/api/v2/services/dhcp_server/static_mapping', { parent_id: iface(), mac: d.mac, ipaddr: d.ip, hostname: d.hostname, descr: d.description });
      // pfSense ids are list positions that shift when another mapping is deleted, so the MAC is the stable reference.
      return d.mac;
    },
    async revoke(d) {
      const m = (await mappings()).find((r) => normaliseMac(r.mac) === d.mac);
      if (!m) return;
      await request(conn(), 'DELETE', `/api/v2/services/dhcp_server/static_mapping?parent_id=${encodeURIComponent(iface())}&id=${encodeURIComponent(String(m.id))}`);
    },
    async apply() { await request(conn(), 'POST', '/api/v2/services/dhcp_server/apply', {}); },
  };
}

// ── Demo: an in-memory firewall so organisers can try the desk without real hardware ──

const DEMO_NAMES = ['pixelwren-pc', 'bitcrusher-rig', 'Lowpoly-Laptop', 'quietkeys', 'DESKTOP-7F3K2Q', 'steamdeck', 'vexa-tower', 'NullSector-PC'];
const demo = { leases: new Map<string, Lease>(), reservations: new Map<string, Reservation>(), next: 0, seeded: false };

export function resetDemo() { demo.leases.clear(); demo.reservations.clear(); demo.next = 0; demo.seeded = false; }

/** Simulates a new device plugging in: it gets an address from the staging range. */
export function demoPlugIn(cfg: BackendConfig, hostname?: string): Lease {
  const r = parseRange(cfg.stagingRange) ?? { start: ipToInt('10.10.1.10')!, end: ipToInt('10.10.1.250')! };
  const taken = new Set([...demo.leases.values()].map((l) => l.ip));
  const n = demo.next++;
  const mac = normaliseMac(`02:4c:41:4e:${((n >> 8) & 255).toString(16).padStart(2, '0')}:${(n & 255).toString(16).padStart(2, '0')}`)!;
  const lease = { mac, ip: allocate(r, taken) ?? intToIp(r.start), hostname: hostname ?? DEMO_NAMES[n % DEMO_NAMES.length], iface: 'LAN' };
  demo.leases.set(mac, lease);
  return lease;
}

function demoBackend(cfg: BackendConfig): Backend {
  if (!demo.seeded) { demo.seeded = true; for (let i = 0; i < 4; i++) demoPlugIn(cfg); }
  return {
    id: 'demo', label: BACKENDS.demo, assignsAddress: true,
    async leases() { return [...demo.leases.values()].map((l) => ({ ...l })); },
    async reservations() { return [...demo.reservations.values()].map((r) => ({ ...r })); },
    async approve(d) {
      demo.reservations.set(d.mac, { ref: `demo-${d.mac}`, mac: d.mac, ip: d.ip, hostname: d.hostname });
      return `demo-${d.mac}`;
    },
    async revoke(d) { demo.reservations.delete(d.mac); },
    async apply() {
      // a real DHCP server hands out the reserved address when the device renews; the demo does it straight away
      for (const r of demo.reservations.values()) { const l = demo.leases.get(r.mac); if (l) l.ip = r.ip; }
      for (const l of demo.leases.values()) if (!demo.reservations.has(l.mac) && !inRange(l.ip, parseRange(cfg.stagingRange))) {
        const taken = new Set([...demo.leases.values()].map((x) => x.ip));
        const r = parseRange(cfg.stagingRange); if (r) l.ip = allocate(r, taken) ?? l.ip;
      }
    },
  };
}

export function makeBackend(cfg: BackendConfig): Backend {
  switch (cfg.backend) {
    case 'opnsense-kea': return opnsenseKea(cfg);
    case 'opnsense-dnsmasq': return opnsenseDnsmasq(cfg);
    case 'opnsense-isc': return opnsenseIsc(cfg);
    case 'pfsense': return pfsense(cfg);
    default: return demoBackend(cfg);
  }
}
