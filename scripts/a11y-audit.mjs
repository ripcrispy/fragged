// Accessibility audit with axe-core across key pages, as guest and signed in, for every theme.
const PW = process.env.DEMO_PASSWORD ?? 'fragged-demo-pass';
// node scripts/a11y-audit.mjs   (dev server running + seeded). Exits 1 on serious/critical violations.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const base = process.env.BASE ?? 'http://localhost:3000';
const themes = (process.env.THEMES ?? 'classic,dark,light,contrast,frag,millennium,cartridge,arcade,lanparty,bulletin').split(',');
const guestPages = ['/', '/forums', '/f/general-chat', '/t/2', '/login', '/register', '/rules', '/members', '/search?q=test', '/u/PixelWren', '/emoji', '/m/achievements', '/m/lan-intranet', '/m/lan-seating', '/m/lan-seating/frag-night-01', '/m/caffeine-tracker', '/m/lan-pizza'];
const userPages = ['/', '/t/2', '/t/5', '/u/PixelWren', '/messages', '/friends', '/notifications', '/settings', '/settings/preferences', '/settings/security', '/f/general-chat/new', '/t/2/reply', '/m/lan-intranet', '/m/lan-seating/frag-night-01', '/m/caffeine-tracker', '/m/lan-pizza', '/m/lan-event-access'];
const b = await chromium.launch();
const found = new Map();
async function audit(page, label) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of r.violations) {
    const k = `${v.id} [${v.impact}]`;
    const e = found.get(k) ?? { help: v.help, where: new Set(), nodes: new Set() };
    e.where.add(label); v.nodes.slice(0, 3).forEach((n) => e.nodes.add(n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n')[1]?.trim()));
    found.set(k, e);
  }
}
for (const theme of themes) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(base + '/login');
  await p.fill('#lp-login', 'PixelWren'); await p.fill('#lp-pw', PW);
  await Promise.all([p.waitForNavigation(), p.click('.login-panel button.btn-primary')]);
  await p.goto(base + '/settings/preferences'); await p.check(`input[value="${theme}"]`);
  await Promise.all([p.waitForNavigation(), p.click('main form button.btn-primary')]);
  for (const path of userPages) { await p.goto(base + path); await audit(p, `${theme} user ${path}`); }
  // an open conversation (header actions, history, composer)
  await p.goto(base + '/messages');
  const conv = await p.locator('.conv-link').first().getAttribute('href');
  if (conv) { await p.goto(base + conv); await audit(p, `${theme} user conversation`); }
  await ctx.close();
}
// leave the shared dev account's theme as we found it (classic)
{ const ctx = await b.newContext(); const rp = await ctx.newPage();
  await rp.goto(base + '/login'); await rp.fill('#lp-login', 'PixelWren'); await rp.fill('#lp-pw', PW);
  await Promise.all([rp.waitForNavigation(), rp.click('.login-panel button.btn-primary')]);
  await rp.goto(base + '/settings/preferences'); await rp.check('input[value="classic"]');
  await Promise.all([rp.waitForNavigation(), rp.click('main form button.btn-primary')]); await ctx.close(); }
const g = await (await b.newContext()).newPage();
for (const path of guestPages) { await g.goto(base + path); await audit(g, `guest ${path}`); }
// staff pages (as the administrator, in their current theme)
{ const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const ap = await ctx.newPage();
  await ap.goto(base + '/login'); await ap.fill('#lp-login', 'Overseer'); await ap.fill('#lp-pw', PW);
  await Promise.all([ap.waitForNavigation(), ap.click('.login-panel button.btn-primary')]);
  for (const path of ['/admin', '/admin/audit', '/admin/audit?category=config', '/admin/security', '/admin/security?category=signin', '/admin/settings', '/admin/terms', '/mod', '/mod/reports', '/admin/modules', '/admin/m/lan-seating/events', '/admin/m/lan-intranet/manage', '/admin/m/caffeine-tracker/drinks', '/admin/m/achievements/definitions', '/admin/m/lan-pizza/runs', '/admin/m/lan-pizza/runs/1', '/admin/m/lan-pizza/menu', '/admin/m/lan-event-access/desk', '/admin/m/lan-event-access/desk/approve?mac=02:4c:41:4e:00:02']) { await ap.goto(base + path); await audit(ap, `admin ${path}`); }
  await ctx.close(); }
await b.close();
let bad = 0;
for (const [k, e] of found) {
  if (/serious|critical/.test(k)) bad++;
  console.log(`\n${k}: ${e.help}\n  pages: ${[...e.where].slice(0, 6).join(', ')}${e.where.size > 6 ? ` (+${e.where.size - 6})` : ''}`);
  for (const n of [...e.nodes].slice(0, 4)) console.log('   - ' + n.slice(0, 220));
}
console.log(`\n${found.size} rule(s) violated, ${bad} serious/critical`);
process.exit(bad ? 1 : 0);
