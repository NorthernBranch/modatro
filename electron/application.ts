import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { indexLocation, ModIndexUrl } from '../src/shared/mod-index';
import {
  ModSchema,
  type ConflictDecision,
  type GameCandidate,
  type ModAction,
  type ModDefinition,
  type OperationReport,
  type Progress,
  type Prerequisite,
  type Snapshot,
  type UnverifiedPrerequisite,
  type SettingsUpdate,
  type ReleaseOptions,
} from '../src/shared/model';
import { ModatroCatalogueRepository } from './services/catalogue';
import { GameDetectionService, LaunchService } from './services/detection';
import { UserError } from './services/errors';
import { contained, readSmall, safeDestination } from './services/files';
import { ModInstaller } from './services/installer';
import { SetupRecoveryService } from './services/setup-recovery';
import type { SetupRecoveryRequest, SetupRecoveryResult } from '../src/shared/setup-recovery';
import { InstalledModsService } from './services/local-mods';
import { remoteJson } from './services/network';
import { Logger, Storage } from './services/storage';
import { TransactionEngine } from './services/transaction';
import { CatalogueTrust } from './services/trust';
import { allowedDescription, automationReason } from '../src/shared/trust';
import {
  DependencyGraphError,
  packageIdentity,
  resolveDependencyGraph,
} from '../src/shared/dependency-graph';
import {
  canAcceptUnverified,
  blockingDependencies,
  evaluateDependency,
} from '../src/shared/dependencies';
import {
  developmentDistribution,
  repositoryPath,
  resolveDistribution,
} from './services/distribution';
import { LocalModSource } from './services/sources/mod-source';
import { lovelyDistribution } from './services/lovely';
import { GitHubStars } from './services/github-stars';
import { AppUpdates } from './services/app-updates';
import { ProfileService } from './services/profiles';
import { TroubleshootingService } from './services/troubleshooting';
import { profileSummary } from '../src/shared/profile-selection';
import type { ProfileOperation } from '../src/shared/features';
import { CreatorService } from './services/creator';
import { ProfileTransferService } from './services/profile-transfer';
import { developmentAvailability, publishedOptions } from './services/releases';
import { affectedCompatibility } from '../src/shared/compatibility';
import { projectedPrerequisites } from '../src/shared/dependency-graph';

export class ModatroApplication {
  readonly storage: Storage;
  readonly appUpdates: AppUpdates;
  private stars: GitHubStars;
  readonly logger: Logger;
  readonly detection = new GameDetectionService();
  readonly launch = new LaunchService();
  readonly local: InstalledModsService;
  readonly repository: ModatroCatalogueRepository;
  readonly trust: CatalogueTrust;
  readonly transactions: TransactionEngine;
  readonly installer: ModInstaller;
  readonly profiles: ProfileService;
  readonly setupRecovery: SetupRecoveryService;
  readonly profileTransfer: ProfileTransferService;
  readonly troubleshooting: TroubleshootingService;
  readonly creator: CreatorService;
  readonly localSource = new LocalModSource(() => this.custom);
  private candidates: GameCandidate[] = [];
  private custom: ModDefinition[] = [];
  private localArchives = new Map<string, string>();
  private unavailableSources: Record<string, string> = {};
  private initialized = false;
  private discoveryError?: string;
  private publishing?: Promise<void>;
  private republish = false;
  private operationReport?: OperationReport;
  private releaseChoices = new Map<
    string,
    { checked: number; choices: Awaited<ReturnType<typeof publishedOptions>>['choices'] }
  >();
  constructor(
    dataRoot: string,
    private appVersion: string,
    private electronVersion: string,
    progress: (value: Progress) => void,
    private changed: (value: Snapshot) => void,
  ) {
    this.storage = new Storage(dataRoot);
    this.appUpdates = new AppUpdates(this.storage, appVersion, () => {
      if (this.initialized) void this.publish();
    });
    this.stars = new GitHubStars(this.storage);
    this.logger = new Logger(this.storage, os.homedir());
    this.trust = new CatalogueTrust(this.storage, this.logger, remoteJson, () => {
      if (this.initialized) void this.publish();
    });
    this.local = new InstalledModsService(this.storage, this.logger, this.trust);
    this.repository = new ModatroCatalogueRepository(this.storage, this.logger, () => {
      if (this.initialized) void this.publish();
    });
    this.transactions = new TransactionEngine(this.storage, this.logger);
    this.installer = new ModInstaller(
      this.storage,
      this.transactions,
      this.detection,
      this.launch,
      this.logger,
      progress,
      async () => (await this.snapshot()).prerequisites,
      async (mod, update) => {
        await this.repository.assertAvailable(mod);
        const current = this.repository.catalogue.mods.find(
          (entry) =>
            entry.id === mod.id ||
            entry.legacyIds?.includes(mod.id) ||
            (!!mod.thunderstore && entry.thunderstore?.packageId === mod.thunderstore.packageId),
        );
        if (current) {
          const reason = automationReason(
            {
              ...current,
              ...mod,
              permissions: current.permissions,
              approvalStatus: current.approvalStatus,
              policyReason: current.policyReason,
            },
            update,
          );
          if (reason) throw new UserError(reason);
        }
        await this.trust.assertAllowed(mod, update);
      },
      async () => (await this.snapshot()).localMods,
    );
    this.profiles = new ProfileService(this.storage, this.installer, () => this.snapshot());
    this.setupRecovery = new SetupRecoveryService(this.storage, this.installer);
    this.profileTransfer = new ProfileTransferService(
      this.storage,
      this.installer,
      this.profiles,
      () => this.allMods(),
      () => this.snapshot(),
      (roots, staged, prerequisites) => this.dependencyPlan(roots, [], staged, prerequisites),
    );
    this.troubleshooting = new TroubleshootingService(
      this.storage,
      this.transactions,
      () => this.snapshot(),
      this.profiles,
    );
    this.creator = new CreatorService(
      this.storage,
      this.transactions,
      async () => (await this.snapshot()).localMods,
      async (definition) => {
        this.custom = [...this.custom.filter((mod) => mod.id !== definition.id), definition];
        await this.storage.write('data/custom-mods.json', this.custom);
      },
    );
  }
  async profileOperation(request: ProfileOperation) {
    await this.profiles.operation(request);
    return this.snapshot();
  }
  async recoverSetup(request: SetupRecoveryRequest): Promise<SetupRecoveryResult> {
    if (request.operation === 'review') return this.setupRecovery.review(request.mode);
    return { ...(await this.setupRecovery.apply(request.token)), snapshot: await this.snapshot() };
  }
  async switchProfile(request: { profileId: string; token: string }) {
    await this.profiles.switch(request.profileId, request.token);
    return this.snapshot();
  }
  async initialize() {
    await this.storage.initialize();
    await this.installer.pruneDownloads();
    await this.appUpdates.loadCache();
    await this.trust.initialize();
    if (!this.storage.safetyError) await this.transactions.recover();
    await this.storage.migrateProfiles();
    if (!this.storage.safetyError)
      await this.transactions.locked(() => this.installer.removed.prune());
    await this.repository.loadCache();
    try {
      this.unavailableSources =
        (await this.storage.read(
          'data/unavailable-sources.json',
          z.record(z.string(), z.string()),
        )) ?? {};
    } catch {
      await this.logger.log('source-status.invalid');
    }
    try {
      this.custom = (await this.storage.read('data/custom-mods.json', z.array(ModSchema))) ?? [];
    } catch {
      await this.logger.log('custom-mods.invalid');
    }
    // Tests and desktop smoke checks run against isolated application data and
    // never discover or create folders in the developer's real installation.
    if (
      !this.storage.state.settings.gamePath &&
      !this.storage.safetyError &&
      !process.env.MODATRO_TEST_DATA
    ) {
      try {
        await this.detect();
      } catch (error) {
        this.discoveryError =
          'Automatic game discovery could not finish. Choose your Balatro folder manually, or try Find automatically again.';
        await this.logger.log('game.detect.failed', String(error));
      }
    }
    this.initialized = true;
    await this.logger.log('app.start', {
      platform: process.platform,
      arch: process.arch,
      version: this.appVersion,
    });
  }
  backgroundRefresh() {
    void this.appUpdates.check();
    void Promise.all([
      this.trust.refresh(),
      this.repository.refresh().then(() => this.local.checkLatest(this.allMods())),
    ])
      .then(() => this.publish())
      .catch((e) => this.logger.log('background.failed', String(e)));
  }
  allMods(): ModDefinition[] {
    const ids = new Set(this.custom.map((m) => m.id));
    return [...this.custom, ...this.repository.catalogue.mods.filter((m) => !ids.has(m.id))].map(
      (mod) => {
        // Keep the original record identity when a native entry replaces an archived index ID.
        const matches = this.storage.state.installations.filter(
          (record) =>
            mod.legacyIds?.includes(record.modId) ||
            (!!mod.thunderstore && record.provenance?.packageId === mod.thunderstore.packageId),
        );
        const existing = matches.length === 1 ? matches[0] : undefined;
        return this.trust.apply({
          ...mod,
          id: existing?.modId ?? mod.id,
          folderName: existing?.folderName ?? mod.folderName,
          legacyIds: existing ? [...new Set([mod.id, ...(mod.legacyIds ?? [])])] : mod.legacyIds,
          description: allowedDescription(mod),
          unavailableReason:
            this.unavailableSources[existing?.modId ?? mod.id] ?? mod.unavailableReason,
        });
      },
    );
  }
  async githubStars() {
    return this.stars.get(this.allMods());
  }
  async checkAppUpdates() {
    await this.appUpdates.check();
    return this.snapshot();
  }
  async snapshot(): Promise<Snapshot> {
    let removedMods: Snapshot['removedMods'] = [],
      removedModsError: string | undefined,
      removedModsStorage: Snapshot['removedModsStorage'];
    try {
      const status = await this.installer.removed.inspect();
      removedMods = status.items.map((item) => ({
        id: item.id,
        title: item.record.title,
        version: item.record.modVersion,
        removedAt: item.removedAt,
        sizeBytes: item.sizeBytes,
        protected: item.protected,
        installed: this.storage.state.installations.some(
          (record) => record.modId === item.record.modId,
        ),
      }));
      removedModsStorage = {
        sizeBytes: status.sizeBytes,
        sizeIncomplete: status.sizeIncomplete,
        count: status.count,
      };
      removedModsError = status.warnings.join(' ') || undefined;
    } catch {
      removedModsError =
        'Uninstall backup records could not be verified. They have been preserved; open the backups folder in Settings to investigate.';
    }
    const gamePath = this.storage.state.settings.gamePath;
    const validation = gamePath ? await this.detection.validate(gamePath) : undefined;
    const local = await this.local.scan(this.allMods());
    if (validation?.valid)
      local.prerequisites.push({
        id: 'Balatro',
        displayName: 'Balatro',
        installed: true,
        installedVersion: validation.detectedVersion,
        sourceUrl: 'https://www.playbalatro.com',
      });
    return {
      settings: this.storage.state.settings,
      profiles: profileSummary(this.storage.state, local.mods.filter((m) => !m.managed).length),
      validation,
      catalogue: { ...this.repository.catalogue, mods: this.allMods() },
      localMods: local.mods,
      prerequisites: local.prerequisites,
      candidates: this.candidates,
      platform: process.platform,
      arch: process.arch,
      appVersion: this.appVersion,
      appUpdate: this.appUpdates.state,
      electronVersion: this.electronVersion,
      safetyError: this.storage.safetyError,
      discoveryError: this.discoveryError,
      operationReport: this.operationReport,
      removedMods,
      removedModsError,
      removedModsStorage,
      trust: { ...this.trust.state, fresh: this.trust.isFresh() },
    };
  }
  async publish() {
    if (this.publishing) {
      this.republish = true;
      return this.publishing;
    }
    this.publishing = (async () => {
      do {
        this.republish = false;
        this.changed(await this.snapshot());
      } while (this.republish);
    })();
    try {
      await this.publishing;
    } finally {
      this.publishing = undefined;
    }
  }
  async refresh() {
    await Promise.all([
      this.trust.refresh(),
      this.repository.refresh().then(() => this.local.checkLatest(this.allMods())),
    ]);
    // An explicit refresh allows a fresh upstream check on the next attempt.
    if (!this.repository.catalogue.stale && this.trust.isFresh()) {
      this.unavailableSources = {};
      await this.storage.write('data/unavailable-sources.json', {});
    }
    return this.snapshot();
  }
  async launchGame(modded: boolean, start: (snapshot: Snapshot) => Promise<void>) {
    return this.transactions.locked(async () => {
      const snapshot = await this.snapshot();
      if (!snapshot.validation?.valid)
        throw new UserError('Find a valid Balatro installation before launching.');
      if (modded && !snapshot.prerequisites.find((p) => p.id === 'Lovely')?.installed)
        throw new UserError(
          'Install Lovely using the Prerequisites page before launching modded Balatro.',
        );
      await this.launch.assertClosed();
      await start(snapshot);
    });
  }
  private assertSeparateDataRoot(selected: string) {
    if (contained(this.storage.root, selected) || contained(selected, this.storage.root))
      throw new UserError(
        'Game and Mods folders must be separate from Modatro’s application data.',
      );
  }
  async detect() {
    this.candidates = await this.detection.discover();
    await this.logger.log('game.detect', { candidates: this.candidates.length });
    if (
      this.candidates.length === 1 &&
      !this.storage.state.settings.gamePath &&
      !this.storage.safetyError
    )
      await this.setPath('game', this.candidates[0]!.path);
    this.discoveryError = undefined;
    return this.snapshot();
  }
  async setPath(kind: 'game' | 'mods', selected: string) {
    return this.transactions.locked(async () => {
      const state = this.storage.state;
      if (state.installations.length)
        throw new UserError(
          'Uninstall all managed mods before changing installation folders. Your records and backups refer to the current folders.',
        );
      if (kind === 'game') {
        const validation = await this.detection.validate(selected);
        await this.logger.log('game.validation', {
          valid: validation.valid,
          problems: validation.problems,
        });
        if (!validation.valid || !validation.canonicalPath)
          throw new UserError(validation.problems.map((p) => p.message).join('\n'));
        this.assertSeparateDataRoot(validation.canonicalPath);
        const modsPath =
          state.settings.modsPath ??
          (await this.detection.validateMods(
            this.detection.defaultModsPath(validation.canonicalPath),
            validation.canonicalPath,
            true,
          ));
        await this.detection.validateMods(modsPath, validation.canonicalPath);
        this.assertSeparateDataRoot(modsPath);
        await this.storage.save({
          ...state,
          settings: { ...state.settings, gamePath: validation.canonicalPath, modsPath },
        });
      } else {
        const modsPath = await this.detection.validateMods(selected, state.settings.gamePath);
        this.assertSeparateDataRoot(modsPath);
        await this.storage.save({ ...state, settings: { ...state.settings, modsPath } });
      }
      await this.logger.log('path.selected', { kind });
      this.discoveryError = undefined;
      return this.snapshot();
    });
  }
  async saveSettings(settings: SettingsUpdate) {
    if (settings.modIndexUrl !== undefined) {
      const value = ModIndexUrl.parse(settings.modIndexUrl);
      settings = { ...settings, modIndexUrl: value ? indexLocation(value).url : '' };
    }
    return this.transactions.locked(async () => {
      if (
        settings.creatorEnabled &&
        !(settings.creatorAcknowledged || this.storage.state.settings.creatorAcknowledged)
      )
        throw new UserError('Acknowledge the Mod Creator disclaimer before enabling it.');
      if (
        settings.setupComplete &&
        (!this.storage.state.settings.gamePath ||
          !(await this.detection.validate(this.storage.state.settings.gamePath)).valid)
      )
        throw new UserError('Find and validate Balatro before completing setup.');
      await this.storage.save({
        ...this.storage.state,
        settings: {
          ...this.storage.state.settings,
          ...settings,
          ...(settings.dismissedAnnouncements
            ? {
                dismissedAnnouncements: [
                  ...new Set([
                    ...(this.storage.state.settings.dismissedAnnouncements ?? []),
                    ...settings.dismissedAnnouncements,
                  ]),
                ],
              }
            : {}),
        },
      });
      await this.repository.configureIndex(this.storage.state.settings.modIndexUrl);
      return this.snapshot();
    });
  }
  private async dependencyPlan(
    root: ModDefinition | ModDefinition[],
    accepted: UnverifiedPrerequisite[],
    staged: ModDefinition[] = [],
    stagedPrerequisites: Prerequisite[] = [],
    developmentDependencies: string[] = [],
    selectedVersions: { id: string; key: string }[] = [],
  ) {
    // Downloaded metadata describes the planned files before they are committed.
    const installed = [...stagedPrerequisites, ...(await this.snapshot()).prerequisites];
    const roots = [
      ...new Map(
        [...(Array.isArray(root) ? root : [root]), ...staged].map((mod) => [mod.id, mod]),
      ).values(),
    ];
    const candidates = new Map(
      [...this.allMods(), ...roots, ...staged].map((mod) => [mod.id, mod]),
    );
    for (const choice of selectedVersions) {
      if (staged.some((mod) => mod.id === choice.id)) continue;
      const current = candidates.get(choice.id);
      if (!current) throw new UserError('The selected mod is no longer in the catalogue.');
      let history = this.releaseChoices.get(choice.id);
      if (!history || Date.now() - history.checked > 5 * 60 * 1000) {
        history = { checked: Date.now(), choices: (await publishedOptions(current)).choices };
        this.releaseChoices.set(choice.id, history);
      }
      const selected = history.choices.find((item) => item.key === choice.key)?.mod;
      if (!selected)
        throw new UserError(
          'This published version is no longer available. Reopen Versions and builds to check again.',
        );
      candidates.set(choice.id, selected);
    }
    const visited = new Set<string>();
    const visit = async (input: ModDefinition) => {
      if (visited.has(input.id)) return;
      if (visited.size >= 128)
        throw new UserError('The dependency plan is too large. No files were changed.');
      visited.add(input.id);
      const mod =
        staged.find((entry) => entry.id === input.id) ??
        (developmentDependencies.includes(input.id)
          ? await developmentDistribution(input)
          : await resolveDistribution(input));
      candidates.set(mod.id, mod);
      for (const requirement of mod.prerequisites.filter((entry) => entry.required)) {
        const status = evaluateDependency(requirement, installed);
        if (!blockingDependencies([status], accepted).length || status.state === 'unknown')
          continue;
        let matches = [...candidates.values()].filter((candidate) =>
          requirement.packageId
            ? candidate.source?.externalId.toLowerCase() === requirement.packageId.toLowerCase()
            : !candidate.deprecated &&
              (candidate.metadataId ?? candidate.id).toLowerCase() === requirement.id.toLowerCase(),
        );
        if (!matches.length && requirement.id === 'Lovely' && !requirement.packageId) {
          const lovely = await lovelyDistribution();
          candidates.set(lovely.id, lovely);
          matches = [lovely];
        }
        if (matches.length === 1) await visit(matches[0]!);
      }
    };
    try {
      for (const item of roots) await visit(candidates.get(item.id)!);
      return resolveDependencyGraph(
        roots.map((item) => candidates.get(item.id)!),
        [...candidates.values()],
        installed,
        accepted,
        [...candidates.values()]
          .filter(
            (candidate) =>
              (developmentDependencies.includes(candidate.id) ||
                (!!candidate.thunderstore && candidate.downloadProvider !== 'github')) &&
              !staged.some((mod) => mod.id === candidate.id),
          )
          .map(packageIdentity),
        stagedPrerequisites,
      );
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(
        error instanceof Error ? error.message : String(error),
        undefined,
        undefined,
        error instanceof DependencyGraphError
          ? {
              requirements: error.requirements,
              developmentDependency:
                error.candidate &&
                repositoryPath(error.candidate.repositoryUrl) &&
                error.candidate.installation.type !== 'lovely-injector' &&
                !developmentDependencies.includes(error.candidate.id)
                  ? {
                      id: error.candidate.id,
                      title: error.candidate.title,
                      repositoryUrl: error.candidate.repositoryUrl!,
                    }
                  : undefined,
              unverifiedPrerequisites: error.requirements.every(canAcceptUnverified)
                ? error.requirements
                : undefined,
            }
          : undefined,
      );
    }
  }
  async releaseOptions(id: string): Promise<ReleaseOptions> {
    const mod = this.allMods().find((item) => item.id === id);
    if (!mod) throw new UserError('This mod has no catalogue source for version selection.');
    const { choices, warning } = await publishedOptions(mod);
    this.releaseChoices.set(id, { checked: Date.now(), choices });
    const snapshot = await this.snapshot();
    return {
      id,
      title: mod.title,
      development: developmentAvailability(mod),
      warning:
        warning ??
        'Showing active Thunderstore packages and up to 100 published GitHub releases where available. Unsupported archives are omitted. Runtime metadata is checked before installation.',
      versions: choices.map((choice) => {
        let compatibility: 'compatible' | 'conflict' | 'unknown' =
          !snapshot.catalogue.stale &&
          choice.mod.thunderstore &&
          choice.mod.downloadProvider !== 'github'
            ? 'compatible'
            : 'unknown';
        let reason =
          compatibility === 'compatible'
            ? 'Published package requirements fit the proposed plan. Runtime requirements still need inspection.'
            : 'Compatibility cannot be established until the downloaded metadata is checked.';
        try {
          const graph = resolveDependencyGraph(
            [choice.mod],
            [...this.allMods().filter((item) => item.id !== id), choice.mod],
            snapshot.prerequisites,
          );
          const conflicts = affectedCompatibility(
            graph,
            snapshot.localMods,
            projectedPrerequisites(graph, snapshot.prerequisites),
          );
          if (conflicts.length) {
            compatibility = conflicts.every((conflict) => conflict.requirement.state === 'unknown')
              ? 'unknown'
              : 'conflict';
            reason = conflicts
              .map(
                (conflict) =>
                  `${conflict.title} requires ${conflict.requirement.displayName} ${conflict.requirement.versionConstraint ?? '(version not specified)'}; proposed ${conflict.proposedVersion ?? 'unknown'}.`,
              )
              .join(' ');
          }
        } catch (error) {
          compatibility = 'unknown';
          reason = error instanceof Error ? error.message : 'Requirements could not be checked.';
        }
        return {
          key: choice.key,
          version: choice.mod.version,
          source: choice.mod.downloadProvider === 'github' ? 'GitHub' : 'Thunderstore',
          compatibility,
          reason,
        };
      }),
    };
  }
  async restoreMod(id: string, token?: string) {
    this.operationReport = undefined;
    await this.installer.restore(id, token);
    return this.snapshot();
  }
  async deleteRemovedBackup(id?: string) {
    if (id !== undefined) z.uuid().parse(id);
    const result = await this.transactions.locked(() =>
      this.installer.removed.cleanup(id ?? 'all'),
    );
    return { ...result, snapshot: await this.snapshot() };
  }
  async action(
    id: string,
    action: ModAction,
    decisions: ConflictDecision[] = [],
    confirmationToken?: string,
    acceptedUnverified: UnverifiedPrerequisite[] = [],
    developmentDependencies: string[] = [],
    selectedVersions: { id: string; key: string }[] = [],
  ) {
    this.operationReport = undefined;
    if (developmentDependencies.length || selectedVersions.length) {
      for (const selected of [
        id,
        ...developmentDependencies,
        ...selectedVersions.map((choice) => choice.id),
      ])
        delete this.unavailableSources[selected];
      await this.storage.write('data/unavailable-sources.json', this.unavailableSources);
    }
    const mods = this.allMods();
    if (action === 'uninstall')
      this.operationReport = await this.installer.uninstall(id, decisions);
    else if (action === 'disable' || action === 'enable')
      await this.installer.toggle(id, action === 'disable', acceptedUnverified);
    else if (action === 'adopt') {
      const external = (await this.snapshot()).localMods.find((m) => m.id === id && m.canAdopt);
      if (!external) throw new UserError('This external mod could not be confidently identified.');
      const location = await safeDestination(
        this.storage.state.settings.modsPath!,
        external.folderName,
      );
      const { catalogueMatches, inspectMetadata, parseLuaHeader } =
        await import('./services/metadata');
      const metadata = external.folderName.endsWith('.lua')
        ? parseLuaHeader(await readSmall(location))
        : await inspectMetadata(location);
      if (!metadata) throw new UserError('This external mod has no supported identity metadata.');
      const matches = catalogueMatches(metadata, mods);
      if (matches.length > 1)
        throw new UserError(
          'The existing mod matches multiple catalogue entries. Adoption is blocked.',
        );
      await this.installer.adopt(external.folderName, matches[0]);
    } else {
      let mod = mods.find((m) => m.id === id);
      if (id === 'prerequisite:Lovely') {
        const candidates = mods.filter(
          (entry) => entry.installation.type === 'lovely-injector' && entry.metadataId === 'Lovely',
        );
        if (candidates.length > 1)
          throw new UserError('Multiple Lovely sources exist. Choose a specific source.');
        mod = await lovelyDistribution(candidates[0]);
        if (!mod.thunderstore) {
          this.custom = [...this.custom.filter((entry) => entry.id !== mod!.id), mod];
          await this.storage.write('data/custom-mods.json', this.custom);
        }
      }
      if (!mod)
        throw new UserError('This mod is not in the validated catalogue. Refresh and try again.');
      const existing = this.storage.state.installations.find((r) => r.modId === mod!.id);
      try {
        if (mod.source?.provider !== 'local') {
          const target = mod;
          const graph = await this.dependencyPlan(
            target,
            acceptedUnverified,
            [],
            [],
            developmentDependencies,
            selectedVersions,
          );
          await this.logger.log('dependencies.resolved', { ids: graph.map((entry) => entry.id) });
          await this.installer.installMany(
            graph,
            confirmationToken,
            acceptedUnverified,
            false,
            (staged, prerequisites) =>
              this.dependencyPlan(
                target,
                acceptedUnverified,
                staged,
                prerequisites,
                developmentDependencies,
                selectedVersions,
              ),
            selectedVersions.length > 0,
          );
        } else {
          const archive = mod.creator
            ? await this.creator.archiveFor(mod.creator)
            : this.localArchives.get(mod.id);
          if (mod.source?.provider === 'local' && !archive)
            throw new UserError('Choose the local ZIP again using Install from file.');
          await this.installer.install(
            mod,
            action === 'update' || !!existing,
            confirmationToken,
            false,
            acceptedUnverified,
            archive,
          );
          if (archive && !mod.creator) this.localArchives.delete(mod.id);
        }
      } catch (error) {
        if (error instanceof UserError && [404, 410].includes(error.statusCode ?? 0)) {
          this.unavailableSources[mod.id] =
            'The original download source is no longer available. Your installed copy has not been changed. Refresh to check again.';
          await this.storage.write('data/unavailable-sources.json', this.unavailableSources);
          await this.publish();
        }
        if (
          error instanceof UserError &&
          !error.context?.confirmation &&
          developmentDependencies.length
        ) {
          const candidate = this.allMods().find(
            (entry) => entry.id === developmentDependencies.at(-1),
          );
          if (candidate && developmentAvailability(candidate).available)
            throw new UserError(
              error.message,
              error.conflicts,
              error.details,
              {
                ...error.context,
                developmentDependency: {
                  id: candidate.id,
                  title: candidate.title,
                  repositoryUrl: candidate.repositoryUrl!,
                },
              },
              error.statusCode,
            );
        }
        throw error;
      }
    }
    return this.snapshot();
  }
  async importDefinition(file: string) {
    this.storage.assertSafe();
    if (file.toLowerCase().endsWith('.zip')) {
      const id = `local/${randomUUID()}`;
      const definition = ModSchema.parse({
        id,
        title: path.basename(file, path.extname(file)),
        author: 'Local file',
        version: 'Unknown',
        downloadUrl: 'https://github.com/NorthernBranch/modatro',
        categories: [],
        prerequisites: [],
        source: { provider: 'local', externalId: id },
        installation: { type: 'auto' },
        approvalStatus: 'legacy-index',
      });
      this.localArchives.set(id, file);
      this.custom.push(definition);
      await this.storage.write('data/custom-mods.json', this.custom);
      return this.action(id, 'install');
    }
    const definition = ModSchema.parse(JSON.parse(await readSmall(file)));
    if (this.allMods().some((m) => m.id === definition.id))
      throw new UserError(
        'A definition with this ID already exists. Use a unique ID so ownership remains clear.',
      );
    this.custom = [...this.custom, definition];
    await this.storage.write('data/custom-mods.json', this.custom);
    await this.logger.log('custom-mod.import', { id: definition.id });
    return this.snapshot();
  }
  async previewPlan(id: string) {
    const mod = this.allMods().find((entry) => entry.id === id);
    if (!mod) throw new UserError('This mod has no current catalogue definition.');
    if (mod.source?.provider !== 'local') {
      const graph = await this.dependencyPlan(mod, []);
      return this.installer.installMany(graph, undefined, [], true, (staged, prerequisites) =>
        this.dependencyPlan(mod, [], staged, prerequisites),
      );
    }
    const plan = await this.installer.install(
      mod,
      this.storage.state.installations.some((record) => record.modId === id),
      undefined,
      true,
      [],
      mod.creator ? await this.creator.archiveFor(mod.creator) : this.localArchives.get(mod.id),
    );
    if (!plan) throw new UserError('The install plan could not be prepared.');
    return plan;
  }
}
