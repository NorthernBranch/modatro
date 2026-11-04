import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light', 'balatro', 'balatro-dark']) {
  test(`${theme} pages have accessible contrast, names and keyboard controls`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    for (const name of ['Discover', 'Installed', 'Prerequisites', 'Settings']) {
      await page.getByRole('button', { name, exact: true }).click();
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        result.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            summary: node.failureSummary,
          })),
        })),
      ).toEqual([]);
    }
    await expect(page.getByRole('button', { name: /^Version / })).toHaveCSS('text-shadow', 'none');
    const storage = page.locator('summary').filter({ hasText: 'Storage and recovery copies' });
    await storage.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Storage controls are available in the desktop app.'),
    ).toBeVisible();
    await expect(storage).toHaveCSS('outline-style', 'solid');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/${theme}-accessible-settings.png`,
      fullPage: true,
    });
  });
}
