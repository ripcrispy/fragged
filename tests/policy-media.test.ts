import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, viewerFor, makeForum } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { saveTerm } from '../src/services/moderation.ts';
import { createThread } from '../src/services/forums.ts';
import { textFilterFor } from '../src/services/policy.ts';
import { processImage } from '../src/services/uploads.ts';
import * as E from '../src/services/emoji.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { ServiceError } from '../src/services/users.ts';

beforeAll(setupDb);
afterAll(teardownDb);

describe('restricted terms vs profanity preference', () => {
  it('mandatory terms apply regardless of the profanity setting, and changes are audited', async () => {
    const admin = await makeUser({ group: 'admin' });
    const forum = await makeForum('Policy');
    await saveTerm(await viewerFor(admin.id), { pattern: 'forbiddenword', matchType: 'word', category: 'slur', action: 'block', isActive: true });
    await saveTerm(await viewerFor(admin.id), { pattern: 'heldword', matchType: 'word', category: 'harassment', action: 'hold', isActive: true });
    const u = await makeUser();
    await getDb().update(schema.userSettings).set({ profanityFilter: false }).where(eq(schema.userSettings.userId, u.id));
    await expect(createThread(await viewerFor(u.id), forum, { title: 'Bad', body: 'this has f0rbiddenw0rd in it' })).rejects.toMatchObject({ code: 'restricted' });
    resetLimits();
    const { thread } = await createThread(await viewerFor(u.id), forum, { title: 'Held', body: 'this has heldword in it' });
    expect(thread.state).toBe('held');
    const matches = await getDb().select().from(schema.restrictedTermMatches);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'term.create'));
    expect(audit).toHaveLength(2);
    // the audit log does not store the sensitive term text
    expect(JSON.stringify(audit)).not.toContain('forbiddenword');
    // display redaction applies even with profanity filter off
    const f = await textFilterFor(false);
    expect(f('old forbiddenword post')).toBe('old [removed] post');
    expect(f('darn shit')).toBe('darn shit');
    expect((await textFilterFor(true))('darn shit')).toBe('darn s***');
  });
  it('only admins can manage terms', async () => {
    const mod = await makeUser({ group: 'moderator' });
    await expect(saveTerm(await viewerFor(mod.id), { pattern: 'x', matchType: 'word', category: 'x', action: 'block', isActive: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe('image processing', () => {
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#e8772e' } }).png().toBuffer();
  it('re-encodes valid images to WebP within bounds', async () => {
    const r = await processImage(await png(800, 600), 'avatar');
    expect(r.width).toBe(256); expect(r.height).toBe(256);
    expect((await sharp(r.data).metadata()).format).toBe('webp');
  });
  it('rejects SVG, HTML, non-images and oversized images', async () => {
    await expect(processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'post')).rejects.toBeInstanceOf(ServiceError);
    await expect(processImage(Buffer.from('<html><body>hi</body></html>'), 'post')).rejects.toBeInstanceOf(ServiceError);
    await expect(processImage(Buffer.from('MZ\x90\x00 not an image at all'), 'post')).rejects.toBeInstanceOf(ServiceError);
    await expect(processImage(await png(600, 600), 'emoji')).rejects.toThrow(/at most 512/);
  });
  it('strips metadata', async () => {
    const withExif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } }).toBuffer();
    const r = await processImage(withExif, 'post');
    expect((await sharp(r.data).metadata()).exif).toBeUndefined();
  });
});

describe('community emoji', () => {
  it('requires approval before appearing and supports rejection with reason', async () => {
    const est = await makeUser({ group: 'established' });
    const mod = await makeUser({ group: 'moderator' });
    const img = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#5bb974' } }).png().toBuffer();
    const e = await E.submitEmoji(await viewerFor(est.id), { shortcode: 'testgreen', name: 'Green', file: img, fileName: 'g.png' });
    expect(e.status).toBe('pending');
    expect((await E.emojiMap()).has('testgreen')).toBe(false);
    await expect(E.reviewEmoji(await viewerFor(est.id), e.id, 'approve')).rejects.toMatchObject({ status: 403 });
    await E.reviewEmoji(await viewerFor(mod.id), e.id, 'approve');
    expect((await E.emojiMap()).has('testgreen')).toBe(true);
    const img2 = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#3a8dde' } }).png().toBuffer();
    resetLimits();
    const e2 = await E.submitEmoji(await viewerFor(est.id), { shortcode: 'testblue', name: 'Blue', file: img2, fileName: 'b.png' });
    await expect(E.reviewEmoji(await viewerFor(mod.id), e2.id, 'reject')).rejects.toThrow(/reason/);
    await E.reviewEmoji(await viewerFor(mod.id), e2.id, 'reject', 'Too similar to existing');
    expect((await E.emojiMap()).has('testblue')).toBe(false);
  });
  it('rejects duplicates and new members', async () => {
    const est = await makeUser({ group: 'established' });
    const member = await makeUser();
    const img = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#c95de0' } }).png().toBuffer();
    await expect(E.submitEmoji(await viewerFor(member.id), { shortcode: 'nope_new', name: 'Nope', file: img, fileName: 'n.png' })).rejects.toMatchObject({ status: 403 });
    resetLimits();
    await E.submitEmoji(await viewerFor(est.id), { shortcode: 'dupe_one', name: 'Dupe', file: img, fileName: 'd.png' });
    resetLimits();
    await expect(E.submitEmoji(await viewerFor(est.id), { shortcode: 'dupe_two', name: 'Dupe', file: img, fileName: 'd.png' })).rejects.toThrow(/already exists/);
  });
});
