import { expect, test, type Page } from '@playwright/test';
import type {
  ModatroApi,
  Progress,
  Reply,
  Snapshot,
  UnverifiedPrerequisite,
} from '../src/shared/model';

import { creatorIdentities, type CreatorProject } from '../src/shared/creator';
import { defaultContent, type ContentType } from '../src/shared/creator-content';
import { generateLua } from '../src/shared/creator-lua';

type Behavior = 'success' | 'hold' | 'reject' | 'error';
test('setup recovery reviews missing entries and reset files before confirmation, keeps pending work open and refreshes Installed', async ({
  page,
}) => {
  const state = fixture();
  state.localMods = [
    {
      id: 'missing',
      title: 'Missing library',
      version: '1.0.0',
      managed: true,
      state: 'broken',
      filesMissing: true,
      folderName: 'missing',
      canAdopt: false,
      problems: ['a.lua is missing.', 'b.lua is missing.'],
    },
  ];
  await mockDesktop(page, state, { 'setupRecovery:review': 'hold', 'setupRecovery:apply': 'hold' });
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  await expect(page.getByText('2 files need attention', { exact: true })).toBeVisible();
  await expect(page.getByText('Files missing · Recorded version 1.0.0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open mod folder', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Repair or reset setup', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Checking files and saved installation entries…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => window.requestsTest.finish('setupRecovery:review'));
  await expect(
    page.getByRole('button', { name: 'Clear missing entries', exact: true }),
  ).toBeEnabled();
  await page.getByRole('radio', { name: /Back up and reset mod setup/ }).check();
  await page.evaluate(() => window.requestsTest.finish('setupRecovery:review'));
  await page.getByText('Files to remove (2)', { exact: true }).click();
  await expect(page.getByText('game/version.dll', { exact: true })).toBeVisible();
  await expect(page.getByText('game/winmm.dll', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls['setupRecovery:apply'] ?? 0)).toBe(0);
  await page.getByRole('checkbox', { name: /I understand that all reviewed mod files/ }).check();
  await page.screenshot({ path: 'test-results/setup-recovery.png' });
  for (const width of [650, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.getByRole('dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    ).toBe(true);
  }
  await page.screenshot({ path: 'test-results/setup-recovery-mobile.png' });
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.getByRole('button', { name: 'Back up and reset', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Close dialog')).toBeDisabled();
  await page.evaluate(() => window.requestsTest.finish('setupRecovery:apply'));
  await expect(page.getByRole('heading', { name: 'Your setup is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.local-row')).toHaveCount(0);
});
test('missing installation entries can be cleared with one reviewed confirmation', async ({
  page,
}) => {
  const state = fixture();
  state.localMods = [
    {
      id: 'missing',
      title: 'Missing mod',
      managed: true,
      state: 'broken',
      filesMissing: true,
      folderName: 'missing',
      canAdopt: false,
      problems: ['main.lua is missing.'],
    },
  ];
  await mockDesktop(page, state);
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  await expect(page.getByText('1 file needs attention', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Repair or reset setup', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear missing entries', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your setup is ready' })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls['setupRecovery:apply'])).toBe(1);
});
test('setup recovery offers an inline retry after a failed check without removing files', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { 'setupRecovery:review': 'reject' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Repair or reset setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Checking your mod setup failed');
  await page.evaluate(() => {
    window.requestsTest.behavior['setupRecovery:review'] = 'success';
  });
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back up and reset', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.requestsTest.calls['setupRecovery:apply'] ?? 0)).toBe(0);
});
test('profile sharing reviews downloads, shows progress, blocks dismissal during install and exports through its own flow', async ({
  page,
}) => {
  const state = fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  state.profiles = {
    schemaVersion: 1,
    activeId: id,
    items: [{ id, name: 'Default', selection: [] }],
    unsaved: false,
    differences: [],
    unmanagedCount: 0,
  };
  await mockDesktop(page, state, { 'profileTransfer:install': 'hold' });
  await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
  await page.getByRole('button', { name: 'Import profile from file' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Import as Shared run');
  await expect(dialog).toContainText('Download required');
  await page.getByRole('button', { name: 'Install required mods and import' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.requestsTest.progress({ modId: 'fixture', phase: 'downloading', percent: 50 }),
  );
  await expect(dialog).toContainText('Downloading');
  await expect(dialog).toContainText('50%');
  await page.evaluate(() => window.requestsTest.finish('profileTransfer:install'));
  await expect(dialog).toContainText('Shared run is ready');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Export Default', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Default was exported to your chosen location.',
  );
});
test('Custom Lua is a metadata-and-source workspace without guided controls or code decoding', async ({
  page,
}) => {
  const state = fixture();
  state.settings.creatorEnabled = true;
  state.settings.creatorAcknowledged = true;
  const project = editorProject('joker');
  project.draft.mode = 'custom';
  project.draft.content = { type: 'blank', name: 'Custom source' };
  project.draft.lua = '-- authored mod\nreturn 77';
  await mockDesktop(page, state, {}, project);
  await page.getByRole('button', { name: 'Create mods', exact: true }).click();
  await page.getByRole('button', { name: 'UI mod 0 builds', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Custom Lua workspace' })).toBeVisible();
  for (const name of ['Joker rarity', 'Starting-card mode', 'Redemption effect', 'Joker name'])
    await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to guided builder' })).toHaveCount(0);
  await page.getByLabel('main.lua source', { exact: true }).fill('-- pasted code\nreturn 99');
  await page.getByLabel('Mod name', { exact: true }).fill('My own mod');
  await page.getByLabel('Mod description', { exact: true }).fill('My own behaviour');
  await expect(page.getByLabel('main.lua source', { exact: true })).toHaveValue(
    '-- pasted code\nreturn 99',
  );
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Custom Lua', exact: true })).toBeVisible();
});
for (const action of ['Got it', 'Close dialog', 'Escape', 'Open experimental settings']) {
  test(`creator announcement persists ${action} dismissal without enabling the feature`, async ({
    page,
  }) => {
    const state = fixture();
    state.settings.dismissedAnnouncements = undefined;
    await mockDesktop(page, state);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('New: Experimental Mod Creator');
    await expect(dialog).toContainText('dedicated Joker, Deck and Voucher builders');
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(() => window.requestsTest.state.settings.dismissedAnnouncements),
    ).toContain('mod-creator-introduction');
    expect(await page.evaluate(() => window.requestsTest.state.settings.creatorEnabled)).not.toBe(
      true,
    );
    if (action === 'Open experimental settings')
      await expect(
        page.getByRole('heading', { name: 'Experimental features', exact: true }),
      ).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });
}

test('background clicks and lost focus keep the announcement open without saving a dismissal', async ({
  page,
}) => {
  const state = fixture();
  state.settings.dismissedAnnouncements = undefined;
  await mockDesktop(page, state);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('New: Experimental Mod Creator');
  await page.mouse.click(3, 3);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => window.requestsTest.state.settings.dismissedAnnouncements),
  ).toBeUndefined();
  await dialog.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test('creator announcement waits for loaded settings and onboarding and remains dismissed after version changes', async ({
  page,
}) => {
  const state = fixture();
  state.settings.dismissedAnnouncements = undefined;
  await mockDesktop(page, state, { snapshot: 'hold' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const changed = {
    ...state,
    appVersion: '99.0.0',
    settings: { ...state.settings, dismissedAnnouncements: ['mod-creator-introduction'] },
  };
  await page.evaluate(
    (value) => window.requestsTest.finish('snapshot', { ok: true, value }),
    changed,
  );
  await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('creator announcement does not stack over onboarding or recovery', async ({ page }) => {
  const state = fixture(false);
  state.settings.dismissedAnnouncements = undefined;
  await mockDesktop(page, state);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Welcome to Modatro.');
  await expect(page.getByRole('heading', { name: 'New: Experimental Mod Creator' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse for now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New: Experimental Mod Creator' })).toBeVisible();
});
function editorProject(type: ContentType): CreatorProject {
  const id = '11111111-1111-4111-8111-111111111111';
  const draft = {
    configVersion: 2 as const,
    name: 'UI mod',
    author: 'Author',
    description: 'Local test',
    version: '1.0.0',
    ...creatorIdentities(id),
    content: defaultContent(type, 'Example ' + type),
    artwork: { source: 'builtin' as const, builtinId: type + '-1' },
    mode: 'template' as const,
    lua: '',
    crop: { x: 0.5, y: 0.5, zoom: 1 },
  };
  draft.lua = generateLua(draft);
  return {
    schemaVersion: 2,
    id,
    draft,
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
    builds: [],
    token: 'a'.repeat(64),
    previewUrl: '',
  };
}
test('Joker retriggers use appropriate conditions and show standard description highlights', async ({
  page,
}) => {
  const state = fixture();
  state.settings.creatorEnabled = true;
  state.settings.creatorAcknowledged = true;
  await mockDesktop(page, state, {}, editorProject('joker'));
  await page.getByRole('button', { name: 'Create mods', exact: true }).click();
  await page.getByRole('button', { name: 'UI mod 0 builds', exact: true }).click();
  const rule = page.locator('.creator-rule').first();
  await expect(
    rule.getByLabel('Then', { exact: true }).locator('option[value="repetitions"]'),
  ).toHaveCount(0);
  await rule.getByLabel('When', { exact: true }).selectOption('scored');
  await rule.getByLabel('Then', { exact: true }).selectOption('repetitions');
  await rule.getByLabel('Additional retriggers').fill('2');
  await rule.getByLabel('Add condition', { exact: true }).selectOption('ranks');
  await rule.getByRole('checkbox', { name: 'King', exact: true }).uncheck();
  await rule.getByRole('checkbox', { name: 'Jack', exact: true }).check();
  await rule.getByLabel('Add condition', { exact: true }).selectOption('position');
  await rule.getByLabel('Position in scoring hand', { exact: true }).selectOption('last');
  await expect(page.getByLabel('Joker description', { exact: true })).toHaveValue(
    /Retrigger.*Jack.*2.*last/,
  );
  const preview = page.getByRole('group', { name: 'In-game description styling preview' });
  await expect(preview.locator('.creator-loc-attention').filter({ hasText: 'Jack' })).toBeVisible();
  await expect(preview).not.toContainText('{C:');
  await rule.getByLabel('When', { exact: true }).selectOption('main');
  await expect(rule.getByLabel('Then', { exact: true })).toHaveValue('mult');
  await expect(rule.getByLabel('Position in scoring hand', { exact: true })).toHaveCount(0);
  await rule.getByLabel('Then', { exact: true }).selectOption('xmult');
  await expect(preview.locator('.creator-loc-bg-mult')).toHaveText('X2');
  await page.getByRole('button', { name: 'Write a manual description' }).click();
  await page.getByLabel('Joker description', { exact: true }).fill('{C:chips}+25{} Chips');
  await expect(preview.locator('.creator-loc-chips')).toHaveText('+25');
  await page.getByLabel('Joker name', { exact: true }).fill('New name');
  await expect(page.getByLabel('Joker description', { exact: true })).toHaveValue(
    '{C:chips}+25{} Chips',
  );
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

for (const type of ['joker', 'deck', 'voucher'] as const) {
  test(`${type} has dedicated controls, descriptions, artwork selection and responsive layout`, async ({
    page,
  }) => {
    const state = fixture();
    state.settings.creatorEnabled = true;
    state.settings.creatorAcknowledged = true;
    await mockDesktop(page, state, {}, editorProject(type));
    await page.getByRole('button', { name: 'Create mods', exact: true }).click();
    await page.getByRole('button', { name: 'UI mod 0 builds', exact: true }).click();
    const title = type === 'joker' ? 'Joker' : type === 'deck' ? 'Deck' : 'Voucher';
    await expect(
      page.getByRole('heading', { name: title + ' builder', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel(title + ' name', { exact: true })).toHaveValue('Example ' + type);
    await expect(
      page.getByRole('button', { name: 'Amethyst ' + title + ' artwork', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Ocean ' + title + ' artwork', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Ocean ' + title + ' artwork', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    if (type === 'joker') {
      await expect(page.getByLabel('Purchase cost', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Starting-card mode')).toHaveCount(0);
      await page.getByLabel('Joker rarity').selectOption('Legendary');
      await expect(page.getByText(/acquired through The Soul/)).toBeVisible();
      await page.getByRole('button', { name: 'Add rule', exact: true }).click();
      await expect(page.locator('.creator-rule')).toHaveCount(2);
      await page.getByRole('button', { name: 'Move rule 2 up', exact: true }).click();
      await page
        .locator('.creator-rule')
        .first()
        .getByLabel('When', { exact: true })
        .selectOption('round');
      await expect(
        page.locator('.creator-rule').first().getByLabel('Then', { exact: true }),
      ).toHaveValue('dollars');
    } else if (type === 'deck') {
      await expect(page.getByLabel('Joker rarity')).toHaveCount(0);
      await expect(page.getByLabel('When', { exact: true })).toHaveCount(0);
      await page.getByLabel('Starting-card mode').selectOption('modified');
      await page
        .getByLabel('Remove all face cards (Jacks, Queens and Kings)', { exact: true })
        .check();
      await expect(page.getByLabel('Starting composition preview')).toContainText(
        'Total cards: 40',
      );
      await expect(page.getByRole('checkbox', { name: 'King', exact: true })).not.toBeChecked();
      await page.getByRole('checkbox', { name: 'King', exact: true }).check();
      await expect(
        page.getByLabel('Remove all face cards (Jacks, Queens and Kings)', { exact: true }),
      ).not.toBeChecked();
      await page.getByLabel('Starting-card mode').selectOption('rank');
      await page.getByLabel('Total starting deck size').fill('41');
      await expect(page.getByLabel('Starting composition preview')).toContainText(
        '11 Hearts, 10 Diamonds, 10 Clubs, 10 Spades',
      );
      await page.getByLabel('Starting-card mode').selectOption('standard');
      await expect(page.getByLabel('Total starting deck size')).toHaveCount(0);
      await page.getByLabel('Starting-card mode').selectOption('rank');
      await expect(page.getByLabel('Total starting deck size')).toHaveValue('41');
    } else {
      await expect(page.getByLabel('Joker rarity')).toHaveCount(0);
      await expect(page.getByLabel('When', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Starting-card mode')).toHaveCount(0);
      await page.getByLabel('Redemption effect').selectOption('hands');
      await expect(
        page.getByText(
          'Increases the allowance for future rounds. Does not immediately grant additional remaining hands or discards.',
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Add redemption effect' }).click();
      await expect(page.locator('.creator-redemption')).toHaveCount(2);
    }
    await page.getByRole('button', { name: 'Write a manual description' }).click();
    await page.getByLabel(title + ' description', { exact: true }).fill('My manual description');
    await page.getByLabel(title + ' name', { exact: true }).fill('Renamed');
    await expect(page.getByLabel(title + ' description', { exact: true })).toHaveValue(
      'My manual description',
    );
    await page.getByRole('button', { name: 'Restore automatic description' }).click();
    await expect(page.getByLabel(title + ' description', { exact: true })).not.toHaveValue(
      'My manual description',
    );
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByRole('button', { name: 'Use Custom Lua' }).click();
    await page
      .getByLabel('main.lua source', { exact: true })
      .fill('-- preserved custom\nreturn 77');
    await expect(page.getByLabel(title + ' name', { exact: true })).toHaveCount(0);
    await page.getByLabel('Mod name', { exact: true }).fill('Custom title');
    await expect(page.getByLabel('main.lua source', { exact: true })).toHaveValue(
      '-- preserved custom\nreturn 77',
    );
  });
}
test('application updates stay quiet and open the installer only after a user click', async ({
  page,
}) => {
  const state = fixture();
  state.appUpdate = {
    checking: false,
    version: '0.2.42',
    releaseUrl:
      'https://github.com/NorthernBranch/modatro/releases/tag/v0.2.42-beta.build.42.aaaaaaa',
    downloadUrl:
      'https://github.com/NorthernBranch/modatro/releases/download/v0.2.42-beta.build.42.aaaaaaa/Modatro-Setup-0.2.42.exe',
  };
  await mockDesktop(page, state);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.requestsTest.calls.openLink ?? 0)).toBe(0);
  await page.getByRole('button', { name: 'Update available', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Application updates', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.openLink ?? 0)).toBe(0);
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.openLink)).toBe(1);
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.checkAppUpdates)).toBe(1);
  expect(await page.evaluate(() => window.requestsTest.calls.openLink)).toBe(1);
});
interface MockRequests {
  backupDeletes: string[];
  state: Snapshot;
  calls: Record<string, number>;
  actions: {
    id: string;
    action: string;
    token?: string;
    acceptedUnverified?: UnverifiedPrerequisite[];
    developmentDependencies?: string[];
    selectedVersions?: { id: string; key: string }[];
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
      dismissedAnnouncements: ['mod-creator-introduction'],
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
async function mockDesktop(
  page: Page,
  state = fixture(),
  behavior: Record<string, Behavior> = {},
  project?: CreatorProject,
) {
  await page.addInitScript(
    ({ state, behavior, project }) => {
      const remembered = localStorage.getItem('announcement-test-dismissals');
      if (remembered) state.settings.dismissedAnnouncements = JSON.parse(remembered);
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
        backupDeletes: [],
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
        initialTheme: state.settings.theme,
        setupRecovery: (request) =>
          request.operation === 'review'
            ? call('setupRecovery:review', {
                status: 'review' as const,
                plan: {
                  mode: request.mode,
                  token: '22222222-2222-4222-8222-222222222222',
                  gamePath: '/fixture/Balatro',
                  modsPath: '/fixture/Mods',
                  records: control.state.localMods
                    .filter((mod) => mod.managed)
                    .map((mod) => ({ id: mod.id, title: mod.title })),
                  files:
                    request.mode === 'reset'
                      ? [
                          { root: 'game' as const, path: 'version.dll', sizeBytes: 1024 },
                          { root: 'game' as const, path: 'winmm.dll', sizeBytes: 1024 },
                        ]
                      : [],
                  sizeBytes: request.mode === 'reset' ? 2048 : 0,
                  warnings: [],
                },
              })
            : call('setupRecovery:apply', {
                status: 'complete' as const,
                snapshot: { ...control.state, localMods: [] },
                backupFolder: '/fixture/data/backups/setup-resets/example',
              }),
        releaseOptions: (id) =>
          call('releaseOptions', {
            id,
            title: control.state.catalogue.mods.find((entry) => entry.id === id)?.title ?? id,
            versions: [
              {
                key: 'thunderstore:old',
                version: '0.9.0',
                source: 'Thunderstore',
                compatibility: 'compatible',
                reason:
                  'Published requirements fit the proposed plan. Runtime metadata still needs inspection.',
              },
            ],
            development: {
              available: true,
              reason: 'Optional upstream development code. Retry after changing installed mods.',
            },
          }),
        restoreMod: () => call('restoreMod', control.state),
        deleteRemovedBackup: (id) => {
          control.backupDeletes.push(id ?? 'all');
          return call('deleteRemovedBackup', {
            snapshot: control.state,
            deleted: 0,
            retained: control.state.removedModsStorage?.count ?? 0,
          });
        },
        profileTransfer: (request) =>
          call(
            'profileTransfer:' + request.operation,
            request.operation === 'choose-import'
              ? {
                  status: 'review',
                  token: '22222222-2222-4222-8222-222222222222',
                  name: 'Shared run',
                  mods: [
                    { title: 'Test mod', version: '1.0.0', enabled: true, status: 'download' },
                  ],
                  blockers: [],
                  warnings: [],
                }
              : request.operation === 'install'
                ? {
                    status: 'complete',
                    name: 'Shared run',
                    profileId: '22222222-2222-4222-8222-222222222222',
                    snapshot: control.state,
                  }
                : request.operation === 'export'
                  ? { status: 'exported', name: 'Default' }
                  : { status: 'cancelled', snapshot: control.state },
          ),
        creator: async (request) => {
          if (!project) throw new Error('No project fixture');
          if (request.operation === 'save') project = { ...project, draft: request.draft };
          return {
            ok: true,
            value: {
              projects: [
                {
                  id: project.id,
                  name: project.draft.name,
                  updatedAt: project.updatedAt,
                  builds: 0,
                },
              ],
              project: request.operation === 'list' ? undefined : project,
            },
          };
        },
        checkAppUpdates: () => call('checkAppUpdates', control.state),
        githubStars: async () => ({ ok: true, value: { fixture: 42, popular: 1200, zero: 0 } }),
        snapshot: () => call('snapshot', control.state),
        profileOperation: () => call('profileOperation', control.state),
        previewProfile: (id) =>
          call('previewProfile', {
            profileId: id,
            name: control.state.profiles!.items.find((profile) => profile.id === id)!.name,
            token: '33333333-3333-4333-8333-333333333333',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            selection: [],
            enable: [],
            disable: [],
            retained: [],
            blockers: [],
            warnings: [],
          }),
        switchProfile: () => call('switchProfile', control.state),
        previewPlan: (id) =>
          call('previewPlan', {
            modId: id,
            version: '1.0.0',
            create: [],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
          }),
        troubleshoot: () =>
          call('troubleshoot', {
            generatedAt: new Date().toISOString(),
            appVersion: control.state.appVersion,
            platform: control.state.platform,
            arch: control.state.arch,
            prerequisites: [],
            mods: [],
            findings: [],
            history: [],
            logs: [],
            report: 'Synthetic support report',
          }),
        detect: () => call('detect', control.state),
        refresh: () => call('refresh', control.state),
        choosePath: () => call('choosePath', control.state),
        selectCandidate: () => call('selectCandidate', control.state),
        saveSettings: async (settings) => {
          const reply = await call('saveSettings', {
            ...control.state,
            settings: { ...control.state.settings, ...settings },
          });
          if (reply.ok) {
            control.state = reply.value;
            localStorage.setItem(
              'announcement-test-dismissals',
              JSON.stringify(reply.value.settings.dismissedAnnouncements ?? []),
            );
          }
          return reply;
        },
        action: (
          id,
          action,
          _decisions,
          token,
          acceptedUnverified,
          developmentDependencies,
          selectedVersions,
        ) => {
          control.actions.push({
            id,
            action,
            token,
            acceptedUnverified,
            developmentDependencies,
            selectedVersions,
          });
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
    { state, behavior, project },
  );
  await page.goto('/');
}
async function closeError(page: Page) {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Let’s sort this out.' }) });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

test('Troubleshooting waits for profile deletion even when the active name remains Default', async ({
  page,
}) => {
  const state = fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  state.profiles = {
    schemaVersion: 1,
    activeId: id,
    items: [{ id, name: 'Default', selection: [] }],
    unsaved: false,
    differences: [],
    unmanagedCount: 0,
  };
  await mockDesktop(page, state, { profileOperation: 'hold' });
  await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Default', exact: true }).click();
  await page.getByLabel('Preserve the current selection as a new Default profile').check();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByText('Active: Default', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.profileOperation)).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh setup checks', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.requestsTest.calls.troubleshoot ?? 0)).toBe(0);
  await page.evaluate(() => window.requestsTest.finish('profileOperation'));
  await expect(page.getByRole('heading', { name: 'Setup overview', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.troubleshoot)).toBe(1);
});

for (const installed of [false, true]) {
  test(`Troubleshooting groups mods and ${installed ? 'shows installed' : 'hides absent'} Talisman`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: installed ? 375 : 1440, height: 1000 });
    await mockDesktop(page, fixture(), { troubleshoot: 'hold' });
    await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
    await page.evaluate((installed) => {
      window.requestsTest.finish('troubleshoot', {
        ok: true,
        value: {
          generatedAt: new Date().toISOString(),
          appVersion: '0.4.0',
          platform: 'win32',
          arch: 'x64',
          prerequisites: [
            { id: 'Lovely', installed: false },
            { id: 'Steamodded', installed: true, version: '1.0.0' },
            { id: 'Talisman', installed, version: installed ? '2.7.0' : undefined },
            { id: 'ActiveMod', installed: true, version: '1.0.0' },
          ],
          mods: [
            { id: 'active', title: 'Active mod', version: '1.0.0', enabled: true, managed: true },
            { id: 'inactive', title: 'Inactive mod', enabled: false, managed: true },
            { id: 'external', title: 'External mod', managed: false },
          ],
          findings: [],
          history: [],
          logs: [],
          report: 'Synthetic report',
        },
      });
    }, installed);
    const overview = page.locator('.troubleshooting-section').filter({
      has: page.getByRole('heading', { name: 'Setup overview', exact: true }),
    });
    await expect(overview).toBeVisible();
    const prerequisites = overview.locator('.diagnostic-prerequisites');
    await expect(prerequisites).not.toContainText('Lovely');
    await expect(prerequisites).not.toContainText('ActiveMod');
    await expect(prerequisites).not.toContainText('Missing');
    await expect(prerequisites).toContainText('Steamodded: Installed');
    if (installed) await expect(prerequisites).toContainText('Talisman: Installed · 2.7.0');
    else await expect(prerequisites).not.toContainText('Talisman');
    for (const [group, title, detail] of [
      ['Enabled mods', 'Active mod', 'active · 1.0.0 · Managed'],
      ['Disabled mods', 'Inactive mod', 'inactive · Version unknown · Managed'],
      ['Enabled state unknown', 'External mod', 'external · Version unknown · Unmanaged'],
    ]) {
      const region = overview.getByRole('region', { name: group, exact: true });
      await expect(region.getByRole('listitem')).toHaveCount(1);
      await expect(region.getByRole('listitem')).toContainText(title!);
      await expect(region.getByRole('listitem')).toContainText(detail!);
    }
    expect(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });
}

test('large preview file lists start collapsed and expand on demand', async ({ page }) => {
  await mockDesktop(page, fixture(), { previewPlan: 'hold' });
  await page
    .locator('.mod-card')
    .getByRole('button', { name: /View details/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Preview file changes', exact: true }).click();
  await page.evaluate(() => {
    window.requestsTest.finish('previewPlan', {
      ok: true,
      value: {
        modId: 'fixture',
        version: '1.0.0',
        create: Array.from({ length: 200 }, (_, index) => ({
          root: 'mods',
          path: `Fixture/file-${index}.lua`,
        })),
        replace: [],
        remove: [],
        prerequisites: [],
        conflicts: [],
      },
    });
  });
  const files = dialog.locator('details');
  await expect(files.locator('summary')).toContainText('Create 200');
  await expect(files).not.toHaveAttribute('open');
  await expect(files.getByText('create: mods/Fixture/file-199.lua', { exact: true })).toBeHidden();
  await files.locator('summary').click();
  await expect(files).toHaveAttribute('open', '');
  await expect(files.getByText('create: mods/Fixture/file-199.lua', { exact: true })).toBeVisible();
  await files.locator('summary').click();
  await expect(files).not.toHaveAttribute('open');
});

test('profile actions stay concise and switching cannot be dismissed until it finishes', async ({
  page,
}) => {
  const state = fixture();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  state.profiles = {
    schemaVersion: 1,
    activeId: first,
    items: [
      { id: first, name: 'Default', selection: [] },
      { id: second, name: 'Other', selection: [] },
    ],
    unsaved: false,
    differences: [],
    unmanagedCount: 0,
  };
  await mockDesktop(page, state, { switchProfile: 'hold' });
  await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create profile from current selection', exact: true })
    .click();
  await page.getByLabel('Profile name', { exact: true }).fill('Unsaved profile name');
  await page.mouse.click(2, 2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
    'Unsaved profile name',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const action of ['Rename', 'Duplicate', 'Delete'])
    await expect(page.getByRole('button', { name: `${action} Other`, exact: true })).toHaveText(
      action,
    );
  await expect(
    page.getByRole('button', { name: 'Review switch to Other', exact: true }),
  ).toHaveText('Review switch');
  await page.getByRole('button', { name: 'Review switch to Other', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review profile: Other' });
  await dialog.getByRole('button', { name: 'Confirm profile switch' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Applying selection…', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText('Switching profile');
  await page.keyboard.press('Escape');
  await page.mouse.click(1, 1);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.switchProfile)).toBe(1);
  await page.evaluate(() =>
    window.requestsTest.finish('switchProfile', {
      ok: false,
      error: { message: 'Switch blocked fixture' },
    }),
  );
  await closeError(page);
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Profile', { exact: true }).selectOption(second);
  await dialog.getByRole('button', { name: 'Confirm profile switch' }).click();
  await page.evaluate((id) => {
    window.requestsTest.state.profiles!.activeId = id;
    window.requestsTest.finish('switchProfile');
  }, second);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Profile', { exact: true })).toHaveValue(second);
});

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

for (const theme of ['light', 'balatro', 'balatro-dark', 'system'] as const) {
  test(`startup keeps ${theme} while library loading is pending or fails`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const state = fixture();
    state.settings.theme = theme;
    const expected = theme === 'system' ? 'light' : theme;
    await mockDesktop(page, state, { snapshot: 'hold' });
    await expect(page.getByRole('heading', { name: 'Loading Modatro…' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected);
    await page.evaluate(() => window.requestsTest.reject('snapshot'));
    await expect(page.getByRole('heading', { name: 'Modatro could not load' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected);
    await closeError(page);
    if (theme === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await page.evaluate(() => {
      window.requestsTest.behavior.snapshot = 'success';
    });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Make the game your own.' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected);
  });
}

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

test('GitHub stars sort mods by popularity, with zero ahead of unknown counts', async ({
  page,
}) => {
  const state = fixture();
  const original = state.catalogue.mods[0]!;
  state.catalogue.mods = [
    original,
    { ...original, id: 'unknown', title: 'Unknown' },
    { ...original, id: 'zero', title: 'Zero' },
    { ...original, id: 'popular', title: 'Popular' },
  ];
  await mockDesktop(page, state);
  await expect(page.getByLabel('42 GitHub stars', { exact: true })).toBeVisible();
  await expect(page.getByLabel('0 GitHub stars', { exact: true })).toBeVisible();
  await page.getByLabel('Sort mods', { exact: true }).selectOption('popular');
  await expect(page.locator('.mod-card h3')).toHaveText([
    'Popular',
    'Fixture mod',
    'Zero',
    'Unknown',
  ]);
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByLabel('1200 GitHub stars', { exact: true })).toBeVisible();
  await page.getByLabel('Search mods', { exact: true }).fill('Fixture');
  await expect(page.locator('.mod-card h3')).toHaveText(['Fixture mod']);
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
  await expect(page.locator('.operation-toast')).toContainText('Preparing installation');
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
  await expect(toast).toContainText('Downloading files 12%');
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
  await expect(details.getByRole('status')).toContainText('Preparing installation');
  for (const [phase, label] of [
    ['downloading', 'Downloading files'],
    ['validating', 'Checking downloaded files'],
    ['planning', 'Checking install plan'],
    ['installing', 'Installing files'],
  ] as const) {
    await page.evaluate(
      (phase) => window.requestsTest.progress({ modId: 'fixture', phase }),
      phase,
    );
    await expect(details.getByRole('status')).toContainText(label);
    await expect(details.getByRole('button', { name: `${label}…`, exact: true })).toBeDisabled();
    await expect(page.locator('.operation-toast')).toContainText(label);
    if (phase !== 'installing') {
      await expect(details.getByRole('status')).not.toContainText('Installing');
      await expect(page.locator('.operation-toast')).not.toContainText('Installing');
    }
  }
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
  await expect(dialog.getByRole('button', { name: 'Preparing Talisman…' })).toBeDisabled();
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

test('source records, filenames and error paths wrap across pages and viewport widths', async ({
  page,
}) => {
  const state = fixture();
  const segment = 'LongUnbrokenName'.repeat(10);
  const url = `https://github.com/tests/${segment}/archive/refs/tags/26.1002.0.zip`;
  const path = `fixture/${segment}.lua`;
  const provenance = {
    sourceType: 'tag' as const,
    repositoryUrl: `https://github.com/tests/${segment}`,
    downloadUrl: url,
    releaseTag: '26.1002.0',
    sha256: 'a'.repeat(64),
  };
  for (const id of ['Lovely', 'Steamodded', 'Talisman']) {
    const value = {
      id,
      displayName: id,
      installed: true,
      installedVersion: '26.1002.0',
      latestVersion: '26.1002.0',
      sourceUrl: provenance.repositoryUrl,
      provenance,
    };
    const existing = state.prerequisites.find((p) => p.id === id);
    if (existing) Object.assign(existing, value);
    else state.prerequisites.push(value);
  }
  state.catalogue.mods[0]!.repositoryUrl = provenance.repositoryUrl;
  state.catalogue.mods[0]!.title = segment;
  state.localMods.push({
    id: 'fixture',
    title: 'Fixture mod',
    version: '1.0.0',
    state: 'broken',
    managed: true,
    folderName: 'fixture',
    canAdopt: false,
    provenance,
    files: [{ root: 'mods', path, operation: 'created' }],
    problems: [`Could not verify ${path}`],
  });
  state.settings.gamePath = `/game/${segment}`;
  state.settings.modsPath = `/mods/${segment}`;
  await mockDesktop(page, state, { previewPlan: 'hold', launch: 'hold' });
  const assertContained = async () => {
    const clipped = await page.evaluate(() => {
      const scope =
        document.querySelector('dialog[open]') ?? document.querySelector('.main-content')!;
      const failures: string[] = [];
      for (const element of scope.querySelectorAll<HTMLElement>('p, code, dd, li, h2, h3')) {
        if (
          !element.getClientRects().length ||
          element.closest('details:not([open]) > :not(summary)')
        )
          continue;
        const style = getComputedStyle(element);
        if (style.textOverflow === 'ellipsis' || Number.parseInt(style.webkitLineClamp) > 0)
          continue;
        if (element.scrollWidth > element.clientWidth + 1)
          failures.push(element.textContent!.slice(0, 100));
        const range = document.createRange();
        range.selectNodeContents(element);
        const boundary = (
          element.closest('.prerequisite-card, .local-row, dialog') ?? scope
        ).getBoundingClientRect();
        if (
          [...range.getClientRects()].some(
            (rect) =>
              rect.width && (rect.left < boundary.left - 1 || rect.right > boundary.right + 1),
          )
        )
          failures.push(`Outside container: ${element.textContent!.slice(0, 100)}`);
      }
      return failures;
    });
    expect(clipped).toEqual([]);
  };
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await assertContained();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await assertContained();
    await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Setup overview', exact: true })).toBeVisible();
    await assertContained();
    await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
    for (const source of await page.locator('.prerequisite-card details').all()) {
      if ((await source.getAttribute('open')) === null) await source.locator('summary').click();
    }
    await expect(
      page.locator('.prerequisite-card').first().getByText(url, { exact: true }),
    ).toBeVisible();
    await assertContained();
    if (width === 1440 || width === 375)
      await page.screenshot({
        path: `test-results/prerequisite-source-${width}.png`,
        fullPage: true,
      });
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /^Installed/ })
      .click();
    for (const source of await page.locator('.local-row details').all()) {
      if ((await source.getAttribute('open')) === null) await source.locator('summary').click();
    }
    await assertContained();
    await page.getByRole('button', { name: 'Fixture mod', exact: true }).click();
    await assertContained();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Preview file changes', exact: true }).click();
    await page.evaluate(
      (path) =>
        window.requestsTest.finish('previewPlan', {
          ok: true,
          value: {
            modId: 'fixture',
            version: '1.0.0',
            create: [{ root: 'mods', path }],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
          },
        }),
      path,
    );
    await dialog.locator('details summary').click();
    await assertContained();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await assertContained();
    await page.getByRole('button', { name: /^Launch (Modded )?Balatro$/ }).click();
    await page.evaluate(
      (path) =>
        window.requestsTest.finish('launch', {
          ok: false,
          error: { message: `Cannot access ${path}` },
        }),
      path,
    );
    await assertContained();
    await closeError(page);
  }
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
  });
  const files = page.getByRole('dialog').locator('details');
  await expect(files).not.toHaveAttribute('open');
  await expect(files.getByText('replace: game/game.lua', { exact: true })).toBeHidden();
  await files.locator('summary').click();
  await expect(files.getByText('replace: game/game.lua', { exact: true })).toBeVisible();
  await files.locator('summary').click();
  await expect(page.getByRole('dialog')).toContainText('Required package 1.2.0');
  await expect(page.getByRole('dialog')).toContainText('Fixture mod requires Required package');
  await expect(page.getByRole('dialog')).toContainText('Nothing has been installed yet.');
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
  await expect(page.locator('.operation-toast')).toContainText('Checking reviewed files');
  await page.evaluate(() =>
    window.requestsTest.progress({ modId: 'fixture', phase: 'validating' }),
  );
  await expect(page.locator('.operation-toast')).toContainText('Checking downloaded files');
  await expect(page.locator('.operation-toast')).not.toContainText('Downloading');
  await page.evaluate(() => window.requestsTest.finish('action'));
});
test('development dependencies require opt-in and retain that choice through file confirmation', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold' });
  await page.getByRole('button', { name: 'Install', exact: true }).first().click();
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'No compatible published release is available.',
        developmentDependency: {
          id: 'library',
          title: 'Library',
          repositoryUrl: 'https://github.com/fixture/library',
        },
      },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Development builds may be unstable');
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(1);
  await page.getByRole('button', { name: 'Try development build', exact: true }).click();
  expect(
    (await page.evaluate(() => window.requestsTest.actions)).at(-1)?.developmentDependencies,
  ).toEqual(['library']);
  await page.evaluate(() => {
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Review files',
        confirmation: {
          token: 'development-review',
          plan: {
            modId: 'fixture',
            version: '1.0.0',
            create: [],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
            packages: [
              {
                id: 'library',
                title: 'Library',
                version: '2.0.0',
                update: false,
                source: 'GitHub commit aaaaaaa',
              },
              {
                id: 'fixture',
                title: 'Fixture mod',
                version: '1.0.0',
                update: false,
                source: 'Thunderstore',
              },
            ],
          },
        },
      },
    });
    window.requestsTest.behavior.action = 'success';
  });
  await expect(page.getByRole('dialog')).toContainText('GitHub commit aaaaaaa');
  await page.getByRole('button', { name: 'Install mod and dependencies', exact: true }).click();
  const last = (await page.evaluate(() => window.requestsTest.actions)).at(-1)!;
  expect(last.token).toBe('development-review');
  expect(last.developmentDependencies).toEqual(['library']);
});

test('version selection stays available after a failed development attempt and preserves the chosen release through review', async ({
  page,
}) => {
  await mockDesktop(page, fixture(), { action: 'hold' });
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  await page.getByRole('button', { name: 'Versions and builds', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Published requirements fit');
  await page.getByRole('button', { name: 'Try development build', exact: true }).click();
  expect(
    (await page.evaluate(() => window.requestsTest.actions)).at(-1)?.developmentDependencies,
  ).toEqual(['fixture']);
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'An installed add-on rejects this version.',
        compatibility: [
          {
            modId: 'other',
            title: 'Other add-on',
            proposedVersion: '2.0.0',
            requirement: {
              id: 'Library',
              displayName: 'Library',
              required: true,
              versionConstraint: '<2.0.0',
              state: 'incompatible',
              reason: 'Rejected version',
            },
          },
        ],
      },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Other add-on');
  await expect(page.getByRole('dialog')).toContainText('Proposed version: 2.0.0');
  await page.getByRole('button', { name: 'Choose another version or build' }).click();
  await expect(
    page.getByRole('button', { name: 'Try development build', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review selected version' }).click();
  expect((await page.evaluate(() => window.requestsTest.actions)).at(-1)?.selectedVersions).toEqual(
    [{ id: 'fixture', key: 'thunderstore:old' }],
  );
  await page.evaluate(() =>
    window.requestsTest.finish('action', {
      ok: false,
      error: {
        message: 'Review old version',
        confirmation: {
          token: 'old-release-token',
          plan: {
            modId: 'fixture',
            version: '0.9.0',
            create: [],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
            packages: [
              {
                id: 'fixture',
                title: 'Fixture mod',
                version: '0.9.0',
                update: true,
                source: 'Thunderstore',
              },
            ],
          },
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Back up & install', exact: true }).click();
  expect((await page.evaluate(() => window.requestsTest.actions)).at(-1)).toMatchObject({
    token: 'old-release-token',
    selectedVersions: [{ id: 'fixture', key: 'thunderstore:old' }],
  });
  await page.evaluate(() => window.requestsTest.finish('action'));
});
test('recently uninstalled mods have a reviewed restore route using the backup service', async ({
  page,
}) => {
  const state = fixture();
  state.removedMods = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Local development mod',
      version: '0.9.0',
      removedAt: '2026-10-23T10:00:00Z',
    },
  ];
  await mockDesktop(page, state, { restoreMod: 'hold' });
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  await page.getByRole('button', { name: 'Recently uninstalled' }).click();
  await expect(page.getByText('Local development mod · 0.9.0')).toBeVisible();
  await page.getByRole('button', { name: 'Review restore', exact: true }).click();
  await page.evaluate(() =>
    window.requestsTest.finish('restoreMod', {
      ok: false,
      error: {
        message: 'Review restore',
        confirmation: {
          token: 'backup-review-token',
          plan: {
            modId: 'fixture',
            version: '0.9.0',
            create: [],
            replace: [],
            remove: [],
            prerequisites: [],
            conflicts: [],
            packages: [
              {
                id: 'fixture',
                title: 'Local development mod',
                version: '0.9.0',
                update: false,
                source: 'Uninstall backup',
              },
            ],
          },
        },
      },
    }),
  );
  await expect(page.getByRole('dialog')).toContainText('Nothing has been restored yet');
  await page.getByRole('button', { name: 'Restore from backup', exact: true }).click();
  await page.evaluate(() => window.requestsTest.finish('restoreMod'));
  expect(await page.evaluate(() => window.requestsTest.calls.restoreMod)).toBe(2);
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(0);
});

test('uninstall backup storage, confirmations and pending deletion preserve required originals', async ({
  page,
}) => {
  const state = fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  state.removedMods = [
    {
      id,
      title: 'Recoverable mod',
      version: '1.0.0',
      removedAt: '2026-10-23T10:00:00Z',
      sizeBytes: 1024 ** 2,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Required original',
      version: '1.0.0',
      removedAt: '2026-10-22T10:00:00Z',
      sizeBytes: 1024 ** 2,
      protected: true,
      installed: true,
    },
  ];
  state.removedModsStorage = { sizeBytes: 2 * 1024 ** 2, sizeIncomplete: false, count: 2 };
  await mockDesktop(page, state, { deleteRemovedBackup: 'hold' });
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Uninstall backups' });
  await panel.getByRole('button', { name: 'Recently uninstalled' }).click();
  await expect(panel).toContainText('2.0 MiB used');
  await expect(panel).toContainText('temporary and subject to automatic cleanup');
  const protectedRow = panel.locator('.conflict-item').filter({ hasText: 'Required original' });
  await expect(protectedRow.getByRole('button', { name: 'Delete backup' })).toBeDisabled();
  await expect(protectedRow.getByRole('button', { name: 'Already installed' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Delete backup' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('will no longer be available');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.requestsTest.backupDeletes)).toEqual([]);
  await panel.getByRole('button', { name: 'Delete backup' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete backup', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Deleting backups…' }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.requestsTest.backupDeletes)).toEqual([id]);
  await page.evaluate(() => {
    const state = window.requestsTest.state;
    state.removedMods = state.removedMods!.slice(1);
    state.removedModsStorage = { sizeBytes: 1024 ** 2, sizeIncomplete: false, count: 1 };
    state.removedModsError =
      '1 backup contains originals required by installations and cannot be deleted.';
    window.requestsTest.finish('deleteRemovedBackup', {
      ok: true,
      value: { snapshot: state, deleted: 1, retained: 1 },
    });
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel).toContainText('1.0 MiB used');
  await expect(panel.getByRole('alert')).toContainText('required by installations');
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('will be retained');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Clear all eligible backups' })
    .click();
  await page.evaluate(() => window.requestsTest.finish('deleteRemovedBackup'));
  expect(await page.evaluate(() => window.requestsTest.backupDeletes)).toEqual([id, 'all']);
  await expect(panel).toContainText('Required original');
});

test('backup deletion failures can be retried and refresh storage and the empty state', async ({
  page,
}) => {
  const state = fixture();
  state.removedMods = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Local copy',
      version: '1.0.0',
      removedAt: '2026-10-23T10:00:00Z',
      sizeBytes: 1024,
    },
  ];
  state.removedModsStorage = { sizeBytes: 1024, sizeIncomplete: true, count: 1 };
  state.removedModsError = 'Some backup storage could not be fully read.';
  await mockDesktop(page, state, { deleteRemovedBackup: 'error' });
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Uninstall backups' });
  await panel.getByRole('button', { name: 'Recently uninstalled' }).click();
  await expect(panel).toContainText('At least 1.0 KiB used');
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Clear all eligible backups' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('The folder is not accessible.');
  await closeError(page);
  await expect(panel).toContainText('Local copy');
  await page.evaluate(() => {
    window.requestsTest.behavior.deleteRemovedBackup = 'hold';
  });
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Clear all eligible backups' })
    .click();
  await page.evaluate(() => {
    const state = window.requestsTest.state;
    state.removedMods = [];
    state.removedModsStorage = { sizeBytes: 0, sizeIncomplete: false, count: 0 };
    state.removedModsError = undefined;
    window.requestsTest.finish('deleteRemovedBackup', {
      ok: true,
      value: { snapshot: state, deleted: 1, retained: 0 },
    });
  });
  await expect(panel).toContainText('0 B used');
  await expect(panel).toContainText('No uninstall backups.');
  await expect(panel.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Refresh backups' }).click();
  expect(await page.evaluate(() => window.requestsTest.calls.snapshot)).toBe(2);
});

test('profile dropdown opens a pending review immediately and retries failed checks inside the modal', async ({
  page,
}) => {
  const state = fixture();
  const first = '11111111-1111-4111-8111-111111111111',
    second = '22222222-2222-4222-8222-222222222222';
  state.profiles = {
    schemaVersion: 1,
    activeId: first,
    items: [
      { id: first, name: 'Default', selection: [] },
      { id: second, name: 'Other', selection: [] },
    ],
    unsaved: false,
    differences: [],
    unmanagedCount: 0,
  };
  await mockDesktop(page, state, { previewProfile: 'hold' });
  await page.getByLabel('Profile', { exact: true }).selectOption(second);
  const dialog = page.getByRole('dialog', { name: 'Review profile: Other' });
  await expect(dialog.getByRole('status')).toContainText('Checking profile selection');
  await expect(dialog.locator('.spin')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm profile switch' })).toHaveCount(0);
  await page.evaluate(() => window.requestsTest.reject('previewProfile'));
  await expect(dialog.getByRole('alert')).toContainText('Checking profile selection failed');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('status')).toContainText('Checking profile selection');
  await page.evaluate(() => window.requestsTest.finish('previewProfile'));
  await expect(dialog.getByRole('button', { name: 'Confirm profile switch' })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.calls.previewProfile)).toBe(2);
  expect(await page.evaluate(() => window.requestsTest.calls.switchProfile ?? 0)).toBe(0);
  await expect(page.getByLabel('Profile', { exact: true })).toHaveValue(first);
});
test('version history failures can be retried without installing anything', async ({ page }) => {
  await mockDesktop(page, fixture(), { releaseOptions: 'error' });
  await page.getByRole('button', { name: 'Details for Fixture mod' }).click();
  await page.getByRole('button', { name: 'Versions and builds', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('The folder is not accessible.');
  await page.evaluate(() => {
    window.requestsTest.behavior.releaseOptions = 'success';
  });
  await page.getByRole('button', { name: 'Refresh available versions' }).click();
  await expect(page.getByRole('button', { name: 'Try development build' })).toBeVisible();
  expect(await page.evaluate(() => window.requestsTest.actions.length)).toBe(0);
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
