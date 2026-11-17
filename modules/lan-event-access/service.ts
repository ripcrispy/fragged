import { database, pg, eq, and, inArray, asc, desc, ServiceError } from '../../src/sdk/index.ts';
import { FirewallError, allocate, parseRange, inRange, normaliseMac, safeHostname, type Backend, type BackendConfig, type Lease, type Reservation } from './backends.ts';

export const attendees = pg.pgTable('mod_lan_event_access_attendees', {
  id: pg.serial('id').primaryKey(),
  name: pg.varchar('name', { length: 80 }).notNull(),
  userId: pg.integer('user_id'),
  amountCents: pg.integer('amount_cents').notNull().default(0),
  method: pg.varchar('method', { length: 12 }).notNull().default('cash'),
  note: pg.varchar('note', { length: 200 }).notNull().default(''),
  receivedBy: pg.integer('received_by'),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const devices = pg.pgTable('mod_lan_event_access_devices', {
  id: pg.serial('id').primaryKey(),
  attendeeId: pg.integer('attendee_id').notNull(),
  mac: pg.varchar('mac', { length: 17 }).notNull(),
  hostname: pg.varchar('hostname', { length: 80 }).notNull().default(''),
  ip: pg.varchar('ip', { length: 45 }).notNull().default(''),
  backend: pg.varchar('backend', { length: 20 }).notNull(),
  backendRef: pg.varchar('backend_ref', { length: 120 }).notNull().default(''),
  status: pg.varchar('status', { length: 10 }).notNull().default('approving'),
  approvedBy: pg.integer('approved_by'),
  approvedAt: pg.timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  revokedBy: pg.integer('revoked_by'),
  revokedAt: pg.timestamp('revoked_at', { withTimezone: true }),
});
export type Attendee = typeof attendees.$inferSelect;
export type Device = typeof devices.$inferSelect;

export const METHODS = { cash: 'Cash', card: 'Card', prepaid: 'Paid in advance', free: 'Free entry (crew or guest)' } as const;
export type Method = keyof typeof METHODS;
/** Methods where the desk takes money at the door and must tick “payment received”. */
export const TAKEN_AT_DOOR: readonly Method[] = ['cash', 'card'];

const db = () => database.db();

export function parseMoney(raw: string): number | null {
  const m = /^\s*(\d{1,5})(?:[.,](\d{1,2}))?\s*$/.exec(raw);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
}
export const formatMoney = (cents: number, symbol: string) => `${symbol}${(cents / 100).toFixed(2)}`;

const uniqueViolation = (e: any): string | null => {
  const code = e?.code ?? e?.cause?.code;
  if (code !== '23505') return null;
  const where = String(e?.constraint ?? e?.cause?.constraint ?? e?.message ?? e?.cause?.message ?? '');
  return where.includes('_ip_') ? 'ip' : 'mac';
};
const asServiceError = (e: unknown) => e instanceof FirewallError ? new ServiceError(e.message, e.status) : e;

export async function activeDevices() {
  return db().select().from(devices).where(inArray(devices.status, ['approving', 'approved'])).orderBy(desc(devices.approvedAt));
}
export async function listAttendees() { return db().select().from(attendees).orderBy(asc(attendees.name), asc(attendees.id)); }
export async function attendeeById(id: number) { return (await db().select().from(attendees).where(eq(attendees.id, id)))[0] ?? null; }
export async function deviceById(id: number) { return (await db().select().from(devices).where(eq(devices.id, id)))[0] ?? null; }

export interface NewAttendee { name: string; userId: number | null; amountCents: number; method: Method; note: string }
export interface ApproveRequest {
  mac: string;
  hostname: string;
  attendeeId?: number | null;
  newAttendee?: NewAttendee | null;
  actorId: number;
}

/**
 * Records the payment (for a new attendee) and moves the device into the approved section on the firewall.
 * The device row is written first with status "approving" so the unique indexes stop two desks approving the same
 * device or handing out the same address; if the firewall refuses, everything written here is rolled back.
 */
export async function approveDevice(backend: Backend, cfg: BackendConfig, req: ApproveRequest) {
  const mac = normaliseMac(req.mac);
  if (!mac) throw new ServiceError('That isn’t a valid MAC address.');
  if ((await activeDevices()).some((d) => d.mac === mac)) throw new ServiceError('This device is already approved.', 409);
  if (!req.attendeeId && !req.newAttendee) throw new ServiceError('Choose who this device belongs to.');
  if (req.newAttendee && req.newAttendee.name.length < 2) throw new ServiceError('Enter the attendee’s name.');

  let leases: Lease[], reservations: Reservation[];
  try { [leases, reservations] = await Promise.all([backend.leases(), backend.reservations()]); }
  catch (e) { throw asServiceError(e); }
  const lease = leases.find((l) => l.mac === mac) ?? null;
  if (!backend.assignsAddress && !lease) throw new ServiceError('This device has no DHCP lease right now. Plug it in, wait for an address, then approve it.', 409);
  const range = parseRange(cfg.approvedRange);
  if (backend.assignsAddress && !range) throw new ServiceError('Set a valid “Approved address range” in the module settings first.', 503);
  const hostname = safeHostname(req.hostname || lease?.hostname || '', mac);

  let attendee: Attendee;
  let createdAttendee = false;
  if (req.attendeeId) {
    const a = await attendeeById(req.attendeeId);
    if (!a) throw new ServiceError('That attendee no longer exists.', 404);
    attendee = a;
  } else {
    const n = req.newAttendee!;
    [attendee] = await db().insert(attendees).values({ name: n.name, userId: n.userId, amountCents: n.amountCents, method: n.method, note: n.note, receivedBy: req.actorId }).returning();
    createdAttendee = true;
  }
  const undoAttendee = async () => { if (createdAttendee) await db().delete(attendees).where(eq(attendees.id, attendee.id)); };

  // reserve an address (or the lease address) in our own table first
  let device: Device | null = null;
  const skip = new Set<string>();
  for (let attempt = 0; attempt < 5 && !device; attempt++) {
    let ip = lease?.ip ?? '';
    if (backend.assignsAddress) {
      const taken = new Set<string>([...skip, ...reservations.map((r) => r.ip), ...leases.filter((l) => l.mac !== mac).map((l) => l.ip), ...(await activeDevices()).map((d) => d.ip)]);
      const free = allocate(range!, taken);
      if (!free) { await undoAttendee(); throw new ServiceError('The approved address range is full. Widen it in the module settings.', 409); }
      ip = free;
    }
    try {
      [device] = await db().insert(devices).values({ attendeeId: attendee.id, mac, hostname, ip, backend: backend.id, status: 'approving', approvedBy: req.actorId }).returning();
    } catch (e) {
      const which = uniqueViolation(e);
      if (which === 'ip' && backend.assignsAddress) { skip.add(ip); continue; }
      await undoAttendee();
      if (which) throw new ServiceError('Another desk has just approved this device.', 409);
      throw e;
    }
  }
  if (!device) { await undoAttendee(); throw new ServiceError('Couldn’t find a free address. Try again.', 409); }

  try {
    const ref = await backend.approve({ mac, ip: device.ip, hostname, description: `Fragged: ${attendee.name}`.slice(0, 100) });
    await backend.apply();
    [device] = await db().update(devices).set({ status: 'approved', backendRef: ref.slice(0, 120) }).where(eq(devices.id, device.id)).returning();
  } catch (e) {
    await db().delete(devices).where(eq(devices.id, device.id));
    await undoAttendee();
    throw asServiceError(e);
  }
  return { device, attendee, createdAttendee };
}

export async function revokeDevice(backend: Backend, id: number, actorId: number) {
  const d = await deviceById(id);
  if (!d || d.status !== 'approved') throw new ServiceError('That device isn’t approved.', 404);
  try {
    await backend.revoke({ mac: d.mac, ip: d.ip, ref: d.backend === backend.id ? d.backendRef : '' });
    await backend.apply();
  } catch (e) { throw asServiceError(e); }
  const [out] = await db().update(devices).set({ status: 'revoked', revokedBy: actorId, revokedAt: new Date() }).where(eq(devices.id, d.id)).returning();
  return out;
}

export type DeviceState = 'online' | 'renewing' | 'offline' | 'moved' | 'missing';
export const STATE_LABELS: Record<DeviceState, string> = {
  online: 'On the LAN',
  renewing: 'Approved, still on a staging address. Reconnect the cable or renew DHCP',
  offline: 'No lease right now',
  moved: 'Lease address changed. Use “Sync with firewall”',
  missing: 'Not on the firewall. Use “Sync with firewall”',
};

function stateOf(d: Device, backend: Backend, cfg: BackendConfig, lease: Lease | undefined, reservations: Reservation[]): DeviceState {
  const onFirewall = backend.assignsAddress ? reservations.some((r) => r.mac === d.mac) : reservations.some((r) => r.ip === d.ip);
  if (!onFirewall) return 'missing';
  if (!lease) return 'offline';
  if (lease.ip === d.ip) return 'online';
  // with an alias the device keeps its staging address for good, so a different address means the lease moved
  if (!backend.assignsAddress) return 'moved';
  return inRange(lease.ip, parseRange(cfg.stagingRange)) ? 'renewing' : 'online';
}

/** Everything the door desk needs, with the firewall's live view merged in. Firewall errors are returned, not thrown. */
export async function deskState(backend: Backend, cfg: BackendConfig) {
  const [list, people] = await Promise.all([activeDevices(), listAttendees()]);
  let leases: Lease[] = [], reservations: Reservation[] = [], error: string | null = null;
  try { [leases, reservations] = await Promise.all([backend.leases(), backend.reservations()]); }
  catch (e) { error = e instanceof FirewallError ? e.message : 'The firewall request failed.'; if (!(e instanceof FirewallError)) throw e; }
  const staging = parseRange(cfg.stagingRange);
  const approvedMacs = new Set(list.map((d) => d.mac));
  const byMac = new Map(leases.map((l) => [l.mac, l]));
  const waiting = leases.filter((l) => inRange(l.ip, staging) && !approvedMacs.has(l.mac)).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  const byId = new Map(people.map((a) => [a.id, a]));
  const approved = list.filter((d) => d.status === 'approved').map((d) => ({
    device: d, attendee: byId.get(d.attendeeId) ?? null, lease: byMac.get(d.mac) ?? null,
    state: error ? null : stateOf(d, backend, cfg, byMac.get(d.mac), reservations),
  }));
  return { error, leases, waiting, approved, attendees: people, counts: devicesPerAttendee(list) };
}

function devicesPerAttendee(list: Device[]) {
  const m = new Map<number, number>();
  for (const d of list) if (d.status === 'approved') m.set(d.attendeeId, (m.get(d.attendeeId) ?? 0) + 1);
  return m;
}

/** Re-adds approved devices the firewall has lost (reboot, restore, someone deleted them) and follows lease changes. */
export async function syncWithFirewall(backend: Backend, cfg: BackendConfig) {
  let leases: Lease[], reservations: Reservation[];
  try { [leases, reservations] = await Promise.all([backend.leases(), backend.reservations()]); }
  catch (e) { throw asServiceError(e); }
  const byMac = new Map(leases.map((l) => [l.mac, l]));
  let restored = 0, moved = 0;
  try {
    for (const d of (await activeDevices()).filter((x) => x.status === 'approved')) {
      const lease = byMac.get(d.mac);
      const state = stateOf(d, backend, cfg, lease, reservations);
      const attendee = await attendeeById(d.attendeeId);
      const description = `Fragged: ${attendee?.name ?? 'attendee'}`.slice(0, 100);
      if (state === 'moved' && lease) {
        await backend.revoke({ mac: d.mac, ip: d.ip, ref: d.backendRef });
        const ref = await backend.approve({ mac: d.mac, ip: lease.ip, hostname: d.hostname, description });
        await db().update(devices).set({ ip: lease.ip, backendRef: ref.slice(0, 120), backend: backend.id }).where(eq(devices.id, d.id));
        moved++;
      } else if (state === 'missing') {
        const ip = backend.assignsAddress ? d.ip : lease?.ip;
        if (!ip) continue; // the alias needs an address; wait until the device has a lease
        const ref = await backend.approve({ mac: d.mac, ip, hostname: d.hostname, description });
        await db().update(devices).set({ ip, backendRef: ref.slice(0, 120), backend: backend.id }).where(eq(devices.id, d.id));
        restored++;
      }
    }
    if (restored || moved) await backend.apply();
  } catch (e) { throw asServiceError(e); }
  return { restored, moved };
}

export async function moneySummary() {
  const list = await listAttendees();
  const byMethod = new Map<string, { count: number; cents: number }>();
  for (const a of list) {
    const m = byMethod.get(a.method) ?? { count: 0, cents: 0 };
    m.count++; m.cents += a.amountCents; byMethod.set(a.method, m);
  }
  return { attendees: list.length, total: list.reduce((s, a) => s + a.amountCents, 0), byMethod };
}

export async function devicesForUser(userId: number) {
  const mine = await db().select().from(attendees).where(eq(attendees.userId, userId));
  if (!mine.length) return { attendees: mine, devices: [] as Device[] };
  const list = await db().select().from(devices).where(and(inArray(devices.attendeeId, mine.map((a) => a.id)), eq(devices.status, 'approved'))).orderBy(desc(devices.approvedAt));
  return { attendees: mine, devices: list };
}

/** Closed accounts: keep the payment record (it's a cash record) but drop the link and the name. */
export async function forgetUser(userId: number) {
  await db().update(attendees).set({ userId: null, name: 'Closed account', note: '' }).where(eq(attendees.userId, userId));
}
