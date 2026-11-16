// Interactive check of the friends pane → DM dock flow (dev server must be running, seeded).
const PW = process.env.DEMO_PASSWORD ?? 'fragged-demo-pass';
import { chromium } from 'playwright';
const out = process.argv[2] ?? 'data/shots';
const b = await chromium.launch();
const errs = [];
async function login(name) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
  await p.goto('http://localhost:3000/login');
  await p.fill('#lp-login', name); await p.fill('#lp-pw', PW);
  await Promise.all([p.waitForNavigation(), p.click('.login-panel button.btn-primary')]);
  return p;
}
const wren = await login('PixelWren');
const bit = await login('bitcrusher');
await wren.goto('http://localhost:3000/t/2');
await wren.click('[data-open-dm][data-dm-name="bitcrusher"]');
await wren.waitForSelector('.dm-window .dm-composer textarea');
await wren.click('[data-open-dm][data-dm-name="bitcrusher"]'); // second click must reuse, not duplicate
const windows = await wren.locator('.dm-window').count();
await wren.fill('.dm-window textarea', 'live test from the dock :gg:');
await wren.keyboard.press('Enter');
await wren.waitForSelector('.dm-window .msg.mine:not(.pending) >> text=live test');
await bit.goto('http://localhost:3000/');
await bit.waitForTimeout(800);
await wren.fill('.dm-window textarea', 'second live message');
await wren.keyboard.press('Enter');
await bit.waitForSelector('.dm-window .msg.theirs >> text=second live message', { timeout: 8000, state: 'attached' });
const badge = await bit.locator('.dm-window .dm-unread').innerText();
await bit.click('.dm-window .dm-toggle');
await bit.waitForTimeout(400);
await wren.screenshot({ path: out + '/dock-sender.png' });
await bit.screenshot({ path: out + '/dock-receiver.png' });
// closing a tab keeps history
await wren.click('.dm-window .dm-close');
await wren.goto('http://localhost:3000/messages');
const preview = await wren.locator('.conv-item').first().innerText();
console.log(JSON.stringify({ windows, badge, preview, errs }));
await b.close();
