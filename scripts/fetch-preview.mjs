// Development-only snapshot. Desktop builds use the live main-process provider.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'modatro-preview-'));
try {
  await build({
    entryPoints: ['electron/services/sources/thunderstore-client.ts', 'src/shared/thunderstore.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: temporary,
    outExtension: { '.js': '.mjs' },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const { normalizeThunderstore } = await import(
    pathToFileURL(path.join(temporary, 'src/shared/thunderstore.mjs')).href
  );
  const { readThunderstoreCatalogue } = await import(
    pathToFileURL(path.join(temporary, 'electron/services/sources/thunderstore-client.mjs')).href
  );
  const feed = process.env.MODATRO_PREVIEW_FEED
    ? JSON.parse(await readFile(process.env.MODATRO_PREVIEW_FEED, 'utf8'))
    : await readThunderstoreCatalogue();
  const mods = feed
    .flatMap((raw) => {
      try {
        const mod = normalizeThunderstore(raw);
        return mod ? [mod] : [];
      } catch (error) {
        console.warn(`Skipping invalid package: ${error.message}`);
        return [];
      }
    })
    .filter((mod) => mod && mod.installation.type !== 'unsupported');
  await writeFile(
    process.env.MODATRO_PREVIEW_OUTPUT ?? 'src/preview-catalogue.json',
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), mods }, null, 2)}\n`,
  );
  console.log(`Saved ${mods.length} Thunderstore entries for browser preview.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
