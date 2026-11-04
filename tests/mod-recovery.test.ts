import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, put, mod } from './helpers';
import { SetupRecoveryService } from '../electron/services/setup-recovery';
import { InstalledModsService } from '../electron/services/local-mods';
import { exists, hashFile } from '../electron/services/files';
import { errorReply } from '../electron/services/errors';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  await put(path.join(f.stage, 'mod.json'), JSON.stringify({ id: 'demo', version: '1.0.0' }));
  await put(path.join(f.stage, 'main.lua'), 'old code');
  await f.installer.commitPrepared(await f.installer.plan(mod({ metadataId: 'demo' }), f.stage));
  const record = f.storage.state.installations[0]!;
  const folder = path.join(f.mods, record.folderName);
  const recovery = new SetupRecoveryService(f.storage, f.installer);
  async function update() {
    await put(path.join(folder, 'mod.json'), JSON.stringify({ id: 'demo', version: '2.0.0' }));
    await fs.unlink(path.join(folder, 'main.lua'));
    await put(path.join(folder, 'new.lua'), 'updated code');
  }
  return { ...f, record, folder, recovery, update };
}
it('adopts an in-place update with added and removed files, preserving identities and profiles', async () => {
  const f = await fixture();
  const profiles = structuredClone(f.storage.state.profiles);
  await f.update();
  expect((await new InstalledModsService(f.storage, f.logger).scan([])).mods[0]).toMatchObject({
    state: 'broken',
    detectedVersion: '2.0.0',
  });
  const review = await f.recovery.review('repair', f.record.modId);
  expect(review.plan.detectedVersion).toBe('2.0.0');
  expect(review.plan.files.map((file) => file.path)).toContain(`${f.record.folderName}/new.lua`);
  const result = await f.recovery.apply(review.plan.token);
  expect(f.storage.state.profiles).toEqual(profiles);
  const current = f.storage.state.installations[0]!;
  expect(current).toMatchObject({
    modId: f.record.modId,
    metadataId: 'demo',
    modVersion: '2.0.0',
    provenance: { sourceType: 'external' },
  });
  expect(current.files.some((file) => file.path.endsWith('/main.lua'))).toBe(false);
  for (const file of current.files)
    expect(await hashFile(path.join(f.mods, file.path))).toBe(file.installedHash);
  expect(
    await fs.readFile(
      path.join(result.backupFolder, 'files/mods', f.record.folderName, 'new.lua'),
      'utf8',
    ),
  ).toBe('updated code');
  expect((await new InstalledModsService(f.storage, f.logger).scan([])).mods[0]?.state).toBe(
    'installed',
  );
  await f.installer.toggle(current.modId, true);
  await f.installer.toggle(current.modId, false);
});
it('recognizes a uniquely renamed folder and refuses duplicate identities', async () => {
  const f = await fixture();
  await f.update();
  const renamed = path.join(f.mods, 'new-version');
  await fs.rename(f.folder, renamed);
  const preview = await f.recovery.review('repair', f.record.modId);
  expect(preview.plan.detectedFolder).toBe('new-version');
  await put(path.join(f.folder, 'mod.json'), JSON.stringify({ id: 'demo', version: '1.0.0' }));
  await expect(f.recovery.apply(preview.plan.token)).rejects.toThrow('Multiple folders');
  expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
});
it('backs up and uninstalls a partially missing externally updated mod without removing other mods, and can restore the remaining files', async () => {
  const f = await fixture();
  await f.update();
  await put(path.join(f.mods, 'other/main.lua'), 'other mod');
  const review = await f.recovery.review('remove', f.record.modId);
  await f.recovery.apply(review.plan.token);
  expect(f.storage.state.installations).toHaveLength(0);
  expect(
    f.storage.state.profiles!.items.every((profile) =>
      profile.selection.every((entry) => entry.id !== f.record.modId),
    ),
  ).toBe(true);
  expect(await exists(path.join(f.folder, 'new.lua'))).toBe(false);
  expect(await fs.readFile(path.join(f.mods, 'other/main.lua'), 'utf8')).toBe('other mod');
  const removed = await f.installer.removed.list();
  expect(removed).toHaveLength(1);
  expect(removed[0]?.record.modVersion).toBe('2.0.0');
  const restore = await f.installer.restore(removed[0]!.id).catch(errorReply);
  expect(restore).toHaveProperty('confirmation');
  await f.installer.restore(
    removed[0]!.id,
    (restore as ReturnType<typeof errorReply>).confirmation!.token,
  );
  expect(await fs.readFile(path.join(f.folder, 'new.lua'), 'utf8')).toBe('updated code');
});
it('refuses changed previews and backup failures before adopting or removing files', async () => {
  const f = await fixture();
  await f.update();
  const review = await f.recovery.review('repair', f.record.modId);
  await put(path.join(f.folder, 'new.lua'), 'changed again');
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow('changed');
  const remove = await f.recovery.review('remove', f.record.modId);
  vi.spyOn(f.installer.removed, 'capture').mockRejectedValue(new Error('disk full'));
  await expect(f.recovery.apply(remove.plan.token)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.folder, 'new.lua'), 'utf8')).toBe('changed again');
  expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
});
it('clears a completely missing individual entry and rejects a mismatched identity for adoption', async () => {
  const f = await fixture();
  await put(path.join(f.folder, 'mod.json'), JSON.stringify({ id: 'different', version: '2.0.0' }));
  await expect(f.recovery.review('repair', f.record.modId)).rejects.toThrow('matching identity');
  await fs.rm(f.folder, { recursive: true });
  const preview = await f.recovery.review('remove', f.record.modId);
  expect(preview.plan.files).toEqual([]);
  await f.recovery.apply(preview.plan.token);
  expect(f.storage.state.installations).toHaveLength(0);
});
it('adopts updates while disabled and keeps them outside Mods', async () => {
  const f = await fixture();
  await f.installer.toggle(f.record.modId, true);
  const folder = f.storage.file(`disabled/${f.record.modId}/${f.record.folderName}`);
  await put(path.join(folder, 'mod.json'), JSON.stringify({ id: 'demo', version: '2.0.0' }));
  await put(path.join(folder, 'new.lua'), 'updated disabled code');
  const review = await f.recovery.review('repair', f.record.modId);
  await f.recovery.apply(review.plan.token);
  expect(f.storage.state.installations[0]).toMatchObject({ disabled: true, modVersion: '2.0.0' });
  await f.installer.toggle(f.record.modId, false);
  expect(await fs.readFile(path.join(f.folder, 'new.lua'), 'utf8')).toBe('updated disabled code');
});
it('can remove a deleted entry even when another installed mod refers to it', async () => {
  const f = await fixture();
  await put(path.join(f.mods, 'dependent/main.lua'), 'dependent');
  await f.storage.save({
    ...f.storage.state,
    installations: [
      ...f.storage.state.installations,
      {
        ...f.record,
        modId: 'dependent',
        title: 'Dependent',
        metadataId: 'dependent',
        folderName: 'dependent',
        dependencies: [
          { id: 'demo', displayName: 'Demo', required: true, versionConstraint: '<2.0.0' },
        ],
        files: [
          {
            root: 'mods',
            path: 'dependent/main.lua',
            operation: 'created',
            installedHash: await hashFile(path.join(f.mods, 'dependent/main.lua')),
          },
        ],
      },
    ],
  });
  await f.update();
  const repair = await f.recovery.review('repair', f.record.modId);
  expect(repair.plan.warnings.some((warning) => warning.includes('Dependent'))).toBe(true);
  await expect(f.recovery.review('remove', f.record.modId)).rejects.toThrow('required by');
  await fs.rm(f.folder, { recursive: true });
  const remove = await f.recovery.review('remove', f.record.modId);
  expect(remove.plan.files).toHaveLength(0);
  await f.recovery.apply(remove.plan.token);
  expect(f.storage.state.installations.map((record) => record.modId)).toEqual(['dependent']);
  expect(await exists(path.join(f.mods, 'dependent/main.lua'))).toBe(true);
});
it('preserves the old record and current files if the adoption backup fails', async () => {
  const f = await fixture();
  await f.update();
  const preview = await f.recovery.review('repair', f.record.modId);
  vi.spyOn(f.storage, 'write').mockRejectedValue(new Error('disk full'));
  await expect(f.recovery.apply(preview.plan.token)).rejects.toThrow('backup could not be created');
  expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
  expect(await fs.readFile(path.join(f.folder, 'new.lua'), 'utf8')).toBe('updated code');
});
it('adopts a standalone Lua mod through its declared identity', async () => {
  const f = await fixture();
  await fs.rm(f.folder, { recursive: true });
  const file = path.join(f.mods, 'single.lua');
  const code =
    '--- STEAMODDED HEADER\n--- MOD_NAME: Demo\n--- MOD_ID: demo\n--- MOD_AUTHOR: [Fixture]\n--- VERSION: 2.0.0\n';
  await put(file, code);
  await f.storage.save({
    ...f.storage.state,
    installations: [
      {
        ...f.record,
        folderName: 'single.lua',
        files: [
          { root: 'mods', path: 'single.lua', operation: 'created', installedHash: '0'.repeat(64) },
        ],
      },
    ],
  });
  const review = await f.recovery.review('repair', f.record.modId);
  await f.recovery.apply(review.plan.token);
  expect(f.storage.state.installations[0]).toMatchObject({
    modVersion: '2.0.0',
    folderName: 'single.lua',
    files: [{ path: 'single.lua', installedHash: await hashFile(file) }],
  });
});
