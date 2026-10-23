import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  HashSchema,
  RecordSchema,
  RelativePath,
  RootSchema,
  StateSchema,
  type FileRoot,
  type InstallationRecord,
} from '../../src/shared/model';
import { BackupService } from './transaction';
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

// Kept separately from transaction scratch files. Keep the 20 most recent
// uninstall snapshots, including their own copies of any replaced originals.
export class RemovedMods {
  constructor(
    private storage: Storage,
    private backup: BackupService,
  ) {}
  async list() {
    const directory = await safeDestination(this.storage.root, 'backups/removed');
    if (!(await exists(directory))) return [];
    const items: z.infer<typeof RemovedSchema>[] = [];
    for (const name of await fs.readdir(directory)) {
      if (!z.uuid().safeParse(name).success) continue;
      if (
        !(await exists(
          await safeDestination(this.storage.root, `backups/removed/${name}/manifest.json`),
        ))
      )
        continue;
      const item = await this.read(name);
      if (item) items.push(item);
    }
    return items.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
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
    const states = [this.storage.state];
    for (const name of await fs.readdir(this.storage.file('data'))) {
      if (!/^state-v\d+(?:-[a-f0-9]{16})?\.backup\.json$/.test(name)) continue;
      const state = await this.storage.read(`data/${name}`, StateSchema);
      if (state) states.push(state);
    }
    for (const item of (await this.list()).slice(20)) {
      // A restored file-replacing mod may still depend on this snapshot's originals.
      if (
        states.some((state) =>
          state.installations.some((record) =>
            record.files.some((file) => file.backupPath?.startsWith(`backups/removed/${item.id}/`)),
          ),
        )
      )
        continue;
      const directory = await safeDestination(this.storage.root, `backups/removed/${item.id}`);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
