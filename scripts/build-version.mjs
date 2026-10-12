import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const baseline = JSON.parse(
  readFileSync(new URL('../build/version.json', import.meta.url), 'utf8'),
);

// Release versions are assigned by CI, without bot commits or manual patch bumps.
// Rolling the patch at 65536 keeps Windows file versions within their field limits.
export function repositoryTags() {
  return execFileSync('git', ['tag', '--list'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
}
export function buildVersion(env = process.env, config = baseline, tags = repositoryTags()) {
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) {
    const version = env.GITHUB_REF.slice('refs/tags/v'.length);
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error('The version tag is invalid.');
    return version;
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER ?? ''))
    throw new Error('A positive GitHub workflow run number is required.');
  const run = Number(env.GITHUB_RUN_NUMBER);
  if (
    !/^\d+\.\d+\.0$/.test(config.baseVersion) ||
    (config.firstRunNumber !== null &&
      (!Number.isSafeInteger(config.firstRunNumber) || config.firstRunNumber < 1))
  )
    throw new Error('The automatic version baseline is invalid.');
  const [major, baseMinor] = config.baseVersion.split('.').map(Number);
  // Anchor a new minor series to its first published beta, not a guessed CI
  // counter. Failed, documentation and PR runs before release keep X.Y.0.
  const pattern = new RegExp(
    `^v${config.baseVersion.replaceAll('.', '\\.')}-beta\\.build\\.([1-9]\\d*)\\.[a-f0-9]{7,40}$`,
  );
  const publishedRuns = tags
    .map((tag) => pattern.exec(tag)?.[1])
    .filter(Boolean)
    .map(Number);
  if (publishedRuns.some((value) => !Number.isSafeInteger(value)))
    throw new Error('The published version anchor is invalid.');
  const firstRun =
    config.firstRunNumber ?? (publishedRuns.length ? Math.min(...publishedRuns) : run);
  const offset = run - firstRun;
  const minor = baseMinor + Math.floor(offset / 65536);
  if (!Number.isSafeInteger(run) || offset < 0 || major > 255 || minor > 255)
    throw new Error('The workflow run number exceeds supported desktop version limits.');
  return `${major}.${minor}.${offset % 65536}`;
}

export async function stampBuildVersion(
  file = new URL('../package.json', import.meta.url),
  env = process.env,
  config = baseline,
  tags = repositoryTags(),
) {
  const version = buildVersion(env, config, tags);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(`Assigned Modatro version ${await stampBuildVersion()}`);
