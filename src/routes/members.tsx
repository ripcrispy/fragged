import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { form, str, int, bool, setFlash } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, Pagination, UserLink, Avatar, Time, Notice, ActionButton, Html, EmptyState, Presence, Select } from '../web/components.tsx';
import { rendererFor } from '../web/content.ts';
import { getDb, schema } from '../db/client.ts';
import { getUserByUsername, userCards, ServiceError, getProfile, type UserCard } from '../services/users.ts';
import * as R from '../services/relationships.ts';
import * as P from '../services/profiles.ts';
import { getUpload } from '../services/uploads.ts';
import { profilePalette } from '../lib/color.ts';
import { numberFmt, fmtMonthYear } from '../lib/time.ts';
import { loadPermissionData } from '../services/permissions.ts';
import { canMessage } from '../services/messages.ts';
import { profileSections, between } from '../web/extensions.tsx';

export const memberRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';
const profileUrl = (u: string) => `/u/${encodeURIComponent(u)}`;

// ─────────────── member directory ───────────────

memberRoutes.get('/members', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  await v.require('member.view');
  const q = c.req.query('q') ?? '';
  if (q) {
    const { rateLimit } = await import('../services/forums.ts');
    await rateLimit(v, 'member_search');
  }
  const sort = (['username', 'joined', 'posts'].includes(c.req.query('sort') ?? '') ? c.req.query('sort') : 'username') as 'username' | 'joined' | 'posts';
  const group = c.req.query('group') || null;
  const res = await P.searchMembers(v, { q, page: int(c.req.query('page'), 1), sort, group });
  const { groups } = await loadPermissionData();
  const href = (p: number) => `/members?${new URLSearchParams({ ...(q ? { q } : {}), sort, ...(group ? { group } : {}), page: String(p) })}`;
  return page(c, 'Members', (
    <>
      <h1 class="page-title">Members</h1>
      <form class="filter-bar" method="get" action="/members" role="search">
        <label for="m-q">Find a member</label>
        <input id="m-q" name="q" value={q} maxlength={32} placeholder="Username" autocomplete="off" data-member-autocomplete list="member-suggest" />
        <datalist id="member-suggest" />
        <Select label="Sort by" name="sort" value={sort} options={[['username', 'Username'], ['joined', 'Newest'], ['posts', 'Most posts']]} />
        <Select label="Group" name="group" value={group ?? ''} options={[['', 'All groups'], ...groups.filter((g) => g.slug !== 'guest').map((g) => [g.slug, g.name] as [string, string])]} />
        <button class="btn">Search</button>
      </form>
      <p class="muted">{numberFmt(res.total)} member{res.total === 1 ? '' : 's'}{q ? ` matching “${q}”` : ''}. Members who opt out of the directory only appear on an exact username search.</p>
      <Pagination page={res.page} pages={res.pages} href={href} />
      <div class="table-wrap"><table class="data-table member-table">
        <thead><tr><th scope="col">Member</th><th scope="col">Group</th><th scope="col">Joined</th><th scope="col" class="col-num">Posts</th></tr></thead>
        <tbody>
          {res.members.map((m) => (
            <tr><td class="member-cell"><Avatar user={m} size={32} /><UserLink user={m} /> <Presence p={m.presence} />{m.title ? <span class="muted"> — {m.title}</span> : null}</td>
              <td>{m.groupName}</td><td><Time d={m.joinedAt} tz={tz(ctx)} mode="date" /></td><td class="col-num">{numberFmt(m.postCount)}</td></tr>
          ))}
          {!res.members.length ? <tr><td colspan={4}><EmptyState title="No members found." /></td></tr> : null}
        </tbody>
      </table></div>
      <Pagination page={res.page} pages={res.pages} href={href} />
    </>
  ), { crumbs: [{ label: 'Members' }] });
});

// ─────────────── profile ───────────────

async function loadMember(c: C) {
  const user = await getUserByUsername(c.req.param('username') ?? '');
  if (!user || user.closedAt) throw new ServiceError('Member not found.', 404);
  return user;
}

memberRoutes.get('/u/:username', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const user = await loadMember(c);
  if (user.username !== c.req.param('username')) return c.redirect(profileUrl(user.username), 301);
  const card = (await userCards([user.id])).get(user.id)!;
  const access = await P.profileAccess(v, user);
  const profile = await getProfile(user.id);
  const rel = v.user ? await R.relationState(v.user.id, user.id) : 'none';
  const muted = v.user ? await R.hasMuted(v.user.id, user.id) : false;
  const cover = profile.coverUploadId ? (await getDb().select({ pid: schema.uploads.publicId }).from(schema.uploads).where(eq(schema.uploads.id, profile.coverUploadId)))[0]?.pid : null;
  const Rd = await rendererFor(v);
  // safe, validated colour → derived palette in a nonce'd style block scoped to the profile
  if (profile.backgroundColor) {
    const pal = profilePalette(profile.backgroundColor);
    ctx.pageStyle = `.profile-page.custom-bg{--pf-bg:${pal.bg};--pf-text:${pal.text};--pf-panel:${pal.panel};--pf-muted:${pal.muted};--pf-border:${pal.border};--pf-link:${pal.link}}`;
  }
  const isSelf = v.user?.id === user.id;
  const header = (
    <div class="profile-header">
      <div class="profile-cover" data-cover-pos={profile.coverPositionY}>{cover ? <img src={`/media/${cover}`} alt="" class={`cover-img cover-y-${Math.round(profile.coverPositionY / 10) * 10}`} /> : <div class="cover-default" />}</div>
      <div class="profile-ident">
        <Avatar user={card} size={128} link={false} />
        <div class="profile-names">
          <h1 class="profile-username"><UserLink user={card} /></h1>
          {card.title ? <div class="profile-title">{card.title}</div> : null}
          <div class="profile-sub"><Presence p={card.presence} /> {card.presence ? <span class="muted">{card.presence === 'online' ? 'Online' : card.presence === 'away' ? 'Away' : 'Offline'}</span> : null}
            {profile.pronouns ? <span class="profile-pronouns">{profile.pronouns}</span> : null}
            <span class="muted">Joined {fmtMonthYear(user.createdAt, tz(ctx))}</span></div>
        </div>
        {v.user && !isSelf ? <ProfileActions ctx={ctx} username={user.username} userId={user.id} rel={rel} muted={muted} /> : isSelf ? <div class="profile-actions"><a class="btn" href="/settings">Edit profile</a></div> : null}
      </div>
    </div>
  );
  if (!access.visible) {
    return page(c, user.username, <div class="profile-page">{header}<Notice type="info">{access.reason}</Notice></div>, { crumbs: [{ label: 'Members', href: '/members' }, { label: user.username }] });
  }
  const [topIds, activity, comments, canC] = await Promise.all([
    R.getTopFriends(user.id),
    profile.showRecentActivity || isSelf ? P.recentActivity(v, user.id, 8) : Promise.resolve([]),
    P.listComments(v, user.id, int(c.req.query('cpage'), 1)),
    P.canComment(v, user.id),
  ]);
  const blockedTop = v.user ? await R.blockedSetFor(v.user.id, topIds) : new Set<number>();
  const topCards = await userCards([...topIds, ...comments.comments.map((x) => x.authorId)]);
  const friendCount = await R.friendCount(user.id);
  const sectionArgs = { viewer: v, user, isSelf, ctx };
  const [sideExtra, mainExtra] = await Promise.all([profileSections(sectionArgs, 'side'), profileSections(sectionArgs, 'main')]);
  return page(c, user.username, (
    <div class={`profile-page ${profile.backgroundColor ? 'custom-bg' : ''}`}>
      {header}
      <div class="profile-grid">
        <div class="profile-side">
          <Box title="Statistics" headingLevel={3}>
            <dl class="kv">
              <dt>Posts</dt><dd>{numberFmt(user.postCount)}</dd>
              <dt>Threads</dt><dd>{numberFmt(user.threadCount)}</dd>
              <dt>Reactions received</dt><dd>{numberFmt(user.reactionsReceived)}</dd>
              <dt>Friends</dt><dd>{numberFmt(friendCount)}</dd>
              <dt>Group</dt><dd>{card.groupName}</dd>
              {profile.location ? <><dt>Location</dt><dd>{profile.location}</dd></> : null}
              <dt>Joined</dt><dd><Time d={user.createdAt} tz={tz(ctx)} mode="date" /></dd>
            </dl>
          </Box>
          {profile.links.length ? <Box title="Links" headingLevel={3}><ul class="plain-list">{profile.links.map((l) => <li><a href={l.url} rel="nofollow noopener noreferrer ugc me" target="_blank">{l.label}</a> <span class="muted">({new URL(l.url).hostname})</span></li>)}</ul></Box> : null}
          {between(sideExtra, 0, 50)}
          {profile.topFriendsCount > 0 && topIds.length ? <Box title="Top Friends" headingLevel={3}>
            <ol class="top-friends">{topIds.filter((id) => !blockedTop.has(id)).map((id) => { const f = topCards.get(id); return f ? <li><Avatar user={f} size={56} /><UserLink user={f} /></li> : null; })}</ol>
          </Box> : null}
          {between(sideExtra, 50, Infinity)}
        </div>
        <div class="profile-main">
          <Box title={`About ${user.username}`} headingLevel={3}>
            {profile.bio ? <div class="bb profile-bio"><Html html={Rd.post(profile.bio, { embeds: false })} /></div> : <p class="muted">{isSelf ? <>You haven't written a bio yet. <a href="/settings">Add one</a>.</> : 'No bio yet.'}</p>}
          </Box>
          {between(mainExtra, 0, 60)}
          {activity.length ? <Box title="Recent posts" headingLevel={3}>
            <ul class="activity-list">{activity.map((a) => <li><a href={`/p/${a.postId}`}>{a.title}</a> <span class="muted">#{a.position} · <Time d={a.createdAt} tz={tz(ctx)} mode="ago" /></span></li>)}</ul>
            <p><a href={`/search?type=posts&author=${encodeURIComponent(user.username)}`}>Find all posts by {user.username}</a></p>
          </Box> : null}
          {between(mainExtra, 60, 80)}
          <Box title={`Profile comments (${comments.total})`} headingLevel={3} id="comments">
            {canC.ok ? (
              <form method="post" action={`${profileUrl(user.username)}/comments`} class="comment-form"><Csrf ctx={ctx} />
                <label for="pc-body" class="sr-only">Leave a comment</label>
                <textarea id="pc-body" name="body" rows={3} maxlength={1000} required placeholder={isSelf ? 'Post an update on your own profile…' : `Leave a comment for ${user.username}…`} />
                <button class="btn btn-primary btn-small">Post comment</button>
              </form>
            ) : <p class="muted">{canC.reason}</p>}
            {comments.comments.length ? <ol class="comments">{comments.comments.map((cm) => {
              const a = topCards.get(cm.authorId);
              return (
                <li class={`comment ${cm.state === 'held' ? 'is-held' : ''}`} id={`comment-${cm.id}`}>
                  <Avatar user={a} size={40} />
                  <div class="comment-body">
                    <div class="comment-head"><UserLink user={a} /> <span class="muted"><Time d={cm.createdAt} tz={tz(ctx)} mode="ago" /></span>{cm.state === 'held' ? <span class="tag tag-held">Awaiting approval</span> : null}</div>
                    <div class="bb"><Html html={Rd.post(cm.body, { embeds: false, images: false })} /></div>
                    <div class="comment-actions">
                      {comments.canModerate || v.user?.id === cm.authorId ? <ActionButton ctx={ctx} action={`/comments/${cm.id}/delete`} label="Remove" className="link-btn" confirm="Remove this comment?" /> : null}
                      {v.user && v.user.id !== cm.authorId ? <a class="link-btn" href={`/report?type=profile_comment&id=${cm.id}`}>Report</a> : null}
                    </div>
                  </div>
                </li>
              );
            })}</ol> : <p class="muted">No comments yet.</p>}
            <Pagination page={comments.page} pages={comments.pages} href={(p) => `${profileUrl(user.username)}?cpage=${p}#comments`} />
          </Box>
          {between(mainExtra, 80, Infinity)}
        </div>
      </div>
    </div>
  ), { crumbs: [{ label: 'Members', href: '/members' }, { label: user.username }] });
});

function ProfileActions({ ctx, username, userId, rel, muted }: { ctx: PageCtx; username: string; userId: number; rel: R.RelationState; muted: boolean }) {
  const base = profileUrl(username);
  return (
    <div class="profile-actions">
      {rel === 'none' ? <ActionButton ctx={ctx} action={`${base}/friend`} label="Add friend" className="btn btn-primary" /> : null}
      {rel === 'request_sent' ? <ActionButton ctx={ctx} action={`${base}/friend/cancel`} label="Cancel friend request" className="btn" /> : null}
      {rel === 'request_received' ? <><ActionButton ctx={ctx} action={`${base}/friend`} label="Accept friend request" className="btn btn-primary" /><ActionButton ctx={ctx} action={`${base}/friend/decline`} label="Decline" className="btn" /></> : null}
      {rel === 'friends' ? <ActionButton ctx={ctx} action={`${base}/unfriend`} label="Remove friend" className="btn" confirm={`Remove ${username} from your friends? Your message history is kept.`} /> : null}
      {rel !== 'blocked' && rel !== 'blocked_by' ? <button type="button" class="btn" data-open-dm={userId} data-dm-name={username}>Message</button> : null}
      <details class="menu"><summary class="btn btn-ghost" aria-label="More actions">⋯</summary>
        <ul class="menu-panel">
          <li>{muted ? <ActionButton ctx={ctx} action={`${base}/unmute`} label="Unmute" className="link-btn" /> : <ActionButton ctx={ctx} action={`${base}/mute`} label="Mute notifications" className="link-btn" title="You won't get notifications from this member. They can still message you." />}</li>
          <li>{rel === 'blocked' ? <ActionButton ctx={ctx} action={`${base}/unblock`} label="Unblock" className="link-btn" /> : <ActionButton ctx={ctx} action={`${base}/block`} label="Block" className="link-btn danger" confirm={`Block ${username}? They won't be able to message you, send friend requests or comment on your profile. Any friendship is removed. Message history is kept.`} />}</li>
          <li><a href={`/report?type=user&id=${userId}`}>Report member</a></li>
          {ctx.canMod ? <li><a href={`/mod/users/${userId}`}>Moderate</a></li> : null}
        </ul>
      </details>
      {rel === 'blocked' ? <p class="muted small">You have blocked this member.</p> : null}
    </div>
  );
}

// ─────────────── relationship actions ───────────────

const back = (c: C, username: string) => c.redirect(c.req.header('referer')?.includes('/friends') ? '/friends' : profileUrl(username));

async function actor(c: C) {
  const v = c.get('viewer');
  if (!v.user) throw new ServiceError('You need to be signed in to do that.', 401, 'login_required');
  if (v.ban) throw new ServiceError('Your account is restricted.', 403, 'banned');
  return v;
}

memberRoutes.post('/u/:username/friend', async (c) => {
  const v = await actor(c);
  const u = await loadMember(c);
  const { rateLimit } = await import('../services/forums.ts');
  await rateLimit(v, 'friend_request');
  const r = await R.sendFriendRequest(v.user!.id, u.id);
  setFlash(c, { type: 'ok', text: r === 'accepted' ? `You and ${u.username} are now friends.` : `Friend request sent to ${u.username}.` });
  return back(c, u.username);
});
memberRoutes.post('/u/:username/friend/cancel', async (c) => {
  const v = await actor(c); const u = await loadMember(c);
  const { outgoing } = await R.listFriendRequests(v.user!.id);
  const req = outgoing.find((r) => r.toUserId === u.id);
  if (req) await R.cancelRequest(v.user!.id, req.id);
  setFlash(c, { type: 'ok', text: 'Friend request cancelled.' });
  return back(c, u.username);
});
memberRoutes.post('/u/:username/friend/decline', async (c) => {
  const v = await actor(c); const u = await loadMember(c);
  const { incoming } = await R.listFriendRequests(v.user!.id);
  const req = incoming.find((r) => r.fromUserId === u.id);
  if (req) await R.respondToRequest(v.user!.id, req.id, 'decline');
  setFlash(c, { type: 'ok', text: 'Friend request declined.' });
  return back(c, u.username);
});
memberRoutes.post('/friend-requests/:id/:action', async (c) => {
  const v = await actor(c);
  const id = int(c.req.param('id'));
  const action = c.req.param('action');
  if (action === 'accept' || action === 'decline') await R.respondToRequest(v.user!.id, id, action);
  else if (action === 'cancel') await R.cancelRequest(v.user!.id, id);
  else throw new ServiceError('Unknown action.');
  if ((c.req.header('accept') ?? '').includes('json')) return c.json({ ok: true });
  setFlash(c, { type: 'ok', text: action === 'accept' ? 'Friend request accepted.' : action === 'decline' ? 'Friend request declined.' : 'Friend request cancelled.' });
  return c.redirect('/friends');
});
memberRoutes.post('/u/:username/unfriend', async (c) => { const v = await actor(c); const u = await loadMember(c); await R.removeFriend(v.user!.id, u.id); setFlash(c, { type: 'ok', text: `${u.username} was removed from your friends.` }); return back(c, u.username); });
memberRoutes.post('/u/:username/block', async (c) => { const v = c.get('viewer'); if (!v.user) return c.redirect('/login'); const u = await loadMember(c); await R.block(v.user.id, u.id); setFlash(c, { type: 'ok', text: `You blocked ${u.username}.` }); return back(c, u.username); });
memberRoutes.post('/u/:username/unblock', async (c) => { const v = c.get('viewer'); if (!v.user) return c.redirect('/login'); const u = await loadMember(c); await R.unblock(v.user.id, u.id); setFlash(c, { type: 'ok', text: `You unblocked ${u.username}.` }); return c.redirect(c.req.header('referer')?.includes('/settings') ? '/settings/blocked' : profileUrl(u.username)); });
memberRoutes.post('/u/:username/mute', async (c) => { const v = c.get('viewer'); if (!v.user) return c.redirect('/login'); const u = await loadMember(c); const b = await form(c); await R.mute(v.user.id, u.id, bool(b.hideContent)); setFlash(c, { type: 'ok', text: `You muted ${u.username}. You won't receive notifications from them.` }); return back(c, u.username); });
memberRoutes.post('/u/:username/unmute', async (c) => { const v = c.get('viewer'); if (!v.user) return c.redirect('/login'); const u = await loadMember(c); await R.unmute(v.user.id, u.id); setFlash(c, { type: 'ok', text: `You unmuted ${u.username}.` }); return c.redirect(c.req.header('referer')?.includes('/settings') ? '/settings/blocked' : profileUrl(u.username)); });

memberRoutes.post('/u/:username/comments', async (c) => {
  const v = await actor(c);
  const u = await loadMember(c);
  const b = await form(c);
  try {
    const cm = await P.addComment(v, u.id, str(b.body));
    if (cm.state === 'held') setFlash(c, { type: 'info', text: 'Your comment is awaiting moderator approval.' });
  } catch (e) { if (e instanceof ServiceError && e.status < 500) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect(`${profileUrl(u.username)}#comments`);
});
memberRoutes.post('/comments/:id/delete', async (c) => {
  const v = c.get('viewer');
  if (!v.user) return c.redirect('/login');
  await P.removeComment(v, int(c.req.param('id')));
  setFlash(c, { type: 'ok', text: 'Comment removed.' });
  const ref = c.req.header('referer');
  return c.redirect(ref && ref.includes('/u/') ? new URL(ref).pathname + '#comments' : '/');
});

// ─────────────── friends management ───────────────

memberRoutes.get('/friends', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  if (!v.user) return c.redirect('/login?returnTo=/friends');
  const { incoming, outgoing } = await R.listFriendRequests(v.user.id);
  const ids = await R.friendIds(v.user.id);
  const cards = await userCards([...ids, ...incoming.map((r) => r.fromUserId), ...outgoing.map((r) => r.toUserId)]);
  const friends = ids.map((id) => cards.get(id)!).filter(Boolean).sort((a, b) => a.username.localeCompare(b.username));
  return page(c, 'Friends', (
    <>
      <h1 class="page-title">Friends</h1>
      <Box title={`Incoming requests (${incoming.length})`}>
        {incoming.length ? <ul class="request-list">{incoming.map((r) => { const u = cards.get(r.fromUserId); return (
          <li><Avatar user={u} size={32} /><UserLink user={u} /> <span class="muted"><Time d={r.createdAt} tz={tz(ctx)} mode="ago" /></span>
            <ActionButton ctx={ctx} action={`/friend-requests/${r.id}/accept`} label="Accept" className="btn btn-primary btn-small" />
            <ActionButton ctx={ctx} action={`/friend-requests/${r.id}/decline`} label="Decline" className="btn btn-small" /></li>); })}</ul> : <p class="muted">No pending requests.</p>}
      </Box>
      <Box title={`Outgoing requests (${outgoing.length})`}>
        {outgoing.length ? <ul class="request-list">{outgoing.map((r) => { const u = cards.get(r.toUserId); return (
          <li><Avatar user={u} size={32} /><UserLink user={u} /> <span class="muted">sent <Time d={r.createdAt} tz={tz(ctx)} mode="ago" /></span>
            <ActionButton ctx={ctx} action={`/friend-requests/${r.id}/cancel`} label="Cancel" className="btn btn-small" /></li>); })}</ul> : <p class="muted">No outgoing requests.</p>}
      </Box>
      <Box title={`Your friends (${friends.length})`} actions={<a href="/settings/top-friends">Choose Top Friends</a>}>
        {friends.length ? <table class="data-table"><tbody>{friends.map((f) => (
          <tr><td class="member-cell"><Avatar user={f} size={32} /><UserLink user={f} /> <Presence p={f.presence} /></td>
            <td class="row-actions"><button type="button" class="btn btn-small" data-open-dm={f.id} data-dm-name={f.username}>Message</button>
              <ActionButton ctx={ctx} action={`${profileUrl(f.username)}/unfriend`} label="Remove" className="btn btn-small btn-ghost" confirm={`Remove ${f.username} from your friends?`} /></td></tr>))}</tbody></table>
          : <EmptyState title="No friends yet.">Find people in the <a href="/members">member list</a> and choose <em>Add friend</em> on their profile.</EmptyState>}
      </Box>
    </>
  ), { crumbs: [{ label: 'Friends' }] });
});

export const _x = { inArray, getUpload, canMessage };
export type { UserCard };
