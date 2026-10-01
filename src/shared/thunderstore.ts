import { z } from 'zod';
import semver from 'semver';
import { HttpsUrl, ModSchema, type DependencyRequirement, type ModDefinition } from './model';

export const THUNDERSTORE_ENDPOINT = 'https://thunderstore.io/c/balatro/api/v1/package/';
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
  if (pkg.is_deprecated) return undefined;
  const release = [...pkg.versions]
    .filter((version) => version.is_active)
    .sort((a, b) => semver.rcompare(a.version_number, b.version_number))[0];
  if (!release) return undefined;
  if (
    release.name !== pkg.name ||
    release.full_name !== `${pkg.full_name}-${release.version_number}` ||
    release.download_url !== thunderstoreDownload(pkg.owner, pkg.name, release.version_number)
  )
    throw new Error('Thunderstore release identity does not match its download.');
  const lovely = pkg.owner === 'Thunderstore' && pkg.name === 'lovely';
  const steamodded = pkg.owner === 'Steamodded' && pkg.name === 'Steamodded';
  let repositoryUrl: string | undefined;
  try {
    const url = new URL(release.website_url);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.port
    )
      repositoryUrl = url.href.replace(/\/$/, '');
  } catch {
    /* Website links are optional and cannot expand download permissions. */
  }
  if (steamodded) repositoryUrl = 'https://github.com/Steamodded/smods';
  const modpack = pkg.categories.some((category) => category.toLowerCase() === 'modpacks');
  return ModSchema.parse({
    id: thunderstoreId(pkg.owner, pkg.name),
    title: lovely ? 'Lovely' : pkg.name.replaceAll('_', ' '),
    author: pkg.owner,
    version: release.version_number,
    repositoryUrl,
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
    installation: modpack
      ? {
          type: 'unsupported',
          instructions: 'This package is a modpack. Install its individual dependencies instead.',
        }
      : lovely
        ? { type: 'game-replacement', files: [{ source: 'winmm.dll', destination: 'winmm.dll' }] }
        : { type: 'auto' },
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
