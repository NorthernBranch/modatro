import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Release versions are assigned by CI, without bot commits or manual patch bumps.
// Rolling the patch at 65536 keeps Windows file versions within their field limits.
export function buildVersion(env = process.env) {
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) {
    const version = env.GITHUB_REF.slice('refs/tags/v'.length);
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error('The version tag is invalid.');
    return version;
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER ?? ''))
    throw new Error('A positive GitHub workflow run number is required.');
  const run = Number(env.GITHUB_RUN_NUMBER);
  const minor = 2 + Math.floor(run / 65536);
  if (!Number.isSafeInteger(run) || minor > 255)
    throw new Error('The workflow run number exceeds supported desktop version limits.');
  return `0.${minor}.${run % 65536}`;
}

export async function stampBuildVersion(
  file = new URL('../package.json', import.meta.url),
  env = process.env,
) {
  const version = buildVersion(env);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(`Assigned Modatro version ${await stampBuildVersion()}`);
