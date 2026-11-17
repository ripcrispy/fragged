/** Shared helpers for the page modules: permissions, loading, integrations. Built once in setup(). */
import { ServiceError, setFlash, type ModuleContext, type RequestContext, type PageCtx, type Viewer, type Child } from '../../src/sdk/index.ts';
import { ACTIONS, roleOf, canSee, entriesOf, bySlug, type Action, type Eligibility } from './service.ts';
import type { Tournament } from './schema.ts';

export interface SeatingApi {
  eventById(id: number): Promise<{ id: number; slug: string; name: string; startsAt: Date | null; endsAt: Date | null; status: string } | null>;
  listEvents(includeDrafts: boolean): Promise<{ id: number; slug: string; name: string; startsAt: Date | null; status: string }[]>;
  seatFor(eventId: number, userId: number): Promise<string | null>;
}
export interface BookingsApi { isBooked(eventId: number, userId: number): Promise<boolean> }
export interface AchievementsApi {
  registerMetric(key: string, label: string, value: (userId: number) => Promise<number>): void;
  unregisterMetric(key: string): void;
  addDefinitions(list: { key: string; name: string; description: string; category: string; icon: string; rarity: string; metric: string; threshold: number }[]): Promise<void>;
  evaluate(userId: number): Promise<string[]>;
}

export const PERMS = {
  view: { label: 'See tournaments, brackets and results', grantTo: ['guest', 'member'] },
  compete: { label: 'Register for tournaments, run a team and report your own scores', grantTo: ['member'] },
  create: { label: 'Create tournaments (you become their organiser)' },
  manage: { label: 'Act as organiser on every tournament' },
  registrations: { label: 'Approve and reject registrations, and invite members, on any tournament' },
  participants: { label: 'Manage participants, teams, seeds, stations and check-in on any tournament' },
  brackets: { label: 'Generate and adjust brackets on any tournament' },
  schedule: { label: 'Schedule matches on any tournament' },
  scores: { label: 'Report and confirm scores as a referee on any tournament' },
  disputes: { label: 'Resolve disputes and override results on any tournament' },
  publish: { label: 'Publish results and announcements on any tournament' },
} as const;

export interface Helpers {
  P: Record<keyof typeof PERMS, string>;
  /** May this viewer do this to this tournament? Managers and the tournament's organisers can do everything. */
  can(v: Viewer, t: Tournament, action: Action): Promise<boolean>;
  /** Any staff power at all on this tournament (used for the manage page and private tournaments). */
  isStaff(v: Viewer, t: Tournament): Promise<boolean>;
  canCreate(v: Viewer): Promise<boolean>;
  load(c: RequestContext): Promise<{ t: Tournament; v: Viewer; page: PageCtx; staff: boolean }>;
  require(v: Viewer, t: Tournament, action: Action): Promise<void>;
  elig(t: Tournament): Eligibility;
  seating(): SeatingApi | null;
  achievements(): AchievementsApi | null;
  names(t: Tournament): Promise<Map<number, string>>;
  tz(page: PageCtx): string;
  flash(c: RequestContext, e: unknown): void;
  audit(v: Viewer, action: string, t: Tournament, detail?: Record<string, unknown>): Promise<void>;
  render(c: RequestContext, title: string, body: Child, crumbs: { label: string; href?: string }[], status?: number): Promise<Response>;
}

export function makeHelpers(ctx: ModuleContext, services: { audit: (actor: number, action: string, target: { type?: string; id?: number }, detail: Record<string, unknown>, ip?: string | null) => Promise<void> }): Helpers {
  const P = Object.fromEntries(Object.keys(PERMS).map((k) => [k, ctx.perm(k)])) as Helpers['P'];
  const can: Helpers['can'] = async (v, t, action) => {
    if (!v.user) return false;
    if (await v.can(P.manage)) return true;
    const role = await roleOf(t.id, v.user.id);
    if (role === 'organiser') return true;
    const a = ACTIONS[action];
    if (role === 'referee' && a.referee) return true;
    return !!a.perm && (await v.can(P[a.perm as keyof typeof PERMS]));
  };
  const isStaff: Helpers['isStaff'] = async (v, t) => {
    if (!v.user) return false;
    for (const a of Object.keys(ACTIONS) as Action[]) if (await can(v, t, a)) return true;
    return false;
  };
  const seating = () => ctx.use<SeatingApi>('lan-seating');
  return {
    P, can, isStaff,
    canCreate: async (v) => !!v.user && ((await v.can(P.create)) || (await v.can(P.manage))),
    async load(c) {
      const v = c.get('viewer');
      await v.require(P.view);
      const t = await bySlug(c.req.param('slug') ?? '');
      if (!t) throw new ServiceError('Tournament not found.', 404);
      const staff = await isStaff(v, t);
      if ((t.status === 'draft' && !staff) || !(await canSee(t, v.user?.id ?? null, staff))) throw new ServiceError('Tournament not found.', 404);
      return { t, v, page: c.get('page'), staff };
    },
    async require(v, t, action) {
      if (!v.user) throw new ServiceError('Sign in first.', 401, 'login_required');
      if (!(await can(v, t, action))) throw new ServiceError('You don’t have permission to do that in this tournament.', 403);
    },
    elig(t) {
      const b = ctx.use<BookingsApi>('lan-bookings');
      return { isBooked: b && t.lanEventId ? (u: number) => b.isBooked(t.lanEventId!, u) : undefined };
    },
    seating,
    achievements: () => ctx.use<AchievementsApi>('achievements'),
    names: async (t) => new Map((await entriesOf(t.id)).map((e) => [e.id, e.name])),
    tz: (page) => page.viewer.user?.timezone ?? 'UTC',
    flash(c, e) {
      if (e instanceof ServiceError && e.status < 500) { setFlash(c, { type: 'error', text: e.message }); return; }
      throw e;
    },
    async audit(v, action, t, detail = {}) { if (v.user) await services.audit(v.user.id, `lan-tournaments.${action}`, { type: 'lan_tournament', id: t.id }, { tournament: t.slug, ...detail }, v.ip); },
    render: (c, title, body, crumbs, status) => ctx.render(c, title, body, { crumbs: [{ label: 'Tournaments', href: '/m/lan-tournaments' }, ...crumbs], status }),
  };
}
