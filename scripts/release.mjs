import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildVersion } from './build-version.mjs';

export function releaseDetails(version, env) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))
    throw new Error('The package version is not a supported release version.');
  if (env.GITHUB_EVENT_NAME !== 'push') throw new Error('Only push events can publish releases.');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''))
    throw new Error('A full commit SHA is required.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? ''))
    throw new Error('A valid GitHub repository is required.');
  let tag, title, prerelease;
  if (env.GITHUB_REF === 'refs/heads/main') {
    if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER ?? ''))
      throw new Error('A workflow run number is required.');
    if (version !== buildVersion(env))
      throw new Error('The app version does not match this workflow run.');
    tag = `v${version}-beta.build.${env.GITHUB_RUN_NUMBER}.${env.GITHUB_SHA.slice(0, 7)}`;
    title = `Modatro Beta ${version} · build ${env.GITHUB_RUN_NUMBER}`;
    prerelease = true;
  } else if (env.GITHUB_REF === `refs/tags/v${version}`) {
    tag = `v${version}`;
    title = `Modatro ${version}`;
    prerelease = version.split('+')[0].includes('-');
  } else throw new Error('Publish from main or a version tag matching the assigned app version.');
  return {
    tag,
    title,
    prerelease,
    sha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
    macReports: ['signing-macos-arm64.json', 'signing-macos-x64.json'],
    assets: [
      `Modatro-Setup-${version}.exe`,
      `Modatro-${version}-arm64.dmg`,
      `Modatro-${version}-x64.dmg`,
      `Modatro-${version}-x86_64.AppImage`,
      `Modatro-${version}-amd64.deb`,
    ],
  };
}

export async function publishRelease({
  version,
  env = process.env,
  directory = 'release-artifacts',
  run = (args) => spawnSync('gh', args, { encoding: 'utf8' }),
}) {
  const details = releaseDetails(version, env);
  const assets = details.assets.map((name) => path.resolve(directory, name));
  // Validate every platform build before making any GitHub mutation.
  const checksums = [];
  const hashes = new Map();
  for (const [index, file] of assets.entries()) {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0)
      throw new Error(`The installer is missing or empty: ${details.assets[index]}`);
    const hash = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    hashes.set(details.assets[index], hash);
    checksums.push(`${hash}  ${details.assets[index]}`);
  }
  const macModes = [];
  for (const [index, name] of details.macReports.entries()) {
    const file = path.resolve(directory, name);
    const data = await readFile(file);
    const report = JSON.parse(data.toString('utf8'));
    const arch = index === 0 ? 'arm64' : 'x64';
    const asset = `Modatro-${version}-${arch}.dmg`;
    if (
      report.schemaVersion !== 1 ||
      report.arch !== arch ||
      report.signatureVerified !== true ||
      !['ad-hoc', 'notarized'].includes(report.mode) ||
      report.notarized !== (report.mode === 'notarized') ||
      report.asset !== asset ||
      report.sha256 !== hashes.get(asset)
    )
      throw new Error(
        `The macOS signing report is invalid or does not match its installer: ${name}`,
      );
    macModes.push(
      `${arch}: ${report.mode === 'notarized' ? 'Developer ID signed and notarized by Apple' : 'ad-hoc signed for testing; not Apple-verified or notarized'}`,
    );
    checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
    assets.push(file);
  }
  const checksumFile = path.resolve(directory, 'SHA256SUMS.txt');
  await writeFile(checksumFile, `${checksums.join('\n')}\n`);
  assets.push(checksumFile);
  const notesFile = path.resolve(directory, 'release-notes.md');
  await writeFile(
    notesFile,
    [
      details.prerelease ? 'This is a beta release of Modatro.' : `Modatro ${version}.`,
      `Built from commit [${details.sha.slice(0, 7)}](https://github.com/${details.repository}/commit/${details.sha}) after the Windows, Apple Silicon, Intel macOS and Linux checks passed.`,
      'Choose the Windows x64 EXE, Apple Silicon arm64 DMG, Intel x64 DMG, or Linux x64 AppImage/DEB for your computer. SHA256SUMS.txt contains download checksums.',
      `macOS signing — ${macModes.join('; ')}. See the signing reports included with this release. Ad-hoc beta builds may require macOS approval before opening.`,
      'The Windows installer is currently unsigned. Linux packages do not carry a publisher signature. Modatro checks for updates at startup; choose Download update in Settings to open the installer. Updates are never downloaded automatically. Preserve your application data and backups.',
      'Modatro is an independent community project and is not affiliated with, endorsed by, or sponsored by LocalThunk or Playstack. Mod authors retain ownership of their work.',
      `[Installation instructions and release information](https://github.com/${details.repository}/blob/${details.sha}/docs/release.md).`,
    ].join('\n\n') + '\n',
  );
  const gh = (args) => run([...args, '--repo', details.repository]);
  const checked = (args) => {
    const result = gh(args);
    if (result.status !== 0)
      throw new Error(result.stderr || String(result.error ?? 'GitHub CLI failed.'));
    return result.stdout;
  };
  const existing = gh(['release', 'view', details.tag, '--json', 'isDraft,targetCommitish,assets']);
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout);
    if (!release.isDraft) {
      const names = new Set(release.assets.map((asset) => asset.name));
      if (
        ![...details.assets, ...details.macReports, 'SHA256SUMS.txt'].every((name) =>
          names.has(name),
        )
      )
        throw new Error(
          'The published release is incomplete. Published assets will not be overwritten.',
        );
      return details; // Rerunning a completed build preserves its published assets.
    }
    if (release.targetCommitish !== details.sha)
      throw new Error('The existing draft belongs to a different commit.');
    checked(['release', 'upload', details.tag, ...assets, '--clobber']);
  } else {
    checked([
      'release',
      'create',
      details.tag,
      ...assets,
      '--draft',
      '--target',
      details.sha,
      '--title',
      details.title,
      '--notes-file',
      notesFile,
    ]);
  }
  checked([
    'release',
    'edit',
    details.tag,
    '--draft=false',
    `--prerelease=${details.prerelease}`,
    `--latest=${!details.prerelease}`,
    '--title',
    details.title,
    '--notes-file',
    notesFile,
  ]);
  return details;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const details = await publishRelease({ version });
  console.log(
    `Release ready: https://github.com/${details.repository}/releases/tag/${details.tag}`,
  );
}
