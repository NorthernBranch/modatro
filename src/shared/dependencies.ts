import semver from 'semver';
import type {
  DependencyRequirement,
  DependencyStatus,
  Prerequisite,
  UnverifiedPrerequisite,
} from './model';

export function externalLoaderRequirement(
  requirement: Pick<DependencyRequirement, 'id' | 'packageId'>,
): boolean {
  return (
    ['lovely', 'steamodded'].includes(requirement.id.toLowerCase()) &&
    (!requirement.packageId ||
      ['thunderstore/thunderstore-lovely', 'thunderstore/steamodded-steamodded'].includes(
        requirement.packageId.toLowerCase(),
      ))
  );
}
export function canAcceptUnverified(requirement: DependencyStatus): boolean {
  return requirement.state === 'unknown' && externalLoaderRequirement(requirement);
}

export function blockingDependencies(
  requirements: DependencyStatus[],
  accepted: UnverifiedPrerequisite[] = [],
): DependencyStatus[] {
  return requirements.filter(
    (requirement) =>
      requirement.required &&
      requirement.state !== 'satisfied' &&
      !(
        canAcceptUnverified(requirement) &&
        accepted.some(
          (acknowledgement) =>
            acknowledgement.id.toLowerCase() === requirement.id.toLowerCase() &&
            acknowledgement.versionConstraint === requirement.versionConstraint &&
            acknowledgement.installedVersion === requirement.installedVersion &&
            acknowledgement.packageId === requirement.packageId,
        )
      ),
  );
}
export function cleanVersion(value?: string): string | undefined {
  return value ? (semver.valid(value.replace(/^v/i, '').trim()) ?? undefined) : undefined;
}
function loaderVersion(id: string, value?: string): string | undefined {
  if (id.toLowerCase() === 'balatro' && value) {
    const game = /^v?(\d+\.\d+\.\d+)([a-z])?(?:-FULL)?$/i.exec(value);
    return game
      ? cleanVersion(`${game[1]}-${game[2] ? game[2].toLowerCase().charCodeAt(0) - 96 : 0}`)
      : undefined;
  }
  if (id.toLowerCase() !== 'steamodded' || !value) return cleanVersion(value);
  if (/~BETA(?:$|[^-])/i.test(value)) return undefined;
  // Steamodded uses '~' for prereleases, which is not a SemVer delimiter.
  return cleanVersion(
    value
      .replace(
        /~BETA-(\d+)([a-z]+)/i,
        (_match, build: string, suffix: string) =>
          `-beta.${build.replace(/^0+(?=\d)/, '')}.${suffix.toLowerCase()}`,
      )
      .replace('~', '-'),
  );
}
function loaderRange(id: string, range: string): string | null {
  if (id.toLowerCase() === 'balatro')
    return semver.validRange(
      range.replace(
        /\b(\d+\.\d+\.\d+)([a-z])?\b/gi,
        (_match, version: string, letter?: string) =>
          `${version}-${letter ? letter.toLowerCase().charCodeAt(0) - 96 : 0}`,
      ),
    );
  if (id.toLowerCase() === 'steamodded' && /~BETA(?:$|[^-])/i.test(range)) return null;
  return semver.validRange(
    id.toLowerCase() === 'steamodded'
      ? range
          .replace(
            /~BETA-(\d+)([a-z]+)/gi,
            (_match, build: string, suffix: string) =>
              `-beta.${build.replace(/^0+(?=\d)/, '')}.${suffix.toLowerCase()}`,
          )
          .replace(/(\d+\.\d+\.\d+)~/g, '$1-')
      : range,
  );
}
export function hasUpdate(installed: string, latest: string): boolean {
  const a = cleanVersion(installed),
    b = cleanVersion(latest);
  // Different arbitrary branch/date strings do not prove that a release is newer.
  return !!a && !!b && semver.gt(b, a);
}
export function evaluateDependency(
  requirement: DependencyRequirement,
  installed: Prerequisite[],
): DependencyStatus {
  const found =
    installed.find((p) =>
      requirement.packageId
        ? p.packageId?.toLowerCase() === requirement.packageId.toLowerCase()
        : p.id.toLowerCase() === requirement.id.toLowerCase(),
    ) ??
    (requirement.packageId
      ? installed.find(
          (p) =>
            !p.packageId &&
            p.id.toLowerCase() === requirement.id.toLowerCase() &&
            externalLoaderRequirement(requirement),
        )
      : undefined);
  if (!found?.installed)
    return {
      ...requirement,
      state: 'missing',
      reason: requirement.required
        ? `${requirement.displayName} is required.`
        : `${requirement.displayName} is optional.`,
    };
  if (!requirement.versionConstraint)
    return {
      ...requirement,
      installedVersion: found.installedVersion,
      state: 'satisfied',
      reason: 'Installed. Required version: not specified by mod.',
    };
  let observedVersion = requirement.packageId
    ? found.packageId?.toLowerCase() === requirement.packageId.toLowerCase()
      ? found.packageVersion
      : undefined
    : found.installedVersion;
  const runtimeFallback =
    !!requirement.packageId &&
    !observedVersion &&
    (externalLoaderRequirement(requirement) ||
      (found.packageId?.toLowerCase() === requirement.packageId.toLowerCase() &&
        found.provenance?.provider === 'github'));
  if (runtimeFallback) observedVersion = found.installedVersion;
  let version = loaderVersion(requirement.id, observedVersion);
  const range = loaderRange(requirement.id, requirement.versionConstraint);
  // The official legacy registry series encoded beta build N as 1.N.0.
  // Compare the known runtime build without claiming a registry archive was installed.
  if (
    runtimeFallback &&
    externalLoaderRequirement(requirement) &&
    requirement.id.toLowerCase() === 'steamodded'
  ) {
    const beta = /^v?1\.0\.0~BETA-(\d+)[a-z]$/i.exec(observedVersion ?? '');
    if (beta && /^>=1\.\d+\.0$/.test(requirement.versionConstraint))
      version = cleanVersion(`1.${beta[1]}.0`);
  }
  if (!version || !range)
    return {
      ...requirement,
      installedVersion: observedVersion,
      state: 'unknown',
      reason:
        requirement.packageId && !runtimeFallback
          ? `Cannot verify the installed Thunderstore package version of ${requirement.displayName} against ${requirement.versionConstraint}.`
          : `Cannot verify ${requirement.displayName} against ${requirement.versionConstraint}.`,
    };
  if (semver.satisfies(version, range, { includePrerelease: true }))
    return {
      ...requirement,
      installedVersion: observedVersion,
      state: 'satisfied',
      reason: 'Meets the mod’s requirement.',
    };
  const minimum = semver.minVersion(range),
    outdated = minimum && semver.lt(version, minimum);
  return {
    ...requirement,
    installedVersion: observedVersion,
    state: outdated ? 'outdated' : 'incompatible',
    reason: outdated
      ? `${requirement.displayName} update required (${requirement.versionConstraint}).`
      : `${requirement.displayName} ${observedVersion} is incompatible with ${requirement.versionConstraint}.`,
  };
}
export function evaluateDependencies(
  requirements: DependencyRequirement[],
  installed: Prerequisite[],
): DependencyStatus[] {
  return requirements.map((r) => evaluateDependency(r, installed));
}
