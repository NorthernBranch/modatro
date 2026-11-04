import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  RecordSchema,
  type AppState,
  type FileRoot,
  type InstallationRecord,
} from '../../src/shared/model';
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
import { dependencyId, inspectMetadata, parseLuaHeader } from './metadata';

interface RecoveryFile {
  root: FileRoot;
  path: string;
  hash: string;
  sizeBytes: number;
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class SetupRecoveryService {
  private pending?: {
    mode: SetupRecoveryMode;
    modId?: string;
    token: string;
    hash: string;
    expires: number;
  };
  constructor(
    private storage: Storage,
    private installer: ModInstaller,
  ) {}

  private async collect(mode: SetupRecoveryMode, modId?: string) {
    await this.installer.guard(true);
    const roots = this.installer.roots();
    const records: InstallationRecord[] = [];
    let replacement: InstallationRecord | undefined;
    let removalRecord: InstallationRecord | undefined;
    const warnings: string[] = [];
    const files: RecoveryFile[] = [];
    const add = async (root: FileRoot, relative: string) => {
      const location = await safeDestination(roots[root], relative);
      const stat = await fs.lstat(location);
      files.push({ root, path: relative, hash: await hashFile(location), sizeBytes: stat.size });
    };
    if (mode === 'repair' || mode === 'remove') {
      const record = this.storage.state.installations.find((entry) => entry.modId === modId);
      if (!record)
        throw new UserError('This installation entry no longer exists. Refresh Installed.');
      if (record.provenance?.sourceType === 'local' || record.provenance?.creator)
        throw new UserError('Use Mod Creator build history to recover this authored mod.');
      if (record.files.some((file) => file.operation !== 'created' || file.root === 'game'))
        throw new UserError(
          'This mod replaces original files or game libraries. Use its Uninstall action to restore the originals safely.',
        );
      records.push(record);
      const root = record.disabled ? 'disabled' : 'mods';
      const base = record.disabled ? `${record.modId}/` : '';
      if (record.files.some((file) => file.root !== root || (base && !file.path.startsWith(base))))
        throw new UserError(
          'This installation has an unusual file layout. Review its recorded files before recovery.',
        );
      const directory = record.disabled
        ? await safeDestination(roots.disabled, record.modId)
        : roots.mods;
      const identity = record.metadataId && dependencyId(record.metadataId).toLowerCase();
      const candidates: {
        folder: string;
        metadata: NonNullable<Awaited<ReturnType<typeof inspectMetadata>>>;
      }[] = [];
      if (identity && (await exists(directory))) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (
            (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith('.lua'))) ||
            entry.name.startsWith('.modatro-')
          )
            continue;
          const folder = await safeDestination(directory, entry.name);
          let metadata;
          try {
            metadata = entry.isDirectory()
              ? await inspectMetadata(folder)
              : parseLuaHeader(await readSmall(folder));
          } catch {
            // The selected folder is inspected again below with errors exposed.
            // Unrelated malformed metadata must not block a mod's recovery.
            continue;
          }
          if (metadata?.id && dependencyId(metadata.id).toLowerCase() === identity)
            candidates.push({ folder: entry.name, metadata });
        }
      }
      if (candidates.length > 1)
        throw new UserError(
          'Multiple folders declare this mod identity. Move the extra copies out of Mods, then review again.',
        );
      const candidate = candidates[0];
      if (mode === 'repair' && (!candidate || !candidate.metadata.version))
        throw new UserError(
          'A unique mod with matching identity and readable version could not be found. You can still review removal of its recorded files.',
        );
      const folders = new Set(
        record.files.map((file) => file.path.slice(base.length).split('/')[0]!),
      );
      if (candidate) folders.add(candidate.folder);
      const inspectedLocations = new Set<string>();
      for (const folder of folders) {
        const location = await safeDestination(roots[root], `${base}${folder}`);
        if (!(await exists(location))) continue;
        if (inspectedLocations.has(location)) continue;
        inspectedLocations.add(location);
        const relative = path.relative(roots[root], location).split(path.sep).join('/');
        const stat = await fs.lstat(location);
        // Whole-folder ownership requires matching metadata. Otherwise review
        // only the paths this installation already owned.
        let metadata;
        try {
          metadata = stat.isDirectory()
            ? await inspectMetadata(location)
            : parseLuaHeader(await readSmall(location));
        } catch (error) {
          if (mode === 'repair') throw error;
        }
        if (identity && metadata?.id && dependencyId(metadata.id).toLowerCase() === identity) {
          if (stat.isDirectory())
            await fileBatches(await walkFiles(location), (file) =>
              add(root, `${relative}/${file}`),
            );
          else await add(root, relative);
        } else {
          if (mode === 'repair')
            throw new UserError(
              'The previous folder contains files whose mod identity cannot be verified. Review removal before adopting a different copy.',
            );
          for (const file of record.files.filter(
            (file) =>
              file.root === root &&
              (file.path === relative || file.path.startsWith(`${relative}/`)),
          )) {
            if (await exists(await safeDestination(roots[root], file.path)))
              await add(root, file.path);
          }
          warnings.push(
            `${relative}: only previously recorded files are included. Other files stay in place.`,
          );
        }
      }
      if (
        files.some((file) =>
          this.storage.state.installations.some(
            (other) =>
              other.modId !== record.modId &&
              other.files.some(
                (owned) =>
                  owned.root === file.root && owned.path.toLowerCase() === file.path.toLowerCase(),
              ),
          ),
        )
      )
        throw new UserError(
          'Some reviewed files belong to another managed mod. Resolve the overlapping installation entries first.',
        );
      if (mode === 'repair') {
        const selected = files
          .filter(
            (file) =>
              file.path === `${base}${candidate!.folder}` ||
              file.path.startsWith(`${base}${candidate!.folder}/`),
          )
          .sort((a, b) => a.path.localeCompare(b.path));
        if (selected.length !== files.length)
          throw new UserError(
            'The old and updated folders both contain files. Move the old copy out of Mods before adopting the updated one.',
          );
        replacement = RecordSchema.parse({
          ...record,
          modVersion: candidate!.metadata.version,
          metadataId: candidate!.metadata.id,
          folderName: candidate!.folder,
          packageVersion: undefined,
          source: undefined,
          dependencies: candidate!.metadata.requirements,
          declaredConflicts: candidate!.metadata.conflicts,
          provenance: {
            sourceType: 'external',
            repositoryUrl: record.provenance?.repositoryUrl,
            namespace: record.provenance?.namespace,
            packageName: record.provenance?.packageName,
          },
          files: selected.map((file) => ({
            root: file.root,
            path: file.path,
            installedHash: file.hash,
            operation: 'created',
          })),
        });
        warnings.push(
          'Adopts the current files and their declared requirements. Their origin and runtime compatibility are not verified. Any previous package release version is cleared.',
        );
        warnings.push(...(await this.installer.externalRepairWarnings(replacement)));
      } else {
        if (files.length) await this.installer.assertNotRequired(record);
        if (files.length)
          removalRecord = RecordSchema.parse({
            ...record,
            modVersion: candidate?.metadata.version ?? 'Unknown',
            folderName: candidate?.folder ?? record.folderName,
            dependencies: candidate?.metadata.requirements ?? record.dependencies,
            declaredConflicts: candidate?.metadata.conflicts ?? record.declaredConflicts,
            packageVersion: undefined,
            source: undefined,
            provenance: {
              sourceType: 'external',
              repositoryUrl: record.provenance?.repositoryUrl,
              namespace: record.provenance?.namespace,
              packageName: record.provenance?.packageName,
            },
            files: [...files]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((file) => ({
                root: file.root,
                path: file.path,
                installedHash: file.hash,
                operation: 'created',
              })),
          });
      }
    } else {
      for (const record of this.storage.state.installations) {
        const present = await fileBatches(
          record.files,
          async (file) =>
            (await exists(roots[file.root])) &&
            (await exists(await safeDestination(roots[file.root], file.path))),
        );
        if (mode === 'reset' || present.every((value) => !value)) records.push(record);
      }
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
    }
    files.sort((a, b) => `${a.root}/${a.path}`.localeCompare(`${b.root}/${b.path}`));
    return { roots, records, files, replacement, removalRecord, warnings };
  }
  private signature(plan: Awaited<ReturnType<SetupRecoveryService['collect']>>) {
    return fingerprint({ state: this.storage.state, ...plan });
  }
  async review(
    mode: SetupRecoveryMode,
    modId?: string,
  ): Promise<{ status: 'review'; plan: SetupRecoveryPlan }> {
    return this.installer.transactions.locked(async () => {
      this.pending = undefined;
      const inspected = await this.collect(mode, modId);
      const token = randomUUID();
      this.pending = {
        mode,
        modId,
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
          detectedVersion: inspected.replacement?.modVersion,
          detectedFolder: inspected.replacement?.folderName,
          warnings:
            mode === 'reset'
              ? [
                  'Includes external mods, mod configuration and Lovely logs inside the selected Mods folder. Installed creator copies are removed; editable creator projects stay safe.',
                ]
              : inspected.warnings,
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
      const plan = await this.collect(pending.mode, pending.modId);
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
        if (plan.removalRecord)
          await this.installer.removed.capture(plan.removalRecord, plan.roots);
        if (this.signature(await this.collect(pending.mode, pending.modId)) !== pending.hash)
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
          (pending.mode === 'repair' ? [] : plan.files).map((file) => ({
            root: file.root,
            path: file.path,
            expectedBefore: file.hash,
          })),
          (journal) =>
            ({
              ...this.storage.state,
              installations: plan.replacement
                ? this.storage.state.installations.map((record) =>
                    record.modId === plan.replacement!.modId
                      ? { ...plan.replacement!, transactionId: journal.id }
                      : record,
                  )
                : this.storage.state.installations.filter((record) => !removed.has(record.modId)),
              profiles: plan.replacement
                ? this.storage.state.profiles
                : this.storage.state.profiles && {
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
            const remaining = await this.collect(pending.mode, pending.modId);
            if (
              pending.mode === 'reset' || pending.mode === 'remove'
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
        if (pending.mode !== 'repair')
          await this.installer.cleanupEmptyDirectories(plan.files).catch(() => []);
        if (pending.mode === 'remove') await this.installer.removed.prune().catch(() => {});
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
