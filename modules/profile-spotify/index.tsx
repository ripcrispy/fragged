/** @jsxImportSource hono/jsx */
import {
  defineModule, pg, eq, sql, Box, Field, Checkbox, Html, safeUrl, resolveMedia, mediaEmbedHtml, linkCardHtml, str, bool,
} from '../../src/sdk/index.ts';

/** Module-owned table (created by migrations/0001_init.sql). */
export const spotifyLinks = pg.pgTable('mod_profile_spotify', {
  userId: pg.integer('user_id').primaryKey(),
  trackUrl: pg.text('track_url'),
  playlistUrl: pg.text('playlist_url'),
  show: pg.boolean('show').notNull().default(true),
  updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const SPOTIFY = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|playlist|album|episode)\/[A-Za-z0-9]{22}(?:\/|$)/;

/** Accept only open.spotify.com links of the right kind; returns the normalised URL or null. */
export function validateSpotifyUrl(raw: string, type: 'track' | 'playlist'): string | null {
  const u = safeUrl(raw);
  if (!u || u.protocol !== 'https:' || u.hostname !== 'open.spotify.com') return null;
  const m = SPOTIFY.exec(u.pathname);
  if (!m) return null;
  const ok = type === 'track' ? ['track', 'album', 'episode'] : ['playlist', 'album'];
  return ok.includes(m[1]) ? u.toString() : null;
}

export default defineModule({
  id: 'profile-spotify',
  name: 'Spotify on profiles',
  version: '1.1.0',
  description: 'Members can show a favourite Spotify track and playlist on their profile. Links only — no Spotify account connection.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.2.0',
  // with Media embeds enabled the links play in a click-to-load player; without it they show as plain links
  optionalDependencies: { 'media-embeds': '^1.0.0' },
  migrations: 'migrations',
  setup(ctx) {
    const db = () => ctx.db();
    const load = async (userId: number) => (await db().select().from(spotifyLinks).where(eq(spotifyLinks.userId, userId)))[0] ?? null;

    ctx.register.profileSection({
      id: 'spotify', column: 'side', order: 30,
      async render({ user }) {
        const row = await load(user.id);
        if (!row?.show) return null;
        const links = [row.trackUrl, row.playlistUrl].filter((x): x is string => !!x).map((u) => resolveMedia(u)).filter((x) => !!x);
        if (!links.length) return null;
        return (
          <Box title="On repeat" headingLevel={3} className="spotify-box">
            {links.map((r) => <Html html={r!.embedUrl ? mediaEmbedHtml(r!) : linkCardHtml(r!)} />)}
            <p class="field-hint">Shared Spotify {links.length > 1 ? 'links' : 'link'} — this isn't live listening data.</p>
          </Box>
        );
      },
    });

    ctx.register.profileSettings({
      id: 'spotify', order: 30,
      async render({ viewer, errors }) {
        const row = await load(viewer.user!.id);
        return (
          <fieldset class="field"><legend>Spotify</legend>
            <Field label="Favourite song (Spotify track link)" name="spotifyTrackUrl" value={row?.trackUrl} error={errors.spotifyTrackUrl} placeholder="https://open.spotify.com/track/…" />
            <Field label="Favourite playlist (Spotify playlist link)" name="spotifyPlaylistUrl" value={row?.playlistUrl} error={errors.spotifyPlaylistUrl} placeholder="https://open.spotify.com/playlist/…" />
            <Checkbox label="Show the Spotify section on my profile" name="showSpotify" checked={row ? row.show : true} hint="No Spotify account connection is needed. Only the link is stored; the player loads when someone clicks it." />
          </fieldset>
        );
      },
      async save({ viewer, form }) {
        const errors: Record<string, string> = {};
        const t = str(form.spotifyTrackUrl).trim(), pl = str(form.spotifyPlaylistUrl).trim();
        const track = t ? validateSpotifyUrl(t, 'track') : null;
        const playlist = pl ? validateSpotifyUrl(pl, 'playlist') : null;
        if (t && !track) errors.spotifyTrackUrl = 'Enter a Spotify track link, e.g. https://open.spotify.com/track/…';
        if (pl && !playlist) errors.spotifyPlaylistUrl = 'Enter a Spotify playlist link, e.g. https://open.spotify.com/playlist/…';
        if (Object.keys(errors).length) return errors;
        await db().insert(spotifyLinks).values({ userId: viewer.user!.id, trackUrl: track, playlistUrl: playlist, show: bool(form.showSpotify) })
          .onConflictDoUpdate({ target: spotifyLinks.userId, set: { trackUrl: track, playlistUrl: playlist, show: bool(form.showSpotify), updatedAt: sql`now()` } });
        return {};
      },
    });

    ctx.hooks.on('user.closed', async ({ userId }) => { await db().delete(spotifyLinks).where(eq(spotifyLinks.userId, userId)); });
    ctx.register.personalData({
      id: 'profile-spotify', label: 'Spotify on your profile',
      export: async (userId) => (await db().select({ track: spotifyLinks.trackUrl, playlist: spotifyLinks.playlistUrl, shown: spotifyLinks.show, updated: spotifyLinks.updatedAt }).from(spotifyLinks).where(eq(spotifyLinks.userId, userId)))[0] ?? null,
      erase: async (userId) => { await db().delete(spotifyLinks).where(eq(spotifyLinks.userId, userId)); },
    });
  },
});
