import { defineModule } from '../../src/sdk/index.ts';
import { providers } from './providers.ts';

/**
 * Recognises YouTube, Vimeo and Spotify links in posts, messages and profiles and shows a click-to-load player.
 * Without this module those links still work — they are shown as ordinary external links.
 */
export default defineModule({
  id: 'media-embeds',
  name: 'Media embeds',
  version: '1.0.0',
  description: 'Click-to-load players for YouTube, Vimeo and Spotify links.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  setup(ctx) {
    for (const p of providers) ctx.register.mediaProvider(p);
  },
});
