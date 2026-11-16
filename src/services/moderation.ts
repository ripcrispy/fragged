import { and, desc, eq, isNull, sql, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { cleanLine, cleanText } from '../lib/validate.ts';
import { ServiceError, getUserById } from './users.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { revokeAllSessions } from './auth.ts';
import { rateLimit, postById, threadById } from './forums.ts';
import { invalidatePolicy } from './policy.ts';
import { emit } from '../modules/registry.ts';
import type { Viewer } from './viewer.ts';

export const REPORT_REASONS = { spam: 'Spam or advertising', harassment: 'Harassment or bullying', hate: 'Hate speech or slurs', nsfw: 'Unlabelled NSFW / explicit content', spoiler: 'Unmarked spoilers', illegal: 'Illegal content', impersonation: 'Impersonation', other: 'Something else' } as const;
const TARGETS = ['post', 'thread', 'profile_comment', 'user', 'message', 'emoji'] as const;

export async function createReport(v: Viewer, input: { targetType: string; targetId: number; reason: string; details?: string }) {
  await v.require('report.create');
  await rateLimit(v, 'report');
  if (!(TARGETS as readonly string[]).includes(input.targetType)) throw new ServiceError('Invalid report.');
  if (!(input.reason in REPORT_REASONS)) throw new ServiceError('Choose a reason.');
  const db = getDb();
  // validate the reporter can see the target
  if (input.targetType === 'message') {
    const rows = await db.execute(sql`select 1 from direct_messages m join conversation_participants p on p.conversation_id = m.conversation_id where m.id = ${input.targetId} and p.user_id = ${v.user!.id} and m.sender_id <> ${v.user!.id}`);
    if (!((rows as any).rows ?? rows).length) throw new ServiceError('Message not found.', 404);
  } else if (input.targetType === 'post') {
    const { loadPostFor } = await import('./forums.ts');
    await loadPostFor(v, input.targetId);
  } else if (input.targetType === 'thread') {
    const { loadThreadFor } = await import('./forums.ts');
    await loadThreadFor(v, input.targetId);
  }
  const [dup] = await db.select().from(schema.reports).where(and(eq(schema.reports.reporterId, v.user!.id), eq(schema.reports.targetType, input.targetType), eq(schema.reports.targetId, input.targetId), eq(schema.reports.status, 'open')));
  if (dup) return dup;
  const [r] = await db.insert(schema.reports).values({ reporterId: v.user!.id, targetType: input.targetType, targetId: input.targetId, reason: input.reason, details: cleanText(input.details, 2000) }).returning();
  await emit('report.created', { reportId: r.id, targetType: r.targetType, targetId: r.targetId, reporterId: v.user!.id });
  return r;
}

export async function reportQueue(status = 'open', limit = 100) {
  const rows = await getDb().select({ r: schema.reports, reporter: schema.users.username }).from(schema.reports).leftJoin(schema.users, eq(schema.users.id, schema.reports.reporterId))
    .where(eq(schema.reports.status, status)).orderBy(desc(schema.reports.createdAt)).limit(limit);
  return rows;
}

/** Describe a report target for the queue (never exposes DM text without the audited view). */
export async function describeTarget(type: string, id: number): Promise<{ label: string; url: string | null; ownerId: number | null }> {
  const db = getDb();
  if (type === 'post') { const p = await postById(id); if (!p) return { label: 'Deleted post', url: null, ownerId: null }; const t = await threadById(p.threadId); return { label: `Post #${p.position} in “${t?.title}”`, url: `/p/${id}`, ownerId: p.userId }; }
  if (type === 'thread') { const t = await threadById(id); return { label: t ? `Thread “${t.title}”` : 'Deleted thread', url: t ? `/t/${t.id}-${t.slug}` : null, ownerId: t?.userId ?? null }; }
  if (type === 'user') { const u = await getUserById(id); return { label: u ? `Member ${u.username}` : 'Member', url: u ? `/u/${encodeURIComponent(u.username)}` : null, ownerId: id }; }
  if (type === 'profile_comment') { const [c] = await db.select().from(schema.profileComments).where(eq(schema.profileComments.id, id)); const u = c ? await getUserById(c.profileUserId) : null; return { label: 'Profile comment', url: u ? `/u/${encodeURIComponent(u.username)}#comment-${id}` : null, ownerId: c?.authorId ?? null }; }
  if (type === 'message') { const [m] = await db.select({ s: schema.directMessages.senderId }).from(schema.directMessages).where(eq(schema.directMessages.id, id)); return { label: 'Direct message (open the audited review to read it)', url: `/mod/messages/${id}`, ownerId: m?.s ?? null }; }
  if (type === 'emoji') return { label: 'Emoji', url: '/mod/emoji', ownerId: null };
  return { label: type, url: null, ownerId: null };
}

export async function resolveReport(v: Viewer, id: number, status: 'resolved' | 'dismissed', note: string) {
  await v.require('mod.reports');
  const upd = await getDb().update(schema.reports).set({ status, handledById: v.user!.id, handledAt: new Date(), resolutionNote: cleanLine(note, 500) || null }).where(and(eq(schema.reports.id, id), eq(schema.reports.status, 'open'))).returning();
  if (!upd.length) throw new ServiceError('Report not found or already handled.', 404);
  await audit(v.user!.id, `report.${status}`, { type: 'report', id }, { note }, v.ip);
}

export async function warnUser(v: Viewer, userId: number, reason: string, points = 1, days = 90) {
  await v.require('mod.users');
  const target = await assertModeratable(v, userId);
  const r = cleanText(reason, 1000).trim();
  if (r.length < 5) throw new ServiceError('Give a reason for the warning.');
  await getDb().insert(schema.userWarnings).values({ userId, issuedById: v.user!.id, reason: r, points: Math.max(0, Math.min(10, points)), expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000) : null });
  await audit(v.user!.id, 'user.warn', { type: 'user', id: userId }, { reason: r, points }, v.ip);
  await notify(target.id, 'moderation', v.user!.id, `You received a warning from the moderation team: ${r.slice(0, 200)}`, '/settings/account');
}

async function assertModeratable(v: Viewer, userId: number) {
  const target = await getUserById(userId);
  if (!target) throw new ServiceError('Member not found.', 404);
  if (target.id === v.user!.id) throw new ServiceError('You cannot moderate yourself.');
  const { subjectFor } = await import('./users.ts');
  const ts = await subjectFor(target);
  if (ts.isSuperAdmin && !v.subject.isSuperAdmin) throw new ServiceError('You cannot moderate an administrator.', 403);
  return target;
}

export async function suspendUser(v: Viewer, userId: number, reason: string, days: number | null) {
  const permanent = days == null || days <= 0;
  await v.require(permanent ? 'mod.ban' : 'mod.users');
  const target = await assertModeratable(v, userId);
  const r = cleanText(reason, 1000).trim();
  if (r.length < 5) throw new ServiceError('Give a reason.');
  const expiresAt = permanent ? null : new Date(Date.now() + Math.min(days!, 3650) * 86400_000);
  await getDb().insert(schema.userBans).values({ userId, issuedById: v.user!.id, kind: permanent ? 'ban' : 'suspension', reason: r, expiresAt });
  await revokeAllSessions(userId);
  await audit(v.user!.id, permanent ? 'user.ban' : 'user.suspend', { type: 'user', id: userId }, { reason: r, days }, v.ip);
  await notify(target.id, 'moderation', v.user!.id, permanent ? `Your account has been banned: ${r.slice(0, 200)}` : `Your account is suspended until ${expiresAt!.toISOString().slice(0, 10)}: ${r.slice(0, 200)}`, '/');
}

export async function liftBan(v: Viewer, banId: number) {
  await v.require('mod.users');
  const [b] = await getDb().update(schema.userBans).set({ liftedAt: new Date(), liftedById: v.user!.id }).where(and(eq(schema.userBans.id, banId), isNull(schema.userBans.liftedAt))).returning();
  if (!b) throw new ServiceError('Restriction not found.', 404);
  if (b.kind === 'ban') await v.require('mod.ban');
  await audit(v.user!.id, 'user.unban', { type: 'user', id: b.userId }, { banId }, v.ip);
  await notify(b.userId, 'moderation', v.user!.id, 'A restriction on your account has been lifted.', '/');
  return b.userId;
}

export async function addNote(v: Viewer, userId: number, note: string) {
  await v.require('mod.users');
  const n = cleanText(note, 2000).trim();
  if (!n) throw new ServiceError('Note is empty.');
  await getDb().insert(schema.moderatorNotes).values({ userId, authorId: v.user!.id, note: n });
  await audit(v.user!.id, 'user.note', { type: 'user', id: userId }, {}, v.ip);
}

export async function moderationHistory(userId: number) {
  const db = getDb();
  const [warnings, bans, notes, actions] = await Promise.all([
    db.select().from(schema.userWarnings).where(eq(schema.userWarnings.userId, userId)).orderBy(desc(schema.userWarnings.createdAt)),
    db.select().from(schema.userBans).where(eq(schema.userBans.userId, userId)).orderBy(desc(schema.userBans.createdAt)),
    db.select().from(schema.moderatorNotes).where(eq(schema.moderatorNotes.userId, userId)).orderBy(desc(schema.moderatorNotes.createdAt)),
    db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetType, 'user'), eq(schema.auditLog.targetId, userId))).orderBy(desc(schema.auditLog.createdAt)).limit(50),
  ]);
  return { warnings, bans, notes, actions };
}

export async function heldContent() {
  const db = getDb();
  const posts = await db.select({ p: schema.posts, t: schema.threads, u: schema.users.username }).from(schema.posts).innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId)).innerJoin(schema.users, eq(schema.users.id, schema.posts.userId))
    .where(and(eq(schema.posts.state, 'held'), eq(schema.posts.isDeleted, false))).orderBy(desc(schema.posts.createdAt)).limit(100);
  const comments = await db.select().from(schema.profileComments).where(and(eq(schema.profileComments.state, 'held'), eq(schema.profileComments.isDeleted, false))).limit(100);
  return { posts, comments };
}

export async function approveComment(v: Viewer, id: number, approve: boolean) {
  await v.require('mod.comments');
  const db = getDb();
  if (approve) await db.update(schema.profileComments).set({ state: 'visible' }).where(eq(schema.profileComments.id, id));
  else await db.update(schema.profileComments).set({ isDeleted: true, deletedById: v.user!.id }).where(eq(schema.profileComments.id, id));
  await audit(v.user!.id, approve ? 'profile_comment.approve' : 'profile_comment.reject', { type: 'profile_comment', id }, {}, v.ip);
}

export async function termMatches(status = 'pending') {
  return getDb().select({ m: schema.restrictedTermMatches, term: schema.restrictedTerms.pattern, category: schema.restrictedTerms.category, username: schema.users.username })
    .from(schema.restrictedTermMatches).leftJoin(schema.restrictedTerms, eq(schema.restrictedTerms.id, schema.restrictedTermMatches.termId)).leftJoin(schema.users, eq(schema.users.id, schema.restrictedTermMatches.userId))
    .where(eq(schema.restrictedTermMatches.reviewStatus, status)).orderBy(desc(schema.restrictedTermMatches.createdAt)).limit(200);
}

export async function reviewTermMatch(v: Viewer, id: number, outcome: 'upheld' | 'false_positive') {
  await v.require('mod.terms_review');
  const upd = await getDb().update(schema.restrictedTermMatches).set({ reviewStatus: outcome, reviewedById: v.user!.id, reviewedAt: new Date() }).where(eq(schema.restrictedTermMatches.id, id)).returning();
  if (!upd.length) throw new ServiceError('Match not found.', 404);
  await audit(v.user!.id, 'term_match.review', { type: 'term_match', id }, { outcome }, v.ip);
}

export async function saveTerm(v: Viewer, input: { id?: number; pattern: string; matchType: string; category: string; action: string; isActive: boolean; notes?: string }) {
  await v.require('admin.terms');
  const { validateRegex } = await import('./policy.ts');
  const pattern = input.pattern.trim();
  if (!pattern || pattern.length > 200) throw new ServiceError('Enter a term (max 200 characters).');
  if (!['word', 'phrase', 'regex'].includes(input.matchType)) throw new ServiceError('Invalid match type.');
  if (!['block', 'hold', 'flag', 'redact'].includes(input.action)) throw new ServiceError('Invalid action.');
  if (input.matchType === 'regex') { const e = validateRegex(pattern); if (e) throw new ServiceError(e); }
  const values = { pattern, matchType: input.matchType, category: cleanLine(input.category, 32) || 'other', action: input.action, isActive: input.isActive, notes: cleanText(input.notes, 500), updatedAt: new Date() };
  const db = getDb();
  let id = input.id;
  if (id) await db.update(schema.restrictedTerms).set(values).where(eq(schema.restrictedTerms.id, id));
  else id = (await db.insert(schema.restrictedTerms).values({ ...values, createdById: v.user!.id }).returning())[0].id;
  invalidatePolicy();
  // the audit log records the change but not the term text itself (sensitive list)
  await audit(v.user!.id, input.id ? 'term.update' : 'term.create', { type: 'term', id }, { action: input.action, matchType: input.matchType, isActive: input.isActive }, v.ip);
  return id;
}

export async function deleteTerm(v: Viewer, id: number) {
  await v.require('admin.terms');
  await getDb().delete(schema.restrictedTerms).where(eq(schema.restrictedTerms.id, id));
  invalidatePolicy();
  await audit(v.user!.id, 'term.delete', { type: 'term', id }, {}, v.ip);
}

export const _x = { inArray };
