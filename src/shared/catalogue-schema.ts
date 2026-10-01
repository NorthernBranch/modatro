import { z } from 'zod';
import semver from 'semver';
import {
  ApprovalStatus,
  HttpsUrl,
  InstallationSchema,
  ModId,
  ModSchema,
  PermissionsSchema,
  RelativePath,
  ReleaseAssetName,
  SafeName,
} from './model';

const Range = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !!semver.validRange(v), 'Unsupported version requirement');
export const AuthorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ModId,
    name: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    version: z.string().min(1).max(100).optional(),
    permissions: PermissionsSchema,
    distribution: z
      .object({
        repository: HttpsUrl,
        releaseUrl: HttpsUrl.optional(),
        trackLatestRelease: z.boolean().optional(),
        assetName: ReleaseAssetName.optional(),
        sourceType: z.enum(['release-asset', 'tag', 'commit', 'branch', 'other']).optional(),
        releaseTag: z.string().optional(),
        commitSha: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    requirements: z.record(z.string().regex(/^[\w.-]+$/), Range).default({}),
    installation: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('mods-directory'),
          folder: SafeName,
          sourceRoot: RelativePath.optional(),
        })
        .strict(),
      z.object({ type: z.literal('single-file'), folder: SafeName }).strict(),
      z
        .object({
          type: z.literal('game-replacement'),
          files: z
            .array(z.object({ source: RelativePath, destination: RelativePath }).strict())
            .min(1),
        })
        .strict(),
      z
        .object({ type: z.literal('manual-install-required'), instructions: z.string().min(1) })
        .strict(),
    ]),
    description: z.string().max(2000).optional(),
    licence: z.string().max(200).optional(),
    iconUrl: HttpsUrl.optional(),
    iconUsageApproved: z.boolean().optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      !manifest.distribution.trackLatestRelease &&
      (!manifest.version || !manifest.distribution.releaseUrl)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'A version and release URL are required unless latest-release discovery is enabled.',
      });
  });

export const NativeEntrySchema = ModSchema.extend({
  version: z.string().min(1).max(100).optional(),
  prerequisites: ModSchema.shape.prerequisites.default([]),
  downloadUrl: HttpsUrl.optional(),
  permissions: PermissionsSchema,
})
  .strict()
  .superRefine((entry, ctx) => {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry.id))
      ctx.addIssue({ code: 'custom', message: 'Native IDs must be author/slug.' });
    if (!entry.downloadUrl && !entry.manifestUrl && !(entry.githubRelease && entry.repositoryUrl))
      ctx.addIssue({ code: 'custom', message: 'A manifest or distribution URL is required.' });
    if (entry.approvalStatus === 'author-approved' && !entry.approvalEvidence)
      ctx.addIssue({ code: 'custom', message: 'Author approval requires evidence.' });
    if (entry.approvalStatus === 'community-submitted' && !entry.approvalEvidence)
      ctx.addIssue({
        code: 'custom',
        message: 'Third-party submissions require reviewed permission evidence.',
      });
    if (entry.iconUrl && !entry.iconUsageApproved)
      ctx.addIssue({ code: 'custom', message: 'Images require display permission.' });
    if (entry.description && !entry.descriptionProvenance)
      ctx.addIssue({ code: 'custom', message: 'Descriptions require provenance.' });
    for (const requirement of entry.prerequisites)
      if (requirement.versionConstraint && !semver.validRange(requirement.versionConstraint))
        ctx.addIssue({ code: 'custom', message: 'Unsupported version requirement.' });
  });
export const CatalogueOverridesSchema = z
  .object({
    schemaVersion: z.literal(1),
    overrides: z
      .array(
        z
          .object({
            package: z
              .string()
              .regex(/^thunderstore\/[A-Za-z0-9_]+-[A-Za-z0-9_]+$/)
              .optional(),
            packageId: z.uuid().optional(),
            metadataId: z.string().min(1).max(200).optional(),
            folderName: SafeName.optional(),
            legacyIds: z.array(ModId).max(20).optional(),
            permissions: PermissionsSchema.optional(),
            approvalStatus: ApprovalStatus.optional(),
            approvalEvidence: HttpsUrl.optional(),
            installation: InstallationSchema.optional(),
          })
          .strict()
          .superRefine((entry, ctx) => {
            if (!entry.package && !entry.packageId)
              ctx.addIssue({ code: 'custom', message: 'A package identity or UUID is required.' });
            if (
              ['author-approved', 'community-submitted'].includes(entry.approvalStatus ?? '') &&
              !entry.approvalEvidence
            )
              ctx.addIssue({ code: 'custom', message: 'Permission changes require evidence.' });
          }),
      )
      .max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const identities = value.overrides.flatMap((entry) =>
      [
        entry.package?.toLowerCase(),
        entry.packageId,
        ...(entry.legacyIds ?? []).map((id) => id.toLowerCase()),
      ].filter(Boolean),
    );
    if (new Set(identities).size !== identities.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate registry overrides.' });
  });
export const NativeCatalogueSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    mods: z.array(NativeEntrySchema).max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.mods
      .flatMap((entry) => [entry.id, ...(entry.legacyIds ?? [])])
      .map((id) => id.toLowerCase());
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate identities or legacy aliases.' });
  });
