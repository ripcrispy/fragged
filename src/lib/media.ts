import { registries } from '../modules/registry.ts';

/**
 * Centralised, allowlist-based external media resolver shared by posts, direct messages and profiles.
 *
 * Nothing here fetches remote content. URLs are parsed locally and either mapped to a known
 * provider embed (with a fixed, safe embed URL we construct ourselves) or treated as an
 * external link. Arbitrary iframes/HTML are never produced.
 */

export type MediaKind = 'video' | 'audio' | 'file' | 'link';

export interface ResolvedMedia {
  kind: MediaKind;
  provider: string | null;
  providerName: string;
  /** The original URL, preserved */
  url: string;
  /** Safe embed URL constructed from validated IDs (null when not embeddable) */
  embedUrl: string | null;
  /** iframe sizing hint */
  aspect?: 'video' | 'spotify-track' | 'spotify-list';
  title?: string;
  /** Domain shown to users so external content is clearly identified */
  domain: string;
  fileName?: string;
  fileExt?: string;
}

const MAX_URL = 2000;

/** Parse and validate a user-supplied URL. Only http(s) without credentials is accepted. */
export function safeUrl(raw: string, opts: { allowMailto?: boolean } = {}): URL | null {
  const s = raw.trim();
  if (!s || s.length > MAX_URL) return null;
  // reject control chars / whitespace inside the URL
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (opts.allowMailto && u.protocol === 'mailto:') return u;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname || u.hostname.length > 253) return null;
  return u;
}

/** Same-origin relative paths (e.g. /media/...) are allowed for internal links. */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (/^\/(?!\/)[\w\-./?=&%#~+:]*$/.test(s) && !s.includes('\\')) return s;
  const u = safeUrl(s, { allowMailto: true });
  return u ? u.toString() : null;
}

/** Origins allowed in <iframe> (CSP frame-src): the union of every enabled media provider's embed origins. */
export function embedOrigins(): string[] {
  return [...new Set(registries.mediaProviders.active().flatMap((p) => p.embedOrigins))];
}

const FILE_EXT = /\.(pdf|zip|7z|rar|tar|gz|txt|csv|docx?|xlsx?|pptx?|odt|mp3|ogg|wav|flac|mp4|webm|mov|mkv|png|jpe?g|gif|webp|exe|dmg|apk|iso|blend|psd|obj|fbx|stl)$/i;

export function resolveMedia(raw: string): ResolvedMedia | null {
  const u = safeUrl(raw);
  if (!u) return null;
  const domain = u.hostname.replace(/^www\./, '');
  for (const p of registries.mediaProviders.active()) {
    let r;
    try { r = p.match(u); } catch { r = null; }
    // providers may only produce https embeds on their declared origins
    if (r && !p.embedOrigins.some((o) => r!.embedUrl.startsWith(o + '/'))) r = null;
    if (r) return { ...r, provider: p.id, providerName: p.name, url: u.toString(), domain };
  }
  const last = decodeURIComponent(u.pathname.split('/').pop() ?? '').slice(0, 120);
  const ext = FILE_EXT.exec(last);
  if (ext) {
    const e = ext[1].toLowerCase();
    const isVideo = ['mp4', 'webm', 'mov', 'mkv'].includes(e);
    return { kind: 'file', provider: null, providerName: isVideo ? 'External video file' : 'External file', url: u.toString(), embedUrl: null, domain, fileName: last, fileExt: e };
  }
  return { kind: 'link', provider: null, providerName: domain, url: u.toString(), embedUrl: null, domain };
}


/** Extract http(s) URLs from plain text (messages). */
export function extractUrls(text: string, limit = 10): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = safeUrl(trimUrlPunctuation(m[0]));
    if (u && !out.includes(u.toString())) out.push(u.toString());
    if (out.length >= limit) break;
  }
  return out;
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"'\[\]]+/gi;

export function trimUrlPunctuation(s: string): string {
  // drop trailing punctuation that is usually sentence punctuation
  let out = s.replace(/[.,;:!?]+$/, '');
  // unbalanced closing paren
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1);
  return out;
}
