import { z } from 'zod';

export const ProfileName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v), 'Use a name without control characters');
export const SelectionSchema = z
  .array(z.object({ id: z.string().min(1).max(200), enabled: z.boolean() }).strict())
  .max(10000)
  .refine((v) => new Set(v.map((e) => e.id)).size === v.length, 'Duplicate mod identity');
export type Selection = z.infer<typeof SelectionSchema>;
export const ProfileSchema = z
  .object({ id: z.uuid(), name: ProfileName, selection: SelectionSchema })
  .strict();
export const ProfilesSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeId: z.uuid(),
    items: z.array(ProfileSchema).min(1).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !v.items.some((p) => p.id === v.activeId) ||
      new Set(v.items.map((p) => p.id)).size !== v.items.length ||
      new Set(v.items.map((p) => p.name.normalize('NFKC').toLowerCase())).size !== v.items.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Profiles must have unique names and identities and a valid active profile',
      });
  });
export type Profiles = z.infer<typeof ProfilesSchema>;
export interface ProfileSummary extends Profiles {
  unsaved: boolean;
  differences: string[];
  unmanagedCount: number;
}
export const ProfileOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), name: ProfileName }).strict(),
  z.object({ operation: z.literal('rename'), id: z.uuid(), name: ProfileName }).strict(),
  z.object({ operation: z.literal('duplicate'), id: z.uuid(), name: ProfileName }).strict(),
  z
    .object({
      operation: z.literal('delete'),
      id: z.uuid(),
      preserveCurrent: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('save'), id: z.uuid() }).strict(),
]);
export type ProfileOperation = z.infer<typeof ProfileOperationSchema>;
export const ProfilePlanSchema = z
  .object({
    profileId: z.uuid(),
    name: ProfileName,
    token: z.uuid(),
    expiresAt: z.iso.datetime(),
    enable: z.array(z.string()).max(10000),
    disable: z.array(z.string()).max(10000),
    retained: z.array(z.string()).max(10000),
    selection: SelectionSchema,
    blockers: z.array(z.string()).max(10000),
    warnings: z.array(z.string()).max(10000),
  })
  .strict();
export type ProfilePlan = z.infer<typeof ProfilePlanSchema>;
export const ProfileConfirmationSchema = z
  .object({ profileId: z.uuid(), token: z.uuid() })
  .strict();
export const ReportSections = ['setup', 'profile', 'mods', 'findings', 'history'] as const;
export type ReportSection = (typeof ReportSections)[number];
export const DiagnosticRequestSchema = z
  .object({
    logIds: z.array(z.string().min(1).max(100)).max(5).default([]),
    reportSections: z.array(z.enum(ReportSections)).max(5).optional(),
  })
  .strict();
export type DiagnosticRequest = z.infer<typeof DiagnosticRequestSchema>;
export const ReportExportSchema = z.object({ text: z.string().max(100000) }).strict();
export interface Finding {
  kind: 'problem' | 'warning' | 'possible';
  observed: string;
  why: string;
  next: string;
  action: 'prerequisites' | 'installed' | 'profiles' | 'logs';
  modId?: string;
}
export interface DiagnosticLog {
  id: string;
  name: string;
  source: string;
  modifiedAt?: string;
  stale?: boolean;
  excerpt?: string;
  error?: string;
}
export const HistorySchema = z
  .array(
    z
      .object({
        id: z.uuid(),
        time: z.iso.datetime(),
        type: z.string().max(80),
        ids: z.array(z.string().max(200)).max(10000),
        outcome: z.enum(['success', 'failed', 'uncertain']),
        versions: z
          .array(
            z.object({
              id: z.string().max(200),
              before: z.string().max(200).optional(),
              after: z.string().max(200).optional(),
            }),
          )
          .max(10000),
        profile: z.string().max(60).optional(),
      })
      .strict(),
  )
  .max(100);
export type OperationHistory = z.infer<typeof HistorySchema>;
export interface Troubleshooting {
  generatedAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  gameVersion?: string;
  prerequisites: { id: string; installed: boolean; version?: string }[];
  mods: { id: string; title: string; version?: string; enabled?: boolean; managed: boolean }[];
  profile?: ProfileSummary;
  findings: Finding[];
  history: OperationHistory;
  historyError?: string;
  logs: DiagnosticLog[];
  report: string;
}
