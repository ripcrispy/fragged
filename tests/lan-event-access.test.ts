/** LAN Event Access: address helpers, every firewall connector against a fake firewall, and the door-desk flow over HTTP. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, client } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { setModuleEnabled, saveModuleSettings } from '../src/modules/runtime.ts';
import {
  normaliseMac, parseRange, inRange, inCidr, allocate, safeHostname, makeBackend, resetDemo, FirewallError, type BackendConfig, type BackendId,
} from '../modules/lan-event-access/backends.ts';
import { approveDevice, revokeDevice, deskState, syncWithFirewall, devices, attendees, forgetUser } from '../modules/lan-event-access/service.ts';

// ── a fake firewall speaking just enough OPNsense and pfSense API ──
interface Call { method: string; path: string; body: any; auth: string; apiKey: string }
const fw = {
  calls: [] as Call[],
  leases: [] as { mac: string; ip: string; hostname: string }[],
  kea: { subnets: [{ uuid: 'sub-lan', subnet: '10.10.0.0/23' }], reservations: [] as any[] },
  dnsmasq: { hosts: [] as any[] },
  alias: new Set<string>(),
  pf: { mappings: [] as any[] },
  failNextAdd: false,
  reset() {
    this.calls = []; this.kea.reservations = []; this.dnsmasq.hosts = []; this.alias.clear(); this.pf.mappings = []; this.failNextAdd = false;
    this.leases = [
      { mac: 'aa:aa:aa:00:00:01', ip: '10.10.1.10', hostname: 'Wren PC' },
      { mac: 'aa:aa:aa:00:00:02', ip: '10.10.1.11', hostname: 'crusher' },
      { mac: 'aa:aa:aa:00:00:03', ip: '10.10.0.10', hostname: 'printer' }, // dynamic lease squatting the first approved address
    ];
  },
};
let uuid = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url!, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    fw.calls.push({ method: req.method!, path: url.pathname, body, auth: String(req.headers.authorization ?? ''), apiKey: String(req.headers['x-api-key'] ?? '') });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const okAuth = req.headers.authorization === 'Basic ' + Buffer.from('key:secret').toString('base64') || req.headers['x-api-key'] === 'key';
    if (!okAuth) return send(401, { message: 'Authentication failed' });
    const p = url.pathname, rows = (r: unknown[]) => send(200, { rows: r, total: r.length });
    // OPNsense Kea
    if (p === '/api/kea/leases4/search') return rows(fw.leases.map((l) => ({ address: l.ip, hwaddr: l.mac, hostname: l.hostname, if_descr: 'LAN' })));
    if (p === '/api/kea/dhcpv4/searchSubnet') return rows(fw.kea.subnets);
    if (p === '/api/kea/dhcpv4/searchReservation') return rows(fw.kea.reservations);
    if (p === '/api/kea/dhcpv4/addReservation') {
      if (fw.failNextAdd) { fw.failNextAdd = false; return send(200, { result: 'failed', validations: { 'reservation.ip_address': 'Address already in use.' } }); }
      const r = { uuid: `u${++uuid}`, ...body.reservation };
      fw.kea.reservations.push(r);
      return send(200, { result: 'saved', uuid: r.uuid });
    }
    if (p.startsWith('/api/kea/dhcpv4/delReservation/')) { const id = p.split('/').pop(); fw.kea.reservations = fw.kea.reservations.filter((r) => r.uuid !== id); return send(200, { result: 'deleted' }); }
    if (p === '/api/kea/service/reconfigure') return send(200, { status: 'ok' });
    // OPNsense Dnsmasq
    if (p === '/api/dnsmasq/leases/search') return rows(fw.leases.map((l) => ({ address: l.ip, hwaddr: l.mac, hostname: l.hostname })));
    if (p === '/api/dnsmasq/settings/searchHost') return rows(fw.dnsmasq.hosts);
    if (p === '/api/dnsmasq/settings/addHost') { const h = { uuid: `d${++uuid}`, ...body.host }; fw.dnsmasq.hosts.push(h); return send(200, { result: 'saved', uuid: h.uuid }); }
    if (p.startsWith('/api/dnsmasq/settings/delHost/')) { const id = p.split('/').pop(); fw.dnsmasq.hosts = fw.dnsmasq.hosts.filter((h) => h.uuid !== id); return send(200, { result: 'deleted' }); }
    if (p === '/api/dnsmasq/service/reconfigure') return send(200, { status: 'ok' });
    // OPNsense ISC + alias
    if (p === '/api/dhcpv4/leases/searchLease') return rows(fw.leases.map((l) => ({ address: l.ip, mac: l.mac, hostname: l.hostname, type: 'dynamic', state: 'active' })));
    if (p === '/api/firewall/alias_util/list/LAN_APPROVED') return rows([...fw.alias].map((ip) => ({ ip })));
    if (p === '/api/firewall/alias_util/add/LAN_APPROVED') { fw.alias.add(body.address); return send(200, { status: 'done' }); }
    if (p === '/api/firewall/alias_util/delete/LAN_APPROVED') { fw.alias.delete(body.address); return send(200, { status: 'done' }); }
    // pfSense REST API v2
    if (p === '/api/v2/status/dhcp_server/leases') return send(200, { code: 200, status: 'ok', data: fw.leases.map((l) => ({ ip: l.ip, mac: l.mac, hostname: l.hostname, if: 'lan', active_status: 'active' })) });
    if (p === '/api/v2/services/dhcp_server/static_mappings') return send(200, { code: 200, data: fw.pf.mappings.map((m, id) => ({ id, parent_id: 'lan', ...m })) });
    if (p === '/api/v2/services/dhcp_server/static_mapping' && req.method === 'POST') { fw.pf.mappings.push({ mac: body.mac, ipaddr: body.ipaddr, hostname: body.hostname, descr: body.descr }); return send(200, { code: 200, data: { id: fw.pf.mappings.length - 1 } }); }
    if (p === '/api/v2/services/dhcp_server/static_mapping' && req.method === 'DELETE') { fw.pf.mappings.splice(Number(url.searchParams.get('id')), 1); return send(200, { code: 200 }); }
    if (p === '/api/v2/services/dhcp_server/apply') return send(200, { code: 200 });
    send(404, { message: 'no such endpoint' });
  });
});

let base = '';
const cfgFor = (backend: BackendId, over: Partial<BackendConfig> = {}): BackendConfig => ({
  backend, firewallUrl: base, verifyTls: true, stagingRange: '10.10.1.10-10.10.1.250', approvedRange: '10.10.0.10-10.10.0.20',
  pfsenseInterface: 'lan', iscAlias: 'LAN_APPROVED', ...over,
});
const newAttendee = (name = 'Pixel Wren') => ({ name, userId: null, amountCents: 1500, method: 'cash' as const, note: '' });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LAN_EVENT_ACCESS_API_KEY = 'key';
  process.env.LAN_EVENT_ACCESS_API_SECRET = 'secret';
  await setupDb();
  await setModuleEnabled('lan-event-access', true);
});
afterAll(async () => { server.close(); await teardownDb(); });
beforeEach(async () => {
  fw.reset(); resetDemo();
  await getDb().delete(devices); await getDb().delete(attendees);
  process.env.LAN_EVENT_ACCESS_API_SECRET = 'secret';
});

describe('address helpers', () => {
  it('normalises MACs, ranges and hostnames', () => {
    expect(normaliseMac('AA-BB-CC-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normaliseMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normaliseMac('aa:bb:cc')).toBeNull();
    expect(parseRange('10.0.0.0/24')).toEqual(parseRange('10.0.0.1-10.0.0.254'));
    expect(parseRange('10.0.0.9-10.0.0.1')).toBeNull();
    expect(parseRange('10.0.0.0/8')).toBeNull(); // too big to be a sensible pool
    expect(inRange('10.0.0.5', parseRange('10.0.0.1-10.0.0.9'))).toBe(true);
    expect(inCidr('10.10.1.200', '10.10.0.0/23')).toBe(true);
    expect(inCidr('10.10.2.1', '10.10.0.0/23')).toBe(false);
    expect(allocate(parseRange('10.0.0.1-10.0.0.3')!, new Set(['10.0.0.1']))).toBe('10.0.0.2');
    expect(allocate(parseRange('10.0.0.1-10.0.0.1')!, new Set(['10.0.0.1']))).toBeNull();
    expect(safeHostname('Wren’s Gaming PC!!', 'aa:aa:aa:00:00:01')).toBe('wren-s-gaming-pc');
    expect(safeHostname('', 'aa:aa:aa:00:12:34')).toBe('lan-001234');
  });
});

describe('connectors', () => {
  it('OPNsense Kea: lists staging devices, reserves a free LAN address and revokes it', async () => {
    const cfg = cfgFor('opnsense-kea');
    const b = makeBackend(cfg);
    const staff = await makeUser();
    const st = await deskState(b, cfg);
    expect(st.error).toBeNull();
    expect(st.waiting.map((l) => l.mac)).toEqual(['aa:aa:aa:00:00:01', 'aa:aa:aa:00:00:02']);
    const r = await approveDevice(b, cfg, { mac: 'AA:AA:AA:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id });
    expect(r.device.ip).toBe('10.10.0.11'); // .10 is held by another device's lease
    expect(r.device.status).toBe('approved');
    expect(fw.kea.reservations).toEqual([{ uuid: r.device.backendRef, subnet: 'sub-lan', ip_address: '10.10.0.11', hw_address: 'aa:aa:aa:00:00:01', hostname: 'wren-pc', description: 'Fragged: Pixel Wren' }]);
    expect(fw.calls.some((c) => c.path === '/api/kea/service/reconfigure')).toBe(true);
    expect(fw.calls.every((c) => c.auth === 'Basic ' + Buffer.from('key:secret').toString('base64'))).toBe(true);
    // the approved device disappears from the waiting list, and reports that it hasn't renewed yet
    const after = await deskState(b, cfg);
    expect(after.waiting.map((l) => l.mac)).toEqual(['aa:aa:aa:00:00:02']);
    expect(after.approved[0].state).toBe('renewing');
    await expect(approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id })).rejects.toThrow(/already approved/);
    // a second device for the same attendee takes the next address and no second payment
    const r2 = await approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:02', hostname: 'crusher', attendeeId: r.attendee.id, actorId: staff.id });
    expect(r2.device.ip).toBe('10.10.0.12');
    expect(r2.createdAttendee).toBe(false);
    expect(await getDb().select().from(attendees)).toHaveLength(1);
    await revokeDevice(b, r.device.id, staff.id);
    expect(fw.kea.reservations.map((x) => x.hw_address)).toEqual(['aa:aa:aa:00:00:02']);
  });

  it('rolls everything back when the firewall refuses', async () => {
    const cfg = cfgFor('opnsense-kea');
    const staff = await makeUser();
    fw.failNextAdd = true;
    await expect(approveDevice(makeBackend(cfg), cfg, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id })).rejects.toThrow(/Address already in use/);
    expect(await getDb().select().from(devices)).toHaveLength(0);
    expect(await getDb().select().from(attendees)).toHaveLength(0);
  });

  it('never hands two simultaneous approvals the same address', async () => {
    const cfg = cfgFor('opnsense-kea');
    const staff = await makeUser();
    const b = makeBackend(cfg);
    const [x, y] = await Promise.all([
      approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee('Ann'), actorId: staff.id }),
      approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:02', hostname: '', newAttendee: newAttendee('Bob'), actorId: staff.id }),
    ]);
    expect(x.device.ip).not.toBe(y.device.ip);
  });

  it('reports a full range and a missing Kea subnet clearly', async () => {
    const staff = await makeUser();
    const full = cfgFor('opnsense-kea', { approvedRange: '10.10.0.10-10.10.0.10' });
    await expect(approveDevice(makeBackend(full), full, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id })).rejects.toThrow(/range is full/);
    const elsewhere = cfgFor('opnsense-kea', { approvedRange: '192.168.50.10-192.168.50.20' });
    await expect(approveDevice(makeBackend(elsewhere), elsewhere, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id })).rejects.toThrow(/No Kea subnet contains 192.168.50.10/);
  });

  it('OPNsense Dnsmasq: adds and removes host entries', async () => {
    const cfg = cfgFor('opnsense-dnsmasq');
    const staff = await makeUser();
    const b = makeBackend(cfg);
    const r = await approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:02', hostname: 'crusher', newAttendee: newAttendee(), actorId: staff.id });
    expect(fw.dnsmasq.hosts).toEqual([{ uuid: r.device.backendRef, host: 'crusher', ip: '10.10.0.11', hwaddr: 'aa:aa:aa:00:00:02', descr: 'Fragged: Pixel Wren' }]);
    await revokeDevice(b, r.device.id, staff.id);
    expect(fw.dnsmasq.hosts).toEqual([]);
  });

  it('OPNsense ISC: allows the lease address through an alias and follows address changes on sync', async () => {
    const cfg = cfgFor('opnsense-isc');
    const staff = await makeUser();
    const b = makeBackend(cfg);
    const r = await approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee(), actorId: staff.id });
    expect(r.device.ip).toBe('10.10.1.10');
    expect([...fw.alias]).toEqual(['10.10.1.10']);
    // ISC can't approve a device that has no lease
    await expect(approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:99', hostname: '', newAttendee: newAttendee(), actorId: staff.id })).rejects.toThrow(/no DHCP lease/);
    // the lease moves; sync swaps the alias entry
    fw.leases[0].ip = '10.10.1.50';
    expect(await syncWithFirewall(b, cfg)).toEqual({ restored: 0, moved: 1 });
    expect([...fw.alias]).toEqual(['10.10.1.50']);
    // the firewall rebooted and lost the alias table; sync restores it
    fw.alias.clear();
    expect(await syncWithFirewall(b, cfg)).toEqual({ restored: 1, moved: 0 });
    expect([...fw.alias]).toEqual(['10.10.1.50']);
  });

  it('pfSense: creates static mappings with an API key and deletes the right one when ids shift', async () => {
    delete process.env.LAN_EVENT_ACCESS_API_SECRET;
    const cfg = cfgFor('pfsense');
    const staff = await makeUser();
    const b = makeBackend(cfg);
    const a = await approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:01', hostname: '', newAttendee: newAttendee('Ann'), actorId: staff.id });
    const c = await approveDevice(b, cfg, { mac: 'aa:aa:aa:00:00:02', hostname: '', newAttendee: newAttendee('Bob'), actorId: staff.id });
    expect(fw.pf.mappings.map((m) => m.mac)).toEqual(['aa:aa:aa:00:00:01', 'aa:aa:aa:00:00:02']);
    expect(fw.calls.every((x) => x.apiKey === 'key' && x.auth === '')).toBe(true);
    expect(fw.calls.some((x) => x.path === '/api/v2/services/dhcp_server/apply')).toBe(true);
    fw.pf.mappings.unshift({ mac: '11:11:11:11:11:11', ipaddr: '10.10.0.200' }); // someone added a mapping by hand; ids shift
    await revokeDevice(b, c.device.id, staff.id);
    expect(fw.pf.mappings.map((m) => m.mac)).toEqual(['11:11:11:11:11:11', 'aa:aa:aa:00:00:01']);
    void a;
  });

  it('turns connection problems into messages the desk can act on', async () => {
    process.env.LAN_EVENT_ACCESS_API_SECRET = 'wrong';
    const cfg = cfgFor('opnsense-kea');
    const st = await deskState(makeBackend(cfg), cfg);
    expect(st.error).toMatch(/rejected the API credentials/);
    const dead = cfgFor('opnsense-kea', { firewallUrl: 'http://127.0.0.1:1' });
    await expect(makeBackend(dead).leases()).rejects.toBeInstanceOf(FirewallError);
    await expect(makeBackend(cfgFor('opnsense-kea', { firewallUrl: '' })).leases()).rejects.toThrow(/firewall address/);
  });
});

describe('door desk over HTTP', () => {
  it('approves after payment, links the member, and keeps helpers away from revoking', async () => {
    await saveModuleSettings('lan-event-access', { backend: 'demo' });
    await makeUser({ username: 'DeskBoss', group: 'admin' });
    await makeUser({ username: 'DoorMember' });
    const member = await makeUser({ username: 'PayingGuest' });

    const outsider = client(); await outsider.login('DoorMember');
    expect((await outsider.get('/admin/m/lan-event-access/desk')).status).toBe(403);

    const boss = client(); await boss.login('DeskBoss');
    const desk = await boss.get('/admin/m/lan-event-access/desk');
    expect(desk.status).toBe(200);
    expect(desk.text).toContain('Waiting at the door (4)');
    const mac = /approve\?mac=([0-9a-f%A-F]+)/.exec(desk.text)![1];
    const page = await boss.get(`/admin/m/lan-event-access/desk/approve?mac=${mac}`);
    expect(page.text).toContain('Payment and approval');

    // cash must be ticked as received
    await boss.post('/admin/m/lan-event-access/desk/approve', { mac: decodeURIComponent(mac), attendee: 'new', name: 'Paying Guest', username: 'PayingGuest', amount: '15', method: 'cash' });
    expect(await getDb().select().from(devices)).toHaveLength(0);
    const ok = await boss.post('/admin/m/lan-event-access/desk/approve', { mac: decodeURIComponent(mac), attendee: 'new', name: 'Paying Guest', username: 'PayingGuest', amount: '15', method: 'cash', paid: '1' });
    expect(ok.location).toBe('/admin/m/lan-event-access/desk');
    const [d] = await getDb().select().from(devices);
    expect(d.status).toBe('approved');
    const [a] = await getDb().select().from(attendees);
    expect(a).toMatchObject({ name: 'Paying Guest', userId: member.id, amountCents: 1500, method: 'cash' });

    const after = await boss.get('/admin/m/lan-event-access/desk');
    expect(after.text).toContain('Waiting at the door (3)');
    expect(after.text).toContain('On the LAN'); // the demo firewall renews straight away
    expect(after.text).toContain('£15.00');

    // the member sees their device and got a notification
    const guest = client(); await guest.login('PayingGuest');
    expect((await guest.get('/m/lan-event-access')).text).toContain(d.ip);
    const notes = await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, member.id));
    expect(notes.some((n) => n.kind === 'lan-event-access')).toBe(true);

    // closing the account keeps the cash record but forgets the person
    await forgetUser(member.id);
    expect((await getDb().select().from(attendees))[0]).toMatchObject({ userId: null, name: 'Closed account', amountCents: 1500 });

    // revoking needs the manage permission; admins have everything
    expect((await outsider.post(`/admin/m/lan-event-access/devices/${d.id}/revoke`)).status).toBe(403);
    await boss.post(`/admin/m/lan-event-access/devices/${d.id}/revoke`);
    expect((await getDb().select().from(devices))[0].status).toBe('revoked');
  });

  it('rejects settings with overlapping-looking nonsense', async () => {
    await expect(saveModuleSettings('lan-event-access', { approvedRange: '10.0.0.300-10.0.0.1' })).rejects.toThrow();
    await expect(saveModuleSettings('lan-event-access', { firewallUrl: 'ftp://fw' })).rejects.toThrow();
    await expect(saveModuleSettings('lan-event-access', { pfsenseInterface: 'lan; rm' })).rejects.toThrow();
  });
});
