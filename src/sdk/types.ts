/**
 * Fragged Forums module SDK — public types.
 *
 * Everything a module may rely on is declared here and re-exported from `src/sdk/index.ts`. Core internals
 * may change between releases; this surface follows semantic versioning via SDK_VERSION (see docs/MODULES.md).
 */
import type { Child } from 'hono/jsx';
import type { Hono } from 'hono';
import type { ZodType } from 'zod';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import type { Viewer } from '../services/viewer.ts';
import type { DB } from '../db/client.ts';
import type { User, Profile, UserCard } from '../services/users.ts';
import type { Identity } from '../services/oauth.ts';
import type { ResolvedMedia } from '../lib/media.ts';

export type { Child, Viewer, User, Profile, UserCard, PageCtx, C as RequestContext, Env, DB, Identity, ResolvedMedia };

// ───────────────────────────── manifest ─────────────────────────────

export interface PermissionDecl {
  /** Shown in Admin › Groups & permissions */
  label: string;
  /** Group slugs that receive this permission when the module is first installed (admins always have it). */
  grantTo?: string[];
}

export type SettingField =
  | { key: string; label: string; type: 'boolean'; hint?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; hint?: string }
  | { key: string; label: string; type: 'string' | 'url' | 'text'; maxLength?: number; hint?: string }
  | { key: string; label: string; type: 'select'; options: [string, string][]; hint?: string }
  /** read-only: whether an environment variable is set (secrets never live in the database) */
  | { key: string; label: string; type: 'env'; env: string; hint?: string };

export interface ModuleManifest {
  /** lowercase, kebab-case, unique; also the prefix for permissions (`<id>.<perm>`) and tables (`mod_<id>_*`) */
  id: string;
  name: string;
  /** semver */
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** semver range of the SDK this module was written for, e.g. "^1.0.0" */
  sdk: string;
  /** required modules: id → semver range */
  dependencies?: Record<string, string>;
  /** used when present and enabled: id → semver range */
  optionalDependencies?: Record<string, string>;
  /** modules that cannot be enabled at the same time */
  conflicts?: string[];
  /** default for new installs (true unless stated) */
  enabledByDefault?: boolean;
  /** permissions this module defines; keys are prefixed with the module id automatically */
  permissions?: Record<string, PermissionDecl>;
  /** validated settings; `defaults` must satisfy `schema` */
  settings?: { schema: ZodType<any>; defaults: Record<string, unknown>; fields: SettingField[] };
  /** notification kinds this module may send: key → label (shown in members' notification settings) */
  notificationKinds?: Record<string, string>;
  /** folder of `NNNN_name.sql` migrations, relative to the module's directory (e.g. "migrations") */
  migrations?: string;
  /** folder served at /modules/<id>/… while the module is enabled, relative to the module's directory (e.g. "public") */
  assets?: string;
  /** stylesheets (inside `assets`) included on every page while the module is enabled */
  styles?: string[];
}

export interface ModuleDefinition extends ModuleManifest {
  /** Register hooks, extensions and routes. Runs at boot for every available module (enabled or not). */
  setup?(ctx: ModuleContext): void | Promise<void>;
  /** After the app is ready, for enabled modules (start timers/jobs here). */
  start?(ctx: ModuleContext): void | Promise<void>;
  /** On shutdown or when disabled at runtime. */
  stop?(ctx: ModuleContext): void | Promise<void>;
  /** First time the module is seen by this installation (after its migrations). */
  onInstall?(ctx: ModuleContext): void | Promise<void>;
  /** The installed version changed. */
  onUpgrade?(ctx: ModuleContext, fromVersion: string): void | Promise<void>;
  onEnable?(ctx: ModuleContext): void | Promise<void>;
  onDisable?(ctx: ModuleContext): void | Promise<void>;
}

// ───────────────────────────── hooks ─────────────────────────────

/** Actions: notifications that something happened (handlers run in order; errors are logged, never fatal). */
export interface ActionHooks {
  'user.registered': { userId: number; provider: string };
  'user.loggedIn': { userId: number; provider: string };
  /** account closed: remove or anonymise this member's module data */
  'user.closed': { userId: number };
  'thread.created': { threadId: number; forumId: number; userId: number; postId: number };
  'post.created': { postId: number; threadId: number; forumId: number; userId: number; position: number };
  'post.reacted': { postId: number; authorId: number; userId: number; reaction: string; added: boolean };
  'friend.accepted': { userId: number; friendId: number };
  'profile.commented': { profileUserId: number; authorId: number; commentId: number };
  'message.sent': { conversationId: number; messageId: number; senderId: number; recipientId: number };
  'report.created': { reportId: number; targetType: string; targetId: number; reporterId: number };
  'audit.recorded': { actorId: number | null; action: string; targetType: string | null; targetId: number | null };
}
/** Filters: transform or veto a value. Throw `ServiceError` to reject (shown to the user); other errors are logged and skipped. */
export interface FilterHooks {
  'post.beforeSave': { body: string; userId: number; forumId: number; kind: 'thread' | 'reply' | 'edit' };
  'message.beforeSend': { body: string; senderId: number; recipientId: number };
  'profile.comment.beforeSave': { body: string; authorId: number; profileUserId: number };
}

// ───────────────────────────── extension points ─────────────────────────────

export interface ThemeDef {
  id: string;
  name: string;
  scheme: 'light' | 'dark';
  description: string;
  /** stylesheet (relative to the module's assets dir) defining `[data-theme="<id>"] { --tokens… }` */
  stylesheet?: string;
}

/** OAuth 2.0 / OIDC provider. Core runs the flow (state, PKCE, linking, registration); providers only talk to the IdP. */
export interface AuthProviderDef {
  id: string;
  name: string;
  /** whether the provider supports PKCE (a verifier is always generated) */
  pkce: boolean;
  /** provider returns via cross-site POST (Apple) */
  formPost?: boolean;
  /** true when credentials are configured (read from environment variables) */
  configured(): boolean;
  authUrl(state: string, verifier: string, nonce: string, redirectUri: string): URL;
  exchange(params: { code: string; verifier: string; nonce: string; redirectUri: string; form?: Record<string, string> }): Promise<Identity>;
  /** environment variables an operator must set (shown in Admin › Sign-in providers) */
  envVars?: string[];
}

/** External media recogniser: map a URL to a fixed, safe embed URL (never arbitrary HTML). */
export interface MediaProviderDef {
  id: string;
  name: string;
  /** origins the embeds are served from; added to the CSP frame-src while the module is enabled */
  embedOrigins: string[];
  match(url: URL): { kind: 'video' | 'audio'; embedUrl: string; aspect: 'video' | 'spotify-track' | 'spotify-list'; title?: string } | null;
}

export interface ProfileSectionArgs { viewer: Viewer; user: User; isSelf: boolean; ctx: PageCtx }
export interface ProfileSection {
  id: string;
  /** 'side' (narrow column) or 'main' */
  column: 'side' | 'main';
  order: number;
  render(args: ProfileSectionArgs): Child | null | Promise<Child | null>;
}

export interface ProfileSettingsSection {
  id: string;
  order: number;
  /** fields rendered inside Settings › Profile (use the SDK form components) */
  render(args: { viewer: Viewer; errors: Record<string, string> }): Child | Promise<Child>;
  /** validate + save; return field errors (empty when saved) */
  save(args: { viewer: Viewer; form: Record<string, unknown> }): Promise<Record<string, string>>;
}

export interface NavItem {
  href: string;
  label: string;
  /** lower sorts first; core main-nav items use 10, 20, … 70 */
  order: number;
  /** main-nav icon: home | forums | new | search | members | messages | rules | calendar | monitor | cup | seat | pizza | star (default: star) */
  icon?: string;
  /** where it appears */
  area: 'main' | 'footer' | 'user-menu';
  visible?(viewer: Viewer): boolean | Promise<boolean>;
}

export interface AdminSection {
  /** URL is /admin/m/<moduleId>/<slug>; the page is mounted from the module's admin router */
  slug: string;
  /** filled in by core */
  readonly href?: string;
  label: string;
  /** permission required to see the link (admin.access is always required too) */
  permission: string;
}

/** Item counts surfaced in the moderation overview and the header badge. */
export interface ModQueueSource {
  id: string;
  label: string;
  href: string;
  permission: string;
  count(): Promise<number>;
}

/** Extra panel on Admin › Users › <member>. */
export interface AdminUserPanel {
  id: string;
  title: string;
  permission: string;
  order: number;
  render(args: { viewer: Viewer; user: User; ctx: PageCtx }): Child | Promise<Child>;
}

// ───────────────────────────── module context ─────────────────────────────

export interface ModuleLogger { debug(m: string, f?: Record<string, unknown>): void; info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void }

export interface ModuleContext {
  readonly id: string;
  readonly version: string;
  readonly log: ModuleLogger;
  /** Database handle (core tables via `schema`, module tables via your own Drizzle definitions). */
  db(): DB;
  isEnabled(): boolean;
  settings: {
    get<T = Record<string, unknown>>(): Promise<T>;
    set(values: Record<string, unknown>): Promise<void>;
  };
  hooks: {
    on<K extends keyof ActionHooks>(name: K, handler: (payload: ActionHooks[K]) => void | Promise<void>, opts?: { priority?: number }): void;
    filter<K extends keyof FilterHooks>(name: K, handler: (value: FilterHooks[K]) => FilterHooks[K] | Promise<FilterHooks[K]>, opts?: { priority?: number }): void;
  };
  /** Public routes mounted at /m/<id>/… (session, CSRF and maintenance mode already applied). */
  routes: Hono<Env>;
  /** Admin routes mounted at /admin/m/<id>/… (admin.access already required). */
  adminRoutes: Hono<Env>;
  register: {
    theme(t: ThemeDef): void;
    authProvider(p: AuthProviderDef): void;
    mediaProvider(p: MediaProviderDef): void;
    profileSection(s: ProfileSection): void;
    profileSettings(s: ProfileSettingsSection): void;
    navItem(n: NavItem): void;
    adminSection(s: AdminSection): void;
    modQueue(q: ModQueueSource): void;
    adminUserPanel(p: AdminUserPanel): void;
  };
  /** Render a full page inside the site shell. */
  render(c: C, title: string, body: Child, opts?: { crumbs?: { label: string; href?: string }[]; noPane?: boolean; status?: number }): Promise<Response>;
  /** Render inside the admin shell (navigation + permission check). */
  renderAdmin(c: C, title: string, permission: string, body: Child): Promise<Response>;
  /** Full permission key for one of this module's permissions (`<id>.<key>`). */
  perm(key: string): string;
  /** Publish an API object other modules can use (they must list this module in their (optional) dependencies). */
  expose(api: object): void;
  /**
   * Another module's exposed API, or null when it isn't installed, isn't enabled, exposes nothing, or isn't declared
   * in this module's `dependencies` / `optionalDependencies` (undeclared access is refused).
   */
  use<T = any>(moduleId: string): T | null;
}
