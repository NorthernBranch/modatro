import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { StateSchema, type AppState } from '../../src/shared/model';
import { UserError } from './errors';
import { atomicWrite, canonicalDirectory, exists, readSmall, safeDestination } from './files';

export class Storage {
  state: AppState = {
    schemaVersion: 1,
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
        this.state = StateSchema.parse(JSON.parse(await readSmall(file, 20 * 1024 * 1024)));
      } catch {
        this.safetyError =
          'Modatro’s saved installation records could not be verified. File changes are locked to protect your mods. Keep the data folder and backups, and use diagnostics to investigate.';
      }
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
