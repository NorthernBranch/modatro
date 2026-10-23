import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ModatroApplication } from '../electron/application';
import { exists } from '../electron/services/files';
import { RecordSchema } from '../src/shared/model';
import { mod, put, setup } from './helpers';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of fixtures.splice(0)) await fs.rm(f.root, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  fixtures.push(f);
  return f;
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>, index: number, replaced = false) {
  const id = randomUUID(),
    prefix = `backups/removed/${id}`;
  const hash = createHash('sha256').update('payload').digest('hex');
  const file = {
    root: 'mods' as const,
    path: `mod-${index}/main.lua`,
    installedHash: hash,
    operation: replaced ? ('replaced' as const) : ('created' as const),
    ...(replaced ? { originalHash: hash, backupPath: `${prefix}/1.original` } : {}),
  };
  const item = {
    schemaVersion: 1,
    id,
    removedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    record: RecordSchema.parse({
      modId: `mod-${index}`,
      title: `Mod ${index}`,
      modVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00Z',
      files: [file],
      dependencies: [],
      folderName: `mod-${index}`,
      transactionId: randomUUID(),
    }),
    copies: [{ root: file.root, path: file.path, backupPath: `${prefix}/0.original`, hash }],
  };
  await put(f.storage.file(`${prefix}/0.original`), 'payload');
  if (replaced) await put(f.storage.file(`${prefix}/1.original`), 'payload');
  await f.storage.write(`${prefix}/manifest.json`, item);
  return item;
}
// Exercise real production byte thresholds without allocating gigabytes of fixture data.
function reportedSizes(sizes: Map<string, number>) {
  const lstat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation((async (file) => {
    const result = await lstat(file);
    const size = sizes.get(String(file));
    if (size !== undefined) Object.defineProperty(result, 'size', { value: size });
    return result;
  }) as typeof fs.lstat);
}
it.each(['count', 'size', 'both'] as const)(
  'prunes oldest eligible snapshots until the %s limits are satisfied',
  async (limit) => {
    const f = await fixture();
    const items: Awaited<ReturnType<typeof snapshot>>[] = [];
    for (let i = 0; i < (limit === 'size' ? 3 : 22); i++) items.push(await snapshot(f, i));
    if (limit !== 'count')
      reportedSizes(
        new Map(items.map((item) => [f.storage.file(item.copies[0]!.backupPath), 400 * 1024 ** 2])),
      );
    await f.transactions.locked(() => f.installer.removed.prune());
    const status = await f.installer.removed.inspect();
    expect(status.count).toBe(limit === 'count' ? 20 : 2);
    expect(status.sizeBytes).toBeLessThanOrEqual(1024 ** 3);
    expect(status.items.map((item) => item.id)).toEqual(
      items
        .slice(-status.count)
        .reverse()
        .map((item) => item.id),
    );
    expect(status.warnings).toEqual([]);
  },
);
it('counts manifests and original copies in actual storage totals', async () => {
  const f = await fixture();
  const item = await snapshot(f, 0, true);
  const manifestSize = (await fs.stat(f.storage.file(`backups/removed/${item.id}/manifest.json`)))
    .size;
  const status = await f.installer.removed.inspect();
  expect(status.sizeBytes).toBe(manifestSize + 14);
  expect(status.items[0]!.sizeBytes).toBe(status.sizeBytes);
  expect(status.sizeIncomplete).toBe(false);
});
it('allows exactly 1 GiB and retains more than 20 copies only when required originals prevent cleanup', async () => {
  const f = await fixture();
  const boundary = await snapshot(f, 0, true);
  const status = await f.installer.removed.inspect();
  const sizes = new Map([
    [f.storage.file(boundary.copies[0]!.backupPath), 1024 ** 3 - status.sizeBytes + 7],
  ]);
  reportedSizes(sizes);
  expect((await f.transactions.locked(() => f.installer.removed.prune())).deleted).toBe(0);
  expect((await f.installer.removed.inspect()).sizeBytes).toBe(1024 ** 3);
  sizes.clear();
  const protectedItems = [boundary];
  for (let i = 1; i < 21; i++) protectedItems.push(await snapshot(f, i, true));
  await snapshot(f, 21);
  await f.storage.write('data/state-v2-aaaaaaaaaaaaaaaa.backup.json', {
    ...f.storage.state,
    installations: protectedItems.map((item) => item.record),
  });
  expect((await f.transactions.locked(() => f.installer.removed.prune())).deleted).toBe(1);
  const retained = await f.installer.removed.inspect();
  expect(retained.count).toBe(21);
  expect(retained.items.every((item) => item.protected)).toBe(true);
  expect(retained.warnings.join(' ')).toContain('prevent meeting');
});
it('completes a verified oversized uninstall before retention removes its snapshot', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'return 1');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  const installedPath = f.storage.state.installations[0]!.files[0]!.path;
  const capture = f.installer.removed.capture.bind(f.installer.removed);
  let verified = false;
  vi.spyOn(f.installer.removed, 'capture').mockImplementation(async (...args) => {
    const result = await capture(...args);
    expect(await fs.readFile(f.storage.file(result.copies[0]!.backupPath), 'utf8')).toBe(
      'return 1',
    );
    verified = true;
    reportedSizes(new Map([[f.storage.file(result.copies[0]!.backupPath), 1024 ** 3 + 1]]));
    return result;
  });
  await f.installer.uninstall('test-mod');
  expect(verified).toBe(true);
  expect(f.storage.state.installations).toEqual([]);
  expect(await exists(path.join(f.mods, installedPath))).toBe(false);
  expect((await f.installer.removed.inspect()).count).toBe(0);
});
it.each(['active', 'migration', 'recovery'] as const)(
  'protects %s references during automatic, individual and clear-all cleanup',
  async (source) => {
    const f = await fixture();
    const protectedItem = await snapshot(f, 0, true);
    const eligible = await snapshot(f, 1);
    const state = { ...f.storage.state, installations: [protectedItem.record] };
    if (source === 'active') await f.storage.save(state);
    else if (source === 'migration')
      await f.storage.write('data/state-v2-aaaaaaaaaaaaaaaa.backup.json', state);
    if (source === 'recovery') {
      const id = randomUUID();
      await f.storage.write(`transactions/${id}.json`, {
        id,
        roots: f.installer.roots(),
        changes: [],
        createdDirectories: [],
        previousState: state,
        phase: 'prepared',
      });
    }
    reportedSizes(new Map([[f.storage.file(protectedItem.copies[0]!.backupPath), 1024 ** 3 + 1]]));
    // A pending recovery journal is normally settled before cleanup by the lock.
    // Direct service checks also protect its originals if recovery has not settled.
    const automatic = await f.installer.removed.prune();
    expect(automatic.deleted).toBe(1);
    expect(await exists(f.storage.file(`backups/removed/${eligible.id}`))).toBe(false);
    expect((await f.installer.removed.inspect()).warnings.join(' ')).toContain('prevent meeting');
    expect((await f.installer.removed.cleanup(protectedItem.id)).deleted).toBe(0);
    expect((await f.installer.removed.cleanup('all')).deleted).toBe(0);
    expect(
      await fs.readFile(f.storage.file(protectedItem.record.files[0]!.backupPath!), 'utf8'),
    ).toBe('payload');
  },
);
it('preserves invalid and unreadable records while clearing only verified snapshots', async () => {
  const f = await fixture();
  const invalid = await snapshot(f, 0),
    unreadable = await snapshot(f, 1);
  await snapshot(f, 2);
  await put(f.storage.file(`backups/removed/${invalid.id}/manifest.json`), '{broken');
  const read = f.storage.read.bind(f.storage);
  vi.spyOn(f.storage, 'read').mockImplementation((async (relative, schema) => {
    if (relative === `backups/removed/${unreadable.id}/manifest.json`) throw new Error('EACCES');
    return read(relative, schema);
  }) as typeof f.storage.read);
  const result = await f.transactions.locked(() => f.installer.removed.cleanup('all'));
  expect(result).toEqual({ deleted: 1, retained: 2 });
  const status = await f.installer.removed.inspect();
  expect(status.items).toEqual([]);
  expect(status.sizeBytes).toBeGreaterThan(0);
  expect(status.warnings.join(' ')).toContain('2 unrecognized or unreadable');
  expect(
    await fs.readFile(f.storage.file(`backups/removed/${invalid.id}/0.original`), 'utf8'),
  ).toBe('payload');
});
it('reports incomplete size readings, preserves unsafe entries, and never follows links outside uninstall storage', async () => {
  const f = await fixture();
  const outside = path.join(f.root, 'outside');
  await put(path.join(outside, 'save.jkr'), 'keep');
  await fs.mkdir(f.storage.file('backups/removed'));
  await fs.symlink(
    outside,
    f.storage.file(`backups/removed/${randomUUID()}`),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await f.transactions.locked(() => f.installer.removed.cleanup('all'));
  expect(result.deleted).toBe(0);
  const status = await f.installer.removed.inspect();
  expect(status.sizeIncomplete).toBe(true);
  expect(status.warnings.join(' ')).toContain('preserved');
  expect(await fs.readFile(path.join(outside, 'save.jkr'), 'utf8')).toBe('keep');
});
it('reports deletion failures without losing the retained record, and permits retry', async () => {
  const f = await fixture();
  const item = await snapshot(f, 0);
  const target = f.storage.file(`backups/removed/${item.id}`);
  const remove = fs.rm;
  const failure = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
    if (file === target) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return remove(file, options);
  });
  expect(await f.transactions.locked(() => f.installer.removed.cleanup('all'))).toEqual({
    deleted: 0,
    retained: 1,
  });
  expect((await f.installer.removed.inspect()).warnings.join(' ')).toContain(
    'could not be deleted',
  );
  expect(await fs.readFile(path.join(target, '0.original'), 'utf8')).toBe('payload');
  expect((await f.installer.removed.list())[0]!.id).toBe(item.id);
  failure.mockRestore();
  expect(await f.transactions.locked(() => f.installer.removed.cleanup(item.id))).toEqual({
    deleted: 1,
    retained: 0,
  });
  expect((await f.installer.removed.inspect()).warnings).toEqual([]);
});
it('preserves all snapshots when reference records cannot be verified', async () => {
  const f = await fixture();
  const item = await snapshot(f, 0);
  await put(f.storage.file('data/state-v1.backup.json'), '{invalid');
  expect((await f.transactions.locked(() => f.installer.removed.cleanup('all'))).deleted).toBe(0);
  const status = await f.installer.removed.inspect();
  expect(status.items[0]!.protected).toBe(true);
  expect(status.warnings.join(' ')).toContain('references could not be verified');
  expect(await exists(f.storage.file(`backups/removed/${item.id}`))).toBe(true);
});
it('cleans up on application startup and refreshes snapshot totals after manual deletion under the operation lock', async () => {
  const f = await fixture();
  const items: Awaited<ReturnType<typeof snapshot>>[] = [];
  for (let i = 0; i < 22; i++) items.push(await snapshot(f, i));
  await put(f.storage.file('backups/unrelated/notes.txt'), 'keep');
  await put(f.storage.file('creator/source/main.lua'), 'keep');
  vi.stubEnv('MODATRO_TEST_DATA', f.storage.root);
  const app = new ModatroApplication(
    f.storage.root,
    'test',
    'test',
    () => {},
    () => {},
  );
  const locked = vi.spyOn(app.transactions, 'locked');
  await app.initialize();
  expect(locked).toHaveBeenCalled();
  const state = await app.snapshot();
  expect(state.removedModsStorage?.count).toBe(20);
  expect(state.removedModsStorage?.sizeBytes).toBe(
    state.removedMods!.reduce((sum, item) => sum + item.sizeBytes!, 0),
  );
  expect(state.removedMods?.some((item) => item.id === items[0]!.id)).toBe(false);
  const active = app.transactions.locked(async () => {
    await expect(app.deleteRemovedBackup(items[2]!.id)).rejects.toThrow('Another file operation');
  });
  await active;
  const result = await app.deleteRemovedBackup(items[2]!.id);
  expect(result.deleted).toBe(1);
  expect(result.snapshot.removedModsStorage?.count).toBe(19);
  expect(result.snapshot.removedModsStorage!.sizeBytes).toBeLessThan(
    state.removedModsStorage!.sizeBytes,
  );
  expect((await app.deleteRemovedBackup()).snapshot.removedModsStorage).toEqual({
    count: 0,
    sizeBytes: 0,
    sizeIncomplete: false,
  });
  expect(await fs.readFile(f.storage.file('backups/unrelated/notes.txt'), 'utf8')).toBe('keep');
  expect(await fs.readFile(f.storage.file('creator/source/main.lua'), 'utf8')).toBe('keep');
});
