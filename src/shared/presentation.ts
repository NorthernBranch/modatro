import { canAcceptUnverified, evaluateDependencies, hasUpdate } from './dependencies';
import type { DependencyStatus, ModDefinition, Snapshot } from './model';
import { automationReason } from './trust';
export function plainText(markdown = ''): string {
  return markdown
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function requirements(mod: ModDefinition, snapshot: Snapshot): DependencyStatus[] {
  const local = snapshot.localMods.find(
    (entry) => entry.managed && entry.id === mod.id && entry.version === mod.version,
  );
  const declared = [...mod.prerequisites, ...(local?.dependencies ?? [])];
  const unique = declared.filter(
    (requirement, index) =>
      declared.findIndex(
        (other) =>
          other.id.toLowerCase() === requirement.id.toLowerCase() &&
          other.packageId === requirement.packageId &&
          other.versionConstraint === requirement.versionConstraint,
      ) === index,
  );
  return evaluateDependencies(unique, snapshot.prerequisites);
}
export function eligibility(mod: ModDefinition, snapshot: Snapshot): string | undefined {
  if (snapshot.preview) return 'Open the desktop app to install';
  if (snapshot.safetyError) return 'File changes are locked';
  const managed = snapshot.localMods.some((local) => local.id === mod.id && local.managed);
  const policy = automationReason(mod, managed);
  if (policy) return policy;
  if (snapshot.trust && !snapshot.trust.fresh)
    return (
      snapshot.trust.error ?? 'Connect and refresh removal and release checks before installing.'
    );
  if (mod.unavailableReason) return 'Metadata unavailable';
  if (mod.installation.type === 'unsupported') return 'Automatic install not supported';
  if (!snapshot.validation?.valid || !snapshot.settings.modsPath)
    return 'Set up Balatro to install';
  return requirements(mod, snapshot).find(
    (r) => r.required && r.state !== 'satisfied' && !canAcceptUnverified(r),
  )?.reason;
}
export function isNewer(installed?: string, latest?: string): boolean {
  return !!installed && !!latest && hasUpdate(installed, latest);
}
