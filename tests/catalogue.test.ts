import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModatroCatalogueRepository,
  NativeModRepository,
  ThunderstoreRepository,
} from '../electron/services/catalogue';
import { normalizeThunderstore, THUNDERSTORE_ENDPOINT } from '../src/shared/thunderstore';
import { CatalogueOverridesSchema } from '../src/shared/catalogue-schema';
import { mod, setup, thunderstorePackage } from './helpers';
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
const cache = (mods: ReturnType<typeof mod>[]) => ({
  schemaVersion: 1,
  fetchedAt: '2026-10-01T00:00:00Z',
  mods,
  rejected: 0,
});
it('applies UUID permission exceptions across package renames without accepting pinned versions', async () => {
  const f = await fixture();
  const entry = normalizeThunderstore(thunderstorePackage())!;
  const repository = new ModatroCatalogueRepository(f.storage, f.logger);
  repository.thunderstore.catalogue.mods = [entry];
  repository.native.overrides = CatalogueOverridesSchema.parse({
    schemaVersion: 1,
    overrides: [
      {
        packageId: entry.thunderstore!.packageId,
        permissions: { display: true, install: false, update: false },
      },
    ],
  }).overrides;
  expect(repository.catalogue.mods[0]?.permissions?.install).toBe(false);
  expect(
    CatalogueOverridesSchema.safeParse({
      schemaVersion: 1,
      overrides: [{ packageId: entry.thunderstore!.packageId, version: '2.0.0' }],
    }).success,
  ).toBe(false);
});
it('blocks conflicting namespace and UUID overrides instead of selecting one permission policy', async () => {
  const f = await fixture();
  const entry = normalizeThunderstore(thunderstorePackage())!;
  const repository = new ModatroCatalogueRepository(f.storage, f.logger);
  repository.thunderstore.catalogue.mods = [entry];
  repository.native.overrides = CatalogueOverridesSchema.parse({
    schemaVersion: 1,
    overrides: [{ package: entry.id }, { packageId: entry.thunderstore!.packageId }],
  }).overrides;
  expect(repository.catalogue.mods[0]?.policyReason).toContain('Conflicting registry overrides');
});

describe('live Thunderstore catalogue', () => {
  it('normalizes versioned distribution and dependencies without copying artwork or descriptions', () => {
    const entry = normalizeThunderstore({
      ...thunderstorePackage({ dependencies: ['Steamodded-Steamodded-1.0.0'] }),
      description: 'creative text',
      icon: 'https://example.com/art.png',
    })!;
    expect(entry).toMatchObject({
      id: 'thunderstore/Author-Demo',
      approvalStatus: 'registry-published',
      releaseSource: { sourceType: 'registry' },
      prerequisites: [
        {
          id: 'Steamodded',
          packageId: 'thunderstore/Steamodded-Steamodded',
          versionConstraint: '>=1.0.0',
        },
      ],
    });
    expect(entry.description).toBeUndefined();
    expect(entry.iconUrl).toBeUndefined();
  });
  it('chooses the highest active version and excludes deprecated or entirely inactive packages', () => {
    const pkg = thunderstorePackage();
    pkg.versions.push({
      ...thunderstorePackage({ version: '2.0.0' }).versions[0]!,
      is_active: false,
    });
    pkg.versions.push(thunderstorePackage({ version: '1.5.0' }).versions[0]!);
    expect(normalizeThunderstore(pkg)?.version).toBe('1.5.0');
    expect(normalizeThunderstore({ ...pkg, is_deprecated: true })).toBeUndefined();
    expect(
      normalizeThunderstore({
        ...pkg,
        versions: pkg.versions.map((v) => ({ ...v, is_active: false })),
      }),
    ).toBeUndefined();
  });
  it('rejects mismatched identities, substituted downloads and malformed dependencies', () => {
    expect(() =>
      normalizeThunderstore({ ...thunderstorePackage(), full_name: 'Other-Demo' }),
    ).toThrow();
    const pkg = thunderstorePackage();
    pkg.versions[0]!.download_url = 'https://github.com/evil/mod/archive/main.zip';
    expect(() => normalizeThunderstore(pkg)).toThrow();
    expect(() =>
      normalizeThunderstore(thunderstorePackage({ dependencies: ['not-a-version'] })),
    ).toThrow();
  });
  it('refreshes once from the public API and reloads the validated cache on restart', async () => {
    const f = await fixture(),
      json = vi.fn(async (_url: string) => [thunderstorePackage()]);
    const repository = new ThunderstoreRepository(f.storage, f.logger, undefined, json);
    await Promise.all([repository.refresh(), repository.refresh()]);
    expect(json.mock.calls).toEqual([[THUNDERSTORE_ENDPOINT]]);
    expect(repository.catalogue.stale).toBe(false);
    const loaded = new ThunderstoreRepository(f.storage, f.logger);
    await loaded.loadCache();
    expect(loaded.catalogue.mods[0]?.title).toBe('Demo');
    expect(loaded.catalogue.stale).toBe(true);
  });
  it('preserves cached browsing on outages, including after restarting', async () => {
    const f = await fixture();
    await f.storage.write(
      'catalogue-cache/thunderstore.json',
      cache([normalizeThunderstore(thunderstorePackage())!]),
    );
    const repository = new ThunderstoreRepository(f.storage, f.logger, undefined, async () => {
      throw new Error('offline');
    });
    await repository.loadCache();
    await repository.refresh();
    expect(repository.catalogue.mods[0]?.title).toBe('Demo');
    expect(repository.catalogue.error).toBe('offline');
    await expect(repository.assertAvailable(repository.catalogue.mods[0]!)).rejects.toThrow(
      'cached catalogue',
    );
  });
  it('keeps old index caches for browsing without contacting their source or changing Chromium files', async () => {
    const f = await fixture();
    await fs.mkdir(f.storage.file('Cache'));
    await fs.writeFile(f.storage.file('Cache/browser-data'), 'chromium cache');
    const old = cache([mod()]);
    await f.storage.write('cache/catalogue.json', old);
    const json = vi.fn(async () => [thunderstorePackage()]);
    const repository = new ThunderstoreRepository(f.storage, f.logger, undefined, json);
    await repository.loadCache();
    expect(repository.catalogue.mods[0]?.unavailableReason).toContain('archived');
    expect(json).not.toHaveBeenCalled();
    await repository.refresh();
    expect(repository.catalogue.mods[0]?.thunderstore).toBeDefined();
    expect(await fs.readFile(f.storage.file('Cache/browser-data'), 'utf8')).toBe('chromium cache');
    expect(JSON.parse(await fs.readFile(f.storage.file('cache/catalogue.json'), 'utf8'))).toEqual(
      old,
    );
  });
  it.each([
    { feed: [] },
    { feed: [thunderstorePackage(), thunderstorePackage()] },
    { feed: [{ invalid: true }] },
  ])(
    'keeps a good cache after an empty, conflicting or entirely malformed feed',
    async ({ feed }) => {
      const f = await fixture();
      const repository = new ThunderstoreRepository(
        f.storage,
        f.logger,
        undefined,
        async () => feed,
      );
      repository.catalogue.mods = [normalizeThunderstore(thunderstorePackage())!];
      await repository.refresh();
      expect(repository.catalogue.mods).toHaveLength(1);
      expect(repository.catalogue.stale).toBe(true);
      expect(repository.catalogue.error).toBeTruthy();
    },
  );
  it('counts malformed records while continuing to show valid packages', async () => {
    const f = await fixture();
    const repository = new ThunderstoreRepository(f.storage, f.logger, undefined, async () => [
      thunderstorePackage(),
      { broken: true },
    ]);
    await repository.refresh();
    expect(repository.catalogue.mods).toHaveLength(1);
    expect(repository.catalogue.rejected).toBe(1);
  });
  it('removes deprecated packages from the cache and prevents installing a retired release', async () => {
    const f = await fixture();
    const entry = normalizeThunderstore(thunderstorePackage())!;
    const repository = new ThunderstoreRepository(f.storage, f.logger, undefined, async () => [
      thunderstorePackage({ deprecated: true }),
    ]);
    await repository.refresh();
    expect(repository.catalogue.mods).toEqual([]);
    expect(repository.catalogue.stale).toBe(false);
    await expect(repository.assertAvailable(entry)).rejects.toThrow('no longer current');
  });
  it('keeps registry updates working independently when the GitHub supplement is offline', async () => {
    const f = await fixture();
    const repository = new ModatroCatalogueRepository(f.storage, f.logger);
    vi.spyOn(repository.thunderstore, 'refresh').mockImplementation(async () => {
      repository.thunderstore.catalogue = {
        ...repository.thunderstore.catalogue,
        mods: [normalizeThunderstore(thunderstorePackage())!],
        stale: false,
      };
    });
    vi.spyOn(repository.native, 'refresh').mockImplementation(async () => {
      repository.native.catalogue.error = 'offline';
    });
    await repository.refresh();
    expect(repository.catalogue.mods[0]?.thunderstore).toBeDefined();
    expect(repository.catalogue.error).toContain('offline');
    repository.native.overrides = [
      {
        package: 'thunderstore/Author-Demo',
        permissions: { display: true, install: false, update: false },
      },
    ];
    expect(repository.catalogue.mods[0]?.permissions?.install).toBe(false);
  });
  it('discovers registered GitHub releases without a manually maintained version', async () => {
    const f = await fixture();
    const json = async (url: string) =>
      url.endsWith('index.json')
        ? {
            schemaVersion: 1,
            generatedAt: '2026-10-01T00:00:00Z',
            mods: [
              {
                id: 'Author/Demo',
                title: 'Demo',
                author: 'Author',
                repositoryUrl: 'https://github.com/author/demo',
                githubRelease: {},
                categories: [],
                permissions: { display: true, install: true, update: true },
                approvalStatus: 'author-approved',
                approvalEvidence: 'https://github.com/author/demo/issues/1',
              },
            ],
          }
        : url.endsWith('overrides.json')
          ? { schemaVersion: 1, overrides: [] }
          : {
              tag_name: 'v2.0.0',
              draft: false,
              prerelease: false,
              published_at: '2026-10-01T00:00:00Z',
              assets: [],
            };
    const repository = new NativeModRepository(f.storage, f.logger, json);
    await repository.refresh();
    expect(repository.catalogue.error).toBeUndefined();
    expect(repository.catalogue.mods[0]).toMatchObject({
      version: '2.0.0',
      downloadUrl: 'https://github.com/author/demo/archive/refs/tags/v2.0.0.zip',
    });
  });
});
