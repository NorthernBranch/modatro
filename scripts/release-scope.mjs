import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const desktopFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'index.html',
  'tsconfig.json',
  'vite.config.ts',
  'LICENSE',
  'catalogue/overrides.json',
  'catalogue/revocations.json',
  'catalogue/blocked-releases.json',
  'scripts/build-electron.mjs',
  'scripts/build-version.mjs',
  'scripts/package-desktop.mjs',
  'scripts/release.mjs',
  'scripts/release-scope.mjs',
  '.github/workflows/build.yml',
]);

export function affectsDesktop(file) {
  if (/\.md$/i.test(file)) return false;
  return desktopFiles.has(file) || /^(?:src|electron|public|build)\//.test(file);
}

export function packagingScope(eventName, ref, files) {
  return (
    eventName === 'workflow_dispatch' ||
    (eventName === 'push' && ref.startsWith('refs/tags/v')) ||
    files.some(affectsDesktop)
  );
}

export async function determinePackaging(env = process.env, git = execFileSync) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  let files = [];
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' &&
    !(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF?.startsWith('refs/tags/v'))
  ) {
    const base = event.pull_request?.base.sha ?? event.before;
    const head = event.pull_request?.head.sha ?? env.GITHUB_SHA;
    if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Missing valid head commit.');
    if (base === '0'.repeat(40)) {
      // An initial push has no previous tree. Include every tracked file.
      files = git('git', ['ls-tree', '-r', '--name-only', '-z', head], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
    } else {
      if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing valid base commit.');
      const range =
        env.GITHUB_EVENT_NAME === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
      // Disabling rename detection includes both paths when a desktop file is
      // renamed into docs, or removed. Read the full diff, without API page limits.
      files = git('git', ['diff', '--name-only', '--no-renames', '-z', range], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
    }
  }
  const required = packagingScope(env.GITHUB_EVENT_NAME, env.GITHUB_REF ?? '', files);
  await appendFile(env.GITHUB_OUTPUT, `package_desktop=${required}\n`);
  console.log(
    required ? 'Desktop packaging required.' : 'Checks only: no desktop release inputs changed.',
  );
  return required;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await determinePackaging();
