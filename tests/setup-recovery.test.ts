import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, put, mod } from './helpers';
import { SetupRecoveryService } from '../electron/services/setup-recovery';
import { InstalledModsService } from '../electron/services/local-mods';
import { GameDetectionService } from '../electron/services/detection';
import { exists, hashFile } from '../electron/services/files';
import { SetupRecoveryRequestSchema } from '../src/shared/setup-recovery';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(checkpoint?: (phase: string, index?: number) => Promise<void>) {
  const f = await setup(checkpoint);
  roots.push(f.root);
  const recovery = new SetupRecoveryService(f.storage, f.installer);
  async function install() {
    await put(path.join(f.stage, 'main.lua'), '-- fixture');
    await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
    return f.storage.state.installations[0]!;
  }
  return { ...f, recovery, install };
}
it('clears all genuinely missing entries and profile references together without trying to back up nonexistent files', async () => {
  const f = await fixture();
  const record = await f.install();
  await fs.unlink(path.join(f.mods, record.files[0]!.path));
  await put(path.join(f.mods, 'outside', 'settings.json'), 'external configuration');
  const scan = await new InstalledModsService(f.storage, f.logger).scan([]);
  expect(scan.mods.find((mod) => mod.managed)?.filesMissing).toBe(true);
  const reviewed = await f.recovery.review('missing');
  expect(reviewed.plan.records.map((record) => record.id)).toEqual(['test-mod']);
  expect(reviewed.plan.files).toEqual([]);
  const completed = await f.recovery.apply(reviewed.plan.token);
  expect(f.storage.state.installations).toEqual([]);
  expect(f.storage.state.profiles!.items.every((profile) => profile.selection.length === 0)).toBe(
    true,
  );
  expect(await fs.readFile(path.join(f.mods, 'outside/settings.json'), 'utf8')).toBe(
    'external configuration',
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(completed.backupFolder, 'manifest.json'), 'utf8'),
  );
  expect(manifest.state.installations[0].modId).toBe('test-mod');
  expect(manifest.files).toEqual([]);
  expect(f.storage.state.settings).toEqual(manifest.state.settings);
});
it('preserves partially present and unverifiable installations', async () => {
  const f = await fixture();
  const record = await f.install();
  await f.storage.save({
    ...f.storage.state,
    installations: [
      {
        ...record,
        files: [...record.files, { ...record.files[0]!, path: 'test-mod/missing.lua' }],
      },
    ],
  });
  expect((await f.recovery.review('missing')).plan.records).toEqual([]);
  const target = path.join(f.mods, record.files[0]!.path);
  const original = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation((async (
    file: Parameters<typeof fs.lstat>[0],
    ...args: unknown[]
  ) => {
    if (String(file) === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return (original as Function)(file, ...args);
  }) as typeof fs.lstat);
  await expect(f.recovery.review('missing')).rejects.toThrow();
  expect(f.storage.state.installations).toHaveLength(1);
});
it('backs up and removes active, disabled and external mods and both Lovely filenames, preserving saves and creator sources', async () => {
  const f = await fixture();
  const record = await f.install();
  await f.installer.toggle(record.modId, true);
  await put(path.join(f.mods, 'external/main.lua'), 'custom mod');
  await put(path.join(f.mods, 'lovely/log/run.log'), 'old loader log');
  await put(path.join(f.game, 'winmm.dll'), 'MZ Lovely current injector');
  await put(path.join(f.game, 'version.dll'), 'MZ lovely legacy injector');
  await put(path.join(f.game, 'steam_api64.dll'), 'base game library');
  await put(path.join(f.root, 'save.jkr'), 'private saves');
  await put(f.storage.file('creator/projects/own.lua'), 'editable creator source');
  const review = await f.recovery.review('reset');
  expect(review.plan.files.filter((file) => file.root === 'game').map((file) => file.path)).toEqual(
    ['version.dll', 'winmm.dll'],
  );
  const complete = await f.recovery.apply(review.plan.token);
  expect(f.storage.state.installations).toEqual([]);
  for (const file of review.plan.files) {
    expect(await exists(path.join(f.installer.roots()[file.root], file.path))).toBe(false);
    expect(await exists(path.join(complete.backupFolder, 'files', file.root, file.path))).toBe(
      true,
    );
  }
  expect(await fs.readFile(path.join(f.game, 'steam_api64.dll'), 'utf8')).toBe('base game library');
  expect(await fs.readFile(path.join(f.root, 'save.jkr'), 'utf8')).toBe('private saves');
  expect(await fs.readFile(f.storage.file('creator/projects/own.lua'), 'utf8')).toBe(
    'editable creator source',
  );
  await f.transactions.recover();
  expect(await exists(path.join(complete.backupFolder, 'manifest.json'))).toBe(true);
});
it('keeps a verified copy of replaced originals after the old transaction backups are pruned', async () => {
  const f = await fixture();
  const record = await f.install();
  const original = `backups/${randomUUID()}/0.original`;
  await put(f.storage.file(original), 'previous original');
  const originalHash = await hashFile(f.storage.file(original));
  await f.storage.save({
    ...f.storage.state,
    installations: [
      {
        ...record,
        files: record.files.map((file) => ({
          ...file,
          operation: 'replaced',
          backupPath: original,
          originalHash,
        })),
      },
    ],
  });
  const review = await f.recovery.review('reset');
  const complete = await f.recovery.apply(review.plan.token);
  const saved = JSON.parse(
    await fs.readFile(path.join(complete.backupFolder, 'manifest.json'), 'utf8'),
  );
  const file = saved.state.installations[0].files[0];
  expect(file.backupPath).toContain('backups/setup-resets/');
  expect(await hashFile(f.storage.file(file.backupPath))).toBe(originalHash);
  await f.transactions.recover();
  expect(await exists(f.storage.file(original))).toBe(false);
  expect(await hashFile(f.storage.file(file.backupPath))).toBe(originalHash);
});
it('rejects stale, expired and reused confirmations without changing files', async () => {
  const f = await fixture();
  await put(path.join(f.mods, 'one.lua'), 'first');
  const old = await f.recovery.review('reset');
  await put(path.join(f.mods, 'new.lua'), 'arrived after review');
  await expect(f.recovery.apply(old.plan.token)).rejects.toThrow('changed');
  expect(await fs.readFile(path.join(f.mods, 'one.lua'), 'utf8')).toBe('first');
  await expect(f.recovery.apply(old.plan.token)).rejects.toThrow('expired');
  const current = await f.recovery.review('reset');
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
  await expect(f.recovery.apply(current.plan.token)).rejects.toThrow('expired');
});
it('stops before removal when a recovery copy fails', async () => {
  const f = await fixture();
  const record = await f.install();
  const before = structuredClone(f.storage.state);
  const review = await f.recovery.review('reset');
  vi.spyOn(fs, 'copyFile').mockRejectedValue(
    Object.assign(new Error('Disk full'), { code: 'ENOSPC' }),
  );
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow('backup could not be created');
  expect(f.storage.state).toEqual(before);
  expect(await exists(path.join(f.mods, record.files[0]!.path))).toBe(true);
});
it('rolls back file removals and records when commit fails', async () => {
  let fail = false;
  const f = await fixture(async (phase) => {
    if (fail && phase === 'before-state') throw new Error('Commit fixture');
  });
  const record = await f.install();
  const before = structuredClone(f.storage.state);
  const review = await f.recovery.review('reset');
  fail = true;
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow('Recovery could not finish');
  expect(f.storage.state).toEqual(before);
  expect(await exists(path.join(f.mods, record.files[0]!.path))).toBe(true);
});
it('blocks unknown DLLs and symbolic links instead of deleting them', async () => {
  const f = await fixture();
  await put(path.join(f.game, 'version.dll'), 'MZ unrelated library');
  await expect(f.recovery.review('reset')).rejects.toThrow('could not be identified as Lovely');
  await fs.unlink(path.join(f.game, 'version.dll'));
  const external = path.join(f.root, 'outside');
  await put(path.join(external, 'private.txt'), 'keep');
  await fs.symlink(external, path.join(f.mods, 'linked'), 'junction');
  await expect(f.recovery.review('reset')).rejects.toThrow('symbolic links');
  expect(await fs.readFile(path.join(external, 'private.txt'), 'utf8')).toBe('keep');
});
it('repairs a missing default Mods folder and rejects arbitrary missing overrides', async () => {
  const f = await fixture();
  const record = await f.install();
  await fs.unlink(path.join(f.mods, record.files[0]!.path));
  await fs.rmdir(path.join(f.mods, record.folderName));
  await fs.rmdir(f.mods);
  // This fixture uses the Windows detector on every host. Keep its default
  // independent of the runner's APPDATA (which is absent on Linux/macOS).
  vi.stubEnv('APPDATA', undefined);
  const defaultMods = vi
    .spyOn(GameDetectionService.prototype, 'defaultModsPath')
    .mockReturnValue(path.join(f.root, 'default', 'Mods'));
  await expect(f.recovery.review('missing')).rejects.toThrow('custom Mods folder is missing');
  defaultMods.mockReturnValue(f.mods);
  const review = await f.recovery.review('missing');
  expect(await exists(f.mods)).toBe(false);
  await f.recovery.apply(review.plan.token);
  expect(await exists(f.mods)).toBe(true);
  expect(f.storage.state.installations).toEqual([]);
});
it('preserves files when a recovery copy is corrupted before verification', async () => {
  const f = await fixture();
  const record = await f.install();
  const review = await f.recovery.review('reset');
  const original = f.storage.write.bind(f.storage);
  vi.spyOn(f.storage, 'write').mockImplementation(async (relative, value) => {
    await original(relative, value);
    if (relative.startsWith('backups/setup-resets/') && relative.endsWith('/manifest.json'))
      await fs.writeFile(
        f.storage.file(relative.replace('/manifest.json', `/files/mods/${record.files[0]!.path}`)),
        'corrupted copy',
      );
  });
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow('recovery copy changed');
  expect(await fs.readFile(path.join(f.mods, record.files[0]!.path), 'utf8')).toBe('-- fixture');
  expect(f.storage.state.installations).toHaveLength(1);
});
it('rolls back if an unreviewed file appears during the reset, leaving that new file untouched', async () => {
  let introduce = false;
  let directory = '';
  const f = await fixture(async (phase) => {
    if (introduce && phase === 'before-state')
      await put(path.join(directory, 'arrived.lua'), 'new external file');
  });
  directory = f.mods;
  const record = await f.install();
  const before = structuredClone(f.storage.state);
  const review = await f.recovery.review('reset');
  introduce = true;
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow(
    'setup changed during recovery',
  );
  expect(f.storage.state).toEqual(before);
  expect(await exists(path.join(f.mods, record.files[0]!.path))).toBe(true);
  expect(await fs.readFile(path.join(f.mods, 'arrived.lua'), 'utf8')).toBe('new external file');
});
it('refuses to reset mods that change base game files', async () => {
  const f = await fixture();
  const record = await f.install();
  const gameFile = path.join(f.game, 'Balatro.exe');
  const hash = await hashFile(gameFile);
  await f.storage.save({
    ...f.storage.state,
    installations: [
      {
        ...record,
        files: [{ ...record.files[0]!, root: 'game', path: 'Balatro.exe', installedHash: hash }],
      },
    ],
  });
  await expect(f.recovery.review('reset')).rejects.toThrow('other game files');
  expect(await hashFile(gameFile)).toBe(hash);
});
it('rechecks the game guard before applying a confirmed plan', async () => {
  const f = await fixture();
  await put(path.join(f.mods, 'external.lua'), 'keep');
  const review = await f.recovery.review('reset');
  vi.spyOn(f.installer, 'guard').mockRejectedValue(new Error('Balatro is still running'));
  await expect(f.recovery.apply(review.plan.token)).rejects.toThrow('Balatro is still running');
  expect(await fs.readFile(path.join(f.mods, 'external.lua'), 'utf8')).toBe('keep');
});
it('serializes recovery with other operations and rejects unsafe requests', async () => {
  const f = await fixture();
  await f.transactions.locked(async () => {
    await expect(f.recovery.review('reset')).rejects.toThrow('Another file operation');
  });
  expect(
    SetupRecoveryRequestSchema.safeParse({ operation: 'apply', token: 'not-a-token' }).success,
  ).toBe(false);
  expect(
    SetupRecoveryRequestSchema.safeParse({ operation: 'review', mode: 'reset', path: 'C:/' })
      .success,
  ).toBe(false);
});
