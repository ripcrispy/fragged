# Theme pack

Adds three themes to **Settings › Preferences**: **Dark**, **Light** and **Frag** (gritty industrial arena: gunmetal
plates, hazard accents, bold type). The core ships **Classic** and **High Contrast**.

- **Permissions:** none · **Settings:** none · **Data:** none
- Members using a theme from this module fall back to the site default while the module is disabled.

## Making your own theme module

A theme is one stylesheet that sets design tokens under `[data-theme="<id>"]`:

```css
[data-theme="midnight"] { --bg: #0b0f1a; --surface: #131a2a; --text: #e6e9f2; --accent: #7aa2ff; /* … */ }
```

```ts
ctx.register.theme({ id: 'midnight', name: 'Midnight', scheme: 'dark', description: 'Deep blue.', stylesheet: 'midnight.css' });
```

See `public/themes.css` for the full token list. Run `node scripts/a11y-audit.mjs` with `THEMES=<id>` to check
contrast.
