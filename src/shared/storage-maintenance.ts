import { z } from 'zod';

export const StorageMaintenanceRequest = z.union([
  z.object({ operation: z.enum(['inspect', 'clean']) }).strict(),
  z.object({ operation: z.literal('delete'), id: z.union([z.uuid(), z.literal('all')]) }).strict(),
]);
export type StorageMaintenanceRequest = z.infer<typeof StorageMaintenanceRequest>;
export interface StorageMaintenanceStatus {
  snapshots: {
    id: string;
    createdAt: string;
    mode: string;
    sizeBytes: number;
    protected: boolean;
    complete: boolean;
  }[];
  sizeBytes: number;
  warnings: string[];
}
