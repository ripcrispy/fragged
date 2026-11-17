/** @jsxImportSource hono/jsx */
import {
  defineModule, database, pg, eq, asc, desc, sql, z, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Html, Time, Stat, EmptyState,
  form, str, int, bool, setFlash, cleanLine, cleanText, parseLocalDateTime, toLocalInput, renderBBCode, services, ServiceError,
  type ModuleContext, type RequestContext, type PageCtx, type Child,
} from '../../src/sdk/index.ts';
import { probe, type ProbeKind, type ServerStatus } from './probes.ts';

// ── tables (migrations/0001_init.sql) ──
const announcements = pg.pgTable('mod_lan_intranet_announcements', {
  id: pg.serial('id').primaryKey(), title: pg.varchar('title', { length: 140 }).notNull(), body: pg.text('body').notNull().default(''),
  level: pg.varchar('level', { length: 10 }).notNull().default('info'), pinned: pg.boolean('pinned').notNull().default(false),
  startsAt: pg.timestamp('starts_at', { withTimezone: true }), endsAt: pg.timestamp('ends_at', { withTimezone: true }),
  createdBy: pg.integer('created_by'), createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
const servers = pg.pgTable('mod_lan_intranet_servers', {
  id: pg.serial('id').primaryKey(), name: pg.varchar('name', { length: 80 }).notNull(), game: pg.varchar('game', { length: 80 }).notNull().default(''),
  host: pg.varchar('host', { length: 253 }).notNull().default(''), port: pg.integer('port').notNull().default(0), kind: pg.varchar('kind', { length: 12 }).notNull().default('tcp'),
  connect: pg.varchar('connect', { length: 200 }).notNull().default(''), notes: pg.varchar('notes', { length: 300 }).notNull().default(''),
  displayOrder: pg.integer('display_order').notNull().default(0), enabled: pg.boolean('enabled').notNull().default(true),
});
const schedule = pg.pgTable('mod_lan_intranet_schedule', {
  id: pg.serial('id').primaryKey(), title: pg.varchar('title', { length: 140 }).notNull(), startsAt: pg.timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: pg.timestamp('ends_at', { withTimezone: true }), location: pg.varchar('location', { length: 120 }).notNull().default(''), notes: pg.varchar('notes', { length: 300 }).notNull().default(''),
});

const SECTIONS = ['announcements', 'countdown', 'servers', 'schedule', 'seating', 'pizza', 'caffeine', 'wifi', 'info'] as const;
const KINDS: Record<ProbeKind, string> = { tcp: 'TCP port check', source: 'Source engine (A2S query: players & map)', minecraft: 'Minecraft (server list ping)', none: 'Not monitored' };
const LEVELS = { info: 'Info', warn: 'Heads up', urgent: 'Urgent' } as const;

const settingsSchema = z.object({
  title: z.string().min(1).max(80),
  tagline: z.string().max(160),
  eventStart: z.string().regex(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?$/, 'use YYYY-MM-DDTHH:MM'),
  timezone: z.string().min(1).max(64),
  wifi: z.string().max(1000),
  info: z.string().max(10000),
  sections: z.string().max(200).refine((s) => s.split(',').map((x) => x.trim()).filter(Boolean).every((x) => (SECTIONS as readonly string[]).includes(x)), `allowed: ${SECTIONS.join(', ')}`),
  audience: z.enum(['everyone', 'members']),
  refreshSeconds: z.number().int().min(10).max(600),
});
type Settings = z.infer<typeof settingsSchema>;

const db = () => database.db();
const status = new Map<number, ServerStatus>();
let timer: NodeJS.Timeout | null = null;

async function pollServers() {
  const list = await db().select().from(servers).where(eq(servers.enabled, true));
  await Promise.all(list.map(async (s) => {
    if (s.kind === 'none' || !s.host || !s.port) { status.delete(s.id); return; }
    status.set(s.id, await probe(s.kind as ProbeKind, s.host, s.port));
  }));
}
const statusLabel = (st: ServerStatus | undefined) => !st ? 'Not monitored' : st.online ? `Online${st.latencyMs != null ? ` · ${st.latencyMs} ms` : ''}` : `Offline${st.error ? ` (${st.error})` : ''}`;
const playersOf = (st: ServerStatus | undefined) => (st?.online && st.maxPlayers != null ? `${st.players ?? 0} / ${st.maxPlayers}` : '—');

export default defineModule({
  id: 'lan-intranet',
  name: 'LAN party intranet',
  version: '1.1.0',
  description: 'An event-day landing page: announcements, countdown, game-server status, schedule, Wi-Fi details and widgets from other LAN modules. Every section is configurable.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  enabledByDefault: false,
  // widgets appear when these are enabled
  optionalDependencies: { 'lan-seating': '^1.0.0', 'caffeine-tracker': '^1.0.0', 'lan-pizza': '^1.0.0' },
  migrations: 'migrations',
  assets: 'public',
  styles: ['intranet.css'],
  permissions: { manage: { label: 'Edit the LAN intranet: announcements, game servers and schedule' } },
  settings: {
    schema: settingsSchema,
    defaults: { title: 'LAN Party HQ', tagline: 'Plug in, grab a seat, check the servers.', eventStart: '', timezone: 'UTC', wifi: '', info: '', sections: 'announcements,countdown,servers,schedule,seating,pizza,caffeine,wifi,info', audience: 'everyone', refreshSeconds: 30 },
    fields: [
      { key: 'title', label: 'Page title', type: 'string', maxLength: 80 },
      { key: 'tagline', label: 'Tagline', type: 'string', maxLength: 160 },
      { key: 'eventStart', label: 'Doors open (for the countdown), YYYY-MM-DDTHH:MM', type: 'string', maxLength: 16, hint: 'Leave empty to hide the countdown.' },
      { key: 'timezone', label: 'Event timezone (e.g. Europe/London)', type: 'string', maxLength: 64 },
      { key: 'wifi', label: 'Wi-Fi details (BBCode)', type: 'text', maxLength: 1000 },
      { key: 'info', label: 'House rules & info (BBCode)', type: 'text', maxLength: 10000 },
      { key: 'sections', label: 'Sections in display order (comma separated)', type: 'string', maxLength: 200, hint: `Available: ${SECTIONS.join(', ')}. Remove one to hide it.` },
      { key: 'audience', label: 'Who can see the intranet', type: 'select', options: [['everyone', 'Everyone, including guests'], ['members', 'Signed-in members only']] },
      { key: 'refreshSeconds', label: 'Server status refresh (seconds)', type: 'number', min: 10, max: 600 },
    ],
  },

  async start(ctx) {
    const s = await ctx.settings.get<Settings>();
    await pollServers().catch((e) => ctx.log.warn('server poll failed', { error: String(e) }));
    timer = setInterval(() => void pollServers().catch(() => {}), s.refreshSeconds * 1000);
    timer.unref();
  },
  async stop() { if (timer) clearInterval(timer); timer = null; },

  setup(ctx: ModuleContext) {
    const manage = ctx.perm('manage');
    const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';
    ctx.register.navItem({ href: '/m/lan-intranet', label: 'LAN HQ', icon: 'monitor', area: 'main', order: 15,
      visible: async (v) => (await ctx.settings.get<Settings>()).audience === 'everyone' || !!v.user });
    ctx.register.adminSection({ slug: 'manage', label: 'LAN intranet', permission: manage });

    const gate = async (c: RequestContext) => {
      const s = await ctx.settings.get<Settings>();
      if (s.audience === 'members' && !c.get('viewer').user) throw new ServiceError('Sign in to see the LAN intranet.', 401, 'login_required');
      return s;
    };

    ctx.routes.get('/status.json', async (c) => {
      await gate(c);
      const list = await db().select().from(servers).where(eq(servers.enabled, true)).orderBy(asc(servers.displayOrder));
      c.header('Cache-Control', 'no-store');
      return c.json({ servers: list.map((s) => { const st = status.get(s.id); return { id: s.id, status: st ?? null, label: statusLabel(st), players: playersOf(st), map: st?.map ?? '' }; }) });
    });

    ctx.routes.get('/', async (c) => {
      const s = await gate(c);
      const page = c.get('page');
      const tz = tzOf(page);
      const now = new Date();
      const anns = (await db().select().from(announcements).orderBy(desc(announcements.pinned), desc(announcements.createdAt)))
        .filter((a) => (!a.startsAt || a.startsAt <= now) && (!a.endsAt || a.endsAt > now));
      const srv = await db().select().from(servers).where(eq(servers.enabled, true)).orderBy(asc(servers.displayOrder), asc(servers.id));
      const sched = await db().select().from(schedule).orderBy(asc(schedule.startsAt));
      const start = s.eventStart ? parseLocalDateTime(s.eventStart, s.timezone) : null;
      const seating = ctx.use<{ currentSummary(): Promise<any> }>('lan-seating');
      const pizza = ctx.use<{ currentSummary(): Promise<{ name: string; statusLabel: string; closesAt: Date | null; orders: number; accepting: boolean; url: string } | null> }>('lan-pizza');
      const caffeine = ctx.use<{ leaderboard(kind: 'now', limit: number): Promise<{ username: string; mg: number; level: string }[]> }>('caffeine-tracker');

      const blocks: Record<string, () => Promise<Child | null>> = {
        announcements: async () => anns.length ? (
          <Box title="Announcements">{anns.map((a) => (
            <article class={`ann ann-${a.level}`}><h3>{a.pinned ? <span class="tag">Pinned</span> : null} {LEVELS[a.level as keyof typeof LEVELS] ?? ''}: {a.title}</h3>
              {a.body ? <div class="bb"><Html html={renderBBCode(a.body, { embeds: false })} /></div> : null}
              <p class="muted small"><Time d={a.createdAt} tz={tz} mode="ago" /></p></article>))}
          </Box>) : null,
        servers: async () => (
          <Box title="Game servers">
            {srv.length ? <div class="table-wrap"><table class="data-table" data-servers><thead><tr><th>Server</th><th>Game</th><th>Status</th><th>Players</th><th>Map</th><th>Connect</th></tr></thead><tbody>
              {srv.map((x) => { const st = status.get(x.id); return (
                <tr data-server={x.id}><td><strong>{x.name}</strong>{x.notes ? <div class="muted small">{x.notes}</div> : null}</td><td>{x.game}</td>
                  <td><span data-st class={`srv-status ${st ? (st.online ? 'srv-up' : 'srv-down') : ''}`}><span class="srv-dot" aria-hidden="true" /><span>{statusLabel(st)}</span></span></td>
                  <td data-pl>{playersOf(st)}</td><td data-map>{st?.map ?? ''}</td><td><span class="srv-connect">{x.connect || (x.host && x.port ? `${x.host}:${x.port}` : '')}</span></td></tr>); })}
            </tbody></table></div> : <p class="muted">No servers listed yet.</p>}
          </Box>),
        schedule: async () => sched.length ? (
          <Box title="Schedule">
            <table class="data-table"><tbody>{sched.map((e) => {
              const end = e.endsAt ?? new Date(e.startsAt.getTime() + 3600_000);
              const cls = now >= e.startsAt && now < end ? 'sched-now' : now >= end ? 'sched-past' : '';
              return <tr class={cls}><td class="nowrap"><Time d={e.startsAt} tz={s.timezone} /></td><td><strong>{e.title}</strong>{cls === 'sched-now' ? <span class="tag tag-ok"> now</span> : null}{e.location ? <div class="muted small">{e.location}</div> : null}</td></tr>;
            })}</tbody></table>
          </Box>) : null,
        seating: async () => {
          const sum = seating ? await seating.currentSummary().catch(() => null) : null;
          if (!sum) return null;
          const pct = sum.capacity ? Math.round((sum.booked / sum.capacity) * 100) : 0;
          return <Box title="Seating"><p><a href={sum.url}><strong>{sum.name}</strong></a>: {sum.booked} of {sum.capacity} seats booked</p>
            <progress class="meter-progress" value={sum.booked} max={Math.max(1, sum.capacity)} aria-label={`${pct}% of seats booked`}>{pct}%</progress>
            <p><a class="btn btn-small" href={sum.url}>Pick your seat</a></p></Box>;
        },
        pizza: async () => {
          const p = pizza ? await pizza.currentSummary().catch(() => null) : null;
          if (!p) return null;
          return <Box title="Pizza run"><p><strong>{p.name}</strong>: {p.statusLabel}</p>
            <p>{p.orders} order{p.orders === 1 ? '' : 's'} so far{p.accepting && p.closesAt ? <> · orders close <Time d={p.closesAt} tz={tz} /></> : null}</p>
            <p><a class="btn btn-small" href={p.url}>{p.accepting ? 'Order food' : 'See your order'}</a></p></Box>;
        },
        caffeine: async () => {
          const top = caffeine ? await caffeine.leaderboard('now', 5).catch(() => []) : [];
          if (!caffeine) return null;
          return <Box title="Most caffeinated right now">{top.length ? <ol class="plain-list">{top.map((t) => <li><a href={`/u/${encodeURIComponent(t.username)}`}>{t.username}</a> — {Math.round(t.mg)} mg · <strong>{t.level}</strong></li>)}</ol> : <p class="muted">Nobody has logged a drink yet.</p>}
            <p><a href="/m/caffeine-tracker">Full leaderboard</a></p></Box>;
        },
        wifi: async () => s.wifi ? <Box title="Wi-Fi"><div class="bb"><Html html={renderBBCode(s.wifi, { embeds: false })} /></div></Box> : null,
        info: async () => s.info ? <Box title="Info & house rules"><div class="bb"><Html html={renderBBCode(s.info, { embeds: false })} /></div></Box> : null,
      };
      // The countdown lives in the hero banner rather than the grid: as a small card it ended up
      // orphaned on its own row between the full-width announcements and servers boxes.
      const sections = s.sections.split(',').map((x) => x.trim());
      const countdown = start && sections.includes('countdown') ? (
        <div class="intranet-countdown">
          <p class="intranet-countdown-label">{start > now ? 'Doors open in' : 'We’re live!'}</p>
          <div class="countdown" data-countdown={start.toISOString()} role="timer" aria-label={`Doors open ${start.toISOString()}`}>
            <Stat label="days" value={<span data-cd="d">–</span>} /><Stat label="hours" value={<span data-cd="h">–</span>} /><Stat label="min" value={<span data-cd="m">–</span>} /><Stat label="sec" value={<span data-cd="s">–</span>} />
            <p data-cd-live hidden={start > now ? true : undefined}><strong>Doors are open. Have fun!</strong></p>
          </div>
          <p class="small intranet-countdown-when"><Time d={start} tz={s.timezone} /> ({s.timezone})</p>
        </div>) : null;
      const order = sections.filter((x) => x in blocks);
      // Full-width sections span the page; runs of consecutive small cards are grouped into a
      // wrapping row so a short last line stretches to fill the width instead of leaving a hole.
      const WIDE = new Set(['announcements', 'servers', 'info']);
      const rendered: Child[] = [];
      let run: Child[] = [];
      const flush = () => { if (run.length) rendered.push(<div class="intranet-row">{run}</div>); run = []; };
      for (const k of order) {
        try {
          const n = await blocks[k]();
          if (!n) continue;
          if (WIDE.has(k)) { flush(); rendered.push(n); } else run.push(n);
        } catch (e) { ctx.log.error('intranet section failed', { section: k, error: String(e) }); }
      }
      flush();
      return ctx.render(c, s.title, (
        <div data-intranet data-refresh={s.refreshSeconds}>
          <header class="intranet-hero"><div class="intranet-hero-text"><h1>{s.title}</h1>{s.tagline ? <p>{s.tagline}</p> : null}</div>{countdown}</header>
          {rendered.length || countdown ? <div class="intranet-grid">{rendered}</div> : <EmptyState title="Nothing to show yet.">{await page.viewer.can(manage) ? <p><a href="/admin/m/lan-intranet/manage">Add announcements, servers and a schedule</a>.</p> : null}</EmptyState>}
          <script src="/modules/lan-intranet/intranet.js" defer></script>
        </div>
      ), { crumbs: [{ label: s.title }] });
    });

    // ── organiser admin ──
    ctx.adminRoutes.get('/manage', async (c) => {
      await c.get('viewer').require(manage);
      const page = c.get('page');
      const tz = tzOf(page);
      const anns = await db().select().from(announcements).orderBy(desc(announcements.createdAt));
      const srv = await db().select().from(servers).orderBy(asc(servers.displayOrder), asc(servers.id));
      const sched = await db().select().from(schedule).orderBy(asc(schedule.startsAt));
      return ctx.renderAdmin(c, 'LAN intranet', manage, (
        <>
          <p><a href="/m/lan-intranet">View the intranet page</a> · <a href="/admin/modules?open=lan-intranet#module-lan-intranet">Page settings (title, sections, countdown, Wi-Fi, audience)</a></p>
          <Box title="Announcements">
            {anns.map((a) => <div class="admin-forum"><strong>{a.title}</strong> <span class="tag">{LEVELS[a.level as keyof typeof LEVELS]}</span>{a.pinned ? <span class="tag">pinned</span> : null} <span class="muted small"><Time d={a.createdAt} tz={tz} mode="ago" /></span>
              <ActionButton ctx={page} action={`/admin/m/lan-intranet/announcements/${a.id}/delete`} label="Delete" className="btn btn-small" confirm="Delete this announcement?" /></div>)}
            <form method="post" action="/admin/m/lan-intranet/announcements" class="form-grid"><Csrf ctx={page} />
              <div class="field-row"><Field label="Title" name="title" required maxlength={140} /><Select label="Level" name="level" value="info" options={Object.entries(LEVELS)} /><Checkbox label="Pin to top" name="pinned" /></div>
              <TextArea label="Message (BBCode)" name="body" rows={3} maxlength={5000} />
              <div class="field-row"><Field label={`Show from (${tz}, optional)`} name="startsAt" type="datetime-local" /><Field label={`Hide after (${tz}, optional)`} name="endsAt" type="datetime-local" /></div>
              <button class="btn btn-primary btn-small">Post announcement</button></form>
          </Box>
          <Box title="Game servers">
            <Notice type="info">Status checks run from this server every refresh interval. Only list hosts you control (usually LAN addresses).</Notice>
            {srv.map((x) => { const st = status.get(x.id); return (
              <form method="post" action={`/admin/m/lan-intranet/servers/${x.id}`} class="inline-form admin-forum"><Csrf ctx={page} />
                <input name="name" value={x.name} aria-label="Name" required maxlength={80} /><input name="game" value={x.game} aria-label="Game" maxlength={80} />
                <input name="host" value={x.host} aria-label="Host" maxlength={253} placeholder="10.0.0.20" /><input name="port" type="number" value={String(x.port || '')} aria-label="Port" class="input-narrow" min={0} max={65535} />
                <select name="kind" aria-label="Status check">{Object.entries(KINDS).map(([k, l]) => <option value={k} selected={k === x.kind}>{l}</option>)}</select>
                <input name="connect" value={x.connect} aria-label="Connect string" placeholder="connect 10.0.0.20:27015" maxlength={200} />
                <input name="notes" value={x.notes} aria-label="Notes" maxlength={300} placeholder="notes" />
                <input name="displayOrder" type="number" value={String(x.displayOrder)} aria-label="Order" class="input-narrow" />
                <label><input type="checkbox" name="enabled" value="1" checked={x.enabled} /> shown</label>
                <button class="btn btn-small">Save</button> <span class="small muted">{statusLabel(st)}</span>
              </form>); })}
            {srv.length ? <ActionButton ctx={page} action="/admin/m/lan-intranet/servers/check" label="Check all now" className="btn btn-small" /> : null}
            <form method="post" action="/admin/m/lan-intranet/servers" class="inline-form"><Csrf ctx={page} />
              <input name="name" placeholder="Server name" required maxlength={80} aria-label="New server name" /><input name="game" placeholder="Game" maxlength={80} aria-label="Game" />
              <input name="host" placeholder="Host" maxlength={253} aria-label="Host" /><input name="port" type="number" placeholder="Port" class="input-narrow" min={0} max={65535} aria-label="Port" />
              <select name="kind" aria-label="Status check">{Object.entries(KINDS).map(([k, l]) => <option value={k}>{l}</option>)}</select>
              <button class="btn btn-small btn-primary">Add server</button></form>
          </Box>
          <Box title="Schedule">
            {sched.map((e) => <div class="admin-forum"><Time d={e.startsAt} tz={tz} /> — <strong>{e.title}</strong>{e.location ? ` (${e.location})` : ''} <ActionButton ctx={page} action={`/admin/m/lan-intranet/schedule/${e.id}/delete`} label="Delete" className="btn btn-small" /></div>)}
            <form method="post" action="/admin/m/lan-intranet/schedule" class="form-grid"><Csrf ctx={page} />
              <div class="field-row"><Field label="What" name="title" required maxlength={140} /><Field label="Where" name="location" maxlength={120} /></div>
              <div class="field-row"><Field label={`Starts (${tz})`} name="startsAt" type="datetime-local" required /><Field label={`Ends (${tz}, optional)`} name="endsAt" type="datetime-local" /></div>
              <button class="btn btn-small btn-primary">Add to schedule</button></form>
          </Box>
        </>
      ));
    });

    const admin = async (c: RequestContext) => { const v = c.get('viewer'); await v.require(manage); return { v, tz: tzOf(c.get('page')), b: await form(c) }; };
    const back = (c: RequestContext) => c.redirect('/admin/m/lan-intranet/manage');
    const local = (b: Record<string, unknown>, k: string, tz: string) => (str(b[k]) ? parseLocalDateTime(str(b[k]), tz) : null);
    const serverValues = (b: Record<string, unknown>) => {
      const port = int(b.port);
      if (port < 0 || port > 65535) throw new ServiceError('Port must be 0–65535.');
      const host = cleanLine(b.host, 253);
      if (host && !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) throw new ServiceError('Host must be a hostname or IP address.');
      const kind = (str(b.kind) in KINDS ? str(b.kind) : 'tcp') as ProbeKind;
      return { name: cleanLine(b.name, 80) || 'Server', game: cleanLine(b.game, 80), host, port, kind, connect: cleanLine(b.connect, 200), notes: cleanLine(b.notes, 300) };
    };

    ctx.adminRoutes.post('/announcements', async (c) => {
      const { v, tz, b } = await admin(c);
      const title = cleanLine(b.title, 140);
      if (!title) { setFlash(c, { type: 'error', text: 'Give the announcement a title.' }); return back(c); }
      await db().insert(announcements).values({ title, body: cleanText(b.body, 5000), level: str(b.level) in LEVELS ? str(b.level) : 'info', pinned: bool(b.pinned), startsAt: local(b, 'startsAt', tz), endsAt: local(b, 'endsAt', tz), createdBy: v.user!.id });
      await services.audit(v.user!.id, 'lan-intranet.announce', {}, { title }, v.ip);
      return back(c);
    });
    ctx.adminRoutes.post('/announcements/:id/delete', async (c) => { const { v } = await admin(c); await db().delete(announcements).where(eq(announcements.id, int(c.req.param('id')))); await services.audit(v.user!.id, 'lan-intranet.announcement.delete', {}, {}, v.ip); return back(c); });
    ctx.adminRoutes.post('/servers', async (c) => {
      const { v, b } = await admin(c);
      try { await db().insert(servers).values({ ...serverValues(b), displayOrder: 99 }); await services.audit(v.user!.id, 'lan-intranet.server.add', {}, { name: str(b.name) }, v.ip); }
      catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
      void pollServers().catch(() => {});
      return back(c);
    });
    ctx.adminRoutes.post('/servers/check', async (c) => { await admin(c); await pollServers(); setFlash(c, { type: 'ok', text: 'Server status refreshed.' }); return back(c); });
    ctx.adminRoutes.post('/servers/:id', async (c) => {
      const { v, b } = await admin(c);
      try { await db().update(servers).set({ ...serverValues(b), displayOrder: int(b.displayOrder), enabled: bool(b.enabled) }).where(eq(servers.id, int(c.req.param('id')))); await services.audit(v.user!.id, 'lan-intranet.server.update', {}, { id: int(c.req.param('id')) }, v.ip); }
      catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
      void pollServers().catch(() => {});
      return back(c);
    });
    ctx.adminRoutes.post('/schedule', async (c) => {
      const { v, tz, b } = await admin(c);
      const startsAt = local(b, 'startsAt', tz);
      if (!startsAt || !cleanLine(b.title, 140)) { setFlash(c, { type: 'error', text: 'Give the slot a title and start time.' }); return back(c); }
      await db().insert(schedule).values({ title: cleanLine(b.title, 140), startsAt, endsAt: local(b, 'endsAt', tz), location: cleanLine(b.location, 120) });
      await services.audit(v.user!.id, 'lan-intranet.schedule.add', {}, {}, v.ip);
      return back(c);
    });
    ctx.adminRoutes.post('/schedule/:id/delete', async (c) => { await admin(c); await db().delete(schedule).where(eq(schedule.id, int(c.req.param('id')))); return back(c); });
    void sql; void toLocalInput;
  },
});
