/** @jsxImportSource hono/jsx */
import {
  defineModule, z, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Time, Stat, EmptyState, UserLink,
  form, str, int, bool, setFlash, cleanLine, cleanText, parseLocalDateTime, toLocalInput, services, ServiceError, database, eq,
  type ModuleContext, type RequestContext, type PageCtx, type Viewer,
} from '../../src/sdk/index.ts';
import {
  rounds, menu, STATUSES, CATEGORIES, LIMITS, seedMenu, listMenu, listRounds, roundById, closedReason, parseMoney, formatMoney,
  orderOf, placeOrder, statusLabel, isTakingOrders, cancelOrder, ordersFor, kitchenSummary, moneySummary, setPaid, setHandedOut, removeOrder, currentSummary, forgetUser, orders, items,
  type Round, type MenuItem, type Status,
} from './service.ts';

const settingsSchema = z.object({
  currency: z.string().min(1).max(4),
  paymentInstructions: z.string().max(1000),
});
type Settings = z.infer<typeof settingsSchema>;

const db = () => database.db();
const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';

function DietTags({ m }: { m: MenuItem }) {
  return m.vegan ? <span class="tag tag-ok pz-diet">Vegan</span> : m.vegetarian ? <span class="tag pz-diet">Vegetarian</span> : null;
}

export default defineModule({
  id: 'lan-pizza',
  name: 'LAN party pizza orders',
  version: '1.1.0',
  description: 'Collect food orders for a group pizza run. Members choose from a menu; organisers collect cash in person, tick off payments, phone the order in from an automatic shopping list and announce when the food arrives. No payment or delivery services are connected.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.2.0',
  enabledByDefault: false,
  migrations: 'migrations',
  assets: 'public',
  styles: ['pizza.css'],
  permissions: {
    view: { label: 'See pizza runs and the menu', grantTo: ['guest', 'member'] },
    order: { label: 'Order food in pizza runs', grantTo: ['member'] },
    handle: { label: 'Take cash payments and hand out food' },
    manage: { label: 'Run pizza runs and edit the menu' },
  },
  notificationKinds: { 'lan-pizza': 'Pizza runs: payment recorded, food has arrived' },
  settings: {
    schema: settingsSchema,
    defaults: { currency: '£', paymentInstructions: 'Pay cash to an organiser at the front desk. Exact change helps!' },
    fields: [
      { key: 'currency', label: 'Currency symbol', type: 'string', maxLength: 4 },
      { key: 'paymentInstructions', label: 'How to pay (shown to everyone with an unpaid order)', type: 'text', maxLength: 1000 },
    ],
  },

  async onInstall() { await seedMenu(); },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), order: ctx.perm('order'), handle: ctx.perm('handle'), manage: ctx.perm('manage') };
    const cfg = () => ctx.settings.get<Settings>();
    const money = (cents: number, s: Settings) => formatMoney(cents, s.currency);
    const canHandle = async (v: Viewer) => (await v.can(P.handle)) || (await v.can(P.manage));
    const requireHandle = async (v: Viewer) => { if (!(await canHandle(v))) await v.require(P.handle); };

    ctx.expose({ currentSummary });
    ctx.register.navItem({ href: '/m/lan-pizza', label: 'Pizza', icon: 'pizza', area: 'main', order: 67, visible: (v) => v.can(P.view) });
    ctx.register.adminSection({ slug: 'runs', label: 'Pizza runs', permission: P.handle });
    ctx.hooks.on('user.closed', async ({ userId }) => { await forgetUser(userId); });
    ctx.register.personalData({
      id: 'lan-pizza', label: 'Pizza orders',
      async export(userId) {
        const list = await db().select({ o: orders, run: rounds.name }).from(orders).innerJoin(rounds, eq(rounds.id, orders.roundId)).where(eq(orders.userId, userId));
        return Promise.all(list.map(async ({ o, run }) => ({
          run, totalCents: o.totalCents, paid: o.paid, paidAt: o.paidAt, handedOut: o.handedOut, notes: o.notes, placed: o.createdAt,
          items: (await db().select({ name: items.name, qty: items.qty, priceCents: items.priceCents }).from(items).where(eq(items.orderId, o.id))),
        })));
      },
      // paid orders are the organisers' cash record, so only unpaid ones go
      erase: (userId) => forgetUser(userId),
    });

    // ── member pages ──
    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer'); await v.require(P.view);
      const page = c.get('page');
      const s = await cfg();
      const organiser = await canHandle(v);
      const all = await listRounds(organiser);
      const active = all.filter((r) => r.status !== 'delivered');
      const past = all.filter((r) => r.status === 'delivered').slice(0, 5);
      const canOrder = v.user ? await v.can(P.order) : false;
      const menuItems = await listMenu();
      const tz = tzOf(page);

      const RoundBox = async ({ r }: { r: Round }) => {
        const mine = v.user ? await orderOf(r.id, v.user.id) : null;
        const closed = closedReason(r);
        const qty = new Map((mine?.items ?? []).map((i) => [i.menuId, i.qty]));
        const byCat = Object.keys(CATEGORIES).map((k) => [k, menuItems.filter((m) => m.category === k)] as const).filter(([, l]) => l.length);
        return (
          <Box title={r.name}>
            <p class="pz-meta"><span class={`tag ${isTakingOrders(r) ? 'tag-ok' : ''}`}>{statusLabel(r)}</span>
              {r.closesAt && isTakingOrders(r) ? <span>Orders close <Time d={r.closesAt} tz={tz} /></span> : null}</p>
            {r.notes ? <p>{r.notes}</p> : null}
            {mine ? (
              <div class={`pz-mine ${mine.paid ? 'is-paid' : 'is-unpaid'}`}>
                <h3>Your order · {money(mine.totalCents, s)} {mine.paid ? <span class="tag tag-ok">Paid</span> : <span class="tag tag-held">Not paid yet</span>}{mine.handedOut ? <span class="tag">Collected</span> : null}</h3>
                <ul class="plain-list">{mine.items.map((i) => <li>{i.qty} × {i.name} <span class="muted small">({money(i.priceCents * i.qty, s)})</span></li>)}</ul>
                {mine.notes ? <p class="small">Note: {mine.notes}</p> : null}
                {!mine.paid ? <Notice type="warn"><strong>Bring {money(mine.totalCents, s)} in cash.</strong> {s.paymentInstructions}</Notice> : null}
                {!mine.paid && !closed ? <ActionButton ctx={page} action={`/m/lan-pizza/${r.id}/cancel`} label="Cancel my order" className="btn btn-small" confirm="Cancel your order?" /> : null}
              </div>
            ) : null}
            {!closed && canOrder && !mine?.paid ? (
              <form method="post" action={`/m/lan-pizza/${r.id}/order`} class="pz-order" data-pizza-order data-currency={s.currency}><Csrf ctx={page} />
                {byCat.map(([cat, list]) => (
                  <fieldset class="pz-cat"><legend>{CATEGORIES[cat]}</legend>
                    <table class="data-table pz-menu"><tbody>
                      {list.map((m) => (
                        <tr><td><label for={`q-${r.id}-${m.id}`}><strong>{m.name}</strong></label> <DietTags m={m} />{m.description ? <div class="muted small">{m.description}</div> : null}</td>
                          <td class="pz-price">{money(m.priceCents, s)}</td>
                          <td class="pz-qty"><input id={`q-${r.id}-${m.id}`} type="number" name={`qty_${m.id}`} min="0" max={String(LIMITS.maxQtyPerItem)} value={String(qty.get(m.id) ?? 0)} data-price={String(m.priceCents)} inputmode="numeric" /></td></tr>
                      ))}
                    </tbody></table>
                  </fieldset>
                ))}
                <TextArea label="Notes for the organisers (optional)" name="notes" value={mine?.notes ?? ''} rows={2} maxlength={300} hint="Allergies, “no olives”, “cut in 8”…" />
                <div class="form-actions pz-actions"><button class="btn btn-primary">{mine ? 'Update my order' : 'Place order'}</button>
                  <span class="pz-total" aria-live="polite" data-pizza-total hidden /></div>
              </form>
            ) : closed && !mine ? <p class="muted">{closed}</p> : !v.user ? <p><a href="/login?returnTo=/m/lan-pizza">Sign in</a> to order.</p> : !canOrder ? <p class="muted">You can’t place orders.</p> : null}
          </Box>
        );
      };

      return ctx.render(c, 'Pizza', (
        <>
          <h1 class="page-title">Pizza runs</h1>
          <p class="page-desc">Order here, then pay an organiser in cash. They place the order and shout when it arrives.</p>
          {active.length ? <>{await Promise.all(active.map((r) => RoundBox({ r })))}</> : <EmptyState title="No pizza run right now.">{organiser ? <p><a href="/admin/m/lan-pizza/runs">Start one</a>.</p> : <p>Hungry? Ask an organiser.</p>}</EmptyState>}
          {past.length ? <Box title="Earlier pizza runs"><ul class="plain-list">{past.map((r) => <li>{r.name} <span class="muted small">· <Time d={r.createdAt} tz={tz} mode="date" /></span></li>)}</ul></Box> : null}
          <script src="/modules/lan-pizza/pizza.js" defer></script>
        </>
      ), { crumbs: [{ label: 'Pizza' }] });
    });

    const loadRound = async (c: RequestContext) => {
      const r = await roundById(int(c.req.param('id')));
      if (!r || r.status === 'draft') throw new ServiceError('Pizza run not found.', 404);
      return r;
    };
    ctx.routes.post('/:id/order', async (c) => {
      const v = c.get('viewer'); await v.require(P.order);
      const r = await loadRound(c);
      const b = await form(c);
      const lines = Object.entries(b).filter(([k]) => /^qty_\d+$/.test(k)).map(([k, val]) => ({ menuId: Number(k.slice(4)), qty: Number(str(val) || '0') }));
      try {
        const res = await placeOrder(r, v.user!.id, lines, cleanLine(b.notes, 300));
        setFlash(c, { type: 'ok', text: `Order saved: ${formatMoney(res.total, (await cfg()).currency)}. Now pay an organiser in cash.` });
      } catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect('/m/lan-pizza');
    });
    ctx.routes.post('/:id/cancel', async (c) => {
      const v = c.get('viewer'); await v.require(P.order);
      const r = await loadRound(c);
      try { await cancelOrder(r, v.user!.id); setFlash(c, { type: 'ok', text: 'Order cancelled.' }); }
      catch (err) { if (err instanceof ServiceError && err.status < 500) setFlash(c, { type: 'error', text: err.message }); else throw err; }
      return c.redirect('/m/lan-pizza');
    });

    // ── organiser admin ──
    const RoundForm = ({ page, r }: { page: PageCtx; r?: Round }) => (
      <form method="post" action={r ? `/admin/m/lan-pizza/runs/${r.id}/edit` : '/admin/m/lan-pizza/runs/new'} class="form-grid"><Csrf ctx={page} />
        <div class="field-row">
          <Field label="Name" name="name" value={r?.name ?? ''} required maxlength={120} placeholder="Friday dinner" />
          <Field label={`Orders close (${tzOf(page)}, optional)`} name="closesAt" type="datetime-local" value={toLocalInput(r?.closesAt, tzOf(page))} />
        </div>
        <TextArea label="Notes shown to everyone (optional)" name="notes" value={r?.notes ?? ''} rows={2} maxlength={1000} hint="Which shop, when food is expected, where to collect it…" />
        {!r ? <Checkbox label="Open for orders straight away" name="open" checked /> : null}
        <div class="form-actions"><button class="btn btn-primary btn-small">{r ? 'Save' : 'Start pizza run'}</button></div>
      </form>
    );

    ctx.adminRoutes.get('/runs', async (c) => {
      const v = c.get('viewer'); await requireHandle(v);
      const page = c.get('page');
      const manage = await v.can(P.manage);
      const list = await listRounds(true);
      return ctx.renderAdmin(c, 'Pizza runs', P.handle, (
        <>
          <Box title="Pizza runs">{list.length ? <ul class="plain-list">{list.map((r) => <li><a href={`/admin/m/lan-pizza/runs/${r.id}`}><strong>{r.name}</strong></a> <span class="muted small">· {statusLabel(r)} · <Time d={r.createdAt} tz={tzOf(page)} mode="ago" /></span></li>)}</ul> : <p class="muted">No pizza runs yet.</p>}</Box>
          {manage ? <Box title="Start a pizza run"><RoundForm page={page} /></Box> : null}
          {manage ? <p><a href="/admin/m/lan-pizza/menu">Edit the menu →</a></p> : null}
        </>
      ));
    });

    ctx.adminRoutes.post('/runs/new', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const b = await form(c);
      const name = cleanLine(b.name, 120);
      if (name.length < 2) { setFlash(c, { type: 'error', text: 'Give the pizza run a name.' }); return c.redirect('/admin/m/lan-pizza/runs'); }
      const closesAt = str(b.closesAt) ? parseLocalDateTime(str(b.closesAt), tzOf(c.get('page'))) : null;
      const [r] = await db().insert(rounds).values({ name, closesAt, notes: cleanText(b.notes, 1000), status: bool(b.open) ? 'open' : 'draft' }).returning();
      await services.audit(v.user!.id, 'lan-pizza.run.create', { type: 'pizza_run', id: r.id }, { name }, v.ip);
      return c.redirect(`/admin/m/lan-pizza/runs/${r.id}`);
    });

    const adminRound = async (c: RequestContext) => {
      const r = await roundById(int(c.req.param('id')));
      if (!r) throw new ServiceError('Pizza run not found.', 404);
      return r;
    };

    ctx.adminRoutes.get('/runs/:id', async (c) => {
      const v = c.get('viewer'); await requireHandle(v);
      const r = await adminRound(c);
      const page = c.get('page');
      const s = await cfg();
      const manage = await v.can(P.manage);
      const list = await ordersFor(r.id);
      const cards = await services.users.cards(list.map((o) => o.userId));
      const sum = moneySummary(list);
      const kitchen = kitchenSummary(list);
      const next: Partial<Record<Status, [Status, string]>> = { draft: ['open', 'Open for orders'], open: ['closed', 'Close orders'], closed: ['ordered', 'Mark as ordered'], ordered: ['delivered', 'Food has arrived — notify everyone'] };
      const step = next[r.status as Status];
      return ctx.renderAdmin(c, `Pizza run: ${r.name}`, P.handle, (
        <>
          <p><a href="/admin/m/lan-pizza/runs">← All pizza runs</a> · <a href="/m/lan-pizza">Member view</a></p>
          <Box title={r.name}>
            <p><span class="tag">{statusLabel(r)}</span> {r.closesAt ? <>· closes <Time d={r.closesAt} tz={tzOf(page)} /></> : null}</p>
            <div class="stats-row">
              <Stat label="Orders" value={String(sum.orders)} />
              <Stat label="Paid" value={`${sum.paidOrders} / ${sum.orders}`} />
              <Stat label="Cash collected" value={money(sum.collected, s)} />
              <Stat label="Still to collect" value={money(sum.outstanding, s)} />
            </div>
            {manage ? <div class="pz-steps">
              {step ? <ActionButton ctx={page} action={`/admin/m/lan-pizza/runs/${r.id}/status`} fields={{ status: step[0] }} label={step[1]} className="btn btn-primary btn-small"
                confirm={step[0] === 'delivered' ? 'Notify everyone with an order that the food is here?' : step[0] === 'closed' ? 'Stop taking orders? Members with unpaid orders get a reminder.' : undefined} /> : null}
              {r.status === 'closed' ? <ActionButton ctx={page} action={`/admin/m/lan-pizza/runs/${r.id}/status`} fields={{ status: 'open' }} label="Re-open orders" className="btn btn-small" /> : null}
            </div> : null}
            {manage ? <details><summary>Edit name, deadline and notes</summary><RoundForm page={page} r={r} /></details> : null}
          </Box>
          <Box title="Shopping list (what to order)">
            {kitchen.length ? <table class="data-table"><thead><tr><th>Item</th><th>Paid</th><th>Not paid yet</th><th>Total</th></tr></thead><tbody>
              {kitchen.map((k) => <tr><td>{k.name}</td><td><strong>{k.paid}</strong></td><td>{k.unpaid}</td><td>{k.paid + k.unpaid}</td></tr>)}
            </tbody></table> : <p class="muted">No orders yet.</p>}
            <p class="small muted">Tip: order the “Paid” column; chase or drop unpaid orders before you call the shop.</p>
          </Box>
          <Box title={`Orders (${list.length})`}>
            {list.length ? <div class="table-wrap"><table class="data-table pz-orders"><thead><tr><th>Member</th><th>Order</th><th>Total</th><th>Cash</th><th>Food</th><th /></tr></thead><tbody>
              {list.map((o) => {
                const u = cards.get(o.userId);
                return (
                  <tr class={o.paid ? '' : 'pz-unpaid'}>
                    <td>{u ? <UserLink user={u} /> : <span class="muted">Closed account</span>}</td>
                    <td>{o.items.map((i) => <div>{i.qty} × {i.name}</div>)}{o.notes ? <div class="small muted">“{o.notes}”</div> : null}</td>
                    <td><strong>{money(o.totalCents, s)}</strong></td>
                    <td>{o.paid
                      ? <><span class="tag tag-ok">Paid</span> <ActionButton ctx={page} action={`/admin/m/lan-pizza/orders/${o.id}/paid`} fields={{ paid: '0' }} label="Undo" className="btn btn-small btn-ghost" confirm={`Mark ${u?.username ?? 'this'} order as NOT paid?`} /></>
                      : <ActionButton ctx={page} action={`/admin/m/lan-pizza/orders/${o.id}/paid`} fields={{ paid: '1' }} label={`Received ${money(o.totalCents, s)}`} className="btn btn-small btn-primary" />}</td>
                    <td>{o.handedOut
                      ? <><span class="tag">Collected</span> <ActionButton ctx={page} action={`/admin/m/lan-pizza/orders/${o.id}/handed`} fields={{ handed: '0' }} label="Undo" className="btn btn-small btn-ghost" /></>
                      : <ActionButton ctx={page} action={`/admin/m/lan-pizza/orders/${o.id}/handed`} fields={{ handed: '1' }} label="Handed out" className="btn btn-small" />}</td>
                    <td>{manage ? <ActionButton ctx={page} action={`/admin/m/lan-pizza/orders/${o.id}/remove`} label="Remove" className="btn btn-small btn-ghost" confirm={o.paid ? 'This order is PAID — remove it only after refunding the cash. Remove?' : 'Remove this order?'} /> : null}</td>
                  </tr>
                );
              })}
            </tbody></table></div> : <p class="muted">No orders yet.</p>}
          </Box>
        </>
      ));
    });

    ctx.adminRoutes.post('/runs/:id/edit', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const r = await adminRound(c);
      const b = await form(c);
      const name = cleanLine(b.name, 120) || r.name;
      const closesAt = str(b.closesAt) ? parseLocalDateTime(str(b.closesAt), tzOf(c.get('page'))) : null;
      await db().update(rounds).set({ name, closesAt, notes: cleanText(b.notes, 1000) }).where(eq(rounds.id, r.id));
      setFlash(c, { type: 'ok', text: 'Saved.' });
      return c.redirect(`/admin/m/lan-pizza/runs/${r.id}`);
    });

    ctx.adminRoutes.post('/runs/:id/status', async (c) => {
      const v = c.get('viewer'); await v.require(P.manage);
      const r = await adminRound(c);
      const status = str((await form(c)).status) as Status;
      if (!(status in STATUSES)) throw new ServiceError('Unknown status.');
      await db().update(rounds).set({ status }).where(eq(rounds.id, r.id));
      await services.audit(v.user!.id, 'lan-pizza.run.status', { type: 'pizza_run', id: r.id }, { from: r.status, to: status }, v.ip);
      const list = await ordersFor(r.id);
      const s = await cfg();
      if (status === 'delivered') for (const o of list) await services.notify(o.userId, 'lan-pizza', v.user!.id, `The food for “${r.name}” has arrived!${o.paid ? '' : ` Please bring ${money(o.totalCents, s)} in cash.`}`, '/m/lan-pizza');
      if (status === 'closed') for (const o of list.filter((x) => !x.paid)) await services.notify(o.userId, 'lan-pizza', v.user!.id, `Orders for “${r.name}” are closed — please pay ${money(o.totalCents, s)} in cash so your food gets ordered.`, '/m/lan-pizza');
      setFlash(c, { type: 'ok', text: `Now: ${STATUSES[status]}.` });
      return c.redirect(`/admin/m/lan-pizza/runs/${r.id}`);
    });

    const orderAction = (path: string, fn: (id: number, b: Record<string, unknown>, v: Viewer) => Promise<{ roundId: number }>) =>
      ctx.adminRoutes.post(path, async (c) => {
        const v = c.get('viewer'); await requireHandle(v);
        const o = await fn(int(c.req.param('id')), await form(c), v);
        return c.redirect(`/admin/m/lan-pizza/runs/${o.roundId}`);
      });
    orderAction('/orders/:id/paid', async (id, b, v) => {
      const paid = str(b.paid) === '1';
      const o = await setPaid(id, paid, v.user!.id);
      const s = await cfg();
      await services.audit(v.user!.id, paid ? 'lan-pizza.payment.received' : 'lan-pizza.payment.undone', { type: 'user', id: o.userId }, { order: o.id, amount: money(o.totalCents, s) }, v.ip);
      if (paid) await services.notify(o.userId, 'lan-pizza', v.user!.id, `Payment of ${money(o.totalCents, s)} received for your food order. Thanks!`, '/m/lan-pizza');
      return o;
    });
    orderAction('/orders/:id/handed', async (id, b) => setHandedOut(id, str(b.handed) === '1'));
    orderAction('/orders/:id/remove', async (id, _b, v) => {
      if (!(await v.can(P.manage))) await v.require(P.manage);
      const o = await removeOrder(id);
      await services.audit(v.user!.id, 'lan-pizza.order.remove', { type: 'user', id: o.userId }, { order: o.id, wasPaid: o.paid, cents: o.totalCents }, v.ip);
      return o;
    });

    // ── menu ──
    ctx.adminRoutes.get('/menu', async (c) => {
      await c.get('viewer').require(P.manage);
      const page = c.get('page');
      const s = await cfg();
      const list = await listMenu(true);
      const catOpts = Object.entries(CATEGORIES) as [string, string][];
      return ctx.renderAdmin(c, 'Pizza menu', P.handle, (
        <>
          <p><a href="/admin/m/lan-pizza/runs">← Pizza runs</a></p>
          <Box title="Add an item">
            <form method="post" action="/admin/m/lan-pizza/menu/new" class="form-grid"><Csrf ctx={page} />
              <div class="field-row">
                <Field label="Name" name="name" required maxlength={80} />
                <Select label="Category" name="category" value="pizza" options={catOpts} />
                <Field label={`Price (${s.currency})`} name="price" required placeholder="12.50" inputmode="decimal" />
              </div>
              <Field label="Description (optional)" name="description" maxlength={200} />
              <div class="field-row"><Checkbox label="Vegetarian" name="vegetarian" /><Checkbox label="Vegan" name="vegan" /></div>
              <div class="form-actions"><button class="btn btn-primary btn-small">Add to menu</button></div>
            </form>
          </Box>
          <Box title={`Menu (${list.length})`}>
            {list.length ? <div class="table-wrap"><table class="data-table"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Shown</th><th /></tr></thead><tbody>
              {list.map((m) => (
                <tr><td><strong>{m.name}</strong> <DietTags m={m} />{m.description ? <div class="small muted">{m.description}</div> : null}</td>
                  <td>{CATEGORIES[m.category] ?? m.category}</td>
                  <td><form method="post" action={`/admin/m/lan-pizza/menu/${m.id}/price`} class="inline-form"><Csrf ctx={page} />
                    <label class="sr-only" for={`p-${m.id}`}>Price of {m.name}</label>
                    <input id={`p-${m.id}`} name="price" class="input-narrow" inputmode="decimal" value={(m.priceCents / 100).toFixed(2)} />
                    <button class="btn btn-small">Save</button></form></td>
                  <td>{m.enabled ? <span class="tag tag-ok">Shown</span> : <span class="tag tag-held">Hidden</span>}</td>
                  <td><ActionButton ctx={page} action={`/admin/m/lan-pizza/menu/${m.id}/toggle`} label={m.enabled ? 'Hide' : 'Show'} className="btn btn-small" /></td></tr>))}
            </tbody></table></div> : <EmptyState title="The menu is empty."><ActionButton ctx={page} action="/admin/m/lan-pizza/menu/seed" label="Load an example menu" className="btn btn-primary" /></EmptyState>}
            <p class="small muted">Price changes apply to new and updated orders; existing orders keep the price they were placed at.</p>
          </Box>
        </>
      ));
    });
    const menuAction = (path: string, fn: (c: RequestContext, b: Record<string, unknown>) => Promise<string>) =>
      ctx.adminRoutes.post(path, async (c) => {
        const v = c.get('viewer'); await v.require(P.manage);
        try { setFlash(c, { type: 'ok', text: await fn(c, await form(c)) }); await services.audit(v.user!.id, `lan-pizza.menu.${path.split('/').pop()}`, { type: 'pizza_menu' }, { path: c.req.path }, v.ip); }
        catch (err) { if (err instanceof ServiceError) setFlash(c, { type: 'error', text: err.message }); else throw err; }
        return c.redirect('/admin/m/lan-pizza/menu');
      });
    const priceOf = (b: Record<string, unknown>) => { const p = parseMoney(str(b.price)); if (p === null || p > 100000) throw new ServiceError('Enter a price like 12.50.'); return p; };
    menuAction('/menu/new', async (_c, b) => {
      const name = cleanLine(b.name, 80);
      if (name.length < 2) throw new ServiceError('Give the item a name.');
      const category = str(b.category) in CATEGORIES ? str(b.category) : 'pizza';
      await db().insert(menu).values({ name, category, description: cleanLine(b.description, 200), priceCents: priceOf(b), vegetarian: bool(b.vegetarian) || bool(b.vegan), vegan: bool(b.vegan), displayOrder: 1000 });
      return `Added ${name}.`;
    });
    menuAction('/menu/seed', async () => `Loaded ${await seedMenu()} items.`);
    menuAction('/menu/:id/price', async (c, b) => { await db().update(menu).set({ priceCents: priceOf(b) }).where(eq(menu.id, int(c.req.param('id')))); return 'Price saved.'; });
    menuAction('/menu/:id/toggle', async (c) => {
      const [m] = await db().select().from(menu).where(eq(menu.id, int(c.req.param('id'))));
      if (!m) throw new ServiceError('Item not found.', 404);
      await db().update(menu).set({ enabled: !m.enabled }).where(eq(menu.id, m.id));
      return `${m.name} is now ${m.enabled ? 'hidden' : 'shown'}.`;
    });
  },
});
