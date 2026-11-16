import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Child } from 'hono/jsx';
import type { Env, C, PageCtx } from '../web/ctx.ts';
import { COOKIE, form, str, int, bool, arr, setFlash, secureCookies } from '../web/ctx.ts';
import { page } from '../web/render.tsx';
import { Box, Csrf, Field, TextArea, Checkbox, Select, Notice, ActionButton, Time, UserLink, Avatar } from '../web/components.tsx';
import { ProviderButtons } from './auth.tsx';
import { profileSettingsFields, saveProfileSettings } from '../web/extensions.tsx';
import { emit } from '../modules/registry.ts';
import { themes, isTheme } from '../web/themes.ts';
import { themeStylesheet } from '../modules/runtime.ts';
import { getDb, schema } from '../db/client.ts';
import { getProfile, userCards, ServiceError } from '../services/users.ts';
import * as P from '../services/profiles.ts';
import * as A from '../services/auth.ts';
import * as O from '../services/oauth.ts';
import * as N from '../services/notifications.ts';
import { friendIds, getTopFriends, setTopFriends, listBlocksAndMutes } from '../services/relationships.ts';
import { saveUpload, fileToBuffer } from '../services/uploads.ts';
import { getSetting } from '../services/settings.ts';
import { PROFILE_COLOR_PRESETS, profilePalette } from '../lib/color.ts';
import { isValidTimezone } from '../lib/time.ts';
import { securityEvent, audit } from '../services/audit.ts';
import { rateLimit } from '../services/forums.ts';

export const settingsRoutes = new Hono<Env>();
const tz = (ctx: PageCtx) => ctx.viewer.user?.timezone ?? 'UTC';

const TABS: [string, string][] = [
  ['/settings', 'Profile'], ['/settings/images', 'Avatar & cover'], ['/settings/top-friends', 'Top Friends'], ['/settings/preferences', 'Preferences'],
  ['/settings/privacy', 'Privacy'], ['/settings/notifications', 'Notifications'], ['/settings/blocked', 'Blocked & muted'], ['/settings/account', 'Account'], ['/settings/security', 'Security'],
];

async function settingsPage(c: C, title: string, body: Child) {
  const ctx = c.get('page');
  return page(c, `Settings — ${title}`, (
    <div class="settings-layout">
      <nav class="settings-nav box" aria-label="Settings sections"><ul>{TABS.map(([href, label]) => <li><a href={href} aria-current={ctx.path === href ? 'page' : undefined} class={ctx.path === href ? 'active' : ''}>{label}</a></li>)}</ul></nav>
      <div class="settings-main"><h1 class="page-title">{title}</h1>{body}</div>
    </div>
  ), { crumbs: [{ label: 'Settings', href: '/settings' }, { label: title }], noPane: true });
}

function need(c: C) {
  const v = c.get('viewer');
  if (!v.user) throw new ServiceError('You need to be signed in to change settings.', 401, 'login_required');
  return v;
}

async function requireReauth(c: C, back: string): Promise<Response | null> {
  const v = need(c);
  if (await A.isRecentlyAuthenticated(v.session)) return null;
  return c.redirect(`/reauth?returnTo=${encodeURIComponent(back)}`);
}

// ─────────────── profile ───────────────

async function profileForm(c: C, errors: Record<string, string> = {}) {
  const ctx = c.get('page');
  const v = need(c);
  const p = await getProfile(v.user!.id);
  const canTitle = await v.can('user.change_username');
  const links = [...p.links, ...Array(Math.max(0, 5 - p.links.length)).fill({ label: '', url: '' })].slice(0, 5);
  const pal = p.backgroundColor ? profilePalette(p.backgroundColor) : null;
  return settingsPage(c, 'Profile', (
    <form method="post" action="/settings" class="form-grid settings-form"><Csrf ctx={ctx} />
      {Object.keys(errors).length ? <Notice type="error" title="Some fields weren't saved.">{Object.values(errors).map((e) => <div>{e}</div>)}</Notice> : null}
      <TextArea label="About you" name="bio" value={p.bio} rows={6} maxlength={3000} hint="BBCode allowed. Shown on your profile." error={errors.bio} />
      <div class="field-row">
        <Field label="Pronouns (optional)" name="pronouns" value={p.pronouns} maxlength={40} hint="e.g. she/her, they/them — leave blank to not show any." error={errors.pronouns} />
        <Field label="Location (optional)" name="location" value={p.location} maxlength={80} error={errors.location} />
      </div>
      {canTitle ? <Field label="Custom user title" name="customTitle" value={p.customTitle} maxlength={40} hint="Shown under your name in posts. Staff titles are reserved." error={errors.customTitle} /> : null}
      <TextArea label="Signature" name="signature" value={p.signature} rows={3} maxlength={600} hint="Up to 5 lines. Images and embeds are not shown in signatures." error={errors.signature} />
      <fieldset class="field"><legend>Links (up to 5)</legend>
        {links.map((l, i) => <div class="field-row"><input name={`linkLabel${i}`} value={l.label} placeholder="Label" maxlength={40} aria-label={`Link ${i + 1} label`} /><input name={`linkUrl${i}`} value={l.url} placeholder="https://…" maxlength={500} aria-label={`Link ${i + 1} URL`} /></div>)}
        {errors.links ? <div class="field-error">{errors.links}</div> : null}
      </fieldset>
      <fieldset class="field colour-field" data-colour-picker><legend>Profile background colour</legend>
        <p class="field-hint">Applies to your profile page only. Text colour is chosen automatically to stay readable; site navigation and notices are never affected.</p>
        <div class="colour-row">
          <label for="f-bg" class="sr-only">Colour</label>
          <input type="color" id="f-bg" name="backgroundColor" value={p.backgroundColor ?? '#3b4a5c'} data-colour-input />
          <span class="presets" role="group" aria-label="Presets">{PROFILE_COLOR_PRESETS.map((col) => <button type="button" class={`swatch swatch-${col.slice(1)}`} data-colour-preset={col} aria-label={`Use ${col}`} title={col} />)}</span>
          <label class="check-inline"><input type="checkbox" name="useDefaultBg" value="1" checked={!p.backgroundColor} /> Use theme default</label>
        </div>
        <div class="colour-preview" data-colour-preview aria-live="polite">
          <div class="cp-panel"><strong>Preview</strong> — profile text and <a href="#" tabindex={-1}>links</a> stay legible.</div>
        </div>
        {pal ? <p class="field-hint">Current text colour: {pal.text === '#ffffff' ? 'white' : 'dark'}.</p> : null}
        {errors.backgroundColor ? <div class="field-error">{errors.backgroundColor}</div> : null}
      </fieldset>
      {await profileSettingsFields(v, errors)}
      <Checkbox label="Show my recent posts on my profile" name="showRecentActivity" checked={p.showRecentActivity} />
      <div class="form-actions"><button class="btn btn-primary">Save profile</button> <a href={`/u/${encodeURIComponent(v.user!.username)}`}>View profile</a></div>
    </form>
  ));
}

settingsRoutes.get('/settings', (c) => profileForm(c));
settingsRoutes.post('/settings', async (c) => {
  const v = need(c);
  const b = await form(c);
  const links = Array.from({ length: 5 }, (_, i) => ({ label: str(b[`linkLabel${i}`]), url: str(b[`linkUrl${i}`]) }));
  const errors = await P.updateProfile(v, {
    bio: str(b.bio), pronouns: str(b.pronouns), location: str(b.location), customTitle: b.customTitle != null ? str(b.customTitle) : undefined,
    signature: str(b.signature), links,
    backgroundColor: bool(b.useDefaultBg) ? null : str(b.backgroundColor), showRecentActivity: bool(b.showRecentActivity),
  });
  Object.assign(errors, await saveProfileSettings(v, b));
  if (Object.keys(errors).length) return profileForm(c, errors);
  setFlash(c, { type: 'ok', text: 'Profile saved.' });
  return c.redirect('/settings');
});

// ─────────────── avatar & cover ───────────────

settingsRoutes.get('/settings/images', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const card = (await userCards([v.user!.id])).get(v.user!.id)!;
  const p = await getProfile(v.user!.id);
  const cover = p.coverUploadId ? (await getDb().select().from(schema.uploads).where(eq(schema.uploads.id, p.coverUploadId)))[0] : null;
  const lim = await getSetting('upload_limits');
  return settingsPage(c, 'Avatar & cover', (
    <>
      <Box title="Avatar" headingLevel={2}>
        <div class="image-setting"><Avatar user={card} size={128} link={false} />
          <form method="post" action="/settings/images/avatar" enctype="multipart/form-data" class="form-grid"><Csrf ctx={ctx} />
            <div class="field"><label for="f-avatar">Upload a new avatar</label><input id="f-avatar" type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
              <div class="field-hint">PNG, JPEG, WebP or GIF, up to {Math.round(lim.avatar.maxBytes / 1000)} KB. Cropped to a square (256×256); location data and other metadata are removed.</div></div>
            <Select label="Crop focus" name="gravity" value="centre" options={[['centre', 'Centre'], ['north', 'Top'], ['south', 'Bottom'], ['attention', 'Automatic (most detailed area)']]} />
            <div class="form-actions"><button class="btn btn-primary">Upload avatar</button></div>
          </form>
        </div>
        {p.avatarUploadId ? <ActionButton ctx={ctx} action="/settings/images/avatar/remove" label="Reset to default avatar" className="btn btn-small" /> : null}
      </Box>
      <Box title="Cover image" headingLevel={2}>
        {cover ? <img src={`/media/${cover.publicId}`} alt="Current cover" class={`cover-preview cover-y-${Math.round(p.coverPositionY / 10) * 10}`} /> : <p class="muted">No cover image — a theme pattern is shown instead.</p>}
        <form method="post" action="/settings/images/cover" enctype="multipart/form-data" class="form-grid"><Csrf ctx={ctx} />
          <div class="field"><label for="f-cover">Upload a cover image</label><input id="f-cover" type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
            <div class="field-hint">Up to {Math.round(lim.cover.maxBytes / 1_000_000)} MB. Resized to 1600×500.</div></div>
          <div class="form-actions"><button class="btn btn-primary">Upload cover</button></div>
        </form>
        {cover ? <form method="post" action="/settings/images/cover/position" class="inline-form"><Csrf ctx={ctx} />
          <label for="f-cpos">Vertical position</label><input id="f-cpos" type="range" name="y" min={0} max={100} step={10} value={String(p.coverPositionY)} />
          <button class="btn btn-small">Save position</button></form> : null}
        {cover ? <ActionButton ctx={ctx} action="/settings/images/cover/remove" label="Remove cover" className="btn btn-small" /> : null}
      </Box>
    </>
  ));
});

async function handleImage(c: C, purpose: 'avatar' | 'cover') {
  const v = need(c);
  await v.require('profile.customize');
  await rateLimit(v, 'upload');
  const b = await form(c);
  try {
    const f = await fileToBuffer(b.file);
    if (!f) throw new ServiceError('Choose an image to upload.');
    const g = str(b.gravity);
    const up = await saveUpload(v.user!.id, purpose, f.buf, f.name, { gravity: (['centre', 'north', 'south', 'attention'].includes(g) ? g : 'centre') as any });
    await (purpose === 'avatar' ? P.setAvatar(v.user!.id, up.id) : P.setCover(v.user!.id, up.id));
    setFlash(c, { type: 'ok', text: purpose === 'avatar' ? 'Avatar updated.' : 'Cover image updated.' });
  } catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/settings/images');
}
settingsRoutes.post('/settings/images/avatar', (c) => handleImage(c, 'avatar'));
settingsRoutes.post('/settings/images/cover', (c) => handleImage(c, 'cover'));
settingsRoutes.post('/settings/images/avatar/remove', async (c) => { await P.setAvatar(need(c).user!.id, null); setFlash(c, { type: 'ok', text: 'Avatar reset.' }); return c.redirect('/settings/images'); });
settingsRoutes.post('/settings/images/cover/remove', async (c) => { await P.setCover(need(c).user!.id, null); setFlash(c, { type: 'ok', text: 'Cover removed.' }); return c.redirect('/settings/images'); });
settingsRoutes.post('/settings/images/cover/position', async (c) => { const v = need(c); await P.updateProfile(v, { coverPositionY: int((await form(c)).y, 50) }); return c.redirect('/settings/images'); });

// ─────────────── Top Friends ───────────────

settingsRoutes.get('/settings/top-friends', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const p = await getProfile(v.user!.id);
  const ids = await friendIds(v.user!.id);
  const cards = await userCards(ids);
  const friends = ids.map((id) => cards.get(id)!).filter(Boolean).sort((a, b) => a.username.localeCompare(b.username));
  const current = await getDb().select().from(schema.topFriends).where(eq(schema.topFriends.userId, v.user!.id)).orderBy(schema.topFriends.position);
  return settingsPage(c, 'Top Friends', (
    <form method="post" action="/settings/top-friends" class="form-grid"><Csrf ctx={ctx} />
      <p>Choose up to five friends to feature on your profile, in order. Only accepted friends can be chosen.</p>
      <Select label="How many to show" name="count" value={String(p.topFriendsCount)} options={[['0', 'Off (hide the section)'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']]} />
      {friends.length ? [1, 2, 3, 4, 5].map((pos) => (
        <Select label={`Position ${pos}`} name="slot" value={String(current.find((x) => x.position === pos)?.friendId ?? '')} options={[['', '— empty —'], ...friends.map((f) => [String(f.id), f.username] as [string, string])]} />
      )) : <Notice type="info">You don't have any friends yet. Add some from member profiles first.</Notice>}
      <div class="form-actions"><button class="btn btn-primary">Save Top Friends</button></div>
    </form>
  ));
});
settingsRoutes.post('/settings/top-friends', async (c) => {
  const v = need(c);
  const b = await form(c);
  const count = int(b.count);
  const ids = arr(b.slot).map((x) => parseInt(x, 10)).filter((n) => n > 0);
  try {
    await setTopFriends(v.user!.id, count, [...new Set(ids)].slice(0, count));
    if (ids.length > count && count > 0) setFlash(c, { type: 'info', text: `Only the first ${count} were kept.` });
    setFlash(c, { type: 'ok', text: 'Top Friends saved.' });
  } catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/settings/top-friends');
});

// ─────────────── preferences ───────────────

settingsRoutes.get('/settings/preferences', async (c) => {
  const ctx = c.get('page');
  const v = ctx.viewer;
  const s = v.settings;
  return settingsPage(c, 'Preferences', (
    <form method="post" action="/settings/preferences" class="form-grid"><Csrf ctx={ctx} />
      <fieldset class="field theme-picker"><legend>Theme</legend>
        {themes().map((t) => <label class={`theme-option theme-swatch-${t.id}`}><input type="radio" name="theme" value={t.id} checked={s.theme === t.id || ctx.theme === t.id && !v.user} data-theme-preview data-theme-css={themeStylesheet(t.id) ?? ''} data-theme-scheme={t.scheme} /> <strong>{t.name}</strong><span class="muted"> — {t.description}</span></label>)}
        {!v.user ? <p class="field-hint">As a guest your choice is stored in a cookie on this device.</p> : null}
      </fieldset>
      {v.user ? <>
        <Checkbox label="Filter profanity" name="profanityFilter" checked={s.profanityFilter} hint="Masks general swear words when you read posts and messages. This only changes what you see — it never edits anyone's post. Language prohibited by the community rules is always removed regardless of this setting." />
        <Select label="NSFW-labelled threads" name="nsfwMode" value={s.nsfwMode} options={[['blur', 'Ask before showing (default)'], ['hide', 'Hide from thread lists'], ['show', 'Show without asking']]} />
        <Select label="Trigger-warning-labelled threads" name="triggerMode" value={s.triggerMode} options={[['blur', 'Ask before showing (default)'], ['hide', 'Hide from thread lists'], ['show', 'Show without asking']]} hint="Spoiler-labelled threads and [spoiler] blocks are always hidden until you reveal them." />
        <Checkbox label="Show signatures in posts" name="showSignatures" checked={s.showSignatures} />
        <Select label="Posts per page" name="postsPerPage" value={String(s.postsPerPage)} options={[['10', '10'], ['20', '20'], ['30', '30'], ['40', '40']]} />
        <div class="field"><label for="f-tz">Timezone</label><input id="f-tz" name="timezone" value={v.user.timezone} maxlength={64} list="tz-list" /><datalist id="tz-list">{((Intl as any).supportedValuesOf?.('timeZone') ?? ['UTC']).map((t: string) => <option value={t} />)}</datalist></div>
      </> : null}
      <div class="form-actions"><button class="btn btn-primary">Save preferences</button></div>
    </form>
  ));
});
settingsRoutes.post('/settings/preferences', async (c) => {
  const v = c.get('viewer');
  const b = await form(c);
  const theme = isTheme(str(b.theme)) ? str(b.theme) : 'classic';
  if (!v.user) {
    setCookie(c, COOKIE.theme, theme, { path: '/', sameSite: 'Lax', secure: secureCookies(), maxAge: 60 * 60 * 24 * 365, httpOnly: true });
    return c.redirect('/settings/preferences');
  }
  const mode = (x: string) => (['blur', 'hide', 'show'].includes(x) ? x : 'blur');
  const ppp = [10, 20, 30, 40].includes(int(b.postsPerPage)) ? int(b.postsPerPage) : 20;
  await getDb().update(schema.userSettings).set({ theme, profanityFilter: bool(b.profanityFilter), nsfwMode: mode(str(b.nsfwMode)), triggerMode: mode(str(b.triggerMode)), showSignatures: bool(b.showSignatures), postsPerPage: ppp }).where(eq(schema.userSettings.userId, v.user.id));
  if (isValidTimezone(str(b.timezone))) await getDb().update(schema.users).set({ timezone: str(b.timezone) }).where(eq(schema.users.id, v.user.id));
  setFlash(c, { type: 'ok', text: 'Preferences saved.' });
  return c.redirect('/settings/preferences');
});

// ─────────────── privacy ───────────────

settingsRoutes.get('/settings/privacy', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const s = v.settings;
  const p = await getProfile(v.user!.id);
  return settingsPage(c, 'Privacy', (
    <form method="post" action="/settings/privacy" class="form-grid"><Csrf ctx={ctx} />
      <Checkbox label="Show when I'm online" name="showPresence" checked={s.showPresence} hint="When off, nobody (including friends) sees your online/away status, and you're left out of the 'Online now' list." />
      <Checkbox label="List me in the member directory and search suggestions" name="discoverable" checked={s.discoverable} hint="When off, people can still find you by typing your exact username." />
      <Select label="Who can start a direct-message conversation with me" name="dmPolicy" value={s.dmPolicy} options={[['everyone', 'Any member'], ['friends', 'Friends only'], ['nobody', 'Nobody']]} hint="Blocked members can never message you. Existing conversations stay readable." />
      <Select label="Who can see my full profile" name="visibility" value={p.visibility} options={[['everyone', 'Everyone, including guests'], ['members', 'Signed-in members'], ['friends', 'Friends only']]} hint="Your username, avatar and posts in forums remain visible to people who can read those forums." />
      <div class="form-actions"><button class="btn btn-primary">Save privacy settings</button></div>
    </form>
  ));
});
settingsRoutes.post('/settings/privacy', async (c) => {
  const v = need(c);
  const b = await form(c);
  const dm = ['everyone', 'friends', 'nobody'].includes(str(b.dmPolicy)) ? str(b.dmPolicy) : 'everyone';
  await getDb().update(schema.userSettings).set({ showPresence: bool(b.showPresence), discoverable: bool(b.discoverable), dmPolicy: dm }).where(eq(schema.userSettings.userId, v.user!.id));
  await P.updateProfile(v, { visibility: str(b.visibility) });
  setFlash(c, { type: 'ok', text: 'Privacy settings saved.' });
  return c.redirect('/settings/privacy');
});

// ─────────────── notifications ───────────────

settingsRoutes.get('/settings/notifications', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const kinds = await N.allNotificationKinds();
  const rows = await Promise.all(Object.keys(kinds).map(async (k) => [k, await N.preferenceFor(v.user!.id, k as N.NotificationKind)] as const));
  return settingsPage(c, 'Notifications', (
    <form method="post" action="/settings/notifications" class="form-grid"><Csrf ctx={ctx} />
      <Checkbox label="Allow email notifications" name="emailNotifications" checked={v.settings.emailNotifications} hint={v.user!.email ? `Sent to ${v.user!.email}. Security notices are always emailed.` : 'Add an email address under Account to receive email.'} />
      <table class="data-table prefs-table"><thead><tr><th>Event</th><th>On site</th><th>Email</th></tr></thead><tbody>
        {rows.map(([k, p]) => { const mandatory = N.MANDATORY_KINDS.includes(k as N.NotificationKind); return (
          <tr><td>{kinds[k]}{mandatory ? <span class="muted small"> (always on)</span> : null}</td>
            <td><input type="checkbox" name={`in_${k}`} value="1" checked={p.inApp || mandatory} disabled={mandatory} aria-label={`On-site notifications for ${k}`} /></td>
            <td><input type="checkbox" name={`em_${k}`} value="1" checked={p.email} aria-label={`Email notifications for ${k}`} /></td></tr>); })}
      </tbody></table>
      <p class="field-hint">Muting a member or conversation suppresses their notifications regardless of these settings.</p>
      <div class="form-actions"><button class="btn btn-primary">Save</button></div>
    </form>
  ));
});
settingsRoutes.post('/settings/notifications', async (c) => {
  const v = need(c);
  const b = await form(c);
  const prefs: Record<string, { inApp: boolean; email: boolean }> = {};
  for (const k of Object.keys(await N.allNotificationKinds())) prefs[k] = { inApp: bool(b[`in_${k}`]), email: bool(b[`em_${k}`]) };
  await N.setPreferences(v.user!.id, prefs);
  await getDb().update(schema.userSettings).set({ emailNotifications: bool(b.emailNotifications) }).where(eq(schema.userSettings.userId, v.user!.id));
  setFlash(c, { type: 'ok', text: 'Notification settings saved.' });
  return c.redirect('/settings/notifications');
});

// ─────────────── blocked & muted ───────────────

settingsRoutes.get('/settings/blocked', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const { blocks, mutes } = await listBlocksAndMutes(v.user!.id);
  const cards = await userCards([...blocks.map((b) => b.blockedId), ...mutes.map((m) => m.mutedId)]);
  return settingsPage(c, 'Blocked & muted members', (
    <>
      <Box title="What's the difference?" headingLevel={2}>
        <dl class="kv kv-wide">
          <dt>Block</dt><dd>The member can't message you, send friend requests or comment on your profile, and any friendship between you is removed. Their posts are collapsed for you. They aren't notified. Existing message history is kept but no new messages can be sent either way.</dd>
          <dt>Mute</dt><dd>You stop receiving notifications from the member. They can still message you and interact normally — muting only changes what you're alerted to.</dd>
        </dl>
      </Box>
      <Box title={`Blocked (${blocks.length})`} headingLevel={2}>
        {blocks.length ? <table class="data-table"><tbody>{blocks.map((b) => { const u = cards.get(b.blockedId); return <tr><td><UserLink user={u} /></td><td class="muted">since <Time d={b.createdAt} tz={tz(ctx)} mode="date" /></td><td class="row-actions"><ActionButton ctx={ctx} action={`/u/${encodeURIComponent(u?.username ?? '')}/unblock`} label="Unblock" className="btn btn-small" /></td></tr>; })}</tbody></table> : <p class="muted">You haven't blocked anyone.</p>}
      </Box>
      <Box title={`Muted (${mutes.length})`} headingLevel={2}>
        {mutes.length ? <table class="data-table"><tbody>{mutes.map((m) => { const u = cards.get(m.mutedId); return <tr><td><UserLink user={u} /></td><td class="muted">{m.hideContent ? 'notifications + content collapsed' : 'notifications only'}</td><td class="row-actions"><ActionButton ctx={ctx} action={`/u/${encodeURIComponent(u?.username ?? '')}/unmute`} label="Unmute" className="btn btn-small" /></td></tr>; })}</tbody></table> : <p class="muted">You haven't muted anyone.</p>}
      </Box>
    </>
  ));
});

// ─────────────── account ───────────────

settingsRoutes.get('/settings/account', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const u = v.user!;
  const days = await getSetting('username_change_days');
  const canRename = (await v.can('user.change_username')) || v.subject.isSuperAdmin;
  const warnings = await getDb().select().from(schema.userWarnings).where(eq(schema.userWarnings.userId, u.id)).orderBy(desc(schema.userWarnings.createdAt));
  const err = c.req.query('error');
  return settingsPage(c, 'Account', (
    <>
      {err ? <Notice type="error">{err}</Notice> : null}
      <Box title="Username" headingLevel={2}>
        <p>Your username is <strong>{u.username}</strong>.{u.usernameChangedAt ? <> Last changed <Time d={u.usernameChangedAt} tz={tz(ctx)} mode="date" />.</> : null}</p>
        {canRename ? <form method="post" action="/settings/account/username" class="inline-form"><Csrf ctx={ctx} /><label for="f-un">New username</label> <input id="f-un" name="username" maxlength={24} minlength={3} required data-username-check /> <button class="btn btn-small">Change</button><div class="field-hint">You can change it once every {days} days. Your old name may become available to others.</div></form>
          : <p class="muted">Username changes unlock once you become an Established Member.</p>}
      </Box>
      <Box title="Email address" headingLevel={2}>
        <p>{u.email ? <>Current: <strong>{u.email}</strong> {u.emailVerifiedAt ? <span class="tag tag-ok">verified</span> : <span class="tag tag-held">unverified</span>}</> : 'No email address on file. Adding one lets you recover your account.'}</p>
        <form method="post" action="/settings/account/email" class="inline-form"><Csrf ctx={ctx} /><label for="f-em">New email</label> <input id="f-em" type="email" name="email" required maxlength={254} /> <button class="btn btn-small">Send confirmation</button></form>
      </Box>
      <Box title={u.passwordHash ? 'Change password' : 'Add a password'} headingLevel={2}>
        <form method="post" action="/settings/account/password" class="form-grid"><Csrf ctx={ctx} />
          {u.passwordHash ? <Field label="Current password" name="current" type="password" required autocomplete="current-password" /> : <p class="muted">You sign in with a connected provider. Adding a password gives you another way in.</p>}
          <Field label="New password" name="password" type="password" required minlength={10} autocomplete="new-password" />
          <Field label="Confirm new password" name="confirm" type="password" required autocomplete="new-password" />
          <div class="form-actions"><button class="btn btn-primary">{u.passwordHash ? 'Change password' : 'Add password'}</button></div>
        </form>
      </Box>
      {warnings.length ? <Box title="Warnings on your account" headingLevel={2}><ul class="plain-list">{warnings.map((w) => <li><Time d={w.createdAt} tz={tz(ctx)} mode="date" /> — {w.reason}{w.expiresAt ? <span class="muted"> (expires <Time d={w.expiresAt} tz={tz(ctx)} mode="date" />)</span> : null}</li>)}</ul></Box> : null}
      <Box title="Close account" headingLevel={2} className="danger-zone">
        <p>Closing your account signs you out everywhere, removes your profile, avatar, email address and sign-in methods, and shows your past posts as by “Former member”. Forum posts and direct messages you've already sent are kept so conversations stay intact (see the <a href="/pages/privacy">privacy policy</a> for erasure requests).</p>
        <form method="post" action="/settings/account/close" class="form-grid" data-confirm="Close your account permanently? This cannot be undone."><Csrf ctx={ctx} />
          <Field label={`Type your username (${u.username}) to confirm`} name="confirmName" required />
          <div class="form-actions"><button class="btn btn-danger">Close my account</button></div>
        </form>
      </Box>
    </>
  ));
});

settingsRoutes.post('/settings/account/username', async (c) => {
  const r = await requireReauth(c, '/settings/account'); if (r) return r;
  const err = await P.changeUsername(need(c), str((await form(c)).username));
  setFlash(c, err ? { type: 'error', text: err } : { type: 'ok', text: 'Username changed.' });
  return c.redirect('/settings/account');
});
settingsRoutes.post('/settings/account/email', async (c) => {
  const r = await requireReauth(c, '/settings/account'); if (r) return r;
  const v = need(c);
  const err = await A.requestEmailChange(v.user!, str((await form(c)).email), { ip: v.ip, userAgent: v.userAgent });
  setFlash(c, err ? { type: 'error', text: err } : { type: 'ok', text: 'Check the new address for a confirmation link.' });
  return c.redirect('/settings/account');
});
settingsRoutes.post('/settings/account/password', async (c) => {
  const v = need(c);
  if (!v.user!.passwordHash) { const r = await requireReauth(c, '/settings/account'); if (r) return r; }
  const b = await form(c);
  const err = await A.changePassword(v.user!, v.session!.id, str(b.current), str(b.password), str(b.confirm), { ip: v.ip, userAgent: v.userAgent });
  setFlash(c, err ? { type: 'error', text: err } : { type: 'ok', text: 'Password saved. Other sessions were signed out.' });
  if (!err) await A.markReauthenticated(v.session!.id);
  return c.redirect('/settings/account');
});
settingsRoutes.post('/settings/account/close', async (c) => {
  const r = await requireReauth(c, '/settings/account'); if (r) return r;
  const v = need(c);
  const b = await form(c);
  if (str(b.confirmName) !== v.user!.username) { setFlash(c, { type: 'error', text: 'The username you typed did not match.' }); return c.redirect('/settings/account'); }
  const db = getDb();
  const uid = v.user!.id;
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ closedAt: new Date(), email: null, emailLower: null, passwordHash: null, username: `former-member-${uid}`, usernameLower: `former-member-${uid}` }).where(eq(schema.users.id, uid));
    await tx.update(schema.userProfiles).set({ bio: '', signature: '', pronouns: null, location: null, customTitle: null, links: [], spotifyTrackUrl: null, spotifyPlaylistUrl: null, avatarUploadId: null, coverUploadId: null, backgroundColor: null }).where(eq(schema.userProfiles.userId, uid));
    await tx.delete(schema.externalAccounts).where(eq(schema.externalAccounts.userId, uid));
    await tx.delete(schema.friendships).where(eq(schema.friendships.userLowId, uid));
    await tx.delete(schema.friendships).where(eq(schema.friendships.userHighId, uid));
    await tx.update(schema.userSessions).set({ revokedAt: new Date() }).where(eq(schema.userSessions.userId, uid));
  });
  await emit('user.closed', { userId: uid });
  await securityEvent(uid, 'account_closed', { ip: v.ip });
  await audit(uid, 'user.close', { type: 'user', id: uid }, {}, v.ip);
  deleteCookie(c, COOKIE.session, { path: '/' });
  return c.redirect('/');
});

// ─────────────── security ───────────────

settingsRoutes.get('/settings/security', async (c) => {
  const ctx = c.get('page');
  const v = need(c);
  const sessions = await A.listSessions(v.user!.id);
  const { hasPassword, linked } = await O.authMethods(v.user!.id);
  const providers = await O.listProviders();
  const events = await getDb().select().from(schema.securityEvents).where(eq(schema.securityEvents.userId, v.user!.id)).orderBy(desc(schema.securityEvents.createdAt)).limit(20);
  const recent = await A.isRecentlyAuthenticated(v.session);
  const methods = (hasPassword ? 1 : 0) + linked.length;
  return settingsPage(c, 'Security', (
    <>
      <Box title="Connected accounts" headingLevel={2}>
        <p>Sign in to Fragged with any connected provider. Your Fragged username, profile and content belong to your Fragged account, not the provider.</p>
        <table class="data-table"><thead><tr><th>Method</th><th>Details</th><th>Connected</th><th>Last used</th><th /></tr></thead><tbody>
          <tr><td>Password</td><td>{hasPassword ? 'Set' : <span class="muted">Not set</span>}</td><td /><td /><td>{hasPassword ? null : <a href="/settings/account">Add password</a>}</td></tr>
          {linked.map((l) => (
            <tr><td>{providers.find((p) => p.id === l.provider)?.name ?? l.provider}</td><td>{l.providerDisplayName ?? ''}{l.providerEmail ? <span class="muted"> · {l.providerEmail}</span> : null}</td>
              <td><Time d={l.connectedAt} tz={tz(ctx)} mode="date" /></td><td><Time d={l.lastAuthAt} tz={tz(ctx)} mode="ago" /></td>
              <td>{methods > 1 ? <ActionButton ctx={ctx} action={`/settings/security/unlink/${l.id}`} label="Disconnect" className="btn btn-small" confirm="Disconnect this sign-in method?" /> : <span class="muted small" title="You need at least one way to sign in">Only sign-in method</span>}</td></tr>
          ))}
        </tbody></table>
        {recent ? <ProviderButtons ctx={ctx} mode="link" /> : <p><a class="btn" href="/reauth?returnTo=/settings/security">Confirm it's you to connect a provider</a></p>}
      </Box>
      <Box title="Active sessions" headingLevel={2}>
        <table class="data-table"><thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th /></tr></thead><tbody>
          {sessions.map((s) => (
            <tr class={s.id === v.session?.id ? 'is-current' : ''}><td>{describeUA(s.userAgent)}{s.id === v.session?.id ? <span class="tag tag-ok">this device</span> : null}</td><td>{s.ip ?? ''}</td>
              <td><Time d={s.createdAt} tz={tz(ctx)} mode="date" /></td><td><Time d={s.lastUsedAt} tz={tz(ctx)} mode="ago" /></td>
              <td>{s.id !== v.session?.id ? <ActionButton ctx={ctx} action={`/settings/security/revoke/${s.id}`} label="Sign out" className="btn btn-small" /> : null}</td></tr>
          ))}
        </tbody></table>
        <ActionButton ctx={ctx} action="/settings/security/revoke-all" label="Sign out all other sessions" className="btn" />
      </Box>
      <Box title="Recent security activity" headingLevel={2}>
        <table class="data-table"><tbody>{events.map((e) => <tr><td><Time d={e.createdAt} tz={tz(ctx)} /></td><td>{e.kind.replace(/_/g, ' ')}{e.provider ? ` (${e.provider})` : ''}</td><td class="muted">{e.ip ?? ''}</td></tr>)}</tbody></table>
      </Box>
    </>
  ));
});

function describeUA(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ' on ' + os : ''}`;
}

settingsRoutes.post('/settings/security/revoke/:id', async (c) => { const v = need(c); await A.revokeSession(int(c.req.param('id')), v.user!.id); await securityEvent(v.user!.id, 'session_revoked', { ip: v.ip }); setFlash(c, { type: 'ok', text: 'Session signed out.' }); return c.redirect('/settings/security'); });
settingsRoutes.post('/settings/security/revoke-all', async (c) => { const v = need(c); await A.revokeAllSessions(v.user!.id, v.session!.id); await securityEvent(v.user!.id, 'sessions_revoked', { ip: v.ip }); setFlash(c, { type: 'ok', text: 'All other sessions were signed out.' }); return c.redirect('/settings/security'); });
settingsRoutes.post('/settings/security/unlink/:id', async (c) => {
  const r = await requireReauth(c, '/settings/security'); if (r) return r;
  const v = need(c);
  try { await O.unlinkIdentity(v.user!, int(c.req.param('id')), { ip: v.ip, userAgent: v.userAgent }); setFlash(c, { type: 'ok', text: 'Sign-in method disconnected.' }); }
  catch (e) { if (e instanceof ServiceError) setFlash(c, { type: 'error', text: e.message }); else throw e; }
  return c.redirect('/settings/security');
});

export const _x = { and, inArray, getTopFriends };
