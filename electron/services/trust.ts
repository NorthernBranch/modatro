import { z } from 'zod';
import baseline from '../../catalogue/revocations.json';
import blockedBaseline from '../../catalogue/blocked-releases.json';
import type { ModDefinition, TrustState } from '../../src/shared/model';
import {
  automationReason,
  BlockedReleasesSchema,
  RevocationsSchema,
  sameRepository,
} from '../../src/shared/trust';
import { UserError } from './errors';
import { remoteJson } from './network';
import { Logger, Storage } from './storage';
import { thunderstoreId } from '../../src/shared/thunderstore';

const BASE = 'https://raw.githubusercontent.com/NorthernBranch/modatro/main/catalogue';
const Cache = z.object({ revocations: RevocationsSchema, blocked: BlockedReleasesSchema });
export class CatalogueTrust {
  private data = Cache.parse({ revocations: baseline, blocked: blockedBaseline });
  private refreshing?: Promise<void>;
  state: TrustState = { fresh: false };
  constructor(
    private storage: Storage,
    private logger: Logger,
    private json = remoteJson,
    private changed: () => void = () => {},
  ) {}
  async initialize() {
    try {
      const cached = await this.storage.read('catalogue-cache/trust.json', Cache);
      if (cached) {
        this.data.revocations = this.merge(
          this.data.revocations,
          cached.revocations,
          'revocations',
        );
        this.data.blocked = this.merge(this.data.blocked, cached.blocked, 'blockedReleases');
      }
    } catch {
      this.state.error =
        'Saved removal and release restrictions could not be verified. Refresh before installing.';
    }
  }
  private merge<T extends { revision: number; generatedAt: string }>(
    old: T,
    next: T,
    key: 'revocations' | 'blockedReleases',
  ): T {
    if (next.revision < old.revision)
      throw new UserError('The restriction feed is older than the saved version.');
    // Removals are append-only. An omitted entry never silently reinstates a mod.
    const previous = (old as unknown as Record<string, unknown[]>)[key]!;
    const incoming = (next as unknown as Record<string, unknown[]>)[key]!;
    const unique = new Map(
      [...previous, ...incoming].map((entry) => [JSON.stringify(entry), entry]),
    );
    return { ...next, [key]: [...unique.values()] };
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const failures: string[] = [];
      // Apply each feed independently, even if the catalogue or the other feed is offline.
      const feeds = await Promise.allSettled([
        this.json(`${BASE}/revocations.json`).then((v) => RevocationsSchema.parse(v)),
        this.json(`${BASE}/blocked-releases.json`).then((v) => BlockedReleasesSchema.parse(v)),
      ]);
      for (const [index, result] of feeds.entries()) {
        if (result.status === 'rejected') {
          failures.push(String(result.reason));
          continue;
        }
        try {
          if (index === 0)
            this.data.revocations = this.merge(
              this.data.revocations,
              RevocationsSchema.parse(result.value),
              'revocations',
            );
          else
            this.data.blocked = this.merge(
              this.data.blocked,
              BlockedReleasesSchema.parse(result.value),
              'blockedReleases',
            );
        } catch (error) {
          failures.push(String(error));
        }
      }
      try {
        await this.storage.write('catalogue-cache/trust.json', this.data);
      } catch (error) {
        failures.push(String(error));
      }
      this.state = failures.length
        ? {
            ...this.state,
            fresh: false,
            error:
              'Removal and release checks could not finish. Installed mods are unchanged; connect and refresh before installing or updating.',
          }
        : { checkedAt: new Date().toISOString(), fresh: true };
      await this.logger.log('catalogue.restrictions', { fresh: this.state.fresh, failures });
      this.changed();
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  isFresh() {
    return (
      this.state.fresh &&
      !!this.state.checkedAt &&
      Date.now() - Date.parse(this.state.checkedAt) < 15 * 60 * 1000
    );
  }
  private matches(
    entry: { modId: string; repositoryUrl?: string; packageId?: string },
    mod: ModDefinition,
  ) {
    return (
      (!!entry.packageId && entry.packageId === mod.thunderstore?.packageId) ||
      [
        mod.id,
        ...(mod.legacyIds ?? []),
        ...(mod.thunderstore
          ? [thunderstoreId(mod.thunderstore.namespace, mod.thunderstore.name)]
          : []),
      ].some((id) => id.toLowerCase() === entry.modId.toLowerCase()) ||
      sameRepository(entry.repositoryUrl, mod.repositoryUrl)
    );
  }
  apply(mod: ModDefinition): ModDefinition {
    const revocation = this.data.revocations.revocations.find((r) => this.matches(r, mod));
    if (revocation)
      return {
        ...mod,
        approvalStatus: revocation.reason === 'author-request' ? 'opted-out' : 'blocked',
        policyReason:
          revocation.reason === 'author-request'
            ? 'This mod is no longer available through Modatro. The author requested removal. Your existing installation has not been changed.'
            : `Automatic installations and updates are blocked (${revocation.reason}). Your existing installation has not been changed.`,
        permissions: { display: mod.permissions?.display ?? true, install: false, update: false },
      };
    const blocked = this.blockedReason(mod, mod.thunderstore?.packageVersion ?? mod.version);
    return blocked
      ? {
          ...mod,
          policyReason: `Release ${mod.thunderstore?.packageVersion ?? mod.version} is blocked: ${blocked}`,
        }
      : mod;
  }
  blockedReason(mod: ModDefinition, version: string) {
    return this.data.blocked.blockedReleases.find(
      (r) => this.matches(r, mod) && r.version.replace(/^v/, '') === version.replace(/^v/, ''),
    )?.reason;
  }
  async assertAllowed(mod: ModDefinition, update: boolean, refresh = true) {
    if (refresh) await this.refresh();
    const reason = automationReason(this.apply(mod), update);
    if (reason) throw new UserError(reason);
    if (!this.isFresh())
      throw new UserError(
        this.state.error ??
          'Connect and refresh removal and release checks before installing or updating.',
      );
  }
}
