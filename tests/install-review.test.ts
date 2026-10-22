import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeThunderstore } from '../src/shared/thunderstore';
import { developmentDistribution } from '../electron/services/distribution';
import { DownloadService } from '../electron/services/network';
import { errorReply } from '../electron/services/errors';
import { put, setup, thunderstorePackage, zip } from './helpers';

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.installer.cancel();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await setup();
  fixtures.push(f);
  const mods = ['Library', 'Addon'].map((name) =>
    normalizeThunderstore(thunderstorePackage({ name }))!,
  );
  const files: string[] = [];
  const download = vi
    .spyOn(DownloadService.prototype, 'download')
    .mockImplementation(async (url) => {
      const mod = mods.find((m) => m.downloadUrl === url)!;
      const file = path.join(f.root, `${randomUUID()}.zip`);
      await fs.writeFile(
        file,
        zip([
          {
            name: 'manifest.json',
            data: JSON.stringify({
              name: mod.metadataId,
              version_number: mod.thunderstore!.packageVersion,
              dependencies: [],
            }),
          },
          { name: 'mod.json', data: JSON.stringify({ id: mod.metadataId, version: mod.version }) },
          { name: 'main.lua', data: 'return true' },
        ]),
      );
      files.push(file);
      return file;
    });
  return { ...f, modsDir: f.mods, mods, files, download };
}
async function review(f: Awaited<ReturnType<typeof fixture>>, token?: string) {
  const error = await f.installer.installMany(f.mods, token).then(() => {
    throw new Error('Expected an installation review.');
  }, errorReply);
  expect(error.confirmation).toBeDefined();
  return error.confirmation!;
}
it('reuses reviewed downloads and removes them after committing', async () => {
  const f = await fixture();
  const pending = await review(f);
  expect(f.storage.state.installations).toEqual([]);
  await f.installer.installMany(f.mods, pending.token);
  expect(f.download).toHaveBeenCalledTimes(2);
  expect(f.storage.state.installations).toHaveLength(2);
  for (const file of f.files) await expect(fs.stat(file)).rejects.toThrow();
});
it('redownloads a changed cached archive rather than installing it', async () => {
  const f = await fixture();
  const pending = await review(f);
  await fs.writeFile(f.files[0]!, 'changed bytes');
  await f.installer.installMany(f.mods, pending.token);
  expect(f.download).toHaveBeenCalledTimes(3);
  expect(f.storage.state.installations).toHaveLength(2);
});
it('rechecks destination changes even when the archive is cached', async () => {
  const f = await fixture();
  const pending = await review(f);
  const changed = pending.plan.create[0]!;
  await put(path.join(f.modsDir, changed.path), 'external edit');
  await expect(f.installer.installMany(f.mods, pending.token)).rejects.toThrow('conflicts');
  expect(f.download).toHaveBeenCalledTimes(2);
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readFile(path.join(f.modsDir, changed.path), 'utf8')).toBe('external edit');
});
it('expires review tokens and requires a new confirmation', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  const pending = await review(f);
  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
  const retry = await review(f, pending.token);
  expect(retry.token).not.toBe(pending.token);
  expect(f.download).toHaveBeenCalledTimes(4);
  expect(f.storage.state.installations).toEqual([]);
});
it('pins development archives to the declared repository without inventing a runtime version', async () => {
  const f = await fixture(),
    entry = f.mods[0]!;
  const json = vi.fn(async (url: string) =>
    url.endsWith('/commits/development')
      ? { sha: 'a'.repeat(40) }
      : { default_branch: 'development' },
  );
  const selected = await developmentDistribution(entry, json);
  expect(selected.downloadUrl).toBe(`${entry.repositoryUrl}/archive/${'a'.repeat(40)}.zip`);
  expect(selected.version).toBe('Development aaaaaaa');
  expect(selected.releaseSource).toEqual({ sourceType: 'commit', commitSha: 'a'.repeat(40) });
  expect(selected.downloadProvider).toBe('github');
  expect(selected.prerequisites).toEqual([]);
  expect(json.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/author/demo',
    'https://api.github.com/repos/author/demo/commits/development',
  ]);
});
it('refuses a shared dependency update that would break an enabled installed mod', async () => {
  const f = await fixture();
  f.mods[1]!.prerequisites = [
    { id: 'Library', displayName: 'Library', required: true, versionConstraint: '<2.0.0' },
  ];
  const pending = await review(f);
  await f.installer.installMany(f.mods, pending.token);
  f.mods[0] = normalizeThunderstore(thunderstorePackage({ name: 'Library', version: '2.0.0' }))!;
  await expect(f.installer.installMany([f.mods[0]!])).rejects.toThrow('Addon: Library');
  expect(f.storage.state.installations.find((m) => m.metadataId === 'Library')!.modVersion).toBe(
    '1.0.0',
  );
});
