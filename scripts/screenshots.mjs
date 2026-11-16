// Visual QA helper: node scripts/screenshots.mjs <outDir>  (dev server running on :3000, seeded)
const PW = process.env.DEMO_PASSWORD ?? 'fragged-demo-pass';
// Env: THEMES=classic,dark  PAGES=/,/t/2  MOBILE=1  FULL=1
import { chromium } from 'playwright';
const out = process.argv[2] ?? 'data/shots';
const base = process.env.BASE ?? 'http://localhost:3000';
const browser = await chromium.launch();
const errors = [];
async function session(viewport, theme) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme} ${page.url()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${theme} ${page.url()}: ${e.message}`));
  await page.goto(base + '/login');
  await page.fill('#lp-login', process.env.LOGIN ?? 'PixelWren'); await page.fill('#lp-pw', PW);
  await Promise.all([page.waitForNavigation(), page.click('.login-panel button.btn-primary')]);
  await page.goto(base + '/settings/preferences'); await page.check(`input[value="${theme}"]`);
  await Promise.all([page.waitForNavigation(), page.click('main form button.btn-primary')]);
  return { ctx, page };
}
const pages = (process.env.PAGES ?? '/,/f/general-chat,/t/2,/u/PixelWren,/messages').split(',');
for (const theme of (process.env.THEMES ?? 'classic').split(',')) {
  const vp = process.env.MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const { ctx, page } = await session(vp, theme);
  for (const p of pages) {
    await page.goto(base + p);
    await page.waitForTimeout(500);
    const name = `${theme}${process.env.MOBILE ? '-m' : ''}${p.replace(/[^a-z0-9]+/gi, '_')}.png`;
    await page.screenshot({ path: `${out}/${name}`, fullPage: !!process.env.FULL });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) errors.push(`horizontal overflow: ${theme} ${p}`);
  }
  await ctx.close();
}
// leave the shared dev account's theme as we found it (classic)
{ const ctx = await browser.newContext(); const rp = await ctx.newPage();
  await rp.goto(base + '/login'); await rp.fill('#lp-login', process.env.LOGIN ?? 'PixelWren'); await rp.fill('#lp-pw', PW);
  await Promise.all([rp.waitForNavigation(), rp.click('.login-panel button.btn-primary')]);
  await rp.goto(base + '/settings/preferences'); await rp.check('input[value="classic"]');
  await Promise.all([rp.waitForNavigation(), rp.click('main form button.btn-primary')]); await ctx.close(); }
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors / overflow');
