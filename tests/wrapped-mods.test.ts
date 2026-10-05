import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService } from '../electron/services/archive';
import { exists } from '../electron/services/files';
import { mod, put, setup, zip } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
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
  const archive = path.join(f.root, 'wrapped.zip');
  await fs.writeFile(
    archive,
    zip([
      { name: 'release/lovely.toml', data: 'incorrect installation error patch' },
      { name: 'release/installation-instructions.txt', data: 'copy the inner folder' },
      {
        name: 'release/ActualMod/metadata.json',
        data: JSON.stringify({
          id: 'ActualMod',
          version: '2.0.6',
          main_file: 'steamodded.lua',
          dependencies: ['Lovely (>=0.9.0)'],
        }),
      },
      { name: 'release/ActualMod/steamodded.lua', data: 'loader entry point' },
      { name: 'release/ActualMod/lovely/preflight.toml', data: 'actual mod patch' },
      { name: 'release/ActualMod/src/preflight.lua', data: 'preflight module' },
    ]),
  );
  await new ArchiveService().extract(archive, f.stage, new AbortController().signal);
  return f;
}

describe('wrapped mod layouts', () => {
  it.each(['standard', 'auto', 'lovely-patch'] as const)(
    'installs the actual mod root with the %s strategy',
    async (type) => {
      const f = await fixture();
      const prepared = await f.installer.plan(mod({ installation: { type } }), f.stage);
      expect(prepared.metadataId).toBe('ActualMod');
      expect(prepared.runtimeVersion).toBe('2.0.6');
      expect(prepared.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'Steamodded', state: 'satisfied' }),
          expect.objectContaining({ id: 'Lovely', state: 'satisfied' }),
        ]),
      );
      await f.installer.commitPrepared(prepared);
      expect(await fs.readFile(path.join(f.mods, 'test-mod/lovely/preflight.toml'), 'utf8')).toBe(
        'actual mod patch',
      );
      expect(await exists(path.join(f.mods, 'test-mod/steamodded.lua'))).toBe(true);
      expect(await exists(path.join(f.mods, 'test-mod/src/preflight.lua'))).toBe(true);
      expect(await exists(path.join(f.mods, 'test-mod/ActualMod'))).toBe(false);
      expect(await exists(path.join(f.mods, 'test-mod/lovely.toml'))).toBe(false);
      expect(await exists(path.join(f.mods, 'test-mod/installation-instructions.txt'))).toBe(false);
      expect(f.storage.state.installations[0]).toMatchObject({
        metadataId: 'ActualMod',
        modVersion: '2.0.6',
      });
    },
  );
  it.each([false, true])(
    'repairs a previous nested installation while protecting edited files (edited: %s)',
    async (edited) => {
      const f = await fixture();
      // Reproduce a managed installation made using the old outer-root layout.
      await f.installer.commitPrepared(
        await f.installer.plan(
          mod({ installation: { type: 'standard', sourceRoot: 'release' } }),
          f.stage,
        ),
      );
      const outerPatch = path.join(f.mods, 'test-mod/lovely.toml');
      await put(path.join(f.mods, 'test-mod/user-notes.txt'), 'preserve my notes');
      if (edited) await put(outerPatch, 'user changes');
      const prepared = await f.installer.plan(mod(), f.stage);
      if (edited) {
        expect(prepared.plan.conflicts).toContainEqual(
          expect.objectContaining({ path: 'test-mod/lovely.toml' }),
        );
        await expect(f.installer.commitPrepared(prepared)).rejects.toThrow('not eligible');
        expect(await fs.readFile(outerPatch, 'utf8')).toBe('user changes');
        expect(await exists(path.join(f.mods, 'test-mod/ActualMod/steamodded.lua'))).toBe(true);
      } else {
        await f.installer.commitPrepared(prepared);
        expect(await exists(outerPatch)).toBe(false);
        expect(await exists(path.join(f.mods, 'test-mod/ActualMod'))).toBe(false);
        expect(await exists(path.join(f.mods, 'test-mod/steamodded.lua'))).toBe(true);
        expect(f.storage.state.installations[0]?.modVersion).toBe('2.0.6');
      }
      expect(await fs.readFile(path.join(f.mods, 'test-mod/user-notes.txt'), 'utf8')).toBe(
        'preserve my notes',
      );
    },
  );
});
