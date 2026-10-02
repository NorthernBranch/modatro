import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ModSchema,
  HttpsUrl,
  SafeName,
  type Catalogue,
  type ModDefinition,
} from '../../src/shared/model';
import { indexLocation } from '../../src/shared/mod-index';
import { boundedBody, safeFetch, validateRemoteUrl, remoteJson } from './network';
import { Storage, Logger } from './storage';
import { UserError } from './errors';
import { validateDistribution } from './distribution';

export async function readRemoteIndex(value: string): Promise<{ id: string; data: unknown }[]> {
  const location = indexLocation(value);
  const branch = new URL(location.url).pathname.split('/tree/')[1] ?? 'HEAD';
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      await remoteJson(
        `https://api.github.com/repos/${location.repo}/commits/${encodeURIComponent(branch)}`,
      ),
    );
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(z.object({ path: z.string(), type: z.string() })).max(50000),
    })
    .parse(
      await remoteJson(
        `https://api.github.com/repos/${location.repo}/git/trees/${commit.sha}?recursive=1`,
      ),
    );
  if (tree.truncated) throw new Error('The index file listing is incomplete.');
  const paths = tree.tree.filter(
    (entry) => entry.type === 'blob' && /^mods\/[A-Za-z0-9_@.+ -]+\/meta\.json$/.test(entry.path),
  );
  if (paths.length > 10000) throw new Error('The index contains too many mods.');
  const entries: { id: string; data: unknown }[] = [];
  let total = 0;
  for (let i = 0; i < paths.length; i += 8) {
    entries.push(
      ...(await Promise.all(
        paths.slice(i, i + 8).map(async (entry) => {
          const bytes = await boundedBody(
            await safeFetch(
              `https://raw.githubusercontent.com/${location.repo}/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
            ),
            256000,
          );
          if ((total += bytes.length) > 20 * 1024 * 1024)
            throw new Error('The index metadata exceeds the size limit.');
          let data: unknown;
          try {
            data = JSON.parse(bytes.toString('utf8'));
          } catch {
            data = null;
          }
          return { id: entry.path.split('/')[1]!, data };
        }),
      )),
    );
  }
  return entries;
}

const Metadata = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  repo: HttpsUrl,
  downloadURL: HttpsUrl,
  version: z.string().max(100).optional(),
  categories: z.array(z.string()).max(30).default([]),
  folderName: SafeName.optional(),
  'requires-steamodded': z.boolean().default(false),
  'requires-talisman': z.boolean().default(false),
  'requires-lovely': z.boolean().default(false),
});

export function normalizeIndexEntry(id: string, data: unknown, url: string): ModDefinition {
  const meta = Metadata.parse(data);
  validateRemoteUrl(meta.repo);
  validateRemoteUrl(meta.downloadURL);
  const download = new URL(meta.downloadURL);
  const latestAsset = /^\/[^/]+\/[^/]+\/releases\/latest\/download\/([^/]+)$/.exec(
    download.pathname,
  )?.[1];
  if (download.hostname === 'github.com')
    download.pathname = download.pathname.replace(/\/zipball\/(.+)$/, '/archive/$1.zip');
  if (
    new URL(meta.repo).hostname !== 'github.com' ||
    !/^\/[\w.-]+\/[\w.-]+\/?$/.test(new URL(meta.repo).pathname)
  )
    throw new Error('A GitHub project repository is required.');
  const project = new URL(meta.repo).pathname
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
  const metadataId = [
    '/steamodded/smods',
    '/steamodded/steamodded',
    '/steamopollys/steamodded',
  ].includes(project)
    ? 'Steamodded'
    : project === '/mathisfun0/talisman'
      ? 'Talisman'
      : project === '/ethangreen-dev/lovely-injector'
        ? 'Lovely'
        : undefined;
  const mod = ModSchema.parse({
    id,
    title: meta.title,
    author: meta.author,
    version: meta.version || 'Unknown',
    metadataId,
    repositoryUrl: meta.repo,
    folderName: meta.folderName,
    downloadUrl: latestAsset ? `${meta.repo.replace(/\/$/, '')}/archive/HEAD.zip` : download.href,
    githubRelease: latestAsset ? { assetName: decodeURIComponent(latestAsset) } : undefined,
    categories: meta.categories.length ? meta.categories : ['Other'],
    source: { provider: 'mod-index', externalId: id, url },
    downloadProvider: metadataId === 'Lovely' ? undefined : 'github',
    approvalStatus: 'legacy-index',
    installation: { type: metadataId === 'Lovely' ? 'lovely-injector' : 'auto' },
    prerequisites: ['steamodded', 'talisman', 'lovely']
      .filter((name) => meta[`requires-${name}` as keyof typeof meta])
      .map((name) => ({
        id: name === 'steamodded' ? 'Steamodded' : name === 'lovely' ? 'Lovely' : 'Talisman',
        displayName:
          name === 'steamodded' ? 'Steamodded' : name === 'lovely' ? 'Lovely' : 'Talisman',
        required: true,
      })),
  });
  if (metadataId !== 'Lovely') validateDistribution(mod);
  return mod;
}

const Cache = z.object({
  url: z.string(),
  fetchedAt: z.iso.datetime(),
  mods: z.array(ModSchema),
  rejected: z.number(),
});
export class ConfiguredModIndex {
  catalogue: Catalogue = { mods: [], stale: true, refreshing: false, rejected: 0 };
  readonly location;
  private readonly cachePath;
  constructor(
    value: string,
    private storage: Storage,
    private logger: Logger,
    private download: (url: string) => Promise<{ id: string; data: unknown }[]> = readRemoteIndex,
  ) {
    this.location = indexLocation(value);
    this.cachePath = `catalogue-cache/index-${createHash('sha256').update(this.location.url).digest('hex')}.json`;
  }
  async loadCache() {
    try {
      const cache = await this.storage.read(this.cachePath, Cache);
      if (
        cache &&
        cache.url === this.location.url &&
        cache.mods.every(
          (mod) => mod.source?.provider === 'mod-index' && mod.source.url === cache.url,
        )
      )
        this.catalogue = { ...cache, stale: true, refreshing: false };
    } catch {
      this.catalogue.error = 'The additional index cache could not be verified.';
    }
  }
  async refresh() {
    this.catalogue.refreshing = true;
    try {
      const entries = await this.download(this.location.url);
      const mods: ModDefinition[] = [];
      let rejected = 0;
      for (const entry of entries) {
        try {
          mods.push(normalizeIndexEntry(entry.id, entry.data, this.location.url));
        } catch {
          rejected++;
        }
      }
      if (
        !mods.length ||
        rejected > mods.length ||
        new Set(mods.map((mod) => mod.id.toLowerCase())).size !== mods.length
      )
        throw new Error(
          'This repository has no valid Balatro mod index, or contains conflicting records.',
        );
      const cache = { url: this.location.url, fetchedAt: new Date().toISOString(), mods, rejected };
      await this.storage.write(this.cachePath, cache);
      this.catalogue = { ...cache, stale: false, refreshing: false };
    } catch (error) {
      this.catalogue = {
        ...this.catalogue,
        stale: true,
        refreshing: false,
        error: `Additional index: ${String(error)}`,
      };
      await this.logger.log('catalogue.index.failed', String(error));
    }
  }
  assertAvailable(mod: ModDefinition) {
    const current = this.catalogue.mods.find((entry) => entry.id === mod.id);
    if (
      this.catalogue.stale ||
      !current ||
      current.repositoryUrl !== mod.repositoryUrl ||
      mod.source?.url !== this.location.url
    )
      throw new UserError(
        'The additional index could not be verified. Connect and refresh before installing from it.',
      );
  }
}
