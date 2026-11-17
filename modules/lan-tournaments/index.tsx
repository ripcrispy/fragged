/** @jsxImportSource hono/jsx */
/**
 * LAN tournaments: create and run gaming tournaments, from registration to final results.
 * Formats and maths live in formats.ts (pure), data and progression in service.ts / matches.ts, pages in web-*.tsx.
 */
import { defineModule, database, services, eq, and, inArray, sql, type ModuleContext } from '../../src/sdk/index.ts';
import { makeHelpers, PERMS, type AchievementsApi } from './context.ts';
import { registerPublic, liveData } from './web-public.tsx';
import { registerManage } from './web-manage.tsx';
import { exportFor, forget } from './service.ts';
import { sendReminders, setAfterPublish } from './matches.ts';
import { tournaments, results, matches as matchesTable, type Tournament } from './schema.ts';

const ID = 'lan-tournaments';
let timer: ReturnType<typeof setInterval> | null = null;
let intranetFeed: { liveSummary(eventId: number | null): Promise<unknown>; schedule(from: Date | null, to: Date | null): Promise<unknown> } | null = null;
const db = () => database.db();

const METRICS: [string, string, (userId: number) => Promise<number>][] = [
  ['tournaments_played', 'Tournaments played (published results)', async (u) => count(sql`select count(distinct tournament_id)::int as n from mod_lan_tournaments_results where user_id = ${u}`)],
  ['tournament_wins', 'Tournaments won', async (u) => count(sql`select count(*)::int as n from mod_lan_tournaments_results where user_id = ${u} and place = 1`)],
  ['tournament_podiums', 'Tournament podium finishes (top 3)', async (u) => count(sql`select count(*)::int as n from mod_lan_tournaments_results where user_id = ${u} and place <= 3`)],
];
async function count(q: ReturnType<typeof sql>) { const r: any = await db().execute(q); return Number((r.rows ?? r)[0]?.n ?? 0); }
const BADGES = [
  { key: 'tournament-first', name: 'Bracket Rookie', description: 'Played in your first tournament.', category: 'tournaments', icon: 'flag', rarity: 'common', metric: 'tournaments_played', threshold: 1 },
  { key: 'tournament-podium', name: 'On the Podium', description: 'Finished in the top 3 of a tournament.', category: 'tournaments', icon: 'medal', rarity: 'uncommon', metric: 'tournament_podiums', threshold: 1 },
  { key: 'tournament-champion', name: 'Champion', description: 'Won a tournament.', category: 'tournaments', icon: 'crown', rarity: 'rare', metric: 'tournament_wins', threshold: 1 },
  { key: 'tournament-veteran', name: 'Tournament Veteran', description: 'Played in 10 tournaments.', category: 'tournaments', icon: 'shield', rarity: 'epic', metric: 'tournaments_played', threshold: 10 },
];

export default defineModule({
  id: ID,
  name: 'LAN tournaments',
  version: '1.0.0',
  description: 'Run gaming tournaments: solo or team registration, single and double elimination, round robin, swiss, groups with playoffs, free-for-all heats and time challenges, with brackets, score reporting and disputes, a live spectator view, results, leaderboards and LAN event integration.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.4.0',
  enabledByDefault: false,
  optionalDependencies: { 'lan-seating': '^1.2.0', 'lan-bookings': '^1.3.0', achievements: '^1.2.0', 'lan-intranet': '^1.3.0' },
  migrations: 'migrations',
  assets: 'public',
  styles: ['tournaments.css'],
  permissions: PERMS as unknown as Record<string, { label: string; grantTo?: string[] }>,
  notificationKinds: { [ID]: 'Tournaments: registrations, matches, results and announcements' },

  async start(ctx) {
    const ach = ctx.use<AchievementsApi>('achievements');
    if (ach) {
      for (const [k, label, fn] of METRICS) ach.registerMetric(k, label, fn);
      await ach.addDefinitions(BADGES).catch((e) => ctx.log.warn('could not add tournament achievements', { error: String(e) }));
    }
    // LAN HQ shows live tournaments and puts scheduled matches in its schedule
    ctx.use<{ setTournamentSource(api: unknown): void }>('lan-intranet')?.setTournamentSource(intranetFeed);
    timer = setInterval(() => void sendReminders().catch((e) => ctx.log.warn('tournament reminders failed', { error: String(e) })), 60_000);
    timer.unref();
  },
  async stop(ctx) {
    if (timer) clearInterval(timer);
    timer = null;
    const ach = ctx.use<AchievementsApi>('achievements');
    if (ach) for (const [k] of METRICS) ach.unregisterMetric(k);
    ctx.use<{ setTournamentSource(api: unknown): void }>('lan-intranet')?.setTournamentSource(null);
  },

  setup(ctx: ModuleContext) {
    const h = makeHelpers(ctx, services);
    // published results can unlock tournament achievements
    setAfterPublish(async (userIds) => { const ach = ctx.use<AchievementsApi>('achievements'); if (ach) for (const u of userIds) await ach.evaluate(u).catch(() => []); });
    ctx.register.navItem({ href: '/m/lan-tournaments', label: 'Tournaments', icon: 'star', area: 'main', order: 66, visible: (v) => v.can(h.P.view) });
    ctx.register.personalData({ id: ID, label: 'Tournaments', export: exportFor, erase: forget });
    ctx.hooks.on('user.closed', async ({ userId }) => { await forget(userId); });

    // for the LAN intranet (LAN HQ): what's on, and scheduled matches for the event schedule
    intranetFeed = {
      async liveSummary(eventId: number | null) {
        const list = (await db().select().from(tournaments).where(and(inArray(tournaments.status, ['registration_open', 'registration_closed', 'in_progress']), eq(tournaments.archived, false))))
          .filter((t) => t.visibility !== 'private' && (!eventId || t.lanEventId === eventId || t.lanEventId === null));
        const out = [];
        for (const t of list) {
          const live = t.status === 'in_progress' ? await liveData(t) : null;
          const names = await h.names(t);
          const label = (m: { entryA: number | null; entryB: number | null; code: string; bracket: string }) => m.bracket === 'H' ? `Heat ${m.code}` : `${names.get(m.entryA ?? -1) ?? 'TBD'} vs ${names.get(m.entryB ?? -1) ?? 'TBD'}`;
          out.push({
            name: t.name, game: t.game, status: t.status, url: `/m/lan-tournaments/${t.slug}`, liveUrl: `/m/lan-tournaments/${t.slug}/live`, progress: live?.progress ?? 0,
            active: (live?.active ?? []).slice(0, 3).map((m) => ({ label: label(m), code: m.code, score: m.scoreA !== null ? `${m.scoreA}–${m.scoreB}` : null, station: m.station })),
            next: (live?.upcoming ?? []).slice(0, 3).map((m) => ({ label: label(m), code: m.code, at: m.scheduledAt, station: m.station })),
          });
        }
        return out;
      },
      async schedule(from: Date | null, to: Date | null) {
        const rows = await db().select({ m: matchesTable, t: tournaments }).from(matchesTable).innerJoin(tournaments, eq(tournaments.id, matchesTable.tournamentId))
          .where(and(eq(tournaments.status, 'in_progress'), sql`${matchesTable.scheduledAt} is not null`, inArray(matchesTable.status, ['pending', 'ready', 'live'])));
        return rows.filter(({ m, t }) => t.visibility !== 'private' && (!from || m.scheduledAt! >= from) && (!to || m.scheduledAt! <= to))
          .map(({ m, t }) => ({ title: `${t.name}: ${m.code}`, startsAt: m.scheduledAt!, location: m.station, url: `/m/lan-tournaments/${t.slug}/match/${m.id}` }));
      },
    };
    ctx.expose({ ...intranetFeed, async historyCount(userId: number) { return count(sql`select count(*)::int as n from mod_lan_tournaments_results where user_id = ${userId}`); } });
    void results; void ({} as Tournament);

    registerManage(ctx, h);
    registerPublic(ctx, h);
  },
});
