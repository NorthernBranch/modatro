import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AppState, FileRoot } from '../../src/shared/model';
import type { SetupRecoveryMode, SetupRecoveryPlan } from '../../src/shared/setup-recovery';
import {
  atomicCopy,
  contained,
  exists,
  fileBatches,
  hashFile,
  readSmall,
  safeDestination,
  walkFiles,
} from './files';
import { inspectLovelyLibrary } from './lovely';
import { ModInstaller } from './installer';
import { Storage } from './storage';
import { UserError } from './errors';

interface RecoveryFile {
  root: FileRoot;
  path: string;
  hash: string;
  sizeBytes: number;
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class SetupRecoveryService {
  private pending?: { mode: SetupRecoveryMode; token: string; hash: string; expires: number };
  constructor(
    private storage: Storage,
    private installer: ModInstaller,
  ) {}

  private async collect(mode: SetupRecoveryMode) {
    await this.installer.guard(true);
    const roots = this.installer.roots();
    const records = [];
    for (const record of this.storage.state.installations) {
      const present = await fileBatches(
        record.files,
        async (file) =>
          (await exists(roots[file.root])) &&
          (await exists(await safeDestination(roots[file.root], file.path))),
      );
      if (mode === 'reset' || present.every((value) => !value)) records.push(record);
    }
    const files: RecoveryFile[] = [];
    if (mode === 'reset') {
      if (
        records.some((record) =>
          record.files.some(
            (file) =>
              file.root === 'game' &&
              !/^(?:winmm\.dll|version\.dll|liblovely\.dylib)$/i.test(file.path),
          ),
        )
      )
        throw new UserError(
          'A managed mod changes other game files. Uninstall that mod before resetting; base game files will not be removed.',
        );
      const add = async (root: FileRoot, relative: string) => {
        const location = await safeDestination(roots[root], relative);
        const stat = await fs.lstat(location);
        files.push({ root, path: relative, hash: await hashFile(location), sizeBytes: stat.size });
      };
      for (const root of ['mods', 'disabled'] as const)
        if (await exists(roots[root]))
          await fileBatches(
            await walkFiles(roots[root], {
              count: 50000,
              bytes: 20 * 1024 ** 3,
            }),
            (relative) => add(root, relative),
          );
      const candidates = (await fs.readdir(roots.game)).filter((name) =>
        /^(?:winmm\.dll|version\.dll|liblovely\.dylib)$/i.test(name),
      );
      for (const name of candidates) {
        const owned = records
          .flatMap((record) => record.files)
          .find((file) => file.root === 'game' && file.path.toLowerCase() === name.toLowerCase());
        if (
          !(
            await inspectLovelyLibrary(
              await safeDestination(roots.game, name),
              owned?.installedHash,
            )
          ).identified
        )
          throw new UserError(
            `${name} could not be identified as Lovely. Review it in the game folder before resetting; unknown game libraries are left untouched.`,
          );
        await add('game', name);
      }
    }
    files.sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`));
    return { roots, records, files };
  }
  private signature(plan: Awaited<ReturnType<SetupRecoveryService['collect']>>) {
    return fingerprint({ state: this.storage.state, ...plan });
  }
  async review(mode: SetupRecoveryMode): Promise<{ status: 'review'; plan: SetupRecoveryPlan }> {
    return this.installer.transactions.locked(async () => {
      this.pending = undefined;
      const inspected = await this.collect(mode);
      const token = randomUUID();
      this.pending = {
        mode,
        token,
        hash: this.signature(inspected),
        expires: Date.now() + 10 * 60 * 1000,
      };
      return {
        status: 'review',
        plan: {
          mode,
          token,
          gamePath: inspected.roots.game,
          modsPath: inspected.roots.mods,
          records: inspected.records.map((record) => ({ id: record.modId, title: record.title })),
          files: inspected.files.map(({ hash: _hash, ...file }) => file),
          sizeBytes: inspected.files.reduce((total, file) => total + file.sizeBytes, 0),
          warnings:
            mode === 'reset'
              ? [
                  'Includes external mods, mod configuration and Lovely logs inside the selected Mods folder. Installed creator copies are removed; editable creator projects stay safe.',
                ]
              : [],
        },
      };
    });
  }
  async apply(token: string) {
    return this.installer.transactions.locked(async () => {
      const pending = this.pending;
      this.pending = undefined;
      if (!pending || pending.token !== token || pending.expires < Date.now())
        throw new UserError('This recovery preview has expired. Review the setup again.');
      const plan = await this.collect(pending.mode);
      if (this.signature(plan) !== pending.hash)
        throw new UserError('Your mod setup changed. Review a fresh preview before continuing.');
      if (!plan.records.length && !plan.files.length)
        throw new UserError('There is nothing to clean up in this setup.');
      const prefix = `backups/setup-resets/${randomUUID()}`;
      let backupComplete = false;
      try {
        const saved = structuredClone(this.storage.state);
        // A durable, self-contained recovery copy is separate from transaction
        // scratch backups, which normal maintenance is allowed to prune.
        await fileBatches(plan.files, async (file) => {
          const source = await safeDestination(plan.roots[file.root], file.path);
          const destination = await safeDestination(
            this.storage.root,
            `${prefix}/files/${file.root}/${file.path}`,
          );
          if ((await hashFile(source)) !== file.hash)
            throw new UserError('A mod file changed before backup. Nothing was removed.');
          await atomicCopy(source, destination);
          if ((await hashFile(destination)) !== file.hash || (await hashFile(source)) !== file.hash)
            throw new UserError('A recovery copy could not be verified. Nothing was removed.');
        });
        const originals = new Map<string, string>();
        for (const record of saved.installations)
          for (const file of record.files) {
            if (!file.backupPath) continue;
            let copy = originals.get(file.backupPath);
            if (!copy) {
              const source = await this.installer.transactions.backup.verified(
                file.backupPath,
                file.originalHash!,
              );
              copy = (
                await this.installer.transactions.backup.capture(
                  `setup-resets/${path.posix.basename(prefix)}/originals`,
                  originals.size,
                  source,
                  file.originalHash,
                )
              ).path;
              originals.set(file.backupPath, copy);
            }
            file.backupPath = copy;
          }
        const manifest = {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          mode: pending.mode,
          state: saved,
          files: plan.files,
          note: 'Recovery files mirror their former game, mods and disabled locations under files/. Missing files were already absent and cannot be restored from this copy.',
        };
        await this.storage.write(`${prefix}/manifest.json`, manifest);
        const verifyBackup = async () => {
          const recorded = JSON.parse(
            await readSmall(
              await safeDestination(this.storage.root, `${prefix}/manifest.json`),
              32 * 1024 * 1024,
            ),
          );
          if (fingerprint(recorded) !== fingerprint(manifest))
            throw new UserError(
              'Recovery records could not be verified. Your mod files were preserved.',
            );
          await fileBatches(plan.files, async (file) => {
            if (
              (await hashFile(
                await safeDestination(
                  this.storage.root,
                  `${prefix}/files/${file.root}/${file.path}`,
                ),
              )) !== file.hash
            )
              throw new UserError('A recovery copy changed. Your mod files were preserved.');
          });
          for (const record of saved.installations)
            for (const file of record.files)
              if (file.backupPath)
                await this.installer.transactions.backup.verified(
                  file.backupPath,
                  file.originalHash!,
                );
        };
        await verifyBackup();
        backupComplete = true;
        if (this.signature(await this.collect(pending.mode)) !== pending.hash)
          throw new UserError(
            'The setup changed while backing up. Your files remain unchanged; review a fresh preview.',
          );
        if (!(await exists(plan.roots.mods))) {
          // guard(true) only permits a missing, verified default Mods location.
          await fs.mkdir(plan.roots.mods, { recursive: true });
          await this.installer.guard();
        }
        const removed = new Set(plan.records.map((record) => record.modId));
        await this.installer.transactions.execute(
          plan.roots,
          plan.files.map((file) => ({
            root: file.root,
            path: file.path,
            expectedBefore: file.hash,
          })),
          () =>
            ({
              ...this.storage.state,
              installations: this.storage.state.installations.filter(
                (record) => !removed.has(record.modId),
              ),
              profiles: this.storage.state.profiles && {
                ...this.storage.state.profiles,
                items: this.storage.state.profiles.items.map((profile) => ({
                  ...profile,
                  selection: profile.selection.filter((entry) => !removed.has(entry.id)),
                })),
              },
            }) satisfies AppState,
          'setup-recovery',
          async () => {
            await this.installer.guard();
            await verifyBackup();
            const remaining = await this.collect(pending.mode);
            if (
              pending.mode === 'reset'
                ? remaining.files.length > 0
                : this.signature(remaining) !== pending.hash
            )
              throw new UserError(
                'The setup changed during recovery. The previous files and records will be restored.',
              );
          },
        );
        // Cleanup only removes now-empty directories, never the selected root.
        // A cleanup failure cannot turn a completed reset into a failed operation.
        await this.installer.cleanupEmptyDirectories(plan.files).catch(() => []);
        return { status: 'complete' as const, backupFolder: this.storage.file(prefix) };
      } catch (error) {
        if (!backupComplete) {
          try {
            const directory = await safeDestination(this.storage.root, prefix);
            if (
              contained(this.storage.file('backups/setup-resets'), directory) &&
              path.basename(directory) === path.posix.basename(prefix)
            )
              await fs.rm(directory, { recursive: true, force: true });
          } catch {
            /* Preserve the original failure if an incomplete copy cannot be cleaned up. */
          }
        }
        if (error instanceof UserError) throw error;
        throw new UserError(
          backupComplete
            ? 'Recovery could not finish. Keep the recovery copy and review the technical details before retrying.'
            : 'The recovery backup could not be created. No mod files were removed. Free up space or check permissions and try again.',
          undefined,
          String(error),
        );
      }
    });
  }
}
