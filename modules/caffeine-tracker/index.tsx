/** @jsxImportSource hono/jsx */
import {
  defineModule, z, Box, Csrf, Notice, ActionButton, Field, Checkbox, Time, EmptyState,
  form, str, int, bool, setFlash, cleanLine, parseLocalDateTime, services, ServiceError, database, eq,
  type ModuleContext, type RequestContext, type PageCtx,
} from '../../src/sdk/index.ts';
import { LEVELS, levelFor, mgAt, type Level, type ModelOptions } from './model.ts';
import {
  drinks, CATEGORIES, LIMITS, seedDrinks, listDrinks, logDrink, deleteLog, currentFor, leaderboard, topDrinks, isHidden, setHidden, forgetUser, logs,
  type BoardKind, type BoardRow, type Drink,
} from './service.ts';

const settingsSchema = z.object({
  halfLifeHours: z.number().min(2).max(10),
  absorptionMinutes: z.number().int().min(0).max(120),
  eventStart: z.string().regex(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?$/, 'use YYYY-MM-DDTHH:MM'),
  timezone: z.string().min(1).max(64),
  boardSize: z.number().int().min(3).max(50),
});
type Settings = z.infer<typeof settingsSchema>;

const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';
const fmtMg = (mg: number) => `${Math.round(mg)} mg`;
const AGO: [string, string][] = [['0', 'Just now'], ['15', '15 minutes ago'], ['30', '30 minutes ago'], ['60', '1 hour ago'], ['120', '2 hours ago'], ['180', '3 hours ago'], ['300', '5 hours ago'], ['480', '8 hours ago'], ['720', '12 hours ago']];

function LevelBadge({ level }: { level: Level }) {
  return <span class={`caf-level caf-${level.tone}`}>{level.name}</span>;
}

/** Inline SVG: last 12 h + 6 h forecast. Presentation only via attributes/classes (CSP-safe). */
function Chart({ doses, o, now }: { doses: { mg: number; at: Date }[]; o: ModelOptions; now: Date }) {
  const W = 600, H = 180, PAD = 28, past = 12, future = 6, step = 10 * 60_000;
  const t0 = now.getTime() - past * 3600_000, t1 = now.getTime() + future * 3600_000;
  const samples: [number, number][] = [];
  for (let t = t0; t <= t1; t += step) samples.push([t, mgAt(doses, new Date(t), o)]);
  const peak = Math.max(450, ...samples.map(([, m]) => m)) * 1.1;
  const x = (t: number) => PAD + ((t - t0) / (t1 - t0)) * (W - PAD * 2);
  const y = (m: number) => H - PAD - (m / peak) * (H - PAD * 2);
  const pts = (list: [number, number][]) => list.map(([t, m]) => `${x(t).toFixed(1)},${y(m).toFixed(1)}`).join(' ');
  const pastPts = samples.filter(([t]) => t <= now.getTime());
  const futPts = samples.filter(([t]) => t >= now.getTime() - step);
  const ticks = [0, 200, 400, 600, 800].filter((m) => m < peak);
  const nowMg = mgAt(doses, now, o);
  const in6 = mgAt(doses, new Date(t1), o);
  return (
    <svg class="caf-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Estimated caffeine over the last ${past} hours: now ${fmtMg(nowMg)}, about ${fmtMg(in6)} in ${future} hours.`}>
      {ticks.map((m) => <g><line class={m === 400 ? 'caf-limit' : 'caf-grid'} x1={PAD} x2={W - PAD} y1={y(m)} y2={y(m)} /><text x={2} y={y(m) + 3}>{m}</text></g>)}
      <line class="caf-now" x1={x(now.getTime())} x2={x(now.getTime())} y1={PAD / 2} y2={H - PAD} />
      <text x={x(now.getTime()) + 4} y={PAD / 2 + 8}>now</text>
      <text x={PAD} y={H - 8}>−12 h</text><text x={W - PAD - 26} y={H - 8}>+6 h</text>
      <polyline class="caf-line" points={pts(pastPts)} />
      <polyline class="caf-future" points={pts(futPts)} />
    </svg>
  );
}

function Board({ title, rows, kind, me }: { title: string; rows: BoardRow[]; kind: BoardKind; me?: number }) {
  return (
    <Box title={title}>
      {rows.length ? (
        <div class="table-wrap"><table class="data-table"><thead><tr><th class="caf-rank">#</th><th>Member</th><th>{kind === 'now' ? 'In system' : 'Total'}</th>{kind === 'now' ? <th>Level</th> : <th>Drinks</th>}</tr></thead><tbody>
          {rows.map((r, i) => (
            <tr class={r.userId === me ? 'row-highlight' : ''}><td class="caf-rank">{i + 1}</td><td><a href={`/u/${encodeURIComponent(r.username)}`}>{r.username}</a></td><td>{fmtMg(r.mg)}</td>
              {kind === 'now' ? <td><LevelBadge level={r.level} /></td> : <td>{r.drinks}</td>}</tr>))}
        </tbody></table></div>
      ) : <p class="muted">No drinks logged yet.</p>}
    </Box>
  );
}

function DrinkSelect({ list }: { list: Drink[] }) {
  const groups = new Map<string, Drink[]>();
  for (const d of list) { const g = groups.get(d.category) ?? []; g.push(d); groups.set(d.category, g); }
  return (
    <div class="field"><label for="f-drink">Drink</label>
      <select id="f-drink" name="drink" required>
        {[...groups.entries()].map(([cat, ds]) => <optgroup label={CATEGORIES[cat] ?? cat}>{ds.map((d) => <option value={String(d.id)}>{d.name} — {Math.round(d.caffeineMg)} mg{d.servingMl ? ` / ${d.servingMl} ml` : ''}</option>)}</optgroup>)}
        <option value="custom">Something else (enter the caffeine from the label)…</option>
      </select>
    </div>
  );
}

export default defineModule({
  id: 'caffeine-tracker',
  name: 'Caffeine tracker',
  version: '1.1.0',
  description: 'A playful LAN-party caffeine leaderboard. Members log drinks from a catalogue of typical caffeine amounts; levels decay with a realistic half-life, from "Decaf Ghost" to "GO TO HOSPITAL". Just for fun — not medical advice.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.2.0',
  enabledByDefault: false,
  migrations: 'migrations',
  assets: 'public',
  styles: ['caffeine.css'],
  permissions: {
    view: { label: 'See caffeine leaderboards', grantTo: ['guest', 'member'] },
    log: { label: 'Log caffeinated drinks', grantTo: ['member'] },
    manage: { label: 'Edit the drinks catalogue' },
  },
  settings: {
    schema: settingsSchema,
    defaults: { halfLifeHours: 5, absorptionMinutes: 30, eventStart: '', timezone: 'UTC', boardSize: 10 },
    fields: [
      { key: 'halfLifeHours', label: 'Caffeine half-life (hours)', type: 'number', min: 2, max: 10, hint: 'Typically 3–7 h for healthy adults; 5 h is a common average.' },
      { key: 'absorptionMinutes', label: 'Absorption time (minutes)', type: 'number', min: 0, max: 120, hint: 'Peak blood levels usually arrive 30–60 minutes after a drink.' },
      { key: 'eventStart', label: 'Event start for the "whole event" board, YYYY-MM-DDTHH:MM', type: 'string', maxLength: 16, hint: 'Leave empty to count everything ever logged.' },
      { key: 'timezone', label: 'Timezone of the event start (e.g. Europe/London)', type: 'string', maxLength: 64 },
      { key: 'boardSize', label: 'Leaderboard length', type: 'number', min: 3, max: 50 },
    ],
  },

  async onInstall() { await seedDrinks(); },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), log: ctx.perm('log'), manage: ctx.perm('manage') };
    const cfg = async () => {
      const s = await ctx.settings.get<Settings>();
      let since: Date | null = null;
      if (s.eventStart) { try { since = parseLocalDateTime(s.eventStart, s.timezone); } catch { since = null; } }
      return { s, o: { halfLifeHours: s.halfLifeHours, absorptionMinutes: s.absorptionMinutes } as ModelOptions, since };
    };

    ctx.expose({
      /** For other modules (e.g. lan-intranet): top members by caffeine. */
      async leaderboard(kind: BoardKind = 'now', limit = 5) {
        const { o, since } = await cfg();
        return (await leaderboard(kind, limit, o, { since })).map((r) => ({ username: r.username, mg: r.mg, level: r.level.name, tone: r.level.tone }));
      },
    });

    ctx.register.navItem({ href: '/m/caffeine-tracker', label: 'Caffeine', icon: 'cup', area: 'main', order: 66, visible: (v) => v.can(P.view) });
    ctx.register.adminSection({ slug: 'drinks', label: 'Caffeine drinks', permission: P.manage });
    ctx.hooks.on('user.closed', async ({ userId }) => { await forgetUser(userId); });
    ctx.register.personalData({
      id: 'caffeine-tracker', label: 'Caffeine tracker',
      export: async (userId) => ({
        hiddenFromLeaderboards: await isHidden(userId),
        drinks: await database.db().select({ drink: logs.drinkName, servings: logs.servings, mg: logs.mg, consumed: logs.consumedAt }).from(logs).where(eq(logs.userId, userId)),
      }),
      erase: (userId) => forgetUser(userId),
    });

    ctx.register.profileSection({
      id: 'caffeine', column: 'side', order: 45,
      async render({ user, viewer }) {
        if (!(await viewer.can(P.view)) || (await isHidden(user.id))) return null;
        const { o } = await cfg();
        const cur = await currentFor(user.id, o);
        if (!cur.rows.length) return null;
        return <Box title="Caffeine" headingLevel={3}><p><strong>{fmtMg(cur.mg)}</strong> in system</p><p><LevelBadge level={cur.level} /></p><p class="small"><a href="/m/caffeine-tracker">Leaderboard</a></p></Box>;
      },
    });

    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer'); await v.require(P.view);
      const page = c.get('page');
      const { s, o, since } = await cfg();
      const now = new Date();
      const canLog = v.user ? await v.can(P.log) : false;
      const me = v.user ? await currentFor(v.user.id, o, now) : null;
      const hidden = v.user ? await isHidden(v.user.id) : false;
      const [boardNow, boardDay, boardEvent, popular, list] = await Promise.all([
        leaderboard('now', s.boardSize, o, { now }), leaderboard('day', s.boardSize, o, { now }), leaderboard('event', s.boardSize, o, { since, now }),
        topDrinks(since ?? new Date(now.getTime() - 24 * 3600_000)), canLog ? listDrinks() : Promise.resolve([] as Drink[]),
      ]);
      const tz = tzOf(page);
      return ctx.render(c, 'Caffeine tracker', (
        <>
          <h1 class="page-title">Caffeine tracker</h1>
          <p class="page-desc">Who is fuelling the LAN? Levels are estimates using a {s.halfLifeHours}-hour half-life. Just for fun — not medical advice.</p>
          {me ? (
            <Box title="You">
              <div class="caf-me">
                <div><div class="caf-big">{fmtMg(me.mg)}</div><div class="muted small">estimated in your system</div></div>
                <div><LevelBadge level={me.level} /><p class="small">{me.level.quip}</p></div>
              </div>
              {me.level.tone === 'critical' || me.level.tone === 'danger' ? <Notice type="error">Most adults should stay under about 400 mg a day. If you feel unwell — racing heart, shaking, chest pain, nausea — stop and get help. Drink some water!</Notice> : null}
              {me.rows.length ? <Chart doses={me.doses} o={o} now={now} /> : null}
              {canLog ? (
                <form method="post" action="/m/caffeine-tracker/log" class="form-grid"><Csrf ctx={page} />
                  <DrinkSelect list={list} />
                  <div class="field-row">
                    <Field label="Servings" name="servings" type="number" value="1" attrs={{ min: '0.5', max: String(LIMITS.maxServings), step: '0.5' }} />
                    <div class="field"><label for="f-ago">When</label><select id="f-ago" name="ago">{AGO.map(([val, l]) => <option value={val}>{l}</option>)}</select></div>
                  </div>
                  <details><summary>Something else?</summary>
                    <div class="field-row">
                      <Field label="Drink name" name="customName" maxlength={80} />
                      <Field label="Caffeine per serving (mg)" name="customMg" type="number" attrs={{ min: '1', max: String(LIMITS.maxCustomMg) }} hint="From the can or the maker's website." />
                    </div>
                  </details>
                  <div class="form-actions"><button class="btn btn-primary">Log drink</button></div>
                </form>
              ) : <p class="muted">You can't log drinks.</p>}
              {me.rows.length ? (
                <details><summary>Your last 48 hours ({me.rows.length})</summary>
                  <table class="data-table"><thead><tr><th>Drink</th><th>Caffeine</th><th>When</th><th /></tr></thead><tbody>
                    {me.rows.map((r) => <tr><td>{r.servings !== 1 ? `${r.servings} × ` : ''}{r.drinkName}</td><td>{fmtMg(r.mg)}</td><td><Time d={r.consumedAt} tz={tz} mode="ago" /></td>
                      <td><ActionButton ctx={page} action={`/m/caffeine-tracker/log/${r.id}/delete`} label="Remove" className="btn btn-small" /></td></tr>)}
                  </tbody></table>
                </details>
              ) : null}
              <form method="post" action="/m/caffeine-tracker/prefs" class="inline-form caf-prefs"><Csrf ctx={page} />
                <Checkbox label="Hide me from leaderboards and my profile" name="hidden" checked={hidden} />
                <button class="btn btn-small">Save</button>
              </form>
            </Box>
          ) : <Notice type="info"><a href="/login?returnTo=/m/caffeine-tracker">Sign in</a> to log your drinks and join the leaderboard.</Notice>}
          <div class="caf-boards">
            <Board title="Most caffeinated right now" rows={boardNow} kind="now" me={v.user?.id} />
            <Board title="Last 24 hours" rows={boardDay} kind="day" me={v.user?.id} />
            <Board title={since ? 'Whole event' : 'All time'} rows={boardEvent} kind="event" me={v.user?.id} />
            <Box title="Drink of choice">{popular.length ? <ol class="plain-list">{popular.map((d) => <li>{d.name} <span class="muted small">· {d.n}× · {fmtMg(d.mg)}</span></li>)}</ol> : <p class="muted">Nothing yet.</p>}</Box>
          </div>
          <Box title="Levels">
            <div class="table-wrap"><table class="data-table caf-levels"><thead><tr><th>From</th><th>Level</th><th>What it means</th></tr></thead><tbody>
              {LEVELS.map((l) => <tr><td>{l.min} mg</td><td><LevelBadge level={l} /></td><td>{l.quip}</td></tr>)}
            </tbody></table></div>
            <p class="small muted">Caffeine amounts are typical values from labels and published tables; real drinks vary by brand, size and region. Sensitivity varies a lot between people, and pregnancy, medication and some health conditions change the safe amount. This is a game, not health advice.</p>
          </Box>
        </>
      ), { crumbs: [{ label: 'Caffeine tracker' }] });
    });

    const back = (c: RequestContext) => c.redirect('/m/caffeine-tracker');
    ctx.routes.post('/log', async (c) => {
      const v = c.get('viewer'); await v.require(P.log);
      const b = await form(c);
      const raw = str(b.drink);
      try {
        const row = await logDrink(v.user!.id, {
          drinkId: raw === 'custom' ? 'custom' : int(raw), servings: Number(str(b.servings) || '1'), minutesAgo: int(b.ago),
          customName: cleanLine(b.customName, 80), customMg: Number(str(b.customMg)),
        });
        const { o } = await cfg();
        // level an hour from now, once this drink has been absorbed
        const soon = new Date(Date.now() + 3600_000);
        const lvl = levelFor(mgAt((await currentFor(v.user!.id, o, soon)).doses, soon, o));
        setFlash(c, { type: 'ok', text: `Logged ${row.drinkName} (${fmtMg(row.mg)}).${lvl.tone === 'critical' ? ' Maybe switch to water for a while?' : ''}` });
      } catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return back(c);
    });
    ctx.routes.post('/log/:id/delete', async (c) => {
      const v = c.get('viewer'); await v.require(P.log);
      try { await deleteLog(v.user!.id, int(c.req.param('id'))); setFlash(c, { type: 'ok', text: 'Entry removed.' }); }
      catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return back(c);
    });
    ctx.routes.post('/prefs', async (c) => {
      const v = c.get('viewer'); if (!v.user) throw new ServiceError('Sign in first.', 401);
      await setHidden(v.user.id, bool((await form(c)).hidden));
      setFlash(c, { type: 'ok', text: 'Saved.' });
      return back(c);
    });

    // ── admin: drinks catalogue ──
    const db = () => database.db();
    ctx.adminRoutes.get('/drinks', async (c) => {
      await c.get('viewer').require(P.manage);
      const page = c.get('page');
      const list = await listDrinks(true);
      const catOpts = Object.entries(CATEGORIES);
      return ctx.renderAdmin(c, 'Caffeine drinks', P.manage, (
        <>
          <Box title="Add a drink">
            <form method="post" action="/admin/m/caffeine-tracker/drinks/new" class="form-grid"><Csrf ctx={page} />
              <div class="field-row">
                <Field label="Name" name="name" required maxlength={80} />
                <div class="field"><label for="f-category">Category</label><select id="f-category" name="category">{catOpts.map(([k, l]) => <option value={k}>{l}</option>)}</select></div>
                <Field label="Serving (ml, optional)" name="servingMl" type="number" attrs={{ min: '1', max: '2000' }} />
                <Field label="Caffeine per serving (mg)" name="caffeineMg" type="number" required attrs={{ min: '0', max: '1000', step: '0.1' }} />
              </div>
              <div class="form-actions"><button class="btn btn-primary btn-small">Add drink</button></div>
            </form>
          </Box>
          <Box title={`Catalogue (${list.length})`}>
            {list.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th>Drink</th><th>Category</th><th>Serving</th><th>Caffeine</th><th>Status</th><th /></tr></thead><tbody>
              {list.map((d) => (
                <tr><td>{d.name}</td><td>{CATEGORIES[d.category] ?? d.category}</td><td>{d.servingMl ? `${d.servingMl} ml` : '—'}</td>
                  <td><form method="post" action={`/admin/m/caffeine-tracker/drinks/${d.id}`} class="inline-form"><Csrf ctx={page} />
                    <label class="sr-only" for={`mg-${d.id}`}>Caffeine for {d.name} (mg)</label>
                    <input id={`mg-${d.id}`} name="caffeineMg" type="number" min="0" max="1000" step="0.1" value={String(d.caffeineMg)} class="input-narrow" />
                    <button class="btn btn-small">Save</button></form></td>
                  <td>{d.enabled ? <span class="tag tag-ok">Shown</span> : <span class="tag tag-held">Hidden</span>}</td>
                  <td><ActionButton ctx={page} action={`/admin/m/caffeine-tracker/drinks/${d.id}/toggle`} label={d.enabled ? 'Hide' : 'Show'} className="btn btn-small" /></td></tr>))}
            </tbody></table></div> : <EmptyState title="The catalogue is empty."><ActionButton ctx={page} action="/admin/m/caffeine-tracker/drinks/seed" label="Load the default drinks" className="btn btn-primary" /></EmptyState>}
          </Box>
        </>
      ));
    });
    const mgOf = (x: unknown) => { const n = Number(str(x)); if (!(n >= 0 && n <= 1000)) throw new ServiceError('Caffeine must be between 0 and 1000 mg.'); return Math.round(n * 10) / 10; };
    const adminAction = (path: string, fn: (c: RequestContext, b: Record<string, unknown>) => Promise<string>) =>
      ctx.adminRoutes.post(path, async (c) => {
        const v = c.get('viewer'); await v.require(P.manage);
        try { const msg = await fn(c, await form(c)); await services.audit(v.user!.id, `caffeine-tracker.${path.split('/').pop()}`, { type: 'caffeine_drink' }, { path: c.req.path }, v.ip); setFlash(c, { type: 'ok', text: msg }); }
        catch (err) { if (err instanceof ServiceError) setFlash(c, { type: 'error', text: err.message }); else if (String((err as any)?.cause?.message ?? err).includes('mod_caffeine_drinks_name_uq')) setFlash(c, { type: 'error', text: 'A drink with that name already exists.' }); else throw err; }
        return c.redirect('/admin/m/caffeine-tracker/drinks');
      });
    adminAction('/drinks/new', async (_c, b) => {
      const name = cleanLine(b.name, 80);
      if (name.length < 2) throw new ServiceError('Give the drink a name.');
      const category = str(b.category) in CATEGORIES ? str(b.category) : 'other';
      const ml = int(b.servingMl);
      await db().insert(drinks).values({ name, category, servingMl: ml > 0 && ml <= 2000 ? ml : null, caffeineMg: mgOf(b.caffeineMg), displayOrder: 1000 });
      return `Added ${name}.`;
    });
    adminAction('/drinks/seed', async () => `Loaded ${await seedDrinks()} drinks.`);
    adminAction('/drinks/:id', async (c, b) => { await db().update(drinks).set({ caffeineMg: mgOf(b.caffeineMg) }).where(eq(drinks.id, int(c.req.param('id')))); return 'Saved.'; });
    adminAction('/drinks/:id/toggle', async (c) => {
      const [d] = await db().select().from(drinks).where(eq(drinks.id, int(c.req.param('id'))));
      if (!d) throw new ServiceError('Drink not found.', 404);
      await db().update(drinks).set({ enabled: !d.enabled }).where(eq(drinks.id, d.id));
      return `${d.name} is now ${d.enabled ? 'hidden' : 'shown'}.`;
    });
  },
});
