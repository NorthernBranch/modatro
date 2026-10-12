import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildVersion, stampBuildVersion } from '../scripts/build-version.mjs';
import { releaseDetails } from '../scripts/release.mjs';
const legacy = { baseVersion: '0.3.0', firstRunNumber: 11 };
const current = { baseVersion: '0.4.0', firstRunNumber: null };
const legacyVersion = (env) => buildVersion(env, legacy, []);

it('starts a new minor at zero regardless of earlier PR, failed or documentation runs', () => {
  const oldTags = ['v0.3.9-beta.build.20.aaaaaaa', 'v0.4.1-beta.build.21.bbbbbbb'];
  for (const run of ['23', '42', '100']) {
    expect(buildVersion({ GITHUB_RUN_NUMBER: run }, current, oldTags)).toBe('0.4.0');
  }
});
it('uses the first published beta to increment patches and preserve reruns', () => {
  const tags = ['v0.4.0-beta.build.42.aaaaaaa', 'v0.4.0-beta.build.45.bbbbbbb'];
  expect(buildVersion({ GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2' }, current, tags)).toBe(
    '0.4.0',
  );
  expect(buildVersion({ GITHUB_RUN_NUMBER: '43' }, current, tags)).toBe('0.4.1');
  expect(buildVersion({ GITHUB_RUN_NUMBER: '46' }, current, tags)).toBe('0.4.4');
  expect(buildVersion({ GITHUB_RUN_NUMBER: '65578' }, current, tags)).toBe('0.5.0');
  expect(() => buildVersion({ GITHUB_RUN_NUMBER: '41' }, current, tags)).toThrow();
});
it('rejects unsafe published anchors and invalid baselines', () => {
  expect(() =>
    buildVersion({ GITHUB_RUN_NUMBER: '42' }, current, [
      'v0.4.0-beta.build.9007199254740993.aaaaaaa',
    ]),
  ).toThrow('anchor');
  expect(() =>
    buildVersion({ GITHUB_RUN_NUMBER: '42' }, { baseVersion: '0.4.1', firstRunNumber: null }, []),
  ).toThrow('baseline');
});
it('increments main push and merge builds and preserves rerun versions', () => {
  expect(legacyVersion({ GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '11' })).toBe('0.3.0');
  expect(legacyVersion({ GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '12' })).toBe('0.3.1');
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '42' };
  expect(legacyVersion(env)).toBe('0.3.31');
  expect(legacyVersion({ ...env, GITHUB_RUN_NUMBER: '43' })).toBe('0.3.32');
  expect(legacyVersion({ ...env, GITHUB_RUN_ATTEMPT: '2' })).toBe('0.3.31');
  expect(legacyVersion({ ...env, GITHUB_RUN_NUMBER: '65535' })).toBe('0.3.65524');
  expect(legacyVersion({ ...env, GITHUB_RUN_NUMBER: '65536' })).toBe('0.3.65525');
  expect(legacyVersion({ ...env, GITHUB_RUN_NUMBER: '65547' })).toBe('0.4.0');
});
it.each(['', '0', '10', '-1', '1.5', '../42', '9007199254740993'])(
  'rejects invalid run number %j',
  (number) => {
    expect(() => legacyVersion({ GITHUB_RUN_NUMBER: number })).toThrow();
  },
);
it('allows an optional named version tag without editing package.json', () => {
  expect(legacyVersion({ GITHUB_REF: 'refs/tags/v1.0.0-beta.1' })).toBe('1.0.0-beta.1');
  expect(() => legacyVersion({ GITHUB_REF: 'refs/tags/vinvalid' })).toThrow();
});
it('stamps the same version into every platform and publishing checkout', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-version-test-'));
  try {
    const file = path.join(directory, 'package.json');
    await fs.writeFile(
      file,
      JSON.stringify({ name: 'modatro', version: '0.1.2', scripts: { test: 'vitest' } }),
    );
    const env = {
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_NUMBER: '42',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REPOSITORY: 'tests/modatro',
    };
    const version = await stampBuildVersion(file, env, current, []);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      version: '0.4.0',
      scripts: { test: 'vitest' },
    });
    expect(await stampBuildVersion(file, env, current, [])).toBe(version);
    expect(releaseDetails(version, env, [])).toMatchObject({
      tag: 'v0.4.0-beta.build.42.aaaaaaa',
      title: 'Modatro Beta 0.4.0 · build 42',
      prerelease: true,
    });
    expect(releaseDetails(version, env, []).assets.every((asset) => asset.includes(version))).toBe(
      true,
    );
    expect(() => releaseDetails('0.1.2', env, [])).toThrow('does not match');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
