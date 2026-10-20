import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Synthetic files only: never discovers or opens a user's game or app data.
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-perf-')));
try {
  const bundle = path.join(root, 'services.cjs');
  await build({
    stdin: {
      contents:
        "export * from './electron/services/files'; export {Storage,Logger} from './electron/services/storage'; export {TransactionEngine} from './electron/services/transaction';",
      resolveDir: repository,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  });
  const services = createRequire(import.meta.url)(bundle);
  const results = [];
  for (let trial = 0; trial < 3; trial++) {
    const base = path.join(root, String(trial));
    const storage = new services.Storage(path.join(base, 'app'));
    await storage.initialize();
    const roots = {
      game: path.join(base, 'game'),
      mods: path.join(base, 'mods'),
      disabled: storage.file('disabled'),
    };
    for (const dir of [roots.game, path.join(roots.mods, 'Bench'), storage.file('staging/bench')])
      await fs.mkdir(dir, { recursive: true });
    await storage.save({
      ...storage.state,
      settings: { ...storage.state.settings, gamePath: roots.game, modsPath: roots.mods },
    });
    const engine = new services.TransactionEngine(storage, new services.Logger(storage, base));
    const files = Array.from({ length: 128 }, (_, i) => `Bench/${i}.lua`);
    const bytes = Buffer.alloc(4096, 97),
      hash = createHash('sha256').update(bytes).digest('hex');
    await Promise.all(files.map((file) => fs.writeFile(path.join(roots.mods, file), bytes)));
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const id = randomUUID();
        await fs.writeFile(
          storage.file(`transactions/${id}.json`),
          JSON.stringify({
            id,
            roots,
            changes: [],
            createdDirectories: [],
            previousState: storage.state,
            phase: 'committed',
          }),
        );
      }),
    );
    const time = async (work) => {
      const start = performance.now();
      await work();
      return Math.round(performance.now() - start);
    };
    const firstRecoveryMs = await time(() => engine.recover());
    const repeatRecoveryMs = await time(() => engine.recover());
    const staged = files.map((_, i) => storage.file(`staging/bench/${i}`));
    const stagingMs = await time(async () => {
      if (services.stageCopy)
        await services.fileBatches(
          files.map((file, i) => ({ file, i })),
          ({ file, i }) => services.stageCopy(path.join(roots.mods, file), staged[i]),
        );
      else
        for (let i = 0; i < files.length; i++)
          await services.atomicCopy(path.join(roots.mods, files[i]), staged[i]);
    });
    const changes = files.flatMap((file, i) => [
      { root: 'disabled', path: `bench/${file}`, source: staged[i], afterHash: hash },
      { root: 'mods', path: file, expectedBefore: hash },
    ]);
    const transactionMs = await time(() =>
      engine.locked(() => engine.execute(roots, changes, () => storage.state, 'benchmark')),
    );
    // Verify the actual result, outside the timed region.
    for (const file of files)
      if ((await services.hashFile(path.join(roots.disabled, 'bench', file))) !== hash)
        throw new Error('Benchmark file differs');
    results.push({
      firstRecoveryMs,
      repeatRecoveryMs,
      stagingMs,
      transactionMs,
      totalMs: stagingMs + transactionMs,
      journals: (await fs.readdir(storage.file('transactions'))).length,
    });
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        files: 128,
        bytesPerFile: 4096,
        oldJournals: 200,
        trials: results,
      },
      null,
      2,
    ),
  );
} finally {
  // root was created by this script beneath the canonical temporary directory.
  const temporary = await fs.realpath(os.tmpdir());
  if (path.dirname(root) !== temporary || !path.basename(root).startsWith('modatro-perf-'))
    throw new Error('Unsafe benchmark cleanup path');
  await fs.rm(root, { recursive: true, force: true });
}
