import { z } from 'zod';
import { HttpsUrl, ModId, type InstallationSource, type ModDefinition } from './model';

export const RevocationReason = z.enum([
  'author-request',
  'malware',
  'compromised-release',
  'invalid-source',
  'licensing',
  'broken-install',
  'security-risk',
  'other',
]);
export const RevocationSchema = z.object({
  modId: ModId,
  repositoryUrl: HttpsUrl.optional(),
  reason: RevocationReason,
  effectiveAt: z.iso.datetime(),
});
export const BlockedReleaseSchema = z.object({
  modId: ModId,
  repositoryUrl: HttpsUrl.optional(),
  version: z.string().min(1).max(100),
  status: z.literal('blocked'),
  reason: z.string().min(1).max(1000),
  effectiveAt: z.iso.datetime(),
});
export const RevocationsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  revocations: z.array(RevocationSchema).max(10000),
});
export const BlockedReleasesSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  blockedReleases: z.array(BlockedReleaseSchema).max(10000),
});
export function sameRepository(a?: string, b?: string) {
  if (!a || !b) return false;
  const canonical = (value: string) =>
    value
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
  return canonical(a) === canonical(b);
}
export function sourceType(url: string): InstallationSource['sourceType'] {
  const pathname = new URL(url).pathname;
  if (/\/releases\/download\//.test(pathname)) return 'release-asset';
  if (
    /\/refs\/heads\//.test(pathname) ||
    /\/(?:main|master|develop)\.(?:zip|tar\.gz)$/.test(pathname)
  )
    return 'branch';
  if (/\/[a-f0-9]{40}(?:\.zip|\.tar\.gz|\/|$)/.test(pathname)) return 'commit';
  if (/\/refs\/tags\//.test(pathname) || /\/archive\/v?\d/.test(pathname)) return 'tag';
  // Raw files and unclassified archive refs can move; never call them immutable.
  if (/\/archive\//.test(pathname) || new URL(url).hostname === 'raw.githubusercontent.com')
    return 'branch';
  return 'other';
}
export function approvalLabel(mod: ModDefinition) {
  return {
    'author-approved': 'Author approved',
    'legacy-index': 'Legacy index',
    'community-submitted': 'Community submitted',
    'pending-review': 'Pending review',
    'opted-out': 'Removed by author',
    blocked: 'Blocked',
  }[mod.approvalStatus ?? 'legacy-index'];
}
export function automationReason(mod: ModDefinition, update = false): string | undefined {
  if (mod.policyReason) return mod.policyReason;
  if (mod.approvalStatus === 'opted-out')
    return 'The author requested removal. Your existing installation has not been changed.';
  if (mod.approvalStatus === 'blocked')
    return 'This source is blocked. Your existing installation has not been changed.';
  if (mod.approvalStatus === 'pending-review')
    return 'Catalogue permission is pending review. Open the project for instructions.';
  if (
    mod.permissions?.display === false ||
    mod.permissions?.[update ? 'update' : 'install'] === false
  )
    return update
      ? 'The author does not permit Modatro to manage updates.'
      : 'Automatic installation is not permitted for this entry.';
  if (mod.unavailableReason) return mod.unavailableReason;
  if (mod.installation.type === 'unsupported')
    return 'Automatic installation is not supported. View the project’s installation instructions.';
}
export function allowedDescription(mod: ModDefinition) {
  return mod.descriptionProvenance ? mod.description : undefined;
}
export function defaultFolder(mod: ModDefinition) {
  return mod.folderName ?? mod.id.replaceAll('/', '@');
}
export function sourceLabel(type: InstallationSource['sourceType']) {
  return {
    'release-asset': 'Published release asset',
    tag: 'Tagged archive',
    commit: 'Pinned commit archive',
    branch: 'Branch archive · mutable branch',
    other: 'Configured upstream source',
    legacy: 'Legacy installation',
    external: 'Installed externally',
  }[type];
}
