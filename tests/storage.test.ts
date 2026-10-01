import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exists } from '../electron/services/files';
import { Storage } from '../electron/services/storage';
import { put, tempRoot } from './helpers';

const roots: string[] = [];
async function root() {
  const directory = await tempRoot();
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of roots.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('application storage startup', () => {
  it('initializes beside an existing Electron Cache without changing browser data', async () => {
    const directory = await root();
    await put(path.join(directory, 'Cache', 'browser-data'), 'chromium cache');
    const storage = new Storage(directory);
    await storage.initialize();
    await storage.save({ ...storage.state, settings: { theme: 'light', setupComplete: false } });
    const restarted = new Storage(directory);
    await restarted.initialize();
    expect(restarted.state.settings.theme).toBe('light');
    expect(await fs.readFile(path.join(directory, 'Cache', 'browser-data'), 'utf8')).toBe(
      'chromium cache',
    );
    expect(await fs.readdir(path.join(directory, 'Cache'))).toEqual(['browser-data']);
    expect((await fs.stat(path.join(directory, 'catalogue-cache'))).isDirectory()).toBe(true);
  });
  it('loads and saves existing settings through filesystem case aliases', async ({ skip }) => {
    const directory = await root();
    await fs.mkdir(path.join(directory, 'Data'));
    if (!(await exists(path.join(directory, 'data')))) skip();
    const original = new Storage(directory);
    await original.initialize();
    await original.save({ ...original.state, settings: { theme: 'light', setupComplete: false } });
    const restarted = new Storage(directory);
    await restarted.initialize();
    expect(restarted.state.settings.theme).toBe('light');
    expect(restarted.safetyError).toBeUndefined();
    await restarted.save({
      ...restarted.state,
      settings: { theme: 'system', setupComplete: false },
    });
    expect(
      JSON.parse(await fs.readFile(path.join(directory, 'Data', 'state.json'), 'utf8')).settings
        .theme,
    ).toBe('system');
  });
  it('still rejects a symbolic link in application data at startup', async () => {
    const directory = await root();
    await fs.mkdir(path.join(directory, 'outside'));
    await fs.symlink(path.join(directory, 'outside'), path.join(directory, 'data'), 'junction');
    await expect(new Storage(directory).initialize()).rejects.toThrow('symbolic');
    expect(await fs.readdir(path.join(directory, 'outside'))).toEqual([]);
  });
});
