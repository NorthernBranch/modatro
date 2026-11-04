import { z } from 'zod';
import type { Snapshot } from './model';

export const SetupRecoveryMode = z.enum(['missing', 'reset', 'repair', 'remove']);
export type SetupRecoveryMode = z.infer<typeof SetupRecoveryMode>;
export const SetupRecoveryRequestSchema = z.union([
  z.object({ operation: z.literal('review'), mode: z.enum(['missing', 'reset']) }).strict(),
  z
    .object({
      operation: z.literal('review'),
      mode: z.enum(['inspect', 'repair', 'remove']),
      modId: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ operation: z.literal('apply'), token: z.uuid() }).strict(),
]);
export type SetupRecoveryRequest = z.infer<typeof SetupRecoveryRequestSchema>;
export interface SetupRecoveryPlan {
  mode: SetupRecoveryMode;
  token: string;
  gamePath: string;
  modsPath: string;
  records: { id: string; title: string }[];
  files: { root: 'game' | 'mods' | 'disabled'; path: string; sizeBytes: number }[];
  sizeBytes: number;
  warnings: string[];
  detectedVersion?: string;
  detectedFolder?: string;
  canAdopt?: boolean;
  removalBlocker?: string;
  adoptionReason?: string;
}
export type SetupRecoveryResult =
  | { status: 'review'; plan: SetupRecoveryPlan }
  | {
      status: 'complete';
      snapshot: Snapshot;
      backupFolder: string;
      backupKind?: 'uninstall' | 'setup';
    };
