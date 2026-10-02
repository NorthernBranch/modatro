import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const macCredentials = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

// Actions expands missing secrets to empty strings. electron-builder treats an
// empty CSC_LINK as a relative certificate filename (the working directory).
export function packagingEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of [
    ...macCredentials,
    'CSC_INSTALLER_LINK',
    'CSC_INSTALLER_KEY_PASSWORD',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
  ])
    if (typeof result[key] === 'string' && !result[key].trim()) delete result[key];
  return result;
}
export async function withPackagingEnvironment(env, mode, work) {
  const clean = packagingEnvironment(env);
  const keys = [
    ...macCredentials,
    'CSC_INSTALLER_LINK',
    'CSC_INSTALLER_KEY_PASSWORD',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'CSC_IDENTITY_AUTO_DISCOVERY',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (clean[key] === undefined) delete process.env[key];
    else process.env[key] = clean[key];
  }
  if (mode) process.env.CSC_IDENTITY_AUTO_DISCOVERY = mode === 'notarized' ? 'true' : 'false';
  try {
    return await work();
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

export function macSigningConfiguration(base, env = process.env) {
  env = packagingEnvironment(env);
  const provided = macCredentials.filter((key) => !!env[key]);
  if (!provided.length)
    return {
      mode: 'ad-hoc',
      config: {
        ...base,
        mac: {
          ...base.mac,
          identity: '-',
          notarize: false,
          hardenedRuntime: true,
          type: 'distribution',
          entitlements: 'build/entitlements.mac.preview.plist',
          entitlementsInherit: 'build/entitlements.mac.preview.plist',
        },
      },
    };
  const missing = macCredentials.filter((key) => !env[key]);
  if (missing.length)
    throw new Error(
      `macOS signing is partially configured. Add: ${missing.join(', ')}. Packaging will not silently fall back to an unverified preview.`,
    );
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID))
    throw new Error('APPLE_TEAM_ID must be a ten-character Apple Developer Team ID.');
  return {
    mode: 'notarized',
    config: {
      ...base,
      forceCodeSigning: true,
      mac: {
        ...base.mac,
        identity: env.APPLE_TEAM_ID,
        type: 'distribution',
        notarize: true,
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
      },
    },
  };
}

export function verifyMacApp(
  app,
  mode,
  teamId,
  run = (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
) {
  const checked = (command, args) => {
    const result = run(command, args);
    if (result.status !== 0)
      throw new Error(
        `macOS distribution verification failed (${command}): ${result.stderr || result.stdout || 'Command could not run.'}`,
      );
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  };
  checked('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const signature = checked('codesign', ['--display', '--verbose=4', app]);
  if (!/^Identifier=community\.modatro\.desktop$/m.test(signature))
    throw new Error('The macOS signature does not identify Modatro.');
  if (!/flags=.*\bruntime\b/.test(signature))
    throw new Error('The macOS app is missing the hardened runtime.');
  if (mode === 'notarized') {
    if (
      !/^Authority=Developer ID Application:/m.test(signature) ||
      !signature.includes(`TeamIdentifier=${teamId}\n`)
    )
      throw new Error(
        'The app was not signed with the configured Developer ID Application certificate.',
      );
    checked('xcrun', ['stapler', 'validate', app]);
    checked('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  } else if (mode !== 'ad-hoc' || !/^Signature=adhoc$/m.test(signature))
    throw new Error('The preview signing mode does not match its signature.');
}

export async function packageDesktop(args = process.argv.slice(2), env = process.env) {
  env = packagingEnvironment(env);
  const targets = args.filter((arg) => ['--mac', '--win', '--linux'].includes(arg));
  const archs = args.filter((arg) => ['--arm64', '--x64'].includes(arg)).map((arg) => arg.slice(2));
  if (
    targets.length !== 1 ||
    !archs.length ||
    args.length !== targets.length + archs.length ||
    new Set(archs).size !== archs.length
  )
    throw new Error('Use one platform (--mac, --win or --linux) and --arm64 and/or --x64.');
  const target = targets[0];
  if (target === '--mac' && process.platform !== 'darwin')
    throw new Error('macOS signing and packaging must run on macOS.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const signing =
    target === '--mac' ? macSigningConfiguration(pkg.build, env) : { config: pkg.build };
  const output = path.resolve(signing.config.directories.output);
  // A failed retry must not leave an earlier successful report available for upload.
  if (target === '--mac')
    for (const arch of archs)
      await rm(path.join(output, `signing-macos-${arch}.json`), { force: true });
  await withPackagingEnvironment(env, signing.mode, async () => {
    const { build, Platform, Arch } = await import('electron-builder');
    const platform =
      target === '--mac' ? Platform.MAC : target === '--win' ? Platform.WINDOWS : Platform.LINUX;
    await build({
      config: signing.config,
      targets: platform.createTarget(undefined, ...archs.map((arch) => Arch[arch])),
      publish: 'never',
    });
  });
  if (target === '--mac')
    for (const arch of archs) {
      const app = path.join(output, arch === 'x64' ? 'mac' : `mac-${arch}`, 'Modatro.app');
      verifyMacApp(app, signing.mode, env.APPLE_TEAM_ID);
      const asset = `Modatro-${pkg.version}-${arch}.dmg`;
      const sha256 = createHash('sha256')
        .update(await readFile(path.join(output, asset)))
        .digest('hex');
      await writeFile(
        path.join(output, `signing-macos-${arch}.json`),
        `${JSON.stringify({ schemaVersion: 1, arch, mode: signing.mode, signatureVerified: true, notarized: signing.mode === 'notarized', asset, sha256 }, null, 2)}\n`,
      );
      console.log(`Verified macOS ${arch}: ${signing.mode}.`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await packageDesktop();
