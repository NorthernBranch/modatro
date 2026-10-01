import { z } from 'zod';
import type { ModDefinition } from '../../src/shared/model';
import { AuthorManifestSchema } from '../../src/shared/catalogue-schema';
import { sourceType, sameRepository } from '../../src/shared/trust';
import { ModSchema } from '../../src/shared/model';
import { dependencyId } from './metadata';
import { UserError } from './errors';
import { remoteJson, validateRemoteUrl } from './network';

export function repositoryPath(url?: string): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  return u.hostname === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname)
    ? u.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '')
    : undefined;
}
export function validateDistribution(mod: ModDefinition) {
  const url = validateRemoteUrl(mod.downloadUrl);
  const detected = sourceType(mod.downloadUrl);
  if (mod.releaseSource && detected !== 'other' && mod.releaseSource.sourceType !== detected)
    throw new UserError(
      'The declared release source type does not match its download URL. Automatic installation is blocked.',
    );
  const repo = repositoryPath(mod.repositoryUrl);
  const path = url.pathname.replace(/^\//, '').toLowerCase();
  const ownSource =
    repo &&
    path.startsWith(`${repo.toLowerCase()}/`) &&
    ['github.com', 'raw.githubusercontent.com', 'codeload.github.com'].includes(url.hostname);
  if (!ownSource && !mod.distributionApproved)
    throw new UserError(
      'The download is not from the declared author repository or an explicitly approved distribution source. Open the project for instructions.',
    );
  if (url.hostname === 'github.com' && !/\/(?:archive|releases\/download|raw)\//.test(url.pathname))
    throw new UserError(
      'This source is a project page, not a supported download. Open the project for instructions.',
    );
}
export async function readAuthorManifest(
  entry: ModDefinition,
  json = remoteJson,
): Promise<ModDefinition> {
  if (!entry.manifestUrl) return entry;
  const url = validateRemoteUrl(entry.manifestUrl);
  const repo = repositoryPath(entry.repositoryUrl);
  if (
    !repo ||
    url.hostname !== 'raw.githubusercontent.com' ||
    !url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/`)
  )
    throw new UserError('The author manifest must be hosted in its declared source repository.');
  const manifest = AuthorManifestSchema.parse(await json(entry.manifestUrl));
  if (manifest.id !== entry.id && manifest.id !== entry.metadataId)
    throw new UserError('The author manifest identity does not match the index.');
  if (!sameRepository(manifest.distribution.repository, entry.repositoryUrl))
    throw new UserError('The manifest changes the indexed repository. Review is required.');
  const installation = manifest.installation;
  const definition = ModSchema.parse({
    ...entry,
    title: manifest.name,
    author: manifest.author,
    version: manifest.version,
    permissions: Object.fromEntries(
      ['display', 'install', 'update'].map((key) => [
        key,
        manifest.permissions[key as keyof typeof manifest.permissions] &&
          entry.permissions?.[key as keyof typeof manifest.permissions] !== false,
      ]),
    ),
    downloadUrl: manifest.distribution.releaseUrl,
    releaseSource: {
      ...manifest.distribution,
      sourceType: manifest.distribution.sourceType ?? sourceType(manifest.distribution.releaseUrl),
    },
    description: manifest.description,
    descriptionProvenance: 'author-supplied',
    licence: manifest.licence,
    iconUrl: manifest.iconUsageApproved ? manifest.iconUrl : undefined,
    iconUsageApproved: manifest.iconUsageApproved,
    prerequisites: [
      ...entry.prerequisites,
      ...Object.entries(manifest.requirements).map(([id, versionConstraint]) => ({
        id: dependencyId(id),
        displayName: id,
        versionConstraint,
        required: true,
      })),
    ],
    folderName: 'folder' in installation ? installation.folder : entry.folderName,
    installation:
      installation.type === 'mods-directory'
        ? { type: 'standard', sourceRoot: installation.sourceRoot }
        : installation.type === 'manual-install-required'
          ? { type: 'unsupported', instructions: installation.instructions }
          : installation,
  });
  validateDistribution(definition);
  return definition;
}
export async function resolveDistribution(
  entry: ModDefinition,
  json = remoteJson,
): Promise<ModDefinition> {
  let mod = await readAuthorManifest(entry, json);
  validateDistribution(mod);
  const type = mod.releaseSource?.sourceType ?? sourceType(mod.downloadUrl);
  if (type !== 'branch')
    return ModSchema.parse({ ...mod, releaseSource: { ...mod.releaseSource, sourceType: type } });
  const repo = repositoryPath(mod.repositoryUrl);
  if (!repo) return mod;
  // Ask for a matching published version, never substitute a different release silently.
  const releases = z.object({
    tag_name: z.string(),
    assets: z.array(
      z.object({
        name: z.string(),
        browser_download_url: z.string(),
        digest: z.string().nullable().optional(),
      }),
    ),
    draft: z.boolean().optional(),
  });
  for (const tag of [`v${mod.version}`, mod.version]) {
    try {
      const release = releases.parse(
        await json(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`),
      );
      if (release.draft || release.tag_name.replace(/^v/, '') !== mod.version.replace(/^v/, ''))
        continue;
      const assets = release.assets.filter((asset) => /\.zip$/i.test(asset.name));
      mod = ModSchema.parse({
        ...mod,
        downloadUrl:
          assets.length === 1
            ? assets[0]!.browser_download_url
            : `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(release.tag_name)}.zip`,
        releaseSource: {
          sourceType: assets.length === 1 ? 'release-asset' : 'tag',
          releaseTag: release.tag_name,
          sha256:
            assets.length === 1
              ? /^sha256:([a-f0-9]{64})$/.exec(assets[0]!.digest ?? '')?.[1]
              : undefined,
        },
      });
      validateDistribution(mod);
      return mod;
    } catch (error) {
      if (!(error instanceof UserError && error.statusCode === 404)) throw error;
    }
  }
  for (const tag of [`v${mod.version}`, mod.version]) {
    try {
      const reference = z
        .object({
          ref: z.string(),
          object: z.object({
            sha: z.string().regex(/^[a-f0-9]{40}$/),
            type: z.enum(['commit', 'tag']),
          }),
        })
        .parse(
          await json(
            `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
          ),
        );
      if (reference.ref !== `refs/tags/${tag}`)
        throw new UserError('The upstream tag identity could not be verified.');
      return ModSchema.parse({
        ...mod,
        downloadUrl: `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.zip`,
        releaseSource: {
          sourceType: 'tag',
          releaseTag: tag,
          commitSha: reference.object.type === 'commit' ? reference.object.sha : undefined,
        },
      });
    } catch (error) {
      if (!(error instanceof UserError && error.statusCode === 404)) throw error;
    }
  }
  // Pin an archive branch to the commit currently published by the author.
  const url = new URL(mod.downloadUrl);
  if (url.hostname === 'github.com' && url.pathname.includes('/archive/')) {
    const ref = decodeURIComponent(
      url.pathname
        .split('/archive/')[1]!
        .replace(/^refs\/heads\//, '')
        .replace(/\.zip$/, ''),
    );
    const commit = z
      .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
      .parse(await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`));
    return ModSchema.parse({
      ...mod,
      downloadUrl: `https://github.com/${repo}/archive/${commit.sha}.zip`,
      releaseSource: { sourceType: 'commit', commitSha: commit.sha },
    });
  }
  return ModSchema.parse({ ...mod, releaseSource: { sourceType: 'branch' } });
}
