import { registries } from '../src/modules/registry.ts';
import { providers as mediaProviders } from '../modules/media-embeds/providers.ts';
for (const p of mediaProviders) registries.mediaProviders.add('core', p);
import { describe, it, expect } from 'vitest';
import { render, excerpt, analyse, quoteFor } from '../src/lib/bbcode.ts';

describe('bbcode rendering', () => {
  it('escapes raw HTML', () => {
    const out = render('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });
  it('renders basic formatting', () => {
    expect(render('[b]bold[/b] [i]it[/i] [u]u[/u] [s]s[/s]')).toBe('<strong>bold</strong> <em>it</em> <u>u</u> <s>s</s>');
  });
  it('rejects javascript: and data: URLs', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x', 'vbscript:x', ' javascript:alert(1)', 'java\tscript:alert(1)']) {
      const out = render(`[url=${bad}]x[/url] [url]${bad}[/url] [img]${bad}[/img]`);
      expect(out).not.toMatch(/href="\s*(javascript|data|vbscript)/i);
      expect(out).not.toMatch(/src="\s*(javascript|data)/i);
    }
  });
  it('does not allow attribute breakout through URLs', () => {
    const out = render('[url=https://example.com/"onmouseover="alert(1)]x[/url]');
    expect(out).not.toContain('"onmouseover');
    const out2 = render('[img]https://example.com/a.png" onerror="alert(1)[/img]');
    expect(out2).not.toContain('" onerror="');
    expect(out2).not.toMatch(/<img[^>]*onerror/);
  });
  it('autolinks with rel attributes and no nested anchors', () => {
    const out = render('see https://example.com/page.');
    expect(out).toContain('href="https://example.com/page"');
    expect(out).toContain('rel="nofollow noopener noreferrer ugc"');
    const nested = render('[url=https://a.example]https://b.example[/url]');
    expect(nested.match(/<a /g)?.length).toBe(1);
  });
  it('renders code blocks verbatim without parsing tags', () => {
    const out = render('[code][b]x[/b] <tag>[/code]');
    expect(out).toBe('<pre class="bb-code"><code>[b]x[/b] &lt;tag&gt;</code></pre>');
  });
  it('treats unknown and unbalanced tags as text', () => {
    expect(render('[foo]x[/foo]')).toBe('[foo]x[/foo]');
    expect(render('[b]open')).toBe('[b]open');
    expect(render('close[/b]')).toBe('close[/b]');
  });
  it('maps colours to classes only', () => {
    expect(render('[color=red]r[/color]')).toBe('<span class="bb-c-red">r</span>');
    expect(render('[color=#ff0000;background:url(x)]r[/color]')).toBe('r');
  });
  it('renders quotes with attribution and post links', () => {
    const out = render('[quote=Alice;42]hello[/quote]');
    expect(out).toContain('href="/u/Alice"');
    expect(out).toContain('href="/p/42"');
    expect(out).toContain('hello');
  });
  it('limits quote nesting', () => {
    const deep = '[quote]'.repeat(8) + 'x' + '[/quote]'.repeat(8);
    expect(render(deep)).toContain('bb-quote-collapsed');
  });
  it('conceals spoilers behind details/summary', () => {
    const out = render('[spoiler]the ending[/spoiler]');
    expect(out).toMatch(/^<details class="bb-spoiler"><summary>/);
    expect(out).not.toMatch(/<details[^>]*open/);
  });
  it('renders lists', () => {
    expect(render('[list][*]a[*]b[/list]')).toBe('<ul class="bb-list"><li>a</li><li>b</li></ul>');
    expect(render('[list=1][*]a[/list]')).toBe('<ol class="bb-list"><li>a</li></ol>');
  });
  it('embeds YouTube URLs on their own line as click-to-load', () => {
    const out = render('look:\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42\nnice');
    expect(out).toContain('data-embed="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42"');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('embed-fallback');
  });
  it('renders [media] for supported providers and falls back to link otherwise', () => {
    expect(render('[media]https://youtu.be/dQw4w9WgXcQ[/media]')).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    const other = render('[media]https://evil.example/embed.html[/media]');
    expect(other).not.toContain('data-embed');
    expect(other).toContain('href="https://evil.example/embed.html"');
  });
  it('renders approved emoji only', () => {
    const emoji = new Map([['wave', '/media/emoji/wave.gif']]);
    expect(render(':wave: :nope:', { emoji })).toBe('<img class="emoji" src="/media/emoji/wave.gif" alt=":wave:" title=":wave:" loading="lazy" width="22" height="22"> :nope:');
  });
  it('links mentions', () => {
    expect(render('hi @Some_User!')).toContain('<a class="mention username" href="/u/Some_User">@Some_User</a>');
    expect(render('mail a@b.example')).not.toContain('mention');
  });
  it('applies the text filter to text but not markup', () => {
    const out = render('[b]darn it[/b]', { filterText: (s) => s.replace(/darn/g, '****') });
    expect(out).toBe('<strong>**** it</strong>');
  });
  it('handles pathological input quickly', () => {
    const t = Date.now();
    render('[b]'.repeat(5000) + '[url=' + 'a'.repeat(10000));
    render('[quote]'.repeat(3000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('excerpts and analysis', () => {
  it('never includes spoiler text in excerpts', () => {
    const e = excerpt('Intro [spoiler]secret ending[/spoiler] outro [quote=Bob]q[/quote]');
    expect(e).not.toContain('secret');
    expect(e).toContain('[spoiler]');
    expect(e).not.toContain('q outro');
  });
  it('finds mentions and quoted posts outside quotes only', () => {
    const a = analyse('@alice hi [quote=Bob;12]@carol[/quote] :smile:');
    expect(a.mentions).toEqual(['alice']);
    expect(a.quotedPostIds).toEqual([12]);
    expect(a.emoji).toEqual(['smile']);
  });
  it('builds quotes stripping nested quotes', () => {
    expect(quoteFor('Bob', 5, '[quote=A]old[/quote]new')).toBe('[quote=Bob;5]new[/quote]\n');
  });
});
