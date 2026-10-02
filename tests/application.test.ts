import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ModatroApplication } from '../electron/application';
import { tempRoot } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it('persists the optional index, preserves it across theme changes and explicitly clears it', async () => {
  const root = await tempRoot();
  roots.push(root);
  vi.stubEnv('MODATRO_TEST_DATA', root);
  const application = new ModatroApplication(
    root,
    'test',
    'test',
    () => {},
    () => {},
  );
  await application.initialize();
  const configure = vi.spyOn(application.repository, 'configureIndex').mockResolvedValue();
  const url = 'https://github.com/community/index';
  await application.saveSettings({
    theme: 'dark',
    setupComplete: false,
    modIndexUrl: `${url}.git/`,
  });
  expect(application.storage.state.settings.modIndexUrl).toBe(url);
  expect(configure).toHaveBeenLastCalledWith(url);
  await application.saveSettings({ theme: 'light', setupComplete: false });
  expect(application.storage.state.settings.modIndexUrl).toBe(url);
  await expect(
    application.saveSettings({
      theme: 'light',
      setupComplete: false,
      modIndexUrl: 'https://example.com/index',
    }),
  ).rejects.toThrow();
  expect(application.storage.state.settings.modIndexUrl).toBe(url);
  await application.saveSettings({ theme: 'light', setupComplete: false, modIndexUrl: '' });
  expect(application.storage.state.settings.modIndexUrl).toBe('');
  expect(configure).toHaveBeenLastCalledWith('');
});
it('blocks game launch while a file operation is active', async () => {
  const root = await tempRoot();
  roots.push(root);
  vi.stubEnv('MODATRO_TEST_DATA', root);
  const application = new ModatroApplication(
    root,
    'test',
    'test',
    () => {},
    () => {},
  );
  await application.initialize();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => {};
  const operation = application.transactions.locked(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  await started;
  const launch = vi.fn();
  await expect(application.launchGame(false, launch)).rejects.toThrow('Another file operation');
  expect(launch).not.toHaveBeenCalled();
  release();
  await operation;
});

it('keeps startup usable after automatic discovery fails and clears the warning after retry', async () => {
  const root = await tempRoot();
  roots.push(root);
  vi.stubEnv('MODATRO_TEST_DATA', '');
  const application = new ModatroApplication(
    root,
    'test',
    'test',
    () => {},
    () => {},
  );
  const discover = vi
    .spyOn(application.detection, 'discover')
    .mockRejectedValueOnce(new Error('Steam folder is not accessible'));
  await expect(application.initialize()).resolves.toBeUndefined();
  const snapshot = await application.snapshot();
  expect(snapshot.discoveryError).toContain('Choose your Balatro folder manually');
  expect(snapshot.settings.gamePath).toBeUndefined();
  expect(snapshot.safetyError).toBeUndefined();
  discover.mockResolvedValueOnce([]);
  expect((await application.detect()).discoveryError).toBeUndefined();
});

it('rejects a Mods folder that overlaps application data', async () => {
  const root = await tempRoot();
  roots.push(root);
  vi.stubEnv('MODATRO_TEST_DATA', root);
  const application = new ModatroApplication(
    root,
    'test',
    'test',
    () => {},
    () => {},
  );
  await application.initialize();
  vi.spyOn(application.detection, 'validateMods').mockImplementation(async (selected) => selected);
  await expect(application.setPath('mods', `${root}/Mods`)).rejects.toThrow(
    'separate from Modatro’s application data',
  );
  await expect(application.setPath('mods', root)).rejects.toThrow(
    'separate from Modatro’s application data',
  );
  expect(application.storage.state.settings.modsPath).toBeUndefined();
});
