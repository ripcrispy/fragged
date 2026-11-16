import type { Child, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { PageCtx } from './ctx.ts';
import { Breadcrumbs, Csrf, Logo, Notice, Avatar, Presence, UserLink } from './components.tsx';
import { themeById } from './themes.ts';
import { embedOrigins } from '../lib/media.ts';
import { themeStylesheet, moduleStylesheets } from '../modules/runtime.ts';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Content hash for cache-busting core assets (computed once per process; production rebuilds restart the server). */
const assetVersions = new Map<string, string>();
function assetVersion(file: string): string {
  let v = assetVersions.get(file);
  if (!v) {
    try { v = createHash('sha256').update(fs.readFileSync(`public/${file}`)).digest('hex').slice(0, 10); } catch { v = '0'; }
    assetVersions.set(file, v);
  }
  return v;
}
import type { UserCard } from '../services/users.ts';

export interface PaneFriend { card: UserCard; unread: number }
export interface PaneData { friends: PaneFriend[]; requests: number; online: { count: number; members: UserCard[] } }

export interface LayoutProps {
  ctx: PageCtx;
  title: string;
  crumbs?: { label: string; href?: string }[];
  pane?: PaneData | null;
  /** hide the friends pane on this page (e.g. full messages view, admin) */
  noPane?: boolean;
  description?: string;
  bodyClass?: string;
  groupCss?: string;
}


function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: 'M3 11 L12 3 L21 11 V21 H14 V15 H10 V21 H3 Z',
    forums: 'M3 4 H21 V15 H9 L4 20 V15 H3 Z',
    new: 'M12 2 L14.6 8.6 L22 9 L16.2 13.6 L18 21 L12 17 L6 21 L7.8 13.6 L2 9 L9.4 8.6 Z',
    search: 'M10 3 A7 7 0 1 1 9.99 3 Z M15 15 L21 21',
    members: 'M8 11 A3.5 3.5 0 1 1 8.01 11 Z M2 21 C2 16 5 14 8 14 C11 14 14 16 14 21 Z M17 10 A3 3 0 1 1 17.01 10 Z M15 14 C19 13 22 15 22 20 H16',
    messages: 'M2 5 H22 V19 H2 Z M2 5 L12 13 L22 5',
    rules: 'M5 2 H16 L20 6 V22 H5 Z M8 9 H17 M8 13 H17 M8 17 H14',
    calendar: 'M3 5 H21 V21 H3 Z M3 10 H21 M8 2 V7 M16 2 V7',
    monitor: 'M2 4 H22 V16 H2 Z M8 21 H16 M12 16 V21',
    cup: 'M4 8 H17 V15 A5 5 0 0 1 12 20 H9 A5 5 0 0 1 4 15 Z M17 10 H19 A2 2 0 0 1 19 14 H17 M8 2 V5 M12 2 V5',
    seat: 'M7 3 H17 V12 H7 Z M5 12 H19 V15 H5 Z M7 15 V21 M17 15 V21',
    pizza: 'M3 6 Q12 1 21 6 L12 22 Z M4.5 8.5 Q12 4.5 19.5 8.5 M9 11 h.01 M14 12 h.01 M11.5 16 h.01',
    star: 'M12 2 L14.6 8.6 L22 9 L16.2 13.6 L18 21 L12 17 L6 21 L7.8 13.6 L2 9 L9.4 8.6 Z',
  };
  return <svg class="nav-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d={paths[name] ?? paths.star} /></svg>;
}

export function Layout({ ctx, title, crumbs = [], pane, noPane, description, bodyClass = '', groupCss = '', children }: PropsWithChildren<LayoutProps>) {
  const v = ctx.viewer;
  const user = v.user;
  const showPane = !noPane && pane !== undefined && pane !== null;
  const collapsed = !!v.settings.friendsPaneCollapsed;
  const fullTitle = title ? `${title} — ${ctx.site.site_name}` : ctx.site.site_name;
  const active = (href: string) => (href === '/' ? ctx.path === '/' : ctx.path === href || ctx.path.startsWith(href + '/')) ? 'active' : '';
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en" data-theme={ctx.theme} data-scheme={themeById(ctx.theme)?.scheme ?? 'light'}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{fullTitle}</title>
          {description ? <meta name="description" content={description} /> : null}
          <meta name="csrf-token" content={ctx.csrf} />
          <meta name="embed-origins" content={embedOrigins().join(' ')} />
          <meta name="color-scheme" content={themeById(ctx.theme)?.scheme ?? 'light'} />
          <link rel="icon" href="/img/favicon.svg" type="image/svg+xml" />
          <link rel="stylesheet" href={`/css/app.css?v=${assetVersion('css/app.css')}`} />
          {moduleStylesheets().map((href) => <link rel="stylesheet" href={href} />)}
          {themeStylesheet(ctx.theme) ? <link rel="stylesheet" id="theme-css" href={themeStylesheet(ctx.theme)!} /> : null}
          {groupCss || ctx.pageStyle ? <style nonce={ctx.nonce}>{raw((groupCss + (ctx.pageStyle ?? '')).replace(/<\//g, ''))}</style> : null}
          <script src={`/js/app.js?v=${assetVersion('js/app.js')}`} defer nonce={ctx.nonce}></script>
        </head>
        <body class={`${bodyClass} ${showPane ? 'with-pane' : ''} ${showPane && collapsed ? 'pane-collapsed' : ''} ${user ? 'signed-in' : 'guest'}`} data-user-id={user?.id ?? ''} data-username={user?.username ?? ''}>
          <a class="skip-link" href="#main">Skip to content</a>
          <header class="site-header">
            <div class="wrap header-inner">
              <a class="logo" href="/" aria-label={`${ctx.site.site_name} home`}><Logo name={ctx.site.site_name} /></a>
              <span class="tagline">{ctx.site.site_tagline}</span>
              <div class="header-account">
                {user ? <AccountBox ctx={ctx} /> : <HeaderLogin ctx={ctx} />}
              </div>
            </div>
          </header>
          <nav class="navbar" aria-label="Main">
            <div class="wrap navbar-inner">
              <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav-links" data-nav-toggle>
                <span aria-hidden="true">☰</span><span class="sr-only">Menu</span>
              </button>
              <ul class="nav-links" id="nav-links">
                {(ctx.nav?.main ?? []).map(({ href, label, icon }) => (
                  <li><a href={href} class={active(href)} aria-current={active(href) ? 'page' : undefined}><NavIcon name={icon ?? "star"} />{label}
                    {href === '/messages' && ctx.counts.messages ? <span class="badge" data-badge="messages">{ctx.counts.messages}<span class="sr-only"> unread</span></span> : href === '/messages' ? <span class="badge" data-badge="messages" hidden /> : null}
                  </a></li>
                ))}
                {ctx.canMod ? <li><a href="/mod" class={active('/mod')}>Moderation{ctx.counts.modQueue ? <span class="badge badge-alert">{ctx.counts.modQueue}</span> : null}</a></li> : null}
                {ctx.canAdmin ? <li><a href="/admin" class={active('/admin')}>Admin</a></li> : null}
                {/* filled by the client when the links don't fit on one line */}
                <li class="nav-more" hidden data-nav-more>
                  <button type="button" class="nav-more-btn" aria-expanded="false" aria-controls="nav-more-menu" data-nav-more-btn>
                    More <svg class="nav-more-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true" focusable="false"><path d="M1 1 L5 5 L9 1" /></svg>
                  </button>
                  <ul class="nav-more-menu" id="nav-more-menu" hidden />
                </li>
              </ul>
              <form class="nav-search" action="/search" method="get" role="search">
                <label for="nav-q" class="sr-only">Search forums</label>
                <input id="nav-q" name="q" type="search" placeholder="Search…" maxlength={200} />
                <button type="submit" class="btn btn-small">Go</button>
              </form>
              {showPane ? <button type="button" class="pane-toggle btn btn-small" data-pane-toggle aria-controls="friends-pane" aria-expanded={collapsed ? 'false' : 'true'}>
                <span class="pane-toggle-label">Friends</span><span class="badge" hidden={!pane!.requests}>{pane!.requests || ''}</span>
              </button> : null}
            </div>
          </nav>
          <div class="wrap page">
            {crumbs.length ? <Breadcrumbs items={crumbs} /> : null}
            {ctx.site.announcement ? <div class="announcement" role="note">{ctx.site.announcement}</div> : null}
            {v.ban ? <Notice type="error" title={v.ban.kind === 'ban' ? 'Your account is banned.' : 'Your account is suspended.'}>
              <p>Reason: {v.ban.reason}{v.ban.expiresAt ? ` — until ${v.ban.expiresAt.toISOString().slice(0, 10)}` : ''}. You can read the forums, but cannot post, message or react.</p>
            </Notice> : null}
            {user && v.subject.unverified ? <Notice type="warn" title="Please verify your email address.">
              <p>We sent a link to {user.email}. Until you verify, you can read but not post.</p>
              <form method="post" action="/verify-email/resend" class="inline-form"><Csrf ctx={ctx} /><button class="btn btn-small">Resend verification email</button></form>
            </Notice> : null}
            {ctx.flash.map((f) => <Notice type={f.type === 'ok' ? 'ok' : f.type === 'error' ? 'error' : 'info'}>{f.text}</Notice>)}
            <div class="layout">
              <main id="main" tabindex={-1}>{children}</main>
              {showPane ? <FriendsPane ctx={ctx} pane={pane!} collapsed={collapsed} /> : null}
            </div>
          </div>
          <footer class="site-footer">
            <div class="wrap footer-inner">
              <nav aria-label="Footer"><ul class="footer-links">
                {(ctx.nav?.footer ?? []).map((n) => <li><a href={n.href}>{n.label}</a></li>)}
                <li><a href="/settings/preferences">Theme: {themeById(ctx.theme)?.name}</a></li>
              </ul></nav>
              <p class="footer-note">{ctx.site.site_name} is an independent community. All times shown in {v.user?.timezone ?? 'UTC'}.</p>
            </div>
          </footer>
          {user ? <div id="dm-dock" class="dm-dock" role="region" aria-label="Direct message windows" data-dock></div> : null}
          <div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>
        </body>
      </html>
    </>
  );
}

function HeaderLogin({ ctx }: { ctx: PageCtx }) {
  const back = ctx.path.startsWith('/login') || ctx.path.startsWith('/register') ? '/' : ctx.url.pathname + ctx.url.search;
  return (
    <form class="header-login" method="post" action="/login" aria-label="Sign in">
      <Csrf ctx={ctx} />
      <input type="hidden" name="returnTo" value={back} />
      <label class="sr-only" for="hl-login">Username or email</label>
      <input id="hl-login" name="login" placeholder="Username or email" autocomplete="username" required maxlength={254} />
      <label class="sr-only" for="hl-pw">Password</label>
      <input id="hl-pw" name="password" type="password" placeholder="Password" autocomplete="current-password" required maxlength={200} />
      <label class="remember"><input type="checkbox" name="remember" value="1" /> Remember</label>
      <button type="submit" class="btn btn-primary btn-small">Sign in</button>
      <span class="header-links"><a href="/register">Register</a> · <a href="/login">More options</a></span>
    </form>
  );
}

function AccountBox({ ctx }: { ctx: PageCtx }) {
  const u = ctx.viewer.user!;
  return (
    <div class="account-box">
      <details class="menu notif-menu" data-notif-menu>
        <summary class="btn btn-small btn-ghost" aria-label={`Notifications${ctx.counts.notifications ? `, ${ctx.counts.notifications} unread` : ''}`}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 17 V11 A6 6 0 0 1 18 11 V17 L20 19 H4 Z M10 21 H14" /></svg>
          <span class="badge" data-badge="notifications" hidden={!ctx.counts.notifications}>{ctx.counts.notifications || ''}</span>
        </summary>
        <div class="menu-panel notif-panel" role="region" aria-label="Notifications">
          <div class="menu-head"><strong>Notifications</strong>
            <form method="post" action="/notifications/read" class="inline-form" data-ajax="notif-read-all"><Csrf ctx={ctx} /><input type="hidden" name="all" value="1" /><button class="link-btn">Mark all read</button></form>
          </div>
          <ul class="notif-list" data-notif-list><li class="muted">Loading…</li></ul>
          <div class="menu-foot"><a href="/notifications">All notifications</a> · <a href="/settings/notifications">Settings</a></div>
        </div>
      </details>
      <details class="menu user-menu">
        <summary class="btn btn-small btn-ghost user-summary"><span class="hello">Signed in as</span> <strong>{u.username}</strong>{ctx.counts.friendRequests ? <span class="badge">{ctx.counts.friendRequests}</span> : null}</summary>
        <ul class="menu-panel" role="list">
          <li><a href={`/u/${encodeURIComponent(u.username)}`}>My profile</a></li>
          {(ctx.nav?.userMenu ?? []).map((n) => <li><a href={n.href}>{n.label}{n.href === '/friends' && ctx.counts.friendRequests ? ` (${ctx.counts.friendRequests} requests)` : ''}</a></li>)}
          <li><form method="post" action="/logout"><Csrf ctx={ctx} /><button class="link-btn">Sign out</button></form></li>
        </ul>
      </details>
    </div>
  );
}

function FriendsPane({ ctx, pane, collapsed }: { ctx: PageCtx; pane: PaneData; collapsed: boolean }) {
  const user = ctx.viewer.user;
  return (
    <aside id="friends-pane" class="friends-pane" aria-label={user ? 'Friends' : 'Community'} data-friends-pane hidden={collapsed ? true : undefined}>
      {user ? (
        <>
          <div class="pane-head">
            <h2>Friends <span class="muted" data-friend-online-count>({pane.friends.filter((f) => f.card.presence === 'online' || f.card.presence === 'away').length} online)</span></h2>
            <button type="button" class="icon-btn" data-pane-toggle aria-label="Collapse friends pane">×</button>
          </div>
          <div data-pane-body><FriendsPaneBody pane={pane} /></div>
          <div class="pane-foot"><a href="/friends">Manage friends</a> · <a href="/messages">All messages</a></div>
        </>
      ) : (
        <>
          <div class="pane-head"><h2>Community</h2><button type="button" class="icon-btn" data-pane-toggle aria-label="Collapse community pane">×</button></div>
          <p class="pane-empty">Join Fragged to add friends, chat in real time and customise your profile.</p>
          <p class="pane-cta"><a class="btn btn-primary" href="/register">Create an account</a></p>
        </>
      )}
      {ctx.site.show_online_list ? (
        <div class="pane-online">
          <h3>Online now <span class="muted">({pane.online.count})</span></h3>
          {pane.online.members.length ? <p class="online-list">{pane.online.members.slice(0, 30).map((m, i) => <>{i ? ', ' : ''}<UserLink user={m} /></>)}</p> : <p class="muted">Nobody visible right now.</p>}
        </div>
      ) : null}
    </aside>
  );
}

/** Friends list portion of the pane; also served alone by GET /api/pane for live refresh. */
export function FriendsPaneBody({ pane }: { pane: PaneData }) {
  return (
    <>
      {pane.requests ? <a class="pane-requests" href="/friends">{pane.requests} pending friend request{pane.requests === 1 ? '' : 's'}</a> : null}
      {pane.friends.length > 6 ? <div class="pane-filter"><label class="sr-only" for="pane-filter">Filter friends</label><input id="pane-filter" type="search" placeholder="Filter friends…" data-pane-filter /></div> : null}
      {pane.friends.length ? (
        <ul class="pane-friends" data-pane-friends>
          {pane.friends.map((f) => (
            <li class="pane-friend" data-username={f.card.username.toLowerCase()} data-user-id={f.card.id}>
              <Avatar user={f.card} size={28} />
              <span class="pane-name"><UserLink user={f.card} /><Presence p={f.card.presence} /></span>
              <button type="button" class="pane-dm" data-open-dm={f.card.id} data-dm-name={f.card.username} aria-label={`Message ${f.card.username}${f.unread ? `, ${f.unread} unread` : ''}`}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 5 H21 V17 H9 L4 21 V17 H3 Z" /></svg>
                {f.unread ? <span class="badge" data-unread-for={f.card.id}>{f.unread}</span> : <span class="badge" data-unread-for={f.card.id} hidden />}
              </button>
            </li>
          ))}
        </ul>
      ) : <p class="pane-empty">No friends yet. Visit a member's profile and choose <em>Add friend</em>, or browse the <a href="/members">member list</a>.</p>}
    </>
  );
}

export function ErrorPage({ ctx, status, title, message, loginForm }: { ctx: PageCtx; status: number; title: string; message: string; loginForm?: boolean }) {
  return (
    // Content only: callers render it through page(), which supplies the single site shell.
    <section class="box error-box" aria-labelledby="err-title">
        <div class="box-head"><h1 class="box-title" id="err-title">{title}</h1></div>
        <div class="box-body">
          <p class="error-message">{message}</p>
          {loginForm ? <LoginPanel ctx={ctx} returnTo={ctx.url.pathname + ctx.url.search} /> : null}
          <p class="error-links"><a href="/">Return to the forum index</a>{status === 404 ? <> · <a href="/search">Search</a></> : null}</p>
        </div>
      </section>
  );
}

/** Reusable sign-in panel (used on /login and on permission-denied pages). */
export function LoginPanel({ ctx, returnTo, error, login }: { ctx: PageCtx; returnTo?: string; error?: string; login?: string }) {
  return (
    <div class="login-panel">
      <form method="post" action="/login" class="form-grid">
        <Csrf ctx={ctx} />
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        {error ? <Notice type="error">{error}</Notice> : null}
        <div class="field"><label for="lp-login">Username or email</label><input id="lp-login" name="login" value={login ?? ''} autocomplete="username" required maxlength={254} /></div>
        <div class="field"><label for="lp-pw">Password</label><input id="lp-pw" name="password" type="password" autocomplete="current-password" required maxlength={200} /></div>
        <div class="field field-check"><label><input type="checkbox" name="remember" value="1" /> Keep me signed in on this device</label></div>
        <div class="form-actions"><button class="btn btn-primary">Sign in</button> <a href="/forgot-password">Forgot your password?</a></div>
      </form>
    </div>
  );
}

export type { Child };
