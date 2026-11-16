/**
 * Community emoji: submission → moderator approval → shared picker.
 * Only `approved` emoji are rendered or listed. Images go through the upload pipeline with the
 * emoji purpose limits (bytes, dimensions, frame count) and are re-encoded to (animated) WebP.
 */
import { and, asc, desc, eq, sql, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { cleanLine } from '../lib/validate.ts';
import { ServiceError } from './users.ts';
import { saveUpload } from './uploads.ts';
import { audit } from './audit.ts';
import { onBus, send } from './bus.ts';
import { notify } from './notifications.ts';
import { enforcePolicy } from './policy.ts';
import { rateLimit } from './forums.ts';
import type { Viewer } from './viewer.ts';

export type Emoji = typeof schema.communityEmoji.$inferSelect;
const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;

let cache: Map<string, string> | null = null;
export function invalidateEmoji() { cache = null; send('invalidate', { name: 'emoji' }); }
onBus('invalidate', (m: { name: string }) => { if (m.name === 'emoji') cache = null; });

/** shortcode → URL for approved emoji (used by the renderer). */
export async function emojiMap(): Promise<Map<string, string>> {
  if (!cache) {
    const rows = await getDb().select({ code: schema.communityEmoji.shortcode, pid: schema.uploads.publicId }).from(schema.communityEmoji)
      .innerJoin(schema.uploads, eq(schema.uploads.id, schema.communityEmoji.uploadId)).where(eq(schema.communityEmoji.status, 'approved'));
    cache = new Map(rows.map((r) => [r.code, `/media/${r.pid}`]));
  }
  return cache;
}

export async function approvedEmoji() {
  return getDb().select({ shortcode: schema.communityEmoji.shortcode, name: schema.communityEmoji.name, category: schema.communityEmoji.category, keywords: schema.communityEmoji.keywords, animated: schema.communityEmoji.animated, pid: schema.uploads.publicId })
    .from(schema.communityEmoji).innerJoin(schema.uploads, eq(schema.uploads.id, schema.communityEmoji.uploadId))
    .where(eq(schema.communityEmoji.status, 'approved')).orderBy(asc(schema.communityEmoji.category), asc(schema.communityEmoji.shortcode));
}

export async function submitEmoji(v: Viewer, input: { shortcode: string; name: string; description?: string; keywords?: string; file: Buffer; fileName: string }, opts: { autoApprove?: boolean; category?: string } = {}): Promise<Emoji> {
  await v.require('emoji.submit');
  if (!opts.autoApprove) await rateLimit(v, 'emoji_submit');
  const shortcode = input.shortcode.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!SHORTCODE_RE.test(shortcode)) throw new ServiceError('Shortcodes must be 2–32 characters: lowercase letters, numbers and underscores.');
  const name = cleanLine(input.name, 60);
  if (name.length < 2) throw new ServiceError('Give your emoji a name.');
  await enforcePolicy(`${shortcode} ${name} ${input.description ?? ''} ${input.keywords ?? ''}`, { userId: v.user!.id, contentType: 'emoji' });
  const db = getDb();
  const [taken] = await db.select().from(schema.communityEmoji).where(and(eq(schema.communityEmoji.shortcode, shortcode), inArray(schema.communityEmoji.status, ['pending', 'approved'])));
  if (taken) throw new ServiceError(`:${shortcode}: is already taken or awaiting review.`);
  const upload = await saveUpload(v.user!.id, 'emoji', input.file, input.fileName);
  // duplicate detection by source-image hash
  const [dupe] = await db.select({ code: schema.communityEmoji.shortcode }).from(schema.communityEmoji).where(and(eq(schema.communityEmoji.sha256, upload.sha256), inArray(schema.communityEmoji.status, ['pending', 'approved'])));
  if (dupe) throw new ServiceError(`This image already exists as :${dupe.code}:.`);
  const [e] = await db.insert(schema.communityEmoji).values({
    shortcode, name, description: cleanLine(input.description, 200), keywords: cleanLine(input.keywords, 200), category: opts.category ?? 'community',
    uploadId: upload.id, animated: upload.animated, status: opts.autoApprove ? 'approved' : 'pending', submittedById: v.user!.id, sha256: upload.sha256,
    reviewedById: opts.autoApprove ? v.user!.id : null, reviewedAt: opts.autoApprove ? new Date() : null,
  }).returning();
  if (opts.autoApprove) { invalidateEmoji(); await audit(v.user!.id, 'emoji.create', { type: 'emoji', id: e.id }, { shortcode }, v.ip); }
  return e;
}

export async function reviewEmoji(v: Viewer, id: number, decision: 'approve' | 'reject' | 'disable' | 'enable', reason = '') {
  await v.require('mod.emoji');
  const db = getDb();
  const [e] = await db.select().from(schema.communityEmoji).where(eq(schema.communityEmoji.id, id));
  if (!e) throw new ServiceError('Emoji not found.', 404);
  const status = { approve: 'approved', reject: 'rejected', disable: 'disabled', enable: 'approved' }[decision];
  if (decision === 'reject' && reason.trim().length < 3) throw new ServiceError('Give a reason for rejecting this emoji.');
  if ((decision === 'approve' && e.status !== 'pending') || (decision === 'enable' && e.status !== 'disabled')) throw new ServiceError('This emoji cannot be changed that way.');
  if (decision === 'enable' || decision === 'approve') {
    const [clash] = await db.select().from(schema.communityEmoji).where(and(eq(schema.communityEmoji.shortcode, e.shortcode), eq(schema.communityEmoji.status, 'approved')));
    if (clash && clash.id !== e.id) throw new ServiceError(`:${e.shortcode}: is already in use.`);
  }
  await db.update(schema.communityEmoji).set({ status, reviewedById: v.user!.id, reviewedAt: new Date(), rejectionReason: decision === 'reject' ? cleanLine(reason, 300) : e.rejectionReason }).where(eq(schema.communityEmoji.id, id));
  invalidateEmoji();
  await audit(v.user!.id, `emoji.${decision}`, { type: 'emoji', id }, { shortcode: e.shortcode, reason }, v.ip);
  if (e.submittedById && (decision === 'approve' || decision === 'reject')) {
    await notify(e.submittedById, 'moderation', v.user!.id, decision === 'approve' ? `Your emoji :${e.shortcode}: was approved and is now available to everyone.` : `Your emoji :${e.shortcode}: was not approved: ${cleanLine(reason, 200)}`, '/emoji');
  }
}

export async function emojiQueue(status = 'pending') {
  return getDb().select({ e: schema.communityEmoji, pid: schema.uploads.publicId, w: schema.uploads.width, h: schema.uploads.height, bytes: schema.uploads.bytes, submitter: schema.users.username })
    .from(schema.communityEmoji).innerJoin(schema.uploads, eq(schema.uploads.id, schema.communityEmoji.uploadId)).leftJoin(schema.users, eq(schema.users.id, schema.communityEmoji.submittedById))
    .where(eq(schema.communityEmoji.status, status)).orderBy(desc(schema.communityEmoji.createdAt)).limit(200);
}

export async function mySubmissions(userId: number) {
  return getDb().select({ e: schema.communityEmoji, pid: schema.uploads.publicId }).from(schema.communityEmoji).innerJoin(schema.uploads, eq(schema.uploads.id, schema.communityEmoji.uploadId))
    .where(eq(schema.communityEmoji.submittedById, userId)).orderBy(desc(schema.communityEmoji.createdAt)).limit(50);
}

export async function countUsage(codes: string[]) {
  if (!codes.length) return;
  await getDb().update(schema.communityEmoji).set({ usageCount: sql`${schema.communityEmoji.usageCount} + 1` }).where(and(inArray(schema.communityEmoji.shortcode, codes.slice(0, 20)), eq(schema.communityEmoji.status, 'approved')));
}
