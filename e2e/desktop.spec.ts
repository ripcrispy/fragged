import { test, expect } from '@playwright/test';
import { login, userPage, waitForRealtime } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test('guest sees the forum index and a sign-in prompt for posting', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.forum-table')).toBeVisible();
  await expect(page.locator('.cat-name').first()).toHaveText('General Discussion');
  await page.goto('/f/general-chat/new');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
});

test('registration validates and checks username availability live', async ({ page }) => {
  await page.goto('/register');
  await page.fill('#f-username', 'PixelWren');
  await expect(page.locator('.username-status')).toContainText('already taken');
  await page.fill('#f-username', 'BrandNewPerson');
  await expect(page.locator('.username-status')).toContainText('available');
  await page.fill('#f-email', 'brand.new@example.test');
  await page.fill('#f-password', 'short');
  await page.fill('#f-confirm', 'short');
  await page.click('main form button.btn-primary');
  await expect(page.locator('.field-error').first()).toBeVisible();
});

test('friends pane → dock: one window per conversation, live delivery, history kept after close', async ({ browser }) => {
  const wren = await userPage(browser, 'PixelWren');
  const bit = await userPage(browser, 'bitcrusher');
  await wren.page.goto('/');
  await bit.page.goto('/');
  await waitForRealtime(bit.page);
  const dmButton = wren.page.locator('[data-open-dm][data-dm-name="bitcrusher"]');
  await dmButton.click();
  await expect(wren.page.locator('.dm-window')).toHaveCount(1);
  await dmButton.click();
  await expect(wren.page.locator('.dm-window')).toHaveCount(1);
  const text = `hello from e2e ${Date.now()}`;
  await wren.page.locator('.dm-window textarea').fill(text);
  await wren.page.keyboard.press('Enter');
  await expect(wren.page.locator('.dm-window .msg.mine').last()).toContainText(text);
  // receiver: window appears (minimised) with unread badge, without reloading
  await expect(bit.page.locator('.dm-window .dm-unread')).toHaveText('1', { timeout: 10_000 });
  await bit.page.locator('.dm-window .dm-toggle').click();
  await expect(bit.page.locator('.dm-window .msg.theirs').last()).toContainText(text);
  // closing removes the window only
  await wren.page.locator('.dm-window .dm-close').click();
  await expect(wren.page.locator('.dm-window')).toHaveCount(0);
  await wren.page.goto('/messages');
  await wren.page.locator('.conv-link', { hasText: 'bitcrusher' }).click();
  await expect(wren.page.locator('[data-msg-history]')).toContainText(text);
  await wren.ctx.close(); await bit.ctx.close();
});

test('accepting a friend request updates the other member’s pane live', async ({ browser }) => {
  const grav = await userPage(browser, 'gravwell');
  await grav.page.goto('/');
  await waitForRealtime(grav.page);
  await expect(grav.page.locator('[data-pane-friends]')).not.toContainText('PixelWren');
  const wren = await userPage(browser, 'PixelWren');
  await wren.page.goto('/friends');
  await wren.page.locator('.request-list li', { hasText: 'gravwell' }).getByRole('button', { name: 'Accept' }).click();
  await expect(grav.page.locator('[data-pane-friends]')).toContainText('PixelWren', { timeout: 10_000 });
  await wren.ctx.close(); await grav.ctx.close();
});

test('emoji picker is fully keyboard operable', async ({ page }) => {
  await login(page, 'quietkeys');
  await page.goto('/t/2');
  const textarea = page.locator('#qr-body');
  await textarea.fill('nice ');
  const toggle = page.locator('#quick-reply [data-emoji-toggle]');
  await toggle.focus();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Emoji picker' });
  await expect(picker).toBeVisible();
  await expect(page.locator('#ep-search')).toBeFocused();
  await page.keyboard.type('good game');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(textarea).toHaveValue(/:gg:/);
  await expect(picker).toHaveCount(0);
  await toggle.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test('spoiler-labelled thread is hidden until the reader opts in', async ({ page }) => {
  await page.goto('/t/5');
  const gate = page.locator('details.cw-gate').first();
  await expect(gate).toBeVisible();
  await expect(page.locator('.postlist')).toBeHidden();
  await gate.locator(':scope > summary').click();
  await expect(page.locator('.postlist')).toBeVisible();
  // inline [spoiler] blocks stay closed even after the gate opens
  await expect(page.locator('details.bb-spoiler').first()).not.toHaveAttribute('open', '');
});

test('video embeds load only after a click and use the privacy-enhanced host', async ({ page }) => {
  await page.goto('/t/6');
  const embed = page.locator('.embed-video').first();
  await expect(embed.locator('iframe')).toHaveCount(0);
  await expect(embed.locator('.embed-fallback')).toHaveAttribute('href', /youtube\.com\/watch/);
  await embed.locator('.embed-load').click();
  await expect(embed.locator('iframe')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ/);
});

test('quick reply with preview posts a reply', async ({ page }) => {
  await login(page, 'Lowpoly_Lou');
  await page.goto('/t/8');
  await page.locator('#qr-body').fill('[b]My desk[/b] is mostly frogs.');
  await page.locator('#quick-reply [data-preview-toggle]').click();
  await expect(page.locator('#quick-reply [data-ed-preview] strong')).toHaveText('My desk');
  await page.locator('#quick-reply [data-preview-toggle]').click();
  await page.locator('#quick-reply button.btn-primary').click();
  await expect(page.locator('.post').last()).toContainText('is mostly frogs');
});

test('reaction picker opens fully visible and adds a reaction', async ({ page }) => {
  await login(page, 'Marrow');
  await page.goto('/t/4');
  const post = page.locator('.post').first();
  await post.locator('.react-menu summary').click();
  const creative = post.locator('.react-panel .react-btn', { hasText: 'Creative' });
  await expect(creative).toBeVisible();
  // the button must be the top-most element at its position (not clipped by the post box)
  expect(await creative.evaluate((btn) => { const r = btn.getBoundingClientRect(); return btn.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
  await creative.click();
  await expect(post.locator('.reactions')).toContainText('Creative');
});

test('theme preference applies everywhere', async ({ page }) => {
  await login(page, 'NullSector');
  await page.goto('/settings/preferences');
  await page.check('input[value="frag"]');
  await page.locator('main form button.btn-primary').click();
  await page.goto('/forums');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'frag');
});

test('blocking from the message window disables the composer for both sides', async ({ browser }) => {
  const marrow = await userPage(browser, 'Marrow');
  const bit = await userPage(browser, 'bitcrusher');
  await bit.page.goto('/');
  await waitForRealtime(bit.page);
  await marrow.page.goto('/');
  await marrow.page.locator('[data-open-dm][data-dm-name="bitcrusher"]').click();
  await expect(marrow.page.locator('.dm-window .dm-composer')).toBeVisible();
  marrow.page.once('dialog', (d) => d.accept());
  await marrow.page.locator('.dm-window .dm-menu summary').click();
  await marrow.page.locator('.dm-window [data-dm-block]').click();
  await expect(marrow.page.locator('.dm-window .dm-composer')).toBeHidden();
  await expect(marrow.page.locator('.dm-window .dm-notice')).toContainText('blocked');
  // the blocked member's full conversation view keeps history but refuses to send
  const pid = await marrow.page.locator('.dm-window').getAttribute('data-pid');
  await bit.page.goto(`/messages/${pid}`);
  await expect(bit.page.locator('.conv-view')).toBeVisible();
  await expect(bit.page.locator('[data-msg-composer]')).toHaveCount(0);
  await expect(bit.page.locator('.conv-view .notice')).toContainText('cannot message');
  await marrow.ctx.close(); await bit.ctx.close();
});
