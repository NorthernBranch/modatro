import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ModatroApplication } from '../electron/application';
import { DownloadService } from '../electron/services/network';
import { errorReply } from '../electron/services/errors';
import { InstalledModsService } from '../electron/services/local-mods';
import { publishedOptions, developmentAvailability } from '../electron/services/releases';
import { ThunderstoreRepository } from '../electron/services/catalogue';
import { GameDetectionService } from '../electron/services/detection';
import { developmentDistribution } from '../electron/services/distribution';
import { normalizeThunderstore } from '../src/shared/thunderstore';
import { mod, put, setup, thunderstorePackage, zip } from './helpers';

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of fixtures.splice(0)) {
    await f.installer.cancel();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await setup();
  fixtures.push(f);
  return f;
}
async function applicationFixture(
  f: Awaited<ReturnType<typeof setup>>,
  mods: ReturnType<typeof mod>[] = [],
) {
  vi.stubEnv('MODATRO_TEST_DATA', f.storage.root);
  const app = new ModatroApplication(
    f.storage.root,
    'test',
    'test',
    () => {},
    () => {},
  );
  await app.initialize();
  app.repository.thunderstore.catalogue = {
    mods,
    fetchedAt: new Date().toISOString(),
    stale: false,
    refreshing: false,
    rejected: 0,
  };
  const detection = new GameDetectionService('win32', f.root);
  const folders = new GameDetectionService('linux', f.root);
  vi.spyOn(app.detection, 'validate').mockImplementation((file) => detection.validate(file));
  vi.spyOn(app.detection, 'validateMods').mockImplementation((file, game, create) =>
    folders.validateMods(file, game, create),
  );
  vi.spyOn(app.launch, 'assertClosed').mockResolvedValue();
  vi.spyOn(app.trust, 'assertAllowed').mockResolvedValue();
  return app;
}
async function install(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  version: string,
  dependencies: ReturnType<typeof mod>['prerequisites'] = [],
) {
  const directory = path.join(f.root, `${id}-${version}`);
  await put(path.join(directory, 'mod.json'), JSON.stringify({ id, name: id, version }));
  await put(path.join(directory, 'main.lua'), `return '${version}'`);
  const prepared = await f.installer.plan(
    mod({ id, metadataId: id, title: id, version, prerequisites: dependencies }),
    directory,
  );
  await f.installer.commitPrepared(prepared);
}
const requirement = (versionConstraint: string) => ({
  id: 'Library',
  displayName: 'Library',
  versionConstraint,
  required: true,
});
async function prepareUpdate(f: Awaited<ReturnType<typeof setup>>, includeOldAddon: boolean) {
  const changes = [
    mod({
      id: 'Library',
      metadataId: 'Library',
      title: 'Library',
      version: '2.0.0',
      downloadUrl: 'https://github.com/fixture/mod/archive/library.zip',
    }),
    mod({
      id: 'NewAddon',
      metadataId: 'NewAddon',
      title: 'NewAddon',
      prerequisites: [requirement('>=2.0.0')],
      downloadUrl: 'https://github.com/fixture/mod/archive/new-addon.zip',
    }),
  ];
  if (includeOldAddon)
    changes.push(
      mod({
        id: 'OldAddon',
        metadataId: 'OldAddon',
        title: 'OldAddon',
        version: '2.0.0',
        prerequisites: [requirement('>=2.0.0')],
        downloadUrl: 'https://github.com/fixture/mod/archive/old-addon.zip',
      }),
    );
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async (url) => {
    const selected = changes.find((entry) => entry.downloadUrl === url)!;
    const file = path.join(f.root, `${selected.id}.zip`);
    await fs.writeFile(
      file,
      zip([
        { name: 'mod.json', data: JSON.stringify({ id: selected.id, version: selected.version }) },
        { name: 'main.lua', data: `return '${selected.version}'` },
      ]),
    );
    return file;
  });
  return changes;
}
it.each([false, true])(
  'blocks a dependency upgrade rejected by another installed add-on, including disabled=%s',
  async (disabled) => {
    const f = await fixture();
    await install(f, 'Library', '1.0.0');
    f.prerequisites.push({
      id: 'Library',
      displayName: 'Library',
      installed: true,
      installedVersion: '1.0.0',
      sourceUrl: 'https://github.com/fixture/mod',
    });
    await install(f, 'OldAddon', '1.0.0', [requirement('<2.0.0')]);
    if (disabled) await f.installer.toggle('OldAddon', true);
    const before = structuredClone(f.storage.state);
    const changes = await prepareUpdate(f, false);
    const error = await f.installer.installMany(changes).catch(errorReply);
    expect(error).toMatchObject({
      compatibility: [
        {
          title: 'OldAddon',
          proposedVersion: '2.0.0',
          requirement: { versionConstraint: '<2.0.0', state: 'incompatible' },
        },
      ],
    });
    expect(f.storage.state).toEqual(before);
    expect(await fs.readFile(path.join(f.mods, 'Library/main.lua'), 'utf8')).toBe("return '1.0.0'");
    await expect(fs.stat(path.join(f.mods, 'NewAddon'))).rejects.toThrow();
  },
);
it('validates the complete proposed set instead of rejecting an add-on also being updated', async () => {
  const f = await fixture();
  await install(f, 'Library', '1.0.0');
  f.prerequisites.push({
    id: 'Library',
    displayName: 'Library',
    installed: true,
    installedVersion: '1.0.0',
    sourceUrl: 'https://github.com/fixture/mod',
  });
  await install(f, 'OldAddon', '1.0.0', [requirement('<2.0.0')]);
  const changes = await prepareUpdate(f, true);
  const review = await f.installer.installMany(changes).catch(errorReply);
  expect(review).toHaveProperty('confirmation');
  await f.installer.installMany(
    changes,
    (review as ReturnType<typeof errorReply>).confirmation!.token,
  );
  expect(f.storage.state.installations).toHaveLength(3);
  expect(
    f.storage.state.installations.find((entry) => entry.modId === 'OldAddon')!.modVersion,
  ).toBe('2.0.0');
});
it('restores an undownloadable development build and its provenance after restart and scratch pruning', async () => {
  const f = await fixture();
  await install(f, 'OwnMod', '1.0.0');
  f.storage.state.installations[0]!.provenance = {
    sourceType: 'commit',
    provider: 'github',
    commitSha: 'a'.repeat(40),
    downloadUrl: `https://github.com/fixture/mod/archive/${'a'.repeat(40)}.zip`,
  };
  await f.storage.save(f.storage.state);
  await f.installer.uninstall('OwnMod');
  await f.transactions.recover();
  const saved = (await f.installer.removed.list())[0]!;
  const noDownload = vi
    .spyOn(DownloadService.prototype, 'download')
    .mockRejectedValue(new Error('No longer available'));
  const app = await applicationFixture(f);
  expect(app.storage.state.installations).toEqual([]);
  const review = await app.restoreMod(saved.id).catch(errorReply);
  expect(review).toHaveProperty('confirmation');
  await app.restoreMod(saved.id, (review as ReturnType<typeof errorReply>).confirmation!.token);
  expect(noDownload).not.toHaveBeenCalled();
  expect(app.storage.state.installations[0]!.provenance?.commitSha).toBe('a'.repeat(40));
  expect(await fs.readFile(path.join(f.mods, 'OwnMod/main.lua'), 'utf8')).toBe("return '1.0.0'");
  expect((await new InstalledModsService(app.storage, app.logger).scan([])).mods[0]!.managed).toBe(
    true,
  );
});
it.each(['copy', 'metadata'])(
  'refuses destructive uninstall if its recoverable backup %s cannot be written',
  async (failure) => {
    const f = await fixture();
    await install(f, 'OwnMod', '1.0.0');
    const before = structuredClone(f.storage.state);
    if (failure === 'copy')
      vi.spyOn(f.transactions.backup, 'capture').mockRejectedValue(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      );
    else {
      const write = f.storage.write.bind(f.storage);
      vi.spyOn(f.storage, 'write').mockImplementation((relative, value) => {
        if (relative.endsWith('/manifest.json'))
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return write(relative, value);
      });
    }
    await expect(f.installer.uninstall('OwnMod')).rejects.toThrow('Nothing was removed');
    expect(f.storage.state).toEqual(before);
    expect(await fs.readFile(path.join(f.mods, 'OwnMod/main.lua'), 'utf8')).toBe("return '1.0.0'");
  },
);
it('checks restore compatibility and backup integrity without overwriting files', async () => {
  const f = await fixture();
  await install(f, 'Addon', '1.0.0');
  await f.installer.uninstall('Addon');
  const saved = (await f.installer.removed.list())[0]!;
  saved.record.dependencies = [requirement('<2.0.0')];
  await f.storage.write(`backups/removed/${saved.id}/manifest.json`, saved);
  f.prerequisites.push({
    id: 'Library',
    displayName: 'Library',
    installed: true,
    installedVersion: '2.0.0',
    sourceUrl: 'https://github.com/fixture/mod',
  });
  await expect(f.installer.restore(saved.id)).rejects.toThrow('incompatible');
  f.prerequisites[0]!.installedVersion = '1.0.0';
  await fs.writeFile(f.storage.file(saved.copies[0]!.backupPath), 'tampered');
  await expect(f.installer.restore(saved.id)).rejects.toThrow('backup is missing or has changed');
  expect(f.storage.state.installations).toEqual([]);
});
it('keeps older provider version identity, dependencies and download together and permits only active history', async () => {
  const f = await fixture();
  const latest = thunderstorePackage({
    version: '2.0.0',
    dependencies: ['Author-Library-2.0.0'],
    website: '',
  });
  latest.versions.push(
    ...thunderstorePackage({
      version: '1.0.0',
      dependencies: ['Author-Library-1.0.0'],
      website: '',
    }).versions,
  );
  const current = normalizeThunderstore(latest)!;
  const choices = (await publishedOptions(current)).choices;
  const old = choices.find((entry) => entry.mod.version === '1.0.0')!.mod;
  expect(old.thunderstore).toMatchObject({
    packageVersion: '1.0.0',
    versionId: latest.versions[1]!.uuid4,
    dependencies: ['Author-Library-1.0.0'],
  });
  expect(old.prerequisites[0]!.versionConstraint).toBe('>=1.0.0');
  const repository = new ThunderstoreRepository(f.storage, f.logger, () => {});
  repository.catalogue = {
    mods: [current],
    stale: false,
    refreshing: false,
    fetchedAt: new Date().toISOString(),
    rejected: 0,
  };
  await expect(repository.assertAvailable(old)).resolves.toBeUndefined();
  current.versions = current.versions!.filter((entry) => entry.version !== '1.0.0');
  await expect(repository.assertAvailable(old)).rejects.toThrow('no longer active');
});
it.each([false, true])(
  'selects an older release through the application and checks its downloaded requirements (conflict=%s)',
  async (conflict) => {
    const f = await fixture();
    const latest = thunderstorePackage({
      name: 'Addon',
      version: '2.0.0',
      dependencies: ['Author-Library-2.0.0'],
      website: '',
    });
    latest.versions.push(
      ...thunderstorePackage({
        name: 'Addon',
        version: '1.0.0',
        dependencies: ['Author-Library-1.0.0'],
        website: '',
      }).versions,
    );
    const addon = normalizeThunderstore(latest)!;
    const library = normalizeThunderstore(thunderstorePackage({ name: 'Library', website: '' }))!;
    const app = await applicationFixture(f, [addon, library]);
    const options = await app.releaseOptions(addon.id);
    const selected = options.versions.find((entry) => entry.version === '1.0.0')!;
    expect(selected.compatibility).toBe('compatible');
    const download = vi
      .spyOn(DownloadService.prototype, 'download')
      .mockImplementation(async (url) => {
        expect(url).toContain('/1.0.0/');
        const item = url.includes('/Addon/') ? addon : library;
        const file = path.join(f.root, `${item.metadataId}.zip`);
        await fs.writeFile(
          file,
          zip([
            {
              name: 'manifest.json',
              data: JSON.stringify({
                name: item.thunderstore!.name,
                version_number: '1.0.0',
                dependencies: item.id === addon.id ? ['Author-Library-1.0.0'] : [],
              }),
            },
            {
              name: 'mod.json',
              data: JSON.stringify({
                id: item.metadataId,
                version: '1.0.0',
                dependencies:
                  item.id === addon.id ? [`Library (>=${conflict ? '2' : '1'}.0.0)`] : [],
              }),
            },
            { name: 'main.lua', data: 'return true' },
          ]),
        );
        return file;
      });
    const choices = [{ id: addon.id, key: selected.key }];
    const result = await app
      .action(addon.id, 'install', [], undefined, [], [], choices)
      .catch(errorReply);
    if (conflict) {
      expect(result).not.toHaveProperty('confirmation');
      expect(app.storage.state.installations).toEqual([]);
      expect(await fs.readdir(f.mods)).toEqual([]);
    } else {
      expect(result, JSON.stringify(result)).toHaveProperty('confirmation');
      await app.action(
        addon.id,
        'install',
        [],
        (result as ReturnType<typeof errorReply>).confirmation!.token,
        [],
        [],
        choices,
      );
      expect(app.storage.state.installations.map((entry) => entry.packageVersion)).toEqual([
        '1.0.0',
        '1.0.0',
      ]);
      expect(download).toHaveBeenCalledTimes(2);
    }
  },
);
it('retains published choices and development eligibility when GitHub history fails', async () => {
  const current = normalizeThunderstore(thunderstorePackage())!;
  const options = await publishedOptions(current, async () => {
    throw new Error('Rate limited');
  });
  expect(options.choices).toHaveLength(1);
  expect(options.warning).toContain('Rate limited');
  expect(developmentAvailability(current).available).toBe(true);
  expect(developmentAvailability(mod({ repositoryUrl: undefined })).reason).toContain(
    'No supported',
  );
});
it('refuses a development archive without an actual runtime version instead of trusting its commit label', async () => {
  const f = await fixture();
  const candidate = await developmentDistribution(mod(), async (url) =>
    url.includes('/commits/') ? { sha: 'a'.repeat(40) } : { default_branch: 'main' },
  );
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const file = path.join(f.root, 'unversioned.zip');
    await fs.writeFile(
      file,
      zip([
        { name: 'mod.json', data: JSON.stringify({ id: 'test-mod' }) },
        { name: 'main.lua', data: 'return true' },
      ]),
    );
    return file;
  });
  await expect(f.installer.installMany([candidate])).rejects.toThrow('no readable runtime version');
  expect(f.storage.state.installations).toEqual([]);
});
it('exposes a pinned older GitHub release, without following latest or substituting a branch', async () => {
  const current = mod({ githubRelease: {} });
  const json = vi.fn(async () => [
    {
      tag_name: 'v0.9.0',
      draft: false,
      prerelease: false,
      published_at: '2026-01-01T00:00:00Z',
      assets: [],
    },
  ]);
  const old = (await publishedOptions(current, json)).choices[0]!.mod;
  expect(old).toMatchObject({
    version: '0.9.0',
    downloadUrl: 'https://github.com/fixture/mod/archive/refs/tags/v0.9.0.zip',
    releaseSource: { releaseTag: 'v0.9.0', sourceType: 'tag' },
  });
  expect(old.githubRelease).toBeUndefined();
  expect(old.manifestUrl).toBeUndefined();
  expect(json).toHaveBeenCalledTimes(1);
});
it('selects a uniquely named project archive when a historical release also bundles a loader', async () => {
  const current = mod();
  const result = await publishedOptions(current, async () => [
    {
      tag_name: 'v0.9.0',
      draft: false,
      prerelease: false,
      published_at: '2026-01-01T00:00:00Z',
      assets: [
        {
          name: 'mod-0.9.0.zip',
          browser_download_url:
            'https://github.com/fixture/mod/releases/download/v0.9.0/mod-0.9.0.zip',
        },
        {
          name: 'loader-2.0.0.zip',
          browser_download_url:
            'https://github.com/fixture/mod/releases/download/v0.9.0/loader-2.0.0.zip',
        },
      ],
    },
  ]);
  expect(result.choices[0]!.mod.downloadUrl).toContain('/mod-0.9.0.zip');
});
it('restores a file-replacing mod and retains its original for a later uninstall', async () => {
  const f = await fixture();
  await put(path.join(f.game, 'original.lua'), 'base game');
  await put(path.join(f.stage, 'replacement.lua'), 'local replacement');
  const definition = mod({
    installation: {
      type: 'game-replacement',
      files: [{ source: 'replacement.lua', destination: 'original.lua' }],
    },
  });
  await f.installer.commitPrepared(await f.installer.plan(definition, f.stage));
  await f.installer.uninstall(definition.id);
  const saved = (await f.installer.removed.list())[0]!;
  expect(await fs.readFile(path.join(f.game, 'original.lua'), 'utf8')).toBe('base game');
  const pending = await f.installer.restore(saved.id).catch(errorReply);
  await f.installer.restore(
    saved.id,
    (pending as ReturnType<typeof errorReply>).confirmation!.token,
  );
  await f.transactions.recover();
  expect(await fs.readFile(path.join(f.game, 'original.lua'), 'utf8')).toBe('local replacement');
  for (let index = 0; index < 21; index++) {
    const id = randomUUID();
    await fs.cp(
      f.storage.file(`backups/removed/${saved.id}`),
      f.storage.file(`backups/removed/${id}`),
      { recursive: true },
    );
    const copy = JSON.parse(JSON.stringify(saved).replaceAll(saved.id, id));
    copy.removedAt = new Date(Date.now() + index * 1000).toISOString();
    await f.storage.write(`backups/removed/${id}/manifest.json`, copy);
  }
  await f.installer.removed.prune();
  expect((await f.installer.removed.list()).some((item) => item.id === saved.id)).toBe(true);
  expect(
    await fs.readFile(
      await f.transactions.backup.verified(
        saved.record.files[0]!.backupPath!,
        saved.record.files[0]!.originalHash!,
      ),
      'utf8',
    ),
  ).toBe('base game');
  await f.installer.uninstall(definition.id);
  expect(await fs.readFile(path.join(f.game, 'original.lua'), 'utf8')).toBe('base game');
});
it('keeps a development retry after a conflict, and rechecks external add-ons after they move', async () => {
  const f = await fixture();
  const library = normalizeThunderstore(thunderstorePackage({ name: 'Library' }))!;
  const app = await applicationFixture(f, [library]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/releases?per_page=100'))
        return new Response('Rate limited', { status: 403 });
      return new Response(
        JSON.stringify(
          url.includes('/commits/') ? { sha: 'a'.repeat(40) } : { default_branch: 'main' },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const file = path.join(f.root, 'development.zip');
    await fs.writeFile(
      file,
      zip([
        { name: 'mod.json', data: JSON.stringify({ id: 'Library', version: '2.0.0' }) },
        { name: 'main.lua', data: 'return 2' },
      ]),
    );
    return file;
  });
  await put(
    path.join(f.mods, 'ExternalAddon/mod.json'),
    JSON.stringify({
      id: 'ExternalAddon',
      name: 'External add-on',
      dependencies: ['Library (<2.0.0)'],
    }),
  );
  await put(path.join(f.mods, 'ExternalAddon/main.lua'), 'return 1');
  expect((await app.releaseOptions(library.id)).development.available).toBe(true);
  const failed = await app
    .action(library.id, 'install', [], undefined, [], [library.id])
    .catch(errorReply);
  expect(failed).toMatchObject({
    developmentDependency: { id: library.id },
    compatibility: [{ title: 'External add-on', proposedVersion: '2.0.0' }],
  });
  expect(app.storage.state.installations).toEqual([]);
  await fs.rename(path.join(f.mods, 'ExternalAddon'), path.join(f.root, 'MovedAddon'));
  expect((await app.releaseOptions(library.id)).development.available).toBe(true);
  const retry = await app
    .action(library.id, 'install', [], undefined, [], [library.id])
    .catch(errorReply);
  expect(retry).toHaveProperty('confirmation');
  const token = (retry as ReturnType<typeof errorReply>).confirmation!.token;
  await app.action(library.id, 'install', [], token, [], [library.id]);
  expect(app.storage.state.installations[0]).toMatchObject({
    modVersion: '2.0.0',
    provenance: { commitSha: 'a'.repeat(40), provider: 'github' },
  });
});
