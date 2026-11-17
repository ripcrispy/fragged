/**
 * Fragged Forums module SDK.
 *
 * Modules import ONLY from this entry point (enforced by tests/modules-boundary.test.ts). Anything exported here is
 * covered by SDK_VERSION semver; everything else in src/ is internal and may change without notice.
 *
 *   import { defineModule, z, Box } from '../../src/sdk/index.ts';      // first-party module in ./modules
 *   import { defineModule } from 'fragged-forums/sdk';                    // published third-party module
 */
import type { ModuleDefinition } from './types.ts';

export * from './types.ts';
export { SDK_VERSION } from './version.ts';
export { z } from 'zod';
/** Drizzle ORM (same version as core): table builders and query operators for module-owned tables. */
export * as pg from 'drizzle-orm/pg-core';
export { sql, eq, ne, and, or, not, desc, asc, inArray, isNull, isNotNull, gt, gte, lt, lte } from 'drizzle-orm';

/** Identity helper that gives module definitions full type checking. */
export function defineModule(def: ModuleDefinition): ModuleDefinition { return def; }

// ── errors & request helpers ──
export { ServiceError } from '../services/users.ts';
export { form, str, int, bool, arr, setFlash } from '../web/ctx.ts';

// ── UI building blocks (server-rendered JSX; theme-token styled) ──
export { Box, Field, TextArea, Checkbox, Select, Notice, ActionButton, Csrf, UserLink, Avatar, Time, Html, EmptyState, Pagination, Stat, TagPill } from '../web/components.tsx';
export { escapeHtml, render as renderBBCode, excerpt, mediaEmbedHtml, linkCardHtml } from '../lib/bbcode.ts';
export { safeUrl, resolveMedia } from '../lib/media.ts';
export { cleanLine, cleanText, slugify, parseHexColor } from '../lib/validate.ts';
export { fmtDate, fmtDateTime, timeAgo, numberFmt, parseLocalDateTime, toLocalInput } from '../lib/time.ts';

// ── stable services facade ──
import { getUserById, getUserByUsername, userCards } from '../services/users.ts';
import { notify } from '../services/notifications.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { publish } from '../services/events.ts';
import { getDb, schema } from '../db/client.ts';
import { hit as rateLimitHit } from '../lib/ratelimit.ts';
import { forumById, createThread as coreCreateThread, setThreadFlags, forumsForMoveSelect, loadThreadFor } from '../services/forums.ts';
import { ServiceError as CoreServiceError } from '../services/users.ts';
import type { Viewer } from '../services/viewer.ts';

/**
 * Forum actions for modules (SDK 1.1). They always act AS the given viewer and run every core check (permissions,
 * posting policy, rate limits, restricted terms), so a module can't post where the member couldn't.
 */
const forums = {
  /** Forums the viewer can see and start threads in, in forum-index order. */
  async postable(viewer: Viewer): Promise<{ id: number; name: string }[]> {
    const out: { id: number; name: string }[] = [];
    for (const f of await forumsForMoveSelect(viewer)) if (await viewer.can('thread.create', f.id)) out.push(f);
    return out;
  },
  /** Start a thread as the viewer. Throws ServiceError with a user-facing message when not allowed. */
  async createThread(viewer: Viewer, forumId: number, input: { title: string; body: string }): Promise<{ threadId: number; url: string; held: boolean }> {
    const forum = await forumById(forumId);
    if (!forum) throw new CoreServiceError('Forum not found.', 404);
    const { thread } = await coreCreateThread(viewer, forum, { title: input.title, body: input.body });
    return { threadId: thread.id, url: `/t/${thread.id}-${thread.slug}`, held: thread.state === 'held' };
  },
  /**
   * SDK 1.3: a thread the viewer is allowed to see, or null (missing, deleted for them, or in a forum they can't
   * read). Use it before acting on a thread id that came from a request.
   */
  async thread(viewer: Viewer, threadId: number): Promise<{ id: number; forumId: number; userId: number; title: string; url: string; isLocked: boolean } | null> {
    try {
      const { thread } = await loadThreadFor(viewer, threadId);
      return { id: thread.id, forumId: thread.forumId, userId: thread.userId, title: thread.title, url: `/t/${thread.id}-${thread.slug}`, isLocked: thread.isLocked };
    } catch (e) {
      if (e instanceof CoreServiceError && e.status >= 400 && e.status < 500) return null;
      throw e;
    }
  },
  /** Make a thread sticky (or not). Needs the viewer's thread-moderation permission in that forum. */
  setSticky: (viewer: Viewer, threadId: number, sticky: boolean) => setThreadFlags(viewer, threadId, { isSticky: sticky }),
};

export const services = {
  users: { getById: getUserById, getByUsername: getUserByUsername, cards: userCards },
  /** In-app notification (respects member preferences, mutes and blocks). `kind` must be a core kind or one your module declares. */
  notify: (userId: number, kind: string, actorId: number | null, text: string, url: string) => notify(userId, kind as any, actorId, text, url),
  /** Record a privileged action in the audit log. Use `<moduleId>.<action>` names. */
  audit,
  /** Read a core site setting (e.g. 'site_name'). */
  coreSetting: getSetting,
  /** Push a real-time event to a member's open browser tabs (shared across instances). */
  push: publish,
  /** Count an attempt against a limit; returns { ok, retryAfter }. Shared across instances on PostgreSQL. */
  rateLimit: rateLimitHit,
  /** SDK 1.1: start threads and make them sticky, as the viewer. */
  forums,
};

/**
 * SDK 1.4: store an image a member uploaded through a module form (e.g. a tournament banner). The image is
 * re-encoded server-side (WebP, size-capped, metadata stripped) exactly like post images; `cover` gives a wide
 * 1600×500 crop and `post` keeps the shape. Check your own permission first; this only enforces the size cap.
 */
import { saveUpload, fileToBuffer } from '../services/uploads.ts';
export const media = {
  async upload(viewer: Viewer, file: unknown, purpose: 'cover' | 'post' = 'post'): Promise<{ publicId: string; url: string } | null> {
    if (!viewer.user) throw new CoreServiceError('Sign in to upload images.', 401);
    const f = await fileToBuffer(file, 10_000_000);
    if (!f) return null;
    const up = await saveUpload(viewer.user.id, purpose, f.buf, f.name);
    return { publicId: up.publicId, url: `/media/${up.publicId}` };
  },
};

/** OAuth/OIDC helpers for auth-provider modules (core owns state, PKCE, nonce and account linking). */
import { verifyIdToken, fetchProfile, createRemoteJWKSet } from '../services/oauth.ts';
export const oidc = { verifyIdToken, fetchProfile, createRemoteJWKSet };

/** Cryptographic helpers keyed by the site's APP_SECRET. */
import { hmac, sha256, safeEqual, randomToken } from '../lib/crypto.ts';
export const crypto = { hmac, sha256, safeEqual, randomToken };

/** Database access: `db()` returns the Drizzle handle; `coreTables` are read-only by convention outside core. */
export const database = { db: getDb, coreTables: schema };
