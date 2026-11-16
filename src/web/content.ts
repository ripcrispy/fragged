import { render, type RenderOptions } from '../lib/bbcode.ts';
import { textFilterFor } from '../services/policy.ts';
import { emojiMap } from '../services/emoji.ts';
import type { Viewer } from '../services/viewer.ts';

/** Build a renderer bound to the viewer's filter preferences (restricted terms always apply). */
export async function rendererFor(v: Viewer) {
  const filterText = await textFilterFor(v.settings.profanityFilter);
  const emoji = await emojiMap();
  return {
    post: (src: string, extra: RenderOptions = {}) => render(src, { filterText, emoji, embeds: true, images: true, ...extra }),
    signature: (src: string) => render(src, { filterText, emoji, embeds: false, images: false }),
    message: (src: string) => render(src, { filterText, emoji, embeds: true, images: false }),
    plain: (s: string) => filterText(s),
  };
}
