import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage, Logger } from '../electron/services/storage';
import { BackupService } from '../electron/services/transaction';
import { StorageMaintenance } from '../electron/services/storage-maintenance';
import { indexCachePath } from '../electron/services/mod-index';
import { exists } from '../electron/services/files';
import { put, tempRoot, setup as installationSetup } from './helpers';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await tempRoot();
  roots.push(root);
  const storage = new Storage(root);
  await storage.initialize();
  await storage.save(storage.state);
  const backup = new BackupService(storage),
    logger = new Logger(storage, 'TEST_HOME');
  const maintenance = new StorageMaintenance(storage, backup, logger);
  async function snapshot(index: number, bytes = 10, completed = true) {
    const id = randomUUID(),
      prefix = `backups/setup-resets/${id}`;
    await put(storage.file(`${prefix}/files/mods/example.lua`), '');
    await fs.truncate(storage.file(`${prefix}/files/mods/example.lua`), bytes);
    await storage.write(`${prefix}/manifest.json`, {
      schemaVersion: 1,
      createdAt: new Date(2026, 0, index).toISOString(),
      mode: 'reset',
      completed,
      state: storage.state,
      note: 'fixture',
      files: [{ root: 'mods', path: 'example.lua', hash: 'a'.repeat(64), sizeBytes: bytes }],
    });
    return id;
  }
  return { root, storage, backup, logger, maintenance, snapshot };
}
describe('storage maintenance', () => {
  it('prunes oldest completed copies to the count and combined size targets', async () => {
    const { maintenance, snapshot } = await setup();
    const ids = [];
    for (let i = 1; i <= 22; i++) ids.push(await snapshot(i));
    expect((await maintenance.cleanup()).snapshots.map((item) => item.id)).toEqual(ids.slice(2));
    const big = await snapshot(23, 600 * 1024 ** 2);
    const newest = await snapshot(24, 600 * 1024 ** 2);
    const result = await maintenance.cleanup();
    expect(result.snapshots.map((item) => item.id)).toEqual([newest]);
    expect(result.sizeBytes).toBeGreaterThan(600 * 1024 ** 2);
    expect(result.snapshots.some((item) => item.id === big)).toBe(false);
  });
  it('keeps the newest oversized recovery copy and reports its storage target', async () => {
    const { maintenance, snapshot } = await setup();
    const id = await snapshot(1, 1024 ** 3 + 1);
    const result = await maintenance.cleanup();
    expect(result.snapshots[0]?.id).toBe(id);
    expect(result.warnings.join(' ')).toContain('exceeds');
    expect((await maintenance.cleanup(id)).snapshots).toEqual([]);
  });
  it('preserves protected, incomplete and invalid copies during automatic cleanup', async () => {
    const { storage, backup, maintenance, snapshot } = await setup();
    const protectedId = await snapshot(1),
      incomplete = await snapshot(2, 10, false);
    vi.spyOn(backup, 'references').mockResolvedValue(
      new Set([`backups/setup-resets/${protectedId}/originals/0.original`]),
    );
    await put(storage.file(`backups/setup-resets/${randomUUID()}/manifest.json`), '{');
    for (let i = 3; i <= 23; i++) await snapshot(i);
    const result = await maintenance.cleanup();
    expect(result.snapshots.map((item) => item.id)).toContain(protectedId);
    expect(result.snapshots.map((item) => item.id)).toContain(incomplete);
    expect(result.warnings.join(' ')).toContain('could not be fully checked');
    const cleared = await maintenance.cleanup('all');
    expect(cleared.snapshots.map((item) => item.id)).toEqual([protectedId]);
    expect(cleared.warnings.join(' ')).toContain('referenced originals');
  });
  it('defers all recovery deletion if references cannot be checked', async () => {
    const { backup, maintenance, snapshot, storage } = await setup();
    const id = await snapshot(1);
    vi.spyOn(backup, 'references').mockRejectedValue(new Error('state changed'));
    expect((await maintenance.cleanup('all')).warnings.join(' ')).toContain('retained');
    expect(await exists(storage.file(`backups/setup-resets/${id}/manifest.json`))).toBe(true);
  });
  it('reports deletion failure and keeps the remaining recovery copy available', async () => {
    const { storage, maintenance, snapshot } = await setup();
    const id = await snapshot(1);
    const original = fs.rm;
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === storage.file(`backups/setup-resets/${id}`))
        throw new Error('Access denied');
      return original(file, options);
    });
    const result = await maintenance.cleanup(id);
    expect(result.snapshots[0]?.id).toBe(id);
    expect(result.warnings.join(' ')).toContain('could not be deleted');
  });
  it('removes verified inactive index caches while retaining the configured offline catalogue', async () => {
    const { storage, maintenance } = await setup();
    const active = 'https://github.com/example/active-index',
      old = 'https://github.com/example/old-index';
    await storage.save({
      ...storage.state,
      settings: { ...storage.state.settings, modIndexUrl: active },
    });
    for (const url of [active, old])
      await storage.write(indexCachePath(url), {
        url,
        fetchedAt: new Date().toISOString(),
        mods: [],
        rejected: 0,
      });
    await storage.write('catalogue-cache/catalogue.json', { keep: true });
    await maintenance.scheduled(true);
    expect(await exists(storage.file(indexCachePath(active)))).toBe(true);
    expect(await exists(storage.file(indexCachePath(old)))).toBe(false);
    expect(await exists(storage.file('catalogue-cache/catalogue.json'))).toBe(true);
  });
  it('startup clears only recognized staging directories and retains unfamiliar files', async () => {
    const { maintenance, storage } = await setup();
    await put(storage.file('staging/install-Abc123/main.lua'));
    await put(storage.file('staging/unknown/main.lua'));
    await put(storage.file('creator/projects/source.lua'));
    await maintenance.scheduled(true);
    expect(await exists(storage.file('staging/install-Abc123'))).toBe(false);
    expect(await exists(storage.file('staging/unknown/main.lua'))).toBe(true);
    expect(await exists(storage.file('creator/projects/source.lua'))).toBe(true);
  });
  it('expires old downloads and enforces a combined cache budget, oldest first', async () => {
    const { storage, installer, root } = await installationSetup();
    roots.push(root);
    const old = storage.file(`downloads/${randomUUID()}.download`);
    const recent = storage.file(`downloads/${randomUUID()}.part`);
    const expired = storage.file(`downloads/${randomUUID()}.download`);
    await put(old, '');
    await fs.truncate(old, 512 * 1024 ** 2);
    await fs.utimes(old, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
    await put(recent, 'recent');
    await put(expired, 'expired');
    await fs.utimes(expired, new Date(0), new Date(0));
    await put(storage.file('downloads/unknown.zip'), 'keep');
    await installer.pruneDownloads();
    expect(await exists(old)).toBe(false);
    expect(await exists(expired)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(storage.file('downloads/unknown.zip'))).toBe(true);
  });
  it('serializes log rotation, caps archive count and truncates oversized entries', async () => {
    const { storage, logger } = await setup();
    for (let i = 1; i <= 9; i++) await put(storage.file(`logs/modatro-${i}.log`));
    await put(storage.file('logs/modatro.log'), 'x'.repeat(5 * 1024 ** 2));
    await put(storage.file('logs/keep.log'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        logger.log(`event-${i}`, i === 0 ? 'y'.repeat(100000) : i),
      ),
    );
    const names = await fs.readdir(storage.file('logs'));
    expect(names.filter((name) => name.startsWith('modatro-'))).toHaveLength(5);
    expect(names).toContain('keep.log');
    const lines = (await fs.readFile(storage.file('logs/modatro.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(20);
    expect(lines[0].truncated).toBe(true);
    expect(lines.at(-1).event).toBe('event-19');
  });
});
