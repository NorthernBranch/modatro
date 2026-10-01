import semver from 'semver';
import type { DependencyRequirement, DependencyStatus, Prerequisite } from './model';
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
  const found = installed.find((p) => p.id.toLowerCase() === requirement.id.toLowerCase());
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
  const version = cleanVersion(found.installedVersion),
    range = semver.validRange(requirement.versionConstraint);
  if (!version || !range)
    return {
      ...requirement,
      installedVersion: found.installedVersion,
      state: 'unknown',
      reason: `Cannot verify ${requirement.displayName} against ${requirement.versionConstraint}.`,
    };
  if (semver.satisfies(version, range, { includePrerelease: true }))
    return {
      ...requirement,
      installedVersion: found.installedVersion,
      state: 'satisfied',
      reason: 'Meets the mod’s requirement.',
    };
  const minimum = semver.minVersion(range),
    outdated = minimum && semver.lt(version, minimum);
  return {
    ...requirement,
    installedVersion: found.installedVersion,
    state: outdated ? 'outdated' : 'incompatible',
    reason: outdated
      ? `${requirement.displayName} update required (${requirement.versionConstraint}).`
      : `${requirement.displayName} ${found.installedVersion} is incompatible with ${requirement.versionConstraint}.`,
  };
}
export function evaluateDependencies(
  requirements: DependencyRequirement[],
  installed: Prerequisite[],
): DependencyStatus[] {
  return requirements.map((r) => evaluateDependency(r, installed));
}
