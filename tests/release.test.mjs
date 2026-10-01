import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { publishRelease, releaseDetails } from '../scripts/release.mjs';

const version = '0.2.42';
const env = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REPOSITORY: 'tests/modatro',
  GITHUB_RUN_NUMBER: '42',
};
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-release-test-'));
  roots.push(directory);
  const details = releaseDetails(version, env);
  for (const asset of details.assets)
    await fs.writeFile(path.join(directory, asset), `fixture ${asset}`);
  for (const arch of ['arm64', 'x64']) {
    const asset = `Modatro-${version}-${arch}.dmg`;
    await fs.writeFile(
      path.join(directory, `signing-macos-${arch}.json`),
      JSON.stringify({
        schemaVersion: 1,
        arch,
        mode: 'ad-hoc',
        signatureVerified: true,
        notarized: false,
        asset,
        sha256: createHash('sha256').update(`fixture ${asset}`).digest('hex'),
      }),
    );
  }
  const run = vi.fn((args) =>
    args[1] === 'view' ? { status: 1, stderr: 'release not found' } : { status: 0, stdout: '' },
  );
  return { directory, details, run };
}

it('gives each main push a unique preview tag tied to its commit', () => {
  expect(releaseDetails(version, env)).toMatchObject({
    tag: 'v0.2.42-build.42.aaaaaaa',
    prerelease: true,
  });
  expect(releaseDetails('0.2.43', { ...env, GITHUB_RUN_NUMBER: '43' }).tag).not.toBe(
    releaseDetails(version, env).tag,
  );
  expect(releaseDetails(version, { ...env, GITHUB_SHA: 'b'.repeat(40) }).tag).not.toBe(
    releaseDetails(version, env).tag,
  );
});
it('publishes a matching version tag as a named release', () => {
  expect(releaseDetails(version, { ...env, GITHUB_REF: 'refs/tags/v0.2.42' })).toMatchObject({
    tag: 'v0.2.42',
    prerelease: false,
  });
  expect(
    releaseDetails('1.0.0-beta.1', { ...env, GITHUB_REF: 'refs/tags/v1.0.0-beta.1' }).prerelease,
  ).toBe(true);
});
it.each([
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REF: 'refs/tags/v0.2.43' },
  { GITHUB_SHA: 'main' },
  { GITHUB_REPOSITORY: '--unsafe' },
  { GITHUB_RUN_NUMBER: '../42' },
])('rejects an invalid publication context: %j', (change) => {
  expect(() => releaseDetails(version, { ...env, ...change })).toThrow();
});
it('creates a draft containing all installers and checksums before publishing', async () => {
  const f = await fixture();
  await publishRelease({ version, env, ...f });
  expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(['view', 'create', 'edit']);
  const create = f.run.mock.calls[1][0];
  expect(create).toContain('--draft');
  expect(create).toContain(env.GITHUB_SHA);
  for (const asset of [...f.details.assets, ...f.details.macReports, 'SHA256SUMS.txt'])
    expect(create).toContain(path.join(f.directory, asset));
  expect(f.run.mock.calls[2][0]).toContain('--draft=false');
  expect(f.run.mock.calls[2][0]).toContain('--prerelease=true');
  expect(f.run.mock.calls[2][0]).toContain('--latest=false');
  const checksums = await fs.readFile(path.join(f.directory, 'SHA256SUMS.txt'), 'utf8');
  const hash = createHash('sha256').update(`fixture ${f.details.assets[0]}`).digest('hex');
  expect(checksums).toContain(`${hash}  ${f.details.assets[0]}`);
  expect(await fs.readFile(path.join(f.directory, 'release-notes.md'), 'utf8')).toContain(
    env.GITHUB_SHA,
  );
});
it.each([0, 1, 2, 3, 4])(
  'does not mutate GitHub when platform installer %i is missing',
  async (index) => {
    const f = await fixture();
    await fs.unlink(path.join(f.directory, f.details.assets[index]));
    await expect(publishRelease({ version, env, ...f })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  },
);
it('does not mutate GitHub when an installer is empty', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, f.details.assets[0]), '');
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('missing or empty');
  expect(f.run).not.toHaveBeenCalled();
});
it('marks a matching stable version release as latest', async () => {
  const f = await fixture();
  await publishRelease({ version, ...f, env: { ...env, GITHUB_REF: 'refs/tags/v0.2.42' } });
  const edit = f.run.mock.calls[2][0];
  expect(edit).toContain('v0.2.42');
  expect(edit).toContain('--prerelease=false');
  expect(edit).toContain('--latest=true');
});
it('leaves the release unpublished when an installer upload fails', async () => {
  const f = await fixture();
  f.run.mockImplementation((args) =>
    args[1] === 'view'
      ? { status: 1, stderr: 'release not found' }
      : { status: 1, stderr: 'upload failed' },
  );
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('upload failed');
  expect(f.run.mock.calls.some(([args]) => args[1] === 'edit')).toBe(false);
});
it('resumes a draft after a failed upload without creating another release', async () => {
  const f = await fixture();
  f.run.mockImplementation((args) => ({
    status: 0,
    stdout:
      args[1] === 'view' ? JSON.stringify({ isDraft: true, targetCommitish: env.GITHUB_SHA }) : '',
  }));
  await publishRelease({ version, env, ...f });
  expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(['view', 'upload', 'edit']);
});
it('keeps a resumed draft unpublished when its upload fails', async () => {
  const f = await fixture();
  f.run.mockImplementation((args) =>
    args[1] === 'view'
      ? { status: 0, stdout: JSON.stringify({ isDraft: true, targetCommitish: env.GITHUB_SHA }) }
      : { status: 1, stderr: 'upload failed' },
  );
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('upload failed');
  expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(['view', 'upload']);
});
it('preserves a complete published release when a successful run is retried', async () => {
  const f = await fixture();
  f.run.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      isDraft: false,
      assets: [...f.details.assets, ...f.details.macReports, 'SHA256SUMS.txt'].map((name) => ({
        name,
      })),
    }),
  });
  await publishRelease({ version, env, ...f });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('refuses to replace a draft belonging to a different commit', async () => {
  const f = await fixture();
  f.run.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({ isDraft: true, targetCommitish: 'b'.repeat(40) }),
  });
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('different commit');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('refuses to overwrite downloads on an incomplete published release', async () => {
  const f = await fixture();
  f.run.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({ isDraft: false, assets: [{ name: f.details.assets[0] }] }),
  });
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('incomplete');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('does not publish when a macOS signing report is missing', async () => {
  const f = await fixture();
  await fs.unlink(path.join(f.directory, f.details.macReports[0]));
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it('does not publish when a verified macOS installer has changed', async () => {
  const f = await fixture();
  await fs.appendFile(path.join(f.directory, f.details.assets[1]), 'changed');
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('does not match');
  expect(f.run).not.toHaveBeenCalled();
});
it('uses actual macOS signing status in release notes', async () => {
  const f = await fixture();
  const file = path.join(f.directory, f.details.macReports[0]);
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...report, mode: 'notarized', notarized: true }));
  await publishRelease({ version, env, ...f });
  const notes = await fs.readFile(path.join(f.directory, 'release-notes.md'), 'utf8');
  expect(notes).toContain('arm64: Developer ID signed and notarized by Apple');
  expect(notes).toContain('x64: ad-hoc signed for testing');
});
it('rejects a signing report that makes contradictory notarization claims', async () => {
  const f = await fixture();
  const file = path.join(f.directory, f.details.macReports[0]);
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...report, notarized: true }));
  await expect(publishRelease({ version, env, ...f })).rejects.toThrow('invalid');
  expect(f.run).not.toHaveBeenCalled();
});
