import * as fs from 'node:fs/promises';
import { z } from 'zod';
import {
  ModSchema,
  type LocalMod,
  type ModDefinition,
  type Prerequisite,
} from '../../src/shared/model';
import { exists, hashFile, readSmall, safeDestination } from './files';
import { catalogueMatches, dependencyId, inspectMetadata, parseLuaHeader } from './metadata';
import { remoteJson } from './network';
import { Logger, Storage } from './storage';
import { hasUpdate } from './versions';
import { automationReason } from '../../src/shared/trust';
import { thunderstoreId } from '../../src/shared/thunderstore';
import type { CatalogueTrust } from './trust';
import { inspectLovelyLibrary } from './lovely';

export interface PrerequisiteProvider {
  getInstalledVersion(): Promise<string | undefined>;
  getLatestVersion(): Promise<string | undefined>;
}
export class GitHubPrerequisiteProvider implements PrerequisiteProvider {
  constructor(
    private repository: string,
    private installed: () => Promise<string | undefined>,
  ) {}
  getInstalledVersion() {
    return this.installed();
  }
  async getLatestVersion() {
    return z
      .object({ tag_name: z.string() })
      .parse(await remoteJson(`https://api.github.com/repos/${this.repository}/releases/latest`))
      .tag_name.replace(/^v/, '');
  }
}
const upstreams = [
  { id: 'Lovely', repository: 'ethangreen-dev/lovely-injector' },
  { id: 'Steamodded', repository: 'Steamodded/smods' },
  { id: 'Talisman', repository: 'SpectralPack/Talisman' },
];
export class InstalledModsService {
  latest = new Map<string, { version?: string; error?: string }>();
  private latestCheck?: Promise<void>;
  constructor(
    private storage: Storage,
    private logger: Logger,
    private trust?: CatalogueTrust,
  ) {}
  roots(): Record<'game' | 'mods' | 'disabled', string> {
    return {
      game: this.storage.state.settings.gamePath ?? '',
      mods: this.storage.state.settings.modsPath ?? '',
      disabled: this.storage.file('disabled'),
    };
  }
  async scan(
    catalogue: ModDefinition[],
  ): Promise<{ mods: LocalMod[]; prerequisites: Prerequisite[] }> {
    const state = this.storage.state,
      roots = this.roots(),
      mods: LocalMod[] = [],
      detected = new Map<string, { version?: string; installed: boolean }>();
    for (const record of state.installations) {
      const problems: string[] = [];
      for (const file of record.files) {
        try {
          const dest = await safeDestination(roots[file.root], file.path);
          if (!(await exists(dest))) problems.push(`${file.path} is missing.`);
          else if ((await hashFile(dest)) !== file.installedHash)
            problems.push(`${file.path} has changed outside Modatro.`);
        } catch {
          problems.push(`${file.path} cannot be verified.`);
        }
      }
      const latest = catalogue.find((m) => m.id === record.modId);
      const historical = this.trust?.apply(
        ModSchema.parse({
          id: record.modId,
          title: record.title,
          author: 'Not recorded',
          version: record.modVersion,
          downloadUrl:
            record.provenance?.downloadUrl ??
            record.source ??
            'https://github.com/NorthernBranch/modatro',
          repositoryUrl: record.provenance?.repositoryUrl,
          categories: [],
          prerequisites: [],
        }),
      );
      const updateReason = latest
        ? automationReason(latest, true)
        : 'No catalogue update source is available. Your installed copy has not been changed.';
      const warning =
        latest || historical
          ? this.trust?.blockedReason(
              (latest ?? historical)!,
              record.packageVersion ?? record.modVersion,
            )
          : undefined;
      mods.push({
        id: record.modId,
        title: record.title,
        version: record.packageVersion ?? record.modVersion,
        managed: true,
        folderName: record.folderName,
        canAdopt: false,
        packageVersionUnknown:
          !!latest?.thunderstore &&
          !record.packageVersion &&
          record.provenance?.provider !== 'github',
        deprecated: latest?.deprecated,
        problems,
        dependencies: record.dependencies,
        metadataId: record.metadataId,
        provenance: record.provenance ?? { sourceType: record.adopted ? 'external' : 'legacy' },
        repositoryUrl: record.provenance?.repositoryUrl ?? latest?.repositoryUrl,
        availabilityReason:
          historical?.approvalStatus === 'opted-out' || historical?.approvalStatus === 'blocked'
            ? historical.policyReason
            : updateReason,
        releaseWarning: warning
          ? `This installed version (${record.packageVersion ?? record.modVersion}) has been flagged as unsafe or broken: ${warning}. Your files have not been changed.`
          : undefined,
        canDisable: record.files.every(
          (file) => file.operation === 'created' && file.root !== 'game',
        ),
        files: record.files.map(({ root, path, operation }) => ({ root, path, operation })),
        state: problems.length
          ? 'broken'
          : record.disabled
            ? 'disabled'
            : latest &&
                !updateReason &&
                (!latest.thunderstore || !!record.packageVersion) &&
                hasUpdate(record.packageVersion ?? record.modVersion, latest.version)
              ? 'update-available'
              : 'installed',
      });
    }
    if (roots.mods && (await exists(roots.mods))) {
      for (const entry of await fs.readdir(roots.mods, { withFileTypes: true })) {
        if (['lovely', '.DS_Store'].includes(entry.name) || entry.name.startsWith('.modatro-'))
          continue;
        try {
          const location = await safeDestination(roots.mods, entry.name);
          const owner = state.installations.find(
            (r) =>
              !r.disabled &&
              r.files.some(
                (f) =>
                  f.root === 'mods' &&
                  (f.path === entry.name || f.path.startsWith(`${entry.name}/`)),
              ),
          );
          const meta = entry.isDirectory()
            ? await inspectMetadata(location)
            : entry.isFile() && entry.name.endsWith('.lua')
              ? parseLuaHeader(await readSmall(location))
              : undefined;
          // Older registry installs omitted manifest.json. A fully verified
          // managed record still establishes the loader identity and runtime version.
          if (
            !meta?.id &&
            owner?.metadataId &&
            !mods.find((m) => m.id === owner.modId)?.problems.length
          ) {
            if (dependencyId(owner.metadataId) === 'Steamodded' && meta) {
              meta.id = 'Steamodded';
              const versionFile = owner.files.find(
                (file) => file.root === 'mods' && file.path === `${entry.name}/version.lua`,
              );
              meta.version = versionFile
                ? /^\s*return\s+["']([^"']+)["']\s*$/.exec(
                    await readSmall(await safeDestination(roots.mods, versionFile.path)),
                  )?.[1]
                : undefined;
            }
          }
          if (meta?.id) {
            const id = dependencyId(meta.id);
            const previous = [...detected.keys()].find(
              (key) => key.toLowerCase() === id.toLowerCase(),
            );
            // Multiple installations cannot establish one trustworthy version.
            detected.set(previous ?? id, {
              version: previous ? undefined : meta.version,
              installed: true,
            });
          }
          if (!owner)
            mods.push({
              id: `external:${entry.name}`,
              title: meta?.name ?? entry.name,
              version: meta?.version,
              state: 'unmanaged',
              managed: false,
              folderName: entry.name,
              canAdopt:
                !!meta?.id &&
                catalogueMatches(meta, catalogue).length <= 1 &&
                !state.installations.some(
                  (record) => record.metadataId?.toLowerCase() === meta.id!.toLowerCase(),
                ),
              catalogueId:
                meta && catalogueMatches(meta, catalogue).length === 1
                  ? catalogueMatches(meta, catalogue)[0]!.id
                  : undefined,
              metadataId: meta?.id,
              dependencies: meta?.requirements,
              problems: [],
            });
        } catch (e) {
          await this.logger.log('local-mod.inspect.failed', {
            folder: entry.name,
            error: String(e),
          });
          mods.push({
            id: `external:${entry.name}`,
            title: entry.name,
            state: 'unmanaged',
            managed: false,
            folderName: entry.name,
            canAdopt: false,
            problems: ['This folder’s metadata could not be verified.'],
          });
        }
      }
    }
    let lovelyInstalled = false,
      lovelyVersion: string | undefined,
      lovelyMatches = 0;
    if (roots.game && (await exists(roots.game))) {
      const dll = (await fs.readdir(roots.game)).filter((name) =>
        ['win32', 'linux'].includes(process.platform)
          ? /\.dll$/i.test(name)
          : /\.dylib$/i.test(name),
      );
      if (dll.length > 200) dll.length = 200;
      for (const filename of dll) {
        try {
          const target = await safeDestination(roots.game, filename);
          if (!(await exists(target))) continue;
          const managed = state.installations.find(
            (r) =>
              (r.modId === 'Lovely' || r.metadataId === 'Lovely') &&
              r.files.some((f) => f.root === 'game' && f.path === filename),
          );
          // Binary export/embedded symbol evidence is required for unknown DLLs.
          const ownedFile = managed?.files.find((f) => f.root === 'game' && f.path === filename);
          const evidence = await inspectLovelyLibrary(target, ownedFile?.installedHash);
          if (evidence.identified) {
            lovelyMatches++;
            lovelyInstalled = true;
            // A record cannot prove the version of an externally replaced binary.
            lovelyVersion = evidence.owned ? managed?.modVersion : undefined;
          }
        } catch {
          /* Unknown library is not positive Lovely evidence. */
        }
      }
    }
    if (lovelyMatches > 1) lovelyVersion = undefined;
    detected.set('Lovely', { installed: lovelyInstalled, version: lovelyVersion });
    const prerequisites: Prerequisite[] = upstreams.map((upstream) => ({
      id: upstream.id,
      displayName: upstream.id,
      installed: detected.get(upstream.id)?.installed ?? false,
      installedVersion: detected.get(upstream.id)?.version,
      latestVersion: this.latest.get(upstream.id)?.version,
      latestError: this.latest.get(upstream.id)?.error,
      sourceUrl: `https://github.com/${upstream.repository}`,
      instructions:
        upstream.id === 'Lovely'
          ? process.platform === 'darwin'
            ? `${process.arch === 'arm64' ? 'For this Apple Silicon Mac, download lovely-aarch64-apple-darwin.tar.gz.' : 'For this Intel Mac, download lovely-x86_64-apple-darwin.tar.gz.'} Modatro can install and manage liblovely.dylib beside Balatro.app. Modatro launches the validated game executable with Lovely; it never executes the downloaded launcher script or bypasses macOS security.`
            : process.platform === 'linux'
              ? 'Modatro installs the official Windows Lovely library beside Balatro.exe for Steam Deck / Linux with Proton. Set Steam launch options to WINEDLLOVERRIDES="winmm=n,b" %command%, then launch through Steam. Mods live in Balatro’s Proton prefix. An external library’s version may remain unknown.'
              : 'Modatro installs the official Windows winmm.dll beside Balatro.exe, with a file preview and backups. Managed releases have a verified version. An external library?s version may remain unknown.'
          : undefined,
      provenance: state.installations.find(
        (record) =>
          dependencyId(record.metadataId ?? record.modId.split(/[@/]/).pop() ?? '') ===
            upstream.id && !record.disabled,
      )?.provenance,
    }));
    for (const [id, info] of detected)
      if (!prerequisites.some((p) => p.id === id))
        prerequisites.push({
          id,
          displayName: id,
          installed: true,
          installedVersion: info.version,
          sourceUrl:
            catalogue.find((mod) => mod.metadataId === id)?.repositoryUrl ??
            'https://thunderstore.io/c/balatro/',
        });
    for (const local of mods)
      if (
        !local.managed &&
        local.metadataId &&
        mods.filter((other) => other.metadataId?.toLowerCase() === local.metadataId!.toLowerCase())
          .length > 1
      ) {
        local.canAdopt = false;
        local.problems.push(
          'Multiple installed copies have this identity. Resolve the duplicate before adoption.',
        );
      }
    for (const record of state.installations) {
      const source = catalogue.find(
        (mod) => mod.thunderstore?.packageId === record.provenance?.packageId,
      );
      const local = mods.find((mod) => mod.id === record.modId);
      if (
        (!source?.thunderstore &&
          !(record.provenance?.namespace && record.provenance.packageName)) ||
        (!record.packageVersion && record.provenance?.provider !== 'github') ||
        record.disabled ||
        local?.problems.length ||
        mods.filter(
          (entry) =>
            entry.metadataId &&
            dependencyId(entry.metadataId).toLowerCase() ===
              dependencyId(record.metadataId ?? '').toLowerCase(),
        ).length > 1
      )
        continue;
      const packageId = thunderstoreId(
        source?.thunderstore?.namespace ?? record.provenance!.namespace!,
        source?.thunderstore?.name ?? record.provenance!.packageName!,
      );
      const runtime = prerequisites.find(
        (entry) => entry.id.toLowerCase() === dependencyId(record.metadataId ?? '').toLowerCase(),
      );
      if (runtime && !runtime.packageId) {
        runtime.packageId = packageId;
        runtime.packageVersion = record.packageVersion;
        runtime.provenance = record.provenance;
        runtime.dependencies = record.dependencies;
      } else
        prerequisites.push({
          id: record.metadataId ?? packageId,
          displayName: source?.title ?? record.title,
          installed: true,
          installedVersion: runtime?.installedVersion,
          packageId,
          packageVersion: record.packageVersion,
          provenance: record.provenance,
          dependencies: record.dependencies,
          sourceUrl:
            source?.source?.url ??
            record.provenance?.downloadUrl ??
            'https://thunderstore.io/c/balatro/',
        });
    }
    for (const prerequisite of prerequisites) {
      // Lovely uses official platform-specific GitHub releases rather than registry packages.
      if (prerequisite.id === 'Lovely') continue;
      const matches = catalogue.filter(
        (mod) =>
          !mod.deprecated &&
          mod.source?.provider === 'thunderstore' &&
          dependencyId(mod.metadataId ?? '') === prerequisite.id,
      );
      if (matches.length === 1) {
        const source = matches[0]!;
        prerequisite.latestVersion = source.version;
        prerequisite.latestPackageId = source.source!.externalId;
        prerequisite.latestError = undefined;
        prerequisite.sourceUrl = source.source!.url ?? prerequisite.sourceUrl;
      } else if (matches.length > 1) {
        prerequisite.latestVersion = undefined;
        prerequisite.latestError =
          'Multiple package sources exist; choose a specific package to check its version';
      }
    }
    return { mods, prerequisites };
  }
  async checkLatest(catalogue: ModDefinition[] = []) {
    if (this.latestCheck) return this.latestCheck;
    this.latestCheck = Promise.all(
      upstreams.map(async (upstream) => {
        if (
          upstream.id !== 'Lovely' &&
          catalogue.some(
            (mod) =>
              !mod.deprecated &&
              mod.source?.provider === 'thunderstore' &&
              dependencyId(mod.metadataId ?? '') === upstream.id,
          )
        )
          return;
        try {
          const provider = new GitHubPrerequisiteProvider(
            upstream.repository,
            async () => undefined,
          );
          this.latest.set(upstream.id, { version: await provider.getLatestVersion() });
        } catch {
          this.latest.set(upstream.id, {
            ...this.latest.get(upstream.id),
            error: 'Unable to check latest version',
          });
        }
      }),
    ).then(() => undefined);
    try {
      await this.latestCheck;
    } finally {
      this.latestCheck = undefined;
    }
  }
}
