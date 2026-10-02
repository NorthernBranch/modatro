import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  ModSchema,
  type ConflictDecision,
  type GameCandidate,
  type ModAction,
  type ModDefinition,
  type OperationReport,
  type Progress,
  type Settings,
  type Snapshot,
  type UnverifiedPrerequisite,
} from '../src/shared/model';
import { ModatroCatalogueRepository } from './services/catalogue';
import { GameDetectionService, LaunchService } from './services/detection';
import { UserError } from './services/errors';
import { contained, readSmall, safeDestination } from './services/files';
import { ModInstaller } from './services/installer';
import { InstalledModsService } from './services/local-mods';
import { remoteJson } from './services/network';
import { Logger, Storage } from './services/storage';
import { TransactionEngine } from './services/transaction';
import { CatalogueTrust } from './services/trust';
import { allowedDescription, automationReason } from '../src/shared/trust';
import { DependencyGraphError, resolveDependencyGraph } from '../src/shared/dependency-graph';
import {
  canAcceptUnverified,
  blockingDependencies,
  evaluateDependency,
} from '../src/shared/dependencies';
import { resolveDistribution } from './services/distribution';
import { LocalModSource } from './services/sources/mod-source';
import { lovelyDistribution } from './services/lovely';

export class ModatroApplication {
  readonly storage: Storage;
  readonly logger: Logger;
  readonly detection = new GameDetectionService();
  readonly launch = new LaunchService();
  readonly local: InstalledModsService;
  readonly repository: ModatroCatalogueRepository;
  readonly trust: CatalogueTrust;
  readonly transactions: TransactionEngine;
  readonly installer: ModInstaller;
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
  constructor(
    dataRoot: string,
    private appVersion: string,
    private electronVersion: string,
    progress: (value: Progress) => void,
    private changed: (value: Snapshot) => void,
  ) {
    this.storage = new Storage(dataRoot);
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
          const reason = automationReason(current, update);
          if (reason) throw new UserError(reason);
        }
        await this.trust.assertAllowed(mod, update);
      },
    );
  }
  async initialize() {
    await this.storage.initialize();
    await this.trust.initialize();
    if (!this.storage.safetyError) await this.transactions.recover();
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
  async snapshot(): Promise<Snapshot> {
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
      validation,
      catalogue: { ...this.repository.catalogue, mods: this.allMods() },
      localMods: local.mods,
      prerequisites: local.prerequisites,
      candidates: this.candidates,
      platform: process.platform,
      arch: process.arch,
      appVersion: this.appVersion,
      electronVersion: this.electronVersion,
      safetyError: this.storage.safetyError,
      discoveryError: this.discoveryError,
      operationReport: this.operationReport,
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
  async saveSettings(settings: Pick<Settings, 'theme' | 'setupComplete'>) {
    return this.transactions.locked(async () => {
      if (
        settings.setupComplete &&
        (!this.storage.state.settings.gamePath ||
          !(await this.detection.validate(this.storage.state.settings.gamePath)).valid)
      )
        throw new UserError('Find and validate Balatro before completing setup.');
      await this.storage.save({
        ...this.storage.state,
        settings: { ...this.storage.state.settings, ...settings },
      });
      return this.snapshot();
    });
  }
  private async dependencyPlan(
    root: ModDefinition,
    accepted: UnverifiedPrerequisite[],
    staged: ModDefinition[] = [],
  ) {
    const installed = (await this.snapshot()).prerequisites;
    const candidates = new Map([...this.allMods(), root, ...staged].map((mod) => [mod.id, mod]));
    const visited = new Set<string>();
    const visit = async (input: ModDefinition) => {
      if (visited.has(input.id)) return;
      if (visited.size >= 128)
        throw new UserError('The dependency plan is too large. No files were changed.');
      visited.add(input.id);
      const mod =
        staged.find((entry) => entry.id === input.id) ?? (await resolveDistribution(input));
      candidates.set(mod.id, mod);
      for (const requirement of mod.prerequisites.filter((entry) => entry.required)) {
        const status = evaluateDependency(requirement, installed);
        if (!blockingDependencies([status], accepted).length || status.state === 'unknown')
          continue;
        let matches = [...candidates.values()].filter((candidate) =>
          requirement.packageId
            ? candidate.source?.externalId.toLowerCase() === requirement.packageId.toLowerCase()
            : (candidate.metadataId ?? candidate.id).toLowerCase() === requirement.id.toLowerCase(),
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
      await visit(candidates.get(root.id)!);
      return resolveDependencyGraph(
        [candidates.get(root.id)!],
        [...candidates.values()],
        installed,
        accepted,
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
              unverifiedPrerequisites: error.requirements.every(canAcceptUnverified)
                ? error.requirements
                : undefined,
            }
          : undefined,
      );
    }
  }
  async action(
    id: string,
    action: ModAction,
    decisions: ConflictDecision[] = [],
    confirmationToken?: string,
    acceptedUnverified: UnverifiedPrerequisite[] = [],
  ) {
    this.operationReport = undefined;
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
          const graph = await this.dependencyPlan(target, acceptedUnverified);
          await this.logger.log('dependencies.resolved', { ids: graph.map((entry) => entry.id) });
          await this.installer.installMany(
            graph,
            confirmationToken,
            acceptedUnverified,
            false,
            (staged) => this.dependencyPlan(target, acceptedUnverified, staged),
          );
        } else {
          const archive = this.localArchives.get(mod.id);
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
          if (archive) this.localArchives.delete(mod.id);
        }
      } catch (error) {
        if (error instanceof UserError && [404, 410].includes(error.statusCode ?? 0)) {
          this.unavailableSources[mod.id] =
            'The original download source is no longer available. Your installed copy has not been changed. Refresh to check again.';
          await this.storage.write('data/unavailable-sources.json', this.unavailableSources);
          await this.publish();
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
      return this.installer.installMany(graph, undefined, [], true, (staged) =>
        this.dependencyPlan(mod, [], staged),
      );
    }
    const plan = await this.installer.install(
      mod,
      this.storage.state.installations.some((record) => record.modId === id),
      undefined,
      true,
    );
    if (!plan) throw new UserError('The install plan could not be prepared.');
    return plan;
  }
}
