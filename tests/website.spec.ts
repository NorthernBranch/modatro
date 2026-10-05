import { expect, test } from '@playwright/test';

const base = 'https://github.com/NorthernBranch/modatro/releases';
const tag = 'v0.3.2-beta.build.13.bb583ba';
const release = {
  tag_name: tag,
  published_at: '2026-10-02T15:08:56Z',
  draft: false,
  prerelease: true,
  html_url: `${base}/tag/${tag}`,
  assets: [
    'Modatro-Setup-0.3.2.exe',
    'Modatro-0.3.2-arm64.dmg',
    'Modatro-0.3.2-x64.dmg',
    'Modatro-0.3.2-x86_64.AppImage',
    'Modatro-0.3.2-amd64.deb',
  ].map((name) => ({
    name,
    size: 100,
    browser_download_url: `${base}/download/${tag}/${name}`,
  })),
};

test('the landing page offers exact platform downloads and stays usable on mobile', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(
    'https://api.github.com/repos/NorthernBranch/modatro/releases?per_page=100',
    (route) => route.fulfill({ json: [release] }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make Balatro your own.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /All downloads and release notes/ })).toHaveAttribute(
    'href',
    base,
  );
  for (const [platform, asset] of [
    ['windows', 'Modatro-Setup-0.3.2.exe'],
    ['mac-arm64', 'Modatro-0.3.2-arm64.dmg'],
    ['mac-x64', 'Modatro-0.3.2-x64.dmg'],
    ['linux', 'Modatro-0.3.2-x86_64.AppImage'],
    ['linux-deb', 'Modatro-0.3.2-amd64.deb'],
  ] as const) {
    await page.getByLabel('Download for', { exact: true }).selectOption(platform);
    await expect(page.locator('#download')).toHaveAttribute(
      'href',
      `${base}/download/${tag}/${asset}`,
    );
  }
  await page.getByLabel('Download for', { exact: true }).selectOption('mac');
  await expect(page.getByRole('status')).toContainText('Choose Apple silicon or Intel');
  await expect(page.locator('#download')).toHaveAttribute('href', release.html_url);
  await page.screenshot({ path: 'test-results/website-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#download')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/website-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('failed release lookups and disabled JavaScript keep the releases link working', async ({
  page,
  browser,
}) => {
  await page.route(
    'https://api.github.com/repos/NorthernBranch/modatro/releases?per_page=100',
    (route) => route.fulfill({ status: 403, json: { message: 'Rate limit exceeded' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Downloads are available on GitHub');
  await expect(page.locator('#download')).toHaveAttribute('href', base);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const plain = await context.newPage();
    await plain.goto('http://127.0.0.1:5174');
    await expect(
      plain.getByRole('link', { name: 'Download Modatro', exact: true }),
    ).toHaveAttribute('href', base);
    await expect(
      plain.getByRole('link', { name: /All downloads and release notes/ }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
