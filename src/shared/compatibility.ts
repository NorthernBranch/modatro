import type { DependencyRequirement, DependencyStatus, ModDefinition, Prerequisite } from './model';
import { evaluateDependencies } from './dependencies';

export interface CompatibilityConflict {
  kind?: 'requirement' | 'conflict';
  modId: string;
  title: string;
  requirement: DependencyStatus;
  proposedVersion?: string;
}

export interface CompatibilityMod {
  declaredConflicts?: DependencyRequirement[];
  id: string;
  title: string;
  dependencies?: DependencyRequirement[];
}

export function affectedCompatibility(
  changes: Pick<ModDefinition, 'id' | 'metadataId' | 'source'>[],
  installed: CompatibilityMod[],
  future: Prerequisite[],
): CompatibilityConflict[] {
  return installed
    .filter((mod) => !changes.some((change) => change.id === mod.id))
    .flatMap((mod) => {
      const affected = (mod.dependencies ?? []).filter((requirement) =>
        changes.some((change) =>
          requirement.packageId
            ? change.source?.externalId.toLowerCase() === requirement.packageId.toLowerCase()
            : (change.metadataId ?? change.id).toLowerCase() === requirement.id.toLowerCase(),
        ),
      );
      const declared = (mod.declaredConflicts ?? []).filter((requirement) =>
        changes.some((change) =>
          requirement.packageId
            ? change.source?.externalId.toLowerCase() === requirement.packageId.toLowerCase()
            : (change.metadataId ?? change.id).toLowerCase() === requirement.id.toLowerCase(),
        ),
      );
      return [
        ...evaluateDependencies(declared, future)
          .filter((status) => ['satisfied', 'unknown'].includes(status.state))
          .map((requirement) => ({
            kind: 'conflict' as const,
            modId: mod.id,
            title: mod.title,
            requirement: {
              ...requirement,
              state:
                requirement.state === 'unknown' ? ('unknown' as const) : ('incompatible' as const),
              reason: `${mod.title} declares a conflict with ${requirement.displayName} ${requirement.versionConstraint ?? ''}.`,
            },
            proposedVersion: requirement.installedVersion,
          })),
        ...evaluateDependencies(affected, future)
          .filter((status) => status.required && status.state !== 'satisfied')
          .map((requirement) => ({
            modId: mod.id,
            title: mod.title,
            requirement,
            proposedVersion: requirement.installedVersion,
          })),
      ];
    });
}
