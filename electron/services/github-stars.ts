import { z } from 'zod';
import { repositoryPath } from './distribution';
import { boundedBody, safeFetch } from './network';
import { Storage } from './storage';
import type { ModDefinition } from '../../src/shared/model';
import { UserError } from './errors';

const Entry = z.object({ stars: z.number().int().nonnegative().optional(), checkedAt: z.number() });
const Cache = z.record(z.string(), Entry);
export class GitHubStars {
  private cache: z.infer<typeof Cache> = {};
  private loaded = false;
  private cooldown = 0;
  private active?: Promise<Record<string, number>>;
  constructor(
    private storage: Storage,
    private fetch = safeFetch,
  ) {}
  async get(mods: ModDefinition[]): Promise<Record<string, number>> {
    if (this.active) {
      await this.active;
      return this.get(mods);
    }
    this.active = this.load(mods);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }
  private async load(mods: ModDefinition[]) {
    if (!this.loaded) {
      try {
        this.cache = (await this.storage.read('catalogue-cache/github-stars.json', Cache)) ?? {};
      } catch {
        /* Counts are optional. */
      }
      this.loaded = true;
    }
    const repos = [
      ...new Set(
        mods
          .map((mod) => repositoryPath(mod.repositoryUrl)?.toLowerCase())
          .filter((repo): repo is string => !!repo),
      ),
    ];
    let requests = 0;
    for (const repo of repos) {
      if (Date.now() < this.cooldown || requests >= 40) break;
      const old = this.cache[repo];
      if (old && Date.now() - old.checkedAt < (old.stars === undefined ? 3600000 : 86400000))
        continue;
      requests++;
      try {
        const response = await this.fetch(
          `https://api.github.com/repos/${repo}`,
          AbortSignal.timeout(10000),
        );
        const data = z
          .object({ full_name: z.string(), stargazers_count: z.number().int().nonnegative() })
          .parse(JSON.parse((await boundedBody(response, 256000)).toString('utf8')));
        if (data.full_name.toLowerCase() !== repo) continue;
        this.cache[repo] = { stars: data.stargazers_count, checkedAt: Date.now() };
        // Leave API capacity for release discovery and installation.
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining !== null && Number(remaining) <= 20) {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          this.cooldown = reset > Date.now() ? reset : Date.now() + 3600000;
        }
      } catch (error) {
        if (error instanceof UserError && error.statusCode === 404) {
          this.cache[repo] = { ...old, checkedAt: Date.now() };
          continue;
        }
        this.cooldown = Date.now() + 3600000;
        break;
      }
    }
    try {
      await this.storage.write('catalogue-cache/github-stars.json', this.cache);
    } catch {
      /* Browsing remains available if caching fails. */
    }
    return Object.fromEntries(
      mods.flatMap((mod) => {
        const repo = repositoryPath(mod.repositoryUrl)?.toLowerCase();
        const stars = repo ? this.cache[repo]?.stars : undefined;
        return stars === undefined ? [] : [[mod.id, stars]];
      }),
    );
  }
}
