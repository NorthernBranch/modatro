import { z } from 'zod';
import { ProfileName } from './features';
import type { InstallPlan, Snapshot } from './model';

const PortableArtifact = z
  .object({
    url: z.url().max(2000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceType: z.enum(['tag', 'commit', 'release-asset']),
    releaseTag: z.string().max(200).optional(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
export const PortableModSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    metadataId: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(100),
    packageVersion: z.string().max(100).optional(),
    enabled: z.boolean(),
    artifact: PortableArtifact.optional(),
  })
  .strict();
export const PortableProfileSchema = z
  .object({
    format: z.literal('modatro-profile'),
    schemaVersion: z.literal(1),
    name: ProfileName,
    mods: z
      .array(PortableModSchema)
      .max(128)
      .refine(
        (items) => new Set(items.map((i) => i.id)).size === items.length,
        'Duplicate mod identity.',
      ),
  })
  .strict();
export const ProfileFileSchema = z
  .object({ profile: PortableProfileSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type PortableProfile = z.infer<typeof PortableProfileSchema>;
export type PortableMod = z.infer<typeof PortableModSchema>;
export const ProfileTransferRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('export'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('choose-import') }).strict(),
  z
    .object({
      operation: z.literal('install'),
      token: z.uuid(),
      confirmationToken: z.uuid().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('cancel'), token: z.uuid() }).strict(),
]);
export type ProfileTransferRequest = z.infer<typeof ProfileTransferRequestSchema>;
export interface ProfileTransferResult {
  status: 'cancelled' | 'exported' | 'review' | 'complete';
  token?: string;
  name?: string;
  mods?: { title: string; version: string; enabled: boolean; status: 'installed' | 'download' }[];
  warnings?: string[];
  blockers?: string[];
  confirmation?: { token: string; plan: InstallPlan };
  profileId?: string;
  snapshot?: Snapshot;
}
export function uniqueImportedName(name: string, existing: string[]) {
  const used = new Set(existing.map((n) => n.normalize('NFKC').toLowerCase()));
  if (!used.has(name.normalize('NFKC').toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`,
      candidate = name.slice(0, 60 - suffix.length) + suffix;
    if (!used.has(candidate.normalize('NFKC').toLowerCase())) return candidate;
  }
  throw new Error('No available profile name.');
}
