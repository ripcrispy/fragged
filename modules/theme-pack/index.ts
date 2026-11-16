import { defineModule } from '../../src/sdk/index.ts';

/** Extra colour themes. Each one only redefines the core design tokens, so every page and module inherits it. */
export default defineModule({
  id: 'theme-pack',
  name: 'Theme pack',
  version: '1.0.0',
  description: 'Adds the Dark, Light and Frag themes.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.0.0',
  assets: 'public',
  setup(ctx) {
    ctx.register.theme({ id: 'dark', name: 'Dark', scheme: 'dark', description: 'Dark surfaces with soft contrast for night owls.', stylesheet: 'themes.css' });
    ctx.register.theme({ id: 'light', name: 'Light', scheme: 'light', description: 'Brighter, airier surfaces with the same traditional layout.', stylesheet: 'themes.css' });
    ctx.register.theme({ id: 'frag', name: 'Frag', scheme: 'dark', description: 'Gritty industrial arena: gunmetal plates, hazard accents and bold type.', stylesheet: 'themes.css' });
  },
});
