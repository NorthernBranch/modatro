import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, put, mod } from './helpers';
import { Storage, Logger } from '../electron/services/storage';
import { ProfileService } from '../electron/services/profiles';
import { InstalledModsService } from '../electron/services/local-mods';
import { TransactionEngine } from '../electron/services/transaction';
import { profileSummary } from '../src/shared/profile-selection';
import { StateSchema, type Snapshot, type DependencyRequirement } from '../src/shared/model';
import { ProfilesSchema, ProfileOperationSchema } from '../src/shared/features';
import { OperationHistoryStore } from '../electron/services/history';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
export async function profileFixture(
  checkpoint?: (phase: string, index?: number) => Promise<void>,
) {
  const f = await setup(checkpoint);
  roots.push(f.root);
  const snapshot = async (): Promise<Snapshot> => {
    const scanned = await new InstalledModsService(f.storage, f.logger).scan([]);
    return {
      settings: f.storage.state.settings,
      catalogue: { mods: [], stale: false, refreshing: false, rejected: 0 },
      localMods: scanned.mods,
      prerequisites: [
        ...scanned.prerequisites.filter(
          (entry) => !f.prerequisites.some((p) => p.id.toLowerCase() === entry.id.toLowerCase()),
        ),
        ...f.prerequisites,
      ],
      candidates: [],
      validation: { valid: true, problems: [], warnings: [], detectedVersion: '1.0.1o' },
      appVersion: 'test',
      electronVersion: 'test',
      platform: 'win32',
      arch: 'x64',
      profiles: profileSummary(f.storage.state, scanned.mods.filter((m) => !m.managed).length),
    };
  };
  const profiles = new ProfileService(f.storage, f.installer, snapshot);
  async function install(id: string, requirements: DependencyRequirement[] = []) {
    const stage = path.join(f.root, `stage-${id}`);
    await put(path.join(stage, 'main.lua'), `-- fixture ${id}\nreturn {}`);
    await f.installer.commitPrepared(
      await f.installer.plan(mod({ id, metadataId: id, title: id, prerequisites: [] }), stage),
    );
    await f.storage.save({
      ...f.storage.state,
      installations: f.storage.state.installations.map((r) =>
        r.modId === id ? { ...r, dependencies: requirements } : r,
      ),
    });
  }
  async function duplicate(name: string) {
    await profiles.operation({
      operation: 'duplicate',
      id: f.storage.state.profiles!.activeId,
      name,
    });
    return f.storage.state.profiles!.items.find((profile) => profile.name === name)!.id;
  }
  return { ...f, snapshot, profiles, install, duplicate };
}
it('migrates version two without touching files, saves or provenance and preserves a byte-for-byte backup', async () => {
  const f = await profileFixture();
  await f.install('one');
  await f.installer.toggle('one', true);
  await put(path.join(f.root, 'save.jkr'), 'private save fixture');
  const legacy = { ...f.storage.state, schemaVersion: 2, profiles: undefined };
  const raw = JSON.stringify(legacy);
  await fs.writeFile(f.storage.file('data/state.json'), raw);
  const storage = new Storage(f.storage.root);
  await storage.initialize();
  expect(storage.state.schemaVersion).toBe(3);
  expect(storage.state.installations).toEqual(legacy.installations);
  expect(storage.state.profiles?.items[0]?.selection).toEqual([{ id: 'one', enabled: false }]);
  const backup = (await fs.readdir(storage.file('data'))).find((name) =>
    name.startsWith('state-v2-'),
  )!;
  expect(await fs.readFile(storage.file(`data/${backup}`), 'utf8')).toBe(raw);
  expect(await fs.readFile(path.join(f.root, 'save.jkr'), 'utf8')).toBe('private save fixture');
  const again = new Storage(storage.root);
  await again.initialize();
  expect(again.state).toEqual(storage.state);
});
it('validates persistence and supports create, duplicate, rename and explicit active deletion without uninstalling', async () => {
  const f = await profileFixture();
  await f.install('one');
  const original = f.storage.state.profiles!.activeId;
  await f.profiles.operation({ operation: 'create', name: ' Playing ' });
  const created = f.storage.state.profiles!.activeId;
  expect(f.storage.state.profiles!.items.find((p) => p.id === created)?.name).toBe('Playing');
  await expect(
    f.profiles.operation({ operation: 'duplicate', id: created, name: 'playing' }),
  ).rejects.toThrow('unique');
  await f.profiles.operation({ operation: 'duplicate', id: created, name: 'Copy' });
  const copy = f.storage.state.profiles!.items.find((p) => p.name === 'Copy')!;
  await f.profiles.operation({ operation: 'rename', id: copy.id, name: 'Alternative' });
  await f.profiles.operation({ operation: 'delete', id: original });
  await expect(f.profiles.operation({ operation: 'delete', id: created })).rejects.toThrow(
    'preserving',
  );
  await f.profiles.operation({ operation: 'delete', id: created, preserveCurrent: true });
  expect(f.storage.state.installations).toHaveLength(1);
  expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
  expect(
    ProfilesSchema.safeParse({ ...f.storage.state.profiles, activeId: randomUUID() }).success,
  ).toBe(false);
  expect(ProfileOperationSchema.safeParse({ operation: 'create', name: '\n' }).success).toBe(false);
  expect(StateSchema.safeParse({ ...f.storage.state, profiles: undefined }).success).toBe(false);
});
it('keeps three profiles saved through installs and repeated switches without external duplicates', async () => {
  const f = await profileFixture();
  const ids = [
    f.storage.state.profiles!.activeId,
    await f.duplicate('Second'),
    await f.duplicate('Third'),
  ];
  const mods = ['one', 'two', 'three'];
  for (let index = 0; index < ids.length; index++) {
    const plan = await f.profiles.preview(ids[index]!);
    await f.profiles.switch(plan.profileId, plan.token);
    await f.install(mods[index]!);
    expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
    for (const profile of f.storage.state.profiles!.items)
      expect(profile.selection).toContainEqual({
        id: mods[index],
        enabled: profile.id === ids[index],
      });
  }
  // An older profile may predate explicit disabled entries. Absence must still
  // disable an enabled mod when moving from the first profile to the third.
  await f.storage.save({
    ...f.storage.state,
    profiles: {
      ...f.storage.state.profiles!,
      items: f.storage.state.profiles!.items.map((profile) =>
        profile.id === ids[2]
          ? { ...profile, selection: profile.selection.filter((entry) => entry.id !== 'one') }
          : profile,
      ),
    },
  });
  const first = await f.profiles.preview(ids[0]!);
  await f.profiles.switch(first.profileId, first.token);
  const third = await f.profiles.preview(ids[2]!);
  expect(third.disable).toContain('one');
  await f.profiles.switch(third.profileId, third.token);
  for (let cycle = 0; cycle < 3; cycle++)
    for (let index = 0; index < ids.length; index++) {
      const plan = await f.profiles.preview(ids[index]!);
      expect(plan.blockers).toEqual([]);
      await f.profiles.switch(plan.profileId, plan.token);
      const snapshot = await f.snapshot();
      expect(snapshot.localMods).toHaveLength(3);
      expect(snapshot.localMods.every((mod) => mod.managed && !mod.problems.length)).toBe(true);
      expect(snapshot.localMods.filter((mod) => !mod.disabled).map((mod) => mod.id)).toEqual([
        mods[index],
      ]);
      expect(snapshot.profiles?.unsaved).toBe(false);
      expect(await fs.readdir(f.mods)).toEqual([mods[index]]);
    }
  const loaded = new Storage(f.storage.root);
  await loaded.initialize();
  expect(loaded.state.profiles).toEqual(f.storage.state.profiles);
});
it('commits installation and profile selections together and rolls both back on failure', async () => {
  let failing = false;
  const f = await profileFixture(async (phase) => {
    if (failing && phase === 'before-state') throw new Error('fixture profile-save interruption');
  });
  await f.duplicate('Other');
  await f.install('one');
  const previous = structuredClone(f.storage.state);
  failing = true;
  await expect(f.install('two')).rejects.toThrow('profile-save interruption');
  expect(f.storage.state).toEqual(previous);
  await expect(fs.access(path.join(f.mods, 'two', 'main.lua'))).rejects.toThrow();
  const loaded = new Storage(f.storage.root);
  await loaded.initialize();
  expect(loaded.state).toEqual(previous);
});
it('preserves inactive choices during updates and saves newly adopted mods to every profile', async () => {
  const f = await profileFixture();
  const disabled = await f.duplicate('Disabled');
  await f.install('one');
  const enabled = await f.duplicate('Enabled');
  await f.installer.commitPrepared(
    await f.installer.plan(
      mod({ id: 'one', version: '2.0.0', metadataId: 'one' }),
      path.join(f.root, 'stage-one'),
    ),
  );
  expect(
    f.storage.state.profiles!.items.find((profile) => profile.id === disabled)!.selection,
  ).toContainEqual({ id: 'one', enabled: false });
  expect(
    f.storage.state.profiles!.items.find((profile) => profile.id === enabled)!.selection,
  ).toContainEqual({ id: 'one', enabled: true });
  expect(f.storage.state.installations[0]!.modVersion).toBe('2.0.0');
  await put(
    path.join(f.mods, 'external', 'main.lua'),
    '--- STEAMODDED HEADER\n--- MOD_ID: External\n--- MOD_NAME: External\n--- VERSION: 1.0.0\n',
  );
  await f.installer.adopt('external');
  const adopted = f.storage.state.installations.find((record) => record.adopted)!;
  for (const profile of f.storage.state.profiles!.items)
    expect(profile.selection).toContainEqual({
      id: adopted.modId,
      enabled: profile.id === f.storage.state.profiles!.activeId,
    });
  expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
});
it('allows switching after an uninstalled mod was saved disabled, but blocks a missing enabled mod', async () => {
  const f = await profileFixture();
  const enabled = f.storage.state.profiles!.activeId;
  const disabled = await f.duplicate('Disabled');
  await f.install('one');
  await f.installer.uninstall('one');
  const plan = await f.profiles.preview(disabled);
  expect(plan.blockers).toEqual([]);
  await f.profiles.switch(disabled, plan.token);
  expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
  expect((await f.profiles.preview(enabled)).blockers.join(' ')).toContain('no longer installed');
});
it('saves installs automatically while preserving unsaved toggles and uninstalls, and ignores version-only changes', async () => {
  const f = await profileFixture();
  await f.install('one');
  const id = f.storage.state.profiles!.activeId;
  expect(profileSummary(f.storage.state)?.differences).toEqual([]);
  await f.storage.save({
    ...f.storage.state,
    installations: f.storage.state.installations.map((r) => ({ ...r, modVersion: '2.0.0' })),
  });
  expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
  await f.installer.toggle('one', true);
  expect(profileSummary(f.storage.state)?.unsaved).toBe(true);
  await f.install('two');
  expect(profileSummary(f.storage.state)?.differences).toEqual(['one']);
  expect(f.storage.state.profiles!.items[0]!.selection).toContainEqual({
    id: 'two',
    enabled: true,
  });
  const again = new Storage(f.storage.root);
  await again.initialize();
  expect(profileSummary(again.state)?.unsaved).toBe(true);
  await f.installer.uninstall('one');
  const plan = await f.profiles.preview(id);
  expect(plan.blockers.join(' ')).toContain('no longer installed');
});
it('switches the full selection atomically, disables new mods and never changes unmanaged files', async () => {
  const f = await profileFixture();
  await f.install('one');
  const id = await f.duplicate('One');
  await f.install('two');
  await put(
    path.join(f.mods, 'unmanaged', 'main.lua'),
    '--- STEAMODDED HEADER\n--- MOD_ID: outside\n--- MOD_NAME: Outside\n--- MOD_AUTHOR: [Fixture]',
  );
  const plan = await f.profiles.preview(id);
  expect(plan.disable).toEqual(['two']);
  expect(plan.warnings.join(' ')).toContain('Unmanaged');
  await f.profiles.switch(id, plan.token);
  expect(f.storage.state.installations.find((r) => r.modId === 'two')?.disabled).toBe(true);
  expect(profileSummary(f.storage.state)?.unsaved).toBe(false);
  expect(await fs.readFile(path.join(f.mods, 'unmanaged', 'main.lua'), 'utf8')).toContain(
    'outside',
  );
  expect((await new OperationHistoryStore(f.storage).read()).at(-1)).toMatchObject({
    type: 'profile-switch',
    outcome: 'success',
    profile: 'One',
  });
});
it('retains required dependencies and saves the confirmed effective selection', async () => {
  const f = await profileFixture();
  await f.install('library');
  await f.install('consumer', [
    { id: 'library', displayName: 'Library', required: true, versionConstraint: '>=1.0.0' },
  ]);
  const id = f.storage.state.profiles!.activeId;
  await f.storage.save({
    ...f.storage.state,
    profiles: {
      ...f.storage.state.profiles!,
      items: [{ id, name: 'Consumer only', selection: [{ id: 'consumer', enabled: true }] }],
    },
  });
  const plan = await f.profiles.preview(id);
  expect(plan.retained).toEqual(['library']);
  expect(plan.blockers).toEqual([]);
  await f.profiles.switch(id, plan.token);
  expect(f.storage.state.profiles!.items[0]!.selection).toContainEqual({
    id: 'library',
    enabled: true,
  });
});
it('resolves source-qualified dependencies and blocks ambiguous runtime identities', async () => {
  const f = await profileFixture();
  await f.install('first');
  await f.install('second');
  await f.install('consumer', [
    {
      id: 'Library',
      displayName: 'Library',
      required: true,
      packageId: 'thunderstore/fixture-first',
      versionConstraint: '>=1.0.0',
    },
  ]);
  await f.storage.save({
    ...f.storage.state,
    installations: f.storage.state.installations.map((r) =>
      r.modId === 'first' || r.modId === 'second'
        ? {
            ...r,
            metadataId: 'Library',
            packageVersion: '1.0.0',
            provenance: {
              sourceType: 'registry',
              provider: 'thunderstore',
              namespace: 'Fixture',
              packageName: r.modId,
            },
          }
        : r,
    ),
  });
  const id = f.storage.state.profiles!.activeId;
  await f.storage.save({
    ...f.storage.state,
    profiles: {
      ...f.storage.state.profiles!,
      items: [{ id, name: 'Qualified', selection: [{ id: 'consumer', enabled: true }] }],
    },
  });
  const plan = await f.profiles.preview(id);
  expect(plan.retained).toEqual(['first']);
  expect(plan.disable).toEqual(['second']);
  expect(plan.blockers).toEqual([]);
  await f.storage.save({
    ...f.storage.state,
    installations: f.storage.state.installations.map((r) =>
      r.modId === 'consumer'
        ? { ...r, dependencies: [{ id: 'Library', displayName: 'Library', required: true }] }
        : r,
    ),
  });
  expect((await f.profiles.preview(id)).blockers.join(' ')).toContain('multiple');
});
it('uses observed loader runtimes for qualified requirements without inventing registry versions', async () => {
  const f = await profileFixture();
  await f.install('loader');
  await f.install('consumer', [
    {
      id: 'Steamodded',
      displayName: 'Steamodded',
      required: true,
      packageId: 'thunderstore/steamodded-steamodded',
      versionConstraint: '>=1.1620.0',
    },
  ]);
  await f.storage.save({
    ...f.storage.state,
    installations: f.storage.state.installations.map((r) =>
      r.modId === 'loader'
        ? {
            ...r,
            metadataId: 'Steamodded',
            modVersion: '1.0.0',
            provenance: {
              sourceType: 'registry',
              provider: 'thunderstore',
              namespace: 'Steamodded',
              packageName: 'Steamodded',
            },
          }
        : r,
    ),
  });
  f.prerequisites.push({
    id: 'Steamodded',
    displayName: 'Steamodded',
    installed: true,
    installedVersion: '1.0.0~BETA-1700b',
    sourceUrl: 'https://github.com/Steamodded/smods',
  });
  await f.profiles.operation({ operation: 'create', name: 'Known runtime' });
  expect((await f.profiles.preview(f.storage.state.profiles!.activeId)).blockers).toEqual([]);
});
it('checks unchanged managed files and the game again before the final profile commit', async () => {
  let change = false;
  let external = '';
  const f = await profileFixture(async (phase) => {
    if (change && phase === 'before-state') await fs.writeFile(external, 'external fixture edit');
  });
  await f.install('one');
  const target = await f.duplicate('Keep one');
  await f.install('two');
  await f.profiles.operation({ operation: 'create', name: 'Keep both' });
  const active = f.storage.state.profiles!.activeId;
  external = path.join(f.mods, 'one', 'main.lua');
  const plan = await f.profiles.preview(target);
  change = true;
  await expect(f.profiles.switch(target, plan.token)).rejects.toThrow('changed before');
  expect(f.storage.state.profiles!.activeId).toBe(active);
  expect(await fs.readFile(external, 'utf8')).toBe('external fixture edit');
  expect(await fs.readFile(path.join(f.mods, 'two', 'main.lua'), 'utf8')).toContain('fixture two');
});
it.each(['missing', 'outdated', 'unknown'])(
  'blocks %s dependency evidence without downloading or changing versions',
  async (state) => {
    const f = await profileFixture();
    await f.install('consumer', [
      { id: 'Lovely', displayName: 'Lovely', required: true, versionConstraint: '>=0.10.0' },
    ]);
    if (state !== 'missing')
      f.prerequisites.push({
        id: 'Lovely',
        displayName: 'Lovely',
        installed: true,
        installedVersion: state === 'outdated' ? '0.9.0' : undefined,
        sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
      });
    await f.profiles.operation({ operation: 'create', name: 'Consumer' });
    const plan = await f.profiles.preview(f.storage.state.profiles!.activeId);
    expect(plan.blockers.join(' ')).toMatch(
      state === 'unknown'
        ? /Cannot verify Lovely/
        : state === 'outdated'
          ? /update required/
          : /Lovely is required/,
    );
    await expect(f.profiles.switch(plan.profileId, plan.token)).rejects.toThrow();
    expect(f.storage.state.installations[0]?.modVersion).toBe('1.0.0');
  },
);
it('blocks unsupported game-file disables, unowned additions, external edits and stale tokens', async () => {
  const f = await profileFixture();
  const id = await f.duplicate('Empty');
  await f.install('one');
  await put(path.join(f.mods, 'one', 'external.lua'), 'external');
  expect((await f.profiles.preview(id)).blockers.join(' ')).toContain('not recorded');
  await fs.unlink(path.join(f.mods, 'one', 'external.lua'));
  const plan = await f.profiles.preview(id);
  await f.profiles.operation({ operation: 'rename', id, name: 'Renamed' });
  await expect(f.profiles.switch(id, plan.token)).rejects.toThrow('expired');
  const fresh = await f.profiles.preview(id);
  await fs.writeFile(path.join(f.mods, 'one', 'main.lua'), 'externally edited');
  await expect(f.profiles.switch(id, fresh.token)).rejects.toThrow(/changed|expired/);
  const record = f.storage.state.installations[0]!;
  await f.storage.save({
    ...f.storage.state,
    installations: [
      { ...record, files: record.files.map((file) => ({ ...file, root: 'game' as const })) },
    ],
  });
  expect((await f.profiles.preview(id)).blockers.join(' ')).toContain('cannot safely');
});
it('restores all files and the previous active profile after a failed multi-mod switch', async () => {
  let failing = false;
  const f = await profileFixture(async (phase, index) => {
    if (failing && phase === 'changed' && index === 2) throw new Error('fixture interruption');
  });
  const target = await f.duplicate('Empty');
  await f.install('one');
  await f.install('two');
  await f.profiles.operation({ operation: 'create', name: 'Both' });
  const previous = structuredClone(f.storage.state);
  const plan = await f.profiles.preview(target);
  failing = true;
  await expect(f.profiles.switch(target, plan.token)).rejects.toThrow('fixture interruption');
  expect(f.storage.state).toEqual(previous);
  for (const id of ['one', 'two'])
    expect(await fs.readFile(path.join(f.mods, id, 'main.lua'), 'utf8')).toContain(`fixture ${id}`);
  expect((await new OperationHistoryStore(f.storage).read()).at(-1)?.outcome).toBe('failed');
});
it('recovers interrupted profile files against the old state before migration, and preserves a durable profile commit', async () => {
  const f = await profileFixture();
  await f.install('one');
  const old = { ...f.storage.state, schemaVersion: 2 as const, profiles: undefined },
    id = randomUUID();
  await f.storage.save(old);
  const source = path.join(f.mods, 'one', 'main.lua'),
    backup = `backups/${id}/0.original`;
  await put(f.storage.file(backup), await fs.readFile(source, 'utf8'));
  await fs.unlink(source);
  await f.storage.write(`transactions/${id}.json`, {
    id,
    roots: f.installer.roots(),
    changes: [
      {
        root: 'mods',
        path: 'one/main.lua',
        beforeHash: old.installations[0]!.files[0]!.installedHash,
        beforeBackup: backup,
      },
    ],
    createdDirectories: [],
    previousState: old,
    phase: 'prepared',
  });
  const loaded = new Storage(f.storage.root);
  await loaded.initialize();
  expect(loaded.state.schemaVersion).toBe(2);
  const transactions = new TransactionEngine(loaded, new Logger(loaded, f.root));
  await transactions.recover();
  await loaded.migrateProfiles();
  expect(loaded.state.schemaVersion).toBe(3);
  expect(await fs.readFile(source, 'utf8')).toContain('fixture one');
  const commit = randomUUID();
  await loaded.save({ ...loaded.state, lastTransaction: commit });
  await loaded.write(`transactions/${commit}.json`, {
    id: commit,
    roots: f.installer.roots(),
    changes: [],
    createdDirectories: [],
    previousState: old,
    phase: 'prepared',
  });
  await transactions.recover();
  expect(loaded.safetyError).toBeUndefined();
  expect(loaded.state.profiles).toBeDefined();
});
it('requires the game to be closed before reviewing or committing and rejects concurrent operations', async () => {
  const f = await profileFixture();
  const id = f.storage.state.profiles!.activeId;
  vi.spyOn(f.installer, 'guard').mockRejectedValue(new Error('Balatro is running'));
  await expect(f.profiles.preview(id)).rejects.toThrow('running');
  await f.transactions.inspectLocked(async () => {
    await expect(f.profiles.operation({ operation: 'create', name: 'Busy' })).rejects.toThrow(
      'Another',
    );
  });
});
it('recovers an interrupted profile switch with its previous active identity and preserves uncertain history until recovery', async () => {
  let interrupt = false;
  const f = await profileFixture(async (phase) => {
    if (interrupt && phase === 'changed') throw new Error('fixture process interruption');
  });
  const target = await f.duplicate('Empty');
  await f.install('one');
  await f.profiles.operation({ operation: 'create', name: 'Enabled' });
  const previous = structuredClone(f.storage.state),
    plan = await f.profiles.preview(target);
  const rollback = vi
    .spyOn(f.transactions, 'rollback')
    .mockRejectedValue(new Error('fixture terminated before rollback'));
  interrupt = true;
  await expect(f.profiles.switch(target, plan.token)).rejects.toThrow('locked');
  rollback.mockRestore();
  expect((await new OperationHistoryStore(f.storage).read()).at(-1)?.outcome).toBe('uncertain');
  const loaded = new Storage(f.storage.root);
  await loaded.initialize();
  await new TransactionEngine(loaded, new Logger(loaded, f.root)).recover();
  expect(loaded.state).toEqual(previous);
  expect(loaded.safetyError).toBeUndefined();
  expect(await fs.readFile(path.join(f.mods, 'one', 'main.lua'), 'utf8')).toContain('fixture one');
  expect((await new OperationHistoryStore(loaded).read()).at(-1)?.outcome).toBe('failed');
});
