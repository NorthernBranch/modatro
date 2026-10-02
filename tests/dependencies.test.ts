import { describe, expect, it } from 'vitest';
import { mergeRequirements, parseLuaHeader, parseRequirement } from '../electron/services/metadata';
import { cleanVersion, evaluateDependency, hasUpdate } from '../electron/services/versions';
import { thunderstoreDependency } from '../src/shared/thunderstore';
const requirement = { id: 'Steamodded', displayName: 'Steamodded', required: true };
const installed = [
  {
    id: 'Steamodded',
    displayName: 'Steamodded',
    installed: true,
    installedVersion: '26.829.0',
    sourceUrl: 'https://github.com/Steamodded/smods',
  },
];
describe('dependency eligibility', () => {
  it('reports missing Steamodded and Lovely', () => {
    expect(evaluateDependency(requirement, []).state).toBe('missing');
    expect(
      evaluateDependency({ ...requirement, id: 'Lovely', displayName: 'Lovely' }, []).state,
    ).toBe('missing');
  });
  it('requires an update for an explicit higher minimum', () => {
    expect(
      evaluateDependency({ ...requirement, versionConstraint: '>=26.900.0' }, installed).state,
    ).toBe('outdated');
  });
  it('never invents a requirement for boolean index flags', () => {
    const result = evaluateDependency(requirement, installed);
    expect(result.state).toBe('satisfied');
    expect(result.versionConstraint).toBeUndefined();
    expect(result.reason).toContain('not specified');
  });
  it('accepts installed prerequisites with unknown versions when no constraint exists', () => {
    expect(
      evaluateDependency(requirement, [{ ...installed[0]!, installedVersion: undefined }]).state,
    ).toBe('satisfied');
  });
  it('fails closed if a constrained version is unknown', () => {
    expect(
      evaluateDependency({ ...requirement, versionConstraint: '>=1.0.0' }, [
        { ...installed[0]!, installedVersion: undefined },
      ]).state,
    ).toBe('unknown');
  });
  it('handles non-semver and invalid constraints without guessing', () => {
    expect(
      evaluateDependency({ ...requirement, versionConstraint: '>=dev-branch' }, installed).state,
    ).toBe('unknown');
    expect(cleanVersion('main')).toBeUndefined();
    expect(hasUpdate('dev-abc', 'dev-def')).toBe(false);
  });
  it('compares versions semantically rather than lexicographically', () => {
    expect(hasUpdate('1.9.0', '1.10.0')).toBe(true);
    expect(hasUpdate('2.0.0', '1.99.0')).toBe(false);
    expect(hasUpdate('v1.0.0', '1.0.1')).toBe(true);
  });
  it('marks incompatible upper bounds correctly', () => {
    expect(
      evaluateDependency({ ...requirement, versionConstraint: '<20.0.0' }, installed).state,
    ).toBe('incompatible');
  });
  it('parses structured Steamodded headers and Thunderstore manifests', () => {
    expect(parseRequirement('Thunderstore-lovely-0.9.0')).toMatchObject({
      id: 'Lovely',
      versionConstraint: '>=0.9.0',
    });
    const m = parseLuaHeader(
      '--- STEAMODDED HEADER\n--- MOD_ID: Demo\n--- MOD_NAME: Demo\n--- VERSION: 1.0.0\n--- DEPENDENCIES: [Steamodded (>=1.0.0), Talisman]\n--- CONFLICTS: [Other (>=2.0.0)]',
    );
    expect(m?.requirements).toHaveLength(2);
    expect(m?.requirements[1]?.versionConstraint).toBeUndefined();
    expect(m?.conflicts[0]?.id).toBe('Other');
  });
  it('retains every explicit constraint when combining sources', () => {
    expect(
      mergeRequirements([requirement], [{ ...requirement, versionConstraint: '>=26.900.0' }]),
    ).toHaveLength(2);
  });
});

it('supports structured equality and combined bounds without losing constraints', () => {
  expect(parseRequirement('SomeMod (==1.0.*)')).toMatchObject({ versionConstraint: '=1.0.*' });
  expect(parseRequirement('Steamodded (>=26.800.0) (<<27.0.0)')).toMatchObject({
    versionConstraint: '>=26.800.0 <27.0.0',
  });
  const parsed = parseRequirement('Steamodded>=26.800.0<27.0.0');
  expect(evaluateDependency(parsed, installed).state).toBe('satisfied');
  expect(evaluateDependency(parsed, [{ ...installed[0]!, installedVersion: '27.0.0' }]).state).toBe(
    'incompatible',
  );
  expect(evaluateDependency(parseRequirement('Steamodded (>=1.0.0~BETA)'), installed).state).toBe(
    'unknown',
  );
});

it('requires Steamodded for a positive legacy loader header even when no dependencies are listed', () => {
  expect(parseLuaHeader('--- STEAMODDED HEADER\n--- MOD_ID: Example')?.requirements).toContainEqual(
    { id: 'Steamodded', displayName: 'Steamodded', required: true },
  );
  expect(parseLuaHeader('print("--- STEAMODDED HEADER")')).toBeUndefined();
});

it('checks canonical Steamodded registry requirements against a detected runtime version', () => {
  const requested = thunderstoreDependency('Steamodded-Steamodded-1.1620.0');
  for (const version of ['26.829.0', '26.927.0~dev-a', '1.0.0~BETA-1620a', '1.0.0~BETA-1814a']) {
    const runtime = [{ ...installed[0]!, installedVersion: version }];
    expect(evaluateDependency(requested, runtime)).toMatchObject({
      state: 'satisfied',
      installedVersion: version,
    });
    expect(runtime[0]).not.toHaveProperty('packageVersion');
  }
  expect(
    evaluateDependency(requested, [{ ...installed[0]!, installedVersion: '1.0.0~BETA-1619a' }])
      .state,
  ).toBe('outdated');
  expect(
    evaluateDependency(requested, [{ ...installed[0]!, installedVersion: undefined }]).state,
  ).toBe('unknown');
  expect(
    evaluateDependency(thunderstoreDependency('Impostor-Steamodded-1.1620.0'), installed).state,
  ).toBe('missing');
  expect(
    evaluateDependency(thunderstoreDependency('AnotherTeam-Steamodded-1.1620.0'), [
      { ...installed[0]!, packageId: 'thunderstore/AnotherTeam-Steamodded' },
    ]).state,
  ).toBe('unknown');
});

it('compares Steamodded beta requirements from manual archives using their build numbers', () => {
  const requested = parseRequirement('Steamodded (>=1.0.0~BETA-1620a)');
  for (const [version, state] of [
    ['1.0.0~BETA-1619a', 'outdated'],
    ['1.0.0~BETA-1620a', 'satisfied'],
    ['1.0.0~BETA-1814a', 'satisfied'],
    ['26.829.0', 'satisfied'],
  ]) {
    expect(
      evaluateDependency(requested, [{ ...installed[0]!, installedVersion: version }]).state,
    ).toBe(state);
  }
});

it('compares Balatro letter releases without accepting an older patch or inventing a version', () => {
  const requested = parseRequirement('Balatro (>=1.0.1o)');
  for (const [version, state] of [
    ['1.0.1n', 'outdated'],
    ['1.0.1o', 'satisfied'],
    ['1.0.1p', 'satisfied'],
    ['1.0.2', 'satisfied'],
    ['unknown', 'unknown'],
  ])
    expect(
      evaluateDependency(requested, [
        {
          id: 'Balatro',
          displayName: 'Balatro',
          installed: true,
          installedVersion: version,
          sourceUrl: 'https://www.playbalatro.com',
        },
      ]).state,
    ).toBe(state);
});
