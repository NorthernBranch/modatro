import { z } from 'zod';
import { ModSchema, type ModDefinition } from '../../src/shared/model';
import { readLatestGitHubRelease, repositoryPath } from './distribution';
import { remoteJson } from './network';

export function developmentAvailability(mod: ModDefinition) {
  const available =
    !!repositoryPath(mod.repositoryUrl) &&
    mod.installation.type !== 'lovely-injector' &&
    mod.source?.provider !== 'local';
  return {
    available,
    reason: available
      ? 'Optional unreleased upstream code. The commit, actual version and requirements are checked before confirmation. You can retry after changing installed mods.'
      : mod.installation.type === 'lovely-injector'
        ? 'Lovely requires an official platform release.'
        : 'No supported upstream development archive is declared for this mod.',
  };
}
export async function publishedOptions(mod: ModDefinition, json = remoteJson) {
  const choices: { key: string; mod: ModDefinition }[] = [];
  if (mod.thunderstore && mod.installation.type !== 'lovely-injector')
    choices.push(
      ...(mod.versions ?? [])
        .filter(
          (version) =>
            version.sourceArtifact?.provider === 'thunderstore' &&
            (version.installer === undefined ||
              (Array.isArray(version.installer) && !version.installer.length)),
        )
        .map((version) => ({
          key: `thunderstore:${version.sourceArtifact!.externalId}`,
          mod: ModSchema.parse({
            ...mod,
            versions: undefined,
            version: version.version,
            downloadUrl: version.downloadUrl,
            prerequisites: version.dependencies,
            installer: version.installer,
            downloadProvider: undefined,
            githubRelease: undefined,
            manifestUrl: undefined,
            unavailableReason: undefined,
            installation:
              mod.installation.type === 'unsupported' ? { type: 'auto' } : mod.installation,
            support: undefined,
            releaseSource: { sourceType: 'registry', releaseTag: version.version },
            thunderstore: {
              ...mod.thunderstore!,
              versionId: version.sourceArtifact!.externalId,
              packageVersion: version.version,
              dependencies: version.dependencies.map(
                (dependency) =>
                  `${dependency.namespace}-${dependency.packageName}-${dependency.minimumVersion}`,
              ),
            },
          }),
        })),
    );
  const repo = repositoryPath(mod.repositoryUrl);
  if (!repo || mod.source?.provider === 'local' || mod.installation.type === 'lovely-injector')
    return { choices };
  let releases;
  try {
    releases = z
      .array(
        z
          .object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean() })
          .passthrough(),
      )
      .parse(await json(`https://api.github.com/repos/${repo}/releases?per_page=100`));
  } catch (error) {
    return {
      choices,
      warning: `GitHub release history could not be checked: ${error instanceof Error ? error.message : String(error)} Refresh versions to retry. Development-build eligibility is unchanged.`,
    };
  }
  for (const release of releases.filter((entry) => !entry.draft && !entry.prerelease)) {
    // Reuse the ordinary manual-archive selection and validation, pinned to this
    // published release. Never substitute today's default branch for an old tag.
    try {
      const selected = await readLatestGitHubRelease(
        ModSchema.parse({
          ...mod,
          versions: undefined,
          downloadProvider: 'github',
          githubRelease: mod.githubRelease ?? {},
          manifestUrl: undefined,
          prerequisites: [],
          unavailableReason: undefined,
        }),
        async () => release,
      );
      choices.push({
        key: `github:${release.tag_name}`,
        mod: ModSchema.parse({ ...selected, githubRelease: undefined, installer: undefined }),
      });
    } catch {
      /* Ambiguous or unsupported release assets are not install choices. */
    }
  }
  return { choices };
}
