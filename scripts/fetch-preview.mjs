// Development-only factual snapshot. Desktop builds use the live main-process provider.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'modatro-preview-'));
try {
  const file = path.join(temporary, 'provider.mjs');
  await build({
    entryPoints: ['src/shared/thunderstore.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const { normalizeThunderstore, THUNDERSTORE_ENDPOINT } = await import(pathToFileURL(file).href);
  const response = process.env.MODATRO_PREVIEW_FEED
    ? undefined
    : await fetch(THUNDERSTORE_ENDPOINT, {
        headers: { 'User-Agent': 'Modatro-preview' },
        signal: AbortSignal.timeout(30000),
      });
  if (response && !response.ok) throw new Error(`Thunderstore: ${response.status}`);
  const feed = response
    ? await response.json()
    : JSON.parse(await readFile(process.env.MODATRO_PREVIEW_FEED, 'utf8'));
  const mods = feed
    .map(normalizeThunderstore)
    .filter((mod) => mod && mod.installation.type !== 'unsupported');
  const selected = new Map();
  const add = (mod) => {
    if (mod) selected.set(mod.id, mod);
  };
  for (const name of ['Steamodded', 'lovely', 'JokerDisplay', 'Cryptid'])
    add(mods.find((mod) => mod.thunderstore.name === name));
  for (const mod of mods.filter((mod) => mod.categories.includes('Quality of Life'))) {
    if (
      [...selected.values()].filter((entry) => entry.categories.includes('Quality of Life'))
        .length < 4
    )
      add(mod);
  }
  for (const mod of mods.filter((mod) => !mod.categories.includes('Quality of Life'))) {
    if (selected.size < 12) add(mod);
  }
  await writeFile(
    'src/preview-catalogue.json',
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), mods: [...selected.values()] }, null, 2)}\n`,
  );
  console.log(`Saved ${selected.size} factual Thunderstore entries for browser preview.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
