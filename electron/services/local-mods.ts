import * as fs from 'node:fs/promises';
import { z } from 'zod';
import type { LocalMod, ModDefinition, Prerequisite } from '../../src/shared/model';
import { exists, hashFile, readSmall, safeDestination } from './files';
import { catalogueMatches, dependencyId, inspectMetadata, parseLuaHeader } from './metadata';
import { remoteJson } from './network';
import { Logger, Storage } from './storage';
import { hasUpdate } from './versions';

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
      mods.push({
        id: record.modId,
        title: record.title,
        version: record.modVersion,
        managed: true,
        folderName: record.folderName,
        canAdopt: false,
        problems,
        dependencies: record.dependencies,
        state: problems.length
          ? 'broken'
          : record.disabled
            ? 'disabled'
            : latest && hasUpdate(record.modVersion, latest.version)
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
          const meta = entry.isDirectory()
            ? await inspectMetadata(location)
            : entry.isFile() && entry.name.endsWith('.lua')
              ? parseLuaHeader(await readSmall(location))
              : undefined;
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
          const owner = state.installations.find(
            (r) =>
              !r.disabled &&
              r.files.some(
                (f) =>
                  f.root === 'mods' &&
                  (f.path === entry.name || f.path.startsWith(`${entry.name}/`)),
              ),
          );
          if (!owner)
            mods.push({
              id: `external:${entry.name}`,
              title: meta?.name ?? entry.name,
              version: meta?.version,
              state: 'unmanaged',
              managed: false,
              folderName: entry.name,
              canAdopt:
                entry.isDirectory() && !!meta && catalogueMatches(meta, catalogue).length === 1,
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
      lovelyVersion: string | undefined;
    if (roots.game && (await exists(roots.game))) {
      const dll = process.platform === 'win32' ? ['winmm.dll', 'version.dll'] : ['liblovely.dylib'];
      for (const filename of dll) {
        try {
          const target = await safeDestination(roots.game, filename);
          if (!(await exists(target))) continue;
          const managed = state.installations.find(
            (r) =>
              r.modId === 'Lovely' && r.files.some((f) => f.root === 'game' && f.path === filename),
          );
          // Binary export/embedded symbol evidence is required for unknown DLLs.
          const handle = await fs.open(target, 'r');
          const size = Math.min((await handle.stat()).size, 16 * 1024 * 1024);
          const bytes = Buffer.alloc(size);
          try {
            await handle.read(bytes, 0, size, 0);
          } finally {
            await handle.close();
          }
          const magic = bytes.subarray(0, 4).toString('hex');
          const nativeLibrary =
            process.platform === 'win32'
              ? bytes.subarray(0, 2).toString() === 'MZ'
              : ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(
                  magic,
                );
          const ownedFile = managed?.files.find((f) => f.root === 'game' && f.path === filename);
          const verifiedRecord = ownedFile && (await hashFile(target)) === ownedFile.installedHash;
          if (nativeLibrary && (verifiedRecord || /lovely/i.test(bytes.toString('latin1')))) {
            lovelyInstalled = true;
            // A record cannot prove the version of an externally replaced binary.
            lovelyVersion = verifiedRecord ? managed?.modVersion : undefined;
          }
        } catch {
          /* Unknown library is not positive Lovely evidence. */
        }
      }
    }
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
            ? `${process.arch === 'arm64' ? 'For this Apple Silicon Mac, download lovely-aarch64-apple-darwin.tar.gz.' : 'For this Intel Mac, download lovely-x86_64-apple-darwin.tar.gz.'} Place liblovely.dylib beside Balatro.app using the official instructions. Modatro launches the validated game executable with Lovely; it never executes the downloaded launcher script or bypasses macOS security.`
            : 'Use the official Windows release. Place winmm.dll beside Balatro.exe. Modatro detects Lovely from library evidence; its version may remain unknown.'
          : undefined,
    }));
    for (const [id, info] of detected)
      if (!prerequisites.some((p) => p.id === id))
        prerequisites.push({
          id,
          displayName: id,
          installed: true,
          installedVersion: info.version,
          sourceUrl: 'https://github.com/skyline69/balatro-mod-index',
        });
    return { mods, prerequisites };
  }
  async checkLatest() {
    if (this.latestCheck) return this.latestCheck;
    this.latestCheck = Promise.all(
      upstreams.map(async (upstream) => {
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
