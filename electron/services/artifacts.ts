import { z } from 'zod';
import type { InstallationSource, ModDefinition } from '../../src/shared/model';
import { HashSchema } from '../../src/shared/model';
import { sourceType } from '../../src/shared/trust';
import { UserError } from './errors';
import { Logger, Storage } from './storage';

const History = z.object({
  schemaVersion: z.literal(1),
  artifacts: z.array(z.object({ identity: z.string(), sha256: HashSchema })).max(20000),
});
export function artifactIdentity(mod: ModDefinition) {
  const detected = sourceType(mod.downloadUrl);
  const type = detected === 'other' ? (mod.releaseSource?.sourceType ?? detected) : detected;
  const url = new URL(mod.downloadUrl);
  const reference =
    type === 'commit'
      ? (mod.releaseSource?.commitSha ??
        /\/([a-f0-9]{40})(?:\.zip|\/)/.exec(url.pathname)?.[1] ??
        mod.version)
      : (
          mod.releaseSource?.releaseTag ??
          /\/releases\/download\/([^/]+)\//.exec(url.pathname)?.[1] ??
          /\/archive\/(?:refs\/tags\/)?([^/]+)\.zip$/.exec(url.pathname)?.[1] ??
          mod.version
        ).replace(/^v(?=\d)/, '');
  return JSON.stringify([
    mod.repositoryUrl?.replace(/\/$/, '').toLowerCase() ?? mod.id,
    type,
    reference,
  ]);
}
export class ArtifactHistory {
  constructor(
    private storage: Storage,
    private logger: Logger,
  ) {}
  async verify(mod: ModDefinition, received: string): Promise<InstallationSource> {
    const detected = sourceType(mod.downloadUrl);
    const type = detected === 'other' ? (mod.releaseSource?.sourceType ?? detected) : detected;
    const history = (await this.storage.read('data/artifact-history.json', History)) ?? {
      schemaVersion: 1 as const,
      artifacts: [],
    };
    const identity = artifactIdentity(mod);
    const previous = history.artifacts.find((entry) => entry.identity === identity);
    const installed = this.storage.state.installations.find(
      (entry) => entry.modId === mod.id,
    )?.provenance;
    const expected = [
      previous?.sha256,
      mod.releaseSource?.sha256,
      installed?.downloadUrl === mod.downloadUrl && installed?.sourceType === type
        ? installed.sha256
        : undefined,
    ].find((hash) => hash && hash !== received);
    if (
      expected &&
      expected !== received &&
      (mod.releaseSource?.sha256 || ['tag', 'commit', 'release-asset'].includes(type))
    ) {
      await this.logger.log('artifact.changed', {
        modId: mod.id,
        version: mod.version,
        source: mod.downloadUrl,
        expected,
        received,
      });
      throw new UserError(
        'This release has changed since Modatro last saw it. Automatic installation has been stopped.',
        undefined,
        `Expected: ${expected}\nReceived: ${received}`,
      );
    }
    if (['tag', 'commit', 'release-asset'].includes(type) && !previous) {
      history.artifacts.push({ identity, sha256: received });
      await this.storage.write('data/artifact-history.json', History.parse(history));
    }
    const path = new URL(mod.downloadUrl).pathname;
    const releaseTag =
      mod.releaseSource?.releaseTag ??
      /\/releases\/download\/([^/]+)\//.exec(path)?.[1] ??
      /\/archive\/(?:refs\/tags\/)?([^/]+)\.zip$/.exec(path)?.[1];
    return {
      repositoryUrl: mod.repositoryUrl,
      downloadUrl: mod.downloadUrl,
      sourceType: type,
      releaseTag: type === 'tag' || type === 'release-asset' ? releaseTag : undefined,
      commitSha: mod.releaseSource?.commitSha ?? /\/([a-f0-9]{40})\.zip$/.exec(path)?.[1],
      downloadedAt: new Date().toISOString(),
      sha256: received,
    };
  }
}
