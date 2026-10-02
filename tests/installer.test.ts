import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exists, hashFile } from '../electron/services/files';
import { DownloadService } from '../electron/services/network';
import { normalizeIndexEntry } from '../electron/services/mod-index';
import { resolveDistribution } from '../electron/services/distribution';
import { mod, put, setup, zip } from './helpers';
const roots: string[] = [];
async function fixture(checkpoint?: (phase: string, index?: number) => Promise<void>) {
  const f = await setup(checkpoint);
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function standard(f: Awaited<ReturnType<typeof fixture>>, definition = mod()) {
  await put(path.join(f.stage, 'Wrapper', 'Mod', 'main.lua'), 'return "v1"');
  const plan = await f.installer.plan(definition, f.stage);
  await f.installer.commitPrepared(plan);
  return plan;
}
async function replacement(f: Awaited<ReturnType<typeof fixture>>, version = '1.0.0') {
  await put(path.join(f.stage, 'replacement.lua'), `replacement ${version}`);
  const definition = mod({
    id: 'replacement',
    title: 'Replacement',
    version,
    installation: {
      type: 'game-replacement',
      files: [{ source: 'replacement.lua', destination: 'foo.lua' }],
    },
  });
  const plan = await f.installer.plan(definition, f.stage);
  await f.installer.commitPrepared(plan);
  return plan;
}
describe('manifest-based installation and removal', () => {
  it('rejects conflicts with another planned package before confirming or writing files', async () => {
    const f = await fixture();
    const packages = ['Dependency', 'Root'].map((id) =>
      mod({ id, metadataId: id, downloadUrl: `https://github.com/fixture/mod/archive/${id}.zip` }),
    );
    vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async (url) => {
      const id = url.includes('/Dependency.zip') ? 'Dependency' : 'Root';
      const archive = path.join(f.root, `${id}.zip`);
      await fs.writeFile(
        archive,
        zip([
          {
            name: 'mod.json',
            data: JSON.stringify({
              id,
              version: '1.0.0',
              conflicts: id === 'Root' ? ['Dependency (>=1.0.0)'] : [],
            }),
          },
          { name: 'main.lua', data: 'return true' },
        ]),
      );
      return archive;
    });
    await expect(f.installer.installMany(packages)).rejects.toThrow('conflict with Dependency');
    expect(f.storage.state.installations).toEqual([]);
    expect(await fs.readdir(f.mods)).toEqual([]);
  });
  it('installs a standard mod in the separate Mods directory with hashes and a record', async () => {
    const f = await fixture();
    await standard(f);
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe(
      'return "v1"',
    );
    expect(await exists(path.join(f.game, 'test-mod'))).toBe(false);
    const record = f.storage.state.installations[0]!;
    expect(record.files[0]).toMatchObject({
      root: 'mods',
      path: 'test-mod/main.lua',
      operation: 'created',
      installedHash: await hashFile(path.join(f.mods, 'test-mod', 'main.lua')),
    });
  });
  it('uninstalls only recorded files and leaves unknown files in place', async () => {
    const f = await fixture();
    await standard(f);
    await put(path.join(f.mods, 'test-mod', 'user-notes.txt'), 'do not delete');
    const report = await f.installer.uninstall('test-mod');
    expect(report.retainedFiles).toEqual(['mods/test-mod/user-notes.txt']);
    expect(await exists(path.join(f.mods, 'test-mod', 'main.lua'))).toBe(false);
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'user-notes.txt'), 'utf8')).toBe(
      'do not delete',
    );
    expect(f.storage.state.installations).toHaveLength(0);
  });
  it('backs up an existing game file before replacement and restores it on uninstall', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    const record = f.storage.state.installations[0]!,
      file = record.files[0]!;
    expect(file.operation).toBe('replaced');
    expect(await fs.readFile(f.storage.file(file.backupPath!), 'utf8')).toBe('original');
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('replacement 1.0.0');
    await f.installer.uninstall('replacement');
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('original');
    expect(await exists(f.storage.file(file.backupPath!))).toBe(true);
  });
  it('blocks automatic overwrite of a user-modified replacement', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    await put(path.join(f.game, 'foo.lua'), 'user change');
    await expect(f.installer.uninstall('replacement')).rejects.toMatchObject({
      conflicts: [{ root: 'game', path: 'foo.lua', canRestore: true }],
    });
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('user change');
    expect(f.storage.state.installations).toHaveLength(1);
  });
  it('keeps changed files when explicitly chosen and relinquishes ownership', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    await put(path.join(f.game, 'foo.lua'), 'user change');
    await f.installer.uninstall('replacement', [{ root: 'game', path: 'foo.lua', action: 'keep' }]);
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('user change');
    expect(f.storage.state.installations).toHaveLength(0);
  });
  it('restores a changed replacement only after an explicit choice', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    await put(path.join(f.game, 'foo.lua'), 'user change');
    await f.installer.uninstall('replacement', [
      { root: 'game', path: 'foo.lua', action: 'restore' },
    ]);
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('original');
  });
  it('does not delete a changed created file automatically', async () => {
    const f = await fixture();
    await standard(f);
    await put(path.join(f.mods, 'test-mod', 'main.lua'), 'changed');
    await expect(f.installer.uninstall('test-mod')).rejects.toMatchObject({
      conflicts: [{ canRestore: false }],
    });
    await f.installer.uninstall('test-mod', [
      { root: 'mods', path: 'test-mod/main.lua', action: 'keep' },
    ]);
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe('changed');
  });
  it('blocks another managed mod from replacing an owned file', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    const second = mod({
      id: 'other',
      title: 'Other mod',
      installation: {
        type: 'game-replacement',
        files: [{ source: 'replacement.lua', destination: 'foo.lua' }],
      },
    });
    const prepared = await f.installer.plan(second, f.stage);
    expect(prepared.plan.conflicts[0]?.owner).toBe('Replacement');
    await expect(f.installer.commitPrepared(prepared)).rejects.toThrow('not eligible');
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('replacement 1.0.0');
  });
  it('blocks taking over an unmanaged folder with noncolliding files', async () => {
    const f = await fixture();
    await put(path.join(f.stage, 'main.lua'), 'new');
    await put(path.join(f.mods, 'test-mod', 'external.lua'), 'external');
    const plan = await f.installer.plan(mod(), f.stage);
    expect(plan.plan.conflicts[0]?.reason).toContain('already exists');
  });
  it('does not restore a corrupt or missing original backup', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    const file = f.storage.state.installations[0]!.files[0]!;
    await put(f.storage.file(file.backupPath!), 'tampered');
    await expect(f.installer.uninstall('replacement')).rejects.toThrow(
      'backup is missing or has changed',
    );
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('replacement 1.0.0');
  });
  it('refuses to uninstall unmanaged mods', async () => {
    const f = await fixture();
    await put(path.join(f.mods, 'external', 'main.lua'));
    await expect(f.installer.uninstall('external')).rejects.toThrow('Only Modatro-managed');
    expect(await exists(path.join(f.mods, 'external', 'main.lua'))).toBe(true);
  });
});
describe('transactional updates and disable', () => {
  it('updates a standard mod and removes obsolete recorded files', async () => {
    const f = await fixture();
    await standard(f);
    await put(path.join(f.stage, 'Wrapper', 'Mod', 'obsolete.lua'), 'old');
    await f.installer.commitPrepared(await f.installer.plan(mod({ version: '1.0.1' }), f.stage));
    await fs.unlink(path.join(f.stage, 'Wrapper', 'Mod', 'obsolete.lua'));
    await put(path.join(f.stage, 'Wrapper', 'Mod', 'main.lua'), 'return "v2"');
    await f.installer.commitPrepared(await f.installer.plan(mod({ version: '2.0.0' }), f.stage));
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe(
      'return "v2"',
    );
    expect(await exists(path.join(f.mods, 'test-mod', 'obsolete.lua'))).toBe(false);
    expect(f.storage.state.installations[0]?.modVersion).toBe('2.0.0');
  });
  it('preserves the baseline backup across replacement updates', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    const baseline = f.storage.state.installations[0]!.files[0]!.backupPath;
    await replacement(f, '2.0.0');
    expect(f.storage.state.installations[0]!.files[0]!.backupPath).toBe(baseline);
    await f.installer.uninstall('replacement');
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('original');
  });
  it('preserves the original backup when an update changes only destination casing', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    const baseline = f.storage.state.installations[0]!.files[0]!.backupPath;
    const updated = mod({
      id: 'replacement',
      title: 'Replacement',
      version: '2.0.0',
      installation: {
        type: 'game-replacement',
        files: [{ source: 'replacement.lua', destination: 'Foo.lua' }],
      },
    });
    await put(path.join(f.stage, 'replacement.lua'), 'updated');
    const prepared = await f.installer.plan(updated, f.stage);
    if (!(await exists(path.join(f.game, 'Foo.lua')))) {
      // A different physical file cannot be treated as the prior replacement.
      expect(prepared.plan.conflicts.length).toBeGreaterThan(0);
    } else {
      await f.installer.commitPrepared(prepared);
      expect(f.storage.state.installations[0]!.files[0]!.backupPath).toBe(baseline);
      await f.installer.uninstall('replacement');
      expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('original');
    }
  });
  it('rolls back every changed file if commit fails midway', async () => {
    const f = await fixture(async (phase, index) => {
      if (phase === 'changed' && index === 0) throw new Error('deliberate interruption');
    });
    await put(path.join(f.stage, 'main.lua'), 'new');
    await put(path.join(f.stage, 'other.lua'), 'new');
    const plan = await f.installer.plan(mod(), f.stage);
    await expect(f.installer.commitPrepared(plan)).rejects.toThrow('deliberate interruption');
    expect(await fs.readdir(f.mods)).toEqual([]);
    expect(f.storage.state.installations).toHaveLength(0);
  });
  it('restores the previous working replacement after a failed update', async () => {
    let fail = false;
    const f = await fixture(async (phase) => {
      if (fail && phase === 'before-state') throw new Error('state-write failure');
    });
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    fail = true;
    await expect(replacement(f, '2.0.0')).rejects.toThrow('state-write failure');
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('replacement 1.0.0');
    expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
  });
  it('blocks updates to changed files', async () => {
    const f = await fixture();
    await standard(f);
    await put(path.join(f.mods, 'test-mod', 'main.lua'), 'user change');
    const plan = await f.installer.plan(mod({ version: '2.0.0' }), f.stage);
    expect(plan.plan.conflicts[0]?.reason).toContain('changed');
    await expect(f.installer.commitPrepared(plan)).rejects.toThrow();
  });
  it('moves recorded files outside Mods when disabled and restores them on enable', async () => {
    const f = await fixture();
    await standard(f);
    await f.installer.toggle('test-mod', true);
    expect(await exists(path.join(f.mods, 'test-mod', 'main.lua'))).toBe(false);
    expect(f.storage.state.installations[0]?.disabled).toBe(true);
    expect(await fs.readFile(f.storage.file('disabled/test-mod/test-mod/main.lua'), 'utf8')).toBe(
      'return "v1"',
    );
    await f.installer.toggle('test-mod', false);
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe(
      'return "v1"',
    );
    expect(f.storage.state.installations[0]?.disabled).toBe(false);
  });
  it('blocks enabling when a destination belongs to an external mod', async () => {
    const f = await fixture();
    await standard(f);
    await f.installer.toggle('test-mod', true);
    await put(path.join(f.mods, 'test-mod', 'main.lua'), 'external');
    await expect(f.installer.toggle('test-mod', false)).rejects.toThrow(
      'destination already exists',
    );
    expect(f.storage.state.installations[0]?.disabled).toBe(true);
  });
  it('blocks a partial disable when untracked files could remain active', async () => {
    const f = await fixture();
    await standard(f);
    await put(path.join(f.mods, 'test-mod', 'lovely.toml'), '[manifest]');
    await expect(f.installer.toggle('test-mod', true)).rejects.toThrow('not recorded');
    expect(f.storage.state.installations[0]?.disabled).toBe(false);
    expect(await exists(path.join(f.mods, 'test-mod', 'main.lua'))).toBe(true);
  });
  it('blocks enabling into a noncolliding externally created folder', async () => {
    const f = await fixture();
    await standard(f);
    await f.installer.toggle('test-mod', true);
    await put(path.join(f.mods, 'test-mod', 'external.lua'), 'external');
    await expect(f.installer.toggle('test-mod', false)).rejects.toThrow('folder conflict');
    expect(f.storage.state.installations[0]?.disabled).toBe(true);
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'external.lua'), 'utf8')).toBe(
      'external',
    );
  });
  it('blocks disabling file-replacing mods', async () => {
    const f = await fixture();
    await put(path.join(f.game, 'foo.lua'), 'original');
    await replacement(f);
    await expect(f.installer.toggle('replacement', true)).rejects.toThrow(
      'cannot safely be disabled',
    );
  });
  it('adopts only metadata-identified folders and records all existing hashes', async () => {
    const f = await fixture();
    await put(
      path.join(f.mods, 'External', 'mod.json'),
      JSON.stringify({ id: 'test-mod', name: 'Test mod', version: '0.9.0' }),
    );
    await put(path.join(f.mods, 'External', 'main.lua'), 'external');
    await f.installer.adopt('External', mod());
    expect(f.storage.state.installations[0]).toMatchObject({
      adopted: true,
      modVersion: '0.9.0',
      folderName: 'External',
    });
    expect(f.storage.state.installations[0]?.files).toHaveLength(2);
  });
});
describe('full download-to-install workflow', () => {
  it('stages and installs a valid ZIP with one action', async () => {
    const f = await fixture();
    const archive = path.join(f.root, 'download.zip');
    await fs.writeFile(archive, zip([{ name: 'release-v1/MyMod/main.lua', data: 'valid' }]));
    vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
    await f.installer.install(mod());
    expect(await fs.readFile(path.join(f.mods, 'test-mod', 'main.lua'), 'utf8')).toBe('valid');
    expect(await fs.readdir(f.storage.file('staging'))).toEqual([]);
  });
  it('never installs a broken download', async () => {
    const f = await fixture();
    const archive = path.join(f.root, 'broken.zip');
    await put(archive, 'corrupt archive');
    vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
    await expect(f.installer.install(mod())).rejects.toThrow('not a valid');
    expect(await fs.readdir(f.mods)).toEqual([]);
    expect(f.storage.state.installations).toHaveLength(0);
  });
  it('checks missing prerequisites before downloading', async () => {
    const f = await fixture();
    const download = vi.spyOn(DownloadService.prototype, 'download');
    await expect(
      f.installer.install(
        mod({ prerequisites: [{ id: 'Steamodded', displayName: 'Steamodded', required: true }] }),
      ),
    ).rejects.toThrow('Steamodded is required');
    expect(download).not.toHaveBeenCalled();
  });
  it('checks additional manifest dependencies discovered after download', async () => {
    const f = await fixture();
    const archive = path.join(f.root, 'dependency.zip');
    await fs.writeFile(
      archive,
      zip([
        { name: 'Mod/main.lua', data: 'valid' },
        { name: 'Mod/mod.json', data: JSON.stringify({ id: 'Demo', dependencies: ['Talisman'] }) },
      ]),
    );
    vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
    await expect(f.installer.install(mod())).rejects.toThrow('additional requirements');
    expect(await fs.readdir(f.mods)).toEqual([]);
  });
  it('checks Lovely patch requirements discovered in the archive', async () => {
    const f = await fixture();
    const archive = path.join(f.root, 'patch.zip');
    await fs.writeFile(archive, zip([{ name: 'Mod/lovely.toml', data: '[manifest]' }]));
    vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
    await expect(f.installer.install(mod())).rejects.toThrow('Lovely is required');
    expect(await fs.readdir(f.mods)).toEqual([]);
  });
  it('does not execute a script disguised as an unsupported mod', async () => {
    const f = await fixture();
    const archive = path.join(f.root, 'script.zip');
    await fs.writeFile(archive, zip([{ name: 'install.sh', data: 'echo malicious' }]));
    vi.spyOn(DownloadService.prototype, 'download').mockResolvedValue(archive);
    await expect(f.installer.install(mod())).rejects.toThrow('could not identify');
    expect(await fs.readdir(f.mods)).toEqual([]);
  });
});

it('records the version proved by staged metadata instead of a stale catalogue version', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'return true');
  await put(
    path.join(f.stage, 'mod.json'),
    JSON.stringify({ id: 'test-mod', name: 'Test mod', version: '2.3.0' }),
  );
  const prepared = await f.installer.plan(mod({ version: '1.0.0' }), f.stage);
  expect(prepared.plan.version).toBe('2.3.0');
  await f.installer.commitPrepared(prepared);
  expect(f.storage.state.installations[0]?.modVersion).toBe('2.3.0');
});

it.each([
  { version: '20260820_090743', download: 'releases/download/Mod/mod.zip' },
  { version: 'Demo-2.3.0', download: 'archive/refs/tags/Demo-2.3.0.zip' },
  { version: 'old-label', download: 'releases/latest/download/mod.zip' },
])('installs index release $download using its loader version', async ({ version, download }) => {
  const f = await fixture();
  const indexed = normalizeIndexEntry(
    'Fixture@Mod',
    {
      title: 'Test mod',
      author: 'Fixture',
      repo: 'https://github.com/fixture/mod',
      downloadURL: `https://github.com/fixture/mod/${download}`,
      version,
    },
    'https://github.com/kasimeka/balatro-mod-index',
  );
  const resolved = await resolveDistribution(indexed, async () => ({
    tag_name: 'Demo-2.3.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    assets: [
      {
        name: 'mod.zip',
        browser_download_url: 'https://github.com/fixture/mod/releases/download/Demo-2.3.0/mod.zip',
      },
    ],
  }));
  await put(path.join(f.stage, 'main.lua'), 'return true');
  await put(path.join(f.stage, 'mod.json'), JSON.stringify({ id: 'test-mod', version: '2.3.0' }));
  const prepared = await f.installer.plan(resolved, f.stage);
  expect(prepared.mod.releaseSource).toEqual(resolved.releaseSource);
  expect(prepared.plan.version).toBe('2.3.0');
  await f.installer.commitPrepared(prepared);
  expect(f.storage.state.installations[0]?.modVersion).toBe('2.3.0');
});

it('still rejects a mismatched version for a published catalogue release', async () => {
  const f = await fixture();
  await put(path.join(f.stage, 'main.lua'), 'return true');
  await put(path.join(f.stage, 'mod.json'), JSON.stringify({ id: 'test-mod', version: '2.3.0' }));
  await expect(
    f.installer.plan(mod({ releaseSource: { sourceType: 'tag', releaseTag: 'v1.0.0' } }), f.stage),
  ).rejects.toThrow('differs from the published release');
  expect(f.storage.state.installations).toEqual([]);
  expect(await fs.readdir(f.mods)).toEqual([]);
});

it('rejects a declared missing entry point before installation', async () => {
  const f = await fixture();
  await put(
    path.join(f.stage, 'mod.json'),
    JSON.stringify({ id: 'test-mod', name: 'Test mod', main_file: 'missing.lua' }),
  );
  await expect(f.installer.plan(mod(), f.stage)).rejects.toThrow('entry-point file is missing');
  expect(await fs.readdir(f.mods)).toEqual([]);
});

it('requires the loader for a supported standalone Lua mod', async () => {
  const f = await fixture();
  await put(
    path.join(f.stage, 'mod.lua'),
    '--- STEAMODDED HEADER\n--- MOD_ID: Example\n--- MOD_NAME: Example',
  );
  const prepared = await f.installer.plan(
    mod({ installation: { type: 'single-file' } }),
    f.stage,
    true,
  );
  expect(prepared.dependencies).toContainEqual(
    expect.objectContaining({ id: 'Steamodded', state: 'missing' }),
  );
  await expect(f.installer.commitPrepared(prepared)).rejects.toThrow('not eligible');
});
