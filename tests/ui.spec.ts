import { expect, test } from '@playwright/test';
test('discover supports search, categories, details, navigation and themes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
  await expect(page.getByText('Read-only preview')).toBeVisible();
  await expect(page.locator('.mod-card')).toHaveCount(12);
  await page.getByRole('searchbox', { name: 'Search mods' }).fill('Steamodded');
  await expect(page.locator('.mod-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Details for Steamodded' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What you’ll need' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Quality of Life', exact: true }).click();
  await expect(page.locator('.mod-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.mod-list')).toBeVisible();
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A fresh deck. Endless possibilities.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lovely', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});
test('keyboard shortcuts and dialogs preserve focus', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill('Cryptid');
  const trigger = page.getByRole('button', { name: 'Details for Cryptid', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect
    .poll(async () => page.evaluate(() => !!document.activeElement?.closest('dialog')))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
test('preview never simulates a successful install and renders at narrow widths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await page.goto('/');
  await page
    .locator('.mod-card')
    .first()
    .getByRole('button', { name: 'Install', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Open the desktop app to install');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('capture desktop UI for visual review', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.mod-card')).toHaveCount(12);
  await page.screenshot({ path: 'test-results/discover.png', fullPage: true });
});
