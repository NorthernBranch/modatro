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
  const observedVersion = requirement.packageId
    ? found.packageId?.toLowerCase() === requirement.packageId.toLowerCase()
      ? found.packageVersion
      : undefined
    : found.installedVersion;
  const version = cleanVersion(observedVersion),
    range = semver.validRange(requirement.versionConstraint);
  if (!version || !range)
    return {
      ...requirement,
      installedVersion: observedVersion,
      state: 'unknown',
      reason: requirement.packageId
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
