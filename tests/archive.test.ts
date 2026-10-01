import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, validateArchiveEntry } from '../electron/services/archive';
import { exists } from '../electron/services/files';
import { detectModRoot } from '../electron/services/metadata';
import { put, tempRoot, zip } from './helpers';
const roots: string[] = [];
async function fixture() {
  const root = await tempRoot();
  roots.push(root);
  const stage = path.join(root, 'stage');
  await fs.mkdir(stage);
  return { root, stage, archive: path.join(root, 'mod.zip') };
}
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
describe('archive extraction', () => {
  it('extracts a nested GitHub archive into staging and finds the actual mod root', async () => {
    const f = await fixture();
    await fs.writeFile(f.archive, zip([{ name: 'release-v1/MyMod/main.lua', data: 'return {}' }]));
    await new ArchiveService().extract(f.archive, f.stage, new AbortController().signal);
    expect(await detectModRoot(f.stage)).toBe(path.join(f.stage, 'release-v1', 'MyMod'));
  });
  it('recognises an isolated Lovely patch', async () => {
    const f = await fixture();
    await put(path.join(f.stage, 'Patch', 'lovely', 'patch.toml'), '[manifest]\nversion = "1.0.0"');
    expect(await detectModRoot(f.stage)).toBe(path.join(f.stage, 'Patch'));
  });
  it('rejects an ambiguous archive', async () => {
    const f = await fixture();
    await put(path.join(f.stage, 'One', 'main.lua'));
    await put(path.join(f.stage, 'Two', 'main.lua'));
    await expect(detectModRoot(f.stage)).rejects.toThrow('multiple');
  });
  it('rejects an unidentifiable archive', async () => {
    const f = await fixture();
    await put(path.join(f.stage, 'README.md'));
    await expect(detectModRoot(f.stage)).rejects.toThrow('could not identify');
  });
  it.each(['../../escape.lua', '/absolute.lua', 'C:/Windows/evil.lua', 'foo\\..\\evil.lua'])(
    'rejects malicious archive path %s',
    async (name) => {
      const f = await fixture();
      await fs.writeFile(f.archive, zip([{ name, data: 'evil' }]));
      await expect(
        new ArchiveService().extract(f.archive, f.stage, new AbortController().signal),
      ).rejects.toThrow();
      expect(await exists(path.join(f.root, 'escape.lua'))).toBe(false);
    },
  );
  it('rejects symlink entries', async () => {
    const f = await fixture();
    await fs.writeFile(f.archive, zip([{ name: 'link', data: '/etc', mode: 0o120777 }]));
    await expect(
      new ArchiveService().extract(f.archive, f.stage, new AbortController().signal),
    ).rejects.toThrow('symbolic');
  });
  it('rejects case-conflicting paths', async () => {
    const f = await fixture();
    await fs.writeFile(
      f.archive,
      zip([
        { name: 'Mod/main.lua', data: 'a' },
        { name: 'Mod/MAIN.lua', data: 'b' },
      ]),
    );
    await expect(
      new ArchiveService().extract(f.archive, f.stage, new AbortController().signal),
    ).rejects.toThrow('case-conflicting');
  });
  it('rejects corrupt archive checksums', async () => {
    const f = await fixture();
    await fs.writeFile(f.archive, zip([{ name: 'Mod/main.lua', data: 'bad', badCrc: true }]));
    await expect(
      new ArchiveService().extract(f.archive, f.stage, new AbortController().signal),
    ).rejects.toThrow('corrupt');
  });
  it('rejects invalid download bodies', async () => {
    const f = await fixture();
    await put(f.archive, '<html>not a zip</html>');
    await expect(
      new ArchiveService().extract(f.archive, f.stage, new AbortController().signal),
    ).rejects.toThrow('not a valid');
    expect(await fs.readdir(f.stage)).toEqual([]);
  });
  it('rejects obvious decompression bombs', () => {
    expect(() =>
      validateArchiveEntry({
        fileName: 'bomb.lua',
        externalFileAttributes: 0,
        compressedSize: 10,
        uncompressedSize: 20 * 1024 * 1024,
      }),
    ).toThrow('decompression');
  });
});
