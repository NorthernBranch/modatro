import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const moduleFile = path.join(root, 'test-results/creator-art-generator.cjs');
await build({
  stdin: {
    contents: "export { builtinArtwork, cardArtwork } from './electron/services/creator-art';",
    resolveDir: root,
  },
  outfile: moduleFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { builtinArtwork, cardArtwork } = createRequire(import.meta.url)(moduleFile);
const dir = path.join(root, 'public/creator-art');
await mkdir(dir, { recursive: true });
for (const type of ['joker', 'deck', 'voucher'])
  for (let variant = 1; variant <= 5; variant++) {
    const id = `${type}-${variant}`;
    await writeFile(
      path.join(dir, `${id}.png`),
      cardArtwork(builtinArtwork(id), { x: 0.5, y: 0.5, zoom: 1 }, 1),
    );
  }
console.log(
  'Generated 15 original CC0 artwork designs. Builds generate matching 1x and 2x atlases.',
);
