import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'modatro-catalogue-'));
try {
  const result = await build({
    entryPoints: ['scripts/catalogue-build.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const file = path.join(temporary, 'compiler.mjs');
  await writeFile(file, result.outputFiles[0].contents);
  const { compileCatalogue } = await import(pathToFileURL(file).href);
  const catalogue = await compileCatalogue(
    path.resolve('catalogue'),
    process.argv.includes('--check'),
  );
  console.log(`Validated ${catalogue.mods.length} native catalogue entries.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
