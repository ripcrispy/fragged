/**
 * Tournaments, roles, registration, teams, check-in and announcements. Brackets, scores and standings are in
 * matches.ts. Every check that matters (capacity, duplicates, windows, eligibility) is enforced here and backed by
 * unique indexes, so concurrent requests can't get around it.
 */
import { database, services, eq, and, asc, desc, inArray, sql, ServiceError, slugify, cleanLine, cleanText } from '../../src/sdk/index.ts';
import { tournaments, staff, teams, teamMembers, entries, invites, announcements, results, reports, attempts, type Tournament, type Entry, type Team } from './schema.ts';
import { FORMATS, withDefaults, type FormatId, type FormatConfig } from './formats.ts';

export const STATUSES = {
  draft: 'Draft',
  registration_open: 'Registration open',
  registration_closed: 'Registration closed',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;
export type Status = keyof typeof STATUSES;
export const VISIBILITY = { public: 'Public: listed, anyone can register', invite: 'Invitation only: listed, only invited members can register', private: 'Private: not listed; only staff and invited members can see it' } as const;
export type Visibility = keyof typeof VISIBILITY;
export const ROLES = { organiser: 'Organiser', referee: 'Referee' } as const;
export type Role = keyof typeof ROLES;

/** What can be done to a tournament, and who may do it (besides managers and the tournament's organisers). */
export const ACTIONS = {
  edit: { label: 'Edit and change status', perm: null, referee: false },
  registrations: { label: 'Approve and reject registrations, invitations', perm: 'registrations', referee: false },
  participants: { label: 'Manage participants and teams, seeds and stations', perm: 'participants', referee: false },
  checkin: { label: 'Check participants in', perm: 'participants', referee: true },
  brackets: { label: 'Generate and adjust brackets', perm: 'brackets', referee: false },
  schedule: { label: 'Schedule matches', perm: 'schedule', referee: true },
  scores: { label: 'Report and confirm scores', perm: 'scores', referee: true },
  disputes: { label: 'Resolve disputes and override results', perm: 'disputes', referee: true },
  publish: { label: 'Publish results and announcements', perm: 'publish', referee: false },
} as const;
export type Action = keyof typeof ACTIONS;

const db = () => database.db();
const NOTIFY = 'lan-tournaments';

// ───────────────────────────── reads ─────────────────────────────

export async function bySlug(slug: string) { return (await db().select().from(tournaments).where(eq(tournaments.slug, slug)))[0] ?? null; }
export async function byId(id: number) { return (await db().select().from(tournaments).where(eq(tournaments.id, id)))[0] ?? null; }
export async function listAll() { return db().select().from(tournaments).orderBy(desc(tournaments.startsAt), desc(tournaments.id)); }
export async function staffOf(tId: number) { return db().select().from(staff).where(eq(staff.tournamentId, tId)); }
export async function roleOf(tId: number, userId: number | null): Promise<Role | null> {
  if (!userId) return null;
  return ((await db().select().from(staff).where(and(eq(staff.tournamentId, tId), eq(staff.userId, userId))))[0]?.role as Role) ?? null;
}
export async function entriesOf(tId: number) { return db().select().from(entries).where(eq(entries.tournamentId, tId)).orderBy(asc(entries.seed), asc(entries.createdAt), asc(entries.id)); }
export async function entryById(id: number) { return (await db().select().from(entries).where(eq(entries.id, id)))[0] ?? null; }
export async function teamsOf(tId: number) { return db().select().from(teams).where(eq(teams.tournamentId, tId)).orderBy(asc(teams.name)); }
export async function teamById(id: number) { return (await db().select().from(teams).where(eq(teams.id, id)))[0] ?? null; }
export async function membersOf(teamId: number) { return db().select().from(teamMembers).where(eq(teamMembers.teamId, teamId)).orderBy(asc(teamMembers.createdAt)); }
export async function invitesOf(tId: number) { return db().select().from(invites).where(eq(invites.tournamentId, tId)); }
export async function announcementsOf(tId: number) { return db().select().from(announcements).where(eq(announcements.tournamentId, tId)).orderBy(desc(announcements.createdAt)); }
export const ACTIVE_ENTRY = ['pending', 'approved'] as const;
export const counted = (list: Entry[]) => list.filter((e) => (ACTIVE_ENTRY as readonly string[]).includes(e.status));

/** The member's team in this tournament (active or invited). */
export async function teamOfUser(tId: number, userId: number) {
  const [m] = await db().select().from(teamMembers).where(and(eq(teamMembers.tournamentId, tId), eq(teamMembers.userId, userId), eq(teamMembers.status, 'active')));
  return m ? { member: m, team: (await teamById(m.teamId))! } : null;
}
/** The member's entry: their own (solo) or their team's. */
export async function entryOfUser(t: Tournament, userId: number) {
  if (t.mode === 'solo') return (await db().select().from(entries).where(and(eq(entries.tournamentId, t.id), eq(entries.userId, userId), inArray(entries.status, [...ACTIVE_ENTRY, 'rejected']))))[0] ?? null;
  const team = await teamOfUser(t.id, userId);
  if (!team) return null;
  return (await db().select().from(entries).where(and(eq(entries.tournamentId, t.id), eq(entries.teamId, team.team.id), inArray(entries.status, [...ACTIVE_ENTRY, 'rejected']))))[0] ?? null;
}
/** Everyone an entry represents: the solo player, or the team's active members. */
export async function usersOfEntry(e: Pick<Entry, 'userId' | 'teamId'>): Promise<number[]> {
  if (e.userId) return [e.userId];
  if (!e.teamId) return [];
  return (await db().select({ u: teamMembers.userId }).from(teamMembers).where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.status, 'active')))).map((r) => r.u);
}
/** Who may act for an entry in matches: the solo player, or the team captain. */
export async function actorsOfEntry(e: Pick<Entry, 'userId' | 'teamId'>): Promise<number[]> {
  if (e.userId) return [e.userId];
  const t = e.teamId ? await teamById(e.teamId) : null;
  return t?.captainId ? [t.captainId] : [];
}

export async function notifyUsers(userIds: Iterable<number>, actorId: number | null, text: string, url: string) {
  for (const u of new Set(userIds)) await services.notify(u, NOTIFY, actorId, text.slice(0, 300), url).catch(() => false);
}
export async function notifyEntry(e: Pick<Entry, 'userId' | 'teamId'>, actorId: number | null, text: string, url: string) {
  await notifyUsers(await usersOfEntry(e), actorId, text, url);
}
export async function notifyParticipants(tId: number, actorId: number | null, text: string, url: string) {
  const list = counted(await entriesOf(tId));
  const users = new Set<number>();
  for (const e of list) for (const u of await usersOfEntry(e)) users.add(u);
  await notifyUsers(users, actorId, text, url);
}
export async function notifyStaff(tId: number, actorId: number | null, text: string, url: string, roles: Role[] = ['organiser', 'referee']) {
  await notifyUsers((await staffOf(tId)).filter((s) => roles.includes(s.role as Role)).map((s) => s.userId), actorId, text, url);
}

// ───────────────────────────── tournaments ─────────────────────────────

export interface TournamentInput {
  name: string; game: string; platform: string; description: string; rules: string;
  visibility: Visibility; mode: 'solo' | 'team'; teamMin: number; teamMax: number; subsMax: number; maxEntries: number | null;
  requireApproval: boolean; requireCheckin: boolean; requireBooking: boolean;
  format: FormatId; config: Partial<FormatConfig>; lanEventId: number | null;
  regOpensAt: Date | null; regClosesAt: Date | null; checkinOpensAt: Date | null; startsAt: Date | null; endsAt: Date | null;
}

const between = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/** Server-side validation of a tournament's settings. Returns tidy values or throws with a message to show. */
export function validateTournament(raw: TournamentInput): TournamentInput {
  const name = cleanLine(raw.name, 120);
  if (name.length < 3) throw new ServiceError('Give the tournament a name of at least 3 characters.');
  if (!(raw.format in FORMATS)) throw new ServiceError('Choose a format.');
  if (!(raw.visibility in VISIBILITY)) throw new ServiceError('Choose who can see and join the tournament.');
  if (raw.mode !== 'solo' && raw.mode !== 'team') throw new ServiceError('Choose solo players or teams.');
  const team = raw.mode === 'team';
  const teamMin = team ? raw.teamMin : 1, teamMax = team ? raw.teamMax : 1, subsMax = team ? raw.subsMax : 0;
  if (!between(teamMin, 1, 64) || !between(teamMax, 1, 64) || teamMin > teamMax) throw new ServiceError('Team sizes must be 1–64 players, with the minimum no more than the maximum.');
  if (!between(subsMax, 0, 16)) throw new ServiceError('Substitutes must be 0–16.');
  if (raw.maxEntries !== null && !between(raw.maxEntries, 2, 1024)) throw new ServiceError('Places must be between 2 and 1024, or empty for no limit.');
  const c = { ...raw.config };
  const bo = (v: unknown) => [1, 3, 5, 7].includes(Number(v));
  if (c.bestOf !== undefined && !bo(c.bestOf)) throw new ServiceError('Matches can be best of 1, 3, 5 or 7.');
  if (c.finalBestOf !== undefined && !bo(c.finalBestOf)) throw new ServiceError('Finals can be best of 1, 3, 5 or 7.');
  if (c.swissRounds !== undefined && !between(c.swissRounds, 1, 15)) throw new ServiceError('Swiss can have 1–15 rounds.');
  if (c.groups !== undefined && !between(c.groups, 1, 32)) throw new ServiceError('Use 1–32 groups.');
  if (c.advancePerGroup !== undefined && !between(c.advancePerGroup, 1, 16)) throw new ServiceError('1–16 can go through from each group.');
  if (c.ffaRounds !== undefined && !between(c.ffaRounds, 1, 20)) throw new ServiceError('Free-for-all can have 1–20 rounds.');
  if (c.heatSize !== undefined && !between(c.heatSize, 2, 64)) throw new ServiceError('Heats can have 2–64 entries.');
  for (const list of [c.ffaPoints, c.rankingPoints]) if (list && (list.length > 64 || list.some((x) => !between(x, 0, 100000)))) throw new ServiceError('Points must be whole numbers from 0 to 100000.');
  if (c.points && [c.points.win, c.points.draw, c.points.loss].some((x) => !between(x, -100, 100))) throw new ServiceError('Win, draw and loss points must be between -100 and 100.');
  if (c.participationPoints !== undefined && !between(c.participationPoints, 0, 100000)) throw new ServiceError('Participation points must be 0–100000.');
  if (raw.format === 'groups_playoffs' && (c.groups ?? 2) < 2) throw new ServiceError('A group stage needs at least 2 groups.');
  if (raw.regOpensAt && raw.regClosesAt && raw.regOpensAt >= raw.regClosesAt) throw new ServiceError('Registration must open before it closes.');
  if (raw.startsAt && raw.endsAt && raw.startsAt >= raw.endsAt) throw new ServiceError('The tournament must start before it ends.');
  if (raw.regClosesAt && raw.startsAt && raw.regClosesAt > raw.startsAt) throw new ServiceError('Registration must close by the time the tournament starts.');
  if (raw.checkinOpensAt && raw.startsAt && raw.checkinOpensAt > raw.startsAt) throw new ServiceError('Check-in must open before the tournament starts.');
  if (raw.requireBooking && !raw.lanEventId) throw new ServiceError('Link a LAN event to require a booked place.');
  return {
    ...raw, name, game: cleanLine(raw.game, 80), platform: cleanLine(raw.platform, 40), description: cleanText(raw.description, 10000), rules: cleanText(raw.rules, 20000),
    teamMin, teamMax, subsMax, config: c,
  };
}

export async function createTournament(raw: TournamentInput, userId: number) {
  const v = validateTournament(raw);
  let slug = slugify(v.name, 70) || 'tournament';
  if (await bySlug(slug)) slug = `${slug}-${Date.now().toString(36).slice(-5)}`;
  const [t] = await db().insert(tournaments).values({ ...v, slug, createdBy: userId }).returning();
  await db().insert(staff).values({ tournamentId: t.id, userId, role: 'organiser' }).onConflictDoNothing();
  return t;
}

/** Settings that decide the bracket can't change once it exists. */
export async function updateTournament(t: Tournament, raw: TournamentInput) {
  const v = validateTournament(raw);
  const started = ['in_progress', 'completed'].includes(t.status);
  if (started && (v.format !== t.format || v.mode !== t.mode || JSON.stringify(withDefaults(v.config)) !== JSON.stringify(withDefaults(t.config))))
    throw new ServiceError('The format and match settings can’t change once the bracket exists. Reset the bracket first.', 409);
  if (t.mode !== v.mode && counted(await entriesOf(t.id)).length) throw new ServiceError('Solo or team can’t change once people have registered.', 409);
  await db().update(tournaments).set({ ...v, updatedAt: new Date() }).where(eq(tournaments.id, t.id));
  const changedTimes = ['startsAt', 'regClosesAt', 'checkinOpensAt'].some((k) => (t as any)[k]?.getTime?.() !== (v as any)[k]?.getTime?.());
  return { changedTimes };
}

const TRANSITIONS: Record<Status, Status[]> = {
  draft: ['registration_open', 'cancelled'],
  registration_open: ['registration_closed', 'draft', 'cancelled'],
  registration_closed: ['registration_open', 'cancelled'],
  in_progress: ['cancelled'],
  completed: [],
  cancelled: ['draft'],
};
/** Manual status changes. "In progress" and "Completed" come from generating the bracket and publishing results. */
export async function setStatus(t: Tournament, to: Status) {
  if (!TRANSITIONS[t.status as Status]?.includes(to)) throw new ServiceError(`A tournament that’s ${STATUSES[t.status as Status]?.toLowerCase() ?? t.status} can’t become ${STATUSES[to]?.toLowerCase() ?? to}.`, 409);
  await db().update(tournaments).set({ status: to, updatedAt: new Date() }).where(eq(tournaments.id, t.id));
}
export async function setArchived(t: Tournament, archived: boolean) { await db().update(tournaments).set({ archived }).where(eq(tournaments.id, t.id)); }
export async function deleteTournament(t: Tournament) { await db().delete(tournaments).where(eq(tournaments.id, t.id)); }

export async function setStaff(t: Tournament, userId: number, role: Role | null) {
  if (role) await db().insert(staff).values({ tournamentId: t.id, userId, role }).onConflictDoUpdate({ target: [staff.tournamentId, staff.userId], set: { role } });
  else {
    const all = await staffOf(t.id);
    if (all.filter((s) => s.role === 'organiser' && s.userId !== userId).length === 0 && all.some((s) => s.userId === userId && s.role === 'organiser')) throw new ServiceError('A tournament needs at least one organiser.', 409);
    await db().delete(staff).where(and(eq(staff.tournamentId, t.id), eq(staff.userId, userId)));
  }
}

// ───────────────────────────── registration ─────────────────────────────

export interface Eligibility { isBooked?: (userId: number) => Promise<boolean> }

/** Why registration isn't possible right now (for everyone), or null. */
export function registrationClosedReason(t: Tournament, now = new Date()): string | null {
  if (t.archived) return 'This tournament is archived.';
  if (t.status !== 'registration_open') return t.status === 'draft' ? 'Registration hasn’t opened yet.' : 'Registration is closed.';
  if (t.regOpensAt && now < t.regOpensAt) return 'Registration hasn’t opened yet.';
  if (t.regClosesAt && now > t.regClosesAt) return 'Registration has closed.';
  return null;
}

async function checkEligible(t: Tournament, userIds: number[], elig: Eligibility, opts: { bypass?: boolean }) {
  if (opts.bypass) return;
  const why = registrationClosedReason(t);
  if (why) throw new ServiceError(why, 403);
  if (t.visibility !== 'public') {
    const invited = new Set((await invitesOf(t.id)).map((i) => i.userId));
    const lead = userIds[0];
    if (!invited.has(lead)) throw new ServiceError('This tournament is invitation only.', 403);
  }
  if (t.requireBooking && t.lanEventId) {
    if (!elig.isBooked) throw new ServiceError('LAN bookings are turned off, so bookings can’t be checked. Ask an organiser.', 503);
    for (const u of userIds) if (!(await elig.isBooked(u))) {
      const name = (await services.users.getById(u))?.username ?? 'Someone';
      throw new ServiceError(userIds.length === 1 ? 'Book a place at the LAN event first.' : `${name} hasn’t booked a place at the LAN event.`, 403);
    }
  }
}

/** Places check inside a transaction with the tournament row locked, so the last place can't be taken twice. */
async function insertEntry(t: Tournament, values: typeof entries.$inferInsert, bypass: boolean) {
  try {
    return await db().transaction(async (tx) => {
      await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, t.id)).for('update');
      if (t.maxEntries && !bypass) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(entries).where(and(eq(entries.tournamentId, t.id), inArray(entries.status, [...ACTIVE_ENTRY])));
        if (n >= t.maxEntries) throw new ServiceError('The tournament is full.', 409, 'full');
      }
      return (await tx.insert(entries).values(values).returning())[0];
    });
  } catch (e: any) {
    if (String(e?.cause?.message ?? e?.message).includes('_uq')) throw new ServiceError('Already registered for this tournament.', 409, 'duplicate');
    throw e;
  }
}

export async function registerSolo(t: Tournament, userId: number, elig: Eligibility, opts: { bypass?: boolean; note?: string } = {}) {
  if (t.mode !== 'solo') throw new ServiceError('This is a team tournament: create or join a team.', 400);
  await checkEligible(t, [userId], elig, opts);
  const u = await services.users.getById(userId);
  if (!u) throw new ServiceError('Member not found.', 404);
  const e = await insertEntry(t, { tournamentId: t.id, userId, name: u.username.slice(0, 60), status: t.requireApproval && !opts.bypass ? 'pending' : 'approved', note: opts.note ?? '' }, !!opts.bypass);
  return e;
}

export async function withdrawEntry(t: Tournament, e: Entry, opts: { byStaff?: boolean } = {}) {
  if (!opts.byStaff && !['registration_open', 'registration_closed'].includes(t.status)) throw new ServiceError('You can’t withdraw once the tournament has started. Ask an organiser.', 403);
  await db().update(entries).set({ status: 'withdrawn' }).where(eq(entries.id, e.id));
}

export async function reviewEntry(e: Entry, approve: boolean) {
  if (e.status !== 'pending' && e.status !== (approve ? 'rejected' : 'approved')) throw new ServiceError('That registration has already been dealt with.', 409);
  await db().update(entries).set({ status: approve ? 'approved' : 'rejected' }).where(eq(entries.id, e.id));
}

export async function invite(t: Tournament, userId: number, by: number) {
  await db().insert(invites).values({ tournamentId: t.id, userId, invitedBy: by }).onConflictDoNothing();
}
export async function uninvite(t: Tournament, userId: number) { await db().delete(invites).where(and(eq(invites.tournamentId, t.id), eq(invites.userId, userId))); }
export async function canSee(t: Tournament, userId: number | null, isStaff: boolean) {
  if (t.visibility !== 'private' || isStaff) return true;
  if (!userId) return false;
  if ((await invitesOf(t.id)).some((i) => i.userId === userId)) return true;
  return !!(await entryOfUser(t, userId));
}

// ───────────────────────────── teams ─────────────────────────────

const teamClosed = (t: Tournament) => ['in_progress', 'completed', 'cancelled'].includes(t.status) || t.archived;

export async function createTeam(t: Tournament, captainId: number, rawName: string, rawTag: string) {
  if (t.mode !== 'team') throw new ServiceError('This tournament is for solo players.', 400);
  if (teamClosed(t)) throw new ServiceError('Teams can’t be created any more.', 403);
  const name = cleanLine(rawName, 60), tag = cleanLine(rawTag, 8).toUpperCase();
  if (name.length < 2) throw new ServiceError('Give the team a name.');
  if (await teamOfUser(t.id, captainId)) throw new ServiceError('You’re already in a team in this tournament.', 409);
  try {
    return await db().transaction(async (tx) => {
      const [team] = await tx.insert(teams).values({ tournamentId: t.id, name, tag, captainId }).returning();
      await tx.insert(teamMembers).values({ teamId: team.id, tournamentId: t.id, userId: captainId, role: 'captain', status: 'active' });
      return team;
    });
  } catch (e: any) {
    if (String(e?.cause?.message ?? e?.message).includes('team_name_uq')) throw new ServiceError('There’s already a team with that name.', 409);
    if (String(e?.cause?.message ?? e?.message).includes('member_uq')) throw new ServiceError('You’re already in a team in this tournament.', 409);
    throw e;
  }
}

const rosterCounts = (ms: { role: string; status: string }[]) => ({
  players: ms.filter((m) => m.status === 'active' && m.role !== 'sub').length,
  subs: ms.filter((m) => m.status === 'active' && m.role === 'sub').length,
  invited: ms.filter((m) => m.status === 'invited').length,
});

export async function inviteToTeam(t: Tournament, team: Team, userId: number, role: 'player' | 'sub') {
  if (teamClosed(t)) throw new ServiceError('Rosters are locked once the tournament starts.', 403);
  const ms = await membersOf(team.id);
  if (ms.some((m) => m.userId === userId)) throw new ServiceError('They’re already on, or invited to, this team.', 409);
  if (await teamOfUser(t.id, userId)) throw new ServiceError('They’re already in another team in this tournament.', 409);
  // pending invitations count too, so a captain can't invite more people than the team can hold
  const c = { players: ms.filter((m) => m.role !== 'sub').length, subs: ms.filter((m) => m.role === 'sub').length };
  if (role === 'sub' && c.subs >= t.subsMax) throw new ServiceError(t.subsMax ? `Teams can have at most ${t.subsMax} substitutes.` : 'This tournament doesn’t allow substitutes.', 409);
  if (role === 'player' && c.players >= t.teamMax) throw new ServiceError(`Teams can have at most ${t.teamMax} players.`, 409);
  await db().insert(teamMembers).values({ teamId: team.id, tournamentId: t.id, userId, role, status: 'invited' });
}

export async function answerInvite(t: Tournament, team: Team, userId: number, accept: boolean) {
  const [m] = await db().select().from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId), eq(teamMembers.status, 'invited')));
  if (!m) throw new ServiceError('That invitation no longer exists.', 404);
  if (!accept) { await db().delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId))); return; }
  if (teamClosed(t)) throw new ServiceError('Rosters are locked once the tournament starts.', 403);
  const c = rosterCounts(await membersOf(team.id));
  if (m.role === 'sub' ? c.subs >= t.subsMax : c.players >= t.teamMax) throw new ServiceError('The team is full.', 409);
  try { await db().update(teamMembers).set({ status: 'active' }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId))); }
  catch (e: any) { if (String(e?.cause?.message ?? e?.message).includes('member_uq')) throw new ServiceError('You’re already in another team in this tournament.', 409); throw e; }
}

export async function removeFromTeam(t: Tournament, team: Team, userId: number, opts: { byStaff?: boolean } = {}) {
  if (teamClosed(t) && !opts.byStaff) throw new ServiceError('Rosters are locked once the tournament starts.', 403);
  if (team.captainId === userId) throw new ServiceError('Hand the captaincy to someone else first, or disband the team.', 409);
  const entry = (await db().select().from(entries).where(and(eq(entries.teamId, team.id), inArray(entries.status, [...ACTIVE_ENTRY]))))[0];
  const ms = await membersOf(team.id);
  const leaving = ms.find((m) => m.userId === userId);
  if (!leaving) throw new ServiceError('They’re not on this team.', 404);
  if (entry && !opts.byStaff && leaving.status === 'active' && leaving.role !== 'sub' && rosterCounts(ms).players - 1 < t.teamMin)
    throw new ServiceError(`A registered team needs at least ${t.teamMin} players. Invite a replacement first.`, 409);
  await db().delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)));
}

export async function setCaptain(team: Team, userId: number) {
  const ms = await membersOf(team.id);
  const m = ms.find((x) => x.userId === userId && x.status === 'active');
  if (!m) throw new ServiceError('The new captain must be an active member of the team.', 409);
  await db().transaction(async (tx) => {
    await tx.update(teamMembers).set({ role: 'player' }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, 'captain')));
    await tx.update(teamMembers).set({ role: 'captain' }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)));
    await tx.update(teams).set({ captainId: userId }).where(eq(teams.id, team.id));
  });
}

export async function disbandTeam(t: Tournament, team: Team, opts: { byStaff?: boolean } = {}) {
  if (teamClosed(t) && !opts.byStaff) throw new ServiceError('Teams can’t be disbanded once the tournament starts.', 403);
  await db().update(entries).set({ status: 'withdrawn' }).where(and(eq(entries.teamId, team.id), inArray(entries.status, [...ACTIVE_ENTRY])));
  await db().delete(teamMembers).where(eq(teamMembers.teamId, team.id));
  await db().delete(teams).where(eq(teams.id, team.id));
}

export async function registerTeam(t: Tournament, team: Team, elig: Eligibility, opts: { bypass?: boolean } = {}) {
  const ms = await membersOf(team.id);
  const c = rosterCounts(ms);
  if (!opts.bypass && c.players < t.teamMin) throw new ServiceError(`A team needs at least ${t.teamMin} players to register (you have ${c.players}).`, 409);
  if (c.players > t.teamMax) throw new ServiceError(`A team can have at most ${t.teamMax} players.`, 409);
  const active = ms.filter((m) => m.status === 'active').map((m) => m.userId);
  await checkEligible(t, [team.captainId!, ...active.filter((u) => u !== team.captainId)], elig, opts);
  return insertEntry(t, { tournamentId: t.id, teamId: team.id, name: team.name, status: t.requireApproval && !opts.bypass ? 'pending' : 'approved' }, !!opts.bypass);
}

// ───────────────────────────── check-in, seeds, stations ─────────────────────────────

export function checkinClosedReason(t: Tournament, now = new Date()): string | null {
  if (!['registration_open', 'registration_closed'].includes(t.status)) return 'Check-in is closed.';
  if (!t.checkinOpensAt) return 'Check-in isn’t open. An organiser will check you in.';
  if (now < t.checkinOpensAt) return 'Check-in hasn’t opened yet.';
  return null;
}
export async function checkIn(t: Tournament, e: Entry, opts: { byStaff?: boolean; undo?: boolean } = {}) {
  if (e.status !== 'approved') throw new ServiceError('Only approved registrations can check in.', 409);
  if (!opts.byStaff) { const why = checkinClosedReason(t); if (why) throw new ServiceError(why, 403); }
  await db().update(entries).set({ checkedInAt: opts.undo ? null : new Date() }).where(eq(entries.id, e.id));
}
export async function setSeedsAndStations(t: Tournament, changes: { entryId: number; seed: number | null; station: string }[]) {
  const mine = new Set((await entriesOf(t.id)).map((e) => e.id));
  for (const c of changes) {
    if (!mine.has(c.entryId)) continue;
    if (c.seed !== null && !between(c.seed, 1, 1024)) throw new ServiceError('Seeds must be 1–1024.');
    await db().update(entries).set({ seed: c.seed, station: cleanLine(c.station, 40) }).where(eq(entries.id, c.entryId));
  }
}

// ───────────────────────────── announcements ─────────────────────────────

export async function announce(t: Tournament, body: string, by: number) {
  const text = cleanText(body, 4000);
  if (text.length < 3) throw new ServiceError('Write the announcement first.');
  await db().insert(announcements).values({ tournamentId: t.id, body: text, createdBy: by });
  await notifyParticipants(t.id, by, `${t.name}: ${text.replace(/\[[^\]]*\]/g, '').slice(0, 160)}`, `/m/lan-tournaments/${t.slug}`);
}

// ───────────────────────────── history and privacy ─────────────────────────────

export async function historyOf(userId: number) {
  return db().select({ r: results, name: tournaments.name, slug: tournaments.slug, game: tournaments.game, at: tournaments.resultsPublishedAt })
    .from(results).innerJoin(tournaments, eq(tournaments.id, results.tournamentId))
    .where(and(eq(results.userId, userId), eq(tournaments.archived, false))).orderBy(desc(tournaments.resultsPublishedAt));
}

export async function exportFor(userId: number) {
  const solo = await db().select({ e: entries, t: tournaments.name }).from(entries).innerJoin(tournaments, eq(tournaments.id, entries.tournamentId)).where(eq(entries.userId, userId));
  const memberships = await db().select({ m: teamMembers, team: teams.name, t: tournaments.name }).from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId)).innerJoin(tournaments, eq(tournaments.id, teamMembers.tournamentId)).where(eq(teamMembers.userId, userId));
  return {
    registrations: solo.map(({ e, t }) => ({ tournament: t, status: e.status, seed: e.seed, checkedIn: e.checkedInAt, station: e.station, registered: e.createdAt })),
    teams: memberships.map(({ m, team, t }) => ({ tournament: t, team, role: m.role, status: m.status, joined: m.createdAt })),
    results: (await historyOf(userId)).map(({ r, name }) => ({ tournament: name, place: r.place, points: r.points, wins: r.wins, losses: r.losses, draws: r.draws, team: r.teamName || null })),
    scoreReports: (await db().select().from(reports).where(eq(reports.reportedBy, userId))).map((r) => ({ match: r.matchId, scoreA: r.scoreA, scoreB: r.scoreB, placements: r.placements, status: r.status, dispute: r.disputeReason || null, when: r.createdAt })),
    challengeAttempts: (await db().select().from(attempts).where(eq(attempts.submittedBy, userId))).map((a) => ({ value: a.value, proof: a.proof, status: a.status, when: a.createdAt })),
    staffRoles: (await db().select({ role: staff.role, t: tournaments.name }).from(staff).innerJoin(tournaments, eq(tournaments.id, staff.tournamentId)).where(eq(staff.userId, userId))),
  };
}

/**
 * Erase: leave tournaments that haven't started, drop team memberships and invitations there, and unlink the member
 * from historical results, reports and attempts (results stay so brackets and standings remain correct).
 */
export async function forget(userId: number) {
  const upcoming = (await db().select({ id: tournaments.id }).from(tournaments).where(inArray(tournaments.status, ['draft', 'registration_open', 'registration_closed']))).map((r) => r.id);
  if (upcoming.length) {
    await db().update(entries).set({ status: 'withdrawn' }).where(and(eq(entries.userId, userId), inArray(entries.tournamentId, upcoming)));
    await db().delete(teamMembers).where(and(eq(teamMembers.userId, userId), inArray(teamMembers.tournamentId, upcoming)));
  }
  await db().delete(invites).where(eq(invites.userId, userId));
  await db().update(entries).set({ userId: null, name: 'Former member' }).where(eq(entries.userId, userId));
  await db().update(results).set({ userId: null, name: 'Former member' }).where(eq(results.userId, userId));
  await db().update(reports).set({ reportedBy: null }).where(eq(reports.reportedBy, userId));
  await db().update(attempts).set({ submittedBy: null }).where(eq(attempts.submittedBy, userId));
  await db().update(teams).set({ captainId: null }).where(eq(teams.captainId, userId));
}
