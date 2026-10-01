import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { InstalledModsService } from '../electron/services/local-mods';
import { setup, mod, put } from './helpers';
const roots: string[] = [];
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const libraryName = ['win32', 'linux'].includes(process.platform) ? 'winmm.dll' : 'liblovely.dylib';
function lovelyBinary(extra = '') {
  return Buffer.concat([
    ['win32', 'linux'].includes(process.platform)
      ? Buffer.from('MZ')
      : Buffer.from('cffaedfe', 'hex'),
    Buffer.from(`lovely_injector_fixture${extra}`),
  ]);
}
it('detects Steamodded by structured metadata in a differently named unmanaged folder', async () => {
  const f = await fixture();
  await put(
    path.join(f.mods, 'DifferentFolder', 'manifest.json'),
    JSON.stringify({ name: 'Steamodded', version_number: '26.829.0', dependencies: [] }),
  );
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.prerequisites.find((p) => p.id === 'Steamodded')).toMatchObject({
    installed: true,
    installedVersion: '26.829.0',
  });
  expect(scan.mods[0]).toMatchObject({ managed: false, state: 'unmanaged' });
});
it('reports positive Lovely binary evidence as installed with an unknown version', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.game, libraryName), lovelyBinary());
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.prerequisites.find((p) => p.id === 'Lovely')).toMatchObject({
    installed: true,
    installedVersion: undefined,
  });
});
it('rejects an unrelated or non-native file merely named like Lovely', async () => {
  const f = await fixture();
  await put(path.join(f.game, libraryName), 'not a library, lovely');
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.prerequisites.find((p) => p.id === 'Lovely')?.installed).toBe(false);
});
it('detects positive Lovely evidence under a changed library filename', async () => {
  const f = await fixture();
  const filename =
    process.platform === 'darwin' ? 'renamed-injector.dylib' : 'renamed-injector.dll';
  await fs.writeFile(path.join(f.game, filename), lovelyBinary());
  expect(
    (await new InstalledModsService(f.storage, f.logger).scan([])).prerequisites.find(
      (p) => p.id === 'Lovely',
    )?.installed,
  ).toBe(true);
});
it('offers adoption only for a unique catalogue match in a directory', async () => {
  const f = await fixture();
  await put(
    path.join(f.mods, 'Demo', 'mod.json'),
    JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }),
  );
  const service = new InstalledModsService(f.storage, f.logger);
  const first = mod({ id: 'one@demo', title: 'Demo' });
  const second = mod({ id: 'two@demo', title: 'Demo' });
  expect((await service.scan([first])).mods[0]?.canAdopt).toBe(true);
  expect((await service.scan([first, second])).mods[0]?.canAdopt).toBe(false);
  await put(
    path.join(f.mods, 'single.lua'),
    '--- STEAMODDED HEADER\n--- MOD_ID: demo\n--- MOD_NAME: Demo',
  );
  expect(
    (await service.scan([first])).mods.find((entry) => entry.folderName === 'single.lua')?.canAdopt,
  ).toBe(false);
});
it('does not choose an arbitrary version when a prerequisite has multiple installations', async () => {
  const f = await fixture();
  for (const [folder, version] of [
    ['One', '1.0.0'],
    ['Two', '2.0.0'],
  ])
    await put(
      path.join(f.mods, folder!, 'mod.json'),
      JSON.stringify({ id: 'Steamodded', name: 'Steamodded', version }),
    );
  const prerequisite = (
    await new InstalledModsService(f.storage, f.logger).scan([])
  ).prerequisites.find((entry) => entry.id === 'Steamodded');
  expect(prerequisite).toMatchObject({ installed: true, installedVersion: undefined });
});
it('does not reuse a managed Lovely version when its actual binary was changed outside Modatro', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.stage, 'library.bin'), lovelyBinary());
  const definition = mod({
    id: 'Lovely',
    title: 'Lovely',
    version: '0.9.2',
    installation: {
      type: 'game-replacement',
      files: [{ source: 'library.bin', destination: libraryName }],
    },
  });
  await f.installer.commitPrepared(await f.installer.plan(definition, f.stage));
  const service = new InstalledModsService(f.storage, f.logger);
  expect(
    (await service.scan([])).prerequisites.find((p) => p.id === 'Lovely')?.installedVersion,
  ).toBe('0.9.2');
  await fs.writeFile(path.join(f.game, libraryName), lovelyBinary('changed externally'));
  const scan = await service.scan([]);
  expect(scan.prerequisites.find((p) => p.id === 'Lovely')).toMatchObject({
    installed: true,
    installedVersion: undefined,
  });
  expect(scan.mods.find((m) => m.id === 'Lovely')?.state).toBe('broken');
});
