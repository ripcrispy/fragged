import { defineModule } from '../../src/sdk/index.ts';

/**
 * Five nostalgic themes. Each evokes an era or scene with original styling only — no logos, product names,
 * wallpapers or other trade dress from the things that inspired them.
 */
export default defineModule({
  id: 'retro-themes',
  name: 'Retro themes',
  version: '1.0.1',
  description: 'Five nostalgic themes: Millennium Desktop, Cartridge, Arcade Blue, LAN Party and Bulletin ’06.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  assets: 'public',
  setup(ctx) {
    const sheet = 'retro.css';
    ctx.register.theme({ id: 'millennium', name: 'Millennium Desktop', scheme: 'light', stylesheet: sheet,
      description: 'Early-2000s desktop: glossy blue title bars, cream window panels and a big green go button.' });
    ctx.register.theme({ id: 'cartridge', name: 'Cartridge', scheme: 'dark', stylesheet: sheet,
      description: 'Late-90s 3D console: charcoal plastic, chunky rounded shapes and four primary-colour accents.' });
    ctx.register.theme({ id: 'arcade', name: 'Arcade Blue', scheme: 'dark', stylesheet: sheet,
      description: '16-bit attitude: deep cobalt, chrome buttons, speed lines and bold italic headlines.' });
    ctx.register.theme({ id: 'lanparty', name: 'LAN Party', scheme: 'dark', stylesheet: sheet,
      description: '3 a.m. in a dark hall: CRT scanlines, phosphor green and neon cable glow.' });
    ctx.register.theme({ id: 'bulletin', name: 'Bulletin ’06', scheme: 'light', stylesheet: sheet,
      description: 'Mid-2000s gaming forum: glossy navy headers, brushed-metal banner and tiny, dense text.' });
  },
});
