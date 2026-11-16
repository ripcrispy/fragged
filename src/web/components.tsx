/** Shared UI building blocks (server-rendered, theme-token driven). */
import type { Child, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { PageCtx } from './ctx.ts';
import type { UserCard } from '../services/users.ts';
import { fmtDateTime, timeAgo, fmtDate } from '../lib/time.ts';
import type { Tag } from '../services/forums.ts';

export const Csrf = ({ ctx }: { ctx: PageCtx }) => <input type="hidden" name="_csrf" value={ctx.csrf} />;

export function Logo({ name }: { name: string }) {
  // Fragged mark: a split diamond "fragment" + wordmark.
  return (
    <span class="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40" width="34" height="34" focusable="false">
        <path d="M20 2 L37 20 L24 22 Z" class="lg-a" />
        <path d="M37 20 L20 38 L22 25 Z" class="lg-b" />
        <path d="M20 38 L3 20 L16 18 Z" class="lg-a" />
        <path d="M3 20 L20 2 L18 15 Z" class="lg-b" />
        <path d="M18 15 L24 22 L22 25 L16 18 Z" class="lg-c" />
      </svg>
      <span class="logo-text"><span class="lg-frag">Frag</span><span class="lg-ged">ged</span><span class="sr-only"> {name}</span></span>
    </span>
  );
}

export function UserLink({ user, showColor = true, className = '' }: { user: Pick<UserCard, 'username' | 'color' | 'closed' | 'groupId'> | null | undefined; showColor?: boolean; className?: string }) {
  if (!user) return <span class="username muted">Unknown</span>;
  if (user.closed) return <span class="username muted">Former member</span>;
  const gc = showColor && user.color && user.groupId ? `gc gc-${user.groupId}` : '';
  return <a class={`username ${gc} ${className}`.trim()} href={`/u/${encodeURIComponent(user.username)}`}>{user.username}</a>;
}

export function Avatar({ user, size = 64, link = true }: { user: Pick<UserCard, 'username' | 'avatarUrl' | 'closed'> | null | undefined; size?: number; link?: boolean }) {
  const img = <img class="avatar" src={user?.avatarUrl ?? '/img/default-avatar.svg'} alt="" width={size} height={size} loading="lazy" />;
  if (!user || user.closed || !link) return img;
  return <a href={`/u/${encodeURIComponent(user.username)}`} tabindex={-1} aria-hidden="true">{img}</a>;
}

export function Presence({ p }: { p: string | null | undefined }) {
  if (!p) return null;
  const label = p === 'online' ? 'Online' : p === 'away' ? 'Away' : 'Offline';
  return <span class={`presence presence-${p}`} title={label}><span class="presence-dot" aria-hidden="true" /><span class="sr-only">{label}</span></span>;
}

export function Time({ d, tz, mode = 'datetime' }: { d: Date | null | undefined; tz: string; mode?: 'datetime' | 'ago' | 'date' }) {
  if (!d) return null;
  const abs = fmtDateTime(d, tz);
  return <time datetime={d.toISOString()} title={abs}>{mode === 'ago' ? timeAgo(d) : mode === 'date' ? fmtDate(d, tz) : abs}</time>;
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Fragged</a></li>
        {items.map((it, i) => (
          <li aria-current={i === items.length - 1 ? 'page' : undefined}>{it.href && i < items.length - 1 ? <a href={it.href}>{it.label}</a> : <span>{it.label}</span>}</li>
        ))}
      </ol>
    </nav>
  );
}

export function Box({ title, actions, children, id, className = '', headingLevel = 2 }: PropsWithChildren<{ title?: Child; actions?: Child; id?: string; className?: string; headingLevel?: 2 | 3 }>) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section class={`box ${className}`} id={id}>
      {title ? <div class="box-head"><H class="box-title">{title}</H>{actions ? <div class="box-actions">{actions}</div> : null}</div> : null}
      <div class="box-body">{children}</div>
    </section>
  );
}

export function Notice({ type = 'info', children, title }: PropsWithChildren<{ type?: 'info' | 'ok' | 'error' | 'warn'; title?: string }>) {
  return (
    <div class={`notice notice-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <span class="notice-icon" aria-hidden="true">{type === 'error' ? '!' : type === 'ok' ? '✓' : type === 'warn' ? '⚠' : 'i'}</span>
      <div>{title ? <strong class="notice-title">{title}</strong> : null}{children}</div>
    </div>
  );
}

export function Pagination({ page, pages, href, label = 'Pages' }: { page: number; pages: number; href: (p: number) => string; label?: string }) {
  if (pages <= 1) return null;
  const nums: (number | '…')[] = [];
  const add = (n: number) => { if (!nums.includes(n)) nums.push(n); };
  add(1);
  if (page > 4) nums.push('…');
  for (let i = Math.max(2, page - 2); i <= Math.min(pages - 1, page + 2); i++) add(i);
  if (page < pages - 3) nums.push('…');
  add(pages);
  return (
    <nav class="pagination" aria-label={label}>
      <span class="pagination-label">Page {page} of {pages}</span>
      {page > 1 ? <a class="pg-btn" href={href(1)} aria-label="First page">«</a> : null}
      {page > 1 ? <a class="pg-btn" href={href(page - 1)} rel="prev" aria-label="Previous page">‹</a> : null}
      {nums.map((n) => n === '…' ? <span class="pg-gap">…</span> : n === page ? <span class="pg-btn pg-current" aria-current="page">{n}</span> : <a class="pg-btn" href={href(n)}>{n}</a>)}
      {page < pages ? <a class="pg-btn" href={href(page + 1)} rel="next" aria-label="Next page">›</a> : null}
      {page < pages ? <a class="pg-btn" href={href(pages)} aria-label="Last page">»</a> : null}
    </nav>
  );
}

export function TagPill({ tag, href }: { tag: Pick<Tag, 'name' | 'slug' | 'kind'>; href?: string }) {
  const cls = `tag tag-${tag.kind} ${tag.kind === 'warning' ? 'tag-w-' + tag.slug : ''}`;
  const label = tag.kind === 'warning' ? <><span aria-hidden="true">⚠ </span>{tag.name}</> : tag.name;
  return href ? <a class={cls} href={href}>{label}</a> : <span class={cls}>{label}</span>;
}

export function Field({ label, name, type = 'text', value, error, hint, required, autocomplete, maxlength, minlength, placeholder, inputmode, pattern, id, attrs }: {
  label: string; name: string; type?: string; value?: string | null; error?: string; hint?: string; required?: boolean; autocomplete?: string; maxlength?: number; minlength?: number; placeholder?: string; inputmode?: string; pattern?: string; id?: string; attrs?: Record<string, string>;
}) {
  const fid = id ?? `f-${name}`;
  return (
    <div class={`field ${error ? 'has-error' : ''}`}>
      <label for={fid}>{label}{required ? <span class="req" aria-hidden="true"> *</span> : null}</label>
      <input id={fid} name={name} type={type} value={value ?? ''} required={required} autocomplete={autocomplete} maxlength={maxlength} minlength={minlength} placeholder={placeholder} inputmode={inputmode as any} pattern={pattern}
        aria-invalid={error ? 'true' : undefined} aria-describedby={[error ? `${fid}-err` : '', hint ? `${fid}-hint` : ''].filter(Boolean).join(' ') || undefined} {...(attrs ?? {})} />
      {hint ? <div class="field-hint" id={`${fid}-hint`}>{hint}</div> : null}
      {error ? <div class="field-error" id={`${fid}-err`}>{error}</div> : null}
    </div>
  );
}

export function TextArea({ label, name, value, error, hint, rows = 4, maxlength, id, required }: { label: string; name: string; value?: string | null; error?: string; hint?: string; rows?: number; maxlength?: number; id?: string; required?: boolean }) {
  const fid = id ?? `f-${name}`;
  return (
    <div class={`field ${error ? 'has-error' : ''}`}>
      <label for={fid}>{label}</label>
      <textarea id={fid} name={name} rows={rows} maxlength={maxlength} required={required} aria-invalid={error ? 'true' : undefined} aria-describedby={[error ? `${fid}-err` : '', hint ? `${fid}-hint` : ''].filter(Boolean).join(' ') || undefined}>{value ?? ''}</textarea>
      {hint ? <div class="field-hint" id={`${fid}-hint`}>{hint}</div> : null}
      {error ? <div class="field-error" id={`${fid}-err`}>{error}</div> : null}
    </div>
  );
}

export function Checkbox({ label, name, checked, hint, value = '1' }: { label: string; name: string; checked?: boolean; hint?: string; value?: string }) {
  return (
    <div class="field field-check">
      <label><input type="checkbox" name={name} value={value} checked={checked} /> {label}</label>
      {hint ? <div class="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Select({ label, name, value, options, hint, error }: { label: string; name: string; value?: string; options: [string, string][]; hint?: string; error?: string }) {
  return (
    <div class={`field ${error ? 'has-error' : ''}`}>
      <label for={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} name={name}>{options.map(([v, l]) => <option value={v} selected={v === value}>{l}</option>)}</select>
      {hint ? <div class="field-hint">{hint}</div> : null}
      {error ? <div class="field-error">{error}</div> : null}
    </div>
  );
}

/** A POST button form (for actions like lock, block, accept). */
export function ActionButton({ ctx, action, label, fields = {}, className = 'btn', confirm, title }: { ctx: PageCtx; action: string; label: Child; fields?: Record<string, string | number>; className?: string; confirm?: string; title?: string }) {
  return (
    <form method="post" action={action} class="inline-form" data-confirm={confirm}>
      <Csrf ctx={ctx} />
      {Object.entries(fields).map(([k, v]) => <input type="hidden" name={k} value={String(v)} />)}
      <button type="submit" class={className} title={title}>{label}</button>
    </form>
  );
}

export function Html({ html }: { html: string }) { return <>{raw(html)}</>; }

export function EmptyState({ title, children }: PropsWithChildren<{ title: string }>) {
  return <div class="empty-state"><p class="empty-title">{title}</p>{children}</div>;
}

export function Stat({ label, value }: { label: string; value: Child }) {
  return <div class="stat"><span class="stat-value">{value}</span><span class="stat-label">{label}</span></div>;
}
