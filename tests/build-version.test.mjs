import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  buildVersion,
  bumpFromTitle,
  publishedReleaseTags,
  releaseBump,
  stampBuildVersion,
} from '../scripts/build-version.mjs';
import { releaseDetails } from '../scripts/release.mjs';
const current = { baseVersion: '0.4.0' };
const versionFor = (env) => buildVersion(env, current, []);

it('starts a new minor at zero regardless of earlier PR, failed or documentation runs', () => {
  const oldTags = ['v0.3.9-beta.build.20.aaaaaaa'];
  for (const run of ['23', '42', '100']) {
    expect(buildVersion({ GITHUB_RUN_NUMBER: run }, current, oldTags)).toBe('0.4.0');
  }
});
it('increments published versions once regardless of workflow gaps and preserves reruns', () => {
  const tags = ['v0.4.0-beta.build.42.aaaaaaa', 'v0.4.3-beta.build.45.bbbbbbb'];
  expect(buildVersion({ GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2' }, current, tags)).toBe(
    '0.4.0',
  );
  expect(buildVersion({ GITHUB_RUN_NUMBER: '45', GITHUB_RUN_ATTEMPT: '2' }, current, tags)).toBe(
    '0.4.3',
  );
  expect(buildVersion({ GITHUB_RUN_NUMBER: '46' }, current, tags)).toBe('0.4.4');
  expect(buildVersion({ GITHUB_RUN_NUMBER: '65578' }, current, tags)).toBe('0.4.4');
  expect(
    buildVersion({ GITHUB_RUN_NUMBER: '46' }, current, [...tags, 'v0.4.4-beta.build.46.ccccccc']),
  ).toBe('0.4.4');
  expect(
    buildVersion({ GITHUB_RUN_NUMBER: '100000' }, current, [
      ...tags,
      'v0.4.4-beta.build.46.ccccccc',
    ]),
  ).toBe('0.4.5');
});
it('rejects mismatched reruns and invalid baselines', () => {
  expect(() =>
    buildVersion({ GITHUB_RUN_NUMBER: '42', GITHUB_SHA: 'b'.repeat(40) }, current, [
      'v0.4.0-beta.build.42.aaaaaaa',
    ]),
  ).toThrow('commit');
  expect(() =>
    buildVersion({ GITHUB_RUN_NUMBER: '42' }, { baseVersion: '0.4.1', firstRunNumber: null }, []),
  ).toThrow('baseline');
});
it('uses semantic ordering, respects deliberate minor bumps and never downgrades a named release', () => {
  const env = { GITHUB_RUN_NUMBER: '42' };
  const tags = ['v0.4.10-beta.build.30.aaaaaaa', 'v0.4.9-beta.build.40.bbbbbbb', 'unrelated-tag'];
  expect(buildVersion(env, current, tags)).toBe('0.4.11');
  expect(buildVersion(env, { baseVersion: '0.5.0' }, tags)).toBe('0.5.0');
  expect(buildVersion(env, current, [...tags, 'v1.0.0'])).toBe('1.0.1');
  expect(buildVersion(env, current, ['v0.4.65535-beta.build.40.aaaaaaa'])).toBe('0.5.0');
  expect(buildVersion(env, current, ['v0.255.65535-beta.build.40.aaaaaaa'])).toBe('1.0.0');
  expect(() => buildVersion(env, current, ['v255.255.65535-beta.build.40.aaaaaaa'])).toThrow(
    'limits',
  );
});
it.each(['', '0', '-1', '1.5', '../42', '9007199254740993'])(
  'rejects invalid run number %j',
  (number) => {
    expect(() => versionFor({ GITHUB_RUN_NUMBER: number })).toThrow();
  },
);
it('allows an optional named version tag without editing package.json', () => {
  expect(versionFor({ GITHUB_REF: 'refs/tags/v1.0.0-beta.1' })).toBe('1.0.0-beta.1');
  expect(() => versionFor({ GITHUB_REF: 'refs/tags/vinvalid' })).toThrow();
});

it.each([
  ['MAJOR: new format', '0.4.3', '1.0.0'],
  ['MAJOR: new format', '1.8.2', '2.0.0'],
  ['MINOR: new feature', '0.4.3', '0.5.0'],
  ['PATCH: fix', '0.4.3', '0.4.4'],
  ['fix the overview', '0.4.3', '0.4.4'],
  ['  minor: new feature', '0.4.3', '0.5.0'],
  ['Add MAJOR: text later in the title', '0.4.3', '0.4.4'],
])('uses PR title %j to advance %s to %s', (title, previous, next) => {
  expect(
    buildVersion({ GITHUB_RUN_NUMBER: '100' }, current, [`v${previous}`], bumpFromTitle(title)),
  ).toBe(next);
});

it('reads PR event titles without a GitHub request', async () => {
  const request = vi.fn();
  expect(
    await releaseBump({ GITHUB_EVENT_NAME: 'pull_request' }, request, {
      pull_request: { title: 'MINOR: new feature' },
    }),
  ).toBe('minor');
  expect(request).not.toHaveBeenCalled();
});

it('uses only merged PRs that introduced this main commit, with the strongest prefix winning', async () => {
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'tests/modatro',
    GITHUB_SHA: 'a'.repeat(40),
    GH_TOKEN: 'fixture-token',
  };
  const pull = (title, changes = {}) => ({
    title,
    base: { ref: 'main' },
    merged_at: '2026-10-13T00:00:00Z',
    merge_commit_sha: env.GITHUB_SHA,
    ...changes,
  });
  const request = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [
      pull('PATCH: fix'),
      pull('MINOR: feature'),
      pull('MAJOR: unrelated', { merge_commit_sha: 'b'.repeat(40) }),
      pull('MAJOR: still open', { merged_at: null }),
      pull('MAJOR: other branch', { base: { ref: 'other' } }),
    ],
  });
  expect(await releaseBump(env, request)).toBe('minor');
  expect(request.mock.calls[0][0]).toContain(`/commits/${env.GITHUB_SHA}/pulls?`);
  expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');
  request.mockResolvedValue({
    ok: true,
    json: async () => [pull('MINOR: feature'), pull('MAJOR: format')],
  });
  expect(await releaseBump(env, request)).toBe('major');
  request.mockResolvedValue({ ok: true, json: async () => [] });
  expect(await releaseBump(env, request)).toBe('patch');
  request.mockResolvedValue({ ok: false, status: 403 });
  await expect(releaseBump(env, request)).rejects.toThrow('HTTP 403');
});

it('keeps the assigned bump consistent when publishing and retains completed rerun versions', () => {
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'tests/modatro',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_NUMBER: '100',
    MODATRO_RELEASE_BUMP: 'minor',
  };
  const tags = ['v0.4.3-beta.build.30.bbbbbbb'];
  expect(buildVersion(env, current, tags)).toBe('0.5.0');
  expect(releaseDetails('0.5.0', env, tags).assets.every((asset) => asset.includes('0.5.0'))).toBe(
    true,
  );
  expect(() => releaseDetails('0.4.4', env, tags)).toThrow('does not match');
  expect(
    buildVersion({ ...env, MODATRO_RELEASE_BUMP: 'major' }, current, [
      ...tags,
      'v0.5.0-beta.build.100.aaaaaaa',
    ]),
  ).toBe('0.5.0');
});

it('reads all release pages with CI authentication and excludes unpublished drafts', async () => {
  const release = (index) => ({
    tag_name: `v0.4.${index}`,
    draft: false,
    published_at: '2026-10-13T00:00:00Z',
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => Array.from({ length: 100 }, (_, index) => release(index)),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [release(100), { tag_name: 'v9.0.0', draft: true, published_at: null }],
    });
  const tags = await publishedReleaseTags(
    { GITHUB_REPOSITORY: 'tests/modatro', GH_TOKEN: 'fixture-token' },
    request,
  );
  expect(tags).toHaveLength(101);
  expect(tags).not.toContain('v9.0.0');
  expect(buildVersion({ GITHUB_RUN_NUMBER: '200' }, current, tags)).toBe('0.4.101');
  expect(request.mock.calls[0][0]).toBe(
    'https://api.github.com/repos/tests/modatro/releases?per_page=100&page=1',
  );
  expect(request.mock.calls[1][0]).toContain('page=2');
  expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');
});

it('stops version assignment when release history is unavailable or malformed', async () => {
  const env = { GITHUB_REPOSITORY: 'tests/modatro' };
  await expect(publishedReleaseTags(env, async () => ({ ok: false, status: 403 }))).rejects.toThrow(
    'HTTP 403',
  );
  await expect(
    publishedReleaseTags(env, async () => ({
      ok: true,
      json: async () => ({ message: 'invalid' }),
    })),
  ).rejects.toThrow('invalid');
  await expect(
    publishedReleaseTags(env, async () => ({
      ok: true,
      json: async () => [{ tag_name: 'v0.4.3' }],
    })),
  ).rejects.toThrow('invalid');
  const request = vi.fn();
  expect(await publishedReleaseTags({ GITHUB_REF: 'refs/tags/v1.0.0' }, request)).toEqual([]);
  expect(request).not.toHaveBeenCalled();
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
