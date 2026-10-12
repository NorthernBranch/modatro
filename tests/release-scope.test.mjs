import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { affectsDesktop, determinePackaging, packagingScope } from '../scripts/release-scope.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it.each([
  'README.md',
  'CONTRIBUTING.md',
  'docs/images/discover.png',
  'website/index.html',
  'website/style.css',
  'website/screenshots.mjs',
  'website/_headers',
  'website/images/discover.png',
  'tests/installer.test.ts',
  'fixtures/mod.json',
  'catalogue/README.md',
  'catalogue/mods/author/mod/meta.json',
  'electron/README.md',
  'scripts/screenshots.mjs',
  '.github/CODEOWNERS',
])('checks without packaging for %s', (file) => {
  expect(affectsDesktop(file)).toBe(false);
  expect(packagingScope('push', 'refs/heads/main', [file])).toBe(false);
});
it.each([
  'src/App.tsx',
  'src/shared/model.ts',
  'electron/main.ts',
  'public/icon.svg',
  'build/entitlements.mac.beta.plist',
  'build/version.json',
  'package.json',
  'pnpm-lock.yaml',
  'index.html',
  'tsconfig.json',
  'vite.config.ts',
  'catalogue/overrides.json',
  'catalogue/revocations.json',
  'catalogue/blocked-releases.json',
  'scripts/package-desktop.mjs',
  'scripts/build-electron.mjs',
  '.github/workflows/build.yml',
])('packages a desktop input change to %s', (file) => expect(affectsDesktop(file)).toBe(true));

it('handles mixed changes, explicit version tags and manual packaging', () => {
  expect(packagingScope('push', 'refs/heads/main', ['README.md', 'electron/main.ts'])).toBe(true);
  expect(packagingScope('pull_request', 'refs/pull/1/merge', ['docs/release.md'])).toBe(false);
  expect(packagingScope('push', 'refs/tags/v1.0.0', [])).toBe(true);
  expect(packagingScope('workflow_dispatch', 'refs/heads/main', [])).toBe(true);
});

async function fixture(event, changes = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modatro-scope-'));
  roots.push(root);
  const eventPath = path.join(root, 'event.json');
  const output = path.join(root, 'output.txt');
  await fs.writeFile(eventPath, JSON.stringify(event));
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'b'.repeat(40),
  };
  return { env, output, git: vi.fn(() => changes) };
}
it('checks every pushed commit, including removals and renames, and exposes a job output', async () => {
  const f = await fixture(
    { before: 'a'.repeat(40) },
    'README.md\0src/removed.ts\0docs/renamed.ts\0',
  );
  expect(await determinePackaging(f.env, f.git)).toBe(true);
  expect(f.git.mock.calls[0][1]).toEqual([
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    `${'a'.repeat(40)}..${'b'.repeat(40)}`,
  ]);
  expect(await fs.readFile(f.output, 'utf8')).toBe('package_desktop=true\n');
});
it('uses the PR merge base and skips packaging for documentation changes', async () => {
  const f = await fixture(
    { pull_request: { base: { sha: 'c'.repeat(40) }, head: { sha: 'd'.repeat(40) } } },
    'README.md\0',
  );
  f.env.GITHUB_EVENT_NAME = 'pull_request';
  expect(await determinePackaging(f.env, f.git)).toBe(false);
  expect(f.git.mock.calls[0][1].at(-1)).toBe(`${'c'.repeat(40)}...${'d'.repeat(40)}`);
  expect(await fs.readFile(f.output, 'utf8')).toBe('package_desktop=false\n');
});
it.each(['push', 'pull_request'])(
  'keeps a complete website-only %s change in checks-only mode',
  async (eventName) => {
    const f = await fixture(
      {
        before: 'a'.repeat(40),
        pull_request:
          eventName === 'pull_request'
            ? { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } }
            : undefined,
      },
      [
        'website/index.html',
        'website/style.css',
        'website/screenshots.mjs',
        'website/images/profiles.png',
        'docs/website.md',
        'tests/website.spec.ts',
        'tests/release-scope.test.mjs',
      ].join('\0'),
    );
    f.env.GITHUB_EVENT_NAME = eventName;
    expect(await determinePackaging(f.env, f.git)).toBe(false);
    expect(await fs.readFile(f.output, 'utf8')).toBe('package_desktop=false\n');
  },
);
it('packages an initial push from its complete tree', async () => {
  const f = await fixture({ before: '0'.repeat(40) }, 'README.md\0electron/main.ts\0');
  expect(await determinePackaging(f.env, f.git)).toBe(true);
  expect(f.git.mock.calls[0][1][0]).toBe('ls-tree');
});
it('fails a malformed event instead of guessing that a release is unnecessary', async () => {
  const f = await fixture({ before: 'main; unsafe' });
  await expect(determinePackaging(f.env, f.git)).rejects.toThrow('base commit');
  expect(f.git).not.toHaveBeenCalled();
});
