import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const baseline = JSON.parse(
  readFileSync(new URL('../build/version.json', import.meta.url), 'utf8'),
);

// The publisher restores artifacts without installing packages. Version assignment
// needs just the numeric core of valid SemVer tags;
// beta labels and build metadata do not change the next release's numeric core.
function versionParts(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

// Only published releases consume a version. Drafts and bare Git tags do not.
function apiHeaders(env) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
export function bumpFromTitle(title) {
  return /^(MAJOR|MINOR|PATCH):/i.exec(title.trimStart())?.[1].toLowerCase() ?? 'patch';
}
export async function releaseBump(env = process.env, request = fetch, event) {
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const context = event ?? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    if (typeof context.pull_request?.title !== 'string')
      throw new Error('The pull request title is missing.');
    return bumpFromTitle(context.pull_request.title);
  }
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return 'patch';
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  )
    throw new Error('A valid repository and commit are required to find the merged pull request.');
  let bump = 'patch';
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/commits/${env.GITHUB_SHA}/pulls?per_page=100&page=${page}`,
      { headers: apiHeaders(env), signal: AbortSignal.timeout(30000), redirect: 'error' },
    );
    if (!response.ok) throw new Error(`Cannot read merged pull requests: HTTP ${response.status}.`);
    const pulls = await response.json();
    if (
      !Array.isArray(pulls) ||
      pulls.some((pull) => typeof pull?.title !== 'string' || typeof pull.base?.ref !== 'string')
    )
      throw new Error('The merged pull request list is invalid.');
    for (const pull of pulls) {
      if (!pull.merged_at || pull.base.ref !== 'main' || pull.merge_commit_sha !== env.GITHUB_SHA)
        continue;
      const candidate = bumpFromTitle(pull.title);
      if (candidate === 'major' || (candidate === 'minor' && bump !== 'major')) bump = candidate;
    }
    if (pulls.length < 100) return bump;
  }
  throw new Error('The merged pull request list exceeds the supported pagination limit.');
}
export async function publishedReleaseTags(env = process.env, request = fetch) {
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) return [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? ''))
    throw new Error('A valid GitHub repository is required to read published releases.');
  const headers = apiHeaders(env);
  const tags = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases?per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(30000), redirect: 'error' },
    );
    if (!response.ok) throw new Error(`Cannot read published releases: HTTP ${response.status}.`);
    const releases = await response.json();
    if (
      !Array.isArray(releases) ||
      releases.some(
        (release) =>
          typeof release?.tag_name !== 'string' ||
          typeof release.draft !== 'boolean' ||
          (!release.draft && typeof release.published_at !== 'string'),
      )
    )
      throw new Error('The published release list is invalid.');
    tags.push(...releases.filter((release) => !release.draft).map((release) => release.tag_name));
    if (releases.length < 100) return tags;
  }
  throw new Error('The published release list exceeds the supported pagination limit.');
}
export function buildVersion(
  env = process.env,
  config = baseline,
  tags = [],
  bump = env.MODATRO_RELEASE_BUMP ?? 'patch',
) {
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) {
    const version = env.GITHUB_REF.slice('refs/tags/v'.length);
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error('The version tag is invalid.');
    return version;
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER ?? ''))
    throw new Error('A positive GitHub workflow run number is required.');
  const run = Number(env.GITHUB_RUN_NUMBER);
  const base = versionParts(config.baseVersion);
  if (!/^\d+\.\d+\.0$/.test(config.baseVersion) || !base)
    throw new Error('The automatic version baseline is invalid.');
  if (!Number.isSafeInteger(run)) throw new Error('The workflow run number is invalid.');
  if (!['major', 'minor', 'patch'].includes(bump)) throw new Error('The release bump is invalid.');
  const published = tags.flatMap((tag) => {
    const parsed = tag.startsWith('v') ? versionParts(tag.slice(1)) : null;
    if (!parsed) return [];
    const generated = /^v\d+\.\d+\.\d+-beta\.build\.([1-9]\d*)\.([a-f0-9]{7,40})$/.exec(tag);
    return [
      {
        version: parsed.join('.'),
        parts: parsed,
        run: generated?.[1],
        sha: generated?.[2],
      },
    ];
  });
  // A completed workflow rerun must keep its original version and assets.
  const sameRun = published.filter((release) => release.run === env.GITHUB_RUN_NUMBER);
  if (sameRun.length) {
    if (sameRun.length !== 1 || (env.GITHUB_SHA && !env.GITHUB_SHA.startsWith(sameRun[0].sha)))
      throw new Error('The published workflow release does not match this commit.');
    return sameRun[0].version;
  }
  const latest = published.reduce(
    (highest, release) =>
      !highest || compareVersions(release.parts, highest.parts) > 0 ? release : highest,
    null,
  );
  let next = [...base];
  if (latest) {
    next = [...latest.parts];
    const field = { major: 0, minor: 1, patch: 2 }[bump];
    next[field]++;
    for (let i = field + 1; i < 3; i++) next[i] = 0;
    if (!next.every(Number.isSafeInteger))
      throw new Error('The next version exceeds supported desktop version limits.');
    if (compareVersions(next, base) < 0) next = [...base];
  }
  let [major, minor, patch] = next;
  // Keep all platforms' numeric version fields within their supported limits.
  if (patch > 65535) {
    minor++;
    patch = 0;
  }
  if (minor > 255) {
    major++;
    minor = 0;
  }
  if (major > 255) throw new Error('The next version exceeds supported desktop version limits.');
  return `${major}.${minor}.${patch}`;
}

export async function stampBuildVersion(
  file = new URL('../package.json', import.meta.url),
  env = process.env,
  config = baseline,
  tags,
  bump = env.MODATRO_RELEASE_BUMP ?? 'patch',
) {
  const version = buildVersion(env, config, tags ?? (await publishedReleaseTags(env)), bump);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const bump = await releaseBump();
  const version = await stampBuildVersion(undefined, undefined, undefined, undefined, bump);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `release_bump=${bump}\n`);
  console.log(`Assigned Modatro version ${version} (${bump}).`);
}
