import { z } from 'zod';
import semver from 'semver';
import { HttpsUrl, ModSchema, type DependencyRequirement, type ModDefinition } from './model';

export const THUNDERSTORE_BASE_URL = 'https://thunderstore.io';
export const BALATRO_COMMUNITY = 'balatro';
export const THUNDERSTORE_ENDPOINT = `${THUNDERSTORE_BASE_URL}/c/${BALATRO_COMMUNITY}/api/v1/package-listing-index/`;
const Name = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/)
  .min(1)
  .max(40);
const Version = z
  .string()
  .refine((value) => /^\d+\.\d+\.\d+$/.test(value) && !!semver.valid(value));
export const ThunderstoreManifestSchema = z.object({
  name: Name,
  version_number: Version,
  dependencies: z.array(z.string().max(200)).max(100),
  installers: z.array(z.unknown()).optional(),
});
const PackageVersion = z.object({
  uuid4: z.uuid(),
  name: Name,
  full_name: z.string().max(200),
  version_number: Version,
  is_active: z.boolean(),
  dependencies: z.array(z.string().max(200)).max(100),
  download_url: HttpsUrl,
  website_url: z.string().max(2000),
  description: z.string().max(30000).optional(),
  icon: HttpsUrl.optional(),
  date_created: z.iso.datetime({ offset: true }).optional(),
  downloads: z.number().int().nonnegative().optional(),
  installers: z.array(z.unknown()).optional(),
});
export const ThunderstorePackageSchema = z.object({
  uuid4: z.uuid(),
  name: Name,
  owner: Name,
  full_name: z.string().max(200),
  package_url: HttpsUrl,
  date_updated: z.iso.datetime({ offset: true }),
  categories: z.array(z.string().max(100)).max(30),
  is_deprecated: z.boolean(),
  versions: z.array(PackageVersion).min(1).max(2000),
});
export function thunderstoreId(namespace: string, name: string) {
  return `thunderstore/${namespace}-${name}`;
}
export function thunderstoreDependency(value: string): DependencyRequirement {
  const parts = /^([a-zA-Z0-9_]+)-([a-zA-Z0-9_]+)-(\d+\.\d+\.\d+)$/.exec(value);
  if (!parts || !semver.valid(parts[3]))
    throw new Error(`Invalid Thunderstore dependency: ${value}`);
  const namespace = Name.parse(parts[1]),
    name = Name.parse(parts[2]);
  const id =
    namespace === 'Thunderstore' && name === 'lovely'
      ? 'Lovely'
      : namespace === 'Steamodded' && name === 'Steamodded'
        ? 'Steamodded'
        : name;
  return {
    id,
    displayName: id,
    required: true,
    versionConstraint: `>=${parts[3]}`,
    packageId: thunderstoreId(namespace, name),
    source: 'thunderstore',
    namespace,
    packageName: name,
    minimumVersion: parts[3],
  };
}
export function thunderstoreDownload(namespace: string, name: string, version: string) {
  return `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`;
}
export function normalizeThunderstore(raw: unknown): ModDefinition | undefined {
  const pkg = ThunderstorePackageSchema.parse(raw);
  if (
    pkg.full_name !== `${pkg.owner}-${pkg.name}` ||
    pkg.package_url !== `https://thunderstore.io/c/balatro/p/${pkg.owner}/${pkg.name}/`
  )
    throw new Error('Thunderstore package identity does not match its source.');
  // Deprecated packages are never offered as new installs. An inactive version is not a fallback.
  const releases = [...pkg.versions]
    .filter((version) => version.is_active)
    .sort((a, b) => semver.rcompare(a.version_number, b.version_number));
  const release = releases[0];
  if (!release) return undefined;
  for (const version of releases)
    if (
      version.name !== pkg.name ||
      version.full_name !== `${pkg.full_name}-${version.version_number}` ||
      version.download_url !== thunderstoreDownload(pkg.owner, pkg.name, version.version_number)
    )
      throw new Error('Thunderstore release identity does not match its download.');
  const lovely = pkg.owner === 'Thunderstore' && pkg.name === 'lovely';
  const steamodded = pkg.owner === 'Steamodded' && pkg.name === 'Steamodded';
  let repositoryUrl: string | undefined;
  try {
    const url = new URL(release.website_url);
    const project = /^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(url.pathname);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      project &&
      !url.username &&
      !url.password &&
      !url.port
    )
      repositoryUrl = `https://github.com/${project[1]}/${project[2]!.replace(/\.git$/, '')}`;
  } catch {
    /* Unrecognized website links remain informational. */
  }
  if (steamodded) repositoryUrl = 'https://github.com/Steamodded/smods';
  if (lovely) repositoryUrl = 'https://github.com/ethangreen-dev/lovely-injector';
  return ModSchema.parse({
    id: thunderstoreId(pkg.owner, pkg.name),
    title: lovely ? 'Lovely' : pkg.name.replaceAll('_', ' '),
    author: pkg.owner,
    version: release.version_number,
    source: {
      provider: 'thunderstore',
      externalId: thunderstoreId(pkg.owner, pkg.name),
      namespace: pkg.owner,
      packageName: pkg.name,
      url: pkg.package_url,
    },
    deprecated: pkg.is_deprecated,
    description: release.description,
    descriptionProvenance: 'author-supplied',
    iconUrl: release.icon,
    versions: releases.map((version) => ({
      version: version.version_number,
      downloadUrl: version.download_url,
      dependencies: version.dependencies.map(thunderstoreDependency),
      publishedAt: version.date_created,
      downloads: version.downloads,
      sourceArtifact: { provider: 'thunderstore', externalId: version.uuid4 },
      installer: version.installers,
    })),
    installer: release.installers,
    repositoryUrl,
    websiteUrl: HttpsUrl.safeParse(release.website_url).success ? release.website_url : undefined,
    downloadUrl: release.download_url,
    categories: pkg.categories.length ? pkg.categories : ['Mods'],
    sourceCategories: pkg.categories,
    metadataId: lovely ? 'Lovely' : pkg.name,
    legacyIds: lovely ? ['Lovely'] : steamodded ? ['Steamodded@smods'] : undefined,
    approvalStatus: 'registry-published',
    updatedAt: Date.parse(pkg.date_updated),
    // Registry publication is labelled separately from explicit Modatro author approval.
    releaseSource: { sourceType: 'registry', releaseTag: release.version_number },
    prerequisites: release.dependencies.map(thunderstoreDependency),
    installation: lovely
      ? { type: 'lovely-injector' }
      : release.installers?.length && !repositoryUrl
        ? {
            type: 'unsupported',
            instructions:
              'This package declares an installer Modatro does not support. Open its source page for manual installation.',
          }
        : { type: 'auto' },
    support: lovely
      ? 'dependency-only'
      : release.installers?.length && !repositoryUrl
        ? 'manual-install'
        : undefined,
    thunderstore: {
      packageId: pkg.uuid4,
      versionId: release.uuid4,
      namespace: pkg.owner,
      name: pkg.name,
      packageVersion: release.version_number,
      dependencies: release.dependencies,
      packageUrl: pkg.package_url,
    },
  });
}
