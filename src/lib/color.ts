/** WCAG contrast helpers used to keep user-chosen profile colours legible. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/**
 * Derive safe profile surface tokens from a user background colour.
 * Text is always black or white (whichever contrasts most) and must reach 4.5:1;
 * the panel surface is a tint of the background, also checked against the text.
 */
export function profilePalette(input: string): { bg: string; text: string; muted: string; panel: string; border: string; link: string } {
  const white = '#ffffff', black = '#111111';
  let bg = input;
  // nudge mid-tones until black or white text reaches 4.5:1
  for (let i = 0; i < 20 && Math.max(contrast(bg, white), contrast(bg, black)) < 4.5; i++) {
    bg = mix(bg, contrast(bg, white) >= contrast(bg, black) ? '#000000' : '#ffffff', 0.08);
  }
  const text = contrast(bg, white) >= contrast(bg, black) ? white : black;
  const dark = text === white;
  let panel = mix(bg, dark ? '#000000' : '#ffffff', 0.55);
  if (contrast(panel, text) < 7) panel = dark ? '#1a1a1a' : '#f7f7f7';
  return {
    bg,
    text,
    panel,
    muted: mix(text, panel, 0.35),
    border: mix(bg, dark ? '#ffffff' : '#000000', 0.25),
    link: dark ? '#9fd0ff' : '#0b4f8a',
  };
}

export const PROFILE_COLOR_PRESETS = ['#3b4a5c', '#2d4739', '#5a2e2e', '#4a3b5c', '#6b5b3e', '#1f3b57', '#7a7f87', '#c9d6df', '#e8dcc8', '#d8e8d0', '#e6d0dc', '#202124'];
