import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, mod, zip } from './helpers';
import {
  ProfileTransferService,
  encodeProfile,
  decodeProfile,
  pinProfileArtifact,
} from '../electron/services/profile-transfer';
import { uniqueImportedName, type PortableProfile } from '../src/shared/profile-transfer';
import { ProfileService } from '../electron/services/profiles';
import { InstalledModsService } from '../electron/services/local-mods';
import { profileSummary } from '../src/shared/profile-selection';
import { resolveDependencyGraph } from '../src/shared/dependency-graph';
import type { ModDefinition, Snapshot } from '../src/shared/model';
import { DownloadService } from '../electron/services/network';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const portable = (overrides: Partial<PortableProfile> = {}): PortableProfile => ({
  format: 'modatro-profile',
  schemaVersion: 1,
  name: 'Shared run',
  mods: [],
  ...overrides,
});
async function fixture(definitions: ModDefinition[] = []) {
  const f = await setup();
  roots.push(f.root);
  f.prerequisites.push(
    {
      id: 'Steamodded',
      displayName: 'Steamodded',
      installed: true,
      installedVersion: '26.1002.0',
      sourceUrl: 'https://github.com/Steamodded/smods',
    },
    {
      id: 'Lovely',
      displayName: 'Lovely',
      installed: true,
      installedVersion: '0.10.0',
      sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
    },
  );
  const snapshot = async (): Promise<Snapshot> => {
    const scanned = await new InstalledModsService(f.storage, f.logger).scan(definitions);
    return {
      settings: f.storage.state.settings,
      catalogue: { mods: definitions, stale: false, refreshing: false, rejected: 0 },
      localMods: scanned.mods,
      prerequisites: [
        ...f.prerequisites,
        ...scanned.prerequisites.filter(
          (p) => !f.prerequisites.some((existing) => existing.id === p.id),
        ),
      ],
      candidates: [],
      validation: { valid: true, problems: [], warnings: [], detectedVersion: '1.0.1o' },
      appVersion: 'test',
      electronVersion: 'test',
      platform: 'win32',
      arch: 'x64',
      profiles: profileSummary(f.storage.state, 0),
    };
  };
  const profiles = new ProfileService(f.storage, f.installer, snapshot);
  const transfer = new ProfileTransferService(
    f.storage,
    f.installer,
    profiles,
    () => definitions,
    snapshot,
    async (roots, staged = []) =>
      resolveDependencyGraph(
        roots,
        staged.length ? staged : definitions,
        (await snapshot()).prerequisites,
      ),
  );
  async function choose(profile: PortableProfile) {
    const file = path.join(f.root, 'import.json');
    await fs.writeFile(file, encodeProfile(profile));
    return transfer.choose(file);
  }
  return { ...f, snapshot, profiles, transfer, choose };
}
it('round-trips a portable profile, detects damage and rejects extra private fields, duplicate identities and invalid versions', () => {
  const p = portable({ mods: [{ id: 'mod', title: 'Mod', version: '1.0.0', enabled: true }] });
  expect(decodeProfile(encodeProfile(p))).toEqual(p);
  expect(() => decodeProfile(encodeProfile(p).replace('Shared run', 'Changed run'))).toThrow(
    'integrity',
  );
  const data = JSON.parse(encodeProfile(p));
  data.profile.mods[0].absolutePath = '/private/user/Mods';
  expect(() => decodeProfile(JSON.stringify(data))).toThrow('supported');
  expect(() => encodeProfile({ ...p, mods: [...p.mods, ...p.mods] })).toThrow('Duplicate');
  expect(() => decodeProfile(' '.repeat(1024 * 1024 + 1))).toThrow('1 MiB');
});
it('uses case-insensitive numbered names without overwriting existing profiles and keeps the length limit', () => {
  expect(uniqueImportedName('Shared run', ['shared RUN', 'Shared run (2)'])).toBe('Shared run (3)');
  const name = 'A'.repeat(60);
  expect(uniqueImportedName(name, [name])).toHaveLength(60);
  expect(uniqueImportedName(name, [name])).toMatch(/ \(2\)$/);
});
it('rejects two portable aliases for the same catalogue installation instead of silently merging their states', async () => {
  const d = mod({ metadataId: 'Shared' }),
    f = await fixture([d]);
  const review = await f.choose(
    portable({
      mods: [
        {
          id: 'old-index/one',
          metadataId: 'Shared',
          title: 'One',
          version: '1.0.0',
          enabled: true,
        },
        {
          id: 'old-index/two',
          metadataId: 'Shared',
          title: 'Two',
          version: '1.0.0',
          enabled: false,
        },
      ],
    }),
  );
  expect(review.blockers?.join(' ')).toContain('same catalogue source');
  await expect(f.transfer.perform({ operation: 'install', token: review.token! })).rejects.toThrow(
    'same catalogue source',
  );
  expect(f.storage.state.profiles!.items).toHaveLength(1);
});
it('accepts pinned author-repository artifacts but rejects arbitrary domains and credentials', () => {
  const d = mod();
  const item = {
    id: d.id,
    title: d.title,
    version: '0.9.0',
    enabled: true,
    artifact: {
      url: 'https://github.com/fixture/mod/archive/refs/tags/0.9.0.zip',
      sha256: 'a'.repeat(64),
      sourceType: 'tag' as const,
    },
  };
  expect(pinProfileArtifact(d, item)).toMatchObject({
    version: '0.9.0',
    downloadUrl: item.artifact.url,
    releaseSource: { sha256: item.artifact.sha256 },
    githubRelease: undefined,
  });
  for (const url of [
    'https://evil.example/payload.zip',
    'https://github.com/other/repo/archive/a.zip',
    'https://github.com/fixture/mod/archive/a.zip?token=private',
    'https://user:password@github.com/fixture/mod/archive/a.zip',
  ])
    expect(() => pinProfileArtifact(d, { ...item, artifact: { ...item.artifact, url } })).toThrow(
      'catalogue repository',
    );
});
it('prompts for an export location, excludes machine paths and configurations, and safely handles cancelled pickers', async () => {
  const f = await fixture();
  let chosen: string | undefined;
  const save = vi.fn(async () => chosen);
  f.transfer.native = { save, open: async () => undefined };
  const id = f.storage.state.profiles!.activeId;
  expect((await f.transfer.perform({ operation: 'export', id })).status).toBe('cancelled');
  expect(save).toHaveBeenCalled();
  chosen = path.join(f.root, 'profile.json');
  expect((await f.transfer.perform({ operation: 'export', id })).status).toBe('exported');
  const text = await fs.readFile(chosen, 'utf8');
  expect(decodeProfile(text).name).toBe('Default');
  expect(text).not.toContain(f.root);
  expect(text).not.toMatch(/gamePath|modsPath|settings|backupPath/);
  chosen = f.storage.file('data/bad.json');
  await expect(f.transfer.perform({ operation: 'export', id })).rejects.toThrow('outside');
  expect((await f.transfer.perform({ operation: 'choose-import' })).status).toBe('cancelled');
});
it('imports as a new numbered profile with exactly the exported selection and preserves the original', async () => {
  const f = await fixture();
  const original = structuredClone(f.storage.state.profiles!);
  for (let n = 2; n <= 3; n++) {
    const review = await f.choose(portable({ name: 'Default' }));
    expect(review.name).toBe(`Default (${n})`);
    const done = await f.transfer.perform({ operation: 'install', token: review.token! });
    expect(done.status).toBe('complete');
    expect(f.storage.state.profiles!.activeId).toBe(done.profileId);
  }
  expect(f.storage.state.profiles!.items.find((p) => p.id === original.activeId)).toEqual(
    original.items[0],
  );
});
it('stages prerequisites first, confirms the complete plan, installs selected mods then preserves disabled choices', async () => {
  const dependency = mod({
      id: 'dep',
      title: 'Dependency',
      metadataId: 'Dep',
      folderName: 'Dependency',
    }),
    root = mod({
      id: 'root',
      title: 'Root mod',
      metadataId: 'Root',
      folderName: 'Root',
      prerequisites: [
        { id: 'Dep', displayName: 'Dependency', required: true, versionConstraint: '>=1.0.0' },
      ],
    });
  const f = await fixture([dependency, root]),
    original = f.storage.state.profiles!.activeId,
    order: string[] = [];
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async (url) => {
    const d = url.includes('dep') ? dependency : root;
    order.push(d.id);
    const file = path.join(f.root, `download-${order.length}.zip`);
    await fs.writeFile(
      file,
      zip([
        {
          name: 'mod.json',
          data: JSON.stringify({
            id: d.metadataId,
            name: d.title,
            author: ['Author'],
            version: '1.0.0',
            main_file: 'main.lua',
          }),
        },
        { name: 'main.lua', data: 'return {}' },
      ]),
    );
    return file;
  });
  // Give each archive an unambiguous URL; no source is read from the shared file.
  dependency.downloadUrl = 'https://github.com/fixture/mod/archive/dep.zip';
  root.downloadUrl = 'https://github.com/fixture/mod/archive/root.zip';
  const review = await f.choose(
    portable({
      mods: [
        { id: 'root', metadataId: 'Root', title: 'Root mod', version: '1.0.0', enabled: false },
      ],
    }),
  );
  const prepared = await f.transfer.perform({ operation: 'install', token: review.token! });
  expect(prepared.status).toBe('review');
  expect(prepared.confirmation?.plan.packages?.map((p) => p.id)).toEqual(['dep', 'root']);
  expect(f.storage.state.installations).toHaveLength(0);
  const done = await f.transfer.perform({
    operation: 'install',
    token: review.token!,
    confirmationToken: prepared.confirmation!.token,
  });
  expect(done.status).toBe('complete');
  expect(order).toEqual(['dep', 'root', 'dep', 'root']);
  expect(f.storage.state.installations.find((r) => r.modId === 'root')?.disabled).toBe(true);
  expect(f.storage.state.installations.find((r) => r.modId === 'dep')?.disabled).toBe(false);
  const old = f.storage.state.profiles!.items.find((p) => p.id === original)!;
  expect(old.selection).toEqual([
    { id: 'dep', enabled: false },
    { id: 'root', enabled: false },
  ]);
  expect((await f.snapshot()).profiles?.unsaved).toBe(false);
});
it('cancelling a staged multi-mod import restores the original active profile without installing anything', async () => {
  const defs = [
      mod({
        id: 'one',
        metadataId: 'One',
        folderName: 'One',
        downloadUrl: 'https://github.com/fixture/mod/archive/one.zip',
      }),
      mod({
        id: 'two',
        metadataId: 'Two',
        folderName: 'Two',
        downloadUrl: 'https://github.com/fixture/mod/archive/two.zip',
      }),
    ],
    f = await fixture(defs),
    original = structuredClone(f.storage.state.profiles!);
  let index = 0;
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const d = defs[index++ % 2]!,
      file = path.join(f.root, 'download.zip');
    await fs.writeFile(
      file,
      zip([
        {
          name: 'main.lua',
          data: `--- STEAMODDED HEADER\n--- MOD_ID: ${d.metadataId}\n--- MOD_NAME: ${d.title}\n--- MOD_AUTHOR: [Author]\n--- MOD_DESCRIPTION: Test\n--- VERSION: 1.0.0\nreturn {}`,
        },
      ]),
    );
    return file;
  });
  const review = await f.choose(
    portable({
      mods: defs.map((d) => ({ id: d.id, title: d.title, version: d.version, enabled: true })),
    }),
  );
  const prepared = await f.transfer.perform({ operation: 'install', token: review.token! });
  expect(prepared.confirmation).toBeDefined();
  await f.transfer.perform({ operation: 'cancel', token: review.token! });
  expect(f.storage.state.profiles).toEqual(original);
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});
it('cancel restores an existing managed selection and its verified files after temporarily preparing another profile', async () => {
  const defs = [
    mod({
      id: 'one',
      metadataId: 'One',
      folderName: 'One',
      downloadUrl: 'https://github.com/fixture/mod/archive/one.zip',
    }),
    mod({
      id: 'two',
      metadataId: 'Two',
      folderName: 'Two',
      downloadUrl: 'https://github.com/fixture/mod/archive/two.zip',
    }),
  ];
  const f = await fixture(defs),
    stage = path.join(f.root, 'old-stage');
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'main.lua'), '-- original user mod\nreturn {}');
  await f.installer.commitPrepared(
    await f.installer.plan(
      mod({ id: 'existing', title: 'Existing mod', folderName: 'Existing' }),
      stage,
    ),
  );
  const original = structuredClone(f.storage.state.profiles!);
  const before = await fs.readFile(path.join(f.mods, 'Existing', 'main.lua'), 'utf8');
  let index = 0;
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const d = defs[index++ % 2]!,
      file = path.join(f.root, 'import-download.zip');
    await fs.writeFile(
      file,
      zip([
        {
          name: 'main.lua',
          data: `--- STEAMODDED HEADER\n--- MOD_ID: ${d.metadataId}\n--- MOD_NAME: ${d.title}\n--- MOD_AUTHOR: [Author]\n--- MOD_DESCRIPTION: Test\n--- VERSION: 1.0.0\nreturn {}`,
        },
      ]),
    );
    return file;
  });
  const review = await f.choose(
    portable({
      mods: defs.map((d) => ({ id: d.id, title: d.title, version: d.version, enabled: true })),
    }),
  );
  const prepared = await f.transfer.perform({ operation: 'install', token: review.token! });
  expect(prepared.confirmation).toBeDefined();
  expect(f.storage.state.installations[0]?.disabled).toBe(true);
  await f.transfer.perform({ operation: 'cancel', token: review.token! });
  expect(f.storage.state.profiles).toEqual(original);
  expect(f.storage.state.installations[0]?.disabled).toBe(false);
  expect(await fs.readFile(path.join(f.mods, 'Existing', 'main.lua'), 'utf8')).toBe(before);
  expect((await f.transfer.perform({ operation: 'cancel', token: review.token! })).status).toBe(
    'cancelled',
  );
});
it('rejects unknown sources, version substitution, stale previews and damaged downloads without leaving an import profile', async () => {
  const d = mod(),
    f = await fixture([d]),
    original = structuredClone(f.storage.state.profiles!);
  let review = await f.choose(
    portable({
      mods: [{ id: 'missing', title: 'Private local mod', version: '1.0.0', enabled: true }],
    }),
  );
  expect(review.blockers?.[0]).toContain('no downloadable');
  await expect(f.transfer.perform({ operation: 'install', token: review.token! })).rejects.toThrow(
    'no downloadable',
  );
  expect(f.storage.state.profiles).toEqual(original);
  review = await f.choose(
    portable({ mods: [{ id: d.id, title: d.title, version: '0.1.0', enabled: true }] }),
  );
  expect(review.blockers?.[0]).toContain('unavailable');
  review = await f.choose(
    portable({ mods: [{ id: d.id, title: d.title, version: d.version, enabled: true }] }),
  );
  await f.profiles.operation({ operation: 'rename', id: original.activeId, name: 'Changed' });
  await expect(f.transfer.perform({ operation: 'install', token: review.token! })).rejects.toThrow(
    'changed or expired',
  );
  review = await f.choose(
    portable({ mods: [{ id: d.id, title: d.title, version: d.version, enabled: true }] }),
  );
  vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    const file = path.join(f.root, 'bad.zip');
    await fs.writeFile(file, 'invalid archive');
    return file;
  });
  await expect(
    f.transfer.perform({ operation: 'install', token: review.token! }),
  ).rejects.toThrow();
  expect(f.storage.state.profiles!.items).toHaveLength(1);
  expect(f.storage.state.profiles!.activeId).toBe(original.activeId);
  expect(f.storage.state.installations).toEqual([]);
});
