import os from 'node:os';
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
} from '../src/shared/model';
import { BalatroModIndexRepository } from './services/catalogue';
import { GameDetectionService, LaunchService } from './services/detection';
import { UserError } from './services/errors';
import { contained, exists, readSmall } from './services/files';
import { ModInstaller } from './services/installer';
import { InstalledModsService } from './services/local-mods';
import { remoteJson } from './services/network';
import { Logger, Storage } from './services/storage';
import { TransactionEngine } from './services/transaction';

export class ModatroApplication {
  readonly storage: Storage;
  readonly logger: Logger;
  readonly detection = new GameDetectionService();
  readonly launch = new LaunchService();
  readonly local: InstalledModsService;
  readonly repository: BalatroModIndexRepository;
  readonly transactions: TransactionEngine;
  readonly installer: ModInstaller;
  private candidates: GameCandidate[] = [];
  private custom: ModDefinition[] = [];
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
    this.local = new InstalledModsService(this.storage, this.logger);
    this.repository = new BalatroModIndexRepository(this.storage, this.logger, () => {
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
    );
  }
  async initialize() {
    await this.storage.initialize();
    if (!this.storage.safetyError) await this.transactions.recover();
    await this.repository.loadCache();
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
    void Promise.all([this.repository.refresh(), this.local.checkLatest()])
      .then(() => this.publish())
      .catch((e) => this.logger.log('background.failed', String(e)));
  }
  allMods(): ModDefinition[] {
    const ids = new Set(this.custom.map((m) => m.id));
    return [...this.custom, ...this.repository.catalogue.mods.filter((m) => !ids.has(m.id))];
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
    await Promise.all([this.repository.refresh(), this.local.checkLatest()]);
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
            this.detection.defaultModsPath(),
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
  async action(id: string, action: ModAction, decisions: ConflictDecision[] = []) {
    this.operationReport = undefined;
    const mods = this.allMods();
    if (action === 'uninstall')
      this.operationReport = await this.installer.uninstall(id, decisions);
    else if (action === 'disable' || action === 'enable')
      await this.installer.toggle(id, action === 'disable');
    else if (action === 'adopt') {
      const external = (await this.snapshot()).localMods.find((m) => m.id === id && m.canAdopt);
      if (!external) throw new UserError('This external mod could not be confidently identified.');
      const location = path.join(this.storage.state.settings.modsPath!, external.folderName);
      const { catalogueMatches, inspectMetadata } = await import('./services/metadata');
      const metadata = await inspectMetadata(location);
      const matches = catalogueMatches(metadata, mods);
      if (matches.length !== 1)
        throw new UserError(
          'The existing mod matches multiple catalogue entries. Adoption is blocked.',
        );
      await this.installer.adopt(external.folderName, matches[0]!);
    } else {
      let mod = mods.find((m) => m.id === id);
      if (!mod && id === 'prerequisite:Lovely' && process.platform === 'win32') {
        if (
          this.storage.state.settings.gamePath &&
          (await exists(path.join(this.storage.state.settings.gamePath, 'version.dll')))
        )
          throw new UserError(
            'An older Lovely version.dll may still be installed. Follow Lovely’s official upgrade instructions before using automatic installation.',
          );
        const release = z
          .object({
            tag_name: z.string(),
            assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
          })
          .parse(
            await remoteJson(
              'https://api.github.com/repos/ethangreen-dev/lovely-injector/releases/latest',
            ),
          );
        const asset = release.assets.find((a) => a.name === 'lovely-x86_64-pc-windows-msvc.zip');
        if (!asset)
          throw new UserError(
            'The official Windows Lovely asset could not be identified. Use the official instructions.',
          );
        mod = ModSchema.parse({
          id: 'Lovely',
          title: 'Lovely',
          author: 'ethangreen-dev',
          version: release.tag_name.replace(/^v/, ''),
          categories: ['Technical'],
          downloadUrl: asset.browser_download_url,
          repositoryUrl: 'https://github.com/ethangreen-dev/lovely-injector',
          prerequisites: [],
          installation: {
            type: 'game-replacement',
            files: [{ source: 'winmm.dll', destination: 'winmm.dll' }],
          },
        });
      }
      if (!mod)
        throw new UserError('This mod is not in the validated catalogue. Refresh and try again.');
      const existing = this.storage.state.installations.find((r) => r.modId === mod!.id);
      // Keep the known Lovely definition for subsequent updates and detail views.
      if (id === 'prerequisite:Lovely') {
        this.custom = [...this.custom.filter((m) => m.id !== mod!.id), mod];
        await this.storage.write('data/custom-mods.json', this.custom);
      }
      await this.installer.install(mod, action === 'update' || !!existing);
    }
    return this.snapshot();
  }
  async importDefinition(file: string) {
    this.storage.assertSafe();
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
}
