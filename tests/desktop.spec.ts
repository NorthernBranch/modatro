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
    const productionControls = await application.evaluate(({ BrowserWindow, Menu }) => {
      const roles = (menu: ReturnType<typeof Menu.getApplicationMenu>): string[] =>
        menu?.items.flatMap((item) => [item.role ?? '', ...roles(item.submenu ?? null)]) ?? [];
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.openDevTools();
      return { roles: roles(Menu.getApplicationMenu()), devToolsOpen: contents.isDevToolsOpened() };
    });
    expect(productionControls.roles).not.toContain('toggleDevTools');
    expect(productionControls.roles).not.toContain('reload');
    expect(productionControls.roles).not.toContain('forceReload');
    expect(productionControls.devToolsOpen).toBe(false);
    if (process.platform !== 'darwin') {
      const controls = await application.evaluate(({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        return {
          menu: Menu.getApplicationMenu() === null,
          menuVisible: window.isMenuBarVisible(),
          minimize: window.isMinimizable(),
          maximize: window.isMaximizable(),
          close: window.isClosable(),
        };
      });
      expect(controls).toMatchObject({ menu: true, menuVisible: false });
      if (process.platform === 'win32')
        expect(controls).toMatchObject({ minimize: true, maximize: true, close: true });
    }
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

test('setup and theme saves preserve selected folders through validated desktop IPC', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-settings-test-')),
  );
  const data = path.join(root, 'profile');
  const gamePath = path.join(root, 'Balatro');
  const modsPath = path.join(root, 'Mods');
  await fs.mkdir(path.join(data, 'data'), { recursive: true });
  await fs.mkdir(modsPath);
  const loaderLogs = path.join(modsPath, 'lovely', 'log');
  await fs.mkdir(loaderLogs, { recursive: true });
  await fs.writeFile(
    path.join(loaderLogs, 'fixture-run.log'),
    'ERROR: Synthetic loader failure references FixtureMod\ntoken=ghp_syntheticPrivateToken',
  );
  if (process.platform === 'darwin') {
    const contents = path.join(gamePath, 'Balatro.app', 'Contents');
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(contents, 'Resources'));
    await fs.writeFile(
      path.join(contents, 'Info.plist'),
      '<plist><string>Balatro</string></plist>',
    );
    await fs.writeFile(path.join(contents, 'MacOS', 'love'), Buffer.from('cffaedfe', 'hex'));
    await fs.writeFile(path.join(contents, 'Resources', 'Balatro.love'), 'fixture');
  } else {
    await fs.cp(path.resolve('fixtures/balatro-valid'), gamePath, { recursive: true });
  }
  await fs.writeFile(
    path.join(data, 'data', 'state.json'),
    JSON.stringify({
      schemaVersion: 2,
      settings: { theme: 'dark', setupComplete: false, gamePath, modsPath },
      installations: [],
    }),
  );
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
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Start exploring' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start exploring' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const reply = await page.evaluate(() => window.modatro!.snapshot());
    expect(reply.ok).toBe(true);
    if (reply.ok)
      expect(reply.value.settings).toEqual({
        theme: 'light',
        setupComplete: true,
        gamePath,
        modsPath,
      });
    const invalidSettings = await page.evaluate(() => {
      const settings = {
        theme: 'dark' as const,
        setupComplete: true,
        gamePath: '/unexpected-game',
        modsPath: '/unexpected-mods',
      };
      return window.modatro!.saveSettings(settings);
    });
    expect(invalidSettings.ok).toBe(false);
    if (!invalidSettings.ok) expect(invalidSettings.error.details).toContain('gamePath');
    const saved = JSON.parse(await fs.readFile(path.join(data, 'data', 'state.json'), 'utf8'));
    expect(saved.settings).toEqual({ theme: 'light', setupComplete: true, gamePath, modsPath });
    expect(saved.schemaVersion).toBe(3);
    const originalId = saved.profiles.activeId;
    await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
    await page.getByRole('button', { name: 'Create profile from current selection' }).click();
    await page.getByLabel('Profile name', { exact: true }).fill('Fixture selection');
    await page.getByLabel('Profile name', { exact: true }).press('Enter');
    await expect(page.getByText('Active: Fixture selection', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Duplicate Fixture selection', exact: true }).click();
    await page.getByLabel('Profile name', { exact: true }).fill('Fixture duplicate');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.getByRole('button', { name: 'Rename Fixture duplicate', exact: true }).click();
    await page.getByLabel('Profile name', { exact: true }).fill('Renamed fixture');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Review switch to Renamed fixture' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Profile', { exact: true }).selectOption(originalId);
    await expect(
      page.getByRole('heading', { name: 'Review profile: Default', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm profile switch', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const applied = await page.evaluate(() => window.modatro!.snapshot());
    expect(applied.ok && applied.value.profiles?.activeId).toBe(originalId);
    await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Default', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm delete', exact: true })).toBeDisabled();
    await page.getByLabel('Preserve the current selection as a new Default profile').check();
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByText('Active: Default', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const badRequest = await page.evaluate(() =>
      window.modatro!.troubleshoot!({ logIds: [], path: '/private.log' } as never),
    );
    expect(badRequest.ok).toBe(false);
    await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Setup overview', exact: true })).toBeVisible();
    await expect(page.getByText('profile-switch · success', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Generate support report', exact: true }).click();
    await expect(page.getByLabel('Editable support report')).toContainText(
      'Modatro support report',
    );
    expect(await page.getByLabel('Editable support report').inputValue()).not.toContain(
      'Synthetic loader failure',
    );
    await page.keyboard.press('Escape');
    await page.getByLabel('Lovely / Steamodded: fixture-run.log', { exact: true }).check();
    await page.getByRole('button', { name: 'Read selected excerpts', exact: true }).click();
    await expect(
      page.getByText(
        'This is log evidence, not proof that a referenced mod caused the failure. File time does not prove which game session produced it.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByLabel('Installed mod identities and versions', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Generate support report', exact: true }).click();
    const included = await page.getByLabel('Editable support report').inputValue();
    expect(included).toContain('Synthetic loader failure');
    expect(included).not.toContain('ghp_syntheticPrivateToken');
    expect(included).not.toContain('## Mods');
    await page.getByLabel('Editable support report').fill('Reviewed synthetic support report');
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (globalThis as Record<string, unknown>).copiedFixtureReport = text;
          },
        },
      }),
    );
    await page.getByRole('button', { name: 'Copy report', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Report copied.' })).toBeVisible();
    expect(
      await page.evaluate(() => (globalThis as Record<string, unknown>).copiedFixtureReport),
    ).toBe('Reviewed synthetic support report');
    const exported = path.join(root, 'reviewed-report.md');
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destination,
      })) as typeof dialog.showSaveDialog;
    }, exported);
    await page.getByRole('button', { name: 'Export report', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Report exported.' })).toBeVisible();
    expect(await fs.readFile(exported, 'utf8')).toBe('Reviewed synthetic support report');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
    await page.getByRole('button', { name: 'Create profile from current selection' }).click();
    await page.getByLabel('Profile name', { exact: true }).fill('Fresh checks fixture');
    await page.getByLabel('Profile name', { exact: true }).press('Enter');
    await expect(page.getByText('Active: Fresh checks fixture', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('status').filter({ hasText: 'Setup changed since these checks.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Refresh setup checks', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Setup changed since these checks.' }),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
