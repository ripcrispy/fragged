/**
 * Fragged client enhancements. Every feature degrades to a working server-rendered form/link
 * without JavaScript. Bundled to public/js/app.js by scripts/build.mjs.
 */
import { STANDARD_EMOJI } from './emoji-data.ts';

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
const csrf = () => (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? '';
const me = () => Number(document.body.dataset.userId || 0);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

async function api<T = any>(url: string, opts: { method?: string; body?: Record<string, unknown> | FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { Accept: 'application/json', 'X-CSRF-Token': csrf() }, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body) { (init.headers as any)['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
  return data as T;
}

function toast(text: string, opts: { href?: string; kind?: 'info' | 'error' } = {}) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement(opts.href ? 'a' : 'div');
  el.className = `toast toast-${opts.kind ?? 'info'}`;
  el.textContent = text;
  if (opts.href) (el as HTMLAnchorElement).href = opts.href;
  box.appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 5000);
  setTimeout(() => el.remove(), 5600);
}

function setBadge(name: string, n: number) {
  for (const b of $$(`[data-badge="${name}"]`)) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
}

// ───────────────────────── basic UI ─────────────────────────

function initMenus() {
  document.addEventListener('click', (e) => {
    for (const d of $$<HTMLDetailsElement>('details.menu[open]')) if (!d.contains(e.target as Node)) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of $$<HTMLDetailsElement>('details.menu[open]')) { d.open = false; (d.querySelector('summary') as HTMLElement)?.focus(); }
  });
  // main nav: move links that don't fit on one line into a "More" dropdown (phones use the hamburger instead)
  const navList = $('#nav-links');
  const more = $('[data-nav-more]');
  const moreBtn = $('[data-nav-more-btn]');
  const moreMenu = $('#nav-more-menu');
  const setMoreOpen = (open: boolean) => { moreBtn?.setAttribute('aria-expanded', String(open)); if (moreMenu) moreMenu.hidden = !open; };
  const fitNav = () => {
    if (!navList || !more || !moreBtn || !moreMenu) return;
    setMoreOpen(false);
    for (const li of [...moreMenu.children]) navList.insertBefore(li, more); // restore original order
    more.hidden = true;
    moreBtn.classList.remove('active');
    if (window.matchMedia('(max-width: 640px)').matches) { navList.classList.remove('nav-fit'); return; }
    navList.classList.add('nav-fit');
    if (navList.scrollWidth <= navList.clientWidth + 1) return;
    more.hidden = false;
    const items = () => [...navList.children].filter((li) => li !== more);
    while (navList.scrollWidth > navList.clientWidth + 1 && items().length) moreMenu.prepend(items().pop()!);
    if (moreMenu.querySelector('a.active')) moreBtn.classList.add('active');
  };
  if (navList && more && moreBtn && moreMenu) {
    moreBtn.addEventListener('click', () => setMoreOpen(moreBtn.getAttribute('aria-expanded') !== 'true'));
    more.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape' && moreBtn.getAttribute('aria-expanded') === 'true') { setMoreOpen(false); moreBtn.focus(); } });
    more.addEventListener('focusout', (e) => { if (!more.contains((e as FocusEvent).relatedTarget as Node | null)) setMoreOpen(false); });
    document.addEventListener('click', (e) => { if (!more.contains(e.target as Node)) setMoreOpen(false); });
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitNav); };
    new ResizeObserver(schedule).observe(navList.parentElement!);
    document.fonts?.ready.then(schedule).catch(() => {});
    document.addEventListener('fragged:relayout', schedule);
    fitNav();
  }
  const navBtn = $('[data-nav-toggle]');
  navBtn?.addEventListener('click', () => {
    const open = navBtn.getAttribute('aria-expanded') !== 'true';
    navBtn.setAttribute('aria-expanded', String(open));
    $('#nav-links')?.classList.toggle('open', open);
  });
  // confirmations for destructive actions
  document.addEventListener('submit', (e) => {
    const f = e.target as HTMLFormElement;
    const btn = (e as SubmitEvent).submitter as HTMLElement | null;
    const msg = btn?.dataset.confirm ?? f.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  }, true);
  for (const a of $$<HTMLAnchorElement>('a[data-back]')) a.addEventListener('click', (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } });
}

function initPane() {
  const pane = $('[data-friends-pane]');
  if (!pane) return;
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
  if (isMobile()) { pane.hidden = true; document.body.classList.add('pane-collapsed'); }
  const set = (collapsed: boolean, persist = true) => {
    pane.hidden = collapsed;
    document.body.classList.toggle('pane-collapsed', collapsed);
    document.body.classList.toggle('pane-drawer-open', !collapsed && isMobile());
    for (const b of $$('[data-pane-toggle]')) b.setAttribute('aria-expanded', String(!collapsed));
    if (persist && !isMobile()) { if (me()) api('/api/preferences/pane', { body: { collapsed: collapsed ? '1' : '0' } }).catch(() => {}); else store.set('ff.pane', collapsed); }
    if (!collapsed && isMobile()) (pane.querySelector('input, a, button') as HTMLElement | null)?.focus();
  };
  if (!me() && !isMobile() && store.get('ff.pane', false)) set(true, false);
  for (const b of $$('[data-pane-toggle]')) b.addEventListener('click', () => set(!pane.hidden));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isMobile() && !pane.hidden) set(true, false); });
  bindPaneFilter();
}

async function reloadPane() {
  const body = $('[data-pane-body]');
  if (!body) return;
  try {
    const r = await fetch('/api/pane', { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!r.ok) return;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.openDm;
    body.innerHTML = await r.text();
    const c = $('[data-friend-online-count]');
    if (c) c.textContent = `(${r.headers.get('X-Online-Count') ?? 0} online)`;
    const n = Number(r.headers.get('X-Request-Count') ?? 0);
    for (const b of $$('.pane-toggle .badge')) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
    bindPaneFilter();
    if (focusedId) ($(`[data-open-dm="${focusedId}"]`) as HTMLElement | null)?.focus();
  } catch { /* offline; the next event retries */ }
}

function bindPaneFilter() {
  const filter = $<HTMLInputElement>('[data-pane-filter]');
  filter?.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const li of $$('[data-pane-friends] li')) li.hidden = !!q && !(li.dataset.username ?? '').includes(q);
  });
}

function updatePresence(userId: number, presence: string) {
  for (const li of $$(`[data-pane-friends] li[data-user-id="${userId}"]`)) {
    let p = li.querySelector('.presence');
    if (!p) { p = document.createElement('span'); li.querySelector('.pane-name')?.appendChild(p); }
    p.className = `presence presence-${presence}`;
    p.setAttribute('title', presence[0].toUpperCase() + presence.slice(1));
    p.innerHTML = `<span class="presence-dot" aria-hidden="true"></span><span class="sr-only">${presence}</span>`;
  }
  const online = $$('[data-pane-friends] .presence-online, [data-pane-friends] .presence-away').length;
  const c = $('[data-friend-online-count]');
  if (c) c.textContent = `(${online} online)`;
}

// ───────────────────────── notifications ─────────────────────────

function initNotifications() {
  const menu = $<HTMLDetailsElement>('[data-notif-menu]');
  if (!menu) return;
  const list = $('[data-notif-list]', menu)!;
  const load = async () => {
    try {
      const r = await api('/api/notifications');
      setBadge('notifications', r.unread);
      list.innerHTML = r.notifications.length ? r.notifications.map((n: any) => `<li class="${n.read ? '' : 'is-unread'}"><a href="${esc(n.url)}" data-nid="${n.id}">${esc(n.text)}</a><time datetime="${esc(n.createdAt)}">${new Date(n.createdAt).toLocaleString()}</time></li>`).join('') : '<li class="muted">No notifications yet.</li>';
    } catch { list.innerHTML = '<li class="muted">Couldn’t load notifications.</li>'; }
  };
  menu.addEventListener('toggle', () => { if (menu.open) void load(); });
  list.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[data-nid]') as HTMLAnchorElement | null;
    if (a) void api('/api/notifications/read', { body: { ids: [a.dataset.nid] } }).catch(() => {});
  });
  const readAll = $<HTMLFormElement>('form[data-ajax="notif-read-all"]', menu);
  readAll?.addEventListener('submit', async (e) => { e.preventDefault(); const r = await api('/api/notifications/read', { body: { all: '1' } }); setBadge('notifications', r.unread); void load(); });
}

// ───────────────────────── real-time (SSE) ─────────────────────────

type Handler = (data: any) => void;
const handlers: Record<string, Handler[]> = {};
const on = (ev: string, fn: Handler) => { (handlers[ev] ??= []).push(fn); };

function initEvents() {
  if (!me() || !('EventSource' in window)) return;
  let es: EventSource | null = null;
  let hadError = false;
  const connect = () => {
    es = new EventSource('/api/events');
    for (const ev of ['message', 'notification', 'presence', 'read', 'friends', 'relationship', 'notification_read']) {
      es.addEventListener(ev, (e) => { const d = JSON.parse((e as MessageEvent).data); for (const fn of handlers[ev] ?? []) fn(d); });
    }
    es.addEventListener('hello', () => {
      document.body.classList.remove('rt-offline');
      if (hadError) { hadError = false; for (const fn of handlers.resync ?? []) fn({}); }
    });
    es.onerror = () => { hadError = true; document.body.classList.add('rt-offline'); };
  };
  connect();
  // idle → "away" after 5 minutes hidden
  let idleTimer: number | undefined;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(idleTimer);
    if (document.hidden) idleTimer = window.setTimeout(() => api('/api/presence', { body: { idle: '1' } }).catch(() => {}), 5 * 60_000);
    else api('/api/presence', { body: { idle: '0' } }).catch(() => {});
  });
  on('notification', (n) => {
    const b = $('[data-badge="notifications"]');
    const cur = Number(b?.textContent || 0) + 1;
    setBadge('notifications', cur);
    if (n.kind !== 'message') toast(n.text, { href: n.url });
  });
  on('presence', (d) => updatePresence(d.userId, d.presence));
  // friendship changes (requests, accepts, removals, blocks) re-render the pane from the server
  let paneTimer: number | undefined;
  const refreshPane = () => { clearTimeout(paneTimer); paneTimer = window.setTimeout(() => void reloadPane(), 300); };
  on('friends', refreshPane);
  on('relationship', refreshPane);
  on('resync', refreshPane);
}

// ───────────────────────── direct message dock ─────────────────────────

interface DockTab { pid: string; minimized: boolean }
interface Win { pid: string; el: HTMLElement; list: HTMLElement; lastId: number; firstId: number; hasMore: boolean; other: any; canSend: boolean; blocked: boolean; muted: boolean; pending: Map<string, { body: string; uploads: string[] }>; uploads: string[] }

const MAX_OPEN = 3;
const wins = new Map<string, Win>();
let dockTabs: DockTab[] = [];

function newNonce() { return (crypto as any).randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36); }

function msgHtml(m: any, mine: boolean, otherName: string) {
  const imgs = (m.attachments ?? []).map((a: any) => `<a href="/media/${esc(a.publicId)}" data-lightbox><img src="/media/${esc(a.publicId)}" alt="Image attachment" loading="lazy"></a>`).join('');
  const body = m.hidden ? '<em class="muted">Removed by staff following a report.</em>' : m.html;
  return `<li class="msg ${mine ? 'mine' : 'theirs'}" data-msg-id="${m.id}" data-nonce="${esc(m.nonce ?? '')}"><div class="msg-meta"><strong>${mine ? 'You' : esc(otherName)}</strong> <time datetime="${esc(String(m.createdAt))}" title="${esc(new Date(m.createdAt).toLocaleString())}">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${body ? `<div class="msg-body bb">${body}</div>` : ''}${imgs ? `<div class="msg-images">${imgs}</div>` : ''}</li>`;
}

function saveDock() { store.set('ff.dock.' + me(), dockTabs); }

function renderDockOverflow() {
  const dock = $('[data-dock]');
  if (!dock) return;
  let of = $('.dock-overflow', dock);
  const hidden = dockTabs.slice(0, Math.max(0, dockTabs.length - MAX_OPEN));
  if (!hidden.length) { of?.remove(); return; }
  if (!of) { of = document.createElement('details'); of.className = 'dock-overflow menu'; dock.prepend(of); }
  of.innerHTML = `<summary class="btn btn-small">+${hidden.length} more</summary><ul class="menu-panel">${hidden.map((t) => `<li><button type="button" class="link-btn" data-dock-focus="${esc(t.pid)}">${esc(wins.get(t.pid)?.other?.username ?? 'Conversation')}</button></li>`).join('')}</ul>`;
}

function layoutDock() {
  // keep at most MAX_OPEN expanded windows visible; older ones go to overflow
  dockTabs.forEach((t, i) => {
    const w = wins.get(t.pid);
    if (!w) return;
    const visible = i >= dockTabs.length - MAX_OPEN;
    w.el.hidden = !visible;
    w.el.classList.toggle('minimized', t.minimized);
    $('.dm-toggle', w.el)?.setAttribute('aria-expanded', String(!t.minimized));
  });
  renderDockOverflow();
  document.body.classList.toggle('has-dock', dockTabs.length > 0);
  saveDock();
}

async function openDm(opts: { userId?: number; username?: string; pid?: string; focus?: boolean; minimized?: boolean }) {
  if (window.matchMedia('(max-width: 640px)').matches && opts.focus !== false && !opts.pid) {
    // mobile: use the full-screen conversation route
    try { const r = await api('/api/dm/open', { body: { userId: opts.userId, username: opts.username } }); location.href = `/messages/${r.publicId}`; } catch (e: any) { toast(e.message, { kind: 'error' }); }
    return;
  }
  let pid = opts.pid;
  if (!pid) {
    try { pid = (await api('/api/dm/open', { body: { userId: opts.userId, username: opts.username } })).publicId; }
    catch (e: any) { toast(e.message, { kind: 'error' }); return; }
  }
  const existing = dockTabs.find((t) => t.pid === pid);
  if (existing) {
    // reuse the existing window — never open duplicates
    dockTabs = [...dockTabs.filter((t) => t !== existing), { ...existing, minimized: opts.minimized ?? false }];
  } else dockTabs.push({ pid: pid!, minimized: !!opts.minimized });
  if (!wins.has(pid!)) await createWin(pid!);
  layoutDock();
  const w = wins.get(pid!)!;
  if (opts.focus !== false && !opts.minimized) { ($('textarea', w.el) as HTMLTextAreaElement | null)?.focus(); markRead(w); }
}

function closeDm(pid: string) {
  // closing only removes the dock view — history is untouched on the server
  dockTabs = dockTabs.filter((t) => t.pid !== pid);
  wins.get(pid)?.el.remove();
  wins.delete(pid);
  layoutDock();
}

async function markRead(w: Win) {
  if (!w.lastId || document.hidden) return;
  const t = dockTabs.find((x) => x.pid === w.pid);
  if (t?.minimized) return;
  try { const r = await api(`/api/conversations/${w.pid}/read`, { body: { upTo: w.lastId } }); setBadge('messages', r.unread); setWinUnread(w, 0); updateFriendUnread(w.other.id, 0); } catch { /* offline */ }
}
function setWinUnread(w: Win, n: number) { const b = $('.dm-unread', w.el); if (b) { b.textContent = n ? String(n) : ''; b.hidden = !n; } }
function updateFriendUnread(userId: number, n: number) { for (const b of $$(`[data-unread-for="${userId}"]`)) { b.textContent = n ? String(n) : ''; b.hidden = !n; } }

async function createWin(pid: string) {
  const dock = $('[data-dock]')!;
  const el = document.createElement('section');
  el.className = 'dm-window';
  el.setAttribute('aria-label', 'Direct message');
  el.dataset.pid = pid;
  el.innerHTML = '<div class="dm-head"><span class="muted">Loading…</span></div>';
  dock.appendChild(el);
  const w: Win = { pid, el, list: el, lastId: 0, firstId: 0, hasMore: false, other: { id: 0, username: '' }, canSend: false, blocked: false, muted: false, pending: new Map(), uploads: [] };
  wins.set(pid, w);
  let data: any;
  try { data = await api(`/api/conversations/${pid}?limit=30`); }
  catch (e: any) { el.innerHTML = `<div class="dm-head"><span>Unavailable</span><button type="button" class="icon-btn dm-close" aria-label="Close">×</button></div><p class="dm-error">${esc(e.message)}</p>`; $('.dm-close', el)!.addEventListener('click', () => closeDm(pid)); return; }
  Object.assign(w, { other: data.other, canSend: data.canSend, blocked: data.blocked, muted: data.muted, hasMore: data.hasMore });
  const titleId = `dm-title-${pid}`;
  el.setAttribute('aria-labelledby', titleId);
  el.innerHTML = `
    <div class="dm-head">
      <button type="button" class="dm-toggle" aria-expanded="true" aria-controls="dm-body-${pid}">
        <img class="avatar" src="${esc(data.other.avatarUrl)}" alt="" width="20" height="20">
        <span class="dm-name" id="${titleId}">${esc(data.other.username)}</span><span class="presence presence-${esc(data.other.presence ?? 'offline')}"><span class="presence-dot" aria-hidden="true"></span></span>
        <span class="badge dm-unread" hidden></span>
      </button>
      <details class="menu dm-menu"><summary class="icon-btn" aria-label="Conversation options">⋯</summary>
        <ul class="menu-panel">
          <li><a href="${esc(data.other.profileUrl)}">View profile</a></li>
          <li><a href="/messages/${esc(pid)}">Open full conversation</a></li>
          <li><button type="button" class="link-btn" data-dm-mute>${data.muted ? 'Unmute conversation' : 'Mute conversation'}</button></li>
          <li><button type="button" class="link-btn danger" data-dm-block>${data.blocked ? 'Unblock' : 'Block'} ${esc(data.other.username)}</button></li>
        </ul></details>
      <a class="icon-btn" href="/messages/${esc(pid)}" aria-label="Open full conversation" title="Open full conversation">⤢</a>
      <button type="button" class="icon-btn dm-close" aria-label="Close window (history is kept)" title="Close (history is kept)">×</button>
    </div>
    <div class="dm-body" id="dm-body-${pid}">
      <ol class="msg-history dm-list" aria-live="polite"></ol>
      <div class="dm-notice" hidden></div>
      <form class="dm-composer">
        <label class="sr-only" for="dm-text-${pid}">Message ${esc(data.other.username)}</label>
        <textarea id="dm-text-${pid}" rows="2" maxlength="4000" placeholder="Message… (Enter to send)" data-ed-text></textarea>
        <div class="composer-tools">
          <button type="button" class="icon-btn" data-emoji-toggle aria-expanded="false" aria-label="Insert emoji">☺</button>
          <label class="icon-btn" title="Attach image"><span class="ico ico-image" aria-hidden="true"></span><span class="sr-only">Attach image</span><input type="file" class="sr-only" accept="image/png,image/jpeg,image/webp,image/gif" data-dm-upload></label>
          <span class="composer-uploads"></span>
          <button type="submit" class="btn btn-primary btn-small">Send</button>
        </div>
      </form>
    </div>`;
  w.list = $('.dm-list', el)!;
  renderMessages(w, data.messages, 'replace');
  updateComposerState(w, data.cannotSendReason);
  $('.dm-close', el)!.addEventListener('click', () => closeDm(pid));
  $('.dm-toggle', el)!.addEventListener('click', () => {
    const t = dockTabs.find((x) => x.pid === pid)!;
    t.minimized = !t.minimized;
    layoutDock();
    if (!t.minimized) { markRead(w); ($('textarea', el) as HTMLTextAreaElement).focus(); }
  });
  $('[data-dm-mute]', el)!.addEventListener('click', async () => {
    const r = await api(`/api/conversations/${pid}/mute`, { body: { on: w.muted ? '0' : '1' } });
    w.muted = r.muted; $('[data-dm-mute]', el)!.textContent = w.muted ? 'Unmute conversation' : 'Mute conversation';
    toast(w.muted ? 'Conversation muted — you won’t be notified. They can still message you.' : 'Conversation unmuted.');
  });
  $('[data-dm-block]', el)!.addEventListener('click', async () => {
    if (!w.blocked && !confirm(`Block ${w.other.username}? They won't be able to message you. History is kept.`)) return;
    const r = await api(`/api/conversations/${pid}/block`, { body: { on: w.blocked ? '0' : '1' } });
    w.blocked = r.blocked; await refreshWinState(w);
  });
  w.list.addEventListener('scroll', () => { if (w.list.scrollTop < 30 && w.hasMore) void loadOlder(w); });
  const form = $<HTMLFormElement>('.dm-composer', el)!;
  const ta = $<HTMLTextAreaElement>('textarea', form)!;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  ta.addEventListener('focus', () => markRead(w));
  form.addEventListener('submit', (e) => { e.preventDefault(); const body = ta.value.trim(); if (!body && !w.uploads.length) return; ta.value = ''; void sendDm(w, body, w.uploads.splice(0)); $('.composer-uploads', form)!.innerHTML = ''; });
  $<HTMLInputElement>('[data-dm-upload]', el)!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0]; input.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('purpose', 'message'); fd.append('file', f);
    try { const r = await api('/api/uploads', { body: fd }); w.uploads.push(r.publicId); $('.composer-uploads', form)!.insertAdjacentHTML('beforeend', `<img src="${esc(r.url)}" alt="Attached image" width="32" height="32">`); }
    catch (err: any) { toast(err.message, { kind: 'error' }); }
  });
  bindEmojiButtons(el);
}

async function refreshWinState(w: Win) {
  try {
    const d = await api(`/api/conversations/${w.pid}?limit=1`);
    Object.assign(w, { canSend: d.canSend, blocked: d.blocked, muted: d.muted });
    $('[data-dm-block]', w.el)!.textContent = `${w.blocked ? 'Unblock' : 'Block'} ${w.other.username}`;
    updateComposerState(w, d.cannotSendReason);
  } catch { /* ignore */ }
}

function updateComposerState(w: Win, reason: string | null) {
  const form = $<HTMLFormElement>('.dm-composer', w.el);
  const notice = $('.dm-notice', w.el);
  if (!form || !notice) return;
  form.hidden = !w.canSend;
  notice.hidden = w.canSend;
  notice.textContent = w.canSend ? '' : `${reason ?? 'You can’t send messages here.'} Your history stays available.`;
}

function renderMessages(w: Win, msgs: any[], mode: 'replace' | 'append' | 'prepend') {
  const html = msgs.filter((m) => !$(`[data-msg-id="${m.id}"]`, w.list)).map((m) => msgHtml(m, m.senderId === me(), w.other.username)).join('');
  const atBottom = w.list.scrollHeight - w.list.scrollTop - w.list.clientHeight < 40;
  if (mode === 'replace') w.list.innerHTML = html || '<li class="muted dm-empty">No messages yet — say hi!</li>';
  else if (mode === 'append') { $('.dm-empty', w.list)?.remove(); w.list.insertAdjacentHTML('beforeend', html); }
  else { const h = w.list.scrollHeight; w.list.insertAdjacentHTML('afterbegin', html); w.list.scrollTop = w.list.scrollHeight - h; }
  for (const m of msgs) { w.lastId = Math.max(w.lastId, m.id); w.firstId = w.firstId ? Math.min(w.firstId, m.id) : m.id; }
  if (mode !== 'prepend' && (atBottom || mode === 'replace')) w.list.scrollTop = w.list.scrollHeight;
  initEmbeds(w.list);
}

async function loadOlder(w: Win) {
  w.hasMore = false;
  try { const d = await api(`/api/conversations/${w.pid}?before=${w.firstId}&limit=30`); renderMessages(w, d.messages, 'prepend'); w.hasMore = d.hasMore; } catch { w.hasMore = true; }
}

async function sendDm(w: Win, body: string, uploads: string[], nonce = newNonce(), attempt = 0) {
  w.pending.set(nonce, { body, uploads });
  if (attempt === 0) {
    $('.dm-empty', w.list)?.remove();
    w.list.insertAdjacentHTML('beforeend', `<li class="msg mine pending" data-pending="${nonce}"><div class="msg-meta"><strong>You</strong> <span class="muted">sending…</span></div><div class="msg-body">${esc(body).replace(/\n/g, '<br>')}</div></li>`);
    w.list.scrollTop = w.list.scrollHeight;
  }
  try {
    const r = await api(`/api/conversations/${w.pid}/messages`, { body: { body, nonce, uploads } });
    w.pending.delete(nonce);
    $(`[data-pending="${nonce}"]`, w.list)?.remove();
    renderMessages(w, [r.message], 'append');
  } catch (e: any) {
    const li = $(`[data-pending="${nonce}"]`, w.list);
    if (!e.status && attempt < 4) {
      // network failure: retry with the same nonce (server de-duplicates)
      if (li) $('.muted', li)!.textContent = 'retrying…';
      setTimeout(() => void sendDm(w, body, uploads, nonce, attempt + 1), 1500 * (attempt + 1));
      return;
    }
    w.pending.delete(nonce);
    if (li) { li.classList.add('failed'); $('.muted', li)!.textContent = `not sent — ${e.message}`; }
  }
}

function initDock() {
  if (!me() || !$('[data-dock]')) return;
  document.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-open-dm]') as HTMLElement | null;
    if (t) { e.preventDefault(); void openDm({ userId: Number(t.dataset.openDm), username: t.dataset.dmName }); }
    const f = (e.target as HTMLElement).closest('[data-dock-focus]') as HTMLElement | null;
    if (f) void openDm({ pid: f.dataset.dockFocus });
  });
  // restore previously open tabs (the conversations themselves always live on the server)
  const saved = store.get<DockTab[]>('ff.dock.' + me(), []);
  const isFullView = location.pathname.startsWith('/messages/');
  if (!isFullView && !window.matchMedia('(max-width: 640px)').matches) for (const t of saved.slice(-6)) void openDm({ pid: t.pid, focus: false, minimized: t.minimized });
  on('message', (d) => {
    const w = wins.get(d.conversation);
    const mine = d.message.senderId === me();
    if (w) {
      // dedupe our own optimistic copy
      if (mine && d.message.nonce && w.pending.has(d.message.nonce)) return;
      void api(`/api/conversations/${w.pid}?after=${w.lastId}`).then((x) => { renderMessages(w, x.messages, 'append'); if (!mine) { const t = dockTabs.find((y) => y.pid === w.pid); if (t?.minimized || document.hidden) { setWinUnread(w, Number($('.dm-unread', w.el)?.textContent || 0) + 1); } else markRead(w); } });
    } else if (!mine && !isFullView) {
      // a new message from someone: open their window minimised with an unread badge
      void openDm({ pid: d.conversation, focus: false, minimized: true }).then(() => { const nw = wins.get(d.conversation); if (nw) setWinUnread(nw, 1); });
    }
    if (!mine) {
      const b = $('[data-badge="messages"]');
      setBadge('messages', Number(b?.textContent || 0) + 1);
      const fb = $(`[data-unread-for="${d.from.id}"]`);
      if (fb) { fb.textContent = String(Number(fb.textContent || 0) + 1); fb.hidden = false; }
      if (document.hidden || !w) toast(`New message from ${d.from.username}`, { href: `/messages/${d.conversation}` });
    }
  });
  on('read', (d) => { const w = wins.get(d.conversation); if (w) setWinUnread(w, 0); });
  on('relationship', () => { for (const w of wins.values()) void refreshWinState(w); });
  on('resync', () => {
    for (const w of wins.values()) void api(`/api/conversations/${w.pid}?after=${w.lastId}`).then((x) => renderMessages(w, x.messages, 'append')).catch(() => {});
    void api('/api/messages/unread').then((r) => setBadge('messages', r.unread)).catch(() => {});
  });
  window.addEventListener('focus', () => { for (const w of wins.values()) markRead(w); });
}

/** Full conversation page: live updates + ajax send with idempotency. */
function initConversationPage() {
  const view = $('[data-conversation]');
  if (!view) return;
  const pid = view.dataset.conversation!;
  const list = $('[data-msg-history]', view)!;
  let lastId = Math.max(0, ...$$('[data-msg-id]', list).map((li) => Number(li.dataset.msgId)));
  list.scrollTop = list.scrollHeight;
  const otherName = $('.conv-head .username', view)?.textContent ?? '';
  const fetchNew = async () => {
    const d = await api(`/api/conversations/${pid}?after=${lastId}`);
    const html = d.messages.filter((m: any) => !$(`[data-msg-id="${m.id}"]`, list)).map((m: any) => msgHtml(m, m.senderId === me(), otherName)).join('');
    if (html) { list.insertAdjacentHTML('beforeend', html); initEmbeds(list); window.scrollTo({ top: document.body.scrollHeight }); }
    for (const m of d.messages) lastId = Math.max(lastId, m.id);
    if (!document.hidden) await api(`/api/conversations/${pid}/read`, { body: { upTo: lastId } }).then((r) => setBadge('messages', r.unread));
  };
  on('message', (d) => { if (d.conversation === pid) void fetchNew(); });
  on('resync', () => void fetchNew());
  on('relationship', () => location.reload());
  const form = $<HTMLFormElement>('[data-msg-composer]', view);
  if (!form) return;
  const uploads: string[] = [];
  const ta = $<HTMLTextAreaElement>('textarea', form)!;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body && !uploads.length) return;
    const nonce = newNonce();
    const btn = $('button[type="submit"], button:not([type])', form) as HTMLButtonElement;
    btn.disabled = true;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await api(`/api/conversations/${pid}/messages`, { body: { body, nonce, uploads } }); ta.value = ''; uploads.length = 0; $('[data-msg-uploads]', form)!.innerHTML = ''; await fetchNew(); break; }
      catch (err: any) { if (err.status) { toast(err.message, { kind: 'error' }); break; } await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    btn.disabled = false;
  });
  $<HTMLInputElement>('[data-msg-upload]', form)?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0]; input.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('purpose', 'message'); fd.append('file', f);
    try { const r = await api('/api/uploads', { body: fd }); uploads.push(r.publicId); $('[data-msg-uploads]', form)!.insertAdjacentHTML('beforeend', `<img src="${esc(r.url)}" alt="Attached image" width="32" height="32">`); }
    catch (err: any) { toast(err.message, { kind: 'error' }); }
  });
}

// ───────────────────────── emoji picker ─────────────────────────

let custom: { shortcode: string; name: string; category: string; keywords: string; url: string }[] | null = null;
let picker: HTMLElement | null = null;
let pickerTarget: HTMLTextAreaElement | null = null;
let pickerButton: HTMLElement | null = null;

function insertAtCursor(ta: HTMLTextAreaElement, text: string, selectInner?: [number, number]) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  ta.focus();
  if (selectInner) ta.setSelectionRange(s + selectInner[0], s + selectInner[1]); else ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openPicker(btn: HTMLElement, target: HTMLTextAreaElement) {
  if (!custom) { try { custom = (await api('/api/emoji')).emoji; } catch { custom = []; } }
  closePicker();
  pickerTarget = target; pickerButton = btn;
  const recent = store.get<string[]>('ff.emoji.recent', []);
  picker = document.createElement('div');
  picker.className = 'emoji-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Emoji picker');
  const cell = (val: string, label: string, img?: string) => `<button type="button" class="emoji-cell" data-insert="${esc(val)}" title="${esc(label)}" aria-label="${esc(label)}">${img ? `<img src="${esc(img)}" alt="" width="24" height="24" loading="lazy">` : esc(val)}</button>`;
  const customByCat = new Map<string, typeof custom>();
  for (const e of custom!) customByCat.set(e.category, [...(customByCat.get(e.category) ?? []), e]);
  const recentCells = recent.map((r) => { const c = custom!.find((x) => `:${x.shortcode}:` === r); return c ? cell(r, c.name, c.url) : cell(r, r); }).join('');
  picker.innerHTML = `<div class="ep-head"><label class="sr-only" for="ep-search">Search emoji</label><input id="ep-search" type="search" placeholder="Search emoji…" autocomplete="off"><button type="button" class="icon-btn ep-close" aria-label="Close emoji picker">×</button></div>
    <div class="ep-body">
      ${recentCells ? `<h4>Recently used</h4><div class="ep-grid">${recentCells}</div>` : ''}
      ${[...customByCat].map(([cat, list]) => `<h4>${esc(cat)}</h4><div class="ep-grid">${list!.map((e) => cell(`:${e.shortcode}:`, `${e.name} :${e.shortcode}:`, e.url)).join('')}</div>`).join('')}
      ${STANDARD_EMOJI.map(([cat, items]) => `<h4>${esc(cat)}</h4><div class="ep-grid">${items.map(([ch, name]) => cell(ch, name)).join('')}</div>`).join('')}
    </div>`;
  document.body.appendChild(picker);
  const r = btn.getBoundingClientRect();
  const top = r.top > 340 ? r.top + window.scrollY - 330 : r.bottom + window.scrollY + 4;
  picker.style.top = `${Math.max(8, top)}px`;
  picker.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, r.left + window.scrollX))}px`;
  btn.setAttribute('aria-expanded', 'true');
  const search = $<HTMLInputElement>('#ep-search', picker)!;
  search.focus();
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const b of $$<HTMLElement>('.emoji-cell', picker!)) b.hidden = !!q && !(b.title.toLowerCase().includes(q) || (custom!.find((c) => `:${c.shortcode}:` === b.dataset.insert)?.keywords ?? '').toLowerCase().includes(q));
    for (const h of $$('h4', picker!)) { const grid = h.nextElementSibling!; h.hidden = (grid as HTMLElement).querySelectorAll('.emoji-cell:not([hidden])').length === 0; (grid as HTMLElement).hidden = h.hidden; }
  });
  picker.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-insert]') as HTMLElement | null;
    if (b && pickerTarget) {
      const val = b.dataset.insert!;
      insertAtCursor(pickerTarget, val.startsWith(':') ? ` ${val} ` : val);
      store.set('ff.emoji.recent', [val, ...recent.filter((x) => x !== val)].slice(0, 16));
      closePicker();
    }
    if ((e.target as HTMLElement).closest('.ep-close')) closePicker(true);
  });
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePicker(true); }
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      const cells = $$<HTMLElement>('.emoji-cell:not([hidden])', picker!);
      const i = cells.indexOf(document.activeElement as HTMLElement);
      if (i < 0) { if (e.key === 'ArrowDown') { cells[0]?.focus(); e.preventDefault(); } return; }
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 8 : -8;
      cells[Math.max(0, Math.min(cells.length - 1, i + step))]?.focus();
      e.preventDefault();
    }
  });
}
function closePicker(returnFocus = false) {
  picker?.remove(); picker = null;
  pickerButton?.setAttribute('aria-expanded', 'false');
  if (returnFocus) pickerButton?.focus();
}
function bindEmojiButtons(root: ParentNode) {
  for (const btn of $$('[data-emoji-toggle]', root)) {
    if ((btn as any).__bound) continue;
    (btn as any).__bound = true;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (picker && pickerButton === btn) { closePicker(true); return; }
      const scope = btn.closest('[data-editor], form, .dm-window') ?? document;
      const ta = $<HTMLTextAreaElement>('textarea', scope);
      if (ta) void openPicker(btn, ta);
    });
  }
}
document.addEventListener('click', (e) => { if (picker && !picker.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-emoji-toggle]')) closePicker(); });

// ───────────────────────── editor ─────────────────────────

function initEditors() {
  for (const ed of $$('[data-editor]')) {
    const ta = $<HTMLTextAreaElement>('[data-ed-text]', ed)!;
    const preview = $('[data-ed-preview]', ed)!;
    for (const b of $$<HTMLButtonElement>('[data-bb]', ed)) b.addEventListener('click', () => {
      const tag = b.dataset.bb!;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (tag === 'url') { const u = prompt('Link address (https://…)', 'https://'); if (!u) return; insertAtCursor(ta, `[url=${u}]${sel || 'link text'}[/url]`); return; }
      if (tag === 'media') { const u = prompt('YouTube or Vimeo link'); if (!u) return; insertAtCursor(ta, `\n[media]${u}[/media]\n`); return; }
      if (tag === 'list') { insertAtCursor(ta, `[list]\n[*]${sel || ''}\n[*]\n[/list]`, [8, 8 + (sel || '').length]); return; }
      const open = `[${tag}]`, close = `[/${tag}]`;
      insertAtCursor(ta, open + sel + close, [open.length, open.length + sel.length]);
    });
    $<HTMLSelectElement>('[data-bb-color]', ed)?.addEventListener('change', (e) => {
      const s = e.target as HTMLSelectElement; if (!s.value) return;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      insertAtCursor(ta, `[color=${s.value}]${sel}[/color]`); s.value = '';
    });
    const pbtn = $<HTMLButtonElement>('[data-preview-toggle]', ed)!;
    pbtn.addEventListener('click', async () => {
      const showing = !preview.hidden;
      if (showing) { preview.hidden = true; ta.hidden = false; pbtn.setAttribute('aria-pressed', 'false'); pbtn.textContent = 'Preview'; return; }
      pbtn.textContent = 'Loading…';
      try { const r = await api('/api/preview', { body: { body: ta.value } }); preview.innerHTML = r.html || '<p class="muted">Nothing to preview.</p>'; initEmbeds(preview); }
      catch (e: any) { preview.textContent = e.message; }
      preview.hidden = false; ta.hidden = true; pbtn.setAttribute('aria-pressed', 'true'); pbtn.textContent = 'Edit';
    });
    const up = $<HTMLInputElement>('[data-upload-input]', ed);
    up?.addEventListener('change', async () => {
      const f = up.files?.[0]; up.value = '';
      if (!f) return;
      const fd = new FormData(); fd.append('purpose', ed.dataset.uploadPurpose || 'post'); fd.append('file', f);
      try {
        const r = await api('/api/uploads', { body: fd });
        insertAtCursor(ta, `\n[img]${r.url}[/img]\n`);
        const form = ed.closest('form');
        const hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'uploads'; hidden.value = r.publicId; form?.appendChild(hidden);
        $('[data-ed-uploads]', ed)!.insertAdjacentHTML('beforeend', `<img src="${esc(r.url)}" alt="Uploaded image" width="48" height="48">`);
      } catch (e: any) { toast(e.message, { kind: 'error' }); }
    });
    // draft autosave
    const key = ed.dataset.draftKey;
    if (key && me()) {
      let t: number | undefined;
      const status = $('[data-draft-status]', ed);
      const titleInput = ed.closest('form')?.querySelector('input[name="title"]') as HTMLInputElement | null;
      const save = () => api('/api/drafts', { body: { key, body: ta.value, title: titleInput?.value } }).then(() => { if (status) status.textContent = `Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`; }).catch(() => {});
      ta.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(save, 2500); });
      titleInput?.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(save, 2500); });
    }
    bindEmojiButtons(ed);
  }
  bindEmojiButtons(document);
}

function initMultiQuote() {
  const list = $('[data-thread-id]');
  if (!list) return;
  const tid = list.dataset.threadId!;
  const keyName = `rf.mq.${tid}`;
  const sel = new Set<string>(store.get<string[]>(keyName, []));
  const sync = () => {
    for (const b of $$<HTMLButtonElement>('[data-multiquote]')) { const on = sel.has(b.dataset.multiquote!); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('active', on); b.textContent = on ? '−Quote' : '+Quote'; }
    store.set(keyName, [...sel]);
    const go = $<HTMLAnchorElement>('[data-multiquote-go]');
    if (go) { go.href = `/t/${tid}/reply${sel.size ? `?quote=${[...sel].join(',')}` : ''}`; go.textContent = sel.size ? `Reply with ${sel.size} quote${sel.size > 1 ? 's' : ''}` : 'Go advanced / insert multi-quotes'; }
  };
  for (const b of $$<HTMLButtonElement>('[data-multiquote]')) b.addEventListener('click', () => { const id = b.dataset.multiquote!; sel.has(id) ? sel.delete(id) : sel.add(id); sync(); });
  $('[data-multiquote-go]')?.addEventListener('click', () => store.set(keyName, []));
  sync();
}

// ───────────────────────── embeds, lightbox, reactions ─────────────────────────

function initEmbeds(root: ParentNode = document) {
  for (const box of $$('.embed[data-embed]', root)) {
    const btn = $('.embed-load', box);
    if (!btn || (btn as any).__bound) continue;
    (btn as any).__bound = true;
    btn.addEventListener('click', () => {
      const src = box.dataset.embed!;
      // only our own resolver produces these URLs; double-check the origin client-side too
      const allowed = ((document.querySelector('meta[name="embed-origins"]') as HTMLMetaElement | null)?.content ?? '').split(' ').filter(Boolean);
      if (!allowed.some((o) => src.startsWith(o + '/'))) return;
      const f = document.createElement('iframe');
      f.src = src;
      f.title = `${box.dataset.provider || 'Embedded'} content`;
      f.loading = 'lazy';
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.allow = 'encrypted-media; picture-in-picture; fullscreen';
      f.setAttribute('allowfullscreen', '');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      btn.replaceWith(f);
      box.classList.add('loaded');
    });
  }
}

function initLightbox() {
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[data-lightbox], .post-content img.bb-img') as HTMLElement | null;
    if (!a) return;
    const src = a.tagName === 'A' ? (a as HTMLAnchorElement).href : (a as HTMLImageElement).src;
    if (!src) return;
    e.preventDefault();
    const d = document.createElement('dialog');
    d.className = 'lightbox';
    d.setAttribute('aria-label', 'Image viewer');
    d.innerHTML = `<button type="button" class="icon-btn lb-close" aria-label="Close">×</button><img src="${esc(src)}" alt="Full size image"><a href="${esc(src)}" target="_blank" rel="noopener">Open original</a>`;
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (ev) => { if (ev.target === d || (ev.target as HTMLElement).closest('.lb-close')) d.close(); });
  });
}

function initReactions() {
  document.addEventListener('submit', async (e) => {
    const f = e.target as HTMLFormElement;
    if (f.dataset.ajax !== 'react') return;
    e.preventDefault();
    const postId = f.action.match(/\/p\/(\d+)\/react/)?.[1];
    try {
      const r = await api(f.action, { body: { reaction: (f.elements.namedItem('reaction') as HTMLInputElement).value } });
      const bar = $(`[data-reactions="${postId}"]`);
      if (bar) bar.innerHTML = r.reactions.map((x: any) => `<span class="reaction ${x.mine ? 'mine' : ''}" title="${esc(x.label)}"><span class="rx rx-${esc(x.key)}" aria-hidden="true"></span> ${esc(x.label)} × <strong>${x.count}</strong></span>`).join('') + (r.reactions.length ? ` <a href="/p/${postId}/reactions" class="reaction-list-link">(list)</a>` : '');
      (f.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
    } catch (err: any) { toast(err.message, { kind: 'error' }); }
  });
}

// ───────────────────────── forms helpers ─────────────────────────

function initFormHelpers() {
  for (const input of $$<HTMLInputElement>('[data-member-autocomplete]')) {
    const listId = input.getAttribute('list');
    const dl = listId ? document.getElementById(listId) : null;
    let t: number | undefined;
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 2 || !dl) return;
      t = window.setTimeout(async () => { try { const r = await api(`/api/members/autocomplete?q=${encodeURIComponent(q)}`); dl.innerHTML = r.members.map((m: any) => `<option value="${esc(m.username)}">`).join(''); } catch { /* ignore */ } }, 200);
    });
  }
  for (const input of $$<HTMLInputElement>('[data-username-check]')) {
    const hint = document.createElement('div');
    hint.className = 'field-hint username-status'; hint.setAttribute('aria-live', 'polite');
    input.insertAdjacentElement('afterend', hint);
    let t: number | undefined;
    input.addEventListener('input', () => {
      clearTimeout(t);
      const v = input.value.trim();
      if (v.length < 3) { hint.textContent = ''; return; }
      t = window.setTimeout(async () => { try { const r = await api(`/api/username-available?u=${encodeURIComponent(v)}`); hint.textContent = r.ok ? `✓ ${v} is available` : `✗ ${r.message}`; hint.classList.toggle('ok', r.ok); hint.classList.toggle('bad', !r.ok); } catch { /* ignore */ } }, 350);
    });
  }
  for (const sel of $$<HTMLSelectElement>('select[data-detect-timezone]')) {
    try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (sel.value === 'UTC' && [...sel.options].some((o) => o.value === tz)) sel.value = tz; } catch { /* ignore */ }
  }
  // live theme preview: module themes keep their tokens in their own stylesheet, so load it before switching
  for (const r of $$<HTMLInputElement>('input[data-theme-preview]')) r.addEventListener('change', () => {
    const root = document.documentElement;
    const apply = () => { root.dataset.theme = r.value; root.dataset.scheme = r.dataset.themeScheme || 'light'; document.dispatchEvent(new Event('fragged:relayout')); };
    const css = r.dataset.themeCss || '';
    let link = document.getElementById('theme-css') as HTMLLinkElement | null;
    if (!css) { apply(); return; }
    if (link && link.getAttribute('href') === css) { apply(); return; }
    if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.id = 'theme-css'; document.head.appendChild(link); }
    link.addEventListener('load', apply, { once: true });
    link.addEventListener('error', apply, { once: true });
    link.href = css;
  });
  // profile colour picker live preview (mirrors server-side contrast logic)
  const cp = $('[data-colour-picker]');
  if (cp) {
    const input = $<HTMLInputElement>('[data-colour-input]', cp)!;
    const prev = $('[data-colour-preview]', cp)!;
    const def = $<HTMLInputElement>('input[name="useDefaultBg"]', cp);
    for (const sw of $$<HTMLButtonElement>('[data-colour-preset]', cp)) {
      sw.style.background = sw.dataset.colourPreset!;
      sw.addEventListener('click', () => { input.value = sw.dataset.colourPreset!; if (def) def.checked = false; apply(); });
    }
    const apply = () => {
      if (def?.checked) { prev.removeAttribute('style'); return; }
      const p = palette(input.value);
      prev.style.background = p.bg; prev.style.color = p.text;
      const panel = $('.cp-panel', prev) as HTMLElement; panel.style.background = p.panel; panel.style.color = p.text;
      ($('a', prev) as HTMLElement).style.color = p.link;
    };
    input.addEventListener('input', () => { if (def) def.checked = false; apply(); });
    def?.addEventListener('change', apply);
    apply();
  }
}

function lum(hex: string) { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
function contrast(a: string, b: string) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function mix(a: string, b: string, t: number) { return '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) + (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * t).toString(16).padStart(2, '0')).join(''); }
function palette(input: string) {
  let bg = input;
  for (let i = 0; i < 20 && Math.max(contrast(bg, '#ffffff'), contrast(bg, '#111111')) < 4.5; i++) bg = mix(bg, contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#000000' : '#ffffff', 0.08);
  const text = contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';
  let panel = mix(bg, text === '#ffffff' ? '#000000' : '#ffffff', 0.55);
  if (contrast(panel, text) < 7) panel = text === '#ffffff' ? '#1a1a1a' : '#f7f7f7';
  return { bg, text, panel, link: text === '#ffffff' ? '#9fd0ff' : '#0b4f8a' };
}

// ───────────────────────── log filters ─────────────────────────

function initLogFilters() {
  const form = $<HTMLFormElement>('form.flt-form');
  if (!form) return;
  // the Area / Type-of-event choice narrows the Action / Event list to that group
  const cat = $<HTMLSelectElement>('#flt-category', form);
  const detail = $<HTMLSelectElement>('#flt-action, #flt-kind', form);
  if (cat && detail) {
    const sync = () => {
      const label = cat.value ? cat.options[cat.selectedIndex].text : '';
      for (const g of $$<HTMLOptGroupElement>('optgroup', detail)) {
        const show = !label || g.label === label;
        g.hidden = !show; g.disabled = !show;
      }
      const sel = detail.options[detail.selectedIndex];
      if (sel && (sel.parentElement as HTMLOptGroupElement).disabled) detail.value = '';
    };
    cat.addEventListener('change', sync);
    sync();
  }
  // keep shareable URLs short: don't submit empty fields
  form.addEventListener('submit', () => {
    for (const el of $$<HTMLInputElement | HTMLSelectElement>('input[name], select[name]', form)) if (!el.value) el.disabled = true;
    setTimeout(() => { for (const el of $$<HTMLInputElement>('[name]', form)) el.disabled = false; }, 0);
  });
}

// ───────────────────────── boot ─────────────────────────

function boot() {
  initMenus();
  initPane();
  initNotifications();
  initEvents();
  initDock();
  initConversationPage();
  initEditors();
  initMultiQuote();
  initEmbeds();
  initLightbox();
  initReactions();
  initFormHelpers();
  initLogFilters();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
