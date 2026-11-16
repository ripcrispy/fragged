import { test, expect } from '@playwright/test';
import { login } from './helpers.ts';

test('mobile: hamburger navigation, friends drawer and full-screen messages', async ({ page }) => {
  await login(page, 'PixelWren');
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const nav = page.locator('#nav-links');
  await expect(nav).toBeHidden();
  await page.locator('[data-nav-toggle]').click();
  await expect(nav).toBeVisible();
  await page.locator('[data-nav-toggle]').click();
  // friends pane is a drawer, closed by default, Escape closes it
  const pane = page.locator('[data-friends-pane]');
  await expect(pane).toBeHidden();
  await page.locator('.navbar .pane-toggle').click();
  await expect(pane).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  // DM opens the full-screen conversation route instead of the dock
  await page.locator('.navbar .pane-toggle').click();
  await page.locator('[data-open-dm][data-dm-name="Lowpoly_Lou"]').click();
  await expect(page).toHaveURL(/\/messages\/[A-Za-z0-9]+$/);
  await expect(page.locator('[data-msg-composer]')).toBeVisible();
});
