import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogueTrust } from '../electron/services/trust';
import { ArtifactHistory } from '../electron/services/artifacts';
import { InstalledModsService } from '../electron/services/local-mods';
import { NativeModRepository } from '../electron/services/catalogue';
import {
  resolveDistribution,
  readAuthorManifest,
  validateDistribution,
} from '../electron/services/distribution';
import { sourceType, automationReason } from '../src/shared/trust';
import { AuthorManifestSchema, NativeCatalogueSchema } from '../src/shared/catalogue-schema';
import { DownloadService } from '../electron/services/network';
import { UserError } from '../electron/services/errors';
import { inspectMetadata } from '../electron/services/metadata';
import { mod, put, setup, zip } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await setup();
  roots.push(f.root);
  return f;
}
const revocations = {
  schemaVersion: 1,
  revision: 2,
  generatedAt: '2026-10-01T00:00:00Z',
  revocations: [
    { modId: 'test-mod', reason: 'author-request', effectiveAt: '2026-10-01T00:00:00Z' },
  ],
};
const blocked = {
  schemaVersion: 1,
  revision: 2,
  generatedAt: revocations.generatedAt,
  blockedReleases: [
    {
      modId: 'test-mod',
      version: '1.0.0',
      status: 'blocked',
      reason: 'Broken release',
      effectiveAt: revocations.generatedAt,
    },
  ],
};
const empty = { ...blocked, blockedReleases: [] };

it('applies an author removal to stale catalogue data and keeps installed files intact', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'local mod');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) =>
    url.endsWith('/revocations.json') ? revocations : empty,
  );
  await trust.refresh();
  expect(trust.apply(mod())).toMatchObject({
    approvalStatus: 'opted-out',
    permissions: { install: false, update: false },
  });
  await expect(trust.assertAllowed(mod(), false)).rejects.toThrow('requested removal');
  await expect(trust.assertAllowed(mod(), true)).rejects.toThrow('requested removal');
  const scan = await new InstalledModsService(f.storage, f.logger, trust).scan([
    trust.apply(mod({ version: '2.0.0' })),
  ]);
  expect(scan.mods[0]?.state).toBe('installed');
  expect(scan.mods[0]?.availabilityReason).toContain('requested removal');
  expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe('local mod');
  await f.installer.uninstall('test-mod');
  expect(f.storage.state.installations).toEqual([]);
});
it('retains removals across restarts and rejects an older restriction feed', async () => {
  const f = await fixture();
  const json = async (url: string) => (url.endsWith('/revocations.json') ? revocations : empty);
  const trust = new CatalogueTrust(f.storage, f.logger, json);
  await trust.refresh();
  const restart = new CatalogueTrust(f.storage, f.logger, async (url) =>
    url.endsWith('/revocations.json') ? { ...revocations, revision: 1, revocations: [] } : empty,
  );
  await restart.initialize();
  await restart.refresh();
  expect(restart.apply(mod()).approvalStatus).toBe('opted-out');
  expect(restart.isFresh()).toBe(false);
});
it('applies a newer removal even if the other feed is unavailable', async () => {
  const f = await fixture();
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) => {
    if (url.endsWith('/revocations.json')) return revocations;
    throw new Error('offline');
  });
  await trust.refresh();
  expect(trust.apply(mod()).approvalStatus).toBe('opted-out');
  expect(trust.isFresh()).toBe(false);
});
it('blocks new downloads when current restriction data cannot be established', async () => {
  const f = await fixture();
  const trust = new CatalogueTrust(f.storage, f.logger, async () => {
    throw new Error('offline');
  });
  await expect(trust.assertAllowed(mod(), false)).rejects.toThrow('connect and refresh');
});
it('applies repository revocations to an alias rather than trusting a renamed ID', async () => {
  const f = await fixture();
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) =>
    url.endsWith('/revocations.json')
      ? {
          ...revocations,
          revocations: [
            { ...revocations.revocations[0], repositoryUrl: 'https://github.com/fixture/mod' },
          ],
        }
      : empty,
  );
  await trust.refresh();
  expect(trust.apply(mod({ id: 'renamed/mod' })).approvalStatus).toBe('opted-out');
});
it('blocks just the flagged release and offers a safe newer version without changing the installed copy', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'original');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  const trust = new CatalogueTrust(f.storage, f.logger, async (url) =>
    url.endsWith('/revocations.json') ? { ...revocations, revocations: [] } : blocked,
  );
  await trust.refresh();
  expect(trust.apply(mod()).policyReason).toContain('blocked');
  const safe = trust.apply(mod({ version: '2.0.0' }));
  expect(safe.policyReason).toBeUndefined();
  const scan = await new InstalledModsService(f.storage, f.logger, trust).scan([safe]);
  expect(scan.mods[0]).toMatchObject({
    state: 'update-available',
    releaseWarning: expect.stringContaining('Broken release'),
  });
  expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe('original');
});
it('records archive provenance and rejects a changed immutable artifact after restart', async () => {
  const f = await fixture();
  const original = 'a'.repeat(64),
    changed = 'b'.repeat(64);
  const history = new ArtifactHistory(f.storage, f.logger);
  const provenance = await history.verify(mod(), original);
  expect(provenance).toMatchObject({
    sourceType: 'tag',
    releaseTag: 'v1.0.0',
    sha256: original,
    downloadUrl: mod().downloadUrl,
  });
  await expect(new ArtifactHistory(f.storage, f.logger).verify(mod(), changed)).rejects.toThrow(
    'has changed',
  );
});
it('honours a supplied checksum on the first download', async () => {
  const f = await fixture();
  await expect(
    new ArtifactHistory(f.storage, f.logger).verify(
      mod({ releaseSource: { sourceType: 'tag', sha256: 'a'.repeat(64) } }),
      'b'.repeat(64),
    ),
  ).rejects.toThrow('has changed');
});
it('does not let a changed author-supplied checksum replace an observed immutable hash', async () => {
  const f = await fixture();
  const history = new ArtifactHistory(f.storage, f.logger);
  await history.verify(mod(), 'a'.repeat(64));
  await expect(
    history.verify(
      mod({ releaseSource: { sourceType: 'tag', sha256: 'b'.repeat(64) } }),
      'b'.repeat(64),
    ),
  ).rejects.toThrow('has changed');
});
it('identifies moving branches honestly and allows a newly pinned commit as a different artifact', async () => {
  const f = await fixture();
  expect(sourceType('https://github.com/a/b/archive/refs/heads/main.zip')).toBe('branch');
  await new ArtifactHistory(f.storage, f.logger).verify(
    mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
    'a'.repeat(64),
  );
  await expect(
    new ArtifactHistory(f.storage, f.logger).verify(
      mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
      'b'.repeat(64),
    ),
  ).resolves.toMatchObject({ sourceType: 'branch' });
});
it('separates install permission from update permission', () => {
  const definition = mod({ permissions: { display: true, install: true, update: false } });
  expect(automationReason(definition)).toBeUndefined();
  expect(automationReason(definition, true)).toContain('updates');
});
it('prefers a matching published ZIP over a moving branch', async () => {
  const definition = await resolveDistribution(
    mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
    async () => ({
      tag_name: 'v1.0.0',
      assets: [
        {
          name: 'mod.zip',
          browser_download_url: 'https://github.com/fixture/mod/releases/download/v1.0.0/mod.zip',
        },
      ],
    }),
  );
  expect(definition.releaseSource).toMatchObject({
    sourceType: 'release-asset',
    releaseTag: 'v1.0.0',
  });
});
it('pins a branch to a commit when published releases do not exist', async () => {
  const definition = await resolveDistribution(
    mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
    async (url) => {
      if (url.includes('/releases/') || url.includes('/git/ref/'))
        throw new UserError('missing', undefined, undefined, undefined, 404);
      return { sha: 'a'.repeat(40) };
    },
  );
  expect(definition.downloadUrl).toContain('a'.repeat(40));
  expect(definition.releaseSource?.sourceType).toBe('commit');
});
it('does not mask request failures as absent releases', async () => {
  await expect(
    resolveDistribution(
      mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
      async () => {
        throw new UserError('rate limit', undefined, undefined, undefined, 429);
      },
    ),
  ).rejects.toThrow('rate limit');
});
it('prefers an independently published tag over a moving branch when no release asset exists', async () => {
  const definition = await resolveDistribution(
    mod({ downloadUrl: 'https://github.com/fixture/mod/archive/main.zip' }),
    async (url) => {
      if (url.includes('/releases/'))
        throw new UserError('missing', undefined, undefined, undefined, 404);
      return { ref: 'refs/tags/v1.0.0', object: { type: 'commit', sha: 'a'.repeat(40) } };
    },
  );
  expect(definition.releaseSource).toMatchObject({
    sourceType: 'tag',
    releaseTag: 'v1.0.0',
    commitSha: 'a'.repeat(40),
  });
});
it('rejects distribution from a different repository without explicit approval', () => {
  expect(() =>
    validateDistribution(mod({ downloadUrl: 'https://github.com/other/mod/archive/v1.zip' })),
  ).toThrow('declared author');
});
it('rejects a moving branch falsely described as an immutable release', () => {
  expect(() =>
    validateDistribution(
      mod({
        downloadUrl: 'https://github.com/fixture/mod/archive/main.zip',
        releaseSource: { sourceType: 'tag' },
      }),
    ),
  ).toThrow('does not match');
});
const authorManifest = {
  schemaVersion: 1,
  id: 'fixture/mod',
  name: 'Author Mod',
  author: 'Fixture',
  version: '1.0.0',
  permissions: { display: true, install: true, update: false },
  distribution: {
    repository: 'https://github.com/fixture/mod',
    releaseUrl: 'https://github.com/fixture/mod/releases/download/v1.0.0/mod.zip',
  },
  requirements: { lovely: '>=0.9.0' },
  installation: { type: 'mods-directory', folder: 'AuthorMod' },
};
it('reads an author-controlled manifest and preserves its separate update permission', async () => {
  const definition = await readAuthorManifest(
    mod({
      id: 'fixture/mod',
      manifestUrl: 'https://raw.githubusercontent.com/fixture/mod/main/modatro.json',
    }),
    async () => authorManifest,
  );
  expect(definition).toMatchObject({
    title: 'Author Mod',
    permissions: { update: false },
    folderName: 'AuthorMod',
    installation: { type: 'standard' },
  });
  expect(definition.prerequisites).toContainEqual({
    id: 'Lovely',
    displayName: 'lovely',
    versionConstraint: '>=0.9.0',
    required: true,
  });
});
it('rejects manifests from another repository and unsafe installation paths', async () => {
  await expect(
    readAuthorManifest(
      mod({ manifestUrl: 'https://raw.githubusercontent.com/other/mod/main/modatro.json' }),
    ),
  ).rejects.toThrow('declared source');
  expect(() =>
    AuthorManifestSchema.parse({
      ...authorManifest,
      installation: { type: 'mods-directory', folder: '../outside' },
    }),
  ).toThrow();
});
it('keeps the loader identity when an author manifest uses a namespaced catalogue ID', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'mod');
  await put(path.join(f.stage, 'mod.json'), JSON.stringify({ id: 'loader-id', version: '1.0.0' }));
  await put(
    path.join(f.stage, 'modatro.json'),
    JSON.stringify({ ...authorManifest, requirements: {} }),
  );
  const prepared = await f.installer.plan(
    mod({ id: 'fixture/mod', metadataId: 'loader-id' }),
    f.stage,
  );
  expect(prepared.metadataId).toBe('loader-id');
  expect(prepared.folderName).toBe('fixture@mod');
});
it('rejects conflicting versions in author and loader manifests before changing user files', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'mod');
  await put(path.join(f.stage, 'mod.json'), JSON.stringify({ id: 'loader-id', version: '2.0.0' }));
  await put(path.join(f.stage, 'modatro.json'), JSON.stringify(authorManifest));
  await expect(inspectMetadata(f.stage)).rejects.toThrow('different versions');
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('keeps an installed mod unchanged when its source disappears', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'installed');
  await f.installer.commitPrepared(await f.installer.plan(mod(), f.stage));
  vi.spyOn(DownloadService.prototype, 'download').mockRejectedValue(
    new UserError(
      'The original download source is no longer available.',
      undefined,
      undefined,
      undefined,
      404,
    ),
  );
  await expect(f.installer.install(mod({ version: '2.0.0' }), true)).rejects.toThrow(
    'no longer available',
  );
  expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe('installed');
  expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
});
it('never copies or executes an installer executable in a standard archive', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'unsafe.zip');
  await fs.writeFile(
    archive,
    zip([
      { name: 'main.lua', data: 'mod' },
      { name: 'installer.exe', data: 'MZunsafe' },
    ]),
  );
  vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
  await expect(f.installer.install(mod())).rejects.toThrow('external installer');
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('uses a real install plan for game-file confirmation and revalidates it', async () => {
  const f = await fixture();
  await put(path.join(f.game, 'foo.lua'), 'original');
  const archive = () => path.join(f.root, `download-${Math.random()}.zip`);
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const file = archive();
    await fs.writeFile(file, zip([{ name: 'replacement.lua', data: 'replacement' }]));
    return file;
  });
  const definition = mod({
    installation: {
      type: 'game-replacement',
      files: [{ source: 'replacement.lua', destination: 'foo.lua' }],
    },
  });
  let token = '';
  try {
    await f.installer.install(definition);
  } catch (error) {
    const request = (error as UserError).context?.confirmation;
    token = request!.token;
    expect(request!.plan.replace).toMatchObject([{ root: 'game', path: 'foo.lua' }]);
    expect(request!.plan.replace[0]).not.toHaveProperty('source');
  }
  expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('original');
  await f.installer.install(definition, false, token);
  expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('replacement');
});
it('inspects a standard install plan without changing user files or creating an installation record', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'plan.zip');
  await fs.writeFile(archive, zip([{ name: 'main.lua', data: 'mod' }]));
  vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
  const plan = await f.installer.install(mod(), false, undefined, true);
  expect(plan?.create).toMatchObject([{ root: 'mods', path: 'test-mod/main.lua' }]);
  expect(plan?.create[0]).not.toHaveProperty('source');
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('rejects native index duplicates, missing consent evidence and insecure URLs', () => {
  const entry = {
    ...mod({ id: 'fixture/mod' }),
    approvalStatus: 'author-approved',
    approvalEvidence: 'https://github.com/fixture/mod/issues/1',
    permissions: { display: true, install: true, update: true },
  };
  expect(() =>
    NativeCatalogueSchema.parse({
      schemaVersion: 1,
      generatedAt: revocations.generatedAt,
      mods: [entry, entry],
    }),
  ).toThrow();
  expect(() =>
    NativeCatalogueSchema.parse({
      schemaVersion: 1,
      generatedAt: revocations.generatedAt,
      mods: [{ ...entry, approvalEvidence: undefined }],
    }),
  ).toThrow();
  expect(() =>
    NativeCatalogueSchema.parse({
      schemaVersion: 1,
      generatedAt: revocations.generatedAt,
      mods: [{ ...entry, downloadUrl: 'file:///tmp/mod' }],
    }),
  ).toThrow();
});
it('preserves the native catalogue when its source is offline', async () => {
  const f = await fixture();
  const repository = new NativeModRepository(f.storage, f.logger, async () => {
    throw new Error('offline');
  });
  repository.catalogue.mods = [mod({ id: 'fixture/mod' })];
  await repository.refresh();
  expect(repository.catalogue.mods).toHaveLength(1);
  expect(repository.catalogue.stale).toBe(true);
});
