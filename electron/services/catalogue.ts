import { z } from 'zod';
import { Catalogue, ModDefinition, ModSchema } from '../../src/shared/model';
import { UserError } from './errors';
import { remoteJson, remoteThunderstoreJson } from './network';
import { normalizeThunderstore, thunderstoreId } from '../../src/shared/thunderstore';
import { Logger, Storage } from './storage';
import { CatalogueOverridesSchema, NativeCatalogueSchema } from '../../src/shared/catalogue-schema';
import overridesBaseline from '../../catalogue/overrides.json';
import { allowedDescription } from '../../src/shared/trust';
import { readAuthorManifest, readLatestGitHubRelease } from './distribution';
import type { CatalogueOptions, ModSource } from './sources/mod-source';
import { readThunderstoreCatalogue } from './sources/thunderstore-client';
const CacheSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  fetchedAt: z.iso.datetime(),
  mods: z.array(ModSchema).min(1),
  rejected: z.number().int().nonnegative(),
});
export interface ModRepository {
  getMods(): Promise<ModDefinition[]>;
  refresh(): Promise<void>;
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
export class ThunderstoreModSource implements ModRepository, ModSource {
  readonly id = 'thunderstore';
  readonly displayName = 'Thunderstore';
  catalogue: Catalogue = { mods: [], stale: true, refreshing: false, rejected: 0 };
  private refreshing?: Promise<void>;
  constructor(
    private storage: Storage,
    private logger: Logger,
    private changed: () => void = () => {},
    private json = remoteThunderstoreJson,
  ) {}
  async loadCache() {
    try {
      const cache = await this.storage.read(
        'catalogue-cache/thunderstore.json',
        CacheSchema.extend({ mods: z.array(ModSchema) }),
      );
      if (cache) {
        if (cache.mods.some((mod) => !mod.thunderstore)) throw new Error('Invalid registry cache.');
        this.catalogue = {
          ...cache,
          mods: cache.mods.map((mod) =>
            ModSchema.parse({
              ...mod,
              source: mod.source ?? {
                provider: 'thunderstore',
                externalId: thunderstoreId(mod.thunderstore!.namespace, mod.thunderstore!.name),
                namespace: mod.thunderstore!.namespace,
                packageName: mod.thunderstore!.name,
                url: mod.thunderstore!.packageUrl,
              },
            }),
          ),
          stale: true,
          refreshing: false,
        };
        return;
      }
      // Existing users retain offline discovery until their first registry refresh.
      // Never contact the discontinued index, or offer its cached entries as new downloads.
      const old =
        (await this.storage.read('catalogue-cache/catalogue.json', CacheSchema)) ??
        (await this.storage.read('cache/catalogue.json', CacheSchema));
      if (old)
        this.catalogue = {
          ...old,
          stale: true,
          refreshing: false,
          mods: old.mods.map((mod) => ({
            ...mod,
            description: allowedDescription(mod),
            unavailableReason:
              'This archived catalogue entry has no current source. Refresh to load Thunderstore; existing files remain manageable.',
          })),
        };
    } catch (error) {
      this.catalogue.error =
        'The cached catalogue could not be verified. Refresh to download a new copy.';
      await this.logger.log('catalogue.cache.invalid', String(error));
    }
  }
  async getMods() {
    return this.catalogue.mods;
  }
  async getCatalogue(options?: CatalogueOptions) {
    if (options?.refresh) await this.refresh();
    return this.getMods();
  }
  async getMod(id: string) {
    return (
      this.catalogue.mods.find((mod) => mod.id === id || mod.source?.externalId === id) ?? null
    );
  }
  async getVersions(id: string) {
    return (await this.getMod(id))?.versions ?? [];
  }
  async refresh() {
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
    await this.logger.log('catalogue.thunderstore.started');
    try {
      const feed = z
        .array(z.unknown())
        .min(1)
        .max(10000)
        .parse(await readThunderstoreCatalogue(this.json));
      let rejected = 0,
        valid = 0;
      const mods: ModDefinition[] = [];
      for (const raw of feed) {
        try {
          const mod = normalizeThunderstore(raw);
          valid++;
          if (mod) mods.push(mod);
        } catch (error) {
          rejected++;
          await this.logger.log('catalogue.thunderstore.invalid', String(error));
        }
      }
      if (
        !valid ||
        rejected > valid ||
        new Set(mods.map((mod) => mod.id.toLowerCase())).size !== mods.length ||
        new Set(mods.map((mod) => mod.thunderstore!.packageId)).size !== mods.length
      )
        throw new UserError(
          'Thunderstore returned invalid or conflicting package records. Keeping the previous catalogue.',
        );
      const cache = { schemaVersion: 2, fetchedAt: new Date().toISOString(), mods, rejected };
      await this.storage.write('catalogue-cache/thunderstore.json', cache);
      this.catalogue = { ...cache, stale: false, refreshing: false };
      await this.logger.log('catalogue.thunderstore.complete', { count: mods.length, rejected });
    } catch (error) {
      this.catalogue = {
        ...this.catalogue,
        stale: true,
        refreshing: false,
        error: error instanceof Error ? error.message : 'Thunderstore could not be refreshed.',
      };
      await this.logger.log('catalogue.thunderstore.failed', String(error));
    } finally {
      this.changed();
    }
  }
  async assertAvailable(mod: ModDefinition) {
    if (!mod.thunderstore) return;
    if (
      this.catalogue.stale ||
      !this.catalogue.fetchedAt ||
      Date.now() - Date.parse(this.catalogue.fetchedAt) > 15 * 60 * 1000
    )
      await this.refresh();
    if (this.catalogue.stale)
      throw new UserError(
        'Thunderstore could not be checked. Your cached catalogue is available for browsing; connect and refresh before installing or updating.',
      );
    const current = this.catalogue.mods.find(
      (entry) => entry.thunderstore?.packageId === mod.thunderstore!.packageId,
    );
    if (
      !current ||
      current.thunderstore?.versionId !== mod.thunderstore.versionId ||
      current.thunderstore?.namespace !== mod.thunderstore.namespace ||
      current.thunderstore?.name !== mod.thunderstore.name ||
      current.thunderstore?.packageVersion !== mod.thunderstore.packageVersion ||
      JSON.stringify([...current.thunderstore!.dependencies].sort()) !==
        JSON.stringify([...mod.thunderstore.dependencies].sort()) ||
      (mod.downloadProvider === 'github'
        ? current.repositoryUrl !== mod.repositoryUrl
        : current.downloadUrl !== mod.downloadUrl)
    )
      throw new UserError(
        'This registry release is no longer current or available. Refresh the catalogue before installing or updating.',
      );
  }
}

export { ThunderstoreModSource as ThunderstoreRepository };

export class NativeModRepository implements ModRepository {
  catalogue: Catalogue = { mods: [], stale: true, refreshing: false, rejected: 0 };
  overrides = CatalogueOverridesSchema.parse(overridesBaseline).overrides;
  policyCheckedAt?: string;
  private refreshing?: Promise<void>;
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
      const overrides = await this.storage.read(
        'catalogue-cache/overrides.json',
        CatalogueOverridesSchema,
      );
      if (overrides) this.overrides = overrides.overrides;
    } catch {
      this.catalogue.error = 'The native catalogue cache could not be verified.';
    }
  }
  async refresh() {
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
    try {
      const data = NativeCatalogueSchema.parse(
        await this.verifyEnvelope(await this.json(this.endpoint)),
      );
      const overrides = CatalogueOverridesSchema.parse(
        await this.json(new URL('overrides.json', this.endpoint).href),
      );
      await this.storage.write('catalogue-cache/overrides.json', overrides);
      this.overrides = overrides.overrides;
      this.policyCheckedAt = new Date().toISOString();
      let rejected = 0;
      const mods = await mapConcurrent(data.mods, 6, async (entry) => {
        const definition = ModSchema.parse({
          ...entry,
          version: entry.version ?? 'Unknown',
          approvalStatus: entry.approvalStatus ?? 'pending-review',
          downloadUrl: entry.downloadUrl ?? entry.repositoryUrl ?? entry.manifestUrl,
        });
        try {
          const manifest = await readAuthorManifest(definition, this.json);
          return await readLatestGitHubRelease(manifest, this.json);
        } catch (error) {
          rejected++;
          await this.logger.log('catalogue.github.unavailable', {
            id: entry.id,
            error: String(error),
          });
          const old = this.catalogue.mods.find((mod) => mod.id === entry.id);
          return ModSchema.parse({
            ...definition,
            version: old?.version ?? definition.version,
            unavailableReason:
              'The author manifest or release could not be checked. Refresh to try again; existing installations are unchanged.',
          });
        }
      });
      const cache = { schemaVersion: 1, mods, fetchedAt: new Date().toISOString(), rejected };
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
  readonly thunderstore: ThunderstoreModSource;
  readonly native: NativeModRepository;
  private refreshing?: Promise<void>;
  constructor(
    storage: Storage,
    logger: Logger,
    private changed: () => void = () => {},
  ) {
    this.thunderstore = new ThunderstoreModSource(storage, logger, changed);
    this.native = new NativeModRepository(storage, logger);
  }
  get catalogue(): Catalogue {
    const native =
        process.env.ENABLE_LEGACY_BMI_SOURCE === 'true'
          ? this.native.catalogue
          : {
              ...this.native.catalogue,
              mods: [],
              stale: false,
              rejected: 0,
              error: undefined,
              fetchedAt: undefined,
            },
      registry = this.thunderstore.catalogue;
    const replacements = new Set(
      native.mods
        .flatMap((mod) => [mod.id, ...(mod.legacyIds ?? [])])
        .map((id) => id.toLowerCase()),
    );
    return {
      mods: [
        ...native.mods,
        ...registry.mods
          .map((mod) => {
            const matches = this.native.overrides.filter(
              (entry) =>
                entry.package?.toLowerCase() === mod.id.toLowerCase() ||
                (!!entry.packageId && entry.packageId === mod.thunderstore?.packageId),
            );
            if (matches.length > 1)
              return {
                ...mod,
                policyReason:
                  'Conflicting registry overrides require review before installation or updating.',
              };
            const override = matches[0];
            if (!override) return mod;
            const { package: _package, packageId: _packageId, ...changes } = override;
            return ModSchema.parse({ ...mod, ...changes });
          })
          .filter(
            (mod) =>
              ![mod.id, ...(mod.legacyIds ?? [])].some((id) => replacements.has(id.toLowerCase())),
          ),
      ],
      fetchedAt: [native.fetchedAt, registry.fetchedAt].filter((v): v is string => !!v).sort()[0],
      stale: native.stale || registry.stale,
      refreshing: !!this.refreshing || registry.refreshing,
      rejected: native.rejected + registry.rejected,
      error: [native.error, registry.error].filter(Boolean).join('\n') || undefined,
    };
  }
  async getMods() {
    return this.catalogue.mods;
  }
  async assertAvailable(mod: ModDefinition) {
    if (process.env.ENABLE_LEGACY_BMI_SOURCE !== 'true') {
      await this.thunderstore.assertAvailable(mod);
      return;
    }
    if (
      !this.native.policyCheckedAt ||
      Date.now() - Date.parse(this.native.policyCheckedAt) > 15 * 60 * 1000
    )
      await this.native.refresh();
    if (
      !this.native.policyCheckedAt ||
      Date.now() - Date.parse(this.native.policyCheckedAt) > 15 * 60 * 1000
    )
      throw new UserError(
        'Catalogue permissions could not be checked. Connect and refresh before installing or updating.',
      );
    await this.thunderstore.assertAvailable(mod);
  }
  async loadCache() {
    await this.thunderstore.loadCache();
    if (process.env.ENABLE_LEGACY_BMI_SOURCE === 'true') await this.native.loadCache();
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all([
      ...(process.env.ENABLE_LEGACY_BMI_SOURCE === 'true' ? [this.native.refresh()] : []),
      this.thunderstore.refresh(),
    ]).then(() => undefined);
    this.changed();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
      this.changed();
    }
  }
}
