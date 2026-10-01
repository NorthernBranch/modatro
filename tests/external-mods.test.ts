import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InstalledModsService } from '../electron/services/local-mods';
import { Storage } from '../electron/services/storage';
import { GameDetectionService } from '../electron/services/detection';
import { mod, put, setup, fakeGame } from './helpers';

const roots: string[] = [];
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it('adopts an identified mod absent from the catalogue without fabricating a download source', async () => {
  const f = await fixture();
  await put(
    path.join(f.mods, 'Manual', 'mod.json'),
    JSON.stringify({ id: 'local-only', name: 'Manual mod', version: '1.0.0' }),
  );
  await put(path.join(f.mods, 'Manual', 'main.lua'), 'original');
  expect((await new InstalledModsService(f.storage, f.logger).scan([])).mods[0]?.canAdopt).toBe(
    true,
  );
  await f.installer.adopt('Manual');
  const record = f.storage.state.installations[0]!;
  expect(record.provenance).toEqual({ sourceType: 'external' });
  expect(record.source).toBeUndefined();
  expect(await fs.readFile(path.join(f.mods, 'Manual', 'main.lua'), 'utf8')).toBe('original');
  await f.installer.toggle(record.modId, true);
  await f.installer.toggle(record.modId, false);
  await f.installer.uninstall(record.modId);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('adopts and manages standalone Lua mods while preserving unrecorded files', async () => {
  const f = await fixture();
  const contents =
    '--- STEAMODDED HEADER\n--- MOD_ID: standalone\n--- MOD_NAME: Standalone\n--- VERSION: 1.0.0\n';
  await put(path.join(f.mods, 'handmade.lua'), contents);
  await put(path.join(f.mods, 'notes.txt'), 'unrelated');
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.mods.find((m) => m.folderName === 'handmade.lua')?.canAdopt).toBe(true);
  await f.installer.adopt('handmade.lua');
  const id = f.storage.state.installations[0]!.modId;
  await f.installer.uninstall(id);
  expect(await fs.readFile(path.join(f.mods, 'notes.txt'), 'utf8')).toBe('unrelated');
});
it('never adopts unidentified directories or symlinks', async () => {
  const f = await fixture();
  await put(path.join(f.mods, 'Unknown', 'readme.txt'), 'unknown');
  await expect(f.installer.adopt('Unknown')).rejects.toThrow('identity');
  await fs.symlink(f.stage, path.join(f.mods, 'Linked'), 'junction');
  await expect(f.installer.adopt('Linked')).rejects.toThrow('symbolic');
  expect(f.storage.state.installations).toEqual([]);
});
it('keeps an adopted catalogue mod in its existing directory during an update', async () => {
  const f = await fixture();
  await put(
    path.join(f.mods, 'DifferentName', 'mod.json'),
    JSON.stringify({ id: 'test-mod', name: 'Test mod', version: '0.9.0' }),
  );
  await f.installer.adopt('DifferentName', mod());
  await put(
    path.join(f.stage, 'mod.json'),
    JSON.stringify({ id: 'test-mod', name: 'Test mod', version: '1.0.0' }),
  );
  await put(path.join(f.stage, 'main.lua'), 'updated');
  const plan = await f.installer.plan(mod(), f.stage);
  expect(plan.plan.create[0]?.path).toMatch(/^DifferentName\//);
  await f.installer.commitPrepared(plan);
  expect(await fs.readFile(path.join(f.mods, 'DifferentName', 'main.lua'), 'utf8')).toBe('updated');
});
it('protects externally edited adopted files during uninstall', async () => {
  const f = await fixture();
  await put(path.join(f.mods, 'Manual', 'mod.json'), JSON.stringify({ id: 'manual' }));
  await f.installer.adopt('Manual');
  const id = f.storage.state.installations[0]!.modId;
  await put(path.join(f.mods, 'Manual', 'mod.json'), 'edited');
  await expect(f.installer.uninstall(id)).rejects.toThrow('changed');
  expect(await fs.readFile(path.join(f.mods, 'Manual', 'mod.json'), 'utf8')).toBe('edited');
});
it('blocks ambiguous duplicate external identities instead of choosing one copy', async () => {
  const f = await fixture();
  for (const name of ['One', 'Two'])
    await put(path.join(f.mods, name, 'mod.json'), JSON.stringify({ id: 'same' }));
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.mods.every((entry) => !entry.canAdopt)).toBe(true);
});
it('backs up and migrates legacy state without losing uninstall ownership', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'installed');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  const old = {
    ...f.storage.state,
    schemaVersion: 1,
    installations: f.storage.state.installations.map(({ provenance: _, ...record }) => record),
  };
  const original = JSON.stringify(old);
  await fs.writeFile(f.storage.file('data/state.json'), original);
  const migrated = new Storage(f.storage.root);
  await migrated.initialize();
  expect(migrated.state.schemaVersion).toBe(2);
  expect(migrated.state.installations[0]?.files).toEqual(old.installations[0]?.files);
  expect(migrated.state.installations[0]?.provenance).toEqual({ sourceType: 'legacy' });
  expect(await fs.readFile(f.storage.file('data/state-v1.backup.json'), 'utf8')).toBe(original);
  const again = new Storage(f.storage.root);
  await again.initialize();
  expect(again.state).toEqual(migrated.state);
});
it('leaves the original state recoverable when a migration backup cannot be written', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'installed');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  const original = JSON.stringify({ ...f.storage.state, schemaVersion: 1 });
  await fs.writeFile(f.storage.file('data/state.json'), original);
  await fs.mkdir(f.storage.file('data/state-v1.backup.json'));
  const restart = new Storage(f.storage.root);
  await restart.initialize();
  expect(restart.safetyError).toBeTruthy();
  expect(restart.state.installations).toHaveLength(1);
  expect(await fs.readFile(f.storage.file('data/state.json'), 'utf8')).toBe(original);
});
it('recognizes the Windows Steam game under Linux Proton and uses its library-specific Mods prefix', async () => {
  const f = await fixture();
  const detection = new GameDetectionService('linux', f.root);
  expect((await detection.validate(f.game)).valid).toBe(true);
  expect(detection.defaultModsPath(f.game)).toBe(
    path.join(
      f.root,
      'steamapps',
      'compatdata',
      '2379780',
      'pfx',
      'drive_c',
      'users',
      'steamuser',
      'AppData',
      'Roaming',
      'Balatro',
      'Mods',
    ),
  );
});
it('discovers Linux Steam libraries from the local share Steam root', async () => {
  const f = await fixture();
  const steam = path.join(f.root, '.local', 'share', 'Steam');
  const game = await fakeGame(steam);
  await put(
    path.join(steam, 'steamapps', 'appmanifest_2379780.acf'),
    '"appid" "2379780"\n"installdir" "Balatro"',
  );
  expect(
    (await new GameDetectionService('linux', f.root).discover()).map((candidate) => candidate.path),
  ).toContain(game);
});
