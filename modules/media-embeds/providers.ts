import type { MediaProviderDef } from '../../src/sdk/index.ts';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeStart(u: URL): number | null {
  const t = u.searchParams.get('t') ?? u.searchParams.get('start');
  if (!t) return null;
  if (/^\d+$/.test(t)) return Math.min(parseInt(t, 10), 86400);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return null;
  const secs = (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
  return secs > 0 ? Math.min(secs, 86400) : null;
}

export const youtube: MediaProviderDef = {
  id: 'youtube',
  name: 'YouTube',
  // privacy-enhanced mode; nothing loads until the reader clicks
  embedOrigins: ['https://www.youtube-nocookie.com'],
  match(u) {
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? null;
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else { const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname); if (m) id = m[1]; }
    }
    if (!id || !YT_ID.test(id)) return null;
    const start = parseYouTubeStart(u);
    return { kind: 'video', embedUrl: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`, aspect: 'video' };
  },
};

export const vimeo: MediaProviderDef = {
  id: 'vimeo',
  name: 'Vimeo',
  embedOrigins: ['https://player.vimeo.com'],
  match(u) {
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
    const m = /^\/(?:video\/)?(\d{4,12})(?:\/|$)/.exec(u.pathname);
    return m ? { kind: 'video', embedUrl: `https://player.vimeo.com/video/${m[1]}?dnt=1`, aspect: 'video' } : null;
  },
};

export const spotify: MediaProviderDef = {
  id: 'spotify',
  name: 'Spotify',
  embedOrigins: ['https://open.spotify.com'],
  match(u) {
    if (u.hostname !== 'open.spotify.com') return null;
    const m = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|playlist|album|episode)\/([A-Za-z0-9]{22})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    return { kind: 'audio', embedUrl: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, aspect: m[1] === 'track' || m[1] === 'episode' ? 'spotify-track' : 'spotify-list', title: m[1] };
  },
};

export const providers = [youtube, vimeo, spotify];
