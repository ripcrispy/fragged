/** @jsxImportSource hono/jsx */
import {
  defineModule, database, eq, asc, sql, Box, Csrf, ActionButton, Checkbox, Time, numberFmt, form, str, int, bool, cleanLine, slugify,
  services, ServiceError, type ModuleContext,
} from '../../src/sdk/index.ts';
import { achievementDefinitions as defs, userAchievements as awards } from './schema.ts';
import { evaluate, award, revoke, earnedBy, METRICS, DEFAULTS } from './service.ts';

const db = () => database.db();
const profiles = database.coreTables.userProfiles;
const ICONS = ['medal', 'flag', 'stack', 'quill', 'crown', 'spark', 'star', 'people', 'chat', 'cake', 'shield'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const CATEGORIES = ['threads', 'posts', 'reactions', 'community', 'account', 'contribution'];

function definitionValues(b: Record<string, unknown>) {
  const metric = str(b.metric);
  if (metric && !(metric in METRICS)) throw new ServiceError('Unknown metric.');
  const threshold = int(b.threshold);
  if (metric && threshold < 1) throw new ServiceError('Threshold must be at least 1.');
  const pick = (v: string, allowed: string[], d: string) => (allowed.includes(v) ? v : d);
  return {
    name: cleanLine(b.name, 80), description: cleanLine(b.description, 300), category: pick(str(b.category), CATEGORIES, 'community'),
    rarity: pick(str(b.rarity), RARITIES, 'common'), icon: pick(str(b.icon), ICONS, 'medal'),
    criteria: metric ? { metric, threshold } : { manual: true }, isActive: bool(b.isActive), displayOrder: int(b.displayOrder),
  };
}

export default defineModule({
  id: 'achievements',
  name: 'Achievements',
  version: '1.0.0',
  description: 'Badges awarded automatically for taking part (posts, threads, reactions, friendships), plus manual awards by staff.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  migrations: 'migrations',
  assets: 'public',
  styles: ['achievements.css'],
  permissions: { manage: { label: 'Create, edit, award and revoke achievements' } },
  notificationKinds: { achievement: 'Achievements earned' },

  async onInstall() {
    for (const [i, a] of DEFAULTS.entries()) await db().insert(defs).values({ ...a, displayOrder: i }).onConflictDoNothing();
  },

  setup(ctx: ModuleContext) {
    const tz = (c: any) => c.get('page').viewer.user?.timezone ?? 'UTC';

    // ── award on activity ──
    ctx.hooks.on('post.created', ({ userId }) => evaluate(userId).then(() => {}));
    ctx.hooks.on('thread.created', ({ userId }) => evaluate(userId).then(() => {}));
    ctx.hooks.on('post.reacted', ({ authorId, added }) => (added ? evaluate(authorId).then(() => {}) : undefined));
    ctx.hooks.on('friend.accepted', async ({ userId, friendId }) => { await evaluate(userId); await evaluate(friendId); });
    ctx.hooks.on('profile.commented', ({ profileUserId }) => evaluate(profileUserId).then(() => {}));

    // ── public page: /m/achievements ──
    ctx.routes.get('/', async (c) => {
      const v = c.get('viewer');
      const list = await db().select().from(defs).where(eq(defs.isActive, true)).orderBy(asc(defs.displayOrder));
      const mine = v.user ? await earnedBy(v.user.id) : [];
      const owned = new Map(mine.map((m) => [m.a.id, m.awardedAt]));
      const counts = await db().select({ id: awards.achievementId, n: sql<number>`count(*)::int` }).from(awards).where(sql`${awards.revokedAt} is null`).groupBy(awards.achievementId);
      return ctx.render(c, 'Achievements', (
        <>
          <h1 class="page-title">Achievements</h1>
          <p>Achievements are awarded automatically by the server as you take part — no forms, no grinding. Posts under 10 characters don't count.</p>
          <div class="table-wrap"><table class="data-table ach-table"><thead><tr><th>Achievement</th><th>Category</th><th>Rarity</th><th class="col-num">Earned by</th>{v.user ? <th>You</th> : null}</tr></thead><tbody>
            {list.map((d) => <tr class={owned.has(d.id) ? 'is-owned' : ''}><td><span class={`ach-icon icon-${d.icon}`} aria-hidden="true" /> <strong>{d.name}</strong><div class="muted small">{d.description}</div></td><td>{d.category}</td><td><span class={`rarity rarity-${d.rarity}`}>{d.rarity}</span></td><td class="col-num">{numberFmt(counts.find((x) => x.id === d.id)?.n ?? 0)}</td>{v.user ? <td>{owned.has(d.id) ? <><span aria-hidden="true">✓ </span><Time d={owned.get(d.id)!} tz={tz(c)} mode="date" /></> : <span class="muted">—</span>}</td> : null}</tr>)}
          </tbody></table></div>
        </>
      ), { crumbs: [{ label: 'Achievements' }] });
    });
    ctx.register.navItem({ href: '/m/achievements', label: 'Achievements', area: 'footer', order: 60 });

    // ── profile section + settings checkbox (uses the core "show achievements" profile flag) ──
    ctx.register.profileSection({
      id: 'achievements', column: 'main', order: 20,
      async render({ user, isSelf, ctx: page }) {
        const [p] = await db().select({ show: profiles.showAchievements }).from(profiles).where(eq(profiles.userId, user.id));
        if (!p?.show && !isSelf) return null;
        const list = await earnedBy(user.id);
        if (!list.length) return null;
        return (
          <Box title={`Achievements (${list.length})`} headingLevel={3} actions={<a href="/m/achievements">All achievements</a>}>
            <ul class="achievements">{list.map(({ a, awardedAt }) => (
              <li class={`ach rarity-${a.rarity}`} title={a.description}><span class={`ach-icon icon-${a.icon}`} aria-hidden="true" /><span class="ach-name">{a.name}</span><span class="ach-meta">{a.rarity} · <Time d={awardedAt} tz={page.viewer.user?.timezone ?? 'UTC'} mode="date" /></span></li>))}
            </ul>
          </Box>
        );
      },
    });
    ctx.register.profileSettings({
      id: 'achievements', order: 40,
      async render({ viewer }) {
        const [p] = await db().select({ show: profiles.showAchievements }).from(profiles).where(eq(profiles.userId, viewer.user!.id));
        return <Checkbox label="Show achievements on my profile" name="showAchievements" checked={p?.show ?? true} />;
      },
      async save({ viewer, form: f }) {
        await db().update(profiles).set({ showAchievements: bool(f.showAchievements) }).where(eq(profiles.userId, viewer.user!.id));
        return {};
      },
    });

    // ── administration: /admin/m/achievements/definitions ──
    const manage = ctx.perm('manage');
    ctx.register.adminSection({ slug: 'definitions', label: 'Achievements', permission: manage });
    ctx.adminRoutes.get('/definitions', async (c) => {
      await c.get('viewer').require(manage);
      const page = c.get('page');
      const list = await db().select().from(defs).orderBy(asc(defs.displayOrder));
      const Row = ({ d }: { d?: typeof list[number] }) => (
        <form method="post" action={d ? `/admin/m/achievements/definitions/${d.id}` : '/admin/m/achievements/definitions/new'} class="inline-form ach-form"><Csrf ctx={page} />
          <input name="key" value={d?.key} placeholder="key" required maxlength={48} aria-label="Key" class="input-narrow" readOnly={!!d} />
          <input name="name" value={d?.name} placeholder="Name" required maxlength={80} aria-label="Name" />
          <input name="description" value={d?.description} placeholder="Description" aria-label="Description" />
          <select name="category" aria-label="Category">{CATEGORIES.map((x) => <option selected={d?.category === x}>{x}</option>)}</select>
          <select name="rarity" aria-label="Rarity">{RARITIES.map((x) => <option selected={d?.rarity === x}>{x}</option>)}</select>
          <select name="icon" aria-label="Icon">{ICONS.map((x) => <option selected={d?.icon === x}>{x}</option>)}</select>
          <select name="metric" aria-label="Metric"><option value="">manual award</option>{Object.entries(METRICS).map(([k, l]) => <option value={k} selected={d?.criteria.metric === k}>{l}</option>)}</select>
          <input name="threshold" type="number" min={1} value={String(d?.criteria.threshold ?? '')} placeholder="≥" aria-label="Threshold" class="input-narrow" />
          <input name="displayOrder" type="number" value={String(d?.displayOrder ?? 0)} aria-label="Order" class="input-narrow" />
          <label><input type="checkbox" name="isActive" value="1" checked={d ? d.isActive : true} /> active</label>
          <button class="btn btn-small">{d ? 'Save' : 'Create'}</button>
        </form>
      );
      return ctx.renderAdmin(c, 'Achievements', manage, (
        <>
          <p>Achievements with a metric are evaluated by the server after relevant activity. Awards are unique per member; revocations (from a member's admin page) are audited and not automatically re-awarded.</p>
          <Box title="Definitions">{list.map((d) => <Row d={d} />)}</Box>
          <Box title="New achievement"><Row /></Box>
        </>
      ));
    });
    ctx.adminRoutes.post('/definitions/new', async (c) => {
      const v = c.get('viewer'); await v.require(manage);
      const b = await form(c);
      const [d] = await db().insert(defs).values({ key: slugify(str(b.key), 48), ...definitionValues(b) }).returning();
      await services.audit(v.user!.id, 'achievement.create', { type: 'achievement', id: d.id }, { key: d.key }, v.ip);
      return c.redirect('/admin/m/achievements/definitions');
    });
    ctx.adminRoutes.post('/definitions/:id', async (c) => {
      const v = c.get('viewer'); await v.require(manage);
      const id = int(c.req.param('id'));
      await db().update(defs).set(definitionValues(await form(c))).where(eq(defs.id, id));
      await services.audit(v.user!.id, 'achievement.update', { type: 'achievement', id }, {}, v.ip);
      return c.redirect('/admin/m/achievements/definitions');
    });

    // ── panel on Admin › Users › <member> ──
    ctx.register.adminUserPanel({
      id: 'achievements', title: 'Achievements', permission: manage, order: 50,
      async render({ user, ctx: page }) {
        const list = await db().select().from(defs).orderBy(asc(defs.displayOrder));
        const mine = await db().select().from(awards).where(eq(awards.userId, user.id));
        return (
          <Box title="Achievements">
            <table class="data-table"><tbody>{list.map((d) => {
              const a = mine.find((x) => x.achievementId === d.id);
              const held = a && !a.revokedAt;
              return (
                <tr><td>{d.name}</td><td class="small muted">{held ? <>awarded <Time d={a!.awardedAt} tz={page.viewer.user?.timezone ?? 'UTC'} mode="date" /></> : a?.revokedAt ? `revoked: ${a.revokeReason}` : 'not earned'}</td><td>
                  {held ? <form method="post" action={`/admin/m/achievements/users/${user.id}/${d.id}/revoke`} class="inline-form"><Csrf ctx={page} /><input name="reason" placeholder="Reason" required aria-label="Revoke reason" /><button class="btn btn-small">Revoke</button></form>
                    : <ActionButton ctx={page} action={`/admin/m/achievements/users/${user.id}/${d.id}/award`} label="Award" className="btn btn-small" />}</td></tr>
              );
            })}</tbody></table>
          </Box>
        );
      },
    });
    ctx.adminRoutes.post('/users/:uid/:aid/award', async (c) => {
      const v = c.get('viewer'); await v.require(manage);
      const uid = int(c.req.param('uid'));
      await award(v.user!.id, uid, int(c.req.param('aid')), v.ip);
      return c.redirect(`/admin/users/${uid}`);
    });
    ctx.adminRoutes.post('/users/:uid/:aid/revoke', async (c) => {
      const v = c.get('viewer'); await v.require(manage);
      const uid = int(c.req.param('uid'));
      const reason = str((await form(c)).reason);
      if (reason.trim().length < 3) throw new ServiceError('Give a reason.');
      await revoke(v.user!.id, uid, int(c.req.param('aid')), reason, v.ip);
      return c.redirect(`/admin/users/${uid}`);
    });
  },
});
