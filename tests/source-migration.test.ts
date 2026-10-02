import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import {
  normalizeThunderstore,
  thunderstoreDependency,
  THUNDERSTORE_ENDPOINT,
} from '../src/shared/thunderstore';
import { projectedPrerequisites, resolveDependencyGraph } from '../src/shared/dependency-graph';
import { evaluateDependency } from '../src/shared/dependencies';
import { automationReason } from '../src/shared/trust';
import { readThunderstoreCatalogue } from '../electron/services/sources/thunderstore-client';
import { remoteThunderstoreJson, safeFetch, DownloadService } from '../electron/services/network';
import { InstalledModsService } from '../electron/services/local-mods';
import { errorReply } from '../electron/services/errors';
import { LovelyInstaller } from '../electron/services/strategies';
import { mod, put, setup, thunderstorePackage, zip } from './helpers';
import { ModSchema, type ModDefinition } from '../src/shared/model';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(checkpoint?: (phase: string, index?: number) => Promise<void>) {
  const f = await setup(checkpoint);
  roots.push(f.root);
  return f;
}
function pkg(
  name: string,
  dependencies: string[] = [],
  version = '1.0.0',
  namespace = 'ArbitraryTeam',
) {
  return normalizeThunderstore(thunderstorePackage({ name, dependencies, version, namespace }))!;
}
const dep = (name: string, version = '1.0.0', namespace = 'ArbitraryTeam') =>
  `${namespace}-${name}-${version}`;
const chunk = `https://ccdn.thunderstore.io/live/blob-storage/sha256/${'b'.repeat(64)}.sh_test.blob`;

it('maps a previously unknown package, version history, description, icon and categories', () => {
  const raw = thunderstorePackage({ name: 'NeverBeforeSeen', categories: ['New Mechanics'] });
  Object.assign(raw.versions[0]!, {
    description: 'Author description',
    icon: 'https://ccdn.thunderstore.io/live/repository/icons/Author-NeverBeforeSeen-1.0.0.png',
    date_created: '2026-10-01T00:00:00Z',
    downloads: 42,
  });
  raw.versions.push(
    thunderstorePackage({ name: 'NeverBeforeSeen', version: '1.10.0' }).versions[0]!,
  );
  raw.versions.push(
    thunderstorePackage({ name: 'NeverBeforeSeen', version: '1.9.9' }).versions[0]!,
  );
  const result = normalizeThunderstore(raw)!;
  expect(result.source).toMatchObject({
    provider: 'thunderstore',
    namespace: 'Author',
    packageName: 'NeverBeforeSeen',
  });
  expect(result.version).toBe('1.10.0');
  expect(result.versions?.map((version) => version.version)).toEqual(['1.10.0', '1.9.9', '1.0.0']);
  expect(result.categories).toEqual(['New Mechanics']);
  expect(normalizeThunderstore({ ...raw, versions: [raw.versions[0]] })).toMatchObject({
    description: 'Author description',
    iconUrl: expect.stringContaining('icons/'),
  });
});
it('rejects normalized source identities substituted for another namespace', () => {
  const entry = pkg('AnyPackage');
  expect(() =>
    ModSchema.parse({
      ...entry,
      source: { ...entry.source, externalId: 'thunderstore/AnotherTeam-AnyPackage' },
    }),
  ).toThrow('source identity');
});
it('keeps a valid package whose optional project website is blank or malformed', () => {
  for (const website of ['', 'not a URL']) {
    expect(normalizeThunderstore(thunderstorePackage({ website }))).toMatchObject({
      title: 'Demo',
      websiteUrl: undefined,
    });
  }
});
it('reads index chunks only once and rejects unrelated CDN paths', async () => {
  const json = vi.fn(async (url: string) =>
    url === THUNDERSTORE_ENDPOINT ? [chunk] : [thunderstorePackage()],
  );
  expect(await readThunderstoreCatalogue(json)).toHaveLength(1);
  expect(json.mock.calls).toEqual([[THUNDERSTORE_ENDPOINT], [chunk]]);
  await expect(
    readThunderstoreCatalogue(async () => ['https://example.com/packages.json']),
  ).rejects.toThrow();
});
it('decodes gzip indexes and chunks with a bounded response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(gzipSync(JSON.stringify([chunk]))))),
  );
  expect(await remoteThunderstoreJson(THUNDERSTORE_ENDPOINT)).toEqual([chunk]);
});
it('rejects incomplete catalogue chunks whose bytes do not match the immutable hash', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(new Uint8Array(gzipSync(JSON.stringify([thunderstorePackage()])))),
    ),
  );
  await expect(remoteThunderstoreJson(chunk)).rejects.toThrow('content hash');
});
it('honours Retry-After before retrying a rate-limited index', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response('[]'));
  vi.stubGlobal('fetch', fetch);
  const request = safeFetch(THUNDERSTORE_ENDPOINT, undefined, 'thunderstore');
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await request;
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('resolves recursive and shared dependencies before dependants exactly once', () => {
  const c = pkg('C'),
    b = pkg('B', [dep('C')]),
    a = pkg('A', [dep('B'), dep('C')]);
  expect(resolveDependencyGraph([a], [a, b, c], []).map((mod) => mod.title)).toEqual([
    'C',
    'B',
    'A',
  ]);
});
it('builds a graph for multiple update roots with a shared dependency', () => {
  const c = pkg('C', [], '2.0.0'),
    a = pkg('A', [dep('C', '2.0.0')]),
    b = pkg('B', [dep('C', '2.0.0')]);
  expect(
    resolveDependencyGraph([a, b], [a, b, c], projectedPrerequisites([pkg('C')], [])).map(
      (mod) => mod.title,
    ),
  ).toEqual(['C', 'A', 'B']);
});
it('accepts a newer installed package but keeps namespaces distinct', () => {
  const c = pkg('C', [], '1.3.0'),
    a = pkg('A', [dep('C', '1.2.0')]);
  expect(
    resolveDependencyGraph([a], [a, c], projectedPrerequisites([c], [])).map((mod) => mod.title),
  ).toEqual(['A']);
  expect(
    evaluateDependency(
      thunderstoreDependency(dep('C')),
      projectedPrerequisites([pkg('C', [], '99.0.0', 'DifferentTeam')], []),
    ).state,
  ).toBe('missing');
  expect(
    evaluateDependency(thunderstoreDependency('OtherTeam-lovely-1.0.0'), [
      {
        id: 'Lovely',
        displayName: 'Lovely',
        installed: true,
        sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
      },
    ]).state,
  ).toBe('missing');
});
it('uses installed version dependencies instead of assuming the newest release is installed', () => {
  const old = pkg('B');
  const current = pkg('B', [dep('MissingFutureDependency')], '2.0.0');
  current.versions!.push(...old.versions!);
  const a = pkg('A', [dep('B')]);
  expect(
    resolveDependencyGraph([a], [a, current], projectedPrerequisites([old], [])).map(
      (mod) => mod.title,
    ),
  ).toEqual(['A']);
});
it('detects circular, missing, incompatible and unsupported dependency graphs', () => {
  const a = pkg('A', [dep('B')]),
    b = pkg('B', [dep('A')]);
  expect(() => resolveDependencyGraph([a], [a, b], [])).toThrow('Circular');
  expect(() => resolveDependencyGraph([a], [a], [])).toThrow('missing or ambiguous');
  expect(() => resolveDependencyGraph([pkg('A', [dep('B', '2.0.0')])], [pkg('B')], [])).toThrow(
    'compatible',
  );
  expect(() =>
    resolveDependencyGraph([a], [a, { ...pkg('B'), installation: { type: 'unsupported' } }], []),
  ).toThrow('not supported');
});
it('preserves deprecated packages for management while blocking new installs', () => {
  const entry = normalizeThunderstore(thunderstorePackage({ deprecated: true }))!;
  expect(entry.deprecated).toBe(true);
  expect(automationReason(entry)).toContain('deprecated');
  expect(automationReason(entry, true)).toBeUndefined();
});

async function mockArchives(
  f: Awaited<ReturnType<typeof fixture>>,
  mods: ModDefinition[],
  unknown = false,
) {
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async (url) => {
    const entry = mods.find((mod) => mod.downloadUrl === url)!;
    const archive = path.join(f.root, `${entry.metadataId}-${Math.random()}.zip`);
    const registry = entry.thunderstore!;
    await fs.writeFile(
      archive,
      zip([
        {
          name: 'manifest.json',
          data: JSON.stringify({
            name: registry.name,
            version_number: registry.packageVersion,
            dependencies: registry.dependencies,
          }),
        },
        { name: 'README.md', data: 'Packaging text' },
        ...(unknown && entry === mods[mods.length - 1]
          ? [{ name: 'custom.payload', data: 'unsupported' }]
          : [
              {
                name: 'mod.json',
                data: JSON.stringify({ id: entry.metadataId, version: entry.version }),
              },
              { name: 'main.lua', data: 'return true' },
            ]),
      ]),
    );
    return archive;
  });
}
it('stages a complete dependency plan, then commits one transaction with provenance and ownership', async () => {
  const f = await fixture();
  const c = pkg('C'),
    b = pkg('B', [dep('C')]),
    a = pkg('A', [dep('B')]);
  const graph = resolveDependencyGraph([a], [a, b, c], []);
  await mockArchives(f, graph);
  const first = await f.installer.installMany(graph).catch(errorReply);
  expect(first).toHaveProperty('confirmation');
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
  const token = (first as ReturnType<typeof errorReply>).confirmation!.token;
  await f.installer.installMany(graph, token);
  expect(f.storage.state.installations.map((record) => record.title)).toEqual(['C', 'B', 'A']);
  expect(new Set(f.storage.state.installations.map((record) => record.transactionId)).size).toBe(1);
  expect(f.storage.state.installations[0]).toMatchObject({
    automaticallyInstalled: true,
    provenance: {
      provider: 'thunderstore',
      namespace: 'ArbitraryTeam',
      packageName: 'C',
      packageVersion: '1.0.0',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(
    f.storage.state.installations
      .flatMap((record) => record.files)
      .some((file) => /manifest\.json|README\.md/.test(file.path)),
  ).toBe(false);
  await expect(f.installer.uninstall(c.id)).rejects.toThrow('required by');
});
it('rejects an unknown layout before installing any dependency', async () => {
  const f = await fixture(),
    b = pkg('B'),
    a = pkg('A', [dep('B')]);
  await mockArchives(f, [b, a], true);
  await expect(f.installer.installMany([b, a])).rejects.toThrow();
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('rolls back the entire dependency set if the commit fails', async () => {
  const f = await fixture(async (phase, index) => {
    if (phase === 'changed' && index === 1) throw new Error('Simulated failure');
  });
  const b = pkg('B'),
    a = pkg('A', [dep('B')]);
  await mockArchives(f, [b, a]);
  const first = await f.installer.installMany([b, a]).catch(errorReply);
  await expect(
    f.installer.installMany([b, a], (first as ReturnType<typeof errorReply>).confirmation!.token),
  ).rejects.toThrow('Simulated failure');
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('installs a local ZIP with no network access using the transactional pipeline', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'local.zip');
  await fs.writeFile(
    archive,
    zip([
      { name: 'main.lua', data: 'return true' },
      { name: 'mod.json', data: JSON.stringify({ id: 'LocalOnly', version: '0.3.0' }) },
    ]),
  );
  const download = vi.spyOn(DownloadService.prototype, 'download');
  await f.installer.install(
    mod({
      id: 'local/Arbitrary',
      source: { provider: 'local', externalId: 'local/Arbitrary' },
      installation: { type: 'auto' },
    }),
    false,
    undefined,
    false,
    [],
    archive,
  );
  expect(download).not.toHaveBeenCalled();
  expect(f.storage.state.installations[0]).toMatchObject({
    modVersion: '0.3.0',
    provenance: { sourceType: 'local', provider: 'local', sha256: expect.any(String) },
  });
  expect(f.storage.state.installations[0]?.files).toHaveLength(2);
  expect(await fs.readFile(archive)).toBeTruthy();
});
it('detects Lovely from binary evidence, rejects unrelated libraries, and does not infer an external version', async () => {
  const f = await fixture();
  const extension = process.platform === 'darwin' ? 'dylib' : 'dll';
  const magic = process.platform === 'darwin' ? Buffer.from('cffaedfe', 'hex') : Buffer.from('MZ');
  await fs.writeFile(
    path.join(f.game, `unknown.${extension}`),
    Buffer.concat([magic, Buffer.from('lovely runtime injector')]),
  );
  const service = new InstalledModsService(f.storage, f.logger);
  expect(
    (await service.scan([])).prerequisites.find((entry) => entry.id === 'Lovely'),
  ).toMatchObject({ installed: true, installedVersion: undefined });
  await fs.writeFile(
    path.join(f.game, `unknown.${extension}`),
    Buffer.concat([magic, Buffer.from('unrelated library')]),
  );
  expect(
    (await service.scan([])).prerequisites.find((entry) => entry.id === 'Lovely')?.installed,
  ).toBe(false);
});
it('uses the active prerequisite package despite a deprecated package with the same name', async () => {
  const f = await fixture();
  const current = normalizeThunderstore(
    thunderstorePackage({ namespace: 'Steamodded', name: 'Steamodded', version: '26.829.0' }),
  )!;
  const retired = normalizeThunderstore(
    thunderstorePackage({ namespace: 'Steamopollys', name: 'Steamodded', deprecated: true }),
  )!;
  const service = new InstalledModsService(f.storage, f.logger);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  // Lovely and Talisman may use fallback lookup; Steamodded never does.
  const scan = await service.scan([retired, current]);
  expect(scan.prerequisites.find((entry) => entry.id === 'Steamodded')).toMatchObject({
    latestVersion: '26.829.0',
    latestPackageId: current.id,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('interprets supported Lovely library names and refuses unfamiliar payloads', async () => {
  const f = await fixture();
  const name = process.platform === 'darwin' ? 'liblovely.dylib' : 'version.dll';
  const magic = process.platform === 'darwin' ? Buffer.from('cffaedfe', 'hex') : Buffer.from('MZ');
  await fs.writeFile(path.join(f.stage, name), Buffer.concat([magic, Buffer.from('lovely')]));
  const definition = mod({ installation: { type: 'lovely-injector' } });
  expect(await new LovelyInstaller().plan({ mod: definition, staging: f.stage })).toMatchObject([
    { root: 'game', path: name },
  ]);
  await put(path.join(f.stage, 'unrecognized.dat'));
  await expect(new LovelyInstaller().plan({ mod: definition, staging: f.stage })).rejects.toThrow(
    'not yet supported',
  );
});
