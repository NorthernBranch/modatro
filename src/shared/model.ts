import { z } from 'zod';
import { ModIndexUrl } from './mod-index';

export const SafeName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_@.+ -]+$/)
  .refine(
    (v) =>
      !/^\.+$/.test(v) &&
      !/[. ]$/.test(v) &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(v),
    'Unsafe filename',
  );
export const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !v.includes('\\') &&
      !v.includes('\0') &&
      !v.startsWith('/') &&
      v.split('/').every((s) => SafeName.safeParse(s).success),
    'Unsafe relative path',
  );
// Native catalogue identities may be author/slug; filesystem names remain separate.
export const ModId = z.union([
  SafeName,
  z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
    .refine((v) => v.split('/').every((part) => SafeName.safeParse(part).success)),
]);
export const ApprovalStatus = z.enum([
  'author-approved',
  'legacy-index',
  'registry-published',
  'community-submitted',
  'pending-review',
  'opted-out',
  'blocked',
]);
export const PermissionsSchema = z.object({
  display: z.boolean(),
  install: z.boolean(),
  update: z.boolean(),
});
export const ReleaseSourceSchema = z.object({
  sourceType: z.enum(['release-asset', 'tag', 'commit', 'branch', 'registry', 'other']),
  releaseTag: z.string().max(200).optional(),
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const HttpsUrl = z.url().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}, 'Only HTTPS links are supported');
export const DependencySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  versionConstraint: z.string().optional(),
  required: z.boolean(),
  packageId: ModId.optional(),
  source: z.string().optional(),
  namespace: z.string().optional(),
  packageName: z.string().optional(),
  minimumVersion: z.string().optional(),
});
export const ReleaseAssetName = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      SafeName.safeParse(value.replaceAll('{version}', 'release').replaceAll('{tag}', 'release'))
        .success,
    'Asset names may contain {version} or {tag} placeholders.',
  );
export type DependencyRequirement = z.infer<typeof DependencySchema>;
export const InstallationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auto') }),
  z.object({ type: z.literal('standard'), sourceRoot: RelativePath.optional() }),
  z.object({ type: z.literal('single-file') }),
  z.object({ type: z.literal('lovely-patch') }),
  z.object({ type: z.literal('lovely-injector') }),
  z.object({
    type: z.literal('game-replacement'),
    files: z.array(z.object({ source: RelativePath, destination: RelativePath })).min(1),
  }),
  z.object({ type: z.literal('unsupported'), instructions: z.string().optional() }),
]);
export type InstallationDefinition = z.infer<typeof InstallationSchema>;
export const ModVersionSchema = z.object({
  version: z.string().min(1).max(100),
  downloadUrl: HttpsUrl,
  dependencies: z.array(DependencySchema).max(100),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  downloads: z.number().int().nonnegative().optional(),
  sourceArtifact: z.object({ provider: z.string(), externalId: z.string() }).optional(),
  installer: z.unknown().optional(),
});
export type ModVersion = z.infer<typeof ModVersionSchema>;
export const ModSchema = z
  .object({
    id: ModId,
    title: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    source: z
      .object({
        provider: z.string(),
        externalId: z.string(),
        namespace: z.string().optional(),
        packageName: z.string().optional(),
        url: HttpsUrl.optional(),
      })
      .optional(),
    versions: z.array(ModVersionSchema).max(2000).optional(),
    deprecated: z.boolean().optional(),
    support: z.enum(['supported', 'manual-install', 'unsupported', 'dependency-only']).optional(),
    installer: z.unknown().optional(),
    description: z.string().max(30000).optional(),
    repositoryUrl: HttpsUrl.optional(),
    websiteUrl: HttpsUrl.optional(),
    downloadUrl: HttpsUrl,
    categories: z
      .array(z.string())
      .max(30)
      .transform((categories) => {
        const visible = categories.filter(
          (category) => !/^ai[\s_-]+generated$/i.test(category.trim()),
        );
        return categories.length && !visible.length ? ['Other'] : visible;
      }),
    // Registry metadata remains the discovery identity when downloading upstream.
    downloadProvider: z.literal('github').optional(),
    sourceCategories: z.array(z.string()).optional(),
    folderName: SafeName.optional(),
    prerequisites: z.array(DependencySchema).max(100),
    installation: InstallationSchema.default({ type: 'auto' }),
    unavailableReason: z.string().optional(),
    updatedAt: z.number().optional(),
    approvalStatus: ApprovalStatus.optional(),
    approvalEvidence: HttpsUrl.optional(),
    permissions: PermissionsSchema.optional(),
    manifestUrl: HttpsUrl.optional(),
    metadataId: z.string().min(1).max(200).optional(),
    legacyIds: z.array(ModId).max(20).optional(),
    releaseSource: ReleaseSourceSchema.optional(),
    licence: z.string().max(200).optional(),
    descriptionProvenance: z.enum(['author-supplied', 'licensed', 'factual']).optional(),
    iconUrl: HttpsUrl.optional(),
    iconUsageApproved: z.boolean().optional(),
    distributionApproved: z.boolean().optional(),
    policyReason: z.string().optional(),
    githubRelease: z.object({ assetName: ReleaseAssetName.optional() }).strict().optional(),
    thunderstore: z
      .object({
        packageId: z.uuid(),
        versionId: z.uuid(),
        namespace: z
          .string()
          .regex(/^[a-zA-Z0-9_]+$/)
          .max(40),
        name: z
          .string()
          .regex(/^[a-zA-Z0-9_]+$/)
          .max(40),
        packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        dependencies: z.array(z.string().max(200)).max(100),
        packageUrl: HttpsUrl,
      })
      .strict()
      .optional(),
  })
  .superRefine((mod, context) => {
    if (mod.source?.provider === 'thunderstore' && !mod.thunderstore)
      context.addIssue({ code: 'custom', message: 'Thunderstore source identity is incomplete.' });
    if (mod.thunderstore && mod.source) {
      const registry = mod.thunderstore;
      if (
        mod.source.provider !== 'thunderstore' ||
        mod.source.externalId !== `thunderstore/${registry.namespace}-${registry.name}` ||
        (mod.source.namespace !== undefined && mod.source.namespace !== registry.namespace) ||
        (mod.source.packageName !== undefined && mod.source.packageName !== registry.name) ||
        (mod.source.url !== undefined && mod.source.url !== registry.packageUrl)
      )
        context.addIssue({
          code: 'custom',
          message: 'Normalized source identity does not match its registry package.',
        });
    }
  });
export type ModDefinition = z.infer<typeof ModSchema>;
export type DependencyState = 'satisfied' | 'missing' | 'outdated' | 'incompatible' | 'unknown';
export interface DependencyStatus extends DependencyRequirement {
  state: DependencyState;
  installedVersion?: string;
  reason: string;
}
export interface Prerequisite {
  id: string;
  displayName: string;
  installed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  latestError?: string;
  sourceUrl: string;
  instructions?: string;
  provenance?: InstallationSource;
  packageId?: string;
  packageVersion?: string;
  latestPackageId?: string;
  dependencies?: DependencyRequirement[];
}
export interface ValidationProblem {
  code: string;
  message: string;
}
export interface PathValidationResult {
  valid: boolean;
  canonicalPath?: string;
  detectedPlatform?: 'windows' | 'macos';
  detectedVersion?: string;
  problems: ValidationProblem[];
  warnings: ValidationProblem[];
}
export interface GameCandidate {
  path: string;
  validation: PathValidationResult;
}
export const SettingsSchema = z.object({
  modIndexUrl: ModIndexUrl.optional(),
  gamePath: z.string().optional(),
  modsPath: z.string().optional(),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  setupComplete: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const RootSchema = z.enum(['mods', 'game', 'disabled']);
export type FileRoot = z.infer<typeof RootSchema>;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const InstallationSourceSchema = z.object({
  sourceType: z.enum([
    'release-asset',
    'tag',
    'commit',
    'branch',
    'registry',
    'other',
    'legacy',
    'external',
    'local',
  ]),
  repositoryUrl: HttpsUrl.optional(),
  downloadUrl: HttpsUrl.optional(),
  finalUrl: HttpsUrl.optional(),
  releaseTag: z.string().max(200).optional(),
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  downloadedAt: z.iso.datetime().optional(),
  sha256: HashSchema.optional(),
  packageId: z.uuid().optional(),
  packageVersion: z.string().max(100).optional(),
  provider: z.string().optional(),
  namespace: z.string().optional(),
  packageName: z.string().optional(),
});
export type InstallationSource = z.infer<typeof InstallationSourceSchema>;
export const InstalledFileSchema = z.object({
  root: RootSchema,
  path: RelativePath,
  operation: z.enum(['created', 'replaced']),
  installedHash: HashSchema,
  originalHash: HashSchema.optional(),
  backupPath: RelativePath.optional(),
});
export type InstalledFileRecord = z.infer<typeof InstalledFileSchema>;
export const RecordSchema = z
  .object({
    modId: ModId,
    title: z.string(),
    modVersion: z.string(),
    installedAt: z.iso.datetime(),
    files: z.array(InstalledFileSchema).min(1),
    dependencies: z.array(DependencySchema),
    source: HttpsUrl.optional(),
    provenance: InstallationSourceSchema.optional(),
    disabled: z.boolean().default(false),
    adopted: z.boolean().default(false),
    folderName: SafeName,
    transactionId: z.string(),
    metadataId: z.string().optional(),
    packageVersion: z.string().max(100).optional(),
    automaticallyInstalled: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.files.map((f) => `${f.root}:${f.path.toLowerCase()}`)).size !== r.files.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate owned files' });
    for (const f of r.files)
      if (f.operation === 'replaced' && (!f.backupPath || !f.originalHash))
        ctx.addIssue({ code: 'custom', message: 'Replacement is missing its original backup' });
  });
export type InstallationRecord = z.infer<typeof RecordSchema>;
export const StateSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    settings: SettingsSchema,
    installations: z.array(RecordSchema),
    lastTransaction: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const owners = s.installations.flatMap((r) =>
      r.files.map((f) => `${f.root}:${f.path.toLowerCase()}`),
    );
    if (
      new Set(owners).size !== owners.length ||
      new Set(s.installations.map((r) => r.modId)).size !== s.installations.length
    )
      ctx.addIssue({ code: 'custom', message: 'Conflicting installation ownership' });
  });
export type AppState = z.infer<typeof StateSchema>;
export type ModState =
  | 'not-installed'
  | 'installed'
  | 'disabled'
  | 'update-available'
  | 'installing'
  | 'updating'
  | 'broken'
  | 'unmanaged';
export interface LocalMod {
  id: string;
  title: string;
  version?: string;
  state: ModState;
  managed: boolean;
  folderName: string;
  canAdopt: boolean;
  problems: string[];
  dependencies?: DependencyRequirement[];
  catalogueId?: string;
  metadataId?: string;
  provenance?: InstallationSource;
  availabilityReason?: string;
  releaseWarning?: string;
  repositoryUrl?: string;
  canDisable?: boolean;
  packageVersionUnknown?: boolean;
  deprecated?: boolean;
  files?: Pick<InstalledFileRecord, 'root' | 'path' | 'operation'>[];
}
export interface TrustState {
  checkedAt?: string;
  fresh: boolean;
  error?: string;
}
export interface Catalogue {
  mods: ModDefinition[];
  fetchedAt?: string;
  stale: boolean;
  refreshing: boolean;
  error?: string;
  rejected: number;
}
export interface Snapshot {
  appUpdate?: {
    checking: boolean;
    checkedAt?: string;
    version?: string;
    releaseUrl?: string;
    downloadUrl?: string;
    error?: string;
  };
  settings: Settings;
  validation?: PathValidationResult;
  catalogue: Catalogue;
  localMods: LocalMod[];
  prerequisites: Prerequisite[];
  candidates: GameCandidate[];
  platform: string;
  arch: string;
  appVersion: string;
  electronVersion: string;
  safetyError?: string;
  discoveryError?: string;
  preview?: boolean;
  operationReport?: OperationReport;
  trust?: TrustState;
}
export interface OperationReport {
  title: string;
  retainedFiles: string[];
  cleanupProblems: string[];
}
export interface Progress {
  modId: string;
  phase:
    | 'downloading'
    | 'validating'
    | 'planning'
    | 'backing-up'
    | 'installing'
    | 'rolling-back'
    | 'complete';
  percent?: number;
}
export interface FileConflict {
  root: FileRoot;
  path: string;
  reason: string;
  owner?: string;
  canRestore: boolean;
}
export interface AppError {
  message: string;
  details?: string;
  conflicts?: FileConflict[];
  requirements?: DependencyStatus[];
  unverifiedPrerequisites?: DependencyStatus[];
  retryable?: boolean;
  confirmation?: { token: string; plan: InstallPlan };
}
export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type ModAction = 'install' | 'update' | 'uninstall' | 'disable' | 'enable' | 'adopt';
export type UnverifiedPrerequisite = Pick<
  DependencyStatus,
  'id' | 'versionConstraint' | 'installedVersion' | 'packageId'
>;
export interface ConflictDecision {
  root: FileRoot;
  path: string;
  action: 'keep' | 'restore';
}
export interface PlannedFile {
  root: FileRoot;
  path: string;
  source?: string;
  hash?: string;
}
export interface PlannedReplacement extends PlannedFile {
  previousHash: string;
}
export interface InstallPlan {
  modId: string;
  version: string;
  create: PlannedFile[];
  replace: PlannedReplacement[];
  remove: PlannedFile[];
  prerequisites: DependencyStatus[];
  conflicts: FileConflict[];
  packages?: { id: string; title: string; version: string; update: boolean; source?: string }[];
}
export interface ModatroApi {
  checkAppUpdates?(): Promise<Reply<Snapshot>>;
  githubStars?(): Promise<Reply<Record<string, number>>>;
  snapshot(): Promise<Reply<Snapshot>>;
  refresh(): Promise<Reply<Snapshot>>;
  detect(): Promise<Reply<Snapshot>>;
  choosePath(kind: 'game' | 'mods'): Promise<Reply<Snapshot>>;
  selectCandidate(path: string): Promise<Reply<Snapshot>>;
  saveSettings(
    settings: Pick<Settings, 'theme' | 'setupComplete' | 'modIndexUrl'>,
  ): Promise<Reply<Snapshot>>;
  action(
    id: string,
    action: ModAction,
    decisions?: ConflictDecision[],
    confirmationToken?: string,
    acceptedUnverified?: UnverifiedPrerequisite[],
  ): Promise<Reply<Snapshot>>;
  cancel(): Promise<Reply<void>>;
  previewPlan?(id: string): Promise<Reply<InstallPlan>>;
  openFolder(kind: 'game' | 'mods' | 'logs' | 'backups' | 'cache'): Promise<Reply<void>>;
  openModFolder?(id: string): Promise<Reply<void>>;
  openLink(url: string): Promise<Reply<void>>;
  launch(modded: boolean): Promise<Reply<void>>;
  diagnostics(): Promise<Reply<string>>;
  importDefinition(): Promise<Reply<Snapshot>>;
  onProgress(callback: (progress: Progress) => void): () => void;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
}
