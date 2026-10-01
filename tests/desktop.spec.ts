import { _electron as electron, expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('desktop has an isolated renderer, working preload and validated IPC', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-desktop-test-'));
  // Electron creates this directory before Modatro initializes its own storage.
  // On macOS/Windows, "cache" aliases "Cache" and used to abort startup.
  await fs.mkdir(path.join(data, 'Cache'));
  await fs.writeFile(path.join(data, 'Cache', 'chromium-sentinel'), 'browser cache');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    MODATRO_TEST_DATA: data,
    MODATRO_DEV_URL: '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packagedExecutable = process.env.MODATRO_PACKAGED_EXECUTABLE;
  const application = await electron.launch({
    args: packagedExecutable ? [] : ['.'],
    executablePath: packagedExecutable,
    env,
  });
  try {
    const profile = await application.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    }));
    expect(profile).toEqual({ userData: data, sessionData: data });
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Welcome to Modatro.' })).toBeVisible();
    expect(await fs.readFile(path.join(data, 'Cache', 'chromium-sentinel'), 'utf8')).toBe(
      'browser cache',
    );
    expect((await fs.stat(path.join(data, 'catalogue-cache'))).isDirectory()).toBe(true);
    const isolation = await page.evaluate(() => ({
      node: typeof (globalThis as Record<string, unknown>).require,
      bridge: typeof window.modatro?.snapshot,
    }));
    expect(isolation).toEqual({ node: 'undefined', bridge: 'function' });
    // Inspect Electron's trusted main process rather than adding a privileged
    // diagnostic method to the production renderer bridge.
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>;
      };
      return contents.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    const reply = await page.evaluate(() => window.modatro!.snapshot());
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.value.preview).toBeUndefined();
      expect(reply.value.settings.gamePath).toBeUndefined();
      const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
      expect(reply.value.appVersion).toBe(pkg.version);
    }
    const invalidLink = await page.evaluate(() => window.modatro!.openLink('file:///etc/passwd'));
    expect(invalidLink.ok).toBe(false);
    const unsupportedConsent = await page.evaluate(() =>
      window.modatro!.action('fixture', 'install', undefined, undefined, [
        { id: 'Talisman', versionConstraint: '>=1.0.0' },
      ]),
    );
    expect(unsupportedConsent.ok).toBe(false);
    if (!unsupportedConsent.ok)
      expect(unsupportedConsent.error.details).toContain('acceptedUnverified');
    const loaderConsent = await page.evaluate(() =>
      window.modatro!.action('fixture', 'install', undefined, undefined, [
        { id: 'Lovely', versionConstraint: '>=1.0.0' },
      ]),
    );
    expect(loaderConsent.ok).toBe(false);
    if (!loaderConsent.ok)
      expect(loaderConsent.error.message).toBe(
        'This mod is not in the validated catalogue. Refresh and try again.',
      );
    await page.getByRole('button', { name: 'Browse for now' }).click();
    await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Just the way you like it.' })).toBeVisible();
  } finally {
    await application.close();
    await fs.rm(data, { recursive: true, force: true });
  }
});
