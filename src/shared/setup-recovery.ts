import { z } from 'zod';
import type { Snapshot } from './model';

export const SetupRecoveryMode = z.enum(['missing', 'reset']);
export type SetupRecoveryMode = z.infer<typeof SetupRecoveryMode>;
export const SetupRecoveryRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('review'), mode: SetupRecoveryMode }).strict(),
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
}
export type SetupRecoveryResult =
  | { status: 'review'; plan: SetupRecoveryPlan }
  | { status: 'complete'; snapshot: Snapshot; backupFolder: string };
