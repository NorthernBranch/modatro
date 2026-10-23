import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  HashSchema,
  RecordSchema,
  RelativePath,
  RootSchema,
  type FileRoot,
  type InstallationRecord,
} from '../../src/shared/model';
import { BackupService, backupReferenceKey } from './transaction';
import { exists, hashFile, safeDestination } from './files';
import { Storage } from './storage';
import { UserError } from './errors';

const RemovedSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  removedAt: z.iso.datetime(),
  record: RecordSchema,
  copies: z
    .array(
      z.object({
        root: RootSchema,
        path: RelativePath,
        backupPath: RelativePath,
        hash: HashSchema,
      }),
    )
    .min(1),
});

const MAX_SNAPSHOTS = 20;
const MAX_BYTES = 1024 ** 3;
// Kept separately from transaction scratch files. Only complete, recognized
// uninstall snapshots are eligible for deletion, under the operation lock.
export class RemovedMods {
  private cleanupWarning?: string;
  constructor(
    private storage: Storage,
    private backup: BackupService,
  ) {}
  async list() {
    return (await this.inspect()).items;
  }
  async inspect(verifyActive = false) {
    const items: (z.infer<typeof RemovedSchema> & { sizeBytes: number; protected: boolean })[] = [];
    const warnings: string[] = [];
    let references: Set<string> | undefined;
    try {
      references = await this.backup.references(verifyActive);
    } catch {
      warnings.push(
        'Installation or recovery references could not be verified. All uninstall backups were preserved.',
      );
    }
    let sizeBytes = 0,
      sizeIncomplete = false,
      count = 0,
      invalid = 0;
    try {
      const directory = await safeDestination(this.storage.root, 'backups/removed');
      if (await exists(directory))
        for (const name of await fs.readdir(directory)) {
          count++;
          const prefix = `backups/removed/${name}`;
          const files = new Set<string>();
          let bytes = 0,
            complete = true;
          const measure = async (relative: string): Promise<void> => {
            try {
              const location = await safeDestination(this.storage.root, relative);
              const stat = await fs.lstat(location);
              if (stat.isFile()) {
                bytes += stat.size;
                files.add(relative);
              } else if (stat.isDirectory()) {
                for (const child of await fs.readdir(location))
                  await measure(`${relative}/${child}`);
              } else complete = false;
            } catch {
              complete = false;
            }
          };
          await measure(prefix);
          sizeBytes += bytes;
          sizeIncomplete ||= !complete;
          try {
            if (!complete) throw new Error('Unreadable snapshot');
            const item = await this.read(name);
            const expected = new Set([
              `${prefix}/manifest.json`,
              ...item.copies.map((copy) => copy.backupPath),
              ...item.record.files.flatMap((file) => (file.backupPath ? [file.backupPath] : [])),
            ]);
            if (files.size !== expected.size || [...files].some((file) => !expected.has(file)))
              throw new Error('Unrecognized or missing snapshot files');
            items.push({
              ...item,
              sizeBytes: bytes,
              protected:
                !references ||
                [...references].some((file) => file.startsWith(backupReferenceKey(`${prefix}/`))),
            });
          } catch {
            invalid++;
          }
        }
    } catch {
      sizeIncomplete = true;
      warnings.push(
        'Uninstall backup storage could not be fully read. Cleanup could not fully complete; unreadable backups were preserved.',
      );
    }
    if (invalid)
      warnings.push(
        `${invalid} unrecognized or unreadable uninstall backup record(s) were preserved. Cleanup could not fully complete. Open the backups folder in Settings to investigate.`,
      );
    const protectedCount = items.filter((item) => item.protected).length;
    const overLimit = count > MAX_SNAPSHOTS || sizeBytes > MAX_BYTES;
    if (protectedCount && references)
      warnings.push(
        `${protectedCount} backup(s) contain originals required by installations or recovery records and cannot be deleted.${overLimit ? ' These protected copies may prevent meeting the 20-backup / 1 GiB limits.' : ''}`,
      );
    if (overLimit && (!protectedCount || !references))
      warnings.push(
        'Uninstall backup storage exceeds the 20-backup / 1 GiB limits. Cleanup will retry at the next startup or uninstall; unverified records are preserved.',
      );
    if (this.cleanupWarning) warnings.push(this.cleanupWarning);
    return {
      items: items.sort(
        (a, b) => b.removedAt.localeCompare(a.removedAt) || a.id.localeCompare(b.id),
      ),
      sizeBytes,
      sizeIncomplete,
      count,
      warnings,
    };
  }
  async read(id: string) {
    z.uuid().parse(id);
    const item = await this.storage.read(`backups/removed/${id}/manifest.json`, RemovedSchema);
    if (!item || item.id !== id)
      throw new UserError('This uninstall backup could not be verified.');
    const prefix = `backups/removed/${id}/`;
    if (
      item.copies.length !== item.record.files.length ||
      item.copies.some((copy, index) => {
        const file = item.record.files[index]!;
        return (
          !copy.backupPath.startsWith(prefix) ||
          copy.root !== file.root ||
          copy.path !== file.path ||
          copy.hash !== file.installedHash
        );
      }) ||
      item.record.files.some((file) => file.backupPath && !file.backupPath.startsWith(prefix))
    )
      throw new UserError('The uninstall backup has inconsistent file records.');
    return item;
  }
  async capture(record: InstallationRecord, roots: Record<FileRoot, string>) {
    const id = randomUUID();
    const directory = await safeDestination(this.storage.root, `backups/removed/${id}`);
    try {
      const saved = structuredClone(record);
      const copies: z.infer<typeof RemovedSchema>['copies'] = [];
      for (const [index, file] of saved.files.entries()) {
        const source = await safeDestination(roots[file.root], file.path);
        const captured = await this.backup.capture(
          `removed/${id}`,
          index * 2,
          source,
          await hashFile(source),
        );
        file.installedHash = captured.hash;
        copies.push({
          root: file.root,
          path: file.path,
          backupPath: captured.path,
          hash: captured.hash,
        });
        if (file.operation === 'replaced') {
          const original = await this.backup.verified(file.backupPath!, file.originalHash!);
          file.backupPath = (
            await this.backup.capture(`removed/${id}`, index * 2 + 1, original, file.originalHash)
          ).path;
        }
      }
      const item = RemovedSchema.parse({
        schemaVersion: 1,
        id,
        removedAt: new Date().toISOString(),
        record: saved,
        copies,
      });
      await this.storage.write(`backups/removed/${id}/manifest.json`, item);
      return item;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new UserError(
        'The uninstall backup could not be created. Nothing was removed. Free up space or check folder permissions and try again.',
        undefined,
        String(error),
      );
    }
  }
  async prune() {
    return this.cleanup();
  }
  // Callers hold TransactionEngine.locked, including startup and manual cleanup.
  async cleanup(selection?: 'all' | string) {
    this.cleanupWarning = undefined;
    const status = await this.inspect(true);
    let count = status.count,
      bytes = status.sizeBytes,
      deleted = 0,
      failures = 0;
    for (const item of [...status.items].reverse()) {
      if (item.protected || (selection && selection !== 'all' && selection !== item.id)) continue;
      if (!selection && count <= MAX_SNAPSHOTS && bytes <= MAX_BYTES) break;
      try {
        // Resolve the complete absolute target again immediately before removal.
        const directory = await safeDestination(this.storage.root, `backups/removed/${item.id}`);
        await fs.rm(directory, { recursive: true });
        count--;
        bytes -= item.sizeBytes;
        deleted++;
      } catch {
        failures++;
      }
    }
    if (failures)
      this.cleanupWarning = `${failures} uninstall backup(s) could not be deleted. Remaining files and records were retained; cleanup could not fully complete. Check folder permissions and retry.`;
    // Read actual disk totals again: a failed removal can leave a partial copy.
    const remaining = await this.inspect();
    return { deleted, retained: remaining.count };
  }
}
