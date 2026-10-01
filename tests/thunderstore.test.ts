import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeThunderstore, thunderstoreDependency } from '../src/shared/thunderstore';
import { evaluateDependency } from '../src/shared/dependencies';
import { safeFetch, validateRemoteUrl, DownloadService } from '../electron/services/network';
import { InstalledModsService } from '../electron/services/local-mods';
import { ArtifactHistory } from '../electron/services/artifacts';
import { CatalogueTrust } from '../electron/services/trust';
import {
  readAuthorManifest,
  readLatestGitHubRelease,
  validateDistribution,
} from '../electron/services/distribution';
import { inspectMetadata } from '../electron/services/metadata';
import { ModatroApplication } from '../electron/application';
import { ModSchema } from '../src/shared/model';
import { mod, put, setup, thunderstorePackage, zip } from './helpers';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
const definition = () => normalizeThunderstore(thunderstorePackage())!;
it('retains author removals across registry package renames using the package UUID', async () => {
  const f = await fixture();
  const original = definition();
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) => ({
    schemaVersion: 1,
    revision: 2,
    generatedAt: '2026-10-01T00:00:00Z',
    ...(url.endsWith('revocations.json')
      ? {
          revocations: [
            {
              modId: original.id,
              packageId: original.thunderstore!.packageId,
              reason: 'author-request',
              effectiveAt: '2026-10-01T00:00:00Z',
            },
          ],
        }
      : { blockedReleases: [] }),
  }));
  await trust.refresh();
  const renamed = normalizeThunderstore({
    ...thunderstorePackage({
      namespace: 'NewAuthor',
      website: 'https://github.com/newauthor/demo',
    }),
    uuid4: original.thunderstore!.packageId,
  })!;
  expect(trust.apply(renamed).approvalStatus).toBe('opted-out');
  await expect(trust.assertAllowed(renamed, true, false)).rejects.toThrow('requested removal');
});
it('blocks a registry release by package version even when its runtime version differs', async () => {
  const f = await fixture();
  const entry = definition();
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) => ({
    schemaVersion: 1,
    revision: 2,
    generatedAt: '2026-10-01T00:00:00Z',
    ...(url.endsWith('revocations.json')
      ? { revocations: [] }
      : {
          blockedReleases: [
            {
              modId: 'thunderstore/OldAuthor-Demo',
              packageId: entry.thunderstore!.packageId,
              version: '1.0.0',
              status: 'blocked',
              reason: 'Broken package',
              effectiveAt: '2026-10-01T00:00:00Z',
            },
          ],
        }),
  }));
  await trust.refresh();
  await expect(trust.assertAllowed({ ...entry, version: '8.0.0' }, true, false)).rejects.toThrow(
    'Release 1.0.0 is blocked',
  );
});
async function archive(
  f: Awaited<ReturnType<typeof fixture>>,
  version = '1.0.0',
  runtimeVersion = '8.0.0',
  name = 'Demo',
) {
  const file = path.join(f.root, `download-${version}.zip`);
  await fs.writeFile(
    file,
    zip([
      {
        name: 'manifest.json',
        data: JSON.stringify({ name, version_number: version, dependencies: [] }),
      },
      { name: 'mod.json', data: JSON.stringify({ id: 'Demo', version: runtimeVersion }) },
      { name: 'main.lua', data: 'return true' },
    ]),
  );
  return file;
}

it('allows registry redirects only within its own reviewed CDN paths', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://ccdn.thunderstore.io/live/repository/packages/Author-Demo-1.0.0.zip',
        },
      }),
    )
    .mockResolvedValueOnce(new Response('zip'));
  vi.stubGlobal('fetch', fetch);
  await safeFetch(definition().downloadUrl, undefined, 'thunderstore');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
  expect(() => validateRemoteUrl(definition().downloadUrl)).toThrow('GitHub sources only');
  expect(() =>
    validateRemoteUrl('https://ccdn.thunderstore.io/private/file.zip', 'thunderstore'),
  ).toThrow();
  expect(() =>
    validateRemoteUrl(`${definition().downloadUrl}?redirect=evil`, 'thunderstore'),
  ).toThrow();
});
it('rejects registry redirects to arbitrary hosts and unrelated communities', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/evil/replacement.zip' },
        }),
    ),
  );
  await expect(safeFetch(definition().downloadUrl, undefined, 'thunderstore')).rejects.toThrow(
    'outside',
  );
  expect(() =>
    validateRemoteUrl('https://thunderstore.io/c/other/api/v1/package/', 'thunderstore'),
  ).toThrow();
});
it('cannot approve a different registry package by changing its source URL', () => {
  expect(() =>
    validateDistribution(
      mod({
        ...definition(),
        downloadUrl: 'https://thunderstore.io/package/download/Other/Demo/1.0.0/',
      }),
    ),
  ).toThrow('identity');
});
it('installs and updates packages while keeping runtime versions separate', async () => {
  const f = await fixture();
  const first = definition();
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(
    async (url, _signal, _progress, source) => {
      expect(source).toBe('thunderstore');
      return archive(f, url.includes('/2.0.0/') ? '2.0.0' : '1.0.0');
    },
  );
  await f.installer.install(first);
  expect(f.storage.state.installations[0]).toMatchObject({
    modVersion: '8.0.0',
    packageVersion: '1.0.0',
    metadataId: 'Demo',
    provenance: { sourceType: 'registry', packageId: first.thunderstore!.packageId },
  });
  const latest = normalizeThunderstore(thunderstorePackage({ version: '2.0.0' }))!;
  const service = new InstalledModsService(f.storage, f.logger);
  let scan = await service.scan([latest]);
  expect(scan.mods[0]).toMatchObject({ version: '1.0.0', state: 'update-available' });
  const requirement = thunderstoreDependency('Author-Demo-2.0.0');
  expect(evaluateDependency(requirement, scan.prerequisites).state).toBe('outdated');
  expect(scan.prerequisites.find((p) => p.id === 'Demo')).toMatchObject({
    installedVersion: '8.0.0',
    packageVersion: '1.0.0',
  });
  await f.installer.install(latest, true);
  scan = await service.scan([latest]);
  expect(scan.mods[0]).toMatchObject({ version: '2.0.0', state: 'installed' });
  expect(evaluateDependency(requirement, scan.prerequisites).state).toBe('satisfied');
});
it('does not pretend an external runtime version proves a package version', async () => {
  const requirement = thunderstoreDependency('Steamodded-Steamodded-1.0.0');
  expect(
    evaluateDependency(requirement, [
      {
        id: 'Steamodded',
        displayName: 'Steamodded',
        installed: true,
        installedVersion: '99.0.0',
        sourceUrl: 'https://github.com/Steamodded/smods',
      },
    ]).state,
  ).toBe('unknown');
  const f = await fixture();
  await put(
    path.join(f.mods, 'ExternalDemo', 'mod.json'),
    JSON.stringify({ id: 'Demo', version: '99.0.0' }),
  );
  await put(path.join(f.mods, 'ExternalDemo', 'main.lua'), 'return true');
  await f.installer.adopt('ExternalDemo', definition());
  const scan = await new InstalledModsService(f.storage, f.logger).scan([definition()]);
  expect(scan.mods[0]).toMatchObject({
    state: 'installed',
    packageVersionUnknown: true,
    folderName: 'ExternalDemo',
  });
  expect(f.storage.state.installations[0]?.packageVersion).toBeUndefined();
});
it('rejects a registry manifest which disagrees with the selected release before writing user files', async () => {
  const f = await fixture();
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () =>
    archive(f, '9.0.0'),
  );
  await expect(f.installer.install(definition())).rejects.toThrow('differs from');
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('keeps immutable registry hashes even after uninstall and rejects replacement bytes', async () => {
  const f = await fixture();
  const history = new ArtifactHistory(f.storage, f.logger);
  await history.verify(definition(), 'a'.repeat(64));
  await expect(
    new ArtifactHistory(f.storage, f.logger).verify(definition(), 'b'.repeat(64)),
  ).rejects.toThrow('has changed');
});
it('does not use a Thunderstore manifest version as Steamodded runtime proof', async () => {
  const f = await fixture();
  await put(
    path.join(f.stage, 'manifest.json'),
    JSON.stringify({ name: 'Steamodded', version_number: '26.829.0', dependencies: [] }),
  );
  expect((await inspectMetadata(f.stage)).version).toBeUndefined();
  await put(path.join(f.stage, 'version.lua'), 'return "1.0.0~BETA"');
  expect((await inspectMetadata(f.stage)).version).toBe('1.0.0~BETA');
});
it('retains record IDs and folders when a provider identity changes but its UUID stays stable', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'return true');
  await f.installer.commitPrepared(
    await f.installer.plan(
      mod({ id: 'old@Demo', metadataId: 'Demo', folderName: 'ExistingDemo' }),
      f.stage,
    ),
  );
  await f.storage.save({
    ...f.storage.state,
    installations: f.storage.state.installations.map((record) => ({
      ...record,
      provenance: { sourceType: 'registry', packageId: definition().thunderstore!.packageId },
    })),
  });
  vi.stubEnv('MODATRO_TEST_DATA', f.storage.root);
  const application = new ModatroApplication(
    f.storage.root,
    'test',
    'test',
    () => {},
    () => {},
  );
  await application.initialize();
  application.repository.thunderstore.catalogue.mods = [definition()];
  expect(application.allMods()[0]).toMatchObject({
    id: 'old@Demo',
    folderName: 'ExistingDemo',
    legacyIds: expect.arrayContaining(['thunderstore/Author-Demo']),
  });
  expect(application.storage.state.installations[0]?.modId).toBe('old@Demo');
});

const release = (
  version: string,
  assets: { name: string; browser_download_url: string }[] = [],
) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  assets,
});
it('tracks new author GitHub releases and changing asset names without index edits', async () => {
  const entry = mod({ githubRelease: { assetName: 'Demo-{version}.zip' } });
  const latest = await readLatestGitHubRelease(entry, async () =>
    release('2.0.0', [
      {
        name: 'Demo-2.0.0.zip',
        browser_download_url:
          'https://github.com/fixture/mod/releases/download/v2.0.0/Demo-2.0.0.zip',
      },
    ]),
  );
  expect(latest).toMatchObject({
    version: '2.0.0',
    releaseSource: { sourceType: 'release-asset', releaseTag: 'v2.0.0' },
  });
});
it('intersects author permissions while following releases from a manifest without a hardcoded version', async () => {
  const entry = mod({
    id: 'fixture/mod',
    manifestUrl: 'https://raw.githubusercontent.com/fixture/mod/main/modatro.json',
    permissions: { display: true, install: true, update: false },
  });
  const manifest = await readAuthorManifest(entry, async () => ({
    schemaVersion: 1,
    id: 'fixture/mod',
    name: 'Example',
    author: 'Fixture',
    permissions: { display: true, install: true, update: true },
    distribution: { repository: entry.repositoryUrl, trackLatestRelease: true },
    installation: { type: 'mods-directory', folder: 'Example' },
  }));
  const latest = await readLatestGitHubRelease(manifest, async () => release('2.0.0'));
  expect(latest.permissions).toEqual({ display: true, install: true, update: false });
  expect(latest.version).toBe('2.0.0');
});
it('rejects ambiguous GitHub release assets and cannot change the author repository', async () => {
  await expect(
    readLatestGitHubRelease(mod({ githubRelease: {} }), async () =>
      release(
        '2.0.0',
        ['one', 'two'].map((name) => ({
          name: `${name}.zip`,
          browser_download_url: `https://github.com/fixture/mod/releases/download/v2.0.0/${name}.zip`,
        })),
      ),
    ),
  ).rejects.toThrow('unambiguous');
  await expect(
    readLatestGitHubRelease(ModSchema.parse({ ...mod(), githubRelease: {} }), async () =>
      release('2.0.0', [
        {
          name: 'one.zip',
          browser_download_url: 'https://github.com/evil/mod/releases/download/v2.0.0/one.zip',
        },
      ]),
    ),
  ).rejects.toThrow('declared author');
});
