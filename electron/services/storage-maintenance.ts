import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { HashSchema, RelativePath, RootSchema, StateSchema } from '../../src/shared/model';
import type { StorageMaintenanceStatus } from '../../src/shared/storage-maintenance';
import { exists, fileBatches, safeDestination, walkFiles } from './files';
import { Storage, Logger } from './storage';
import { BackupService, backupReferenceKey } from './transaction';
import { IndexCache, indexCachePath } from './mod-index';

const MAX_COUNT = 20;
const MAX_BYTES = 1024 ** 3;
const Manifest = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  mode: z.enum(['missing', 'reset', 'repair', 'remove']),
  completed: z.boolean().optional(),
  state: StateSchema,
  files: z.array(
    z.object({
      root: RootSchema,
      path: RelativePath,
      hash: HashSchema,
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
  note: z.string(),
});

// Called only while holding the existing operation lock, after journal recovery.
export class StorageMaintenance {
  private nextCleanup = 0;
  constructor(
    private storage: Storage,
    private backup: BackupService,
    private logger: Logger,
  ) {}

  async inspect(): Promise<StorageMaintenanceStatus> {
    const status: StorageMaintenanceStatus = { snapshots: [], sizeBytes: 0, warnings: [] };
    let references: Set<string>;
    try {
      references = await this.backup.references(true);
    } catch {
      status.warnings.push(
        'Backup references could not be verified. Recovery copies were retained.',
      );
      return status;
    }
    const root = await safeDestination(this.storage.root, 'backups/setup-resets');
    if (!(await exists(root))) return status;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const prefix = `backups/setup-resets/${entry.name}`;
      try {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success)
          throw new Error('Unknown recovery entry');
        const directory = await safeDestination(this.storage.root, prefix);
        const manifest = await this.storage.read(`${prefix}/manifest.json`, Manifest);
        if (!manifest) throw new Error('Missing manifest');
        const expected = new Set(['manifest.json']);
        for (const file of manifest.files) expected.add(`files/${file.root}/${file.path}`);
        for (const record of manifest.state.installations)
          for (const file of record.files) {
            if (!file.backupPath) continue;
            if (!file.backupPath.startsWith(`${prefix}/originals/`))
              throw new Error('Foreign original');
            expected.add(file.backupPath.slice(prefix.length + 1));
          }
        const files = await walkFiles(directory, { count: 100000, bytes: 32 * 1024 ** 3 });
        if (files.length !== expected.size || files.some((file) => !expected.has(file)))
          throw new Error('Incomplete or unfamiliar copy');
        // Size accounting also checks manifest sizes, without hashing gigabytes on every launch.
        const declaredSizes = new Map(
          manifest.files.map((file) => [`files/${file.root}/${file.path}`, file.sizeBytes]),
        );
        const sizes = await fileBatches(files, async (file) => {
          const size = (await fs.stat(await safeDestination(directory, file))).size;
          if (declaredSizes.has(file) && declaredSizes.get(file) !== size)
            throw new Error('Changed recovery file');
          return size;
        });
        const sizeBytes = sizes.reduce((total, size) => total + size, 0);
        status.sizeBytes += sizeBytes;
        status.snapshots.push({
          id: entry.name,
          createdAt: manifest.createdAt,
          mode: manifest.mode,
          sizeBytes,
          complete: manifest.completed === true,
          protected: [...references].some((reference) =>
            reference.startsWith(backupReferenceKey(`${prefix}/`)),
          ),
        });
      } catch {
        status.warnings.push(
          `Recovery copy ${entry.name} could not be fully checked. It was retained and its size is excluded from the total.`,
        );
      }
    }
    status.snapshots.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    if (status.snapshots.length > MAX_COUNT || status.sizeBytes > MAX_BYTES)
      status.warnings.push(
        'Recovery storage exceeds its target. The newest copy, incomplete copies and referenced originals are retained for safety.',
      );
    return status;
  }

  async cleanup(selection?: string): Promise<StorageMaintenanceStatus> {
    const before = await this.inspect();
    if (!selection && before.snapshots.length <= MAX_COUNT && before.sizeBytes <= MAX_BYTES)
      return before;
    const warnings = before.warnings.filter(
      (warning) => !warning.startsWith('Recovery storage exceeds'),
    );
    let count = before.snapshots.length,
      bytes = before.sizeBytes;
    const newest = before.snapshots.at(-1)?.id;
    for (const snapshot of before.snapshots) {
      const selected = selection === 'all' || selection === snapshot.id;
      if (!selection && count <= MAX_COUNT && bytes <= MAX_BYTES) break;
      if (selection && !selected) continue;
      if (snapshot.protected || (!selection && (!snapshot.complete || snapshot.id === newest)))
        continue;
      try {
        // Resolve against the approved snapshot root immediately before recursive deletion.
        const root = await safeDestination(this.storage.root, 'backups/setup-resets');
        const directory = await safeDestination(root, snapshot.id);
        if (path.dirname(directory) !== root) throw new Error('Invalid recovery location');
        await fs.rm(directory, { recursive: true });
        count--;
        bytes -= snapshot.sizeBytes;
      } catch {
        warnings.push(
          'A recovery copy could not be deleted. Check folder permissions and try again.',
        );
      }
    }
    const after = await this.inspect();
    if (after.snapshots.length > MAX_COUNT || after.sizeBytes > MAX_BYTES)
      warnings.push(
        'Recovery storage exceeds its target. The newest copy, incomplete copies and referenced originals are retained for safety.',
      );
    if (
      selection &&
      after.snapshots.some(
        (item) => (selection === 'all' || item.id === selection) && item.protected,
      )
    )
      warnings.push('Copies containing referenced originals were retained.');
    after.warnings = [...new Set([...warnings, ...after.warnings])];
    return after;
  }

  async scheduled(startup = false) {
    if (!startup && Date.now() < this.nextCleanup) return false;
    this.nextCleanup = Date.now() + 60 * 60 * 1000;
    if (startup) {
      const root = await safeDestination(this.storage.root, 'staging');
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          !/^(?:install|batch|toggle|profile)-[a-zA-Z0-9]{6}$/.test(entry.name)
        )
          continue;
        try {
          const directory = await safeDestination(root, entry.name);
          await walkFiles(directory, { count: 100000, bytes: 32 * 1024 ** 3 });
          if (path.dirname(directory) !== root) throw new Error('Invalid staging location');
          await fs.rm(directory, { recursive: true });
        } catch {
          await this.logger.log('storage.staging.retained', entry.name);
        }
      }
    }
    const status = await this.cleanup();
    if (status.warnings.length) await this.logger.log('storage.cleanup.deferred', status.warnings);
    const active = this.storage.state.settings.modIndexUrl;
    for (const entry of await fs.readdir(this.storage.file('catalogue-cache'), {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/^index-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const relative = `catalogue-cache/${entry.name}`;
      if (active && relative === indexCachePath(active)) continue;
      try {
        const record = await this.storage.read(relative, IndexCache);
        if (!record || indexCachePath(record.url) !== relative) throw new Error('Unverified cache');
        await fs.rm(await safeDestination(this.storage.root, relative));
      } catch {
        await this.logger.log('storage.index-cache.retained', entry.name);
      }
    }
    return true;
  }
}
