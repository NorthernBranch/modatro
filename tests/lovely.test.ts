import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { lovelyDistribution } from '../electron/services/lovely';
import { extractLovelyTar } from '../electron/services/lovely-archive';
import { LovelyInstaller } from '../electron/services/strategies';
import { DownloadService } from '../electron/services/network';
import { InstalledModsService } from '../electron/services/local-mods';
import { errorReply } from '../electron/services/errors';
import { exists } from '../electron/services/files';
import { ModatroApplication } from '../electron/application';
import { GameDetectionService } from '../electron/services/detection';
import { normalizeThunderstore } from '../src/shared/thunderstore';
import { mod, put, setup, zip, thunderstorePackage, policyResponse } from './helpers';

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
const names = [
  'lovely-x86_64-pc-windows-msvc.zip',
  'lovely-aarch64-apple-darwin.tar.gz',
  'lovely-x86_64-apple-darwin.tar.gz',
];
function release() {
  return {
    tag_name: 'v0.10.0',
    draft: false,
    prerelease: false,
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/ethangreen-dev/lovely-injector/releases/download/v0.10.0/${name}`,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  };
}
it.each([
  ['win32', 'x64', names[0]],
  ['linux', 'x64', names[0]],
  ['darwin', 'arm64', names[1]],
  ['darwin', 'x64', names[2]],
] as const)('selects the official Lovely asset on %s %s', async (platform, arch, name) => {
  const result = await lovelyDistribution(undefined, platform, arch, async () => release());
  expect(result.downloadUrl).toContain(name);
  expect(result).toMatchObject({
    version: '0.10.0',
    metadataId: 'Lovely',
    installation: { type: 'lovely-injector' },
    releaseSource: { sha256: 'a'.repeat(64) },
  });
});
it('refuses unsupported architectures, missing assets, duplicates and redirected release metadata', async () => {
  await expect(
    lovelyDistribution(undefined, 'darwin', 'ia32', async () => release()),
  ).rejects.toThrow('no supported release');
  for (const invalid of [
    { ...release(), draft: true },
    { ...release(), prerelease: true },
    { ...release(), assets: [] },
    { ...release(), assets: [release().assets[0], release().assets[0]] },
    {
      ...release(),
      assets: [
        {
          ...release().assets[0],
          browser_download_url:
            'https://github.com/other/repo/releases/download/v0.10.0/library.zip',
        },
      ],
    },
  ])
    await expect(
      lovelyDistribution(undefined, 'win32', 'x64', async () => invalid),
    ).rejects.toThrow('could not be verified');
});

it.skipIf(process.platform === 'darwin').each([false, true])(
  'installs Lovely through the application action with registry discovery=%s',
  async (registry) => {
    const f = await fixture();
    vi.stubEnv('MODATRO_TEST_DATA', f.storage.root);
    const payload = zip([{ name: 'winmm.dll', data: 'MZ Lovely official fixture' }]);
    const metadata = release();
    metadata.assets[0]!.digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const policy = policyResponse(url);
        if (policy) return policy;
        expect(url).toBe(
          'https://api.github.com/repos/ethangreen-dev/lovely-injector/releases/latest',
        );
        return new Response(JSON.stringify(metadata), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const app = new ModatroApplication(
      f.storage.root,
      'test',
      'test',
      () => {},
      () => {},
    );
    await app.initialize();
    const entry = normalizeThunderstore(
      thunderstorePackage({
        namespace: 'Thunderstore',
        name: 'lovely',
        version: '0.9.0',
        website: 'https://github.com/ethangreen-dev/lovely-injector',
      }),
    )!;
    app.repository.thunderstore.catalogue = {
      mods: registry ? [entry] : [],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshing: false,
      rejected: 0,
    };
    const detection = new GameDetectionService('win32', f.root);
    vi.spyOn(app.detection, 'validate').mockImplementation((selected) =>
      detection.validate(selected),
    );
    // Treat the isolated fixture root as home for the real Unix folder-safety check.
    const folderDetection = new GameDetectionService(
      process.platform === 'win32' ? 'linux' : process.platform,
      f.root,
    );
    vi.spyOn(app.detection, 'validateMods').mockImplementation((selected, gamePath, create) =>
      folderDetection.validateMods(selected, gamePath, create),
    );
    vi.spyOn(app.launch, 'assertClosed').mockResolvedValue();
    vi.spyOn(DownloadService.prototype, 'download').mockImplementation(
      async (url, _signal, _progress, provider) => {
        expect(url).toBe(metadata.assets[0]!.browser_download_url);
        expect(provider).toBe('github');
        const archive = path.join(f.root, 'lovely.zip');
        await fs.writeFile(archive, payload);
        return archive;
      },
    );
    const first = await app.action('prerequisite:Lovely', 'install').catch(errorReply);
    expect(first).toHaveProperty('confirmation');
    expect(await exists(path.join(f.game, 'winmm.dll'))).toBe(false);
    const result = await app.action(
      'prerequisite:Lovely',
      'install',
      [],
      (first as ReturnType<typeof errorReply>).confirmation!.token,
    );
    expect(result.prerequisites.find((p) => p.id === 'Lovely')).toMatchObject({
      installed: true,
      installedVersion: '0.10.0',
    });
    expect(app.storage.state.installations[0]).toMatchObject({
      modId: registry ? entry.id : 'Lovely',
      modVersion: '0.10.0',
      metadataId: 'Lovely',
      provenance: { provider: 'github', releaseTag: 'v0.10.0' },
    });
    expect(app.storage.state.installations[0]!.packageVersion).toBeUndefined();
  },
);

function tar(entries: { name: string; data: Buffer; type?: string }[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    parts.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
it('stages official macOS tar files but plans only the library, never the launcher', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'lovely.tar.gz');
  await fs.writeFile(
    archive,
    tar([
      {
        name: 'liblovely.dylib',
        data: Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('Lovely library')]),
      },
      { name: 'run_lovely_macos.sh', data: Buffer.from('exit 99') },
    ]),
  );
  await extractLovelyTar(archive, f.stage, new AbortController().signal);
  expect(
    await new LovelyInstaller('darwin').plan({
      mod: mod({ installation: { type: 'lovely-injector' } }),
      staging: f.stage,
    }),
  ).toMatchObject([{ root: 'game', path: 'liblovely.dylib' }]);
  expect(await exists(path.join(f.game, 'liblovely.dylib'))).toBe(false);
});
it.each(['../liblovely.dylib', '/liblovely.dylib', 'unexpected.sh'])(
  'refuses unsafe macOS tar entry %s',
  async (name) => {
    const f = await fixture();
    const archive = path.join(f.root, 'lovely.tar.gz');
    await fs.writeFile(archive, tar([{ name, data: Buffer.from('Lovely') }]));
    await expect(
      extractLovelyTar(archive, f.stage, new AbortController().signal),
    ).rejects.toThrow();
    expect(await fs.readdir(f.game)).not.toContain('liblovely.dylib');
  },
);
it('refuses symlinks, duplicate libraries and corrupt tar headers', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'lovely.tar.gz');
  const entry = { name: 'liblovely.dylib', data: Buffer.from('Lovely') };
  for (const entries of [[{ ...entry, type: '2' }], [entry, entry]]) {
    await fs.writeFile(archive, tar(entries));
    await expect(
      extractLovelyTar(archive, f.stage, new AbortController().signal),
    ).rejects.toThrow();
    await fs.rm(path.join(f.stage, 'liblovely.dylib'), { force: true });
  }
  const bad = Buffer.alloc(1024);
  bad.write('liblovely.dylib');
  await fs.writeFile(archive, gzipSync(bad));
  await expect(extractLovelyTar(archive, f.stage, new AbortController().signal)).rejects.toThrow();
});

it.skipIf(process.platform === 'darwin')(
  'requires confirmation, manages an existing DLL, exposes its version, and restores the original after updates',
  async () => {
    const f = await fixture();
    const definition = mod({
      id: 'Lovely',
      metadataId: 'Lovely',
      title: 'Lovely',
      version: '0.10.0',
      downloadProvider: 'github',
      installation: { type: 'lovely-injector' },
    });
    await put(path.join(f.game, 'winmm.dll'), 'MZ Lovely external copy');
    let payload = 'MZ Lovely 0.10.0';
    vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
      const archive = path.join(f.root, 'download.zip');
      await fs.writeFile(archive, zip([{ name: 'winmm.dll', data: payload }]));
      return archive;
    });
    const first = await f.installer.install(definition).catch(errorReply);
    expect(first).toHaveProperty('confirmation');
    expect(f.storage.state.installations).toEqual([]);
    expect(await fs.readFile(path.join(f.game, 'winmm.dll'), 'utf8')).toBe(
      'MZ Lovely external copy',
    );
    await f.installer.install(
      definition,
      false,
      (first as ReturnType<typeof errorReply>).confirmation!.token,
    );
    const service = new InstalledModsService(f.storage, f.logger);
    expect(
      (await service.scan([definition])).prerequisites.find((p) => p.id === 'Lovely'),
    ).toMatchObject({ installed: true, installedVersion: '0.10.0' });
    payload = 'MZ Lovely 0.11.0';
    const next = {
      ...definition,
      version: '0.11.0',
      downloadUrl:
        'https://github.com/ethangreen-dev/lovely-injector/releases/download/v0.11.0/lovely-x86_64-pc-windows-msvc.zip',
    };
    const confirmation = await f.installer.install(next, true).catch(errorReply);
    expect(confirmation).toHaveProperty('confirmation');
    await f.installer.install(
      next,
      true,
      (confirmation as ReturnType<typeof errorReply>).confirmation!.token,
    );
    await f.installer.uninstall('Lovely');
    expect(await fs.readFile(path.join(f.game, 'winmm.dll'), 'utf8')).toBe(
      'MZ Lovely external copy',
    );
  },
);
it.skipIf(process.platform === 'darwin')(
  'blocks unmanaged legacy injector conflicts and removing a loader required by canonical registry dependencies',
  async () => {
    const f = await fixture();
    await put(path.join(f.stage, 'winmm.dll'), 'MZ Lovely new');
    await put(path.join(f.game, 'version.dll'), 'MZ Lovely old');
    const definition = mod({
      id: 'Lovely',
      metadataId: 'Lovely',
      title: 'Lovely',
      installation: { type: 'lovely-injector' },
    });
    await expect(f.installer.plan(definition, f.stage)).rejects.toThrow('Another Lovely library');
    await fs.rm(path.join(f.game, 'version.dll'));
    await f.installer.commitPrepared(await f.installer.plan(definition, f.stage));
    f.prerequisites.push({
      id: 'Lovely',
      displayName: 'Lovely',
      installed: true,
      installedVersion: definition.version,
      sourceUrl: definition.repositoryUrl!,
    });
    const dependentStage = path.join(f.root, 'dependent');
    await put(path.join(dependentStage, 'main.lua'), 'return true');
    await f.installer.commitPrepared(
      await f.installer.plan(
        mod({
          prerequisites: [
            {
              id: 'Lovely',
              displayName: 'Lovely',
              required: true,
              packageId: 'thunderstore/Thunderstore-lovely',
            },
          ],
        }),
        dependentStage,
      ),
    );
    await expect(f.installer.uninstall('Lovely')).rejects.toThrow('is required by');
  },
);
