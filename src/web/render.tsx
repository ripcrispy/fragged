import type { Child } from 'hono/jsx';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import type { C, PageCtx } from './ctx.ts';
import { Layout, type LayoutProps, type PaneData } from './layout.tsx';
import { loadPermissionData } from '../services/permissions.ts';
import { friendIds } from '../services/relationships.ts';
import { userCards } from '../services/users.ts';
import { onlineUserIds } from '../services/events.ts';
import { unreadByUser } from '../services/messages.ts';
import { getSetting } from '../services/settings.ts';
import { rowsOf } from '../services/notifications.ts';

export async function groupCss(): Promise<string> {
  const { groups } = await loadPermissionData();
  return groups.filter((g) => g.color && /^#[0-9a-f]{6}$/i.test(g.color)).map((g) => `.gc-${g.id}{--uc:${g.color}}`).join('');
}

export async function paneData(ctx: PageCtx): Promise<PaneData> {
  const u = ctx.viewer.user;
  const db = getDb();
  let friends: PaneData['friends'] = [];
  let requests = 0;
  if (u) {
    const ids = await friendIds(u.id);
    const cards = await userCards(ids);
    const unread = await unreadByUser(u.id);
    const order = { online: 0, away: 1, offline: 2 } as Record<string, number>;
    friends = ids.map((id) => ({ card: cards.get(id)!, unread: unread.get(id) ?? 0 })).filter((f) => f.card && !f.card.closed)
      .sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || (order[a.card.presence ?? 'offline'] - order[b.card.presence ?? 'offline']) || a.card.username.localeCompare(b.card.username));
    requests = ctx.counts.friendRequests;
  }
  let online = { count: 0, members: [] as PaneData['online']['members'] };
  if (ctx.site.show_online_list && ctx.site.presence_enabled) {
    const ids = onlineUserIds();
    if (ids.length) {
      const visible = await db.select({ id: schema.userSettings.userId }).from(schema.userSettings).where(and(inArray(schema.userSettings.userId, ids.slice(0, 500)), eq(schema.userSettings.showPresence, true)));
      const cards = await userCards(visible.map((r) => r.id));
      online = { count: ids.length, members: [...cards.values()].sort((a, b) => a.username.localeCompare(b.username)) };
    }
  }
  return { friends, requests, online };
}

/** Render a full page in the shared shell. */
export async function page(c: C, title: string, body: Child, opts: Omit<LayoutProps, 'ctx' | 'title'> & { status?: number; withPane?: boolean } = {}) {
  const ctx = c.get('page');
  const { navItems } = await import('./extensions.tsx');
  ctx.nav = { main: await navItems(ctx.viewer, 'main'), footer: await navItems(ctx.viewer, 'footer'), userMenu: await navItems(ctx.viewer, 'user-menu') };
  const pane = opts.noPane ? null : (opts.pane ?? (opts.withPane === false ? null : await paneData(ctx)));
  const css = await groupCss();
  const html = await (<Layout ctx={ctx} title={title} {...opts} pane={pane} groupCss={css}>{body}</Layout>);
  return c.html(html as any, (opts.status ?? 200) as any);
}

export async function headerCounts(userId: number, canMod: boolean) {
  const db = getDb();
  const r = rowsOf(await db.execute(sql`select
    (select count(*) from notifications where user_id = ${userId} and read_at is null)::int as notifications,
    (select count(*) from friend_requests where to_user_id = ${userId} and status = 'pending')::int as requests,
    (select count(*) from direct_messages m join conversation_participants p on p.conversation_id = m.conversation_id and p.user_id = ${userId} where m.sender_id <> ${userId} and m.id > p.last_read_message_id)::int as messages`))[0];
  let modQueue = 0;
  if (canMod) {
    const q = rowsOf(await db.execute(sql`select
      (select count(*) from reports where status = 'open')::int +
      (select count(*) from community_emoji where status = 'pending')::int +
      (select count(*) from posts where state = 'held' and not is_deleted)::int +
      (select count(*) from restricted_term_matches where review_status = 'pending')::int as n`))[0];
    modQueue = Number(q?.n ?? 0);
  }
  return { notifications: Number(r.notifications), messages: Number(r.messages), friendRequests: Number(r.requests), modQueue };
}

export const _x = { isNull, getSetting };
