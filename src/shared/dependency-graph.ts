import type {
  DependencyRequirement,
  DependencyStatus,
  ModDefinition,
  Prerequisite,
  UnverifiedPrerequisite,
} from './model';
import { blockingDependencies, evaluateDependency } from './dependencies';
import { automationReason } from './trust';

export function packageIdentity(mod: ModDefinition) {
  return mod.source?.externalId ?? mod.id;
}
export class DependencyGraphError extends Error {
  constructor(public requirements: DependencyStatus[]) {
    super(requirements.map((entry) => entry.reason).join(' '));
  }
}

export function projectedPrerequisites(
  mods: ModDefinition[],
  installed: Prerequisite[],
): Prerequisite[] {
  const replaced = new Set(mods.map((mod) => packageIdentity(mod).toLowerCase()));
  return [
    ...installed.filter(
      (entry) => !entry.packageId || !replaced.has(entry.packageId.toLowerCase()),
    ),
    ...mods.map((mod) => ({
      id: mod.metadataId ?? mod.id,
      displayName: mod.title,
      installed: true,
      installedVersion: mod.source?.provider === 'thunderstore' ? undefined : mod.version,
      packageId: mod.source?.externalId,
      packageVersion: mod.source?.provider === 'thunderstore' ? mod.version : undefined,
      sourceUrl: mod.source?.url ?? mod.downloadUrl,
    })),
  ];
}

// Resolve the complete reachable graph, including dependencies of already
// installed packages. Identity is provider-qualified; versions never compare
// lexicographically and shared nodes are scheduled only once.
export function resolveDependencyGraph(
  roots: ModDefinition[],
  catalogue: ModDefinition[],
  installed: Prerequisite[],
  accepted: UnverifiedPrerequisite[] = [],
): ModDefinition[] {
  const ordered: ModDefinition[] = [];
  const visited = new Set<string>(),
    active = new Set<string>();
  const scheduled = new Set(roots.map((mod) => packageIdentity(mod).toLowerCase()));
  function resolve(requirement: DependencyRequirement): ModDefinition | undefined {
    const status = evaluateDependency(requirement, installed);
    const matches = catalogue.filter((mod) =>
      requirement.packageId
        ? packageIdentity(mod).toLowerCase() === requirement.packageId.toLowerCase()
        : (mod.metadataId ?? mod.id).toLowerCase() === requirement.id.toLowerCase(),
    );
    if (!blockingDependencies([status], accepted).length) {
      const candidate = matches.length === 1 ? matches[0] : undefined;
      const observed = installed.find(
        (entry) => entry.packageId === requirement.packageId,
      )?.packageVersion;
      const version = candidate?.versions?.find((entry) => entry.version === observed);
      return candidate
        ? {
            ...candidate,
            version: observed ?? candidate.version,
            prerequisites: version?.dependencies ?? candidate.prerequisites,
          }
        : undefined;
    }
    // Never overwrite an external loader whose package version is unverified.
    if (status.state === 'unknown') throw new DependencyGraphError([status]);
    if (matches.length !== 1)
      throw new Error(
        `Cannot resolve ${requirement.displayName}: its package source is missing or ambiguous.`,
      );
    const candidate = matches[0]!;
    const reason = automationReason(candidate, status.state === 'outdated');
    if (reason) throw new Error(`${candidate.title}: ${reason}`);
    const candidateStatus = evaluateDependency(
      requirement,
      projectedPrerequisites([candidate], []),
    );
    if (candidateStatus.state !== 'satisfied')
      throw new Error(
        `No compatible release is available for ${requirement.displayName} ${requirement.versionConstraint ?? ''}.`,
      );
    scheduled.add(packageIdentity(candidate).toLowerCase());
    return candidate;
  }
  function visit(mod: ModDefinition) {
    const identity = packageIdentity(mod).toLowerCase();
    const key = `${identity}@${mod.version}`;
    if (active.has(identity)) throw new Error(`Circular dependency involving ${mod.title}.`);
    if (visited.has(key)) return;
    active.add(identity);
    for (const requirement of mod.prerequisites.filter((entry) => entry.required)) {
      const dependency = resolve(requirement);
      if (dependency) visit(dependency);
    }
    active.delete(identity);
    visited.add(key);
    ordered.push(mod);
  }
  for (const root of roots) visit(root);
  const changes = ordered.filter(
    (mod, index) =>
      scheduled.has(packageIdentity(mod).toLowerCase()) &&
      ordered.findLastIndex(
        (entry) => packageIdentity(entry).toLowerCase() === packageIdentity(mod).toLowerCase(),
      ) === index,
  );
  const future = projectedPrerequisites(changes, installed);
  for (const mod of changes) {
    const blocked = blockingDependencies(
      mod.prerequisites.map((requirement) => evaluateDependency(requirement, future)),
      accepted,
    );
    if (blocked.length) throw new Error(blocked.map((entry) => entry.reason).join(' '));
  }
  return changes;
}
