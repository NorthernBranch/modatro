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
  const screenshot = page.getByRole('img', { name: /Modatro's Discover screen/ });
  await screenshot.scrollIntoViewIfNeeded();
  await expect
    .poll(() => screenshot.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1440);
  await page.screenshot({ path: 'test-results/website-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#download')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/website-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('desktop sections remain stacked and the screenshot stays within a compact frame', async ({
  page,
}) => {
  // Reproduce a browser still holding the stylesheet from before the preview
  // existed. The versioned URL must avoid this old asset entirely.
  const oldStyles = [] as string[];
  await page.route('**/style.css', (route) => {
    oldStyles.push(route.request().url());
    return route.fulfill({ contentType: 'text/css', body: 'main { display:flex; }' });
  });
  await page.route(
    'https://api.github.com/repos/NorthernBranch/modatro/releases?per_page=100',
    (route) => route.fulfill({ json: [release] }),
  );
  await page.goto('/');
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute('href', /style\.css\?v=.+/);
  for (const width of [1828, 1320, 900, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const hero = await page.locator('.hero').boundingBox();
    const preview = await page.locator('.app-preview').boundingBox();
    const image = await page.locator('.app-preview img').boundingBox();
    expect(hero).not.toBeNull();
    expect(preview!.y).toBeGreaterThanOrEqual(hero!.y + hero!.height);
    expect(image!.width).toBeLessThanOrEqual(720);
    expect(image!.x).toBeGreaterThanOrEqual(0);
    expect(image!.x + image!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  expect(oldStyles).toEqual([]);
});

test('search and social metadata identify the app and use a working screenshot', async ({
  page,
  request,
}) => {
  await page.route(
    'https://api.github.com/repos/NorthernBranch/modatro/releases?per_page=100',
    (route) => route.fulfill({ json: [release] }),
  );
  await page.goto('/');
  await expect(page).toHaveTitle(/Free Balatro Mod Manager/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://modatro.app/',
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://modatro.app/images/discover.png',
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  );
  const data = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}',
  );
  expect(
    data['@graph'].find((entry: { '@type': string }) => entry['@type'] === 'SoftwareApplication'),
  ).toMatchObject({
    name: 'Modatro',
    operatingSystem: 'Windows, macOS, Linux',
    offers: { price: '0' },
  });
  expect((await request.get('/images/discover.png')).ok()).toBe(true);
  expect(await (await request.get('/robots.txt')).text()).toContain(
    'Sitemap: https://modatro.app/sitemap.xml',
  );
  expect(await (await request.get('/sitemap.xml')).text()).toContain(
    '<loc>https://modatro.app/</loc>',
  );
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
    const screenshot = plain.getByRole('link', {
      name: 'View the Discover screenshot at full size',
    });
    await expect(screenshot).toHaveAttribute('href', '/images/discover.png');
    await screenshot.click();
    await expect(plain).toHaveURL(/\/images\/discover\.png$/);
  } finally {
    await context.close();
  }
});

test('screenshots expand in a contained modal and restore focus when closed', async ({
  page,
  context,
}) => {
  await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  const originalUrl = page.url();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Discover', 'Profiles', 'Troubleshooting', 'Creator']) {
      const opener = page.getByRole('link', { name: `View the ${name} screenshot at full size` });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: `${name} in Modatro` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('img')).toHaveAttribute(
        'src',
        new RegExp(`/images/${name.toLowerCase()}\\.png$`),
      );
      await expect
        .poll(() =>
          dialog.getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(1440);
      await expect(dialog.getByRole('button', { name: 'Close screenshot' })).toBeFocused();
      expect(await page.locator('body').evaluate((body) => getComputedStyle(body).overflow)).toBe(
        'hidden',
      );
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(page.url()).toBe(originalUrl);
      expect(context.pages()).toHaveLength(1);
      if (name === 'Discover') await page.keyboard.press('Escape');
      else if (name === 'Profiles')
        await dialog.getByRole('button', { name: 'Close screenshot' }).click();
      else await page.mouse.click(2, 2);
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/screenshot-open/);
    }
  }
});

test('profile and troubleshooting previews remain contained at desktop and mobile widths', async ({
  page,
}) => {
  await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  for (const width of [1828, 1320, 900, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['Named Modatro profiles', 'Modatro troubleshooting']) {
      const image = page.getByRole('img', { name: new RegExp(name) });
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBe(1440);
      const box = await image.boundingBox();
      expect(box!.width).toBeLessThan(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
