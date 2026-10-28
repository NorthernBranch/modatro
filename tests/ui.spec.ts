import { expect, test } from '@playwright/test';
test('the startup theme is applied before the renderer entry runs', async ({ page }) => {
  await page.addInitScript(() => {
    window.modatro = { initialTheme: 'balatro' } as never;
  });
  await page.route('**/src/main.tsx', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'balatro');
  await expect(page.locator('#root')).toBeEmpty();
});

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
  await page.getByLabel('Theme', { exact: true }).selectOption('balatro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'balatro');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'balatro');
  await page.getByLabel('Theme', { exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});

test('Balatro theme stays readable and contained across pages, dialogs and narrow layouts', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('balatro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'balatro');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('700 20px "Modatro Pixel"'))).toBe(true);
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await page.screenshot({ path: 'test-results/balatro-discover.png', fullPage: true });
  const trigger = page.getByRole('button', { name: 'Details for Steamodded' });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: 'test-results/balatro-dialog.png' });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  for (const width of [1320, 650, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Discover', 'Prerequisites', 'Settings']) {
      await page.getByRole('button', { name, exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
  await page.screenshot({ path: 'test-results/balatro-settings-mobile.png', fullPage: true });
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});
test('long navigation labels shrink to fit, including the active marker and loaded pixel font', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('balatro');
  await page.evaluate(() => document.fonts.ready);
  const target = page.getByRole('button', { name: 'Troubleshooting', exact: true });
  await target.click();
  await expect(target).toHaveAttribute('aria-current', 'page');
  await expect
    .poll(() =>
      target.locator('.nav-label').evaluate((label) => {
        const text = label.firstElementChild!;
        return text.getBoundingClientRect().width <= label.clientWidth;
      }),
    )
    .toBe(true);
  const size = await target.locator('.nav-label').evaluate((label) => ({
    normal: parseFloat(getComputedStyle(label).fontSize),
    fitted: parseFloat(getComputedStyle(label.firstElementChild!).fontSize),
  }));
  expect(size.fitted).toBeLessThan(size.normal);
  expect(size.fitted).toBeGreaterThanOrEqual(10);
  const short = page.getByRole('button', { name: 'Discover', exact: true }).locator('.nav-label');
  expect(
    await short.evaluate(
      (label) =>
        getComputedStyle(label).fontSize === getComputedStyle(label.firstElementChild!).fontSize,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 650, height: 900 });
  await expect(target.locator('.nav-label')).toBeHidden();
  await page.setViewportSize({ width: 1320, height: 900 });
  await expect(target.locator('.nav-label')).toBeVisible();
  await expect
    .poll(() =>
      target
        .locator('.nav-label')
        .evaluate(
          (label) => label.firstElementChild!.getBoundingClientRect().width <= label.clientWidth,
        ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await target.click();
  await expect
    .poll(() =>
      target
        .locator('.nav-label')
        .evaluate(
          (label) => label.firstElementChild!.getBoundingClientRect().width <= label.clientWidth,
        ),
    )
    .toBe(true);
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
  await page.mouse.click(2, 2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
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
