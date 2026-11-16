import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, client } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { audit, securityEvent } from '../src/services/audit.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { auditLabel, securityLabel, humanise } from '../src/web/log-labels.ts';

beforeAll(setupDb);
afterAll(teardownDb);

let adminC: ReturnType<typeof client>;
let target: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  const admin = await makeUser({ username: 'LogAdmin', group: 'admin' });
  const mod = await makeUser({ username: 'LogMod', group: 'moderator' });
  target = await makeUser({ username: 'LogTarget' });
  const old = new Date('2026-01-05T12:00:00Z');
  await audit(mod.id, 'user.warn', { type: 'user', id: target.id }, { reason: 'Spam links' }, '10.1.1.1');
  await audit(mod.id, 'user.suspend', { type: 'user', id: target.id }, { reason: 'Repeated spam' }, '10.1.1.1');
  await audit(admin.id, 'group.update', { type: 'group', id: 2 }, { permissions: ['post.reply'] }, '10.2.2.2');
  await audit(admin.id, 'settings.update', {}, { keys: ['=HYPERLINK("http://evil")'] }, '10.2.2.2');
  await getDb().insert(schema.auditLog).values({ actorId: mod.id, action: 'post.delete', targetType: 'post', targetId: 77, detail: { reason: 'old' }, ip: '10.1.1.1', createdAt: old });
  await securityEvent(target.id, 'login', { ip: '203.0.113.5', provider: 'password' });
  await securityEvent(target.id, 'login_failed', { ip: '203.0.113.5', provider: 'password', detail: { login: 'logtarget' } });
  await securityEvent(null, 'login_failed', { ip: '198.51.100.9', provider: 'password', detail: { login: 'admin' } });
  await securityEvent(target.id, 'provider_linked', { ip: '203.0.113.5', provider: 'discord' });
  resetLimits();
  adminC = client();
  await adminC.login('LogAdmin');
});

const rowsIn = (html: string) => (html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr/g) ?? []).length;
const count = (html: string) => Number(/class="flt-count">([\d,]+)/.exec(html)?.[1].replace(/,/g, '') ?? -1);

describe('labels', () => {
  it('has readable names and falls back sensibly', () => {
    expect(auditLabel('user.suspend')).toBe('Suspended a member');
    expect(securityLabel('login_failed')).toBe('Failed sign-in');
    expect(auditLabel('brand_new.thing')).toBe('Brand new thing');
    expect(humanise('oauth_failed')).toBe('Oauth failed');
  });
});

describe('audit log filters', () => {
  it('lists everything by default with readable labels and filter buttons', async () => {
    const r = await adminC.get('/admin/audit');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Suspended a member');
    expect(r.text).toContain('<optgroup label="Member moderation">');
    expect(r.text).toContain('aria-label="Add filter: done by LogMod"');
    expect(r.text).toContain('No filters — showing everything.');
  });

  it('combines filters with AND and shows one removable chip per filter', async () => {
    const r = await adminC.get(`/admin/audit?category=members&actor=LogMod&member=LogTarget`);
    expect(count(r.text)).toBe(2);
    expect(rowsIn(r.text)).toBe(2);
    expect(r.text).toContain('Area: Member moderation');
    expect(r.text).toContain('Done by: LogMod');
    expect(r.text).toContain('Affected member: LogTarget');
    // each chip's remove link drops only that filter
    const removeArea = /href="([^"]+)" class="chip-remove" aria-label="Remove filter Area: Member moderation"/.exec(r.text)![1].replace(/&amp;/g, '&');
    expect(removeArea).not.toContain('category=');
    expect(removeArea).toContain('actor=LogMod');
    const narrower = await adminC.get(`/admin/audit?category=members&action=user.suspend`);
    expect(count(narrower.text)).toBe(1);
  });

  it('filters by date range, IP and detail text', async () => {
    expect(count((await adminC.get('/admin/audit?to=2026-01-31')).text)).toBe(1);
    expect(count((await adminC.get('/admin/audit?from=2026-01-01&to=2026-01-31&action=post.delete')).text)).toBe(1);
    expect(count((await adminC.get('/admin/audit?ip=10.2.2')).text)).toBe(2);
    expect(count((await adminC.get('/admin/audit?q=repeated')).text)).toBe(1);
  });

  it('ignores values that are not offered and says when a username is unknown', async () => {
    const bogus = await adminC.get('/admin/audit?action=drop%20table&category=nope&from=yesterday');
    expect(bogus.text).toContain('No filters — showing everything.');
    const unknown = await adminC.get('/admin/audit?member=NoSuchPerson');
    expect(unknown.text).toContain('No member with that username');
    expect(count(unknown.text)).toBe(0);
  });

  it('exports the filtered rows as CSV, neutralising formulas, and records the export', async () => {
    const r = await adminC.get('/admin/audit.csv?actor=LogAdmin');
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('time_utc,actor,action_code');
    expect(lines.length).toBe(3); // header + group.update + settings.update
    // no cell may start with a formula character
    for (const line of lines) expect(line).not.toMatch(/(^|,)[=+\-@]/);
    const { csvCell } = await import('../src/routes/admin-logs.tsx');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain, with comma')).toBe('"plain, with comma"');
    const exp = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'audit.export'));
    expect(exp).toHaveLength(1);
  });
});

describe('security event filters', () => {
  it('filters by category, member, method and severity', async () => {
    expect(count((await adminC.get('/admin/security?member=LogTarget')).text)).toBe(3);
    expect(count((await adminC.get('/admin/security?category=failures')).text)).toBe(2);
    expect(count((await adminC.get('/admin/security?severity=warning&member=LogTarget')).text)).toBe(1);
    expect(count((await adminC.get('/admin/security?provider=discord')).text)).toBe(1);
    expect(count((await adminC.get('/admin/security?q=admin&kind=login_failed')).text)).toBe(1);
    const r = await adminC.get('/admin/security?category=failures');
    expect(r.text).toContain('Warning: </span>Failed sign-in');
    expect(r.text).toContain('Last 24 h:');
  });

  it('exports security events as CSV', async () => {
    const r = await adminC.get('/admin/security.csv?category=failures');
    expect(r.text.trim().split('\r\n')).toHaveLength(3);
    expect(r.text).toContain('Failed sign-in');
  });
});

describe('access', () => {
  it('moderators and members cannot view or export logs', async () => {
    resetLimits();
    const m = client(); await m.login('LogMod');
    for (const p of ['/admin/audit', '/admin/security', '/admin/audit.csv', '/admin/security.csv']) expect((await m.get(p)).status, p).toBe(403);
    expect((await client().get('/admin/audit.csv')).status).toBe(401);
  });
});
