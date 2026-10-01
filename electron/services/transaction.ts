import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HashSchema,
  RelativePath,
  RootSchema,
  StateSchema,
  type AppState,
  type FileRoot,
} from '../../src/shared/model';
import { UserError } from './errors';
import { atomicCopy, exists, hashFile, safeDestination, syncDirectory } from './files';
import { Logger, Storage } from './storage';

export interface Change {
  root: FileRoot;
  path: string;
  source?: string;
  expectedBefore?: string;
  afterHash?: string;
}
const JournalChange = z
  .object({
    root: RootSchema,
    path: RelativePath,
    beforeHash: HashSchema.optional(),
    beforeBackup: RelativePath.optional(),
    afterHash: HashSchema.optional(),
    temporaryPath: RelativePath.optional(),
  })
  .superRefine((c, ctx) => {
    if (!!c.beforeHash !== !!c.beforeBackup)
      ctx.addIssue({ code: 'custom', message: 'Incomplete rollback backup' });
  });
const JournalSchema = z.object({
  id: z.uuid(),
  roots: z.object({ game: z.string(), mods: z.string(), disabled: z.string() }),
  changes: z.array(JournalChange),
  createdDirectories: z.array(z.object({ root: RootSchema, path: RelativePath })),
  previousState: StateSchema,
  phase: z.enum(['prepared', 'committed', 'rolled-back']),
});
export type TransactionJournal = z.infer<typeof JournalSchema>;
export class BackupService {
  constructor(private storage: Storage) {}
  async capture(
    transactionId: string,
    index: number,
    source: string,
  ): Promise<{ path: string; hash: string }> {
    const relative = `backups/${transactionId}/${index}.original`;
    const destination = await safeDestination(this.storage.root, relative);
    if (await exists(destination))
      throw new UserError('A backup already exists at this location. It will not be overwritten.');
    const originalHash = await hashFile(source);
    await atomicCopy(source, destination);
    if ((await hashFile(destination)) !== originalHash || (await hashFile(source)) !== originalHash)
      throw new UserError(
        'A file changed while its backup was being created. Try again after closing Balatro.',
      );
    return { path: relative, hash: originalHash };
  }
  async verified(relative: string, expected: string): Promise<string> {
    if (!relative.startsWith('backups/'))
      throw new UserError('An installation refers to an invalid backup.');
    const file = await safeDestination(this.storage.root, relative);
    if (!(await exists(file)) || (await hashFile(file)) !== expected)
      throw new UserError(
        'The original backup is missing or has changed. Modatro will not modify the installed file.',
      );
    return file;
  }
}
export class TransactionEngine {
  private busy = false;
  readonly backup: BackupService;
  // Tests use a deterministic hook to fail or simulate a process interruption.
  constructor(
    private storage: Storage,
    private logger: Logger,
    private checkpoint: (phase: string, index?: number) => Promise<void> = async () => {},
  ) {
    this.backup = new BackupService(storage);
  }
  async locked<T>(work: () => Promise<T>): Promise<T> {
    this.storage.assertSafe();
    if (this.busy)
      throw new UserError('Another file operation is in progress. Wait for it to finish.');
    this.busy = true;
    try {
      // Finish a durable commit whose journal write failed before another state
      // change can supersede its transaction ID.
      await this.recover();
      this.storage.assertSafe();
      return await work();
    } finally {
      this.busy = false;
    }
  }
  async execute(
    roots: Record<FileRoot, string>,
    changes: Change[],
    buildState: (journal: TransactionJournal) => AppState,
  ): Promise<void> {
    this.storage.assertSafe();
    await this.recover();
    this.storage.assertSafe();
    const id = randomUUID();
    const journalPath = `transactions/${id}.json`;
    if (new Set(changes.map((c) => `${c.root}:${c.path.toLowerCase()}`)).size !== changes.length)
      throw new UserError('The install plan has duplicate destinations.');
    const journal: TransactionJournal = {
      id,
      roots,
      changes: [],
      createdDirectories: [],
      previousState: structuredClone(this.storage.state),
      phase: 'prepared',
    };
    await this.logger.log('transaction.prepare', { id, count: changes.length });
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!,
        destination = await safeDestination(roots[change.root], change.path);
      const before = (await exists(destination)) ? await hashFile(destination) : undefined;
      if (before !== change.expectedBefore)
        throw new UserError(
          'A destination changed after the install plan was created. No files were changed.',
        );
      if (
        change.source &&
        (!change.afterHash || (await hashFile(change.source)) !== change.afterHash)
      )
        throw new UserError('A staged file failed its integrity check.');
      const backup = before ? await this.backup.capture(id, i, destination) : undefined;
      const temporaryPath = change.source
        ? path.posix.join(path.posix.dirname(change.path), `.modatro-${id}-${i}.tmp`)
        : undefined;
      if (temporaryPath && (await exists(await safeDestination(roots[change.root], temporaryPath))))
        throw new UserError(
          'The transaction temporary path already exists. No files were changed.',
        );
      journal.changes.push({
        root: change.root,
        path: change.path,
        beforeHash: before,
        beforeBackup: backup?.path,
        afterHash: change.afterHash,
        temporaryPath,
      });
      if (change.source) {
        const parts = change.path.split('/');
        parts.pop();
        for (let count = 1; count <= parts.length; count++) {
          const dir = parts.slice(0, count).join('/');
          if (
            !(await exists(await safeDestination(roots[change.root], dir))) &&
            !journal.createdDirectories.some((d) => d.root === change.root && d.path === dir)
          )
            journal.createdDirectories.push({ root: change.root, path: dir });
        }
      }
    }
    const next = StateSchema.parse(buildState(journal));
    next.lastTransaction = id;
    await this.storage.write(journalPath, JournalSchema.parse(journal));
    try {
      await this.checkpoint('prepared');
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!,
          destination = await safeDestination(roots[change.root], change.path);
        const current = (await exists(destination)) ? await hashFile(destination) : undefined;
        if (current !== journal.changes[i]!.beforeHash)
          throw new UserError('A file changed during installation. Modatro stopped to protect it.');
        if (change.source) {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          // Recheck after directory creation; a pre-existing symlink must not be followed.
          await safeDestination(roots[change.root], change.path);
          const temporaryPath = journal.changes[i]!.temporaryPath!;
          await atomicCopy(
            change.source,
            destination,
            await safeDestination(roots[change.root], temporaryPath),
          );
          if ((await hashFile(destination)) !== change.afterHash)
            throw new UserError('An installed file failed its integrity check.');
        } else {
          if (await exists(destination)) {
            await fs.unlink(destination);
            await syncDirectory(path.dirname(destination));
          }
        }
        await this.checkpoint('changed', i);
      }
      await this.checkpoint('before-state');
      await this.storage.save(next);
      // The state's transaction ID is the durable commit marker. A crash between
      // these two writes must never roll back a successfully saved installation.
      journal.phase = 'committed';
      try {
        await this.storage.write(journalPath, journal);
      } catch (e) {
        await this.logger.log('transaction.commit-marker.failed', String(e));
      }
      await this.logger.log('transaction.commit', { id });
    } catch (e) {
      if (this.storage.state.lastTransaction === id) return;
      await this.logger.log('transaction.rollback.start', { id, error: String(e) });
      try {
        await this.rollback(journal);
        journal.phase = 'rolled-back';
        await this.storage.write(journalPath, journal);
      } catch (recovery) {
        this.storage.safetyError =
          'Recovery could not finish because a file or backup changed. File changes are locked. Keep your backups and open diagnostics.';
        await this.logger.log('transaction.rollback.blocked', { id, error: String(recovery) });
        throw new UserError(
          this.storage.safetyError,
          undefined,
          `${String(e)}\n${String(recovery)}`,
        );
      }
      throw e;
    }
  }
  async rollback(journal: TransactionJournal) {
    // Validate every rollback destination and backup before changing any file.
    const pending: {
      root: FileRoot;
      path: string;
      destination: string;
      source?: string;
      beforeHash?: string;
      afterHash?: string;
    }[] = [];
    const temporaryFiles: string[] = [];
    for (let index = 0; index < journal.changes.length; index++) {
      const change = journal.changes[index]!;
      if (!change.temporaryPath) continue;
      const expected = path.posix.join(
        path.posix.dirname(change.path),
        `.modatro-${journal.id}-${index}.tmp`,
      );
      if (change.temporaryPath !== expected)
        throw new UserError('The recovery journal refers to an invalid temporary file.');
      const temporary = await safeDestination(journal.roots[change.root], change.temporaryPath);
      if (await exists(temporary)) {
        if (!(await fs.lstat(temporary)).isFile())
          throw new UserError('A transaction temporary file is no longer a regular file.');
        temporaryFiles.push(temporary);
      }
    }
    for (const change of [...journal.changes].reverse()) {
      const destination = await safeDestination(journal.roots[change.root], change.path);
      const current = (await exists(destination)) ? await hashFile(destination) : undefined;
      if (current === change.beforeHash) continue;
      if (current !== change.afterHash)
        throw new UserError(`Recovery stopped: ${change.path} changed outside the transaction.`);
      const source =
        change.beforeHash && change.beforeBackup
          ? await this.backup.verified(change.beforeBackup, change.beforeHash)
          : undefined;
      pending.push({
        root: change.root,
        path: change.path,
        destination,
        source,
        beforeHash: change.beforeHash,
        afterHash: change.afterHash,
      });
    }
    for (const change of pending) {
      await safeDestination(journal.roots[change.root], change.path);
      const current = (await exists(change.destination))
        ? await hashFile(change.destination)
        : undefined;
      if (current !== change.afterHash)
        throw new UserError(`Recovery stopped: ${change.path} changed outside the transaction.`);
      if (change.source && (await hashFile(change.source)) !== change.beforeHash)
        throw new UserError('A recovery backup changed before restoration.');
      if (change.source) await atomicCopy(change.source, change.destination);
      else if (await exists(change.destination)) await fs.unlink(change.destination);
      const restored = (await exists(change.destination))
        ? await hashFile(change.destination)
        : undefined;
      if (restored !== change.beforeHash)
        throw new UserError(`Recovery could not verify the restored file: ${change.path}.`);
    }
    for (const temporary of temporaryFiles) await fs.unlink(temporary);
    for (const directory of [...journal.createdDirectories].reverse()) {
      const dest = await safeDestination(journal.roots[directory.root], directory.path);
      try {
        await fs.rmdir(dest);
      } catch (e) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
    }
    await this.logger.log('transaction.rollback.complete', { id: journal.id });
  }
  async recover() {
    this.storage.assertSafe();
    const files = (await fs.readdir(this.storage.file('transactions'))).filter((f) =>
      f.endsWith('.json'),
    );
    for (const file of files) {
      try {
        const journal = await this.storage.read(`transactions/${file}`, JournalSchema);
        if (!journal || journal.phase !== 'prepared') continue;
        if (journal.id === this.storage.state.lastTransaction) {
          journal.phase = 'committed';
          await this.storage.write(`transactions/${file}`, journal);
          continue;
        }
        // Reject a corrupt journal referring to arbitrary roots. Never use paths
        // from recovery data unless they match the saved approved settings.
        const settings = this.storage.state.settings;
        if (
          journal.roots.game !== (settings.gamePath ?? '') ||
          journal.roots.mods !== (settings.modsPath ?? '') ||
          journal.roots.disabled !== this.storage.file('disabled') ||
          JSON.stringify(journal.previousState) !== JSON.stringify(this.storage.state)
        )
          throw new UserError(
            'An interrupted transaction does not match the saved approved folders or state.',
          );
        await this.rollback(journal);
        journal.phase = 'rolled-back';
        await this.storage.write(`transactions/${file}`, journal);
      } catch (e) {
        this.storage.safetyError =
          'An interrupted installation could not be safely recovered. File changes are locked. Keep the backups and open diagnostics.';
        await this.logger.log('recovery.failed', String(e));
        break;
      }
    }
  }
}
