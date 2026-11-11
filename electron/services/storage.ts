import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StateSchema, type AppState } from '../../src/shared/model';
import { selection } from '../../src/shared/profile-selection';
import { UserError } from './errors';
import { atomicWrite, canonicalDirectory, exists, readSmall, safeDestination } from './files';

export class Storage {
  state: AppState = {
    schemaVersion: 2,
    // New installations follow the system theme.
    settings: { theme: 'system', setupComplete: false },
    installations: [],
  };
  safetyError?: string;
  constructor(public root: string) {}
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await canonicalDirectory(this.root);
    for (const dir of [
      'data',
      'catalogue-cache',
      'downloads',
      'staging',
      'backups',
      'logs',
      'disabled',
      'transactions',
    ]) {
      const p = await safeDestination(this.root, dir);
      await fs.mkdir(p, { recursive: true });
    }
    const file = this.file('data/state.json');
    if (await exists(file)) {
      // Existing installations keep the earlier dark default, even if their records are unreadable.
      this.state.settings.theme = 'dark';
      try {
        const original = await readSmall(file, 20 * 1024 * 1024);
        this.state = StateSchema.parse(JSON.parse(original));
      } catch {
        this.safetyError =
          'Modatro’s saved installation records could not be verified. File changes are locked to protect your mods. Keep the data folder and backups, and use diagnostics to investigate.';
      }
    }
    // Recover old journals against their unchanged before-state before migrating.
    let pending = false;
    for (const name of await fs.readdir(this.file('transactions'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const journal = JSON.parse(
          await readSmall(
            await safeDestination(this.root, `transactions/${name}`),
            20 * 1024 * 1024,
          ),
        );
        if (journal.phase === 'prepared') pending = true;
      } catch {
        pending = true;
      }
    }
    if (!pending) await this.migrateProfiles();
  }
  async migrateProfiles() {
    if (this.safetyError || this.state.schemaVersion === 3) return;
    try {
      const original = JSON.stringify(this.state, null, 2);
      const file = this.file('data/state.json');
      const raw = (await exists(file)) ? await readSmall(file, 20 * 1024 * 1024) : original;
      const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      if (await exists(file)) {
        let backup = await safeDestination(
          this.root,
          this.state.schemaVersion === 1
            ? 'data/state-v1.backup.json'
            : `data/state-v${this.state.schemaVersion}-${digest}.backup.json`,
        );
        if (
          this.state.schemaVersion === 1 &&
          (await exists(backup)) &&
          (await readSmall(backup, 20 * 1024 * 1024)) !== raw
        )
          backup = await safeDestination(this.root, `data/state-v1-${digest}.backup.json`);
        if (await exists(backup)) {
          if ((await readSmall(backup, 20 * 1024 * 1024)) !== raw)
            throw new Error('Migration backup differs');
        } else await atomicWrite(backup, raw);
      }
      const id = randomUUID();
      const migrated = StateSchema.parse({
        ...this.state,
        schemaVersion: 3,
        installations: this.state.installations.map((record) => ({
          ...record,
          provenance: record.provenance ?? { sourceType: record.adopted ? 'external' : 'legacy' },
        })),
        profiles: {
          schemaVersion: 1,
          activeId: id,
          items: [{ id, name: 'Default', selection: selection(this.state.installations) }],
        },
      });
      await atomicWrite(file, JSON.stringify(migrated, null, 2));
      this.state = migrated;
    } catch {
      this.safetyError =
        'The profile migration could not be completed. Installation records and backups were preserved; file changes are locked.';
    }
  }
  file(relative: string): string {
    return path.join(this.root, relative);
  }
  assertSafe() {
    if (this.safetyError) throw new UserError(this.safetyError);
  }
  async save(next: AppState) {
    this.assertSafe();
    const checked = StateSchema.parse(next);
    try {
      await atomicWrite(
        await safeDestination(this.root, 'data/state.json'),
        JSON.stringify(checked, null, 2),
      );
    } catch (error) {
      // A directory fsync can fail after the atomic rename has already saved
      // the commit marker. Reconcile it before the installer decides to roll back.
      try {
        const saved = await this.read('data/state.json', StateSchema);
        if (saved && JSON.stringify(saved) === JSON.stringify(checked)) this.state = saved;
      } catch {
        /* Preserve the previous in-memory state if disk data is invalid. */
      }
      throw error;
    }
    this.state = checked;
  }
  async read<T>(relative: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const file = await safeDestination(this.root, relative);
    if (!(await exists(file))) return undefined;
    return schema.parse(JSON.parse(await readSmall(file, 30 * 1024 * 1024)));
  }
  async write(relative: string, value: unknown) {
    await atomicWrite(await safeDestination(this.root, relative), JSON.stringify(value, null, 2));
  }
}
export class Logger {
  private pending: Promise<void> = Promise.resolve();
  private prunePending = true;
  constructor(
    private storage: Storage,
    private home: string,
  ) {}
  log(event: string, details?: unknown) {
    const write = this.pending.then(() => this.write(event, details));
    this.pending = write;
    return write;
  }
  private async write(event: string, details?: unknown) {
    try {
      let clean = JSON.stringify({ time: new Date().toISOString(), event, details })
        .replaceAll(this.home, '~')
        .replace(/([A-Z]:\\Users\\)[^\\" ]+/gi, '$1<user>');
      if (Buffer.byteLength(clean) > 64 * 1024)
        clean = JSON.stringify({
          time: new Date().toISOString(),
          event,
          truncated: true,
          sample: clean.slice(0, 12000),
        });
      const file = await safeDestination(this.storage.root, 'logs/modatro.log');
      if (
        (await exists(file)) &&
        (await fs.stat(file)).size + Buffer.byteLength(clean) + 1 > 5 * 1024 * 1024
      ) {
        await fs.rename(
          file,
          await safeDestination(
            this.storage.root,
            `logs/modatro-${Date.now()}-${randomUUID()}.log`,
          ),
        );
        this.prunePending = true;
      }
      await fs.appendFile(file, `${clean}\n`, { mode: 0o600 });
      if (!this.prunePending) return;
      const archived = (await fs.readdir(this.storage.file('logs'), { withFileTypes: true }))
        .filter(
          (entry) => entry.isFile() && /^modatro-\d+(?:-[a-f0-9-]{36})?\.log$/.test(entry.name),
        )
        .map((entry) => ({
          name: entry.name,
          time: Number(entry.name.split('-')[1]!.split('.')[0]),
        }))
        .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
      let kept = 0,
        bytes = 0;
      for (const entry of archived) {
        const archivedFile = await safeDestination(this.storage.root, `logs/${entry.name}`);
        const size = (await fs.stat(archivedFile)).size;
        if (kept >= 5 || bytes + size > 25 * 1024 ** 2) await fs.rm(archivedFile);
        else {
          kept++;
          bytes += size;
        }
      }
      this.prunePending = false;
    } catch {
      /* Logging failure must not interrupt rollback. */
    }
  }
}
