import { canAcceptUnverified, evaluateDependencies, hasUpdate } from './dependencies';
import type { DependencyStatus, ModDefinition, Progress, Snapshot } from './model';
import { automationReason } from './trust';
import { resolveDependencyGraph } from './dependency-graph';
export function storageSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
export function installationProgressLabel(progress: Progress): string {
  const labels: Record<Progress['phase'], string> = {
    downloading: 'Downloading files',
    validating: 'Checking downloaded files',
    planning: 'Checking install plan',
    'backing-up': 'Backing up existing files',
    installing: 'Installing files',
    'rolling-back': 'Restoring files',
    complete: 'Finishing up',
  };
  return `${labels[progress.phase]}${progress.phase === 'downloading' && progress.percent !== undefined ? ` ${progress.percent}%` : '…'}`;
}
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
  if (mod.source?.provider === 'thunderstore') {
    try {
      resolveDependencyGraph([mod], snapshot.catalogue.mods, snapshot.prerequisites);
      return undefined;
    } catch {
      /* Show the existing per-requirement guidance when a graph cannot be installed. */
    }
  }
  const blocked = requirements(mod, snapshot).filter(
    (r) => r.required && r.state !== 'satisfied' && !canAcceptUnverified(r),
  );
  if (
    blocked.length &&
    blocked.every((requirement) => {
      if (!['missing', 'outdated'].includes(requirement.state)) return false;
      const candidates = snapshot.catalogue.mods.filter((candidate) =>
        requirement.packageId
          ? candidate.source?.externalId.toLowerCase() === requirement.packageId.toLowerCase()
          : (candidate.metadataId ?? candidate.id).toLowerCase() === requirement.id.toLowerCase(),
      );
      if (!candidates.length && requirement.id === 'Lovely' && !requirement.packageId)
        return ['win32', 'linux', 'darwin'].includes(snapshot.platform);
      return (
        candidates.length === 1 &&
        !automationReason(candidates[0]!, requirement.state === 'outdated')
      );
    })
  )
    return undefined;
  return blocked[0]?.reason;
}
export function isNewer(installed?: string, latest?: string): boolean {
  return !!installed && !!latest && hasUpdate(installed, latest);
}
