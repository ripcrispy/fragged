/** @jsxImportSource hono/jsx */
import {
  defineModule, z, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Time, Stat, EmptyState, UserLink,
  form, str, int, bool, setFlash, cleanLine, cleanText, services, ServiceError, database, eq,
  type ModuleContext, type RequestContext, type PageCtx, type Viewer,
} from '../../src/sdk/index.ts';
import { BACKENDS, makeBackend, demoPlugIn, normaliseMac, parseRange, inRange, FirewallError, type BackendId, type BackendConfig } from './backends.ts';
import {
  METHODS, TAKEN_AT_DOOR, STATE_LABELS, parseMoney, formatMoney, approveDevice, revokeDevice, deskState, syncWithFirewall, moneySummary,
  devicesForUser, forgetUser, attendeeById, listAttendees, attendees, devices, type Method, type DeviceState,
} from './service.ts';

/** What the door desk reads from lan-bookings (optional): who has booked the event being run. */
interface DoorBooking { userId: number; username: string; status: 'booked' | 'interested'; typeName: string; priceCents: number; seat: string | null; termsAccepted: boolean }
interface BookingsApi { doorList(): Promise<{ event: { id: number; name: string; slug: string; startsAt: Date | null }; currency: string; bookings: DoorBooking[] } | null> }

const rangeOk = (s: string) => parseRange(s) !== null;
const settingsSchema = z.object({
  backend: z.enum(Object.keys(BACKENDS) as [BackendId, ...BackendId[]]),
  firewallUrl: z.string().max(200).refine((s) => s === '' || /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(s), 'Use an address like https://192.168.1.1 (no query string).'),
  verifyTls: z.boolean(),
  stagingRange: z.string().max(40).refine(rangeOk, 'Use a range like 10.10.1.10-10.10.1.250 or a subnet like 10.10.1.0/24.'),
  approvedRange: z.string().max(40).refine(rangeOk, 'Use a range like 10.10.0.10-10.10.0.250 or a subnet like 10.10.0.0/24.'),
  pfsenseInterface: z.string().regex(/^[a-z0-9_]{1,32}$/i, 'Use the pfSense interface id, for example lan or opt1.'),
  iscAlias: z.string().regex(/^[A-Za-z0-9_]{1,31}$/, 'Alias names use letters, digits and _ only.'),
  entryFee: z.string().max(10).refine((s) => parseMoney(s) !== null, 'Enter an amount like 15.00.'),
  currency: z.string().min(1).max(4),
  memberInfo: z.string().max(1000),
});
type Settings = z.infer<typeof settingsSchema>;

const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';
const STATE_TAG: Record<DeviceState, string> = { online: 'tag-ok', renewing: 'tag-held', offline: '', moved: 'tag-warning', missing: 'tag-warning' };
const methodOptions = Object.entries(METHODS) as [string, string][];

export default defineModule({
  id: 'lan-event-access',
  name: 'LAN Event Access',
  version: '1.2.0',
  description: 'Door-desk network access for LAN parties. New devices get a staging address from your OPNsense or pfSense firewall; once the desk confirms payment, one click moves them into the LAN DHCP section (Kea reservation, Dnsmasq host, pfSense static mapping or an OPNsense firewall alias).',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.2.0',
  enabledByDefault: false,
  optionalDependencies: { 'lan-bookings': '^1.1.0' },
  migrations: 'migrations',
  assets: 'public',
  styles: ['access.css'],
  permissions: {
    view: { label: 'See your own approved LAN devices', grantTo: ['member'] },
    desk: { label: 'Work the door desk: take entry payments and approve devices' },
    manage: { label: 'Revoke devices and sync with the firewall' },
  },
  notificationKinds: { 'lan-event-access': 'LAN network access: your device was approved' },
  settings: {
    schema: settingsSchema,
    defaults: {
      backend: 'demo', firewallUrl: '', verifyTls: true,
      stagingRange: '10.10.1.10-10.10.1.250', approvedRange: '10.10.0.10-10.10.0.250',
      pfsenseInterface: 'lan', iscAlias: 'LAN_APPROVED', entryFee: '15.00', currency: '£',
      memberInfo: 'Plug in at your seat, then come to the front desk to pay. We’ll switch your PC onto the LAN while you wait.',
    },
    fields: [
      { key: 'backend', label: 'Firewall and DHCP server', type: 'select', options: Object.entries(BACKENDS) as [string, string][], hint: 'Demo needs no firewall. See the module README for setting up each firewall.' },
      { key: 'firewallUrl', label: 'Firewall address', type: 'url', maxLength: 200, hint: 'For example https://192.168.1.1. Only the Fragged server connects to it.' },
      { key: 'verifyTls', label: 'Check the firewall’s TLS certificate', type: 'boolean', hint: 'Turn off only for a self-signed certificate on a network you trust, or set LAN_EVENT_ACCESS_CA_FILE instead.' },
      { key: 'stagingRange', label: 'Staging address range', type: 'string', maxLength: 40, hint: 'Where new, unapproved devices get their addresses. Devices here appear at the door desk.' },
      { key: 'approvedRange', label: 'Approved address range', type: 'string', maxLength: 40, hint: 'Addresses given to approved devices. Keep it outside every DHCP pool. Not used with OPNsense ISC.' },
      { key: 'pfsenseInterface', label: 'pfSense: DHCP interface', type: 'string', maxLength: 32, hint: 'Interface id of the LAN DHCP server, e.g. lan or opt1.' },
      { key: 'iscAlias', label: 'OPNsense ISC: firewall alias', type: 'string', maxLength: 31, hint: 'An alias of type “External (advanced)” that your LAN rules allow.' },
      { key: 'entryFee', label: 'Entry fee', type: 'string', maxLength: 10 },
      { key: 'currency', label: 'Currency symbol', type: 'string', maxLength: 4 },
      { key: 'memberInfo', label: 'Instructions shown to members', type: 'text', maxLength: 1000 },
      { key: 'apiKey', label: 'API key', type: 'env', env: 'LAN_EVENT_ACCESS_API_KEY', hint: 'OPNsense API key, or pfSense REST API key' },
      { key: 'apiSecret', label: 'API secret', type: 'env', env: 'LAN_EVENT_ACCESS_API_SECRET', hint: 'OPNsense API secret. Leave unset for a pfSense API key.' },
      { key: 'caFile', label: 'CA certificate file (optional)', type: 'env', env: 'LAN_EVENT_ACCESS_CA_FILE', hint: 'Path to the firewall’s CA certificate in PEM format' },
    ],
  },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), desk: ctx.perm('desk'), manage: ctx.perm('manage') };
    const cfg = () => ctx.settings.get<Settings>();
    const backendOf = (s: Settings) => makeBackend(s as BackendConfig);
    const canDesk = async (v: Viewer) => (await v.can(P.desk)) || (await v.can(P.manage));
    const requireDesk = async (v: Viewer) => { if (!(await canDesk(v))) await v.require(P.desk); };
    const money = (cents: number, s: Settings) => formatMoney(cents, s.currency);
    const DESK = '/admin/m/lan-event-access/desk';
    /** Bookings for the event at the door, when lan-bookings is on. Never breaks the desk if it fails. */
    const doorList = async () => {
      const api = ctx.use<BookingsApi>('lan-bookings');
      if (!api) return null;
      try { return await api.doorList(); } catch (e) { ctx.log.warn('lan-bookings door list failed', { error: String(e) }); return null; }
    };
    const flashError = (c: RequestContext, e: unknown) => {
      // service and firewall errors are messages for the desk; anything else is a bug and goes to the error page
      if (e instanceof ServiceError || e instanceof FirewallError) { setFlash(c, { type: 'error', text: e.message }); return; }
      throw e;
    };

    ctx.register.adminSection({ slug: 'desk', label: 'Event access', permission: P.desk });
    ctx.register.navItem({ href: '/m/lan-event-access', label: 'Network access', area: 'user-menu', order: 60, visible: async (v) => !!v.user && (await v.can(P.view)) });
    ctx.hooks.on('user.closed', async ({ userId }) => { await forgetUser(userId); });
    ctx.register.personalData({
      id: 'lan-event-access', label: 'LAN network access and entry payments',
      async export(userId) {
        const mine = await database.db().select().from(attendees).where(eq(attendees.userId, userId));
        return Promise.all(mine.map(async (a) => ({
          name: a.name, amountCents: a.amountCents, method: a.method, note: a.note, paid: a.createdAt,
          devices: (await database.db().select({ hostname: devices.hostname, mac: devices.mac, ip: devices.ip, status: devices.status, approved: devices.approvedAt, revoked: devices.revokedAt }).from(devices).where(eq(devices.attendeeId, a.id))),
        })));
      },
      // the payment is the organisers' record: it stays, but without the member's name or account
      erase: (userId) => forgetUser(userId),
    });

    // ── member page ──
    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer');
      if (!v.user) return c.redirect('/login?returnTo=/m/lan-event-access');
      await v.require(P.view);
      const page = c.get('page');
      const s = await cfg();
      const mine = await devicesForUser(v.user.id);
      return ctx.render(c, 'Network access', (
        <>
          <h1 class="page-title">Network access</h1>
          {s.memberInfo ? <p class="page-desc">{s.memberInfo}</p> : null}
          <Box title="Your approved devices">
            {mine.devices.length ? <table class="data-table"><thead><tr><th>Device</th><th>Address</th><th>Approved</th></tr></thead><tbody>
              {mine.devices.map((d) => <tr><td><strong>{d.hostname}</strong><div class="lea-mac muted small">{d.mac}</div></td><td class="lea-mac">{d.ip}</td><td><Time d={d.approvedAt} tz={tzOf(page)} mode="ago" /></td></tr>)}
            </tbody></table> : <p class="muted">No devices approved for you yet. Plug in and visit the front desk.</p>}
          </Box>
          {mine.attendees.length ? <Box title="Entry payment">
            <ul class="plain-list">{mine.attendees.map((a) => <li>{a.amountCents ? money(a.amountCents, s) : 'No charge'} · {METHODS[a.method as Method] ?? a.method} · <Time d={a.createdAt} tz={tzOf(page)} /></li>)}</ul>
          </Box> : null}
        </>
      ), { crumbs: [{ label: 'Network access' }] });
    });

    // ── door desk ──
    ctx.adminRoutes.get('/desk', async (c) => {
      const v = c.get('viewer'); await requireDesk(v);
      const page = c.get('page');
      const s = await cfg();
      const manage = await v.can(P.manage);
      const backend = backendOf(s);
      const st = await deskState(backend, s as BackendConfig);
      const sum = await moneySummary();
      const users = await services.users.cards(st.attendees.map((a) => a.userId).filter((x): x is number => x !== null));
      const door = await doorList();
      const booked = door?.bookings.filter((b) => b.status === 'booked') ?? [];
      const paidBy = new Map(st.attendees.filter((a) => a.userId !== null).map((a) => [a.userId!, a]));
      const arrived = booked.filter((b) => paidBy.has(b.userId)).length;
      const bookedRows = [...booked].sort((a, b) => Number(paidBy.has(a.userId)) - Number(paidBy.has(b.userId)) || a.username.localeCompare(b.username));
      const bookingMoney = (cents: number) => formatMoney(cents, door?.currency ?? s.currency);
      const staging = parseRange(s.stagingRange), approved = parseRange(s.approvedRange);
      const overlap = backend.assignsAddress && staging && approved && staging.start <= approved.end && approved.start <= staging.end;
      const tz = tzOf(page);
      return ctx.renderAdmin(c, 'Event access', P.desk, (
        <div class="lea-desk" data-lea-refresh="15">
          <p class="lea-conn">Firewall: <strong>{backend.label}</strong>{s.backend !== 'demo' && s.firewallUrl ? <> at <span class="lea-mac">{s.firewallUrl}</span></> : null}
            {manage ? <> · <a href="/admin/modules?open=lan-event-access#module-lan-event-access">Settings</a></> : null}</p>
          {st.error ? <Notice type="error" title="Can’t reach the firewall">{st.error}</Notice> : null}
          {overlap ? <Notice type="warn" title="Address ranges overlap">The staging and approved ranges overlap. Approved devices would show up as waiting again. Fix them in the settings.</Notice> : null}
          {s.backend === 'demo' ? <Notice type="info" title="Demo mode">No firewall is connected. Devices and addresses are simulated so you can try the desk.</Notice> : null}
          <div class="stats-row">
            <Stat label="Waiting" value={String(st.waiting.length)} />
            <Stat label="Approved devices" value={String(st.approved.length)} />
            {door ? <Stat label="Booked arrived" value={`${arrived} / ${booked.length}`} /> : null}
            <Stat label="Attendees" value={String(sum.attendees)} />
            <Stat label="Collected" value={money(sum.total, s)} />
          </div>

          <Box title={`Waiting at the door (${st.waiting.length})`} actions={<a class="btn btn-small" href={DESK}>Refresh</a>}>
            {st.waiting.length ? <div class="table-wrap"><table class="data-table lea-stack"><thead><tr><th>Device</th><th>MAC address</th><th>Staging address</th><th /></tr></thead><tbody>
              {st.waiting.map((l) => <tr>
                <td><strong>{l.hostname || <span class="muted">(no name)</span>}</strong>{l.iface ? <div class="muted small">{l.iface}</div> : null}</td>
                <td class="lea-mac" data-label="MAC">{l.mac}</td><td class="lea-mac" data-label="Staging address">{l.ip}</td>
                <td class="lea-actions"><a class="btn btn-small btn-primary" href={`${DESK}/approve?mac=${encodeURIComponent(l.mac)}`}>Take payment &amp; approve</a></td>
              </tr>)}
            </tbody></table></div> : <p class="muted">{st.error ? 'Waiting devices appear here once the firewall answers.' : 'No new devices on the staging network.'}</p>}
            {s.backend === 'demo' ? <ActionButton ctx={page} action="/admin/m/lan-event-access/demo/plug" label="Simulate a device plugging in" className="btn btn-small" /> : null}
            {backend.assignsAddress ? <details class="lea-manual"><summary>Approve a device by MAC address</summary>
              <form method="get" action={`${DESK}/approve`} class="form-grid">
                <div class="field-row"><Field label="MAC address" name="mac" required maxlength={20} placeholder="aa:bb:cc:dd:ee:ff" /></div>
                <div class="form-actions"><button class="btn btn-small">Continue</button></div>
              </form></details> : null}
          </Box>

          {door ? <Box title={`Booked for ${door.event.name} (${booked.length})`} actions={<a class="btn btn-small" href={`/m/lan-bookings/${door.event.slug}`}>Booking page</a>}>
            {bookedRows.length ? <div class="table-wrap"><table class="data-table lea-stack"><thead><tr><th>Member</th><th>Booking</th><th>Seat</th><th>At the door</th></tr></thead><tbody>
              {bookedRows.map((b) => { const a = paidBy.get(b.userId); return <tr class={a ? 'lea-arrived' : ''}>
                <td><strong>{b.username}</strong>{b.termsAccepted ? null : <div class="small muted">Hasn’t agreed to the rules yet</div>}</td>
                <td data-label="Booking">{b.typeName} · {bookingMoney(b.priceCents)}</td>
                <td class="lea-mac" data-label="Seat">{b.seat ?? <span class="muted">none yet</span>}</td>
                <td data-label="At the door">{a ? <span class="tag tag-ok">Paid {money(a.amountCents, s)} · {st.counts.get(a.id) ?? 0} device{st.counts.get(a.id) === 1 ? '' : 's'}</span> : <span class="muted">Not arrived</span>}</td>
              </tr>; })}
            </tbody></table></div> : <p class="muted">Nobody has booked yet.</p>}
            {door.bookings.length > booked.length ? <p class="small muted">Plus {door.bookings.length - booked.length} interested, not booked.</p> : null}
          </Box> : null}

          <Box title={`Approved devices (${st.approved.length})`} actions={manage ? <ActionButton ctx={page} action="/admin/m/lan-event-access/sync" label="Sync with firewall" className="btn btn-small" /> : undefined}>
            {st.approved.length ? <div class="table-wrap"><table class="data-table lea-stack"><thead><tr><th>Attendee</th><th>Device</th><th>Address</th><th>Status</th><th>Approved</th>{manage ? <th /> : null}</tr></thead><tbody>
              {st.approved.map(({ device: d, attendee: a, state }) => {
                const u = a?.userId ? users.get(a.userId) : null;
                return <tr>
                  <td><strong>{a?.name ?? '—'}</strong>{u ? <div class="small"><UserLink user={u} /></div> : null}</td>
                  <td data-label="Device">{d.hostname}<div class="lea-mac muted small">{d.mac}</div></td>
                  <td class="lea-mac" data-label="Address">{d.ip}</td>
                  <td>{state ? <span class={`tag ${STATE_TAG[state]}`}>{STATE_LABELS[state]}</span> : <span class="muted small">Unknown</span>}</td>
                  <td class="small" data-label="Approved"><Time d={d.approvedAt} tz={tz} mode="ago" /></td>
                  {manage ? <td class="lea-actions"><ActionButton ctx={page} action={`/admin/m/lan-event-access/devices/${d.id}/revoke`} label="Revoke" className="btn btn-small btn-ghost" confirm={`Take ${d.hostname} off the LAN? It goes back to the staging network when it renews.`} /></td> : null}
                </tr>;
              })}
            </tbody></table></div> : <p class="muted">No devices approved yet.</p>}
          </Box>

          <Box title={`Attendees and payments (${sum.attendees})`}>
            {sum.byMethod.size ? <p class="lea-totals">{[...sum.byMethod].map(([m, x]) => <span><strong>{METHODS[m as Method] ?? m}</strong>: {x.count} · {money(x.cents, s)}</span>)}</p> : null}
            {st.attendees.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Paid</th><th>How</th><th>Devices</th><th>When</th></tr></thead><tbody>
              {st.attendees.map((a) => { const u = a.userId ? users.get(a.userId) : null; return <tr>
                <td><strong>{a.name}</strong>{u ? <div class="small"><UserLink user={u} /></div> : null}{a.note ? <div class="muted small">{a.note}</div> : null}</td>
                <td>{money(a.amountCents, s)}</td><td>{METHODS[a.method as Method] ?? a.method}</td>
                <td>{st.counts.get(a.id) ?? 0}</td><td class="small"><Time d={a.createdAt} tz={tz} /></td></tr>; })}
            </tbody></table></div> : <p class="muted">Nobody has paid yet.</p>}
          </Box>

          {manage && s.backend !== 'demo' ? <Box title="Firewall connection">
            <p class="small">Checks the address and API credentials by reading leases and the approved section. Nothing is changed.</p>
            <ActionButton ctx={page} action="/admin/m/lan-event-access/test" label="Test connection" className="btn btn-small" />
          </Box> : null}
          <script src="/modules/lan-event-access/access.js" defer></script>
        </div>
      ));
    });

    ctx.adminRoutes.get('/desk/approve', async (c) => {
      const v = c.get('viewer'); await requireDesk(v);
      const page = c.get('page');
      const s = await cfg();
      const mac = normaliseMac(c.req.query('mac') ?? '');
      if (!mac) { setFlash(c, { type: 'error', text: 'That isn’t a valid MAC address.' }); return c.redirect(DESK); }
      const backend = backendOf(s);
      const st = await deskState(backend, s as BackendConfig);
      if (st.approved.some((x) => x.device.mac === mac)) { setFlash(c, { type: 'ok', text: 'That device is already approved.' }); return c.redirect(DESK); }
      const lease = st.leases.find((l) => l.mac === mac) ?? null;
      const fee = parseMoney(s.entryFee) ?? 0;
      const door = await doorList();
      const paidUsers = new Set(st.attendees.map((a) => a.userId).filter((x): x is number => x !== null));
      const bookedWaiting = (door?.bookings ?? []).filter((b) => b.status === 'booked' && !paidUsers.has(b.userId)).sort((a, b) => a.username.localeCompare(b.username));
      const paidLabel = (a: (typeof st.attendees)[number]) => `${a.name} (paid ${money(a.amountCents, s)}, ${st.counts.get(a.id) ?? 0} device${st.counts.get(a.id) === 1 ? '' : 's'})`;
      return ctx.renderAdmin(c, 'Approve a device', P.desk, (
        <>
          <p><a href={DESK}>← Door desk</a></p>
          {st.error ? <Notice type="error" title="Can’t reach the firewall">{st.error}</Notice> : null}
          <Box title="Device">
            <dl class="lea-device">
              <dt>Name</dt><dd>{lease?.hostname || <span class="muted">(no name)</span>}</dd>
              <dt>MAC address</dt><dd class="lea-mac">{mac}</dd>
              <dt>Current address</dt><dd class="lea-mac">{lease?.ip ?? <span class="muted">no lease right now</span>}</dd>
            </dl>
            {!lease && !st.error ? <Notice type="warn">The firewall has no lease for this device. {backend.assignsAddress ? 'You can still approve it; it gets its LAN address when it next asks for one.' : 'Plug it in and wait for an address before approving it.'}</Notice> : null}
          </Box>
          <Box title="Payment and approval">
            <form method="post" action={`${DESK}/approve`} class="form-grid lea-approve" data-lea-approve><Csrf ctx={page} />
              <input type="hidden" name="mac" value={mac} />
              <Field label="Device name on the network" name="hostname" value={lease?.hostname ?? ''} maxlength={63} hint="Letters, digits and dashes. Leave empty to use one based on the MAC address." />
              <div class="field">
                <label for="f-attendee">Who is this device for?</label>
                <select id="f-attendee" name="attendee" data-fee={(fee / 100).toFixed(2)}>
                  <option value="new" selected>New attendee: take the entry payment now</option>
                  {bookedWaiting.length ? <optgroup label={`Booked for ${door!.event.name}: take payment now`}>
                    {bookedWaiting.map((b) => <option value={`booking:${b.userId}`} data-price={(b.priceCents / 100).toFixed(2)}>{b.username}: {b.typeName}, {formatMoney(b.priceCents, door!.currency)}{b.seat ? `, seat ${b.seat}` : ''}</option>)}
                  </optgroup> : null}
                  {st.attendees.length ? <optgroup label="Already paid: add another device">
                    {st.attendees.map((a) => <option value={String(a.id)}>{paidLabel(a)}</option>)}
                  </optgroup> : null}
                </select>
                <div class="field-hint">Booked members pay their booking price. Someone who already paid can add another device without paying again.</div>
              </div>
              <fieldset class="lea-new" data-lea-new><legend>Payment</legend>
                <div class="field-row">
                  <Field label="Name" name="name" maxlength={80} placeholder="Name on their ticket (booked: their username)" />
                  <Field label="Fragged username (optional)" name="username" maxlength={40} placeholder="Links the device to their account" />
                </div>
                <div class="field-row">
                  <Field label={`Amount (${s.currency})`} name="amount" value="" placeholder={`${(fee / 100).toFixed(2)} entry fee`} inputmode="decimal" maxlength={10} />
                  <Select label="Payment" name="method" value="cash" options={methodOptions} />
                </div>
                <p class="field-hint lea-amount-hint">Leave the amount empty to charge the entry fee, or a booked member’s booking price.</p>
                <Field label="Note (optional)" name="note" maxlength={200} placeholder="Receipt number, who paid for them…" />
                <Checkbox label="Payment received" name="paid" hint="Required for cash and card." />
              </fieldset>
              <div class="form-actions"><button class="btn btn-primary">Approve device</button></div>
            </form>
          </Box>
          <script src="/modules/lan-event-access/access.js" defer></script>
        </>
      ));
    });

    ctx.adminRoutes.post('/desk/approve', async (c) => {
      const v = c.get('viewer'); await requireDesk(v);
      const s = await cfg();
      const b = await form(c);
      const mac = normaliseMac(str(b.mac)) ?? '';
      const back = mac ? `${DESK}/approve?mac=${encodeURIComponent(mac)}` : DESK;
      try {
        const who = str(b.attendee);
        let newAttendee = null;
        let attendeeId: number | null = null;
        if (who === 'new' || !who || who.startsWith('booking:')) {
          const method = str(b.method) as Method;
          if (!(method in METHODS)) throw new ServiceError('Choose how they paid.');
          let userId: number | null = null;
          let name = cleanLine(b.name, 80);
          let note = cleanText(b.note, 200);
          const username = cleanLine(b.username, 40);
          if (who.startsWith('booking:')) userId = int(who.slice(8));
          else if (username) {
            const u = await services.users.getByUsername(username);
            if (!u) throw new ServiceError(`There’s no member called “${username}”.`);
            userId = u.id;
          }
          // a booked member pays their booking price unless the desk typed another amount
          const booking = userId !== null ? (await doorList())?.bookings.find((x) => x.userId === userId && x.status === 'booked') : undefined;
          if (who.startsWith('booking:') && !booking) throw new ServiceError('That booking no longer exists. Choose “New attendee” instead.', 409);
          if (userId !== null && (await listAttendees()).some((a) => a.userId === userId)) throw new ServiceError('This member has already paid. Choose their name under “Already paid” to add another device.', 409);
          if (booking) { name ||= booking.username; note ||= `Booked: ${booking.typeName}${booking.seat ? `, seat ${booking.seat}` : ''}`; }
          const rawAmount = str(b.amount).trim();
          const amount = rawAmount ? parseMoney(rawAmount) : booking ? booking.priceCents : parseMoney(s.entryFee);
          if (amount === null) throw new ServiceError('Enter the amount like 15.00.');
          if (TAKEN_AT_DOOR.includes(method) && !bool(b.paid)) throw new ServiceError('Tick “Payment received” once you have the money.');
          newAttendee = { name, userId, amountCents: amount, method, note };
        } else attendeeId = int(who);
        const r = await approveDevice(backendOf(s), s as BackendConfig, { mac, hostname: str(b.hostname), attendeeId, newAttendee, actorId: v.user!.id });
        if (r.createdAttendee) await services.audit(v.user!.id, 'lan-event-access.payment', { type: 'lan_attendee', id: r.attendee.id }, { name: r.attendee.name, amount: money(r.attendee.amountCents, s), method: r.attendee.method }, v.ip);
        await services.audit(v.user!.id, 'lan-event-access.approve', { type: 'lan_device', id: r.device.id }, { mac: r.device.mac, ip: r.device.ip, attendee: r.attendee.name, backend: r.device.backend }, v.ip);
        if (r.attendee.userId) await services.notify(r.attendee.userId, 'lan-event-access', v.user!.id, `${r.device.hostname} is approved for the LAN.`, '/m/lan-event-access');
        const hint = makeBackend(s as BackendConfig).assignsAddress ? ` It moves to ${r.device.ip} when it renews its lease; unplugging and replugging the cable does it straight away.` : ` ${r.device.ip} is now allowed through the firewall.`;
        setFlash(c, { type: 'ok', text: `Approved ${r.device.hostname} for ${r.attendee.name}.${hint}` });
        return c.redirect(DESK);
      } catch (e) { flashError(c, e); return c.redirect(back); }
    });

    ctx.adminRoutes.post('/devices/:id/revoke', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const s = await cfg();
      try {
        const d = await revokeDevice(backendOf(s), int(c.req.param('id')), v.user!.id);
        const a = await attendeeById(d.attendeeId);
        await services.audit(v.user!.id, 'lan-event-access.revoke', { type: 'lan_device', id: d.id }, { mac: d.mac, ip: d.ip, attendee: a?.name ?? '' }, v.ip);
        setFlash(c, { type: 'ok', text: `Revoked ${d.hostname}.` });
      } catch (e) { flashError(c, e); }
      return c.redirect(DESK);
    });

    ctx.adminRoutes.post('/sync', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const s = await cfg();
      try {
        const r = await syncWithFirewall(backendOf(s), s as BackendConfig);
        if (r.restored || r.moved) await services.audit(v.user!.id, 'lan-event-access.sync', { type: 'lan_device' }, r, v.ip);
        setFlash(c, { type: 'ok', text: r.restored || r.moved ? `Synced: ${r.restored} restored, ${r.moved} updated.` : 'The firewall already matches.' });
      } catch (e) { flashError(c, e); }
      return c.redirect(DESK);
    });

    ctx.adminRoutes.post('/test', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const s = await cfg();
      const backend = backendOf(s);
      try {
        const [leases, res] = await Promise.all([backend.leases(), backend.reservations()]);
        const waiting = leases.filter((l) => inRange(l.ip, parseRange(s.stagingRange))).length;
        setFlash(c, { type: 'ok', text: `Connected to ${backend.label}: ${leases.length} leases (${waiting} in the staging range), ${res.length} entries in the approved section.` });
      } catch (e) { flashError(c, e); }
      return c.redirect(DESK);
    });

    ctx.adminRoutes.post('/demo/plug', async (c) => {
      const v = c.get('viewer'); await requireDesk(v);
      const s = await cfg();
      if (s.backend !== 'demo') throw new ServiceError('Only available in demo mode.', 404);
      backendOf(s);
      const l = demoPlugIn(s as BackendConfig);
      setFlash(c, { type: 'ok', text: `${l.hostname} plugged in and got ${l.ip}.` });
      return c.redirect(DESK);
    });

  },
});
