import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fileOperations from '../electron/services/files';
import { exists, hashFile } from '../electron/services/files';
import { Logger, Storage } from '../electron/services/storage';
import { TransactionEngine, type TransactionJournal } from '../electron/services/transaction';
import { put, setup } from './helpers';
const roots: string[] = [];
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function interrupted(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(),
    dest = path.join(f.game, 'foo.lua');
  await put(dest, 'original');
  const backup = await f.transactions.backup.capture(id, 0, dest),
    old = structuredClone(f.storage.state);
  await put(dest, 'partially installed');
  const afterHash = await hashFile(dest);
  const journal: TransactionJournal = {
    id,
    roots: f.installer.roots(),
    previousState: old,
    phase: 'prepared',
    createdDirectories: [],
    changes: [
      {
        root: 'game',
        path: 'foo.lua',
        beforeHash: backup.hash,
        beforeBackup: backup.path,
        afterHash,
      },
    ],
  };
  await f.storage.write(`transactions/${id}.json`, journal);
  return { id, dest, journal };
}
describe('interrupted transaction recovery', () => {
  it('cleans a journal-owned partial atomic copy left by a crash', async () => {
    const f = await fixture(),
      { id, journal, dest } = await interrupted(f);
    journal.changes[0]!.temporaryPath = `.modatro-${id}-0.tmp`;
    const temporary = path.join(f.game, journal.changes[0]!.temporaryPath!);
    await put(temporary, 'partially copied bytes');
    await f.storage.write(`transactions/${id}.json`, journal);
    await f.transactions.recover();
    expect(await exists(temporary)).toBe(false);
    expect(await fs.readFile(dest, 'utf8')).toBe('original');
  });
  it('does not roll back a commit whose state rename succeeded before an fsync error', async () => {
    const f = await fixture();
    const source = path.join(f.stage, 'new.lua');
    await put(source, 'new version');
    const original = fileOperations.atomicWrite;
    vi.spyOn(fileOperations, 'atomicWrite').mockImplementation(async (file, contents) => {
      await original(file, contents);
      if (file.endsWith('state.json')) throw new Error('directory fsync failed after rename');
    });
    await f.transactions.execute(
      f.installer.roots(),
      [{ root: 'mods', path: 'new.lua', source, afterHash: await hashFile(source) }],
      () => f.storage.state,
    );
    expect(await fs.readFile(path.join(f.mods, 'new.lua'), 'utf8')).toBe('new version');
    expect(f.storage.state.lastTransaction).toBeTruthy();
    vi.restoreAllMocks();
    await f.transactions.recover();
    expect(await fs.readFile(path.join(f.mods, 'new.lua'), 'utf8')).toBe('new version');
    expect(f.storage.safetyError).toBeUndefined();
  });
  it('restores an interrupted replacement after restart', async () => {
    const f = await fixture(),
      { dest } = await interrupted(f);
    const storage = new Storage(f.storage.root);
    await storage.initialize();
    await new TransactionEngine(storage, new Logger(storage, f.root)).recover();
    expect(await fs.readFile(dest, 'utf8')).toBe('original');
    expect(storage.safetyError).toBeUndefined();
  });
  it('removes interrupted created files', async () => {
    const f = await fixture(),
      id = randomUUID(),
      dest = path.join(f.mods, 'new.lua');
    await put(dest, 'partial');
    await f.storage.write(`transactions/${id}.json`, {
      id,
      roots: f.installer.roots(),
      previousState: f.storage.state,
      phase: 'prepared',
      createdDirectories: [],
      changes: [{ root: 'mods', path: 'new.lua', afterHash: await hashFile(dest) }],
    });
    await f.transactions.recover();
    expect(await exists(dest)).toBe(false);
  });
  it('recognises a durable state commit even if the journal was not marked committed', async () => {
    const f = await fixture(),
      { id, dest } = await interrupted(f);
    await f.storage.save({ ...f.storage.state, lastTransaction: id });
    await f.transactions.recover();
    expect(await fs.readFile(dest, 'utf8')).toBe('partially installed');
    expect(f.storage.safetyError).toBeUndefined();
  });
  it('stops recovery if the file changed after the interrupted commit', async () => {
    const f = await fixture(),
      { dest } = await interrupted(f);
    await put(dest, 'later user changes');
    await f.transactions.recover();
    expect(await fs.readFile(dest, 'utf8')).toBe('later user changes');
    expect(f.storage.safetyError).toContain('locked');
  });
  it('rejects journals pointing outside approved roots', async () => {
    const f = await fixture(),
      { id, dest, journal } = await interrupted(f);
    journal.roots.game = f.root;
    await f.storage.write(`transactions/${id}.json`, journal);
    await f.transactions.recover();
    expect(f.storage.safetyError).toContain('locked');
    expect(await fs.readFile(dest, 'utf8')).toBe('partially installed');
  });
  it('locks file changes when persisted state is corrupt', async () => {
    const f = await fixture();
    await put(f.storage.file('data/state.json'), '{broken json');
    const storage = new Storage(f.storage.root);
    await storage.initialize();
    expect(storage.safetyError).toContain('locked');
    await expect(storage.save(storage.state)).rejects.toThrow('locked');
  });
  it('rejects unsafe paths in persisted manifests', async () => {
    const f = await fixture();
    await put(
      f.storage.file('data/state.json'),
      JSON.stringify({
        ...f.storage.state,
        installations: [
          {
            modId: 'bad',
            title: 'bad',
            modVersion: '1.0.0',
            installedAt: new Date().toISOString(),
            source: 'https://github.com/a/b',
            folderName: 'bad',
            transactionId: 'bad',
            dependencies: [],
            files: [
              {
                root: 'game',
                path: '../outside.lua',
                operation: 'created',
                installedHash: 'a'.repeat(64),
              },
            ],
          },
        ],
      }),
    );
    const storage = new Storage(f.storage.root);
    await storage.initialize();
    expect(storage.safetyError).toContain('locked');
  });
  it('prevents overlapping operations', async () => {
    const f = await fixture();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = f.transactions.locked(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await expect(f.transactions.locked(async () => {})).rejects.toThrow('Another file operation');
    await started;
    release();
    await blocked;
  });
  it('finishes a failed journal commit marker before a newer transaction supersedes it', async () => {
    const f = await fixture();
    const source = path.join(f.stage, 'new.lua');
    await put(source, 'new version');
    const write = f.storage.write.bind(f.storage);
    let failed = false;
    vi.spyOn(f.storage, 'write').mockImplementation(async (file, value) => {
      if (
        !failed &&
        file.startsWith('transactions/') &&
        (value as TransactionJournal).phase === 'committed'
      ) {
        failed = true;
        throw new Error('one journal write failed');
      }
      await write(file, value);
    });
    await f.transactions.execute(
      f.installer.roots(),
      [{ root: 'mods', path: 'first.lua', source, afterHash: await hashFile(source) }],
      () => f.storage.state,
    );
    await f.transactions.execute(
      f.installer.roots(),
      [{ root: 'mods', path: 'second.lua', source, afterHash: await hashFile(source) }],
      () => f.storage.state,
    );
    const storage = new Storage(f.storage.root);
    await storage.initialize();
    await new TransactionEngine(storage, new Logger(storage, f.root)).recover();
    expect(failed).toBe(true);
    expect(storage.safetyError).toBeUndefined();
    expect(await fs.readFile(path.join(f.mods, 'first.lua'), 'utf8')).toBe('new version');
    expect(await fs.readFile(path.join(f.mods, 'second.lua'), 'utf8')).toBe('new version');
  });
});
