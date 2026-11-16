// Two app instances, one database: verifies cross-instance messaging, presence, rate limits and cache invalidation.
const PW = process.env.DEMO_PASSWORD ?? 'fragged-demo-pass';
// Instances must already be running on :3401 and :3402 (see docs/DEPLOYMENT.md "Running several instances").
import { chromium } from 'playwright';
const A = 'http://localhost:3401', B = 'http://localhost:3402';
const b = await chromium.launch();
const results = {};
async function login(base, name) {
  const p = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await p.goto(base + '/login'); await p.fill('#lp-login', name); await p.fill('#lp-pw', PW);
  await Promise.all([p.waitForNavigation(), p.click('.login-panel button.btn-primary')]);
  return p;
}
// 1) messaging + presence across instances
const wren = await login(A, 'gravwell');           // on instance A
await wren.goto(A + '/'); await wren.waitForTimeout(1500);
const bit = await login(B, 'NullSector');           // on instance B
await bit.goto(B + '/'); await bit.waitForTimeout(1500);
results.presenceSeenFromOtherInstance = await bit.locator('[data-pane-friends] li[data-username="gravwell"] .presence').getAttribute('class');
await bit.locator('[data-open-dm][data-dm-name="gravwell"]').click();
const text = 'cross-instance hello ' + Date.now();
await bit.locator('.dm-window textarea').fill(text); await bit.keyboard.press('Enter');
await wren.locator('.dm-window .dm-unread').filter({ hasText: /\d/ }).waitFor({ timeout: 10000 });
await wren.locator('.dm-window .dm-toggle').click();
results.messageDeliveredAcrossInstances = (await wren.locator('.dm-window .msg.theirs').last().innerText()).includes(text);
// 2) presence change propagates: wren leaves → bitcrusher's view (other instance) updates without reload
await wren.context().close();
await bit.waitForFunction(() => document.querySelector('[data-pane-friends] li[data-username="gravwell"] .presence')?.classList.contains('presence-offline'), null, { timeout: 15000 });
results.offlinePropagated = true;
// 3) admin setting changed on A is visible on B immediately
const admin = await login(A, 'Overseer');
await admin.goto(A + '/admin/settings');
const banner = 'Cluster banner ' + Date.now();
await admin.fill('#f-announcement', banner);
await Promise.all([admin.waitForNavigation(), admin.click('main form button.btn-primary')]);
await bit.goto(B + '/');
results.settingVisibleOnOtherInstance = (await bit.locator('.announcement').innerText().catch(() => '')).includes(banner);
await admin.goto(A + '/admin/settings'); await admin.fill('#f-announcement', '');
await Promise.all([admin.waitForNavigation(), admin.click('main form button.btn-primary')]);
// 4) shared rate limit (last: it deliberately trips the per-IP login limit): failed logins alternate between instances
const g = await (await b.newContext()).newPage();
let statuses = [];
for (let i = 0; i < 10; i++) {
  const base = i % 2 ? B : A;
  await g.goto(base + '/login');
  const r = await Promise.all([g.waitForResponse((res) => res.url().endsWith('/login') && res.request().method() === 'POST'), (async () => { await g.fill('#lp-login', 'cluster-nobody'); await g.fill('#lp-pw', 'wrong password ' + i); await g.click('.login-panel button.btn-primary'); })()]);
  statuses.push(r[0].status());
}
results.loginStatuses = statuses.join(',');
console.log(JSON.stringify(results, null, 2));
await b.close();
