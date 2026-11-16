/**
 * Safe BBCode parser/renderer.
 *
 * Security model: user input is never interpreted as HTML. The source is tokenised into an
 * explicit tree of allowlisted tags; every text node is HTML-escaped, every URL passes
 * `safeHref`/`safeUrl`, colours map to fixed CSS classes, and embeds are produced only by the
 * media resolver. Unknown or malformed tags render as literal (escaped) text.
 */
import { resolveMedia, safeHref, safeUrl, trimUrlPunctuation, type ResolvedMedia } from './media.ts';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type Node =
  | { type: 'text'; text: string }
  | { type: 'tag'; name: string; arg: string | null; children: Node[]; raw: string; closeRaw?: string };

const SIMPLE = new Set(['b', 'i', 'u', 's']);
const KNOWN = new Set(['b', 'i', 'u', 's', 'url', 'img', 'quote', 'code', 'list', '*', 'spoiler', 'color', 'center', 'media', 'video', 'youtube', 'noparse', 'h']);
const RAW_CONTENT = new Set(['code', 'noparse', 'img', 'media', 'video', 'youtube']);
export const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray', 'brown'] as const;
const MAX_DEPTH = 24;
const MAX_QUOTE_DEPTH = 4;
export const USERNAME_RE_SRC = '[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9_]';

const TAG_RE = /\[(\/?)([a-z*]{1,8})(?:=([^\]\n]{0,300}))?\]/gi;

export function parse(src: string): Node[] {
  const root: Node = { type: 'tag', name: '#root', arg: null, children: [], raw: '' };
  const stack: Extract<Node, { type: 'tag' }>[] = [root as any];
  let pos = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const top = stack[stack.length - 1];
    const last = top.children[top.children.length - 1];
    if (last && last.type === 'text') last.text += t;
    else top.children.push({ type: 'text', text: t });
  };
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src))) {
    const [raw, slash, nameRaw, arg] = m;
    const name = nameRaw.toLowerCase();
    if (!KNOWN.has(name)) continue;
    pushText(src.slice(pos, m.index));
    pos = m.index + raw.length;
    if (!slash) {
      if (RAW_CONTENT.has(name)) {
        // take everything up to the matching close tag verbatim
        const closeRe = new RegExp(`\\[/${name}\\]`, 'i');
        const rest = src.slice(pos);
        const cm = closeRe.exec(rest);
        if (!cm) { pushText(raw); continue; }
        const top = stack[stack.length - 1];
        top.children.push({ type: 'tag', name, arg: arg ?? null, children: [{ type: 'text', text: rest.slice(0, cm.index) }], raw, closeRaw: cm[0] });
        pos += cm.index + cm[0].length;
        TAG_RE.lastIndex = pos;
        continue;
      }
      if (name === '*') {
        // list item: close previous item if open
        const top = stack[stack.length - 1];
        if (top.name === '*') stack.pop();
        const parent = stack[stack.length - 1];
        if (parent.name !== 'list') { pushText(raw); continue; }
        const node = { type: 'tag' as const, name, arg: null, children: [], raw };
        parent.children.push(node);
        stack.push(node);
        continue;
      }
      if (stack.length > MAX_DEPTH) { pushText(raw); continue; }
      const node = { type: 'tag' as const, name, arg: arg ?? null, children: [] as Node[], raw };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      // closing tag: find nearest matching open tag
      let idx = -1;
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { idx = i; break; }
      if (name === 'list') {
        // a [/list] also closes an open [*]
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === 'list') { idx = i; break; }
      }
      if (idx === -1) { pushText(raw); continue; }
      stack[idx].closeRaw = raw;
      stack.length = idx;
    }
  }
  pushText(src.slice(pos));
  // Unclosed tags: mark as unclosed so renderer can show them literally
  return root.children;
}

export interface RenderOptions {
  /** Map shortcode (without colons) -> image URL, approved emoji only */
  emoji?: Map<string, string>;
  /** Applied to every text segment before escaping (profanity / restricted-term redaction) */
  filterText?: (s: string) => string;
  /** Render provider embeds (otherwise links). */
  embeds?: boolean;
  /** Allow [img] tags */
  images?: boolean;
  /** Prefix for internal links */
  mentionBase?: string;
}

interface Ctx extends RenderOptions { quoteDepth: number; inLink?: boolean }

const ytLine = /^\s*(https?:\/\/\S+)\s*$/;

export function render(src: string, opts: RenderOptions = {}): string {
  const ctx: Ctx = { embeds: true, images: true, mentionBase: '/u/', ...opts, quoteDepth: 0 };
  return renderNodes(parse(normaliseNewlines(src)), ctx, true);
}

function normaliseNewlines(s: string) { return s.replace(/\r\n?/g, '\n'); }

function renderNodes(nodes: Node[], ctx: Ctx, blockLevel: boolean): string {
  let out = '';
  for (const n of nodes) out += n.type === 'text' ? renderText(n.text, ctx, blockLevel) : renderTag(n, ctx);
  return out;
}

function literal(n: Extract<Node, { type: 'tag' }>, ctx: Ctx): string {
  return escapeHtml(n.raw) + renderNodes(n.children, ctx, false) + escapeHtml(n.closeRaw ?? '');
}

function textOf(nodes: Node[]): string {
  return nodes.map((n) => (n.type === 'text' ? n.text : textOf(n.children))).join('');
}

export function mediaEmbedHtml(r: ResolvedMedia): string {
  if (!r.embedUrl) return linkCardHtml(r);
  const cls = r.aspect === 'video' ? 'embed embed-video' : r.aspect === 'spotify-track' ? 'embed embed-spotify-track' : 'embed embed-spotify-list';
  // Click-to-load: no third-party request is made until the viewer opts in.
  return `<div class="${cls}" data-embed="${escapeHtml(r.embedUrl)}" data-provider="${escapeHtml(r.provider ?? '')}">`
    + `<button type="button" class="embed-load">`
    + `<span class="embed-provider">${escapeHtml(r.providerName)}</span><span class="embed-cta">Click to load<span class="sr-only"> ${escapeHtml(r.providerName)} player</span></span>`
    + `<span class="embed-note">Content from ${escapeHtml(r.domain)}</span></button>`
    + `<a class="embed-fallback" href="${escapeHtml(r.url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${escapeHtml(r.url)}</a></div>`;
}

export function linkCardHtml(r: ResolvedMedia): string {
  if (r.kind === 'file') {
    return `<span class="link-card link-file"><span class="link-file-ext">${escapeHtml((r.fileExt ?? '').toUpperCase())}</span>`
      + `<a href="${escapeHtml(r.url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${escapeHtml(r.fileName ?? r.url)}</a>`
      + `<span class="link-domain">External link · ${escapeHtml(r.domain)}</span></span>`;
  }
  return `<a href="${escapeHtml(r.url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${escapeHtml(r.url)}</a>`;
}

function renderTag(n: Extract<Node, { type: 'tag' }>, ctx: Ctx): string {
  if (!n.closeRaw && n.name !== '*') return literal(n, ctx);
  const inner = () => renderNodes(n.children, ctx, false);
  const name = n.name;
  if (SIMPLE.has(name)) {
    const tag = { b: 'strong', i: 'em', u: 'u', s: 's' }[name as 'b'];
    return `<${tag}>${inner()}</${tag}>`;
  }
  switch (name) {
    case 'h': return `<h3 class="bb-h">${inner()}</h3>`;
    case 'center': return `<div class="bb-center">${renderNodes(n.children, ctx, true)}</div>`;
    case 'color': {
      const c = (n.arg ?? '').toLowerCase().trim();
      if (!(COLORS as readonly string[]).includes(c)) return inner();
      return `<span class="bb-c-${c}">${inner()}</span>`;
    }
    case 'url': {
      const target = n.arg ?? textOf(n.children);
      const href = safeHref(target);
      if (!href) return literal(n, ctx);
      const label = n.arg ? renderNodes(n.children, { ...ctx, inLink: true, embeds: false }, false) : escapeHtml(textOf(n.children));
      const ext = !href.startsWith('/');
      return `<a href="${escapeHtml(href)}"${ext ? ' rel="nofollow noopener noreferrer ugc" target="_blank"' : ''}>${label}</a>`;
    }
    case 'img': {
      const s = textOf(n.children).trim();
      const internal = /^\/media\/[A-Za-z0-9_\-/.]+$/.test(s);
      const u = internal ? s : safeUrl(s)?.toString();
      if (!u || !ctx.images || (!internal && !u.startsWith('https://'))) return literal(n, ctx);
      return `<img class="bb-img" src="${escapeHtml(u)}" alt="Posted image" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    }
    case 'media': case 'video': case 'youtube': {
      const s = textOf(n.children).trim();
      const r = resolveMedia(s);
      if (!r) return literal(n, ctx);
      return ctx.embeds ? mediaEmbedHtml(r) : linkCardHtml(r);
    }
    case 'code': return `<pre class="bb-code"><code>${escapeHtml(textOf(n.children).replace(/^\n/, ''))}</code></pre>`;
    case 'noparse': return escapeHtml(textOf(n.children)).replace(/\n/g, '<br>');
    case 'quote': {
      if (ctx.quoteDepth >= MAX_QUOTE_DEPTH) return `<blockquote class="bb-quote bb-quote-collapsed">[…]</blockquote>`;
      let head = '';
      if (n.arg) {
        const m = new RegExp(`^\\s*"?(${USERNAME_RE_SRC})"?\\s*(?:;\\s*(\\d{1,10}))?\\s*$`).exec(n.arg);
        if (m) {
          head = `<div class="bb-quote-head"><a class="username" href="${ctx.mentionBase}${encodeURIComponent(m[1])}">${escapeHtml(m[1])}</a> posted:`
            + (m[2] ? ` <a class="bb-quote-jump" href="/p/${m[2]}" aria-label="View quoted post">&#8593;</a>` : '') + '</div>';
        } else head = `<div class="bb-quote-head">${escapeHtml(n.arg.slice(0, 60))}:</div>`;
      }
      const body = renderNodes(n.children, { ...ctx, quoteDepth: ctx.quoteDepth + 1 }, true);
      return `<blockquote class="bb-quote">${head}<div class="bb-quote-body">${trimBr(body)}</div></blockquote>`;
    }
    case 'spoiler': {
      const label = n.arg ? escapeHtml(n.arg.slice(0, 60)) : 'Spoiler';
      const body = renderNodes(n.children, ctx, true);
      return `<details class="bb-spoiler"><summary>${label} <span class="bb-spoiler-hint">(click to reveal)</span></summary><div class="bb-spoiler-body">${trimBr(body)}</div></details>`;
    }
    case 'list': {
      const ordered = n.arg === '1';
      const items = n.children.filter((c): c is Extract<Node, { type: 'tag' }> => c.type === 'tag' && c.name === '*');
      if (!items.length) return literal(n, ctx);
      const lis = items.map((li) => `<li>${trimBr(renderNodes(li.children, ctx, false))}</li>`).join('');
      return ordered ? `<ol class="bb-list">${lis}</ol>` : `<ul class="bb-list">${lis}</ul>`;
    }
    case '*': return renderNodes(n.children, ctx, false);
  }
  return literal(n, ctx);
}

function trimBr(s: string) { return s.replace(/^(<br>)+|(<br>)+$/g, ''); }

const INLINE_RE = new RegExp(String.raw`(https?:\/\/[^\s<>"'\[\]]+)|(?<![\w@])@(${USERNAME_RE_SRC})|:([a-z0-9_]{2,32}):`, 'gi');

function renderText(text: string, ctx: Ctx, blockLevel: boolean): string {
  const lines = text.split('\n');
  return lines.map((line) => {
    // A media URL alone on its own line becomes an embed (block-level contexts only)
    if (blockLevel && ctx.embeds) {
      const lm = ytLine.exec(line);
      if (lm) {
        const r = resolveMedia(trimUrlPunctuation(lm[1]));
        if (r?.embedUrl) return mediaEmbedHtml(r);
      }
    }
    return renderInline(line, ctx);
  }).join('<br>');
}

function renderInline(s: string, ctx: Ctx): string {
  let out = '';
  let pos = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const f = ctx.filterText ?? ((x: string) => x);
  while ((m = INLINE_RE.exec(s))) {
    out += escapeHtml(f(s.slice(pos, m.index)));
    pos = m.index + m[0].length;
    if ((m[1] || m[2]) && ctx.inLink) { out += escapeHtml(f(m[0])); continue; }
    if (m[1]) {
      const urlStr = trimUrlPunctuation(m[1]);
      pos = m.index + urlStr.length;
      const u = safeUrl(urlStr);
      if (!u) { out += escapeHtml(urlStr); continue; }
      const r = resolveMedia(urlStr)!;
      out += r.kind === 'file' ? linkCardHtml(r) : `<a href="${escapeHtml(u.toString())}" rel="nofollow noopener noreferrer ugc" target="_blank">${escapeHtml(f(urlStr))}</a>`;
    } else if (m[2]) {
      out += `<a class="mention username" href="${ctx.mentionBase}${encodeURIComponent(m[2])}">@${escapeHtml(m[2])}</a>`;
    } else if (m[3]) {
      const url = ctx.emoji?.get(m[3].toLowerCase());
      out += url
        ? `<img class="emoji" src="${escapeHtml(url)}" alt=":${escapeHtml(m[3])}:" title=":${escapeHtml(m[3])}:" loading="lazy" width="22" height="22">`
        : escapeHtml(f(m[0]));
    }
  }
  out += escapeHtml(f(s.slice(pos)));
  return out;
}

/** Structured facts about a post body (for notifications, attachments, achievements). */
export function analyse(src: string): { mentions: string[]; quotedPostIds: number[]; emoji: string[]; mediaUrls: string[] } {
  const mentions = new Set<string>();
  const quoted = new Set<number>();
  const emoji = new Set<string>();
  const media = new Set<string>();
  const walk = (nodes: Node[], inQuote: boolean) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        if (inQuote) continue;
        for (const m of n.text.matchAll(INLINE_RE)) {
          if (m[2]) mentions.add(m[2].toLowerCase());
          if (m[3]) emoji.add(m[3].toLowerCase());
          if (m[1]) { const r = resolveMedia(trimUrlPunctuation(m[1])); if (r?.embedUrl) media.add(r.url); }
        }
      } else if (n.name === 'quote') {
        const qm = /;\s*(\d{1,10})\s*$/.exec(n.arg ?? '');
        if (qm && !inQuote) quoted.add(parseInt(qm[1], 10));
        walk(n.children, true);
      } else if (n.name === 'code' || n.name === 'noparse') continue;
      else walk(n.children, inQuote);
    }
  };
  walk(parse(normaliseNewlines(src)), false);
  return { mentions: [...mentions].slice(0, 20), quotedPostIds: [...quoted].slice(0, 20), emoji: [...emoji], mediaUrls: [...media] };
}

/**
 * Plain-text excerpt for previews, notifications and search results.
 * Spoiler content is never included; quotes are dropped; media/images become placeholders.
 */
export function excerpt(src: string, max = 160): string {
  const parts: string[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 'text') parts.push(n.text);
      else if (n.name === 'spoiler') parts.push(' [spoiler] ');
      else if (n.name === 'quote') parts.push(' ');
      else if (n.name === 'img') parts.push(' [image] ');
      else if (n.name === 'media' || n.name === 'video' || n.name === 'youtube') parts.push(' [media] ');
      else if (n.name === 'code') parts.push(' [code] ');
      else walk(n.children);
    }
  };
  walk(parse(normaliseNewlines(src)));
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Build a quote block for replying to a post. Strips nested quotes to keep replies short. */
export function quoteFor(username: string, postId: number, body: string): string {
  const stripped = body.replace(/\[quote(?:=[^\]]*)?\][\s\S]*?\[\/quote\]/gi, '').trim();
  return `[quote=${username};${postId}]${stripped}[/quote]\n`;
}
