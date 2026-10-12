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
    settings: { theme: 'dark', setupComplete: false },
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
  constructor(
    private storage: Storage,
    private home: string,
  ) {}
  async log(event: string, details?: unknown) {
    try {
      const clean = JSON.stringify({ time: new Date().toISOString(), event, details })
        .replaceAll(this.home, '~')
        .replace(/([A-Z]:\\Users\\)[^\\" ]+/gi, '$1<user>');
      const file = await safeDestination(this.storage.root, 'logs/modatro.log');
      if ((await exists(file)) && (await fs.stat(file)).size > 5 * 1024 * 1024)
        await fs.rename(file, this.storage.file(`logs/modatro-${Date.now()}.log`));
      await fs.appendFile(file, `${clean}\n`, { mode: 0o600 });
    } catch {
      /* Logging failure must not interrupt rollback. */
    }
  }
}
