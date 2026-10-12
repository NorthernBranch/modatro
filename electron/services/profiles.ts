import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  ProfileOperationSchema,
  ProfilePlanSchema,
  ProfilesSchema,
  type ProfilePlan,
  type ProfileOperation,
  type Selection,
} from '../../src/shared/features';
import { selection } from '../../src/shared/profile-selection';
import { evaluateDependency, externalLoaderRequirement } from '../../src/shared/dependencies';
import type { InstallationRecord, Prerequisite, Snapshot } from '../../src/shared/model';
import { thunderstoreId } from '../../src/shared/thunderstore';
import { dependencyId } from './metadata';
import { atomicCopy, fileBatches, hashFile, safeDestination } from './files';
import { ModInstaller } from './installer';
import { Storage } from './storage';
import { UserError } from './errors';
import type { Change } from './transaction';

export function recordPrerequisite(record: InstallationRecord): Prerequisite {
  return {
    id: dependencyId(record.metadataId ?? record.modId),
    displayName: record.title,
    installed: true,
    installedVersion:
      record.provenance?.provider === 'thunderstore' ? undefined : record.modVersion,
    packageId:
      record.provenance?.namespace && record.provenance.packageName
        ? thunderstoreId(record.provenance.namespace, record.provenance.packageName)
        : record.modId.startsWith('thunderstore/')
          ? record.modId
          : undefined,
    packageVersion: record.packageVersion,
    provenance: record.provenance,
    dependencies: record.dependencies,
    sourceUrl: record.source ?? 'https://github.com/NorthernBranch/modatro',
  };
}
// Use the installer's version evaluator, never catalogue titles or latest versions.
export function enabledPrerequisites(
  records: InstallationRecord[],
  desired: Selection,
  observed: Prerequisite[],
): Prerequisite[] {
  const identities = records.map(recordPrerequisite);
  const enabled = records
    .filter((r) => desired.some((e) => e.id === r.modId && e.enabled))
    .map((record) => {
      const p = recordPrerequisite(record);
      const actual =
        observed.find((entry) =>
          p.packageId
            ? entry.packageId?.toLowerCase() === p.packageId.toLowerCase()
            : entry.id.toLowerCase() === p.id.toLowerCase(),
        ) ??
        observed.find(
          (entry) =>
            !entry.packageId &&
            entry.id.toLowerCase() === p.id.toLowerCase() &&
            externalLoaderRequirement({ id: p.id, packageId: p.packageId }),
        );
      return {
        ...p,
        installedVersion: !record.disabled
          ? (actual?.installedVersion ?? p.installedVersion)
          : p.installedVersion,
      };
    });
  return [
    ...observed.filter(
      (p) =>
        !identities.some((r) =>
          p.packageId
            ? r.packageId?.toLowerCase() === p.packageId.toLowerCase()
            : r.id.toLowerCase() === p.id.toLowerCase(),
        ),
    ),
    ...enabled,
  ];
}
export class ProfileService {
  private confirmations = new Map<string, { fingerprint: string; expires: number }>();
  constructor(
    private storage: Storage,
    private installer: ModInstaller,
    private snapshot: () => Promise<Snapshot>,
  ) {}
  async operation(input: ProfileOperation) {
    const request = ProfileOperationSchema.parse(input);
    return this.installer.transactions.locked(async () => {
      const current = this.storage.state.profiles;
      if (!current) throw new UserError('Profile state is unavailable. Open Troubleshooting.');
      let next = structuredClone(current);
      const item = 'id' in request ? next.items.find((p) => p.id === request.id) : undefined;
      if ('id' in request && !item) throw new UserError('This profile no longer exists.');
      if (request.operation === 'create') {
        const id = randomUUID();
        next.items.push({
          id,
          name: request.name,
          selection: selection(this.storage.state.installations),
        });
        next.activeId = id;
      } else if (request.operation === 'duplicate')
        next.items.push({ ...structuredClone(item!), id: randomUUID(), name: request.name });
      else if (request.operation === 'rename') item!.name = request.name;
      else if (request.operation === 'save') {
        if (request.id !== next.activeId)
          throw new UserError('Only the active profile can save the current selection.');
        item!.selection = selection(this.storage.state.installations);
      } else {
        if (request.id === next.activeId) {
          if (!request.preserveCurrent)
            throw new UserError(
              'Confirm preserving the current selection as a new Default profile before deleting the active profile.',
            );
          const id = randomUUID();
          let name = 'Default',
            n = 2;
          while (
            next.items.some(
              (p) =>
                p.id !== request.id &&
                p.name.normalize('NFKC').toLowerCase() === name.toLowerCase(),
            )
          )
            name = `Default ${n++}`;
          next.items.push({ id, name, selection: selection(this.storage.state.installations) });
          next.activeId = id;
        }
        next.items = next.items.filter((p) => p.id !== request.id);
      }
      const checked = ProfilesSchema.safeParse(next);
      if (!checked.success)
        throw new UserError(
          'Use a unique profile name (up to 60 characters), with at most 100 profiles.',
        );
      next = checked.data;
      await this.storage.save({ ...this.storage.state, profiles: next });
      this.confirmations.clear();
    });
  }
  async readPlan(id: string, snapshot: Snapshot) {
    return this.build(id, false, snapshot);
  }
  private async build(
    id: string,
    guard = true,
    supplied?: Snapshot,
    prepared?: Map<string, Awaited<ReturnType<ModInstaller['planToggle']>>>,
  ): Promise<Omit<ProfilePlan, 'token' | 'expiresAt'>> {
    if (guard) await this.installer.guard();
    const snapshot = supplied ?? (await this.snapshot());
    const profile = this.storage.state.profiles?.items.find((p) => p.id === id);
    if (!profile) throw new UserError('This profile no longer exists.');
    const records = this.storage.state.installations;
    const blockers: string[] = [],
      warnings: string[] = [],
      retained: string[] = [];
    const desired = records.map((r) => ({
      id: r.modId,
      enabled: profile.selection.find((p) => p.id === r.modId)?.enabled ?? false,
    }));
    for (const entry of profile.selection)
      if (entry.enabled && !records.some((r) => r.modId === entry.id))
        blockers.push(
          `${entry.id} is no longer installed. Install it through Discover or save an updated selection; switching will not download it.`,
        );
    for (const local of snapshot.localMods.filter((m) => m.managed))
      for (const problem of local.problems) blockers.push(`${local.title}: ${problem}`);
    if (snapshot.localMods.some((m) => !m.managed))
      warnings.push(
        'Unmanaged mods remain untouched and may still load. They can affect gameplay; use Installed to review or adopt them.',
      );
    // Native injectors are shared prerequisites; profiles cannot move game files.
    for (const record of records)
      if (
        !record.disabled &&
        dependencyId(record.metadataId ?? '') === 'Lovely' &&
        !desired.find((e) => e.id === record.modId)!.enabled
      ) {
        desired.find((e) => e.id === record.modId)!.enabled = true;
        retained.push(record.modId);
        warnings.push(`${record.title} is a shared game prerequisite and will remain installed.`);
      }
    let changed = true;
    while (changed) {
      changed = false;
      const future = enabledPrerequisites(records, desired, snapshot.prerequisites);
      for (const record of records.filter((r) => desired.find((e) => e.id === r.modId)!.enabled))
        for (const requirement of record.dependencies.filter((d) => d.required)) {
          const status = evaluateDependency(requirement, future);
          if (status.state === 'satisfied') continue;
          const candidates = records.filter((r) => {
            const p = recordPrerequisite(r);
            return requirement.packageId
              ? p.packageId?.toLowerCase() === requirement.packageId.toLowerCase()
              : p.id.toLowerCase() === requirement.id.toLowerCase();
          });
          if (
            status.state === 'missing' &&
            candidates.length === 1 &&
            !desired.find((e) => e.id === candidates[0]!.modId)!.enabled
          ) {
            desired.find((e) => e.id === candidates[0]!.modId)!.enabled = true;
            retained.push(candidates[0]!.modId);
            changed = true;
          }
        }
    }
    const future = enabledPrerequisites(records, desired, snapshot.prerequisites);
    for (const record of records.filter((r) => desired.find((e) => e.id === r.modId)!.enabled))
      for (const requirement of record.dependencies.filter((d) => d.required)) {
        const matches = records.filter((r) => {
          const p = recordPrerequisite(r);
          return requirement.packageId
            ? p.packageId?.toLowerCase() === requirement.packageId.toLowerCase()
            : p.id.toLowerCase() === requirement.id.toLowerCase();
        });
        const localMatches = snapshot.localMods.filter(
          (m) =>
            m.metadataId &&
            dependencyId(m.metadataId).toLowerCase() === requirement.id.toLowerCase(),
        );
        if (matches.length > 1 || (!requirement.packageId && localMatches.length > 1)) {
          blockers.push(
            `${record.title}: ${requirement.displayName} has multiple installed identities or copies. Resolve the ambiguity in Installed.`,
          );
          continue;
        }
        const status = evaluateDependency(requirement, future);
        if (status.state !== 'satisfied')
          blockers.push(
            `${record.title}: ${status.reason} Review Prerequisites or install the dependency through Discover. No versions will be changed by this switch.`,
          );
      }
    const enable: string[] = [],
      disable: string[] = [];
    for (const record of records)
      if (desired.find((e) => e.id === record.modId)!.enabled === record.disabled) {
        (record.disabled ? enable : disable).push(record.modId);
        try {
          const toggle = await this.installer.planToggle(record, !record.disabled);
          prepared?.set(record.modId, toggle);
        } catch (e) {
          blockers.push(`${record.title}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    return {
      profileId: id,
      name: profile.name,
      selection: desired,
      enable,
      disable,
      retained: [...new Set(retained)],
      blockers: [...new Set(blockers)],
      warnings,
    };
  }
  private fingerprint(plan: unknown) {
    return createHash('sha256')
      .update(JSON.stringify({ state: this.storage.state, plan }))
      .digest('hex');
  }
  async preview(id: string): Promise<ProfilePlan> {
    return this.installer.transactions.locked(async () => {
      const plan = await this.build(id),
        token = randomUUID(),
        expires = Date.now() + 5 * 60 * 1000;
      this.confirmations.clear();
      this.confirmations.set(token, { fingerprint: this.fingerprint(plan), expires });
      return ProfilePlanSchema.parse({
        ...plan,
        token,
        expiresAt: new Date(expires).toISOString(),
      });
    });
  }
  async switch(id: string, token: string) {
    return this.installer.transactions.locked(async () => {
      const confirmation = this.confirmations.get(token);
      this.confirmations.delete(token);
      const prepared = new Map<string, Awaited<ReturnType<ModInstaller['planToggle']>>>();
      const plan = await this.build(id, true, undefined, prepared);
      if (
        !confirmation ||
        confirmation.expires < Date.now() ||
        confirmation.fingerprint !== this.fingerprint(plan)
      )
        throw new UserError(
          'The profile preview has changed or expired. Review a fresh preview before switching.',
        );
      if (plan.blockers.length) throw new UserError(plan.blockers.join('\n'));
      const changes: Change[] = [],
        nextRecords = [...this.storage.state.installations];
      const moved = this.storage.state.installations.filter(
        (r) => plan.enable.includes(r.modId) || plan.disable.includes(r.modId),
      );
      for (const record of moved) {
        const disabled = plan.disable.includes(record.modId),
          toggle = prepared.get(record.modId)!;
        changes.push(...toggle.changes);
        nextRecords[nextRecords.indexOf(record)] = {
          ...record,
          disabled,
          files: toggle.nextFiles,
        };
      }
      const staging = await fs.mkdtemp(this.storage.file('staging/profile-'));
      try {
        await fileBatches([...changes.entries()], async ([i, change]) => {
          if (change.source) {
            const file = path.join(staging, `${i}`);
            await atomicCopy(change.source, file);
            change.source = file;
          }
        });
        // Recheck process, integrity and dependencies after staging and before mutation.
        const rechecked = await this.build(id);
        if (confirmation.fingerprint !== this.fingerprint(rechecked))
          throw new UserError('The profile preview changed while staging. Review a fresh preview.');
        await this.installer.transactions.execute(
          this.installer.roots(),
          changes,
          () => ({
            ...this.storage.state,
            installations: nextRecords,
            profiles: {
              ...this.storage.state.profiles!,
              activeId: id,
              items: this.storage.state.profiles!.items.map((p) =>
                p.id === id ? { ...p, selection: plan.selection } : p,
              ),
            },
          }),
          'profile-switch',
          async () => {
            await this.installer.guard();
            const roots = this.installer.roots();
            await fileBatches(
              nextRecords.flatMap((record) => record.files),
              async (file) => {
                if (
                  (await hashFile(await safeDestination(roots[file.root], file.path))) !==
                  file.installedHash
                )
                  throw new UserError(
                    'A managed file changed before the profile could commit. Recovery will preserve unverified external edits.',
                  );
              },
            );
          },
        );
        // Use the same conservative cleanup as individual toggles. Only empty
        // source directories are removed, after the durable transaction commit.
        await this.installer.cleanupEmptyDirectories(moved.flatMap((record) => record.files));
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  }
}
