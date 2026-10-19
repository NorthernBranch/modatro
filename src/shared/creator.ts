import { z } from 'zod';
import type { ModDefinition } from './model';

export const CREATOR_TARGET = '26.1002.0';
export const SAVE_NOTICE =
  'Mods can cause crashes or affect your saves. Back up your Balatro saves before installing or updating mods.';
export const CREATOR_DISCLAIMER =
  'The Mod Creator is experimental. Generated or custom mods may crash Balatro, conflict with other mods or affect your saves. Back up your saves before testing. Custom Lua runs as code inside the game; only use code you trust. Validation cannot guarantee that a mod is safe or works correctly.';
export const SAVE_GUIDANCE =
  'Close Balatro before copying saves. Copy the entire Balatro save-data folder, including its numbered profile folders, to a separate location. On Windows it is normally %APPDATA%/Balatro; on macOS ~/Library/Application Support/Balatro; on Linux/Proton use the matching Steam compatdata prefix and its AppData/Roaming/Balatro folder. A custom Mods folder may be elsewhere. Modatro’s mod-file backups do not back up these saves.';
export const RecipeSchema = z.enum(['blank', 'joker-mult', 'joker-chips', 'joker-suit', 'deck']);
export const recipes = [
  { id: 'blank', name: 'Blank Steamodded mod' },
  { id: 'joker-mult', name: 'Joker · fixed Mult' },
  { id: 'joker-chips', name: 'Joker · fixed Chips' },
  { id: 'joker-suit', name: 'Joker · scored suit Mult' },
  { id: 'deck', name: 'Deck · starting bonuses' },
] as const;
export const CreatorId = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine(
    (v) =>
      !['steamodded', 'smods', 'lovely', 'balatro', 'talisman'].includes(v.toLowerCase()) &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v),
    'Choose a unique portable mod ID, not a prerequisite or reserved filename.',
  );
export const CreatorPrefix = z
  .string()
  .min(3)
  .max(16)
  .regex(/^[a-z][a-z0-9_]*$/);
export const CropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    zoom: z.number().min(1).max(8),
  })
  .strict();
export const CreatorDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    author: z.string().trim().min(1).max(80),
    description: z.string().max(2000),
    version: z
      .string()
      .max(32)
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    modId: CreatorId,
    prefix: CreatorPrefix,
    recipe: RecipeSchema,
    amount: z.number().int().min(0).max(100000),
    suit: z.enum(['Hearts', 'Diamonds', 'Clubs', 'Spades']),
    dollars: z.number().int().min(0).max(1000),
    hands: z.number().int().min(0).max(10),
    discards: z.number().int().min(0).max(10),
    mode: z.enum(['template', 'custom']),
    lua: z
      .string()
      .max(128 * 1024)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 128 * 1024,
        'Lua source exceeds 128 KiB in UTF-8.',
      ),
    crop: CropSchema,
  })
  .strict()
  .refine(
    (v) => !['joker-mult', 'joker-suit'].includes(v.recipe) || v.amount <= 1000,
    'Mult must be between 0 and 1000.',
  );
export type CreatorDraft = z.infer<typeof CreatorDraftSchema>;
export const CreatorOriginSchema = z
  .object({ projectId: z.uuid(), buildId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type CreatorOrigin = z.infer<typeof CreatorOriginSchema>;
export const CreatorBuildSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
    version: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type CreatorBuild = z.infer<typeof CreatorBuildSchema>;
export const CreatorProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    draft: CreatorDraftSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    artHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    builds: z.array(CreatorBuildSchema).max(1000),
  })
  .strict();
export type CreatorStoredProject = z.infer<typeof CreatorProjectSchema>;
export interface CreatorProject extends CreatorStoredProject {
  token: string;
  externalChanges?: boolean;
  artwork?: { dataUrl: string; width: number; height: number };
  previewUrl: string;
  installedBuild?: string;
}
export interface CreatorSummary {
  id: string;
  name: string;
  updatedAt: string;
  builds: number;
  installedBuild?: string;
}
const projectRequest = { id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) };
export const CreatorRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z
    .object({
      operation: z.literal('create'),
      name: z.string().trim().min(1).max(80),
      author: z.string().trim().min(1).max(80),
      recipe: RecipeSchema,
    })
    .strict(),
  z.object({ operation: z.literal('load'), id: z.uuid() }).strict(),
  z
    .object({
      operation: z.literal('save'),
      ...projectRequest,
      draft: CreatorDraftSchema,
      regenerate: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('build'), ...projectRequest }).strict(),
  z.object({ operation: z.literal('import-art'), ...projectRequest }).strict(),
  z.object({ operation: z.literal('reset-art'), ...projectRequest }).strict(),
  z.object({ operation: z.literal('delete'), ...projectRequest }).strict(),
  z.object({ operation: z.literal('open'), id: z.uuid() }).strict(),
  z
    .object({
      operation: z.literal('export'),
      id: z.uuid(),
      buildId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      operation: z.literal('prepare-install'),
      id: z.uuid(),
      buildId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type CreatorRequest = z.infer<typeof CreatorRequestSchema>;
export interface CreatorResponse {
  projects: CreatorSummary[];
  project?: CreatorProject;
  definition?: ModDefinition;
  exported?: boolean;
}
export function creatorIdentities(id: string) {
  const suffix = id.replaceAll('-', '').slice(0, 12);
  return { modId: `modatro_${suffix}`, prefix: `mc_${suffix}` };
}
export function recipeDescription(d: CreatorDraft) {
  if (d.recipe === 'deck')
    return `At the start of a new run: +$${d.dollars}, +${d.hands} hands per round and +${d.discards} discards per round. These are bonuses to the run’s normal starting values.`;
  if (d.recipe === 'joker-suit')
    return `Each scored ${d.suit} card gives +${d.amount} Mult. Retriggered scored cards apply the effect again.`;
  if (d.recipe === 'blank')
    return 'A blank Steamodded entry point, ready for your own trusted Lua.';
  return `Gives +${d.amount} ${d.recipe === 'joker-chips' ? 'Chips' : 'Mult'} during Joker scoring for each played hand.`;
}
export function cropRectangle(width: number, height: number, crop: CreatorDraft['crop']) {
  const w = Math.min(width, (height * 71) / 95) / crop.zoom;
  const h = (w * 95) / 71;
  return { x: (width - w) * crop.x, y: (height - h) * crop.y, width: w, height: h };
}
