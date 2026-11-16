import type { Browser, Page } from '@playwright/test';

export const PASSWORD = process.env.DEMO_PASSWORD ?? 'fragged-demo-pass';

export async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#lp-login', username);
  await page.fill('#lp-pw', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('.login-panel button.btn-primary')]);
}

export async function userPage(browser: Browser, username: string, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await login(page, username);
  return { ctx, page };
}

/** Wait until the page's SSE stream has said hello (real-time connected). */
export async function waitForRealtime(page: Page) {
  await page.waitForFunction(() => !document.body.classList.contains('rt-offline'));
  await page.waitForTimeout(600);
}
