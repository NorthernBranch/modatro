import { expect, it, vi } from 'vitest';
import {
  macSigningConfiguration,
  packagingEnvironment,
  withPackagingEnvironment,
  verifyMacApp,
} from '../scripts/package-desktop.mjs';

const credentials = {
  CSC_LINK: 'test-certificate',
  CSC_KEY_PASSWORD: 'test-password',
  APPLE_ID: 'test@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'test-notary-password',
  APPLE_TEAM_ID: 'ABCDEFGHIJ',
};
it('removes empty Actions secrets before electron-builder imports certificates', () => {
  const env = {
    ...Object.fromEntries(Object.keys(credentials).map((key) => [key, ''])),
    CSC_INSTALLER_LINK: '   ',
    OTHER: 'retained',
  };
  expect(packagingEnvironment(env)).toEqual({ OTHER: 'retained' });
  expect(env.CSC_LINK).toBe('');
  expect(macSigningConfiguration({ mac: {} }, env).mode).toBe('ad-hoc');
  expect(packagingEnvironment(credentials)).toEqual(credentials);
});
it('unsets blank credentials in the builder process and restores its environment after failure', async () => {
  vi.stubEnv('CSC_LINK', 'before-test');
  try {
    await expect(
      withPackagingEnvironment({ CSC_LINK: '', CSC_KEY_PASSWORD: ' ' }, 'ad-hoc', async () => {
        expect(process.env.CSC_LINK).toBeUndefined();
        expect(process.env.CSC_KEY_PASSWORD).toBeUndefined();
        expect(process.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
        throw new Error('Build failed');
      }),
    ).rejects.toThrow('Build failed');
    expect(process.env.CSC_LINK).toBe('before-test');
  } finally {
    vi.unstubAllEnvs();
  }
});
const signature =
  'Identifier=community.modatro.desktop\nflags=0x10002(adhoc,runtime)\nSignature=adhoc\nTeamIdentifier=not set\n';
const notarizedSignature =
  'Identifier=community.modatro.desktop\nflags=0x10000(runtime)\nAuthority=Developer ID Application: Example (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\n';
const successfulRun = (details) =>
  vi.fn((command, args) => ({
    status: 0,
    stdout: '',
    stderr: command === 'codesign' && args[0] === '--display' ? details : '',
  }));

it('selects complete preview signing with no credentials and keeps hardened runtime', () => {
  expect(macSigningConfiguration({ mac: {} }, {})).toMatchObject({
    mode: 'ad-hoc',
    config: { mac: { identity: '-', notarize: false, hardenedRuntime: true } },
  });
});
it('requires Developer ID signing and notarization together when credentials are configured', () => {
  expect(macSigningConfiguration({ mac: { identity: '-' } }, credentials)).toMatchObject({
    mode: 'notarized',
    config: {
      forceCodeSigning: true,
      mac: {
        identity: 'ABCDEFGHIJ',
        type: 'distribution',
        notarize: true,
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
      },
    },
  });
});
it.each(Object.keys(credentials))(
  'rejects partial signing configuration without falling back: %s',
  (missing) => {
    const incomplete = { ...credentials };
    delete incomplete[missing];
    expect(() => macSigningConfiguration({ mac: {} }, incomplete)).toThrow(missing);
  },
);
it('rejects the invalid inherited Electron signature that caused damaged-app warnings', () => {
  const run = vi.fn(() => ({
    status: 1,
    stderr: 'code has no resources but signature indicates they must be present',
  }));
  expect(() => verifyMacApp('/test/Modatro.app', 'ad-hoc', undefined, run)).toThrow(
    'signature indicates',
  );
  expect(run).toHaveBeenCalledTimes(1);
});
it('checks the full preview signature without claiming Apple verification', () => {
  const run = successfulRun(signature);
  verifyMacApp('/test/Modatro.app', 'ad-hoc', undefined, run);
  expect(run.mock.calls.map(([command]) => command)).toEqual(['codesign', 'codesign']);
  expect(run.mock.calls[0][1]).toContain('--deep');
});
it('rejects a valid signature for a different application identifier', () => {
  expect(() =>
    verifyMacApp(
      '/test/Modatro.app',
      'ad-hoc',
      undefined,
      successfulRun(
        signature.replace('community.modatro.desktop', 'community.modatro.desktop.other'),
      ),
    ),
  ).toThrow('does not identify Modatro');
});
it('requires a stapled ticket and Gatekeeper acceptance for Apple-verified builds', () => {
  const run = successfulRun(notarizedSignature);
  verifyMacApp('/test/Modatro.app', 'notarized', 'ABCDEFGHIJ', run);
  expect(run.mock.calls.map(([command]) => command)).toEqual([
    'codesign',
    'codesign',
    'xcrun',
    'spctl',
  ]);
});
it('cannot mistake an ad-hoc signature for a Developer ID signature', () => {
  expect(() =>
    verifyMacApp('/test/Modatro.app', 'notarized', 'ABCDEFGHIJ', successfulRun(signature)),
  ).toThrow('Developer ID');
});
it('rejects a missing notarization ticket even when the publisher signature is valid', () => {
  const run = successfulRun(notarizedSignature);
  run.mockImplementation((command, args) => ({
    status: command === 'xcrun' ? 65 : 0,
    stdout: '',
    stderr:
      command === 'codesign' && args[0] === '--display' ? notarizedSignature : 'Ticket missing',
  }));
  expect(() => verifyMacApp('/test/Modatro.app', 'notarized', 'ABCDEFGHIJ', run)).toThrow(
    'Ticket missing',
  );
  expect(run.mock.calls.some(([command]) => command === 'spctl')).toBe(false);
});
