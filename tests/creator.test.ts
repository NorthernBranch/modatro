import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { CreatorService } from '../electron/services/creator';
import { cardArtwork, decodeArtwork, placeholderArtwork } from '../electron/services/creator-art';
import { exists } from '../electron/services/files';
import {
  CreatorDraftSchema,
  CreatorRequestSchema,
  creatorIdentities,
  recipes,
  type CreatorDraft,
  type CreatorProject,
} from '../src/shared/creator';
import { generateLua, luaDiagnostics } from '../src/shared/creator-lua';
import { defaultContent, type JokerContent } from '../src/shared/creator-content';
import { builtinPixels } from '../src/shared/creator-artwork';
import { type LocalMod, type ModDefinition } from '../src/shared/model';
import { setup, put } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  checkpoint?: (phase: string, index?: number) => Promise<void>,
  recipe: 'blank' | 'joker-mult' | 'joker-chips' | 'joker-suit' | 'deck' = 'joker-mult',
) {
  const f = await setup(checkpoint);
  roots.push(f.root);
  await f.storage.save({
    ...f.storage.state,
    settings: { ...f.storage.state.settings, creatorEnabled: true, creatorAcknowledged: true },
  });
  const definitions: ModDefinition[] = [];
  const local: LocalMod[] = [];
  const creator = new CreatorService(
    f.storage,
    f.transactions,
    async () => local,
    async (d) => {
      definitions.push(d);
    },
  );
  const project = (
    await creator.perform({
      operation: 'create',
      name: 'A "quoted" Joker',
      author: 'Test author',
      recipe,
    })
  ).project!;
  return { ...f, creator, project, definitions, local };
}
async function save(
  f: Awaited<ReturnType<typeof fixture>>,
  p: CreatorProject,
  change: Partial<CreatorDraft>,
) {
  return (
    await f.creator.perform({
      operation: 'save',
      id: p.id,
      token: p.token,
      draft: { ...p.draft, ...change },
    })
  ).project!;
}
async function build(f: Awaited<ReturnType<typeof fixture>>, p = f.project) {
  const result = await f.creator.perform({ operation: 'build', id: p.id, token: p.token });
  return {
    p: result.project!,
    d: result.definition!,
    zip: await f.creator.archiveFor(result.definition!.creator!),
  };
}
function prerequisites(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [id, version] of [
    ['Steamodded', '26.1002.0'],
    ['Lovely', '0.10.0'],
  ])
    f.prerequisites.push({
      id: id!,
      displayName: id!,
      installed: true,
      installedVersion: version,
      sourceUrl: 'https://github.com/Steamodded/smods',
    });
}
describe('local Mod Creator', () => {
  it('starts Custom Lua as a separate blank source workspace and preserves pasted code through build/export', async () => {
    const f = await fixture();
    let p = (
      await f.creator.perform({
        operation: 'create',
        name: 'My custom mod',
        author: 'Author',
        contentType: 'custom',
      })
    ).project!;
    expect(p.draft.mode).toBe('custom');
    expect(p.draft.content.type).toBe('blank');
    expect(p.draft.lua).not.toMatch(/SMODS.Joker|SMODS.Back|SMODS.Voucher/);
    const source = '-- pasted own mod\nlocal value = 1\nreturn value';
    p = await save(f, p, { lua: source, description: 'My pasted source' });
    const b = await build(f, p);
    const files = unzipSync(await fs.readFile(b.zip));
    expect(strFromU8(files[`${p.draft.modId}/main.lua`]!)).toBe(source);
  });
  it.each(['joker', 'deck', 'voucher'] as const)(
    'exports the selected %s artwork at both resolutions and preserves uploaded originals',
    async (contentType) => {
      const f = await fixture();
      let p = (
        await f.creator.perform({
          operation: 'create',
          name: 'Art test',
          author: 'Author',
          contentType,
        })
      ).project!;
      expect(p.draft.artwork).toMatchObject({ source: 'builtin', builtinId: contentType + '-1' });
      p = await save(f, p, { artwork: { source: 'builtin', builtinId: contentType + '-5' } });
      const b = await build(f, p),
        files = unzipSync(await fs.readFile(b.zip));
      const image = PNG.sync.read(Buffer.from(files[`${p.draft.modId}/assets/1x/card.png`]!));
      expect(image.data).toEqual(Buffer.from(builtinPixels(contentType + '-5')));
      expect(
        PNG.sync.read(Buffer.from(files[`${p.draft.modId}/assets/2x/card.png`]!)),
      ).toMatchObject({ width: 142, height: 190 });
      expect(strFromU8(files[`${p.draft.modId}/main.lua`]!)).toContain(
        contentType === 'deck'
          ? 'SMODS.Back'
          : contentType === 'joker'
            ? 'SMODS.Joker'
            : 'SMODS.Voucher',
      );
    },
  );
  it('backs up old project metadata, source and uploaded artwork before migration, then preserves custom edits', async () => {
    const f = await fixture(),
      location = `creator/projects/${f.project.id}`;
    const image = PNG.sync.write(placeholderArtwork(false)),
      artHash = createHash('sha256').update(image).digest('hex');
    await fs.mkdir(f.storage.file(`${location}/art`), { recursive: true });
    await fs.writeFile(f.storage.file(`${location}/art/${artHash}.png`), image);
    const original = {
      schemaVersion: 1,
      id: f.project.id,
      createdAt: f.project.createdAt,
      updatedAt: f.project.updatedAt,
      builds: f.project.builds,
      artHash,
      draft: {
        name: 'Old Deck',
        author: 'Author',
        description: 'Old description',
        version: '1.0.0',
        modId: f.project.draft.modId,
        prefix: f.project.draft.prefix,
        recipe: 'deck',
        amount: 4,
        suit: 'Hearts',
        dollars: 10,
        hands: 1,
        discards: 0,
        mode: 'custom',
        lua: '-- custom source preserved\nreturn 77',
        crop: { x: 0.2, y: 0.7, zoom: 2 },
      },
    };
    const raw = JSON.stringify(original);
    await put(f.storage.file(`${location}/project.json`), raw);
    await put(f.storage.file(`${location}/main.lua`), original.draft.lua);
    let p = (await f.creator.perform({ operation: 'load', id: f.project.id })).project!;
    expect(p.schemaVersion).toBe(2);
    expect(p.draft.mode).toBe('custom');
    expect(p.draft.lua).toBe(original.draft.lua);
    expect(p.draft.crop).toEqual(original.draft.crop);
    expect(p.artHash).toBe(artHash);
    expect(p.artwork).toBeDefined();
    expect(
      await fs.readFile(f.storage.file(`${location}/history/migration-v1/project.json`), 'utf8'),
    ).toBe(raw);
    expect(
      await fs.readFile(f.storage.file(`${location}/history/migration-v1/main.lua`), 'utf8'),
    ).toBe(original.draft.lua);
    expect(
      await fs.readFile(f.storage.file(`${location}/history/migration-v1/${artHash}.png`)),
    ).toEqual(image);
    p = await save(f, p, {
      content: { ...p.draft.content, name: 'Renamed content' },
      artwork: { source: 'builtin', builtinId: 'deck-2' },
    });
    expect(p.draft.lua).toBe(original.draft.lua);
    expect(p.artHash).toBe(artHash);
    expect(p.artwork).toBeDefined();
    const reset = (await f.creator.perform({ operation: 'reset-art', id: p.id, token: p.token }))
      .project!;
    expect(reset.artHash).toBe(artHash);
    expect(await fs.readFile(f.storage.file(`${location}/art/${artHash}.png`))).toEqual(image);
    const b = await build(f, reset);
    expect(Object.keys(unzipSync(await fs.readFile(b.zip))).join(' ')).not.toMatch(
      /history|project.json|migration|original/,
    );
  });
  it('keeps a project type fixed and form changes never overwrite custom source', async () => {
    const f = await fixture();
    await expect(
      save(f, f.project, {
        content: defaultContent('deck', 'Other type'),
        artwork: { source: 'builtin', builtinId: 'deck-1' },
      }),
    ).rejects.toThrow('different content type');
    let p = await save(f, f.project, { mode: 'custom', lua: '-- authored source\nreturn 99' });
    p = await save(f, p, {
      content: { ...p.draft.content, name: 'Changed form', rarity: 'Rare' } as JokerContent,
    });
    expect(p.draft.lua).toBe('-- authored source\nreturn 99');
  });
  it.each(recipes)(
    'builds a complete, deterministic $name package with escaped metadata',
    async (recipe) => {
      const f = await fixture(undefined, recipe.id);
      const p = await save(f, f.project, {
        name: 'Quotes " \\ \n ☃',
        description: '<script> is plain text',
      });
      const b = await build(f, p);
      const entries = unzipSync(await fs.readFile(b.zip));
      expect(Object.keys(entries).sort()).toEqual(
        [
          'MODATRO-ARTWORK-LICENSE.txt',
          'README.txt',
          'assets/1x/card.png',
          'assets/2x/card.png',
          'main.lua',
          'mod.json',
        ]
          .map((n) => `${p.draft.modId}/${n}`)
          .sort(),
      );
      const metadata = JSON.parse(strFromU8(entries[`${p.draft.modId}/mod.json`]!));
      expect(metadata).toMatchObject({
        id: p.draft.modId,
        prefix: p.draft.prefix,
        name: p.draft.name,
        author: ['Test author'],
        main_file: 'main.lua',
        dependencies: ['Steamodded (>=26.1002.0)', 'Lovely'],
      });
      const lua = strFromU8(entries[`${p.draft.modId}/main.lua`]!);
      expect(luaDiagnostics(lua)).toEqual([]);
      expect(lua).not.toContain('starting_params');
      if (recipe.id === 'joker-suit')
        expect(lua).toContain('context.individual and context.cardarea == G.play');
      if (recipe.id === 'joker-chips') expect(lua).toContain('append({ chips = 30 })');
      if (recipe.id === 'deck')
        expect(lua).toContain(
          'config = { dollars = 0, hands = 0, discards = 0, hand_size = 0, joker_slot = 0, consumable_slot = 0 }',
        );
      expect(
        PNG.sync.read(Buffer.from(entries[`${p.draft.modId}/assets/1x/card.png`]!)),
      ).toMatchObject({ width: 71, height: 95 });
      expect(
        PNG.sync.read(Buffer.from(entries[`${p.draft.modId}/assets/2x/card.png`]!)),
      ).toMatchObject({ width: 142, height: 190 });
      expect(strFromU8(entries[`${p.draft.modId}/MODATRO-ARTWORK-LICENSE.txt`]!)).toContain(
        'CC0 1.0',
      );
      expect((await build(f, b.p)).d.creator?.buildId).toBe(b.d.creator?.buildId);
      expect(f.storage.state.installations).toEqual([]);
      expect(await fs.readdir(f.mods)).toEqual([]);
    },
  );
  it('keeps source edits separate, restores previous builds, and preserves source on uninstall', async () => {
    const f = await fixture();
    prerequisites(f);
    const first = await build(f);
    await f.installer.install(first.d, false, undefined, false, [], first.zip);
    const installed = path.join(f.mods, first.d.folderName!, 'main.lua');
    const original = await fs.readFile(installed, 'utf8');
    expect(f.storage.state.installations[0]?.provenance?.creator).toEqual(first.d.creator);
    await expect(
      f.installer.plan(
        { ...first.d, creator: undefined, source: { provider: 'github', externalId: 'catalogue' } },
        f.stage,
      ),
    ).rejects.toThrow('Locally created');
    const p = await save(f, first.p, {
      mode: 'custom',
      lua: '-- trusted custom code\nreturn 42\n',
      version: '1.1.0',
    });
    expect(await fs.readFile(installed, 'utf8')).toBe(original);
    const second = await build(f, p);
    await f.installer.install(second.d, true, undefined, false, [], second.zip);
    expect(await fs.readFile(installed, 'utf8')).toContain('return 42');
    const restore = (
      await f.creator.perform({
        operation: 'prepare-install',
        id: p.id,
        buildId: first.d.creator!.buildId,
      })
    ).definition!;
    await f.installer.install(restore, true, undefined, false, [], first.zip);
    expect(await fs.readFile(installed, 'utf8')).toBe(original);
    expect(await fs.readdir(f.storage.file('backups'))).not.toEqual([]);
    await f.installer.uninstall(first.d.id);
    expect((await f.creator.perform({ operation: 'load', id: p.id })).project?.draft.lua).toContain(
      'return 42',
    );
    expect(await exists(second.zip)).toBe(true);
  });
  it('rolls back a failed replacement while preserving drafts and both immutable builds', async () => {
    let fail = false;
    const f = await fixture(async (phase) => {
      if (fail && phase === 'changed') throw new Error('simulated power failure');
    });
    prerequisites(f);
    const first = await build(f);
    await f.installer.install(first.d, false, undefined, false, [], first.zip);
    const p = await save(f, first.p, { mode: 'custom', lua: 'return "next"', version: '1.1.0' });
    const second = await build(f, p);
    fail = true;
    await expect(
      f.installer.install(second.d, true, undefined, false, [], second.zip),
    ).rejects.toThrow('simulated');
    expect(await fs.readFile(path.join(f.mods, first.d.folderName!, 'main.lua'), 'utf8')).toBe(
      first.p.draft.lua,
    );
    expect(f.storage.state.installations[0]?.provenance?.creator).toEqual(first.d.creator);
    expect((await f.creator.perform({ operation: 'load', id: p.id })).project?.draft.lua).toBe(
      'return "next"',
    );
    expect(await exists(first.zip)).toBe(true);
    expect(await exists(second.zip)).toBe(true);
  });
  it('archives a project without uninstalling its mod, then allows ordinary local management', async () => {
    const f = await fixture();
    prerequisites(f);
    const b = await build(f);
    await f.installer.install(b.d, false, undefined, false, [], b.zip);
    await f.creator.perform({ operation: 'delete', id: b.p.id, token: b.p.token });
    expect(await f.creator.list()).toEqual([]);
    expect(f.storage.state.installations).toHaveLength(1);
    expect(await exists(b.zip)).toBe(true);
    f.storage.state.settings.creatorEnabled = false;
    await f.installer.toggle(b.d.id, true);
    await f.installer.toggle(b.d.id, false);
    await f.installer.uninstall(b.d.id);
    expect(f.storage.state.installations).toEqual([]);
    expect(await fs.readdir(f.storage.file('creator/deleted'))).toHaveLength(1);
  });
  it('refuses stale writes and preserves custom source when explicitly returning to templates', async () => {
    const f = await fixture();
    const main = f.storage.file(`creator/projects/${f.project.id}/main.lua`);
    await fs.writeFile(main, '-- external edit\nreturn 77');
    await expect(save(f, f.project, { name: 'Stale' })).rejects.toThrow('changed on disk');
    let p = (await f.creator.perform({ operation: 'load', id: f.project.id })).project!;
    expect(p.externalChanges).toBe(true);
    expect(p.draft.mode).toBe('custom');
    p = await save(f, p, { name: 'Preserved' });
    expect(p.draft.lua).toContain('return 77');
    await expect(save(f, p, { mode: 'template' })).rejects.toThrow('confirmation');
    const next = (
      await f.creator.perform({
        operation: 'save',
        id: p.id,
        token: p.token,
        draft: { ...p.draft, mode: 'template' },
        regenerate: true,
      })
    ).project!;
    const hash = createHash('sha256').update(p.draft.lua).digest('hex');
    expect(
      await fs.readFile(f.storage.file(`creator/projects/${p.id}/history/${hash}.lua`), 'utf8'),
    ).toBe(p.draft.lua);
    expect(next.draft.lua).toBe(generateLua(next.draft));
  });
  it('checks local and installed ID/prefix collisions and locks identities after building', async () => {
    const f = await fixture();
    const other = (
      await f.creator.perform({
        operation: 'create',
        name: 'Other',
        author: 'Tester',
        recipe: 'deck',
      })
    ).project!;
    expect(other.draft.modId).not.toBe(f.project.draft.modId);
    await expect(save(f, other, { modId: f.project.draft.modId.toUpperCase() })).rejects.toThrow(
      'Another local project',
    );
    f.local.push({
      id: 'external',
      metadataId: 'Taken',
      title: 'External',
      folderName: 'External',
      state: 'installed',
      disabled: false,
      managed: false,
      canAdopt: true,
      canDisable: false,
      problems: [],
      dependencies: [],
    });
    await put(
      path.join(f.mods, 'External', 'mod.json'),
      JSON.stringify({ id: 'Taken', prefix: 'taken_prefix' }),
    );
    await expect(save(f, other, { modId: 'Taken' })).rejects.toThrow('installed mod');
    await expect(save(f, other, { prefix: 'taken_prefix' })).rejects.toThrow('prefix');
    await put(
      path.join(f.mods, 'External', 'legacy.lua'),
      '--- STEAMODDED HEADER\n--- MOD_ID: LegacyThing\n--- MOD_NAME: Legacy\n--- MOD_AUTHOR: [Tester]\n--- MOD_DESCRIPTION: Fixture',
    );
    await expect(save(f, other, { prefix: 'lega' })).rejects.toThrow('prefix');
    const b = await build(f);
    await expect(save(f, b.p, { modId: 'NewIdentity' })).rejects.toThrow('fixed after');
  });
  it('rejects invalid syntax and unsafe IPC paths without executing custom code', async () => {
    const f = await fixture();
    let p = await save(f, f.project, { mode: 'custom', lua: 'function(' });
    await expect(build(f, p)).rejects.toThrow('syntax');
    p = await save(f, p, { lua: 'os.execute("do not run this")\nerror("do not execute")' });
    await expect(build(f, p)).resolves.toBeDefined();
    expect(CreatorRequestSchema.safeParse({ operation: 'load', id: '../../game' }).success).toBe(
      false,
    );
    expect(CreatorDraftSchema.safeParse({ ...p.draft, modId: '../../escape' }).success).toBe(false);
    expect(CreatorDraftSchema.safeParse({ ...p.draft, modId: 'Steamodded' }).success).toBe(false);
    for (const modId of ['CON', 'aux', 'COM1', 'LPT9'])
      expect(CreatorDraftSchema.safeParse({ ...p.draft, modId }).success).toBe(false);
    expect(
      CreatorDraftSchema.safeParse({ ...p.draft, lua: '--' + 'é'.repeat(70000) }).success,
    ).toBe(false);
  });
  it('preserves original PNG bytes and exports only whitelisted distributable files', async () => {
    const f = await fixture();
    const art = path.join(f.root, 'input.png');
    const png = new PNG({ width: 100, height: 100 });
    png.data.fill(0);
    png.data.set([9, 20, 30, 128], 0);
    const original = PNG.sync.write(png);
    await fs.writeFile(art, original);
    let exported = path.join(f.root, 'export.zip');
    f.creator.native = {
      artwork: async () => art,
      export: async () => exported,
      open: async () => {},
    };
    const p = (
      await f.creator.perform({ operation: 'import-art', id: f.project.id, token: f.project.token })
    ).project!;
    expect(
      await fs.readFile(f.storage.file(`creator/projects/${p.id}/art/${p.artHash}.png`)),
    ).toEqual(original);
    await put(f.storage.file(`creator/projects/${p.id}/secret.txt`), 'private');
    const b = await build(f, p);
    await f.creator.perform({ operation: 'export', id: p.id, buildId: b.d.creator!.buildId });
    expect(await fs.readFile(exported)).toEqual(await fs.readFile(b.zip));
    expect(Object.keys(unzipSync(await fs.readFile(exported))).join(' ')).not.toMatch(
      /secret|project.json|history|original/,
    );
    exported = path.join(f.mods, 'bad.zip');
    await expect(
      f.creator.perform({ operation: 'export', id: p.id, buildId: b.d.creator!.buildId }),
    ).rejects.toThrow('outside');
    expect(await exists(exported)).toBe(false);
  });
  it('requires enablement and acknowledgement and blocks tampered build archives', async () => {
    const f = await fixture();
    const b = await build(f);
    await fs.writeFile(b.zip, 'changed');
    await expect(f.creator.archiveFor(b.d.creator!)).rejects.toThrow('changed');
    f.storage.state.settings.creatorAcknowledged = false;
    await expect(f.creator.perform({ operation: 'list' })).rejects.toThrow('acknowledge');
  });
});
describe('creator artwork and diagnostics', () => {
  it('preserves alpha and uses exact nearest-neighbour pixels at both atlas scales', () => {
    const png = new PNG({ width: 71, height: 95 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 251;
    const crop = { x: 0.5, y: 0.5, zoom: 1 };
    expect(PNG.sync.read(cardArtwork(png, crop, 1)).data).toEqual(png.data);
    const scaled = PNG.sync.read(cardArtwork(png, crop, 2));
    expect(scaled.data.subarray(0, 4)).toEqual(png.data.subarray(0, 4));
    expect(scaled.data.subarray(4, 8)).toEqual(png.data.subarray(0, 4));
    expect(placeholderArtwork(false).data).not.toEqual(placeholderArtwork(true).data);
  });
  it('bounds PNG headers before allocation and rejects corruption', () => {
    const bytes = PNG.sync.write(placeholderArtwork(false));
    expect(() => decodeArtwork(bytes)).not.toThrow();
    const huge = Buffer.from(bytes);
    huge.writeUInt32BE(100000, 16);
    expect(() => decodeArtwork(huge)).toThrow('2048');
    expect(() => decodeArtwork(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow('8 MiB');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => decodeArtwork(bytes)).toThrow('decoded');
  });
  it('reports a filename and useful line/column without executing Lua', () => {
    expect(luaDiagnostics('local x = 1\nfunction(')[0]).toMatchObject({
      file: 'main.lua',
      line: 2,
    });
    expect(creatorIdentities('11111111-1111-4111-8111-111111111111')).toEqual({
      modId: 'modatro_111111111111',
      prefix: 'mc_111111111111',
    });
  });
  it('rejects animated PNGs and bounds the interlaced decoder before allocation', () => {
    const chunk = (type: string, data: Buffer) => {
      const bytes = Buffer.alloc(data.length + 12);
      bytes.writeUInt32BE(data.length, 0);
      bytes.write(type, 4, 'ascii');
      data.copy(bytes, 8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
      return bytes;
    };
    const image = PNG.sync.write(placeholderArtwork(false));
    expect(() =>
      decodeArtwork(
        Buffer.concat([image.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), image.subarray(33)]),
      ),
    ).toThrow('static PNG');
    const header = Buffer.from(image.subarray(16, 29));
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[12] = 1;
    const bomb = Buffer.concat([
      image.subarray(0, 8),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => decodeArtwork(bomb)).toThrow('decoded');
  });
});
