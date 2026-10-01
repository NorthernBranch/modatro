import { z } from 'zod';
import { Catalogue, HttpsUrl, ModDefinition, ModSchema, SafeName } from '../../src/shared/model';
import { UserError } from './errors';
import { remoteJson, remoteText } from './network';
import { Logger, Storage } from './storage';
import { NativeCatalogueSchema } from '../../src/shared/catalogue-schema';
import { allowedDescription, sourceType } from '../../src/shared/trust';
import { readAuthorManifest } from './distribution';
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
  _description?: string,
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
    approvalStatus: 'legacy-index',
    releaseSource: { sourceType: sourceType(s.downloadURL) },
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
      if (cache)
        this.catalogue = {
          ...cache,
          mods: cache.mods.map((mod) => ({
            ...mod,
            approvalStatus: mod.approvalStatus ?? 'legacy-index',
            description: allowedDescription(mod),
          })),
          stale: true,
          refreshing: false,
        };
      // Preserve the offline catalogue from versions that shared Electron's
      // Cache directory. Leave Chromium's files and the legacy copy untouched.
      if (cache)
        await this.storage.write('catalogue-cache/catalogue.json', {
          ...cache,
          mods: this.catalogue.mods,
        });
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
      let rejected = 0;
      const mods = await mapConcurrent(entries, 6, async (entry) => {
        const folder = entry.path.split('/')[1]!;
        const base = `https://raw.githubusercontent.com/skyline69/balatro-mod-index/${commit.sha}/mods/${encodeURIComponent(folder)}`;
        // Transport failures abort the entire refresh; a malformed individual
        // record becomes unavailable without concealing a partial download.
        const raw = await this.text(`${base}/meta.json`);
        try {
          return normalizeMod(folder, JSON.parse(raw));
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

export class NativeModRepository implements ModRepository {
  catalogue: Catalogue = { mods: [], stale: true, refreshing: false, rejected: 0 };
  constructor(
    private storage: Storage,
    private logger: Logger,
    private json = remoteJson,
    private endpoint = 'https://raw.githubusercontent.com/NorthernBranch/modatro/main/catalogue/index.json',
    private verifyEnvelope: (payload: unknown) => Promise<unknown> = async (payload) => payload,
  ) {}
  async getMods() {
    return this.catalogue.mods;
  }
  async loadCache() {
    try {
      const cache = await this.storage.read(
        'catalogue-cache/native.json',
        CacheSchema.extend({ mods: z.array(ModSchema) }),
      );
      if (cache) this.catalogue = { ...cache, stale: true, refreshing: false };
    } catch {
      this.catalogue.error = 'The native catalogue cache could not be verified.';
    }
  }
  async refresh() {
    this.catalogue.refreshing = true;
    try {
      const data = NativeCatalogueSchema.parse(
        await this.verifyEnvelope(await this.json(this.endpoint)),
      );
      const mods = await mapConcurrent(data.mods, 6, async (entry) => {
        const definition = ModSchema.parse({
          ...entry,
          approvalStatus: entry.approvalStatus ?? 'pending-review',
          downloadUrl: entry.downloadUrl ?? entry.repositoryUrl ?? entry.manifestUrl,
        });
        return readAuthorManifest(definition, this.json);
      });
      const cache = { schemaVersion: 1, mods, fetchedAt: new Date().toISOString(), rejected: 0 };
      await this.storage.write('catalogue-cache/native.json', cache);
      this.catalogue = { ...cache, stale: false, refreshing: false };
    } catch (error) {
      this.catalogue = {
        ...this.catalogue,
        stale: true,
        refreshing: false,
        error: error instanceof Error ? error.message : 'The native catalogue could not refresh.',
      };
      await this.logger.log('catalogue.native.failed', String(error));
    }
  }
}

export class ModatroCatalogueRepository implements ModRepository {
  readonly legacy: BalatroModIndexRepository;
  readonly native: NativeModRepository;
  private refreshing?: Promise<void>;
  constructor(
    storage: Storage,
    logger: Logger,
    private changed: () => void = () => {},
  ) {
    this.legacy = new BalatroModIndexRepository(storage, logger, changed);
    this.native = new NativeModRepository(storage, logger);
  }
  get catalogue(): Catalogue {
    const native = this.native.catalogue,
      legacy = this.legacy.catalogue;
    const replacements = new Set(
      native.mods
        .flatMap((mod) => [mod.id, ...(mod.legacyIds ?? [])])
        .map((id) => id.toLowerCase()),
    );
    return {
      mods: [
        ...native.mods,
        ...legacy.mods.filter((mod) => !replacements.has(mod.id.toLowerCase())),
      ],
      fetchedAt: [native.fetchedAt, legacy.fetchedAt].filter((v): v is string => !!v).sort()[0],
      stale: native.stale || legacy.stale,
      refreshing: !!this.refreshing,
      rejected: native.rejected + legacy.rejected,
      error: [native.error, legacy.error].filter(Boolean).join('\n') || undefined,
    };
  }
  async getMods() {
    return this.catalogue.mods;
  }
  async loadCache() {
    await Promise.all([this.native.loadCache(), this.legacy.loadCache()]);
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all([this.native.refresh(), this.legacy.refresh()]).then(
      () => undefined,
    );
    this.changed();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
      this.changed();
    }
  }
}
