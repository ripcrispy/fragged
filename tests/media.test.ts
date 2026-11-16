import { registries } from '../src/modules/registry.ts';
import { providers as mediaProviders } from '../modules/media-embeds/providers.ts';
for (const p of mediaProviders) registries.mediaProviders.add('core', p);
import { describe, it, expect } from 'vitest';
import { resolveMedia, safeUrl, extractUrls } from '../src/lib/media.ts';
import { validateSpotifyUrl } from '../modules/profile-spotify/index.tsx';

describe('media resolver', () => {
  it('parses YouTube variants', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ']) {
      expect(resolveMedia(u)?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    }
    expect(resolveMedia('https://youtu.be/dQw4w9WgXcQ?t=1m5s')?.embedUrl).toContain('start=65');
  });
  it('rejects bad YouTube ids and lookalike hosts', () => {
    expect(resolveMedia('https://www.youtube.com/watch?v=<script>')?.embedUrl).toBeNull();
    expect(resolveMedia('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')?.embedUrl).toBeNull();
    expect(resolveMedia('https://evilyoutube.com/watch?v=dQw4w9WgXcQ')?.embedUrl).toBeNull();
  });
  it('rejects dangerous schemes and credentials', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html;base64,xx')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('https://user:pass@example.com')).toBeNull();
    expect(resolveMedia('javascript:alert(1)')).toBeNull();
  });
  it('treats files as external links, not uploads', () => {
    const r = resolveMedia('https://files.example.org/build/game-v2.zip');
    expect(r?.kind).toBe('file');
    expect(r?.embedUrl).toBeNull();
    expect(r?.fileName).toBe('game-v2.zip');
    expect(resolveMedia('https://cdn.example.org/clip.mp4')?.kind).toBe('file');
  });
  it('validates Spotify links', () => {
    expect(validateSpotifyUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'track')).toBeTruthy();
    expect(validateSpotifyUrl('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'track')).toBeTruthy();
    expect(validateSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'playlist')).toBeTruthy();
    expect(validateSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'track')).toBeNull();
    expect(validateSpotifyUrl('https://spotify.evil.example/track/4uLU6hMCjMI75M1A2tKUQC', 'track')).toBeNull();
  });
  it('extracts URLs from text', () => {
    expect(extractUrls('a https://x.example/a, and (https://y.example/b) javascript:alert(1)')).toEqual(['https://x.example/a', 'https://y.example/b']);
  });
});
