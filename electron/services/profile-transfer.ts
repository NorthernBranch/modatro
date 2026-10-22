import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  ProfileFileSchema,
  PortableProfileSchema,
  ProfileTransferRequestSchema,
  uniqueImportedName,
  type PortableProfile,
  type PortableMod,
  type ProfileTransferRequest,
  type ProfileTransferResult,
} from '../../src/shared/profile-transfer';
import { ProfilesSchema } from '../../src/shared/features';
import {
  ModSchema,
  type ModDefinition,
  type Prerequisite,
  type Snapshot,
} from '../../src/shared/model';
import { atomicWrite, contained, readSmall, safeDestination } from './files';
import { repositoryPath, validateDistribution } from './distribution';
import { UserError } from './errors';
import type { Storage } from './storage';
import type { ModInstaller } from './installer';
import type { ProfileService } from './profiles';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function encodeProfile(profile: PortableProfile) {
  const normalized = PortableProfileSchema.parse(profile);
  return (
    JSON.stringify({ profile: normalized, sha256: hash(JSON.stringify(normalized)) }, null, 2) +
    '\n'
  );
}
export function decodeProfile(text: string): PortableProfile {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new UserError('Choose a Modatro profile file no larger than 1 MiB.');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new UserError('Choose a valid Modatro profile JSON export.');
  }
  const parsed = ProfileFileSchema.safeParse(document);
  if (!parsed.success) throw new UserError('This is not a supported Modatro profile export.');
  if (hash(JSON.stringify(parsed.data.profile)) !== parsed.data.sha256)
    throw new UserError(
      'The profile integrity check failed. Export a fresh copy; no mods were changed.',
    );
  return parsed.data.profile;
}
function sameVersion(left: string, right: string) {
  return left.replace(/^v(?=\d)/, '') === right.replace(/^v(?=\d)/, '');
}
export function pinProfileArtifact(mod: ModDefinition, item: PortableMod): ModDefinition {
  if (!item.artifact || mod.installation.type === 'lovely-injector') return mod;
  const repo = repositoryPath(mod.repositoryUrl),
    url = new URL(item.artifact.url);
  if (
    !repo ||
    !['github.com', 'codeload.github.com', 'raw.githubusercontent.com'].includes(url.hostname) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.toLowerCase().startsWith('/' + repo.toLowerCase() + '/')
  )
    throw new UserError(
      `${item.title}: the exported source does not match its catalogue repository.`,
    );
  const pinned = ModSchema.parse({
    ...mod,
    version: item.version,
    downloadProvider: mod.thunderstore ? 'github' : undefined,
    githubRelease: undefined,
    manifestUrl: undefined,
    downloadUrl: url.href,
    releaseSource: {
      sourceType: item.artifact.sourceType,
      sha256: item.artifact.sha256,
      releaseTag: item.artifact.releaseTag,
      commitSha: item.artifact.commitSha,
    },
  });
  validateDistribution(pinned);
  return pinned;
}
interface PendingImport {
  profile: PortableProfile;
  createdId?: string;
  originalId?: string;
  fingerprint: string;
  expires: number;
}
export class ProfileTransferService {
  private pending = new Map<string, PendingImport>();
  private busy = false;
  native: {
    open: () => Promise<string | undefined>;
    save: (name: string) => Promise<string | undefined>;
  } = { open: async () => undefined, save: async () => undefined };
  constructor(
    private storage: Storage,
    private installer: ModInstaller,
    private profiles: ProfileService,
    private catalogue: () => ModDefinition[],
    private snapshot: () => Promise<Snapshot>,
    private graph: (
      roots: ModDefinition[],
      staged?: ModDefinition[],
      prerequisites?: Prerequisite[],
    ) => Promise<ModDefinition[]>,
  ) {}
  private fingerprint() {
    return hash(
      JSON.stringify({
        settings: this.storage.state.settings,
        profiles: this.storage.state.profiles,
        installations: this.storage.state.installations,
      }),
    );
  }
  private installedFor(item: PortableMod) {
    const exact = this.storage.state.installations.find((r) => r.modId === item.id);
    if (exact) return exact;
    const matches = this.storage.state.installations.filter(
      (r) => item.metadataId && r.metadataId?.toLowerCase() === item.metadataId.toLowerCase(),
    );
    if (matches.length > 1)
      throw new UserError(
        `${item.title}: multiple installed sources match this identity. Resolve the ambiguity in Installed first.`,
      );
    return matches[0];
  }
  async export(id: string, destination: string) {
    return this.installer.transactions.locked(async () => {
      this.storage.assertSafe();
      const profile = this.storage.state.profiles?.items.find((p) => p.id === id);
      if (!profile) throw new UserError('This profile no longer exists.');
      const mods: PortableMod[] = profile.selection.map((entry) => {
        const record = this.storage.state.installations.find((r) => r.modId === entry.id);
        if (!record)
          throw new UserError(
            `${entry.id} is no longer installed. Update the saved profile before exporting.`,
          );
        const source = record.provenance;
        let artifact: PortableMod['artifact'];
        if (
          source?.downloadUrl &&
          source.sha256 &&
          ['tag', 'commit', 'release-asset'].includes(source.sourceType) &&
          !source.creator
        ) {
          const url = new URL(source.downloadUrl);
          if (
            url.protocol === 'https:' &&
            !url.search &&
            !url.hash &&
            !url.username &&
            !url.password
          )
            artifact = {
              url: url.href,
              sha256: source.sha256,
              sourceType: source.sourceType as 'tag' | 'commit' | 'release-asset',
              releaseTag: source.releaseTag,
              commitSha: source.commitSha,
            };
        }
        return {
          id: record.modId,
          title: record.title,
          metadataId: record.metadataId,
          version: record.modVersion,
          packageVersion: record.packageVersion,
          enabled: entry.enabled,
          artifact,
        };
      });
      const target = path.resolve(destination),
        parent = await fs.realpath(path.dirname(target));
      if (parent !== path.dirname(target))
        throw new UserError('Export to a folder without symbolic links.');
      await safeDestination(parent, path.basename(target));
      if (!target.toLowerCase().endsWith('.json'))
        throw new UserError('Export with a .json extension.');
      for (const root of [
        this.storage.root,
        this.storage.state.settings.modsPath,
        this.storage.state.settings.gamePath,
      ])
        if (root && contained(root, target))
          throw new UserError('Export outside Modatro data, game and Mods folders.');
      await atomicWrite(
        target,
        encodeProfile({ format: 'modatro-profile', schemaVersion: 1, name: profile.name, mods }),
      );
    });
  }
  private resolve(profile: PortableProfile) {
    const definitions: ModDefinition[] = [],
      blockers: string[] = [],
      rows: NonNullable<ProfileTransferResult['mods']> = [];
    const mapped = new Set<string>();
    for (const item of profile.mods) {
      let existing;
      try {
        existing = this.installedFor(item);
      } catch (error) {
        blockers.push(String(error));
        continue;
      }
      if (existing) {
        if (mapped.has(existing.modId)) {
          blockers.push(
            `${item.title}: multiple exported entries resolve to the same installation.`,
          );
          continue;
        }
        mapped.add(existing.modId);
        if (
          !sameVersion(existing.modVersion, item.version) ||
          (item.packageVersion && existing.packageVersion !== item.packageVersion)
        )
          blockers.push(
            `${item.title}: installed ${existing.modVersion}, export requests ${item.version}. Versions are shared across profiles; resolve this difference in Installed first.`,
          );
        if (
          item.artifact?.sha256 &&
          existing.provenance?.sha256 &&
          item.artifact.sha256 !== existing.provenance.sha256
        )
          blockers.push(
            `${item.title}: the installed archive checksum differs from the exported revision. Review it in Installed first.`,
          );
        rows.push({
          title: item.title,
          version: item.version,
          enabled: item.enabled,
          status: 'installed',
        });
        continue;
      }
      const candidates = this.catalogue().filter(
        (m) =>
          m.id === item.id ||
          (item.metadataId && m.metadataId?.toLowerCase() === item.metadataId.toLowerCase()),
      );
      const exact = candidates.find((m) => m.id === item.id),
        mod = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!mod || mod.source?.provider === 'local' || mod.creator) {
        blockers.push(
          `${item.title}: no downloadable catalogue source. Configure the sender’s mod index or install the author’s ZIP separately, then retry.`,
        );
        continue;
      }
      try {
        const pinned = pinProfileArtifact(mod, item);
        if (mapped.has(pinned.id))
          throw new UserError(
            `${item.title}: multiple exported entries resolve to the same catalogue source.`,
          );
        mapped.add(pinned.id);
        if (
          !item.artifact &&
          mod.installation.type !== 'lovely-injector' &&
          !sameVersion(mod.version, item.version) &&
          !(item.packageVersion && item.packageVersion === mod.thunderstore?.packageVersion)
        )
          throw new UserError(
            `${item.title}: the exported version is unavailable from the configured catalogue. Refresh or configure the sender’s index; versions will not be substituted silently.`,
          );
        definitions.push(pinned);
        rows.push({
          title: item.title,
          version: item.version,
          enabled: item.enabled,
          status: 'download',
        });
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { definitions, blockers, rows };
  }
  async choose(file: string): Promise<ProfileTransferResult> {
    this.storage.assertSafe();
    if ([...this.pending.values()].some((p) => p.createdId))
      throw new UserError('Complete or cancel the current import before choosing another profile.');
    if ((await fs.lstat(file)).isSymbolicLink())
      throw new UserError('Choose a regular profile file.');
    const profile = decodeProfile(await readSmall(file, 1024 * 1024));
    const { blockers, rows } = this.resolve(profile),
      token = randomUUID();
    if ((await this.snapshot()).profiles?.unsaved)
      blockers.push('Save or revert your current profile selection before importing.');
    this.pending.clear();
    this.pending.set(token, {
      profile,
      fingerprint: this.fingerprint(),
      expires: Date.now() + 30 * 60 * 1000,
    });
    return {
      status: 'review',
      token,
      name: uniqueImportedName(
        profile.name,
        this.storage.state.profiles!.items.map((p) => p.name),
      ),
      mods: rows,
      blockers,
      warnings: [
        'Profiles share installed versions. This imports managed selections, not saves or mod configuration files.',
        'The checksum detects damaged exports; it does not establish the sender’s identity or make mod code safe.',
        'Local-only mods need their separate author-provided ZIP. Prerequisites are resolved before dependent mods.',
      ],
    };
  }
  async perform(input: ProfileTransferRequest): Promise<ProfileTransferResult> {
    const request = ProfileTransferRequestSchema.parse(input);
    if (this.busy) throw new UserError('A profile transfer is already running.');
    this.busy = true;
    let recovery: PendingImport | undefined;
    try {
      if (request.operation === 'export') {
        const profile = this.storage.state.profiles?.items.find((p) => p.id === request.id);
        if (!profile) throw new UserError('This profile no longer exists.');
        const destination = await this.native.save(
          profile.name.replace(/[^\p{L}\p{N}_ -]/gu, '_') + '.modatro-profile.json',
        );
        if (!destination) return { status: 'cancelled' };
        await this.export(request.id, destination);
        return { status: 'exported', name: profile.name };
      }
      if (request.operation === 'choose-import') {
        const file = await this.native.open();
        return file ? await this.choose(file) : { status: 'cancelled' };
      }
      const pending = this.pending.get(request.token);
      if (!pending && request.operation === 'cancel')
        return { status: 'cancelled', snapshot: await this.snapshot() };
      if (!pending) throw new UserError('Choose the profile export again.');
      if (request.operation === 'cancel') {
        await this.installer.cancel();
        await this.restore(pending);
        this.pending.delete(request.token);
        return { status: 'cancelled', snapshot: await this.snapshot() };
      }
      if (pending.expires < Date.now() || pending.fingerprint !== this.fingerprint())
        throw new UserError(
          'The import preview changed or expired. Close it and choose the export again.',
        );
      if (!pending.createdId && (await this.snapshot()).profiles?.unsaved)
        throw new UserError('Save or revert the current profile selection before importing.');
      const resolved = this.resolve(pending.profile);
      if (resolved.blockers.length) throw new UserError(resolved.blockers.join('\n'));
      await this.installer.guard();
      recovery = pending;
      if (!pending.createdId) {
        await this.installer.transactions.locked(async () => {
          const current = this.storage.state.profiles!;
          if (current.items.length >= 100)
            throw new UserError('Archive a profile before importing another.');
          pending.originalId = current.activeId;
          pending.createdId = randomUUID();
          // Only already-installed entries participate until downloads have passed staging.
          const selectedIds = new Set(
            pending.profile.mods.map((item) => this.installedFor(item)?.modId).filter(Boolean),
          );
          const selection = this.storage.state.installations.map((record) => ({
            id: record.modId,
            enabled: selectedIds.has(record.modId),
          }));
          await this.storage.save({
            ...this.storage.state,
            profiles: ProfilesSchema.parse({
              ...current,
              items: [
                ...current.items,
                {
                  id: pending.createdId,
                  name: uniqueImportedName(
                    pending.profile.name,
                    current.items.map((p) => p.name),
                  ),
                  selection,
                },
              ],
            }),
          });
        });
        const plan = await this.profiles.preview(pending.createdId!);
        await this.profiles.switch(pending.createdId!, plan.token);
      }
      try {
        if (resolved.definitions.length) {
          const graph = await this.graph(resolved.definitions);
          for (const wanted of pending.profile.mods) {
            const source = resolved.definitions.find(
              (d) =>
                d.id === wanted.id ||
                (wanted.metadataId &&
                  d.metadataId?.toLowerCase() === wanted.metadataId.toLowerCase()),
            );
            const candidate = source && graph.find((d) => d.id === source.id);
            if (
              candidate &&
              !sameVersion(candidate.version, wanted.version) &&
              !(
                candidate.thunderstore &&
                candidate.downloadProvider !== 'github' &&
                wanted.packageVersion === candidate.thunderstore.packageVersion
              )
            )
              throw new UserError(
                `${wanted.title}: upstream now resolves to ${candidate.version}, but the export requests ${wanted.version}. No release will be substituted silently.`,
              );
          }
          await this.installer.installMany(
            graph,
            request.confirmationToken,
            [],
            false,
            (staged, prerequisites) => this.graph(resolved.definitions, staged, prerequisites),
          );
        }
      } catch (error) {
        pending.fingerprint = this.fingerprint();
        if (error instanceof UserError && error.context?.confirmation)
          return {
            status: 'review',
            token: request.token,
            name: this.storage.state.profiles!.items.find((p) => p.id === pending.createdId)!.name,
            mods: resolved.rows,
            confirmation: error.context.confirmation,
          };
        throw error;
      }
      await this.installer.transactions.locked(async () => {
        const current = structuredClone(this.storage.state.profiles!);
        const item = current.items.find((p) => p.id === pending.createdId)!;
        // Newly resolved prerequisites stay enabled; explicit selections override roots.
        for (const wanted of pending.profile.mods) {
          const record = this.installedFor(wanted);
          if (!record)
            throw new UserError(`${wanted.title} did not install. The import is incomplete.`);
          if (
            !sameVersion(record.modVersion, wanted.version) ||
            (wanted.packageVersion && record.packageVersion !== wanted.packageVersion)
          )
            throw new UserError(
              `${wanted.title}: the installed version differs from the export. The import stopped; review Installed before retrying.`,
            );
          const entry = item.selection.find((e) => e.id === record.modId);
          if (entry) entry.enabled = wanted.enabled;
        }
        await this.storage.save({ ...this.storage.state, profiles: current });
      });
      const final = await this.profiles.preview(pending.createdId!);
      await this.profiles.switch(pending.createdId!, final.token);
      this.pending.delete(request.token);
      return {
        status: 'complete',
        profileId: pending.createdId,
        name: final.name,
        warnings: final.warnings,
        snapshot: await this.snapshot(),
      };
    } catch (error) {
      if (recovery?.createdId) {
        try {
          await this.restore(recovery);
          this.pending.clear();
        } catch (restoreError) {
          throw new UserError(
            'Import stopped. The previous profile could not be restored automatically; keep recovery backups and review Profiles before launching Balatro.',
            undefined,
            `${String(error)}\n${String(restoreError)}`,
          );
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async restore(pending: PendingImport) {
    if (!pending.createdId || !pending.originalId) return;
    if (!this.storage.state.profiles?.items.some((p) => p.id === pending.createdId)) return;
    // Return through the same integrity-checked profile transaction. Never delete files.
    const plan = await this.profiles.preview(pending.originalId);
    await this.profiles.switch(pending.originalId, plan.token);
    await this.profiles.operation({ operation: 'delete', id: pending.createdId });
  }
}
