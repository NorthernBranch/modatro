import { expect, test, type Page } from '@playwright/test';
import type {
  ModatroApi,
  Progress,
  Reply,
  Snapshot,
  UnverifiedPrerequisite,
} from '../src/shared/model';

type Behavior = 'success' | 'hold' | 'reject' | 'error';
interface MockRequests {
  state: Snapshot;
  calls: Record<string, number>;
  actions: {
    id: string;
    action: string;
    token?: string;
    acceptedUnverified?: UnverifiedPrerequisite[];
  }[];
  behavior: Record<string, Behavior>;
  finish: (method: string, reply?: Reply<unknown>) => void;
  reject: (method: string) => void;
  progress: (value: Progress) => void;
}
declare global {
  interface Window {
    requestsTest: MockRequests;
  }
}

function fixture(ready = true): Snapshot {
  return {
    settings: {
      theme: 'dark',
      setupComplete: ready,
      gamePath: ready ? '/game/Balatro' : undefined,
      modsPath: ready ? '/game-data/Mods' : undefined,
    },
    validation: ready ? { valid: true, problems: [], warnings: [] } : undefined,
    catalogue: {
      mods: [
        {
          id: 'fixture',
          title: 'Fixture mod',
          author: 'Tests',
          version: '1.0.0',
          categories: ['Content'],
          prerequisites: [],
          installation: { type: 'standard' },
          downloadUrl: 'https://github.com/tests/mod/archive/main.zip',
          repositoryUrl: 'https://github.com/tests/mod',
        },
      ],
      stale: false,
      refreshing: false,
      rejected: 0,
    },
    prerequisites: [
      {
        id: 'Lovely',
        displayName: 'Lovely',
        installed: false,
        sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
      },
    ],
    localMods: [],
    candidates: [],
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '0.1.0',
    electronVersion: 'test',
  };
}
async function mockDesktop(page: Page, state = fixture(), behavior: Record<string, Behavior> = {}) {
  await page.addInitScript(
    ({ state, behavior }) => {
      const progressListeners = new Set<(value: Progress) => void>();
      const pending = new Map<
        string,
        {
          resolve: (reply: Reply<unknown>) => void;
          reject: (error: Error) => void;
          fallback: unknown;
        }
      >();
      const control: MockRequests = {
        state,
        behavior,
        calls: {},
        actions: [],
        finish(method, reply) {
          const request = pending.get(method);
          if (!request) throw new Error(`No pending request: ${method}`);
          pending.delete(method);
          request.resolve(reply ?? { ok: true, value: request.fallback });
        },
        reject(method) {
          const request = pending.get(method);
          if (!request) throw new Error(`No pending request: ${method}`);
          pending.delete(method);
          request.reject(new Error('Desktop connection lost'));
        },
        progress(value) {
          for (const listener of progressListeners) listener(value);
        },
      };
      window.requestsTest = control;
      const call = <T>(method: string, fallback: T): Promise<Reply<T>> => {
        control.calls[method] = (control.calls[method] ?? 0) + 1;
        switch (control.behavior[method]) {
          case 'reject':
            return Promise.reject(new Error('Desktop connection lost'));
          case 'error':
            return Promise.resolve({
              ok: false,
              error: { message: 'The folder is not accessible.' },
            });
          case 'hold':
            return new Promise((resolve, reject) =>
              pending.set(method, {
                resolve: (reply) => resolve(reply as Reply<T>),
                reject,
                fallback,
              }),
            );
          default:
            return Promise.resolve({ ok: true, value: fallback });
        }
      };
      const api: ModatroApi = {
        snapshot: () => call('snapshot', control.state),
        detect: () => call('detect', control.state),
        refresh: () => call('refresh', control.state),
        choosePath: () => call('choosePath', control.state),
        selectCandidate: () => call('selectCandidate', control.state),
        saveSettings: async (settings) => {
          const reply = await call('saveSettings', {
            ...control.state,
            settings: { ...control.state.settings, ...settings },
          });
          if (reply.ok) control.state = reply.value;
          return reply;
        },
        action: (id, action, _decisions, token, acceptedUnverified) => {
          control.actions.push({ id, action, token, acceptedUnverified });
          return call('action', control.state);
        },
        openModFolder: () => call('openModFolder', undefined),
        importDefinition: () => call('importDefinition', control.state),
        launch: () => call('launch', undefined),
        cancel: () => call('cancel', undefined),
        openFolder: () => call('openFolder', undefined),
        openLink: () => call('openLink', undefined),
        diagnostics: () => call('diagnostics', '{"version":"test"}'),
        onProgress: (listener) => {
          progressListeners.add(listener);
          return () => {
            progressListeners.delete(listener);
          };
        },
        onSnapshot: () => () => {},
      };
      window.modatro = api;
    },
    { state, behavior },
  );
  await page.goto('/');
}
async function closeError(page: Page) {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Let’s sort this out.' }) });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

test('unverified loaders allow installation only after explicit risk consent', async ({ page }) => {
  const state = fixture();
  state.prerequisites[0]!.installed = true;
  state.catalogue.mods[0]!.prerequisites = [
    { id: 'Lovely', displayName: 'Lovely', required: true, versionConstraint: '>=1.0.0' },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Cannot verify Lovely against >=1.0.0.',
        requirements: [
          {
            id: 'Lovely',
            displayName: 'Lovely',
            required: true,
            versionConstraint: '>=1.0.0',
            state: 'unknown',
            reason: 'Cannot verify Lovely against >=1.0.0.',
          },
        ],
        unverifiedPrerequisites: [
          {
            id: 'Lovely',
            displayName: 'Lovely',
            required: true,
            versionConstraint: '>=1.0.0',
            packageId: 'thunderstore/Thunderstore-lovely',
            state: 'unknown',
            reason: 'Cannot verify Lovely against >=1.0.0.',
          },
        ],
      },
    }),
  );
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Continuing may cause crashes');
  await expect(dialog).toContainText('only to this operation');
  expect(await page.evaluate(() => window.requestsTest.actions)).toEqual([
    { id: 'fixture', action: 'install' },
  ]);
  const proceed = dialog.getByRole('button', { name: 'Proceed at my own risk' });
  await proceed.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(() => window.requestsTest.actions.length)).toBe(2);
  expect(await page.evaluate(() => window.requestsTest.actions[1])).toEqual({
    id: 'fixture',
    action: 'install',
    acceptedUnverified: [
      { id: 'Lovely', versionConstraint: '>=1.0.0', packageId: 'thunderstore/Thunderstore-lovely' },
    ],
  });
  await page.evaluate(() => window.requestsTest.reject('action'));
  await expect(page.getByRole('dialog')).toContainText('could not complete this operation');
  await expect(page.getByRole('button', { name: 'Proceed at my own risk' })).toHaveCount(0);
  await closeError(page);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  expect(
    await page.evaluate(() => window.requestsTest.actions[2]?.acceptedUnverified),
  ).toBeUndefined();
  await page.evaluate(() => window.requestsTest.finish('action'));
});

test('Discover verifies known Steamodded runtimes and keeps unknown Lovely versions explicit', async ({
  page,
}) => {
  const state = fixture();
  state.trust = { fresh: true };
  state.prerequisites[0]!.installed = true;
  state.prerequisites.push({
    id: 'Steamodded',
    displayName: 'Steamodded',
    installed: true,
    installedVersion: '26.829.0',
    sourceUrl: 'https://github.com/Steamodded/smods',
  });
  state.catalogue.mods[0]!.prerequisites = [
    {
      id: 'Lovely',
      displayName: 'Lovely',
      required: true,
      versionConstraint: '>=0.9.0',
      packageId: 'thunderstore/Thunderstore-lovely',
    },
    {
      id: 'Steamodded',
      displayName: 'Steamodded',
      required: true,
      versionConstraint: '>=1.1620.0',
      packageId: 'thunderstore/Steamodded-Steamodded',
    },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  const rows = page.locator('.requirement-row');
  await expect(rows).toHaveCount(2);
  for (const id of ['Lovely', 'Steamodded']) {
    const row = rows.filter({ has: page.getByText(id, { exact: true }) });
    await expect(row.getByText('Installed', { exact: true })).toBeVisible();
    await expect(row.locator('.requirement-symbol')).toHaveText('✓');
    if (id === 'Lovely') {
      await expect(row).toContainText('Package version unverified');
      await expect(row.locator('.requirement-symbol')).toHaveClass(/unknown/);
    } else {
      await expect(row).toContainText('26.829.0');
      await expect(row.locator('.requirement-symbol')).toHaveClass(/satisfied/);
      await expect(row).not.toContainText('unverified');
    }
  }
  await expect(page.getByRole('dialog')).not.toContainText(
    'Removal and release checks could not finish',
  );
});

test('enabling an unverified mod can be cancelled without changing its state', async ({ page }) => {
  const state = fixture();
  state.localMods = [
    {
      id: 'fixture',
      title: 'Fixture mod',
      version: '1.0.0',
      folderName: 'fixture',
      managed: true,
      state: 'disabled',
      canAdopt: false,
      dependencies: [],
      problems: [],
    },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Cannot verify Steamodded against >=1.0.0.',
        unverifiedPrerequisites: [
          {
            id: 'Steamodded',
            displayName: 'Steamodded',
            required: true,
            versionConstraint: '>=1.0.0',
            state: 'unknown',
            reason: 'Cannot verify Steamodded against >=1.0.0.',
          },
        ],
      },
    }),
  );
  await expect(page.getByRole('button', { name: 'Proceed at my own risk' })).toBeVisible();
  await closeError(page);
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(1);
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`Lovely installation is offered on ${platform}`, async ({ page }) => {
    const state = fixture();
    state.platform = platform;
    state.catalogue.mods.push({
      ...state.catalogue.mods[0]!,
      id: 'Lovely',
      title: 'Lovely',
      metadataId: 'Lovely',
      installation: { type: 'lovely-injector' },
      repositoryUrl: 'https://github.com/ethangreen-dev/lovely-injector',
    });
    await mockDesktop(page, state);
    await page.getByRole('button', { name: 'Details for Lovely' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Install$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
    await page.getByRole('button', { name: 'Install Lovely' }).click();
    expect(await page.evaluate(() => window.requestsTest.actions)).toMatchObject([
      { id: 'prerequisite:Lovely', action: 'install' },
    ]);
    await page.getByRole('button', { name: 'Lovely instructions' }).click();
    expect(await page.evaluate(() => window.requestsTest.calls.openLink)).toBe(1);
  });
}

for (const managed of [false, true]) {
  test(`Lovely offers ${managed ? 'Update' : 'Manage'} for an installed copy`, async ({ page }) => {
    const state = fixture();
    state.prerequisites[0] = {
      ...state.prerequisites[0]!,
      installed: true,
      installedVersion: managed ? '0.9.0' : undefined,
      latestVersion: '0.10.0',
    };
    if (managed)
      state.localMods.push({
        id: 'Lovely',
        metadataId: 'Lovely',
        title: 'Lovely',
        version: '0.9.0',
        managed: true,
        state: 'installed',
        folderName: 'Lovely',
        canAdopt: false,
        problems: [],
      });
    await mockDesktop(page, state, { action: 'hold' });
    await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
    await page.getByRole('button', { name: `${managed ? 'Update' : 'Manage'} Lovely` }).click();
    expect(await page.evaluate(() => window.requestsTest.actions)).toMatchObject([
      { id: 'prerequisite:Lovely', action: managed ? 'update' : 'install' },
    ]);
    await expect(page.getByRole('button', { name: 'Preparing Lovely…' })).toBeDisabled();
  });
}

test('automatic discovery shows progress, prevents duplicate clicks and explains no results', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page, fixture(false), { detect: 'hold' });
  const setup = page.getByRole('dialog');
  const find = setup.getByRole('button', { name: 'Find automatically' });
  await find.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  const loading = setup.getByRole('button', { name: 'Finding Balatro…' });
  await expect(loading).toBeDisabled();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(setup.getByRole('button', { name: 'Choose folder' })).toBeDisabled();
  expect(await page.evaluate(() => window.requestsTest.calls.detect)).toBe(1);
  await page.evaluate(() => window.requestsTest.finish('detect'));
  await expect(setup.getByRole('status')).toContainText('No Balatro installation was found');
  await expect(find).toBeEnabled();
  await expect(setup.getByRole('button', { name: 'Choose folder' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('an adopted copy with an unknown registry version offers an explicit catalogue replacement', async ({
  page,
}) => {
  const state = fixture();
  state.localMods = [
    {
      id: 'fixture',
      title: 'Fixture mod',
      version: '99.0.0',
      folderName: 'ExistingFolder',
      managed: true,
      canAdopt: false,
      packageVersionUnknown: true,
      state: 'installed',
      dependencies: [],
      problems: [],
    },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page
    .locator('.sidebar')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await expect(
    page.getByText('The installed Thunderstore package version is unknown.', { exact: false }),
  ).toBeVisible();
  const install = page.getByRole('button', { name: 'Install catalogue release', exact: true });
  await install.click();
  await expect(install).toBeDisabled();
  expect(await page.evaluate(() => window.requestsTest.actions)).toEqual([
    { id: 'fixture', action: 'update' },
  ]);
  await page.evaluate(() => {
    window.requestsTest.state.localMods[0]!.packageVersionUnknown = false;
    window.requestsTest.state.localMods[0]!.version = '1.0.0';
    window.requestsTest.finish('action');
  });
  await expect(install).toHaveCount(0);
  await expect(page.locator('.local-row-info')).toContainText('Installed 1.0.0');
});

test('discovery handles a rejected connection and remains retryable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page, fixture(false), { detect: 'hold' });
  await page.getByRole('button', { name: 'Find automatically' }).click();
  await page.evaluate(() => window.requestsTest.reject('detect'));
  await expect(page.getByRole('dialog').last()).toContainText('Finding Balatro failed');
  await closeError(page);
  await page.evaluate(() => {
    window.requestsTest.behavior.detect = 'success';
  });
  await page.getByRole('button', { name: 'Find automatically' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    'No Balatro installation was found',
  );
  expect(errors).toEqual([]);
});

test('discovery offers multiple candidates and shows connection progress', async ({ page }) => {
  const state = fixture(false);
  state.candidates = ['/library-one/Balatro', '/library-two/Balatro'].map((path) => ({
    path,
    validation: { valid: true, problems: [], warnings: [] },
  }));
  await mockDesktop(page, state, { selectCandidate: 'hold' });
  const setup = page.getByRole('dialog');
  await setup.getByRole('button', { name: 'Find automatically' }).click();
  await expect(setup.getByRole('status')).toContainText('Choose an installation');
  await setup.getByRole('button', { name: '/library-one/Balatro', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Connecting Balatro…' }).first()).toBeDisabled();
  await page.evaluate(
    (ready) => window.requestsTest.finish('selectCandidate', { ok: true, value: ready }),
    { ...fixture(), settings: { ...fixture().settings, setupComplete: false } },
  );
  await expect(setup).toContainText('Your installation is verified and connected.');
  await expect(setup.getByRole('button', { name: 'Start exploring' })).toBeEnabled();
});

test('failed setup saves keep the setup dialog open and restore its controls', async ({ page }) => {
  const state = fixture();
  state.settings.setupComplete = false;
  await mockDesktop(page, state, { saveSettings: 'hold' });
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await expect(page.getByRole('button', { name: 'Saving setup…' })).toBeDisabled();
  await page.evaluate(() =>
    window.requestsTest.finish('saveSettings', {
      ok: false,
      error: { message: 'Settings could not be saved.' },
    }),
  );
  await expect(page.getByRole('dialog').last()).toContainText('Settings could not be saved.');
  await closeError(page);
  await expect(page.getByRole('heading', { name: 'Welcome to Modatro.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start exploring' })).toBeEnabled();
  await page.evaluate(() => {
    window.requestsTest.behavior.saveSettings = 'success';
  });
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('initial service failures show an explicit state and allow retry', async ({ page }) => {
  await mockDesktop(page, fixture(), { snapshot: 'hold' });
  await expect(page.getByRole('heading', { name: 'Loading Modatro…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch Balatro' })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('snapshot'));
  await expect(page.getByRole('heading', { name: 'Modatro could not load' })).toBeVisible();
  await closeError(page);
  await page.evaluate(() => {
    window.requestsTest.behavior.snapshot = 'success';
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
});

test('refresh failures preserve the catalogue and release every refresh control', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { refresh: 'hold' });
  await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('refresh'));
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Refresh catalogue', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Fixture mod', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.requestsTest.behavior.refresh = 'hold';
  });
  await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('refresh', {
      ok: true,
      value: {
        ...window.requestsTest.state,
        catalogue: {
          ...window.requestsTest.state.catalogue,
          stale: true,
          error: 'GitHub is unavailable',
        },
      },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Some updates could not be checked');
  await expect(page.getByRole('dialog')).not.toContainText(
    'Catalogue and prerequisites refreshed.',
  );
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Refresh catalogue', exact: true })).toBeEnabled();
});

test('folder selection handles errors and user cancellation without disabling settings', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { choosePath: 'hold' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choosing folder…' })).toBeDisabled();
  await expect(page.getByLabel('Theme', { exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.requestsTest.finish('choosePath', {
      ok: false,
      error: { message: 'Selected folder is invalid.' },
    }),
  );
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await page.evaluate(() => window.requestsTest.finish('choosePath'));
  await expect(page.getByLabel('Theme', { exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('theme save failures preserve the previous theme and allow retry', async ({ page }) => {
  await mockDesktop(page, fixture(), { saveSettings: 'hold' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.getByLabel('Theme', { exact: true })).toBeDisabled();
  await expect(page.getByText('Saving theme…', { exact: true })).toBeVisible();
  await page.evaluate(() => window.requestsTest.reject('saveSettings'));
  await closeError(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('dark');
  await expect(page.getByLabel('Theme', { exact: true })).toBeEnabled();
});

test('an optional mod index can be saved during setup and removed from Settings', async ({
  page,
}) => {
  const state = fixture();
  state.settings.setupComplete = false;
  await mockDesktop(page, state);
  const index = 'https://github.com/community/balatro-mod-index';
  await page.getByLabel('Additional mod index (optional)').fill(index);
  await page.getByRole('button', { name: 'Save index', exact: true }).click();
  await expect(page.getByText(`Configured index: ${index}`)).toBeVisible();
  await page.getByRole('button', { name: 'Start exploring', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Additional mod index (optional)')).toHaveValue(index);
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.getByLabel('Additional mod index (optional)')).toHaveValue(index);
  await page.getByLabel('Additional mod index (optional)').fill('');
  await page.getByRole('button', { name: 'Remove index', exact: true }).click();
  await expect(page.getByText(`Configured index: ${index}`)).toHaveCount(0);
});

test('mod details identify the configured index before installation', async ({ page }) => {
  const state = fixture();
  state.settings.modIndexUrl = 'https://github.com/community/index';
  state.catalogue.mods[0]!.source = {
    provider: 'mod-index',
    externalId: 'fixture',
    url: state.settings.modIndexUrl,
  };
  await mockDesktop(page, state);
  await page.getByRole('button', { name: 'Details for Fixture mod', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source: Index · community/index' })).toBeVisible();
});

test('Updates distinguishes an ongoing check from a failed catalogue refresh', async ({ page }) => {
  await mockDesktop(page, fixture(), { refresh: 'hold' });
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Checking for updates…', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You’re all caught up.' })).toHaveCount(0);
  await page.evaluate(() =>
    window.requestsTest.finish('refresh', {
      ok: true,
      value: {
        ...window.requestsTest.state,
        catalogue: { ...window.requestsTest.state.catalogue, stale: true, error: 'offline' },
      },
    }),
  );
  await closeError(page);
  await expect(page.getByRole('heading', { name: 'Refresh to check for updates' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
});

test('launch failures show loading, prevent duplicates and restore the launch button', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { launch: 'hold' });
  await page.getByRole('button', { name: 'Launch Balatro', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Launching…' })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('launch'));
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Launch Balatro', exact: true })).toBeEnabled();
});

test('mod operations show progress before a progress event and survive rejected IPC', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('.operation-toast')).toContainText('Installing mod');
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Launch Balatro', exact: true })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('action'));
  await expect(page.getByRole('dialog')).toContainText('Reopen Modatro to check recovery.');
  await closeError(page);
  await expect(page.locator('.operation-toast')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
});

test('download cancellation has its own busy state and errors leave the ongoing operation visible', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold', cancel: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.progress({ modId: 'fixture', phase: 'downloading', percent: 12 }),
  );
  const toast = page.locator('.operation-toast');
  await toast.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(toast.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('cancel'));
  await expect(page.getByRole('dialog')).toContainText('Cancelling download failed');
  await closeError(page);
  await expect(toast).toContainText('Installing mod');
  await expect(toast.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: { message: 'Download cancelled. No files were installed.' },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Download cancelled.');
  await expect(toast).toHaveCount(0);
});

test('mod details keep progress visible while the service prepares an installation', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod', exact: true }).click();
  const details = page.getByRole('dialog');
  await details.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(details.getByRole('status')).toContainText('Installing mod');
  await page.evaluate(() => window.requestsTest.finish('action'));
  await expect(details.getByRole('status')).toHaveCount(0);
});

for (const scenario of [
  { method: 'openFolder', button: 'Open backups', loading: 'Opening…' },
  { method: 'diagnostics', button: 'Copy diagnostics', loading: 'Copying…' },
  {
    method: 'importDefinition',
    button: 'Install from file / Add mod definition',
    loading: 'Inspecting file…',
  },
]) {
  test(`${scenario.button} handles a rejected request and restores its control`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mockDesktop(page, fixture(), { [scenario.method]: 'hold' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    if (scenario.method === 'importDefinition')
      await page.getByText('Advanced', { exact: true }).click();
    await page.getByRole('button', { name: scenario.button, exact: true }).click();
    await expect(page.getByRole('button', { name: scenario.loading, exact: true })).toBeDisabled();
    await page.evaluate((method) => window.requestsTest.reject(method), scenario.method);
    await closeError(page);
    await expect(page.getByRole('button', { name: scenario.button, exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test('clipboard denial provides copyable diagnostics and restores the button', async ({ page }) => {
  await mockDesktop(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Permission denied');
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Copy diagnostics', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('The clipboard is unavailable.');
  await page.getByText('Technical details', { exact: true }).click();
  await expect(page.getByRole('dialog').locator('pre')).toContainText('{"version":"test"}');
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeEnabled();
});

test('project links show progress and handle failures without unhandled rejections', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDesktop(page, fixture(), { openLink: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod', exact: true }).click();
  await page.getByRole('button', { name: 'Repository', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await page.evaluate(() => window.requestsTest.reject('openLink'));
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Repository', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

function addPrerequisite(
  state: Snapshot,
  id: string,
  version = '2.0.0',
  dependencies: Snapshot['catalogue']['mods'][number]['prerequisites'] = [],
) {
  state.catalogue.mods.push({
    ...state.catalogue.mods[0]!,
    id,
    title: id,
    version,
    prerequisites: dependencies,
  });
  state.prerequisites.push({
    id,
    displayName: id,
    installed: false,
    sourceUrl: `https://github.com/tests/${id}`,
  });
}

test('a blocked mod can install Talisman directly and reevaluates its requirements', async ({
  page,
}) => {
  const state = fixture();
  addPrerequisite(state, 'Talisman');
  state.catalogue.mods[0]!.prerequisites = [
    { id: 'Talisman', displayName: 'Talisman', required: true, versionConstraint: '>=2.0.0' },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Install Talisman', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Installing Talisman…' })).toBeDisabled();
  await page.evaluate(() => {
    const dependency = window.requestsTest.state.prerequisites.find((p) => p.id === 'Talisman')!;
    dependency.installed = true;
    dependency.installedVersion = '2.0.0';
    window.requestsTest.finish('action');
  });
  await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
  await expect(dialog.getByText('Installed', { exact: true })).toBeVisible();
});

test('an outdated managed Steamodded has a direct update action', async ({ page }) => {
  const state = fixture();
  addPrerequisite(state, 'Steamodded');
  state.catalogue.mods[0]!.prerequisites = [
    { id: 'Steamodded', displayName: 'Steamodded', required: true, versionConstraint: '>=2.0.0' },
  ];
  Object.assign(state.prerequisites.at(-1)!, {
    installed: true,
    installedVersion: '1.0.0',
    latestVersion: '2.0.0',
  });
  state.localMods.push({
    id: 'Steamodded',
    title: 'Steamodded',
    version: '1.0.0',
    state: 'update-available',
    managed: true,
    folderName: 'Steamodded',
    canAdopt: false,
    problems: [],
  });
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  await expect(page.getByRole('dialog')).toContainText('Update required');
  await page.getByRole('button', { name: 'Update Steamodded', exact: true }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.action)).toBe(1);
  await page.evaluate(() => window.requestsTest.reject('action'));
  await closeError(page);
  await expect(page.getByRole('button', { name: 'Update Steamodded', exact: true })).toBeEnabled();
});

test('dependency chains remain visible and never install silently', async ({ page }) => {
  const state = fixture();
  addPrerequisite(state, 'Steamodded', '2.0.0', [
    { id: 'Lovely', displayName: 'Lovely', required: true },
  ]);
  state.catalogue.mods[0]!.prerequisites = [
    { id: 'Steamodded', displayName: 'Steamodded', required: true },
  ];
  await mockDesktop(page, state);
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  await page.getByRole('button', { name: 'Review Steamodded requirements' }).click();
  await expect(page.getByRole('dialog')).toContainText('Required by Fixture mod');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Lovely instructions' }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.action ?? 0)).toBe(0);
  await page.getByRole('button', { name: 'Back to Fixture mod' }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Fixture mod' }),
  ).toBeVisible();
});

test('archive-discovered requirements offer a direct prerequisite action after failure', async ({
  page,
}) => {
  const state = fixture();
  addPrerequisite(state, 'Talisman');
  await mockDesktop(page, state, { action: 'hold' });
  await page
    .locator('.mod-card')
    .filter({ hasText: 'Fixture mod' })
    .getByRole('button', { name: 'Install', exact: true })
    .click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Additional requirements were found.',
        requirements: [
          {
            id: 'Talisman',
            displayName: 'Talisman',
            required: true,
            state: 'missing',
            reason: 'Talisman is required.',
          },
        ],
      },
    }),
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Install Talisman' }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.action)).toBe(2);
  await page.evaluate(() => window.requestsTest.finish('action'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('prerequisites keep external loader versions visible when package versions are unrecorded', async ({
  page,
}) => {
  const state = fixture();
  Object.assign(state.prerequisites[0]!, {
    installed: true,
    latestVersion: '0.10.0',
    latestPackageId: 'thunderstore/Thunderstore-lovely',
  });
  for (const [id, version, latestVersion, latestPackageId] of [
    ['Steamodded', '1.0.0~BETA-0827c', '26.829.0', 'thunderstore/Steamodded-Steamodded'],
    ['Talisman', '2.7', '2.7.0', 'thunderstore/MathIsFun_-Talisman'],
  ]) {
    state.prerequisites.push({
      id: id!,
      displayName: id!,
      installed: true,
      installedVersion: version,
      latestVersion,
      latestPackageId,
      sourceUrl: 'https://github.com/tests/prerequisite',
    });
    state.localMods.push({
      id: `external:${id}`,
      title: id!,
      folderName: id!,
      version,
      state: 'unmanaged',
      managed: false,
      canAdopt: false,
      problems: [],
    });
  }
  await mockDesktop(page, state);
  await page
    .locator('.sidebar')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await expect(page.locator('.local-row-info')).toContainText(['1.0.0~BETA-0827c', '2.7']);
  await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
  for (const [id, version] of [
    ['Steamodded', '1.0.0~BETA-0827c'],
    ['Talisman', '2.7'],
  ]) {
    const card = page.locator('.prerequisite-card').filter({ hasText: id! });
    await expect(card.locator('.state-badge')).toContainText('Installed');
    await expect(card.locator('dd').first()).toHaveText(version!);
    await expect(card).toContainText('automatic update comparison is unavailable');
    await expect(card).not.toContainText('Update available');
  }
  const lovely = page.locator('.prerequisite-card').filter({ hasText: 'Lovely' });
  await expect(lovely.locator('.state-badge')).toHaveText('Installed · version unknown');
  await expect(lovely.locator('.state-badge')).not.toHaveClass(/missing/);
  await expect(lovely.locator('dd').first()).toHaveText('Version unknown');
});

test('prerequisites compare only recorded versions from the same package source', async ({
  page,
}) => {
  const state = fixture();
  const packageId = 'thunderstore/Steamodded-Steamodded';
  state.prerequisites.push({
    id: 'Steamodded',
    displayName: 'Steamodded',
    installed: true,
    installedVersion: '1.0.0~BETA-0827c',
    packageId,
    packageVersion: '1.827.2',
    latestPackageId: packageId,
    latestVersion: '26.829.0',
    sourceUrl: 'https://github.com/Steamodded/smods',
  });
  Object.assign(state.prerequisites[0]!, {
    installed: true,
    installedVersion: '0.9.0',
    packageId: 'thunderstore/Other-Lovely',
    packageVersion: '0.1.0',
    latestPackageId: 'thunderstore/Thunderstore-lovely',
    latestVersion: '0.10.0',
  });
  state.prerequisites.push({
    id: 'Talisman',
    displayName: 'Talisman',
    installed: false,
    sourceUrl: 'https://github.com/SpectralPack/Talisman',
  });
  await mockDesktop(page, state);
  await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
  const steamodded = page.locator('.prerequisite-card').filter({ hasText: 'Steamodded' });
  await expect(steamodded.locator('.state-badge')).toContainText('Update available');
  await expect(steamodded).toContainText('Installed package version');
  await expect(steamodded).toContainText('1.827.2');
  await expect(steamodded).toContainText('Runtime version');
  await expect(steamodded).toContainText('1.0.0~BETA-0827c');
  const lovely = page.locator('.prerequisite-card').filter({ hasText: 'Lovely' });
  await expect(lovely.locator('.state-badge')).toContainText('Installed');
  await expect(lovely.locator('dd').first()).toHaveText('0.9.0');
  await expect(lovely).not.toContainText('Update available');
  const talisman = page.locator('.prerequisite-card').filter({ hasText: 'Talisman' });
  await expect(talisman.locator('.state-badge')).toContainText('Optional');
  await expect(talisman.locator('dd').first()).toHaveText('Not installed');
});

test('a failed prerequisite check preserves installed status and shows the last known release', async ({
  page,
}) => {
  const state = fixture();
  Object.assign(state.prerequisites[0]!, {
    installed: true,
    installedVersion: '0.9.0',
    latestVersion: '0.9.0',
    latestError: 'Unable to check latest version',
  });
  await mockDesktop(page, state);
  await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
  const card = page.locator('.prerequisite-card');
  await expect(card).toContainText('Unable to check latest version');
  await expect(card).toContainText('Showing the last known release');
  await expect(card.locator('.state-badge')).toContainText('Installed');
  await expect(card).toContainText('0.9.0');
});

test('game-running failures offer Check again and preserve duplicate-click protection', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: { message: 'Close Balatro before changing mods.', retryable: true },
    }),
  );
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.action)).toBe(2);
  await page.evaluate(() => window.requestsTest.finish('action'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('uninstall reports the precise preserved files and cleanup problems', async ({ page }) => {
  const state = fixture();
  state.localMods.push({
    id: 'fixture',
    title: 'Fixture mod',
    version: '1.0.0',
    state: 'installed',
    managed: true,
    folderName: 'fixture',
    canAdopt: false,
    problems: [],
  });
  state.operationReport = {
    title: 'Fixture mod was uninstalled',
    retainedFiles: ['mods/fixture/user-notes.txt'],
    cleanupProblems: ['mods/fixture/empty: could not remove the empty directory.'],
  };
  await mockDesktop(page, state);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  const report = page.getByRole('dialog');
  await expect(report).toContainText('mods/fixture/user-notes.txt');
  await expect(report).toContainText('Some cleanup could not finish');
  await report.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('archive-discovered Lovely requirements offer installation and prevent duplicate requests', async ({
  page,
}) => {
  const state = fixture();
  state.platform = 'win32';
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Lovely is required.',
        requirements: [
          {
            id: 'Lovely',
            displayName: 'Lovely',
            required: true,
            state: 'missing',
            reason: 'Lovely is required.',
          },
        ],
      },
    }),
  );
  await page
    .getByRole('button', { name: 'Install Lovely' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  expect(await page.evaluate(() => window.requestsTest.calls.action)).toBe(2);
  expect(await page.evaluate(() => window.requestsTest.actions[1])).toMatchObject({
    id: 'prerequisite:Lovely',
    action: 'install',
  });
});

test('author removal hides new installs and preserves local uninstall controls', async ({
  page,
}) => {
  const state = fixture();
  const definition = state.catalogue.mods[0]!;
  definition.approvalStatus = 'opted-out';
  definition.permissions = { display: true, install: false, update: false };
  definition.policyReason = 'The author requested removal. Your installation has not been changed.';
  state.localMods.push({
    id: definition.id,
    title: definition.title,
    managed: true,
    state: 'installed',
    folderName: 'fixture',
    canAdopt: false,
    problems: [],
    availabilityReason: definition.policyReason,
  });
  await mockDesktop(page, state);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await expect(
    page.getByText('The author requested removal. Your installation has not been changed.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.requestsTest.calls.action ?? 0)).toBe(0);
});
test('unapproved artwork and descriptions use neutral cards with honest legacy labels', async ({
  page,
}) => {
  const state = fixture();
  const definition = state.catalogue.mods[0]!;
  definition.iconUrl = 'https://github.com/tests/mod/unauthorized.png';
  definition.description = 'Unapproved copied description';
  await mockDesktop(page, state);
  await expect(page.locator('.mod-card img')).toHaveCount(0);
  await expect(page.getByText('Unapproved copied description')).toHaveCount(0);
  await expect(page.getByText('Legacy index', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  await expect(page.getByRole('dialog')).toContainText('mutable branch');
  await expect(page.getByRole('dialog')).toContainText('tests/mod');
});
test('offline trust data disables new downloads while showing cache freshness', async ({
  page,
}) => {
  const state = fixture();
  state.trust = { fresh: false, error: 'Connect and refresh removal checks.' };
  state.catalogue.stale = true;
  state.catalogue.fetchedAt = '2026-09-30T18:42:00Z';
  await mockDesktop(page, state);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Showing catalogue from/)).toBeVisible();
  await page.getByRole('button', { name: 'View availability' }).click();
  await expect(page.getByRole('dialog')).toContainText('Connect and refresh removal checks.');
  expect(await page.evaluate(() => window.requestsTest.calls.action ?? 0)).toBe(0);
});
test('external mods are identified as installed and require explicit adoption', async ({
  page,
}) => {
  const state = fixture();
  state.localMods.push({
    id: 'external:Manual',
    catalogueId: 'fixture',
    title: 'Fixture mod',
    version: '0.9.0',
    managed: false,
    state: 'unmanaged',
    folderName: 'Manual',
    canAdopt: true,
    problems: [],
  });
  await mockDesktop(page, state);
  await expect(page.getByRole('button', { name: 'Installed externally' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await page.getByRole('button', { name: 'Adopt into Modatro' }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.action ?? 0)).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Adopt existing files' }).click();
  expect(await page.evaluate(() => window.requestsTest.actions)).toEqual([
    { id: 'external:Manual', action: 'adopt' },
  ]);
});
test('shows the server-generated file plan and returns its confirmation token', async ({
  page,
}) => {
  const state = fixture();
  state.catalogue.mods[0]!.installation = {
    type: 'game-replacement',
    files: [{ source: 'patch.lua', destination: 'game.lua' }],
  };
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.evaluate(() => {
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Review actual changes',
        confirmation: {
          token: 'actual-plan-token',
          plan: {
            modId: 'fixture',
            version: '1.0.0',
            create: [],
            replace: [{ root: 'game', path: 'game.lua', previousHash: 'a'.repeat(64) }],
            remove: [],
            prerequisites: [],
            conflicts: [],
            packages: [
              { id: 'dependency', title: 'Required package', version: '1.2.0', update: false },
              { id: 'fixture', title: 'Fixture mod', version: '1.0.0', update: false },
            ],
          },
        },
      },
    });
    window.requestsTest.behavior.action = 'success';
  });
  await expect(page.getByRole('dialog')).toContainText('replace: game/game.lua');
  await expect(page.getByRole('dialog')).toContainText('Required package 1.2.0');
  await expect(page.getByRole('dialog')).toContainText('Fixture mod requires Required package');
  await expect(page.getByRole('dialog')).toContainText(
    'installed or updated first, followed by Fixture mod',
  );
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(1);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Install mod and dependencies' })
    .click();
  expect((await page.evaluate(() => window.requestsTest.actions)).at(-1)?.token).toBe(
    'actual-plan-token',
  );
});
test('cancelling a dependency confirmation sends no installation request', async ({ page }) => {
  const state = fixture();
  addPrerequisite(state, 'Talisman');
  state.catalogue.mods[0]!.prerequisites = [
    { id: 'Talisman', displayName: 'Talisman', required: true, versionConstraint: '>=2.0.0' },
  ];
  await mockDesktop(page, state, { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).first().click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Review dependencies',
        confirmation: {
          token: 'dependency-plan-token',
          plan: {
            modId: 'fixture',
            version: '1.0.0',
            create: [{ root: 'mods', path: 'dependency/main.lua' }],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
            packages: [
              { id: 'dependency', title: 'Required dependency', version: '1.0.0', update: false },
              { id: 'fixture', title: 'Fixture mod', version: '1.0.0', update: false },
            ],
          },
        },
      },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Fixture mod requires Required dependency');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(1);
});
test('a managed GitHub catalogue installation does not offer catalogue replacement', async ({
  page,
}) => {
  const state = fixture();
  state.localMods.push({
    id: 'fixture',
    title: 'Fixture mod',
    version: '1.0.0',
    state: 'installed',
    managed: true,
    folderName: 'fixture',
    canAdopt: false,
    problems: [],
    packageVersionUnknown: false,
    provenance: { provider: 'github', sourceType: 'release-asset' },
  });
  await mockDesktop(page, state);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await expect(page.getByRole('button', { name: 'Install catalogue release' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
});
