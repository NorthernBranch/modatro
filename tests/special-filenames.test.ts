import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, validateArchiveEntry } from '../electron/services/archive';
import { exists } from '../electron/services/files';
import { RelativePath } from '../src/shared/model';
import { mod, setup, tempRoot, zip } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

// names from Hot Potato and Fish and Chips, plus other common ones
const ACCEPTED = [
  'assets/1x/Oops! All Programmers/oap_jokers.png',
  'assets/1x/Foo&Squeax/credits/foo.png',
  "assets/1x/CyanSoCalico/literally-just-because-he's-been-causing-issues.png",
  'assets/1x/pulsar&axy/axywob.png',
  'assets/1x/Joker (copy) [v2], final #1 ~old.png',
  'localization/日本語.lua',
  'assets/Café/épée.png',
  '.gitignore',
  'a/.hidden/file.name.with.dots.lua',
];
const REJECTED = [
  '../escape.lua',
  'a/../../escape.lua',
  '/absolute.lua',
  'C:/Windows/evil.lua',
  'C:evil.lua',
  'a\\b.lua',
  'file.lua:stream',
  'bad<name>.lua',
  'what?.lua',
  'star*.lua',
  'pipe|name.lua',
  'quote".lua',
  'trailing-dot.',
  'trailing-space ',
  'dir /file.lua',
  'CON',
  'aux.lua',
  'assets/NUL.png',
  'COM1.txt',
  'lpt9 .txt',
  'ctl\u0007char.lua',
  'bidi\u202Efdp.lua',
  '..',
  './x.lua',
  'a//b.lua',
  'x'.repeat(256),
];

describe('archive file names', () => {
  it.each(ACCEPTED)('accepts the valid path %s', (name) => {
    expect(RelativePath.safeParse(name).success).toBe(true);
    expect(
      validateArchiveEntry({
        fileName: name,
        externalFileAttributes: 0,
        uncompressedSize: 1,
        compressedSize: 1,
      }),
    ).toBe(name);
  });
  it.each(REJECTED)('still rejects the unsafe path %j', (name) => {
    expect(RelativePath.safeParse(name).success).toBe(false);
  });
  it('rejects Unicode-equivalent duplicate names', async () => {
    const root = await tempRoot();
    roots.push(root);
    const stage = path.join(root, 'stage');
    await fs.mkdir(stage);
    const archive = path.join(root, 'mod.zip');
    await fs.writeFile(
      archive,
      zip([
        { name: 'caf\u00e9.lua', data: 'one' },
        { name: 'cafe\u0301.lua', data: 'two' },
      ]),
    );
    await expect(
      new ArchiveService().extract(archive, stage, new AbortController().signal),
    ).rejects.toThrow('duplicate');
  });
});

describe('installing a mod with punctuation in file names', () => {
  it('extracts, installs and uninstalls a Hot Potato style layout', async () => {
    const f = await setup();
    roots.push(f.root);
    f.prerequisites.push(
      ...['Steamodded', 'Lovely'].map((id) => ({
        id,
        displayName: id,
        installed: true,
        installedVersion: '3.0.0',
        sourceUrl: 'https://github.com/fixture/loader',
      })),
    );
    const files = [
      { name: 'manifest.json', data: '{"name":"Potato","version_number":"1.0.0"}' },
      {
        name: 'metadata.json',
        data: JSON.stringify({ id: 'Potato', version: '1.0.0', main_file: 'main.lua' }),
      },
      { name: 'main.lua', data: 'return {}' },
      { name: 'assets/1x/Oops! All Programmers/', data: '' },
      { name: 'assets/1x/Oops! All Programmers/oap_jokers.png', data: 'png' },
      { name: 'assets/1x/Foo&Squeax/fish.png', data: 'png' },
      { name: "assets/1x/he's-been.png", data: 'png' },
    ];
    const archive = path.join(f.root, 'potato.zip');
    await fs.writeFile(archive, zip(files));
    await new ArchiveService().extract(archive, f.stage, new AbortController().signal);

    await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
    for (const file of files.filter((x) => !x.name.endsWith('/') && x.name.startsWith('assets')))
      expect(await exists(path.join(f.mods, 'test-mod', ...file.name.split('/')))).toBe(true);
    expect(f.storage.state.installations[0]?.files.map((x) => x.path)).toContain(
      'test-mod/assets/1x/Foo&Squeax/fish.png',
    );

    await f.installer.uninstall('test-mod');
    expect(await exists(path.join(f.mods, 'test-mod'))).toBe(false);
  });
});
