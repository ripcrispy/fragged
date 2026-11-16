/**
 * Serves stored images with strict headers and per-purpose access control:
 *  - avatar / cover / approved emoji: public
 *  - post images: uploader, or anyone who can view the forum of a post they're attached to
 *  - message images: only the two conversation participants (and the uploader)
 */
import { Hono } from 'hono';
import { and, eq, or } from 'drizzle-orm';
import type { Env } from '../web/ctx.ts';
import { getDb, schema } from '../db/client.ts';
import { getUpload, storage } from '../services/uploads.ts';
import { can, viewableForumIds } from '../services/permissions.ts';

export const mediaRoutes = new Hono<Env>();

mediaRoutes.get('/media/:pid', async (c) => {
  const v = c.get('viewer');
  const up = await getUpload(c.req.param('pid'));
  const notFound = () => c.text('Not found', 404);
  if (!up) return notFound();
  const db = getDb();
  let allowed = false;
  let isPublic = false;
  if (up.purpose === 'avatar' || up.purpose === 'cover') { allowed = true; isPublic = true; }
  else if (up.purpose === 'emoji') {
    const [e] = await db.select({ s: schema.communityEmoji.status }).from(schema.communityEmoji).where(eq(schema.communityEmoji.uploadId, up.id));
    allowed = e?.s === 'approved' || up.userId === v.user?.id || (await v.can('mod.emoji'));
    isPublic = e?.s === 'approved';
  } else if (up.purpose === 'post') {
    if (v.user && up.userId === v.user.id) allowed = true;
    else {
      const rows = await db.select({ forumId: schema.threads.forumId, del: schema.posts.isDeleted, state: schema.posts.state, threadDel: schema.threads.isDeleted, threadState: schema.threads.state })
        .from(schema.postAttachments)
        .innerJoin(schema.posts, eq(schema.posts.id, schema.postAttachments.postId)).innerJoin(schema.threads, eq(schema.threads.id, schema.posts.threadId))
        .where(eq(schema.postAttachments.uploadId, up.id));
      const visibleForums = new Set(await viewableForumIds(v.subject));
      for (const r of rows) {
        if (!visibleForums.has(r.forumId)) continue;
        const live = !r.del && r.state === 'visible' && !r.threadDel && r.threadState === 'visible';
        // deleted or held posts' images are only for moderators (and the uploader, above)
        if (live || (await can(v.subject, 'mod.posts', r.forumId))) { allowed = true; break; }
      }
    }
  } else if (up.purpose === 'message') {
    if (v.user) {
      if (up.userId === v.user.id) allowed = true;
      else {
        const rows = await db.select({ lo: schema.conversations.userLowId, hi: schema.conversations.userHighId, hidden: schema.directMessages.hiddenAt }).from(schema.messageAttachments)
          .innerJoin(schema.directMessages, eq(schema.directMessages.id, schema.messageAttachments.messageId))
          .innerJoin(schema.conversations, eq(schema.conversations.id, schema.directMessages.conversationId))
          .where(and(eq(schema.messageAttachments.uploadId, up.id), or(eq(schema.conversations.userLowId, v.user.id), eq(schema.conversations.userHighId, v.user.id))));
        allowed = rows.some((r) => !r.hidden);
      }
    }
  }
  if (!allowed) return notFound();
  let data: Buffer;
  try { data = await storage.get(up.storageKey); } catch { return notFound(); }
  c.header('Content-Type', up.mime);
  c.header('Content-Length', String(data.length));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  c.header('Content-Disposition', 'inline');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cache-Control', isPublic ? 'public, max-age=604800, immutable' : 'private, max-age=3600');
  c.header('ETag', `"${up.sha256.slice(0, 16)}-${up.id}"`);
  return c.body(new Uint8Array(data));
});
