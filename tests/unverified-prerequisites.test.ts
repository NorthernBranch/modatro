import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadService } from '../electron/services/network';
import { UserError } from '../electron/services/errors';
import { evaluateDependencies } from '../src/shared/dependencies';
import { mod, setup, zip } from './helpers';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(ids = ['Lovely', 'Steamodded']) {
  const f = await setup();
  roots.push(f.root);
  f.prerequisites.push(
    ...ids.map((id) => ({
      id,
      displayName: id,
      installed: true,
      sourceUrl: 'https://github.com/tests/mod',
    })),
  );
  const requirements = ids.map((id) => ({
    id,
    displayName: id,
    required: true,
    versionConstraint: '>=1.0.0',
  }));
  const accepted = requirements.map(({ id, versionConstraint }) => ({ id, versionConstraint }));
  const archive = path.join(f.root, 'download.zip');
  const download = vi.spyOn(DownloadService.prototype, 'download').mockImplementation(async () => {
    await fs.writeFile(archive, zip([{ name: 'Mod/main.lua', data: 'return true' }]));
    return archive;
  });
  return {
    ...f,
    requirements,
    accepted,
    archive,
    download,
    definition: mod({ prerequisites: requirements }),
  };
}

describe('unverified Lovely and Steamodded consent', () => {
  it('asks before downloading, preserves unknown status, and requires fresh consent when enabling or updating', async () => {
    const f = await fixture();
    await expect(f.installer.install(f.definition)).rejects.toMatchObject({
      context: {
        unverifiedPrerequisites: [
          { id: 'Lovely', state: 'unknown' },
          { id: 'Steamodded', state: 'unknown' },
        ],
      },
    });
    expect(f.download).not.toHaveBeenCalled();
    expect(await fs.readdir(f.mods)).toEqual([]);
    await f.installer.install(f.definition, false, undefined, false, f.accepted);
    expect(f.storage.state.installations[0]?.dependencies).toHaveLength(2);
    expect(
      evaluateDependencies(f.storage.state.installations[0]!.dependencies, f.prerequisites).map(
        (requirement) => requirement.state,
      ),
    ).toEqual(['unknown', 'unknown']);
    await f.installer.toggle('test-mod', true);
    await expect(f.installer.toggle('test-mod', false)).rejects.toMatchObject({
      context: { unverifiedPrerequisites: [{ id: 'Lovely' }, { id: 'Steamodded' }] },
    });
    expect(f.storage.state.installations[0]?.disabled).toBe(true);
    await f.installer.toggle('test-mod', false, f.accepted);
    expect(f.storage.state.installations[0]?.disabled).toBe(false);
    await expect(
      f.installer.install(mod({ ...f.definition, version: '2.0.0' }), true),
    ).rejects.toMatchObject({
      context: { unverifiedPrerequisites: [{ id: 'Lovely' }, { id: 'Steamodded' }] },
    });
  });

  it.each(['missing', 'outdated', 'incompatible', 'other dependency'])(
    'cannot override %s prerequisites',
    async (state) => {
      const f = await fixture(state === 'other dependency' ? ['Talisman'] : ['Steamodded']);
      if (state === 'missing') f.prerequisites[0]!.installed = false;
      if (state === 'outdated') f.prerequisites[0]!.installedVersion = '0.5.0';
      if (state === 'incompatible') {
        f.prerequisites[0]!.installedVersion = '2.0.0';
        f.definition.prerequisites[0]!.versionConstraint = '<2.0.0';
      }
      const error = await f.installer
        .install(f.definition, false, undefined, false, f.accepted)
        .catch((error) => error);
      expect(error).toBeInstanceOf(UserError);
      expect(error.context?.unverifiedPrerequisites).toBeUndefined();
      expect(f.download).not.toHaveBeenCalled();
      expect(await fs.readdir(f.mods)).toEqual([]);
    },
  );

  it('does not offer an override when an unknown loader accompanies a missing dependency', async () => {
    const f = await fixture(['Lovely']);
    f.definition.prerequisites.push({ id: 'Talisman', displayName: 'Talisman', required: true });
    await expect(f.installer.install(f.definition)).rejects.toMatchObject({
      context: {
        requirements: [{ state: 'unknown' }, { state: 'missing' }],
        unverifiedPrerequisites: undefined,
      },
    });
    expect(f.download).not.toHaveBeenCalled();
  });

  it('asks for archive requirements separately and rejects consent for a different constraint', async () => {
    const f = await fixture(['Steamodded']);
    f.download.mockImplementation(async () => {
      await fs.writeFile(
        f.archive,
        zip([
          { name: 'Mod/main.lua', data: 'return true' },
          {
            name: 'Mod/mod.json',
            data: JSON.stringify({ id: 'Demo', dependencies: ['Steamodded (>=2.0.0)'] }),
          },
        ]),
      );
      return f.archive;
    });
    const error = await f.installer
      .install(f.definition, false, undefined, false, f.accepted)
      .catch((error) => error);
    expect(error.context?.unverifiedPrerequisites).toMatchObject([
      { id: 'Steamodded', versionConstraint: '>=2.0.0' },
    ]);
    expect(await fs.readdir(f.mods)).toEqual([]);
    await f.installer.install(f.definition, false, undefined, false, [
      ...f.accepted,
      { id: 'Steamodded', versionConstraint: '>=2.0.0' },
    ]);
    expect(f.storage.state.installations).toHaveLength(1);
  });

  it('rechecks known versions after downloading even after explicit consent', async () => {
    const f = await fixture(['Lovely']);
    const download = f.download.getMockImplementation()!;
    f.download.mockImplementation(async (...args) => {
      const archive = await download(...args);
      f.prerequisites[0]!.installedVersion = '0.5.0';
      return archive;
    });
    await expect(
      f.installer.install(f.definition, false, undefined, false, f.accepted),
    ).rejects.toMatchObject({
      context: { requirements: [{ state: 'outdated' }], unverifiedPrerequisites: undefined },
    });
    expect(await fs.readdir(f.mods)).toEqual([]);
  });

  it('requires renewed consent if the observed unknown version changes', async () => {
    const f = await fixture(['Steamodded']);
    f.prerequisites[0]!.installedVersion = '1.0.0~BETA';
    await expect(
      f.installer.install(f.definition, false, undefined, false, f.accepted),
    ).rejects.toMatchObject({
      context: { unverifiedPrerequisites: [{ installedVersion: '1.0.0~BETA' }] },
    });
    expect(f.download).not.toHaveBeenCalled();
    await f.installer.install(f.definition, false, undefined, false, [
      { ...f.accepted[0]!, installedVersion: '1.0.0~BETA' },
    ]);
    expect(f.storage.state.installations).toHaveLength(1);
  });

  it('requires game-file confirmation as well as prerequisite consent', async () => {
    const f = await fixture(['Lovely']);
    const definition = mod({
      ...f.definition,
      installation: {
        type: 'game-replacement',
        files: [{ source: 'Mod/main.lua', destination: 'foo.lua' }],
      },
    });
    const error = await f.installer
      .install(definition, false, undefined, false, f.accepted)
      .catch((error) => error);
    expect(error.context?.confirmation?.plan.create).toMatchObject([
      { root: 'game', path: 'foo.lua' },
    ]);
    expect(f.storage.state.installations).toHaveLength(0);
    await f.installer.install(
      definition,
      false,
      error.context.confirmation.token,
      false,
      f.accepted,
    );
    expect(await fs.readFile(path.join(f.game, 'foo.lua'), 'utf8')).toBe('return true');
  });
});
