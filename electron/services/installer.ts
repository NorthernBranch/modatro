import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConflictDecision,
  DependencyStatus,
  FileConflict,
  FileRoot,
  InstallationRecord,
  InstallationSource,
  InstalledFileRecord,
  InstallPlan,
  ModDefinition,
  Prerequisite,
  Progress,
  UnverifiedPrerequisite,
} from '../../src/shared/model';
import { ModSchema, RecordSchema, SafeName } from '../../src/shared/model';
import { ArchiveService } from './archive';
import { GameDetectionService, LaunchService } from './detection';
import { UserError } from './errors';
import {
  atomicCopy,
  canonicalDirectory,
  contained,
  exists,
  hashFile,
  readSmall,
  safeDestination,
  walkFiles,
} from './files';
import {
  dependencyId,
  detectModRoot,
  inspectMetadata,
  mergeRequirements,
  parseLuaHeader,
} from './metadata';
import { DownloadService } from './network';
import { Logger, Storage } from './storage';
import { selectStrategy } from './strategies';
import { TransactionEngine, type Change } from './transaction';
import { evaluateDependencies } from './versions';
import { blockingDependencies, canAcceptUnverified } from '../../src/shared/dependencies';
import { automationReason, defaultFolder } from '../../src/shared/trust';
import { ArtifactHistory } from './artifacts';
import { resolveDistribution, validateDistribution } from './distribution';
import { validateThunderstoreArchive } from './thunderstore';
import { thunderstoreId } from '../../src/shared/thunderstore';
import { AuthorManifestSchema } from '../../src/shared/catalogue-schema';

export interface PreparedInstallation {
  plan: InstallPlan;
  changes: Change[];
  mod: ModDefinition;
  folderName: string;
  dependencies: DependencyStatus[];
  metadataId?: string;
  previous?: InstallationRecord;
  provenance?: InstallationSource;
}
export class ModInstaller {
  private abort?: AbortController;
  private confirmation?: { token: string; fingerprint: string; expires: number };
  constructor(
    private storage: Storage,
    readonly transactions: TransactionEngine,
    private detection: GameDetectionService,
    private launch: LaunchService,
    private logger: Logger,
    private progress: (event: Progress) => void,
    private getPrerequisites: () => Promise<Prerequisite[]>,
    private verifyTrust?: (mod: ModDefinition, update: boolean) => Promise<void>,
  ) {}
  cancel() {
    this.abort?.abort();
  }
  roots(): Record<FileRoot, string> {
    return {
      game: this.storage.state.settings.gamePath ?? '',
      mods: this.storage.state.settings.modsPath ?? '',
      disabled: this.storage.file('disabled'),
    };
  }
  async guard() {
    this.storage.assertSafe();
    await this.launch.assertClosed();
    const settings = this.storage.state.settings;
    if (!settings.gamePath || !settings.modsPath)
      throw new UserError('Find Balatro and choose a Mods directory in Settings first.');
    for (const root of [settings.gamePath, settings.modsPath])
      if (contained(this.storage.root, root) || contained(root, this.storage.root))
        throw new UserError(
          'Game and Mods folders must be separate from Modatro’s application data.',
        );
    const validation = await this.detection.validate(settings.gamePath);
    await this.logger.log('game.validation', {
      valid: validation.valid,
      problems: validation.problems,
    });
    if (!validation.valid || validation.canonicalPath !== settings.gamePath)
      throw new UserError(
        validation.problems.map((p) => p.message).join(' ') ||
          'The Balatro folder has moved. Select it again.',
      );
    if (
      (await this.detection.validateMods(settings.modsPath, settings.gamePath)) !==
      settings.modsPath
    )
      throw new UserError('The Mods folder has moved. Select it again.');
  }
  private assertDependencies(
    dependencies: DependencyStatus[],
    accepted: UnverifiedPrerequisite[],
    prefix = '',
  ) {
    const blocked = blockingDependencies(dependencies, accepted);
    if (blocked.length)
      throw new UserError(
        prefix + blocked.map((requirement) => requirement.reason).join(' '),
        undefined,
        undefined,
        {
          requirements: blocked,
          unverifiedPrerequisites: blocked.every(canAcceptUnverified) ? blocked : undefined,
        },
      );
  }
  async install(
    input: ModDefinition,
    update = false,
    confirmationToken?: string,
    inspect = false,
    acceptedUnverified: UnverifiedPrerequisite[] = [],
  ) {
    return this.transactions.locked(async () => {
      await this.guard();
      let mod = ModSchema.parse(input);
      await this.verifyTrust?.(mod, update);
      mod = this.verifyTrust ? await resolveDistribution(mod) : mod;
      if (mod.thunderstore) validateDistribution(mod);
      const reason = automationReason(mod, update);
      if (reason) throw new UserError(reason);
      await this.verifyTrust?.(mod, update);
      const previous = this.storage.state.installations.find((r) => r.modId === mod.id);
      if (previous && !update)
        throw new UserError('This mod is already managed by Modatro. Use Update instead.');
      if (update && !previous) throw new UserError('This mod is not managed by Modatro.');
      if (previous?.disabled) throw new UserError('Enable this mod before updating it.');
      const dependencies = evaluateDependencies(mod.prerequisites, await this.getPrerequisites());
      this.assertDependencies(dependencies, acceptedUnverified);
      const stage = await fs.mkdtemp(this.storage.file('staging/install-'));
      let download: string | undefined;
      const abort = new AbortController();
      this.abort = abort;
      try {
        this.progress({ modId: mod.id, phase: 'downloading', percent: 0 });
        await this.logger.log('download.start', { modId: mod.id });
        const downloader = new DownloadService(this.storage.file('downloads'));
        download = await downloader.download(
          mod.downloadUrl,
          abort.signal,
          (percent) => this.progress({ modId: mod.id, phase: 'downloading', percent }),
          mod.thunderstore ? 'thunderstore' : 'github',
        );
        const provenance = await new ArtifactHistory(this.storage, this.logger).verify(
          mod,
          await hashFile(download),
        );
        provenance.finalUrl = downloader.finalUrl ?? mod.downloadUrl;
        await this.logger.log('download.complete', {
          modId: mod.id,
          version: mod.version,
          ...provenance,
        });
        this.progress({ modId: mod.id, phase: 'validating' });
        const directFile = new URL(mod.downloadUrl).pathname.endsWith('.lua');
        if (directFile) await atomicCopy(download, path.join(stage, 'mod.lua'));
        else await new ArchiveService().extract(download, stage, abort.signal);
        await validateThunderstoreArchive(mod, stage);
        abort.signal.throwIfAborted();
        this.progress({ modId: mod.id, phase: 'planning' });
        const prepared = await this.plan(mod, stage, directFile);
        prepared.provenance = provenance;
        if (prepared.plan.conflicts.length)
          throw new UserError(
            'This mod conflicts with existing files. No files were changed.',
            prepared.plan.conflicts,
          );
        this.assertDependencies(
          prepared.dependencies,
          acceptedUnverified,
          'The downloaded mod has additional requirements: ',
        );
        abort.signal.throwIfAborted();
        await this.verifyTrust?.(prepared.mod, update);
        await this.guard();
        // Recheck immediately before committing, including requirements found in the archive.
        prepared.dependencies = evaluateDependencies(
          prepared.dependencies,
          await this.getPrerequisites(),
        );
        prepared.plan.prerequisites = prepared.dependencies;
        this.assertDependencies(prepared.dependencies, acceptedUnverified);
        if (inspect) return this.inspectablePlan(prepared.plan);
        if (prepared.changes.some((change) => change.root === 'game')) {
          const visible = this.inspectablePlan(prepared.plan);
          const fingerprint = createHash('sha256')
            .update(JSON.stringify({ update, ...visible }))
            .digest('hex');
          if (
            !confirmationToken ||
            confirmationToken !== this.confirmation?.token ||
            fingerprint !== this.confirmation.fingerprint ||
            Date.now() > this.confirmation.expires
          ) {
            const token = randomUUID();
            this.confirmation = { token, fingerprint, expires: Date.now() + 10 * 60 * 1000 };
            throw new UserError(
              'Review the actual game-file changes before continuing.',
              undefined,
              undefined,
              { confirmation: { token, plan: visible } },
            );
          }
          this.confirmation = undefined;
        }
        this.abort = undefined;
        this.progress({ modId: mod.id, phase: 'backing-up' });
        await this.logger.log('install.plan', {
          modId: mod.id,
          create: prepared.plan.create.length,
          replace: prepared.plan.replace.length,
          remove: prepared.plan.remove.length,
          acceptedUnverified: prepared.dependencies.filter(
            (requirement) => requirement.required && canAcceptUnverified(requirement),
          ),
        });
        await this.commitPrepared(prepared, acceptedUnverified);
        await this.logger.log('install.complete', {
          modId: mod.id,
          version: prepared.mod.version,
          provenance,
          strategy: prepared.mod.installation.type,
          filesCreated: prepared.plan.create.map((f) => `${f.root}/${f.path}`),
          filesReplaced: prepared.plan.replace.map((f) => `${f.root}/${f.path}`),
          transaction: this.storage.state.lastTransaction,
          result: 'committed',
        });
        this.progress({ modId: mod.id, phase: 'complete', percent: 100 });
      } catch (e) {
        await this.logger.log('install.failed', { modId: mod.id, error: String(e) });
        throw e;
      } finally {
        this.abort = undefined;
        if (download) await fs.rm(download, { force: true });
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  private inspectablePlan(plan: InstallPlan): InstallPlan {
    const file = ({ root, path, hash }: { root: FileRoot; path: string; hash?: string }) => ({
      root,
      path,
      hash,
    });
    return {
      ...plan,
      create: plan.create.map(file),
      replace: plan.replace.map((f) => ({ ...file(f), previousHash: f.previousHash })),
      remove: plan.remove.map(file),
    };
  }
  async plan(
    input: ModDefinition,
    staging: string,
    directFile = false,
  ): Promise<PreparedInstallation> {
    let mod = ModSchema.parse(input);
    const previous = this.storage.state.installations.find((r) => r.modId === mod.id),
      roots = this.roots();
    if (previous?.adopted)
      mod = ModSchema.parse({ ...mod, folderName: previous.folderName.replace(/\.lua$/, '') });
    const strategy = selectStrategy({ mod, staging, directFile });
    const files = await strategy.plan({ mod, staging, directFile });
    if (
      (mod.id === 'Lovely' || mod.metadataId === 'Lovely') &&
      mod.installation.type === 'game-replacement'
    ) {
      const library = files.find(
        (file) => file.root === 'game' && /\.(?:dll|dylib|so)$/i.test(file.path),
      );
      if (!library || files.length !== 1)
        throw new UserError(
          'Lovely’s package layout has changed. Automatic updating is temporarily unsupported; use the official instructions.',
        );
      const bytes = await fs.readFile(library.source);
      const nativeFormat =
        bytes.subarray(0, 2).toString() === 'MZ' ||
        [
          'cffaedfe',
          'cefaedfe',
          'feedfacf',
          'feedface',
          'cafebabe',
          'bebafeca',
          '7f454c46',
        ].includes(bytes.subarray(0, 4).toString('hex'));
      if (!nativeFormat || !/lovely/i.test(bytes.subarray(0, 16 * 1024 * 1024).toString('latin1')))
        throw new UserError(
          'The downloaded Lovely library could not be positively identified. No game files were changed.',
        );
    }
    const stageRoot = await canonicalDirectory(staging);
    let requirements = mod.prerequisites;
    let metadataId: string | undefined = mod.metadataId;
    if (mod.installation.type !== 'game-replacement') {
      const root = directFile
        ? staging
        : mod.installation.type === 'standard' && mod.installation.sourceRoot
          ? await safeDestination(staging, mod.installation.sourceRoot)
          : await detectModRoot(staging);
      const metadata = directFile
        ? parseLuaHeader(await readSmall(path.join(staging, 'mod.lua')))
        : await inspectMetadata(root);
      const authorManifest = path.join(root, 'modatro.json');
      if (await exists(authorManifest)) {
        const manifest = AuthorManifestSchema.parse(
          JSON.parse(await readSmall(await safeDestination(root, 'modatro.json'))),
        );
        if (
          manifest.id !== mod.id &&
          manifest.id !== mod.metadataId &&
          manifest.id !== metadata?.id &&
          !mod.legacyIds?.includes(manifest.id)
        )
          throw new UserError('The downloaded author manifest identifies a different mod.');
        const update = !!previous;
        if (!manifest.permissions.display || !manifest.permissions[update ? 'update' : 'install'])
          throw new UserError('The author manifest does not permit this installation or update.');
        requirements = mergeRequirements(
          requirements,
          Object.entries(manifest.requirements).map(([id, versionConstraint]) => ({
            id: dependencyId(id),
            displayName: id,
            versionConstraint,
            required: true,
          })),
        );
        if (manifest.installation.type === 'manual-install-required')
          throw new UserError(
            'The author requires manual installation. View the project’s instructions.',
          );
      }
      metadataId = metadata?.id;
      if (
        previous?.metadataId &&
        metadataId &&
        previous.metadataId.toLowerCase() !== metadataId.toLowerCase()
      )
        throw new UserError(
          'The downloaded files identify a different mod from the managed installation. No files were changed.',
        );
      // A structured version describes the files being installed more precisely
      // than a catalogue entry whose URL may point at a moving branch.
      if (metadata?.version) {
        if (
          !mod.thunderstore &&
          ['release-asset', 'tag'].includes(mod.releaseSource?.sourceType ?? '') &&
          metadata.version.replace(/^v/, '') !== mod.version.replace(/^v/, '')
        )
          throw new UserError(
            'The downloaded metadata version differs from the published release. Automatic installation has been stopped.',
          );
        mod = ModSchema.parse({ ...mod, version: metadata.version });
      }
      requirements = mergeRequirements(requirements, metadata?.requirements ?? []);
      const paths = await walkFiles(root);
      if (
        paths.includes('lovely.toml') ||
        paths.some((p) => p.startsWith('lovely/') && p.endsWith('.toml'))
      )
        requirements = mergeRequirements(requirements, [
          { id: 'Lovely', displayName: 'Lovely', required: true },
        ]);
      const prerequisites = await this.getPrerequisites();
      for (const conflict of metadata?.conflicts ?? []) {
        const found = evaluateDependencies([conflict], prerequisites)[0];
        if (
          found?.state === 'satisfied' ||
          (found?.state === 'unknown' &&
            prerequisites.some((p) => p.id === conflict.id && p.installed))
        )
          throw new UserError(
            `This mod declares a conflict with installed ${conflict.displayName}. Resolve it before installing.`,
          );
      }
    }
    const dependencies = evaluateDependencies(requirements, await this.getPrerequisites());
    const plan: InstallPlan = {
      modId: mod.id,
      version: mod.version,
      create: [],
      replace: [],
      remove: [],
      prerequisites: dependencies,
      conflicts: [],
    };
    const changes: Change[] = [];
    const destinations = new Set<string>();
    for (const file of files) {
      const key = `${file.root}:${file.path.toLowerCase()}`;
      if (destinations.has(key))
        throw new UserError('The mod contains duplicate file destinations.');
      destinations.add(key);
      const sourceRelative = path.relative(stageRoot, file.source).split(path.sep).join('/');
      const safeSource = await safeDestination(stageRoot, sourceRelative);
      const destination = await safeDestination(roots[file.root], file.path),
        afterHash = await hashFile(safeSource);
      const owner = this.storage.state.installations.find(
        (r) =>
          r.modId !== mod.id && r.files.some((f) => `${f.root}:${f.path.toLowerCase()}` === key),
      );
      const previousFile = previous?.files.find((f) => `${f.root}:${f.path.toLowerCase()}` === key);
      const beforeHash = (await exists(destination)) ? await hashFile(destination) : undefined;
      if (owner)
        plan.conflicts.push({
          root: file.root,
          path: file.path,
          owner: owner.title,
          reason: `${owner.title} already owns this file.`,
          canRestore: false,
        });
      else if (previousFile && beforeHash !== previousFile.installedHash)
        plan.conflicts.push({
          root: file.root,
          path: file.path,
          reason:
            'This installed file has changed or is missing. Updating would discard the change.',
          canRestore: false,
        });
      else if (beforeHash && !previousFile && file.root !== 'game')
        plan.conflicts.push({
          root: file.root,
          path: file.path,
          reason:
            'This file is installed externally. Adopt the existing mod or move it before installing.',
          canRestore: false,
        });
      // Never take over a pre-existing directory containing unowned files, even
      // if none happen to share a destination filename.
      if (
        !previous &&
        file.root === 'mods' &&
        file.path.includes('/') &&
        (await exists(await safeDestination(roots.mods, file.path.split('/')[0]!)))
      ) {
        if (!plan.conflicts.some((c) => c.root === 'mods' && c.path === file.path))
          plan.conflicts.push({
            root: 'mods',
            path: file.path,
            reason: 'The destination mod folder already exists outside Modatro. Adopt it first.',
            canRestore: false,
          });
      }
      changes.push({
        root: file.root,
        path: file.path,
        source: safeSource,
        expectedBefore: beforeHash,
        afterHash,
      });
      if (beforeHash) plan.replace.push({ ...file, hash: afterHash, previousHash: beforeHash });
      else plan.create.push({ ...file, hash: afterHash });
    }
    for (const old of previous?.files ?? []) {
      if (destinations.has(`${old.root}:${old.path.toLowerCase()}`)) continue;
      const destination = await safeDestination(roots[old.root], old.path),
        current = (await exists(destination)) ? await hashFile(destination) : undefined;
      if (current !== old.installedHash) {
        plan.conflicts.push({
          root: old.root,
          path: old.path,
          reason: 'An obsolete file has changed. Updating would discard the change.',
          canRestore: false,
        });
        continue;
      }
      const source =
        old.operation === 'replaced'
          ? await this.transactions.backup.verified(old.backupPath!, old.originalHash!)
          : undefined;
      changes.push({
        root: old.root,
        path: old.path,
        expectedBefore: current,
        source,
        afterHash: source ? old.originalHash : undefined,
      });
      plan.remove.push({ root: old.root, path: old.path });
    }
    if (!files.length) throw new UserError('The install plan is empty.');
    return {
      plan,
      changes,
      mod,
      dependencies,
      metadataId,
      previous,
      folderName: SafeName.parse(defaultFolder(mod)),
    };
  }
  async commitPrepared(
    prepared: PreparedInstallation,
    acceptedUnverified: UnverifiedPrerequisite[] = [],
  ) {
    if (
      prepared.plan.conflicts.length ||
      blockingDependencies(prepared.dependencies, acceptedUnverified).length
    )
      throw new UserError('The install plan is not eligible to commit.');
    this.progress({ modId: prepared.mod.id, phase: 'installing' });
    await this.transactions.execute(this.roots(), prepared.changes, (journal) => {
      const destinations = [...prepared.plan.create, ...prepared.plan.replace];
      const record = RecordSchema.parse({
        modId: prepared.mod.id,
        title: prepared.mod.title,
        modVersion: prepared.mod.version,
        installedAt: new Date().toISOString(),
        dependencies: prepared.dependencies.map(
          ({ id, displayName, versionConstraint, required, packageId }) => ({
            id,
            displayName,
            versionConstraint,
            required,
            packageId,
          }),
        ),
        source: prepared.mod.downloadUrl,
        provenance: prepared.provenance ?? { sourceType: 'legacy' },
        folderName: prepared.folderName,
        transactionId: journal.id,
        metadataId: prepared.metadataId ?? prepared.previous?.metadataId,
        packageVersion: prepared.mod.thunderstore?.packageVersion,
        disabled: false,
        files: destinations.map((file) => {
          const before = journal.changes.find((c) => c.root === file.root && c.path === file.path)!;
          const previous = prepared.previous?.files.find(
            (f) => f.root === file.root && f.path.toLowerCase() === file.path.toLowerCase(),
          );
          const operation = previous?.operation ?? (before.beforeHash ? 'replaced' : 'created');
          return {
            root: file.root,
            path: file.path,
            installedHash: file.hash,
            operation,
            originalHash:
              operation === 'replaced' ? (previous?.originalHash ?? before.beforeHash) : undefined,
            backupPath:
              operation === 'replaced' ? (previous?.backupPath ?? before.beforeBackup) : undefined,
          };
        }),
      });
      return {
        ...this.storage.state,
        installations: [
          ...this.storage.state.installations.filter((r) => r.modId !== record.modId),
          record,
        ],
      };
    });
    await this.cleanupEmptyDirectories(
      prepared.previous?.files.map((f) => ({ root: f.root, path: f.path })) ?? [],
    );
  }
  private async assertNotRequired(record: InstallationRecord) {
    const source = record.provenance?.downloadUrl ?? record.source;
    const registry = source
      ? /^https:\/\/thunderstore\.io\/package\/download\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)\//.exec(
          source,
        )
      : undefined;
    const identities = new Set(
      [
        record.metadataId,
        record.title,
        record.modId,
        record.modId.split('@').pop(),
        registry ? thunderstoreId(registry[1]!, registry[2]!) : undefined,
      ]
        .filter((id): id is string => !!id)
        .map((id) => dependencyId(id).toLowerCase()),
    );
    const dependents = this.storage.state.installations.filter(
      (r) =>
        r.modId !== record.modId &&
        !r.disabled &&
        r.dependencies.some(
          (d) =>
            d.required &&
            (identities.has(dependencyId(d.id).toLowerCase()) ||
              (!!d.packageId && identities.has(d.packageId.toLowerCase()))),
        ),
    );
    if (dependents.length)
      throw new UserError(
        `${record.title} is required by ${dependents.map((r) => r.title).join(', ')}. Disable or uninstall those mods first.`,
      );
    const mods = this.storage.state.settings.modsPath;
    if (mods)
      for (const entry of await fs.readdir(mods, { withFileTypes: true })) {
        if (
          record.files.some(
            (f) =>
              f.root === 'mods' && (f.path === entry.name || f.path.startsWith(`${entry.name}/`)),
          )
        )
          continue;
        try {
          const location = await safeDestination(mods, entry.name);
          const metadata = entry.isDirectory()
            ? await inspectMetadata(location)
            : entry.isFile() && entry.name.endsWith('.lua')
              ? parseLuaHeader(await readSmall(location))
              : undefined;
          if (
            metadata?.requirements.some(
              (d) =>
                d.required &&
                (identities.has(dependencyId(d.id).toLowerCase()) ||
                  (!!d.packageId && identities.has(d.packageId.toLowerCase()))),
            )
          )
            throw new UserError(
              `${record.title} is required by ${metadata.name ?? entry.name}. Remove or disable that dependency chain first.`,
            );
        } catch (e) {
          if (e instanceof UserError && e.message.includes('is required by')) throw e;
        }
      }
  }
  async uninstall(id: string, decisions: ConflictDecision[] = []) {
    return this.transactions.locked(async () => {
      await this.guard();
      const record = this.storage.state.installations.find((r) => r.modId === id);
      if (!record)
        throw new UserError(
          'Only Modatro-managed mods can be uninstalled. External files are left untouched.',
        );
      await this.assertNotRequired(record);
      const roots = this.roots(),
        changes: Change[] = [],
        conflicts: FileConflict[] = [];
      for (const file of record.files) {
        const destination = await safeDestination(roots[file.root], file.path),
          current = (await exists(destination)) ? await hashFile(destination) : undefined;
        const decision = decisions.find((d) => d.root === file.root && d.path === file.path);
        if (current !== file.installedHash) {
          if (decision?.action === 'keep') continue;
          if (decision?.action !== 'restore' || file.operation !== 'replaced') {
            conflicts.push({
              root: file.root,
              path: file.path,
              reason:
                'This file has changed since installation. Keeping it preserves your changes.',
              canRestore: file.operation === 'replaced',
            });
            continue;
          }
        }
        const source =
          file.operation === 'replaced'
            ? await this.transactions.backup.verified(file.backupPath!, file.originalHash!)
            : undefined;
        changes.push({
          root: file.root,
          path: file.path,
          expectedBefore: current,
          source,
          afterHash: source ? file.originalHash : undefined,
        });
      }
      if (conflicts.length)
        throw new UserError(
          'Some files have changed outside Modatro. Choose how to handle each file before uninstalling.',
          conflicts,
        );
      await this.transactions.execute(roots, changes, () => ({
        ...this.storage.state,
        installations: this.storage.state.installations.filter((r) => r.modId !== id),
      }));
      const cleanupProblems = await this.cleanupEmptyDirectories(record.files);
      for (const change of changes) {
        const file = await safeDestination(roots[change.root], change.path);
        if (
          change.afterHash
            ? !(await exists(file)) || (await hashFile(file)) !== change.afterHash
            : await exists(file)
        )
          throw new UserError(
            `Uninstall finished but ${change.path} could not be verified. Keep your backups and inspect this file.`,
          );
      }
      await this.logger.log('uninstall.complete', {
        modId: id,
        preserved: decisions.filter((d) => d.action === 'keep').map((d) => d.path),
      });
      const retainedFiles = new Set<string>();
      for (const file of record.files) {
        if (
          decisions.some(
            (decision) =>
              decision.root === file.root &&
              decision.path === file.path &&
              decision.action === 'keep',
          ) &&
          (await exists(await safeDestination(roots[file.root], file.path)))
        )
          retainedFiles.add(`${file.root}/${file.path}`);
      }
      const modFolders = new Set(
        record.files
          .filter((file) => file.root !== 'game' && file.path.includes('/'))
          .map((file) => `${file.root}:${file.path.split('/')[0]}`),
      );
      for (const key of modFolders) {
        const [root, folder] = key.split(':') as [FileRoot, string];
        try {
          const directory = await safeDestination(roots[root], folder);
          if (await exists(directory))
            for (const file of await walkFiles(directory))
              retainedFiles.add(`${root}/${folder}/${file}`);
        } catch (error) {
          cleanupProblems.push(
            `${root}/${folder}: remaining files could not be inspected (${String(error)}).`,
          );
        }
      }
      return {
        title: `${record.title} was uninstalled`,
        retainedFiles: [...retainedFiles].sort(),
        cleanupProblems,
      };
    });
  }
  async toggle(id: string, disabled: boolean, acceptedUnverified: UnverifiedPrerequisite[] = []) {
    return this.transactions.locked(async () => {
      await this.guard();
      const record = this.storage.state.installations.find((r) => r.modId === id);
      if (!record || record.disabled === disabled)
        throw new UserError('The mod’s state has changed. Refresh and try again.');
      if (record.files.some((f) => f.operation !== 'created' || f.root === 'game'))
        throw new UserError(
          'File-replacing mods cannot safely be disabled. Uninstall to restore their originals.',
        );
      if (disabled) await this.assertNotRequired(record);
      else {
        const dependencies = evaluateDependencies(
          record.dependencies,
          await this.getPrerequisites(),
        );
        this.assertDependencies(dependencies, acceptedUnverified);
        await this.logger.log('enable.prerequisites', {
          modId: id,
          acceptedUnverified: dependencies.filter(
            (requirement) => requirement.required && canAcceptUnverified(requirement),
          ),
        });
      }
      const roots = this.roots(),
        changes: Change[] = [];
      if (disabled) {
        const folders = new Set(
          record.files
            .filter((file) => file.path.includes('/'))
            .map((file) => file.path.split('/')[0]!),
        );
        const owned = new Set(record.files.map((file) => file.path));
        for (const folder of folders) {
          const source = await safeDestination(roots.mods, folder);
          const unknown = (await walkFiles(source)).find((file) => !owned.has(`${folder}/${file}`));
          if (unknown)
            throw new UserError(
              `“${folder}/${unknown}” is not recorded by Modatro. Move or adopt the added files before disabling this mod; leaving them active could leave part of the mod enabled.`,
            );
        }
      } else {
        const activeFolders = new Set(
          record.files
            .map((file) => file.path.slice(record.modId.length + 1))
            .filter((file) => file.includes('/'))
            .map((file) => file.split('/')[0]!),
        );
        for (const folder of activeFolders) {
          const destination = await safeDestination(roots.mods, folder);
          if ((await exists(destination)) && (await walkFiles(destination)).length)
            throw new UserError(
              'An external destination already exists. Resolve the folder conflict before enabling this mod.',
            );
        }
      }
      const nextFiles: InstalledFileRecord[] = [];
      for (const f of record.files) {
        const current = await safeDestination(roots[f.root], f.path);
        if (!(await exists(current)) || (await hashFile(current)) !== f.installedHash)
          throw new UserError(`“${f.path}” has changed or is missing. It will not be moved.`);
        const targetRoot = disabled ? ('disabled' as const) : ('mods' as const);
        const targetPath = disabled
          ? `${record.modId}/${f.path}`
          : f.path.slice(record.modId.length + 1);
        const target = await safeDestination(roots[targetRoot], targetPath);
        if (await exists(target))
          throw new UserError(
            'The destination already exists. Resolve the conflict before enabling or disabling this mod.',
          );
        const owner = this.storage.state.installations.find(
          (r) =>
            r.modId !== id &&
            r.files.some(
              (owned) =>
                owned.root === targetRoot && owned.path.toLowerCase() === targetPath.toLowerCase(),
            ),
        );
        if (owner) throw new UserError(`${owner.title} owns the destination.`);
        changes.push(
          { root: targetRoot, path: targetPath, source: current, afterHash: f.installedHash },
          { root: f.root, path: f.path, expectedBefore: f.installedHash },
        );
        nextFiles.push({ ...f, root: targetRoot, path: targetPath });
      }
      // Capture all sources into staging first. A transaction never relies on
      // sources which one of its own earlier operations removes.
      const staging = await fs.mkdtemp(this.storage.file('staging/toggle-'));
      try {
        for (let i = 0; i < changes.length; i++) {
          const c = changes[i]!;
          if (c.source) {
            const temp = path.join(staging, `${i}`);
            await atomicCopy(c.source, temp);
            c.source = temp;
          }
        }
        if (!disabled)
          this.assertDependencies(
            evaluateDependencies(record.dependencies, await this.getPrerequisites()),
            acceptedUnverified,
          );
        await this.transactions.execute(roots, changes, () => ({
          ...this.storage.state,
          installations: this.storage.state.installations.map((r) =>
            r.modId === id ? { ...r, disabled, files: nextFiles } : r,
          ),
        }));
        await this.cleanupEmptyDirectories(record.files);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  }
  async adopt(externalFolder: string, mod?: ModDefinition) {
    return this.transactions.locked(async () => {
      await this.guard();
      SafeName.parse(externalFolder);
      if (mod && this.storage.state.installations.some((r) => r.modId === mod.id))
        throw new UserError('This catalogue entry is already managed.');
      const roots = this.roots(),
        folder = await safeDestination(roots.mods, externalFolder);
      const info = await fs.lstat(folder);
      const metadata = info.isDirectory()
        ? await inspectMetadata(folder)
        : info.isFile() && externalFolder.endsWith('.lua')
          ? parseLuaHeader(await readSmall(folder))
          : undefined;
      if (
        !metadata?.id ||
        (mod &&
          !(
            metadata.id.toLowerCase() ===
            (mod.metadataId ?? mod.id.split(/[@/]/).pop())?.toLowerCase()
          ))
      )
        throw new UserError('The existing mod’s identity does not match this catalogue entry.');
      const files = info.isDirectory() ? await walkFiles(folder) : [externalFolder];
      const ownedPath = (file: string) => (info.isDirectory() ? `${externalFolder}/${file}` : file);
      const owned = await Promise.all(
        files.map(async (f) => ({
          root: 'mods' as const,
          path: ownedPath(f),
          operation: 'created' as const,
          installedHash: await hashFile(await safeDestination(roots.mods, ownedPath(f))),
        })),
      );
      if (
        owned.some((f) =>
          this.storage.state.installations.some((r) =>
            r.files.some(
              (old) => old.root === f.root && old.path.toLowerCase() === f.path.toLowerCase(),
            ),
          ),
        )
      )
        throw new UserError('Some files already belong to another managed mod.');
      const record = RecordSchema.parse({
        modId:
          mod?.id ??
          `local@${createHash('sha256').update(externalFolder).digest('hex').slice(0, 20)}`,
        title: mod?.title ?? metadata.name ?? metadata.id,
        modVersion: metadata.version ?? 'Unknown',
        installedAt: new Date().toISOString(),
        files: owned,
        dependencies: mergeRequirements(mod?.prerequisites ?? [], metadata.requirements),
        provenance: { sourceType: 'external', repositoryUrl: mod?.repositoryUrl },
        adopted: true,
        disabled: false,
        folderName: externalFolder,
        transactionId: randomUUID(),
        metadataId: metadata.id,
      });
      // Adoption records a baseline without changing files. Recheck before taking ownership.
      for (const file of owned)
        if ((await hashFile(await safeDestination(roots.mods, file.path))) !== file.installedHash)
          throw new UserError('The external mod changed during adoption. Refresh and try again.');
      await this.storage.save({
        ...this.storage.state,
        installations: [...this.storage.state.installations, record],
      });
      await this.logger.log('adoption.complete', { modId: record.modId, files: owned.length });
    });
  }
  private async cleanupEmptyDirectories(files: { root: FileRoot; path: string }[]) {
    const problems: string[] = [];
    const roots = this.roots();
    const dirs = new Set(
      files
        .filter((f) => f.path.includes('/'))
        .map((f) => `${f.root}:${path.posix.dirname(f.path)}`),
    );
    for (const key of [...dirs].sort((a, b) => b.length - a.length)) {
      const separator = key.indexOf(':'),
        root = key.slice(0, separator) as FileRoot;
      let relative = key.slice(separator + 1);
      while (relative && relative !== '.') {
        try {
          const directory = await safeDestination(roots[root], relative);
          await fs.rmdir(directory);
        } catch (e) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) {
            problems.push(
              `${root}/${relative}: could not remove the empty directory (${String(e)}).`,
            );
            await this.logger.log('cleanup.directory.failed', {
              directory: relative,
              error: String(e),
            });
          }
          break;
        }
        relative = path.posix.dirname(relative);
      }
    }
    return problems;
  }
}
