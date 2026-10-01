import { z } from 'zod';
import semver from 'semver';
import { HttpsUrl, ModId, ModSchema, PermissionsSchema, RelativePath, SafeName } from './model';

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
    version: z.string().min(1).max(100),
    permissions: PermissionsSchema,
    distribution: z
      .object({
        repository: HttpsUrl,
        releaseUrl: HttpsUrl,
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
  .strict();

export const NativeEntrySchema = ModSchema.extend({
  downloadUrl: HttpsUrl.optional(),
  permissions: PermissionsSchema,
})
  .strict()
  .superRefine((entry, ctx) => {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(entry.id))
      ctx.addIssue({ code: 'custom', message: 'Native IDs must be author/slug.' });
    if (!entry.downloadUrl && !entry.manifestUrl)
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
