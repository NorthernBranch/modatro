import { z } from 'zod';
import { repositoryPath } from './distribution';
import { boundedBody, githubApiAvailable, safeFetch } from './network';
import { Storage } from './storage';
import type { ModDefinition } from '../../src/shared/model';
import { UserError } from './errors';

const Entry = z.object({ stars: z.number().int().nonnegative().optional(), checkedAt: z.number() });
const Cache = z.record(z.string(), Entry);
const Budget = z.object({
  startedAt: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  cooldown: z.number().nonnegative(),
});
const HOURLY_REQUESTS = 15;
const INSTALL_RESERVE = 40;
export class GitHubStars {
  private cache: z.infer<typeof Cache> = {};
  private loaded = false;
  private cooldown = 0;
  private startedAt = Date.now();
  private requests = 0;
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
      try {
        const budget = await this.storage.read('catalogue-cache/github-stars-budget.json', Budget);
        if (budget) {
          this.startedAt = budget.startedAt;
          this.requests = budget.requests;
          this.cooldown = budget.cooldown;
        }
      } catch {
        /* A missing or invalid budget does not prevent offline browsing. */
      }
      this.loaded = true;
    }
    if (Date.now() - this.startedAt >= 3600000) {
      this.startedAt = Date.now();
      this.requests = 0;
    }
    const repos = [
      ...new Set(
        // The optional index is merged before Thunderstore for discovery. Do not
        // let that ordering consume the whole API budget before registry lookups.
        [...mods]
          .sort(
            (a, b) =>
              Number(!!b.thunderstore || b.source?.provider === 'thunderstore') -
              Number(!!a.thunderstore || a.source?.provider === 'thunderstore'),
          )
          .map((mod) => repositoryPath(mod.repositoryUrl)?.toLowerCase())
          .filter((repo): repo is string => !!repo),
      ),
    ];
    for (const repo of repos) {
      if (
        Date.now() < this.cooldown ||
        this.requests >= HOURLY_REQUESTS ||
        !githubApiAvailable(INSTALL_RESERVE)
      )
        break;
      const old = this.cache[repo];
      if (old && Date.now() - old.checkedAt < (old.stars === undefined ? 3600000 : 86400000))
        continue;
      this.requests++;
      // Persist before making the request so restarting cannot spend the same
      // optional budget again while GitHub's hourly window is still active.
      await this.saveBudget();
      try {
        const response = await this.fetch(
          `https://api.github.com/repos/${repo}`,
          AbortSignal.timeout(10000),
        );
        const data = z
          .object({ full_name: z.string(), stargazers_count: z.number().int().nonnegative() })
          .parse(JSON.parse((await boundedBody(response, 256000)).toString('utf8')));
        if (data.full_name.toLowerCase() !== repo) {
          // GitHub redirects repository renames. Accept the new identity only
          // when the actual API response URL proves the redirect destination.
          const destination = response.url ? new URL(response.url) : undefined;
          if (
            destination?.hostname !== 'api.github.com' ||
            destination.pathname.toLowerCase() !== `/repos/${data.full_name.toLowerCase()}`
          )
            continue;
        }
        this.cache[repo] = { stars: data.stargazers_count, checkedAt: Date.now() };
        this.cache[data.full_name.toLowerCase()] = this.cache[repo];
        // Leave API capacity for release discovery and installation.
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining !== null && Number(remaining) <= INSTALL_RESERVE) {
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
    await this.saveBudget();
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
  private async saveBudget() {
    try {
      await this.storage.write('catalogue-cache/github-stars-budget.json', {
        startedAt: this.startedAt,
        requests: this.requests,
        cooldown: this.cooldown,
      });
    } catch {
      /* The in-memory budget still applies when saving is unavailable. */
    }
  }
}
