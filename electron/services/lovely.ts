import * as fs from 'node:fs/promises';
import { hashFile } from './files';
import { z } from 'zod';
import { HttpsUrl, ModSchema, type ModDefinition } from '../../src/shared/model';
import { remoteJson } from './network';
import { UserError } from './errors';

export async function lovelyDistribution(
  entry?: ModDefinition,
  platform = process.platform,
  arch = process.arch,
  json = remoteJson,
): Promise<ModDefinition> {
  const assetName =
    platform === 'darwin'
      ? arch === 'arm64'
        ? 'lovely-aarch64-apple-darwin.tar.gz'
        : arch === 'x64'
          ? 'lovely-x86_64-apple-darwin.tar.gz'
          : undefined
      : ['win32', 'linux'].includes(platform)
        ? 'lovely-x86_64-pc-windows-msvc.zip'
        : undefined;
  if (!assetName)
    throw new UserError(
      'Lovely has no supported release for this platform and architecture. Open the official instructions.',
    );
  const release = z
    .object({
      tag_name: z.string().regex(/^v?\d+\.\d+\.\d+$/),
      draft: z.boolean(),
      prerelease: z.boolean(),
      assets: z.array(
        z.object({
          name: z.string(),
          browser_download_url: HttpsUrl,
          digest: z.string().nullable().optional(),
        }),
      ),
    })
    .parse(
      await json('https://api.github.com/repos/ethangreen-dev/lovely-injector/releases/latest'),
    );
  const assets = release.assets.filter((asset) => asset.name === assetName);
  const expected = `https://github.com/ethangreen-dev/lovely-injector/releases/download/${release.tag_name}/${assetName}`;
  if (
    release.draft ||
    release.prerelease ||
    assets.length !== 1 ||
    assets[0]!.browser_download_url !== expected
  )
    throw new UserError(
      'The official Lovely release could not be verified for this platform. Open the official instructions.',
    );
  return ModSchema.parse({
    ...entry,
    id: entry?.id ?? 'Lovely',
    title: 'Lovely',
    author: 'ethangreen-dev',
    metadataId: 'Lovely',
    version: release.tag_name.replace(/^v/, ''),
    repositoryUrl: 'https://github.com/ethangreen-dev/lovely-injector',
    downloadUrl: expected,
    downloadProvider: 'github',
    githubRelease: undefined,
    installer: undefined,
    source: entry?.source ?? {
      provider: 'github',
      externalId: 'Lovely',
      url: 'https://github.com/ethangreen-dev/lovely-injector',
    },
    categories: entry?.categories ?? ['Technical'],
    prerequisites: [],
    support: 'dependency-only',
    approvalStatus: entry?.approvalStatus ?? 'legacy-index',
    installation: { type: 'lovely-injector' },
    releaseSource: {
      sourceType: 'release-asset',
      releaseTag: release.tag_name,
      sha256: /^sha256:([a-f0-9]{64})$/.exec(assets[0]!.digest ?? '')?.[1],
    },
  });
}

export function nativeLibrary(bytes: Buffer, platform = process.platform) {
  const magic = bytes.subarray(0, 4).toString('hex');
  return platform === 'darwin'
    ? [
        'cffaedfe',
        'cefaedfe',
        'feedfacf',
        'feedface',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic)
    : bytes.subarray(0, 2).toString() === 'MZ';
}

export async function inspectLovelyLibrary(
  file: string,
  ownedHash?: string,
  platform = process.platform,
) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return { identified: false, owned: false };
    const bytes = Buffer.alloc(Math.min(info.size, 16 * 1024 * 1024));
    await handle.read(bytes, 0, bytes.length, 0);
    const owned = !!ownedHash && (await hashFile(file)) === ownedHash;
    return {
      identified:
        nativeLibrary(bytes, platform) && (owned || /lovely/i.test(bytes.toString('latin1'))),
      owned,
    };
  } finally {
    await handle.close();
  }
}
