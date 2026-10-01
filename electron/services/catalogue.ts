import { z } from 'zod';
import { Catalogue, HttpsUrl, ModDefinition, ModSchema, SafeName } from '../../src/shared/model';
import { UserError } from './errors';
import { remoteJson, remoteText } from './network';
import { Logger, Storage } from './storage';
const SourceSchema = z.object({
  title: z.string().min(1),
  author: z.string().min(1),
  repo: HttpsUrl,
  downloadURL: HttpsUrl,
  version: z.string().min(1),
  categories: z.array(z.string()).min(1),
  folderName: SafeName.optional(),
  'requires-steamodded': z.boolean(),
  'requires-talisman': z.boolean(),
  'last-updated': z.number().optional(),
});
const TreeSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })).min(1),
});
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  fetchedAt: z.iso.datetime(),
  mods: z.array(ModSchema).min(1),
  rejected: z.number().int().nonnegative(),
});
const CommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  commit: z.object({ tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }),
});
export interface ModRepository {
  getMods(): Promise<ModDefinition[]>;
  refresh(): Promise<void>;
}
export function normalizeCategory(value: string): string {
  return (
    ({ Joker: 'Jokers', API: 'APIs', Extension: 'Extensions' } as Record<string, string>)[value] ??
    value
  );
}
export function sourceId(folder: string): string {
  return folder
    .replace(/[^a-zA-Z0-9_@.+ -]/g, '-')
    .replace(/[. ]+$/, '')
    .slice(0, 120);
}
export function normalizeMod(
  folder: string,
  metadata: unknown,
  description?: string,
): ModDefinition {
  const s = SourceSchema.parse(metadata);
  const prerequisites = [];
  if (s['requires-steamodded'])
    prerequisites.push({ id: 'Steamodded', displayName: 'Steamodded', required: true });
  if (s['requires-talisman'])
    prerequisites.push({ id: 'Talisman', displayName: 'Talisman', required: true });
  return ModSchema.parse({
    id: sourceId(folder),
    title: s.title,
    author: s.author,
    version: s.version,
    repositoryUrl: s.repo,
    downloadUrl: s.downloadURL,
    folderName: s.folderName,
    categories: s.categories.map(normalizeCategory),
    sourceCategories: s.categories,
    prerequisites,
    description,
    updatedAt: s['last-updated'],
    installation: { type: 'auto' },
  });
}
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (index < items.length) {
        const i = index++;
        output[i] = await callback(items[i]!);
      }
    }),
  );
  return output;
}
export class BalatroModIndexRepository implements ModRepository {
  catalogue: Catalogue = { mods: [], stale: true, refreshing: false, rejected: 0 };
  private refreshing?: Promise<void>;
  constructor(
    private storage: Storage,
    private logger: Logger,
    private changed: () => void = () => {},
    private json = remoteJson,
    private text = remoteText,
  ) {}
  async loadCache() {
    try {
      const current = await this.storage.read('catalogue-cache/catalogue.json', CacheSchema);
      const cache = current ?? (await this.storage.read('cache/catalogue.json', CacheSchema));
      if (cache) this.catalogue = { ...cache, stale: true, refreshing: false };
      // Preserve the offline catalogue from versions that shared Electron's
      // Cache directory. Leave Chromium's files and the legacy copy untouched.
      if (cache && !current) await this.storage.write('catalogue-cache/catalogue.json', cache);
    } catch (e) {
      await this.logger.log('catalogue.cache.invalid', String(e));
      this.catalogue.error =
        'The cached catalogue could not be verified. Refresh to download a new copy.';
    }
  }
  async getMods() {
    return this.catalogue.mods;
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchCatalogue();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async fetchCatalogue() {
    this.catalogue.refreshing = true;
    this.changed();
    await this.logger.log('catalogue.refresh.start');
    try {
      const commit = CommitSchema.parse(
        await this.json('https://api.github.com/repos/skyline69/balatro-mod-index/commits/main'),
      );
      const tree = TreeSchema.parse(
        await this.json(
          `https://api.github.com/repos/skyline69/balatro-mod-index/git/trees/${commit.commit.tree.sha}?recursive=1`,
        ),
      );
      if (tree.sha !== commit.commit.tree.sha)
        throw new UserError(
          'The index tree does not match its selected commit. Keeping the previous catalogue.',
        );
      const entries = tree.tree.filter(
        (e) => e.type === 'blob' && /^mods\/[^/]+\/meta\.json$/.test(e.path),
      );
      if (!entries.length || entries.length > 10000)
        throw new UserError(
          'The downloaded catalogue is empty or incomplete. Keeping the previous catalogue.',
        );
      const paths = new Set(tree.tree.map((e) => e.path));
      let rejected = 0;
      const mods = await mapConcurrent(entries, 6, async (entry) => {
        const folder = entry.path.split('/')[1]!;
        const base = `https://raw.githubusercontent.com/skyline69/balatro-mod-index/${commit.sha}/mods/${encodeURIComponent(folder)}`;
        // Transport failures abort the entire refresh; a malformed individual
        // record becomes unavailable without concealing a partial download.
        const raw = await this.text(`${base}/meta.json`);
        const description = paths.has(`mods/${folder}/description.md`)
          ? await this.text(`${base}/description.md`)
          : undefined;
        try {
          return normalizeMod(folder, JSON.parse(raw), description);
        } catch (e) {
          rejected++;
          await this.logger.log('catalogue.mod.invalid', {
            id: sourceId(folder),
            reason: String(e),
          });
          return ModSchema.parse({
            id: sourceId(folder),
            title: folder.replace('@', ' / '),
            author: 'Unknown',
            version: 'Unknown',
            downloadUrl: `https://github.com/skyline69/balatro-mod-index`,
            repositoryUrl: 'https://github.com/skyline69/balatro-mod-index',
            categories: ['Unavailable'],
            prerequisites: [],
            unavailableReason:
              'The index metadata could not be verified. Automatic installation is unavailable.',
            installation: { type: 'unsupported' },
          });
        }
      });
      if (
        new Set(mods.map((m) => m.id.toLowerCase())).size !== mods.length ||
        rejected === mods.length
      )
        throw new UserError(
          'The catalogue contains invalid or conflicting entries. Keeping the previous catalogue.',
        );
      const cache = CacheSchema.parse({
        schemaVersion: 1,
        fetchedAt: new Date().toISOString(),
        mods,
        rejected,
      });
      await this.storage.write('catalogue-cache/catalogue.json', cache);
      this.catalogue = { ...cache, stale: false, refreshing: false };
      await this.logger.log('catalogue.refresh.complete', { count: mods.length, rejected });
    } catch (e) {
      this.catalogue = {
        ...this.catalogue,
        stale: true,
        refreshing: false,
        error: e instanceof Error ? e.message : 'The catalogue could not be refreshed.',
      };
      await this.logger.log('catalogue.refresh.failed', String(e));
    } finally {
      this.changed();
    }
  }
}
