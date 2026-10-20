import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exists, hashFile, fileBatches, stageCopy } from '../electron/services/files';
import { TransactionEngine, type TransactionJournal } from '../electron/services/transaction';
import { Logger, Storage } from '../electron/services/storage';
import { OperationHistoryStore } from '../electron/services/history';
import { mod, put, setup } from './helpers';

const roots: string[] = [];
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function replacement(f: Awaited<ReturnType<typeof fixture>>, version = '1.0.0') {
  await put(path.join(f.stage, 'replacement.lua'), `replacement ${version}`);
  const definition = mod({
    id: 'replacement',
    version,
    installation: {
      type: 'game-replacement',
      files: [{ source: 'replacement.lua', destination: 'foo.lua' }],
    },
  });
  await f.installer.commitPrepared(await f.installer.plan(definition, f.stage));
}
async function scratch(
  f: Awaited<ReturnType<typeof fixture>>,
  phase: TransactionJournal['phase'] = 'committed',
) {
  const id = randomUUID();
  const original = path.join(f.stage, id);
  await put(original, 'original scratch');
  const backup = await f.transactions.backup.capture(id, 0, original);
  const journal: TransactionJournal = {
    id,
    roots: f.installer.roots(),
    previousState: structuredClone(f.storage.state),
    phase,
    createdDirectories: [],
    changes: [],
  };
  await f.storage.write(`transactions/${id}.json`, journal);
  return { id, backup, journal };
}

it('keeps the first original through updates, retires completed journals and prunes superseded scratch copies', async () => {
  const f = await fixture();
  await put(path.join(f.game, 'foo.lua'), 'first original');
  await replacement(f);
  const original = f.storage.state.installations[0]!.files[0]!.backupPath!;
  await f.transactions.recover();
  await replacement(f, '2.0.0');
  await f.transactions.recover();
  expect(f.storage.state.installations[0]!.files[0]!.backupPath).toBe(original);
  expect(await fs.readFile(f.storage.file(original), 'utf8')).toBe('first original');
  expect(await fs.readdir(f.storage.file('transactions'))).toEqual([]);
  const backups = await fs.readdir(f.storage.file('backups'), { recursive: true });
  expect(backups.filter((name) => name.endsWith('.original'))).toHaveLength(1);
  expect(
    (await new OperationHistoryStore(f.storage).read()).filter((h) => h.outcome === 'success'),
  ).toHaveLength(2);
  await f.installer.uninstall('replacement');
  expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('first original');
  expect(await exists(f.storage.file(original))).toBe(false);
});

it('cleans old completed and rolled-back journals plus orphaned preparation backups on startup', async () => {
  const f = await fixture();
  const a = await scratch(f),
    b = await scratch(f, 'rolled-back');
  const orphan = randomUUID();
  await put(f.storage.file(`backups/${orphan}/9.original`), 'abandoned preparation');
  await put(
    f.storage.file(`backups/${orphan}/.modatro-${randomUUID()}.tmp`),
    'partial backup copy',
  );
  const storage = new Storage(f.storage.root);
  await storage.initialize();
  await new TransactionEngine(storage, new Logger(storage, f.root)).recover();
  expect(await fs.readdir(storage.file('transactions'))).toEqual([]);
  expect(await fs.readdir(storage.file('backups'))).toEqual([]);
  expect(await exists(storage.file(a.backup.path))).toBe(false);
  expect(await exists(storage.file(b.backup.path))).toBe(false);
});

it('recovers interrupted changes before retiring their backups', async () => {
  const f = await fixture(),
    s = await scratch(f, 'prepared'),
    dest = path.join(f.game, 'foo.lua');
  await put(dest, 'partial');
  s.journal.changes = [
    {
      root: 'game',
      path: 'foo.lua',
      beforeHash: s.backup.hash,
      beforeBackup: s.backup.path,
      afterHash: await hashFile(dest),
    },
  ];
  await f.storage.write(`transactions/${s.id}.json`, s.journal);
  await f.transactions.recover();
  expect(await fs.readFile(dest, 'utf8')).toBe('original scratch');
  expect(await exists(f.storage.file(s.backup.path))).toBe(false);
  expect(f.storage.safetyError).toBeUndefined();
});

it.each(['invalid phase', 'wrong identity'])(
  'does not prune anything when a journal has %s',
  async (problem) => {
    const f = await fixture(),
      s = await scratch(f);
    await f.storage.write(`transactions/${s.id}.json`, {
      ...s.journal,
      ...(problem === 'invalid phase' ? { phase: 'unknown' } : { id: randomUUID() }),
    });
    await f.transactions.recover();
    expect(f.storage.safetyError).toContain('locked');
    expect(await exists(f.storage.file(s.backup.path))).toBe(true);
    expect(await exists(f.storage.file(`transactions/${s.id}.json`))).toBe(true);
  },
);

it('defers cleanup if the durable state differs from the active state', async () => {
  const f = await fixture(),
    s = await scratch(f);
  await put(
    f.storage.file('data/state.json'),
    JSON.stringify({
      ...f.storage.state,
      settings: { ...f.storage.state.settings, theme: 'light' },
    }),
  );
  await f.transactions.recover();
  expect(await exists(f.storage.file(s.backup.path))).toBe(true);
  expect(await exists(f.storage.file(`transactions/${s.id}.json`))).toBe(true);
  expect(f.storage.safetyError).toBeUndefined();
});

it.each(['missing', 'changed'])(
  'preserves scratch recovery material if an active original is %s',
  async (status) => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'first original');
    await replacement(f);
    const original = f.storage.file(f.storage.state.installations[0]!.files[0]!.backupPath!);
    const s = await scratch(f);
    if (status === 'missing') await fs.unlink(original);
    else await put(original, 'external edit');
    await f.transactions.recover();
    expect(await exists(f.storage.file(s.backup.path))).toBe(true);
    expect(await exists(f.storage.file(`transactions/${s.id}.json`))).toBe(true);
    expect(f.storage.safetyError).toBeUndefined();
  },
);

it('preserves every backup and journal when recovery cannot verify an external edit', async () => {
  const f = await fixture(),
    terminal = await scratch(f),
    pending = await scratch(f, 'prepared');
  const dest = path.join(f.game, 'foo.lua');
  await put(dest, 'partial');
  pending.journal.changes = [
    {
      root: 'game',
      path: 'foo.lua',
      beforeHash: pending.backup.hash,
      beforeBackup: pending.backup.path,
      afterHash: await hashFile(dest),
    },
  ];
  await f.storage.write(`transactions/${pending.id}.json`, pending.journal);
  await put(dest, 'external edit');
  await f.transactions.recover();
  expect(f.storage.safetyError).toContain('locked');
  for (const s of [terminal, pending]) {
    expect(await exists(f.storage.file(s.backup.path))).toBe(true);
    expect(await exists(f.storage.file(`transactions/${s.id}.json`))).toBe(true);
  }
  expect(await fs.readFile(dest, 'utf8')).toBe('external edit');
});

it('protects originals referenced by upgrade snapshots and defers pruning for corrupt snapshots', async () => {
  const f = await fixture();
  await put(path.join(f.game, 'foo.lua'), 'upgrade original');
  await replacement(f);
  const original = f.storage.state.installations[0]!.files[0]!.backupPath!;
  await f.storage.write('data/state-v2-aaaaaaaaaaaaaaaa.backup.json', f.storage.state);
  await f.installer.uninstall('replacement');
  expect(await exists(f.storage.file(original))).toBe(true);
  const s = await scratch(f);
  await put(f.storage.file('data/state-v1.backup.json'), '{broken');
  await f.transactions.recover();
  expect(await exists(f.storage.file(s.backup.path))).toBe(true);
  expect(await exists(f.storage.file(`transactions/${s.id}.json`))).toBe(true);
  expect(f.storage.safetyError).toBeUndefined();
});

it('leaves unknown backup entries, links and files outside the managed data root untouched', async () => {
  const f = await fixture(),
    s = await scratch(f);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await put(path.join(outside, '1.original'), 'keep');
  await put(f.storage.file('backups/notes.txt'), 'keep');
  await put(f.storage.file(`backups/${s.id}/notes.txt`), 'keep');
  await fs.symlink(
    outside,
    f.storage.file(`backups/${randomUUID()}`),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.transactions.recover();
  expect(await fs.readFile(path.join(outside, '1.original'), 'utf8')).toBe('keep');
  expect(await fs.readFile(f.storage.file('backups/notes.txt'), 'utf8')).toBe('keep');
  expect(await fs.readFile(f.storage.file(`backups/${s.id}/notes.txt`), 'utf8')).toBe('keep');
  expect(await exists(f.storage.file(s.backup.path))).toBe(false);
});

it('does not overwrite existing staging destinations and drains a failed parallel batch before returning', async () => {
  const f = await fixture(),
    source = path.join(f.stage, 'source'),
    dest = path.join(f.stage, 'dest');
  await put(source, 'source');
  await put(dest, 'preserve');
  await expect(stageCopy(source, dest)).rejects.toThrow();
  expect(await fs.readFile(dest, 'utf8')).toBe('preserve');
  let finish: () => void = () => {},
    started = false;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let rejected = false;
  const pending = fileBatches([0, 1, 2], async (index) => {
    if (index === 0) throw new Error('fixture');
    if (index === 1) {
      started = true;
      await done;
    }
  }).catch(() => {
    rejected = true;
  });
  await vi.waitFor(() => expect(started).toBe(true));
  expect(rejected).toBe(false);
  finish();
  await pending;
  expect(rejected).toBe(true);
});
