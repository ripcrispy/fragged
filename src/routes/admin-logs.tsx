/**
 * Audit log and security-event viewers.
 *
 * Filters are declared once (FilterDef) and drive: the labelled dropdowns/inputs, the "active filter" chips (each
 * removable on its own), quick presets, the SQL conditions, pagination links and CSV export. Everything is a plain
 * GET form, so it works without JavaScript and every combination has a shareable URL.
 */
import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Notice, Pagination, Time, UserLink, EmptyState } from '../web/components.tsx';
import { getDb, schema } from '../db/client.ts';
import { getUserByUsername, userCards, getUserById } from '../services/users.ts';
import { audit } from '../services/audit.ts';
import { rowsOf } from '../services/notifications.ts';
import type { Perm } from '../services/permissions.ts';
import { numberFmt } from '../lib/time.ts';
import {
  AUDIT_ACTIONS, AUDIT_CATEGORIES, SECURITY_CATEGORIES, SECURITY_KINDS, TARGET_TYPES, PROVIDER_NAMES,
  auditLabel, securityLabel, humanise, codesInCategory, type LabelDef,
} from '../web/log-labels.ts';

export const logRoutes = new Hono<Env>();

type Values = Record<string, string>;
interface Option { value: string; label: string; group?: string }
interface FilterDef {
  key: string;
  label: string;
  kind: 'select' | 'text' | 'date' | 'member' | 'number';
  hint?: string;
  options?: Option[];
  /** text shown in the active-filter chip */
  display?: (v: string) => string;
}
interface Preset { label: string; values: Values }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

function readValues(c: C, defs: FilterDef[]): Values {
  const v: Values = {};
  for (const d of [...defs, { key: 'sort' }, { key: 'per' }] as FilterDef[]) {
    const raw = (c.req.query(d.key) ?? '').trim().slice(0, 120);
    if (!raw) continue;
    if (d.kind === 'date' && !DATE_RE.test(raw)) continue;
    if (d.kind === 'number' && !/^\d{1,10}$/.test(raw)) continue;
    if (d.kind === 'select' && d.options && !d.options.some((o) => o.value === raw)) continue;
    v[d.key] = raw;
  }
  return v;
}

function href(base: string, values: Values, patch: Values = {}, drop: string[] = []): string {
  const merged = { ...values, ...patch };
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries(merged)) if (val && !drop.includes(k)) q.set(k, val);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

function groupedOptions(defs: Record<string, LabelDef>, categories: Record<string, string>, seen: string[]): Option[] {
  const opts: Option[] = Object.entries(defs).map(([value, d]) => ({ value, label: d.label, group: categories[d.category] }));
  for (const code of seen) if (!defs[code]) opts.push({ value: code, label: humanise(code), group: 'Other' });
  const order = [...Object.values(categories), 'Other'];
  return opts.sort((a, b) => order.indexOf(a.group!) - order.indexOf(b.group!) || a.label.localeCompare(b.label));
}

/** Filter-by-this button shown next to values in the table. */
function AddFilter({ base, values, k, v, label }: { base: string; values: Values; k: string; v: string; label: string }) {
  if (values[k] === v) return null;
  return <a class="add-filter" href={href(base, values, { [k]: v }, ['page'])} title={`Filter by ${label}`} aria-label={`Add filter: ${label}`}>
    <span class="ico ico-filter" aria-hidden="true" /></a>;
}

function FilterBar({ base, defs, values, presets, total, exportHref, chipText }: {
  base: string; defs: FilterDef[]; values: Values; presets: Preset[]; total: number; exportHref: string; chipText: (d: FilterDef, v: string) => string;
}) {
  const active = defs.filter((d) => values[d.key]);
  const advancedOpen = defs.some((d) => d.kind !== 'select' && values[d.key] && d.key !== 'from' && d.key !== 'to');
  const field = (d: FilterDef) => {
    const id = `flt-${d.key}`;
    const val = values[d.key] ?? '';
    let control;
    if (d.kind === 'select') {
      const groups = [...new Set((d.options ?? []).map((o) => o.group ?? ''))];
      control = <select id={id} name={d.key}>
        <option value="">Any</option>
        {groups.map((g) => {
          const items = (d.options ?? []).filter((o) => (o.group ?? '') === g).map((o) => <option value={o.value} selected={o.value === val}>{o.label}</option>);
          return g ? <optgroup label={g}>{items}</optgroup> : items;
        })}
      </select>;
    } else if (d.kind === 'member') {
      control = <input id={id} name={d.key} value={val} placeholder="Username" autocomplete="off" maxlength={32} list={`${id}-list`} data-member-autocomplete />;
    } else {
      control = <input id={id} name={d.key} value={val} type={d.kind === 'date' ? 'date' : d.kind === 'number' ? 'number' : 'search'} min={d.kind === 'number' ? 1 : undefined} />;
    }
    return <div class="field flt-field">
      <label for={id}>{d.label}</label>{control}
      {d.kind === 'member' ? <datalist id={`${id}-list`} /> : null}
      {d.hint ? <span class="field-hint">{d.hint}</span> : null}
    </div>;
  };
  const primary = defs.filter((d) => d.kind === 'select' || d.kind === 'member' || d.kind === 'date');
  const advanced = defs.filter((d) => !primary.includes(d));
  return (
    <section class="box log-filters" aria-labelledby="flt-title">
      <div class="box-head"><h2 class="box-title" id="flt-title">Filters</h2>
        <div class="box-actions"><a href={exportHref} class="btn btn-small">Download CSV</a></div></div>
      <div class="box-body">
        <nav class="flt-presets" aria-label="Quick filters">
          <span class="muted">Quick filters:</span>
          {presets.map((p) => <a class="chip chip-preset" href={href(base, p.values)}>{p.label}</a>)}
        </nav>
        <form method="get" action={base} class="flt-form">
          <div class="flt-grid">{primary.map(field)}</div>
          {advanced.length ? <details class="flt-more" open={advancedOpen}>
            <summary>More filters</summary>
            <div class="flt-grid">{advanced.map(field)}</div>
          </details> : null}
          <div class="flt-actions">
            <div class="field flt-field"><label for="flt-sort">Order</label>
              <select id="flt-sort" name="sort"><option value="">Newest first</option><option value="oldest" selected={values.sort === 'oldest'}>Oldest first</option></select></div>
            <div class="field flt-field"><label for="flt-per">Per page</label>
              <select id="flt-per" name="per">{['50', '25', '100'].map((n) => <option value={n === '50' ? '' : n} selected={(values.per ?? '') === (n === '50' ? '' : n)}>{n}</option>)}</select></div>
            <button class="btn btn-primary">Apply filters</button>
            {active.length ? <a href={base} class="btn">Clear all</a> : null}
          </div>
        </form>
        <div class="flt-active" aria-live="polite">
          {active.length ? <>
            <span class="muted">Showing entries matching <strong>all</strong> of:</span>
            <ul class="chips">{active.map((d) => {
              const text = `${d.label}: ${chipText(d, values[d.key])}`;
              return <li class="chip chip-active"><span>{text}</span>
                <a href={href(base, values, {}, [d.key, 'page'])} class="chip-remove" aria-label={`Remove filter ${text}`} title="Remove this filter">×</a></li>;
            })}</ul>
          </> : <span class="muted">No filters — showing everything.</span>}
          <span class="flt-count">{numberFmt(total)} matching {total === 1 ? 'entry' : 'entries'}</span>
        </div>
      </div>
    </section>
  );
}

function DetailView({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail ?? {});
  if (!entries.length) return <span class="muted">—</span>;
  const short = entries.slice(0, 2).map(([k, v]) => `${humanise(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
  return (
    <details class="log-detail"><summary>{short.length > 60 ? short.slice(0, 57) + '…' : short}</summary>
      <dl class="kv">{entries.map(([k, v]) => <><dt>{humanise(k)}</dt><dd><code>{typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)}</code></dd></>)}</dl>
    </details>
  );
}

function targetHref(type: string | null, id: number | null, users: Map<number, { username: string }>): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'user': { const u = users.get(id); return u ? `/admin/users/${id}` : null; }
    case 'post': return `/p/${id}`;
    case 'thread': return `/t/${id}`;
    case 'forum': return `/admin/forums`;
    case 'group': return `/admin/groups?edit=${id}`;
    case 'report': return `/mod/reports`;
    case 'message': return `/mod/messages/${id}`;
    default: return null;
  }
}

async function resolveMember(name: string | undefined): Promise<{ id: number | null; missing: boolean }> {
  if (!name) return { id: null, missing: false };
  const u = await getUserByUsername(name);
  return u ? { id: u.id, missing: false } : { id: -1, missing: true };
}

function dateConds(col: any, v: Values): SQL[] {
  const out: SQL[] = [];
  if (v.from) out.push(gte(col, new Date(v.from + 'T00:00:00Z')));
  if (v.to) out.push(lte(col, new Date(v.to + 'T23:59:59.999Z')));
  return out;
}
const like = (s: string) => '%' + s.replace(/[%_\\]/g, '\\$&') + '%';

export function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(c: C, name: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${name}-${today()}.csv"`);
  c.header('Cache-Control', 'no-store');
  return c.body('﻿' + body);
}

async function guard(c: C, perm: Perm) { const v = c.get('viewer'); await v.require('admin.access'); await v.require(perm); return v; }

async function shell(c: C, title: string, body: any) {
  const { adminShell } = await import('./admin.tsx');
  return adminShell(c, title, 'admin.audit', body);
}

// ───────────────────────────── audit log ─────────────────────────────

async function auditDefs(): Promise<FilterDef[]> {
  const db = getDb();
  const seenActions = rowsOf(await db.execute(sql`select distinct action from audit_log`)).map((r) => String(r.action));
  const seenTargets = rowsOf(await db.execute(sql`select distinct target_type from audit_log where target_type is not null`)).map((r) => String(r.target_type));
  const actorIds = rowsOf(await db.execute(sql`select distinct actor_id from audit_log where actor_id is not null limit 200`)).map((r) => Number(r.actor_id));
  const actors = await userCards(actorIds);
  return [
    { key: 'category', label: 'Area', kind: 'select', options: Object.entries(AUDIT_CATEGORIES).map(([value, label]) => ({ value, label })) },
    { key: 'action', label: 'Action', kind: 'select', options: groupedOptions(AUDIT_ACTIONS, AUDIT_CATEGORIES, seenActions) },
    { key: 'actor', label: 'Done by', kind: 'select', options: [...actors.values()].sort((a, b) => a.username.localeCompare(b.username)).map((u) => ({ value: u.username, label: u.username })) },
    { key: 'target', label: 'Affected', kind: 'select', options: seenTargets.map((t) => ({ value: t, label: TARGET_TYPES[t] ?? humanise(t) })).sort((a, b) => a.label.localeCompare(b.label)) },
    { key: 'from', label: 'From date (UTC)', kind: 'date' },
    { key: 'to', label: 'To date (UTC)', kind: 'date' },
    { key: 'member', label: 'Affected member', kind: 'member', hint: 'Actions taken on this member' },
    { key: 'targetId', label: 'Affected item number', kind: 'number', hint: 'e.g. a post or thread number' },
    { key: 'ip', label: 'IP address contains', kind: 'text' },
    { key: 'q', label: 'Details contain', kind: 'text', hint: 'Searches reasons, notes and other recorded details' },
  ];
}

const AUDIT_PRESETS = (): Preset[] => [
  { label: 'Today', values: { from: today() } },
  { label: 'Member moderation, last 7 days', values: { category: 'members', from: daysAgo(7) } },
  { label: 'Posts & threads, last 7 days', values: { category: 'content', from: daysAgo(7) } },
  { label: 'Permission & group changes', values: { category: 'access' } },
  { label: 'Direct-message reviews', values: { category: 'messages' } },
  { label: 'Restricted-term changes', values: { category: 'policy' } },
  { label: 'Settings & sign-in changes', values: { category: 'config' } },
];

async function auditQuery(v: Values) {
  const a = schema.auditLog;
  const conds: SQL[] = [];
  if (v.category) conds.push(inArray(a.action, codesInCategory(AUDIT_ACTIONS, v.category).concat('__none__')));
  if (v.action) conds.push(eq(a.action, v.action));
  const actor = await resolveMember(v.actor);
  if (actor.id) conds.push(eq(a.actorId, actor.id));
  if (v.target) conds.push(eq(a.targetType, v.target));
  const member = await resolveMember(v.member);
  if (member.id) conds.push(and(eq(a.targetType, 'user'), eq(a.targetId, member.id))!);
  if (v.targetId) conds.push(eq(a.targetId, Number(v.targetId)));
  if (v.ip) conds.push(sql`${a.ip} like ${like(v.ip)}`);
  if (v.q) conds.push(sql`(${a.detail}::text ilike ${like(v.q)} or ${a.action} ilike ${like(v.q)})`);
  conds.push(...dateConds(a.createdAt, v));
  return { where: conds.length ? and(...conds) : sql`true`, missing: [actor.missing ? 'actor' : '', member.missing ? 'member' : ''].filter(Boolean) };
}

logRoutes.get('/admin/audit', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.audit');
  const defs = await auditDefs();
  const v = readValues(c, defs);
  const { where, missing } = await auditQuery(v);
  const db = getDb();
  const per = [25, 50, 100].includes(Number(v.per)) ? Number(v.per) : 50;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLog).where(where);
  const pages = Math.max(1, Math.ceil(n / per));
  const pg = Math.min(Math.max(1, Number(c.req.query('page')) || 1), pages);
  const rows = await db.select().from(schema.auditLog).where(where)
    .orderBy(v.sort === 'oldest' ? asc(schema.auditLog.createdAt) : desc(schema.auditLog.createdAt), desc(schema.auditLog.id)).limit(per).offset((pg - 1) * per);
  const users = await userCards([...rows.map((r) => r.actorId!), ...rows.filter((r) => r.targetType === 'user').map((r) => r.targetId!)].filter(Boolean));
  const base = '/admin/audit';
  const chipText = (d: FilterDef, val: string) => d.options?.find((o) => o.value === val)?.label ?? val;
  return shell(c, 'Audit log', (
    <>
      <p class="muted">Every privileged action by staff, plus account changes members make themselves. Entries can't be edited or removed from here.</p>
      <FilterBar base={base} defs={defs} values={v} presets={AUDIT_PRESETS()} total={n} chipText={chipText} exportHref={href('/admin/audit.csv', v)} />
      {missing.length ? <Notice type="warn">No member with that username{missing.length > 1 ? 's' : ''} — the {missing.join(' and ')} filter matches nothing.</Notice> : null}
      <Pagination page={pg} pages={pages} href={(p) => href(base, v, { page: String(p) })} />
      {rows.length ? <div class="table-wrap"><table class="data-table log-table">
        <caption class="sr-only">Audit log entries</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Done by</th><th scope="col">Action</th><th scope="col">Affected</th><th scope="col">Details</th><th scope="col">IP</th></tr></thead>
        <tbody>{rows.map((r) => {
          const actor = r.actorId ? users.get(r.actorId) : null;
          const t = targetHref(r.targetType, r.targetId, users);
          const targetName = r.targetType === 'user' && r.targetId ? users.get(r.targetId)?.username : null;
          const cat = AUDIT_ACTIONS[r.action]?.category;
          return <tr>
            <td class="nowrap"><Time d={r.createdAt} tz={tz(ctx)} /></td>
            <td>{actor ? <><UserLink user={actor} /><AddFilter base={base} values={v} k="actor" v={actor.username} label={`done by ${actor.username}`} /></> : <span class="muted">System</span>}</td>
            <td><span class={`log-cat log-cat-${cat ?? 'other'}`}>{auditLabel(r.action)}</span><AddFilter base={base} values={v} k="action" v={r.action} label={auditLabel(r.action)} />
              <div class="small muted"><code>{r.action}</code></div></td>
            <td>{r.targetType ? <>{TARGET_TYPES[r.targetType] ?? humanise(r.targetType)} {t ? <a href={t}>{targetName ?? `#${r.targetId}`}</a> : r.targetId ? `#${r.targetId}` : ''}
              {targetName ? <AddFilter base={base} values={v} k="member" v={targetName} label={`affecting ${targetName}`} /> : null}</> : <span class="muted">—</span>}</td>
            <td><DetailView detail={r.detail} /></td>
            <td class="small">{r.ip ? <>{r.ip}<AddFilter base={base} values={v} k="ip" v={r.ip} label={`IP ${r.ip}`} /></> : ''}</td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState title="No entries match these filters.">Try removing a filter above.</EmptyState>}
      <Pagination page={pg} pages={pages} href={(p) => href(base, v, { page: String(p) })} />
    </>
  ));
});

logRoutes.get('/admin/audit.csv', async (c) => {
  const viewer = await guard(c, 'admin.audit');
  const defs = await auditDefs();
  const v = readValues(c, defs);
  const { where } = await auditQuery(v);
  const rows = await getDb().select().from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt)).limit(10_000);
  const users = await userCards([...rows.map((r) => r.actorId!), ...rows.filter((r) => r.targetType === 'user').map((r) => r.targetId!)].filter(Boolean));
  await audit(viewer.user!.id, 'audit.export', {}, { filters: v, rows: rows.length }, viewer.ip);
  return csv(c, 'fragged-audit-log', ['time_utc', 'actor', 'action_code', 'action', 'target_type', 'target_id', 'target_member', 'ip', 'detail'],
    rows.map((r) => [r.createdAt.toISOString(), r.actorId ? users.get(r.actorId)?.username ?? r.actorId : 'system', r.action, auditLabel(r.action), r.targetType, r.targetId,
      r.targetType === 'user' && r.targetId ? users.get(r.targetId)?.username ?? '' : '', r.ip, r.detail]));
});

// ───────────────────────────── security events ─────────────────────────────

async function securityDefs(): Promise<FilterDef[]> {
  const db = getDb();
  const seenKinds = rowsOf(await db.execute(sql`select distinct kind from security_events`)).map((r) => String(r.kind));
  const providers = rowsOf(await db.execute(sql`select distinct provider from security_events where provider is not null`)).map((r) => String(r.provider));
  return [
    { key: 'category', label: 'Type of event', kind: 'select', options: Object.entries(SECURITY_CATEGORIES).map(([value, label]) => ({ value, label })) },
    { key: 'kind', label: 'Event', kind: 'select', options: groupedOptions(SECURITY_KINDS, SECURITY_CATEGORIES, seenKinds) },
    { key: 'severity', label: 'Importance', kind: 'select', options: [{ value: 'warning', label: 'Warnings (failures, blocks)' }, { value: 'notice', label: 'Notable changes' }, { value: 'info', label: 'Routine' }] },
    { key: 'provider', label: 'Sign-in method', kind: 'select', options: providers.map((p) => ({ value: p, label: PROVIDER_NAMES[p] ?? humanise(p) })) },
    { key: 'member', label: 'Member', kind: 'member' },
    { key: 'from', label: 'From date (UTC)', kind: 'date' },
    { key: 'to', label: 'To date (UTC)', kind: 'date' },
    { key: 'ip', label: 'IP address contains', kind: 'text' },
    { key: 'q', label: 'Details contain', kind: 'text', hint: 'e.g. the username someone tried to sign in with' },
  ];
}

const SECURITY_PRESETS = (): Preset[] => [
  { label: 'Failed sign-ins, last 24 h', values: { kind: 'login_failed', from: daysAgo(1) } },
  { label: 'All warnings, last 7 days', values: { severity: 'warning', from: daysAgo(7) } },
  { label: 'Rate-limited sign-ins', values: { kind: 'login_throttled' } },
  { label: 'Provider sign-in problems', values: { kind: 'oauth_failed' } },
  { label: 'Password & email changes', values: { category: 'account' } },
  { label: 'Connected providers', values: { category: 'providers' } },
];

async function securityQuery(v: Values) {
  const s = schema.securityEvents;
  const conds: SQL[] = [];
  if (v.category) conds.push(inArray(s.kind, codesInCategory(SECURITY_KINDS, v.category).concat('__none__')));
  if (v.kind) conds.push(eq(s.kind, v.kind));
  if (v.severity) conds.push(inArray(s.kind, Object.entries(SECURITY_KINDS).filter(([, d]) => d.severity === v.severity).map(([k]) => k).concat('__none__')));
  if (v.provider) conds.push(eq(s.provider, v.provider));
  const member = await resolveMember(v.member);
  if (member.id) conds.push(eq(s.userId, member.id));
  if (v.ip) conds.push(sql`${s.ip} like ${like(v.ip)}`);
  if (v.q) conds.push(sql`(${s.detail}::text ilike ${like(v.q)} or ${s.userAgent} ilike ${like(v.q)})`);
  conds.push(...dateConds(s.createdAt, v));
  return { where: conds.length ? and(...conds) : sql`true`, missing: member.missing };
}

logRoutes.get('/admin/security', async (c) => {
  const ctx = c.get('page');
  await guard(c, 'admin.audit');
  const defs = await securityDefs();
  const v = readValues(c, defs);
  const { where, missing } = await securityQuery(v);
  const db = getDb();
  const per = [25, 50, 100].includes(Number(v.per)) ? Number(v.per) : 50;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.securityEvents).where(where);
  const pages = Math.max(1, Math.ceil(n / per));
  const pg = Math.min(Math.max(1, Number(c.req.query('page')) || 1), pages);
  const rows = await db.select().from(schema.securityEvents).where(where)
    .orderBy(v.sort === 'oldest' ? asc(schema.securityEvents.createdAt) : desc(schema.securityEvents.createdAt), desc(schema.securityEvents.id)).limit(per).offset((pg - 1) * per);
  const users = await userCards(rows.map((r) => r.userId!).filter(Boolean));
  // a 24-hour overview so spikes are visible before filtering
  const summary = rowsOf(await db.execute(sql`select kind, count(*)::int as n from security_events where created_at > now() - interval '24 hours' group by kind order by n desc limit 6`));
  const base = '/admin/security';
  const chipText = (d: FilterDef, val: string) => d.options?.find((o) => o.value === val)?.label ?? val;
  return shell(c, 'Security events', (
    <>
      <p class="muted">Sign-ins, failures, password and email changes, connected providers and session activity.</p>
      {summary.length ? <div class="log-summary" role="group" aria-label="Last 24 hours">
        <span class="muted">Last 24 h:</span>
        {summary.map((s) => <a class={`chip chip-sev-${SECURITY_KINDS[String(s.kind)]?.severity ?? 'info'}`} href={href(base, { kind: String(s.kind), from: daysAgo(1) })}>{securityLabel(String(s.kind))} <strong>{s.n}</strong></a>)}
      </div> : null}
      <FilterBar base={base} defs={defs} values={v} presets={SECURITY_PRESETS()} total={n} chipText={chipText} exportHref={href('/admin/security.csv', v)} />
      {missing ? <Notice type="warn">No member with that username — the member filter matches nothing.</Notice> : null}
      <Pagination page={pg} pages={pages} href={(p) => href(base, v, { page: String(p) })} />
      {rows.length ? <div class="table-wrap"><table class="data-table log-table">
        <caption class="sr-only">Security events</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Member</th><th scope="col">Event</th><th scope="col">Method</th><th scope="col">IP / device</th><th scope="col">Details</th></tr></thead>
        <tbody>{rows.map((r) => {
          const u = r.userId ? users.get(r.userId) : null;
          const sev = SECURITY_KINDS[r.kind]?.severity ?? 'info';
          return <tr class={`sev-row sev-${sev}`}>
            <td class="nowrap"><Time d={r.createdAt} tz={tz(ctx)} /></td>
            <td>{u ? <><UserLink user={u} /><AddFilter base={base} values={v} k="member" v={u.username} label={u.username} /></> : <span class="muted">Not signed in</span>}</td>
            <td><span class={`sev-badge sev-${sev}`}><span class="sr-only">{sev === 'warning' ? 'Warning: ' : sev === 'notice' ? 'Notice: ' : ''}</span>{securityLabel(r.kind)}</span>
              <AddFilter base={base} values={v} k="kind" v={r.kind} label={securityLabel(r.kind)} /><div class="small muted"><code>{r.kind}</code></div></td>
            <td>{r.provider ? <>{PROVIDER_NAMES[r.provider] ?? humanise(r.provider)}<AddFilter base={base} values={v} k="provider" v={r.provider} label={PROVIDER_NAMES[r.provider] ?? r.provider} /></> : <span class="muted">—</span>}</td>
            <td class="small">{r.ip ? <>{r.ip}<AddFilter base={base} values={v} k="ip" v={r.ip} label={`IP ${r.ip}`} /></> : ''}{r.userAgent ? <div class="muted" title={r.userAgent}>{describeUA(r.userAgent)}</div> : null}</td>
            <td><DetailView detail={r.detail} /></td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState title="No events match these filters.">Try removing a filter above.</EmptyState>}
      <Pagination page={pg} pages={pages} href={(p) => href(base, v, { page: String(p) })} />
    </>
  ));
});

logRoutes.get('/admin/security.csv', async (c) => {
  const viewer = await guard(c, 'admin.audit');
  const defs = await securityDefs();
  const v = readValues(c, defs);
  const { where } = await securityQuery(v);
  const rows = await getDb().select().from(schema.securityEvents).where(where).orderBy(desc(schema.securityEvents.createdAt)).limit(10_000);
  const users = await userCards(rows.map((r) => r.userId!).filter(Boolean));
  await audit(viewer.user!.id, 'security.export', {}, { filters: v, rows: rows.length }, viewer.ip);
  return csv(c, 'fragged-security-events', ['time_utc', 'member', 'event_code', 'event', 'severity', 'provider', 'ip', 'user_agent', 'detail'],
    rows.map((r) => [r.createdAt.toISOString(), r.userId ? users.get(r.userId)?.username ?? r.userId : '', r.kind, securityLabel(r.kind), SECURITY_KINDS[r.kind]?.severity ?? 'info', r.provider, r.ip, r.userAgent, r.detail]));
});

const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';

function describeUA(ua: string): string {
  const b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ' on ' + os : ''}`;
}

export const _x = { getUserById };
