import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ConfiguredModIndex,
  normalizeIndexEntry,
  readRemoteIndex,
} from '../electron/services/mod-index';
import { ModatroCatalogueRepository } from '../electron/services/catalogue';
import { ModIndexUrl, indexLocation } from '../src/shared/mod-index';
import { normalizeThunderstore } from '../src/shared/thunderstore';
import { setup, thunderstorePackage } from './helpers';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const url = 'https://github.com/community/index';
const metadata = {
  title: 'Demo',
  author: 'Author',
  repo: 'https://github.com/Author/Demo',
  downloadURL: 'https://github.com/Author/Demo/archive/refs/heads/main.zip',
  version: '1.2.3',
  categories: ['AI Generated'],
  'requires-steamodded': true,
  'requires-lovely': true,
};
const archive = [{ id: 'Author@Demo', data: metadata }];
function mockIndex(truncated = false, contents = JSON.stringify(metadata)) {
  const sha = 'a'.repeat(40);
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.includes('/commits/')) return new Response(JSON.stringify({ sha }));
      if (input.includes('/git/trees/'))
        return new Response(
          JSON.stringify({
            truncated,
            tree: [
              { path: 'mods/Author@Demo/meta.json', type: 'blob' },
              { path: 'media/ignored.png', type: 'blob' },
            ],
          }),
        );
      if (
        input ===
        `https://raw.githubusercontent.com/community/index/${sha}/mods/Author%40Demo/meta.json`
      )
        return new Response(contents);
      throw new Error(`Unexpected request: ${input}`);
    }),
  );
}

it('accepts optional GitHub forks and branches, rejecting credentials and unrelated URLs', () => {
  expect(ModIndexUrl.parse('')).toBe('');
  expect(indexLocation(`${url}.git/`).url).toBe(url);
  expect(indexLocation(`${url}/tree/dev/next`).url).toBe(`${url}/tree/dev/next`);
  for (const value of [
    'http://github.com/a/b',
    'https://user:secret@github.com/a/b',
    'https://example.com/a/b',
    `${url}/issues`,
    `${url}?token=secret`,
  ])
    expect(ModIndexUrl.safeParse(value).success).toBe(false);
});
it('reads Balatro mod index metadata without extracting files and maps prerequisites and hidden categories', async () => {
  mockIndex();
  const entries = await readRemoteIndex(url);
  expect(entries).toEqual([{ id: 'Author@Demo', data: metadata }]);
  const mod = normalizeIndexEntry(entries[0]!.id, entries[0]!.data, url);
  expect(mod.categories).toEqual(['Other']);
  expect(mod.source).toEqual({ provider: 'mod-index', externalId: 'Author@Demo', url });
  expect(mod.prerequisites.map((entry) => entry.id)).toEqual(['Steamodded', 'Lovely']);
  expect(() =>
    normalizeIndexEntry(
      'Author@Demo',
      { ...metadata, downloadURL: 'https://github.com/Other/Project/archive/main.zip' },
      url,
    ),
  ).toThrow();
});
it('rejects oversized metadata before reading its contents', async () => {
  mockIndex(false, 'a'.repeat(300000));
  await expect(readRemoteIndex(url)).rejects.toThrow('size limit');
  mockIndex(true);
  await expect(readRemoteIndex(url)).rejects.toThrow('incomplete');
});
it('preserves a verified cache on failure, isolates forks and blocks stale installs', async () => {
  const f = await setup();
  roots.push(f.root);
  let failing = false;
  const source = new ConfiguredModIndex(url, f.storage, f.logger, async () => {
    if (failing) throw new Error('offline');
    return archive;
  });
  await source.refresh();
  const mod = source.catalogue.mods[0]!;
  expect(() => source.assertAvailable(mod)).not.toThrow();
  failing = true;
  await source.refresh();
  expect(source.catalogue.mods).toEqual([mod]);
  expect(() => source.assertAvailable(mod)).toThrow();
  const restored = new ConfiguredModIndex(url, f.storage, f.logger);
  await restored.loadCache();
  expect(restored.catalogue.mods).toEqual([mod]);
  const other = new ConfiguredModIndex('https://github.com/another/index', f.storage, f.logger);
  await other.loadCache();
  expect(other.catalogue.mods).toEqual([]);
});
it('prefers Thunderstore for matching repositories while keeping different mods with the same title', async () => {
  const f = await setup();
  roots.push(f.root);
  const repository = new ModatroCatalogueRepository(f.storage, f.logger);
  const source = new ConfiguredModIndex(url, f.storage, f.logger, async () => archive);
  await source.refresh();
  repository.index = source;
  const registry = normalizeThunderstore(thunderstorePackage({ website: `${metadata.repo}/` }))!;
  repository.thunderstore.catalogue = {
    mods: [registry],
    stale: false,
    refreshing: false,
    rejected: 0,
  };
  expect(repository.catalogue.mods.map((mod) => mod.id)).toEqual([registry.id]);
  expect(repository.catalogue.mods[0]!.legacyIds).toContain('Author@Demo');
  source.catalogue.mods.push(
    normalizeIndexEntry(
      'Other@Demo',
      {
        ...metadata,
        repo: 'https://github.com/Other/Demo',
        downloadURL: 'https://github.com/Other/Demo/archive/main.zip',
      },
      url,
    ),
  );
  expect(repository.catalogue.mods.map((mod) => mod.id)).toEqual(['Other@Demo', registry.id]);
  source.catalogue.stale = true;
  expect(() => repository.thunderstore.assertAvailable(registry)).not.toThrow();
  await repository.configureIndex('');
  expect(repository.catalogue.mods).toEqual([registry]);
});

it('keeps ambiguous repositories separate and normalizes mod index zipball and latest-release URLs', async () => {
  const f = await setup();
  roots.push(f.root);
  const repository = new ModatroCatalogueRepository(f.storage, f.logger);
  const source = new ConfiguredModIndex(url, f.storage, f.logger, async () => archive);
  await source.refresh();
  repository.index = source;
  repository.thunderstore.catalogue.mods = [
    normalizeThunderstore(thunderstorePackage({ website: metadata.repo }))!,
    normalizeThunderstore(thunderstorePackage({ namespace: 'Other', website: metadata.repo }))!,
  ];
  expect(repository.catalogue.mods).toHaveLength(3);
  const zipball = normalizeIndexEntry(
    'Author@Demo',
    { ...metadata, downloadURL: `${metadata.repo}/zipball/main` },
    url,
  );
  expect(zipball.downloadUrl).toBe(`${metadata.repo}/archive/main.zip`);
  const latest = normalizeIndexEntry(
    'Author@Demo',
    { ...metadata, downloadURL: `${metadata.repo}/releases/latest/download/mod.zip` },
    url,
  );
  expect(latest.githubRelease).toEqual({ assetName: 'mod.zip' });
});
