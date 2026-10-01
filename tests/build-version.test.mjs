import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildVersion, stampBuildVersion } from '../scripts/build-version.mjs';
import { releaseDetails } from '../scripts/release.mjs';

it('increments main push and merge builds and preserves rerun versions', () => {
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: '42' };
  expect(buildVersion(env)).toBe('0.2.42');
  expect(buildVersion({ ...env, GITHUB_RUN_NUMBER: '43' })).toBe('0.2.43');
  expect(buildVersion({ ...env, GITHUB_RUN_ATTEMPT: '2' })).toBe('0.2.42');
  expect(buildVersion({ ...env, GITHUB_RUN_NUMBER: '65535' })).toBe('0.2.65535');
  expect(buildVersion({ ...env, GITHUB_RUN_NUMBER: '65536' })).toBe('0.3.0');
});
it.each(['', '0', '-1', '1.5', '../42', '9007199254740993'])(
  'rejects invalid run number %j',
  (number) => {
    expect(() => buildVersion({ GITHUB_RUN_NUMBER: number })).toThrow();
  },
);
it('allows an optional named version tag without editing package.json', () => {
  expect(buildVersion({ GITHUB_REF: 'refs/tags/v1.0.0-beta.1' })).toBe('1.0.0-beta.1');
  expect(() => buildVersion({ GITHUB_REF: 'refs/tags/vinvalid' })).toThrow();
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
    const version = await stampBuildVersion(file, env);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      version: '0.2.42',
      scripts: { test: 'vitest' },
    });
    expect(await stampBuildVersion(file, env)).toBe(version);
    expect(releaseDetails(version, env).assets.every((asset) => asset.includes(version))).toBe(
      true,
    );
    expect(() => releaseDetails('0.1.2', env)).toThrow('does not match');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
