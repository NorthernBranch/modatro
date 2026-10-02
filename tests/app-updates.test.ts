import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AppUpdates,
  APP_RELEASES_ENDPOINT,
  newestAppRelease,
} from '../electron/services/app-updates';
import { setup } from './helpers';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function release(version = '0.2.42', tag = `v${version}-beta.build.42.aaaaaaa`) {
  const base = 'https://github.com/NorthernBranch/modatro/releases';
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes('-'),
    html_url: `${base}/tag/${tag}`,
    assets: [
      `Modatro-Setup-${version}.exe`,
      `Modatro-${version}-arm64.dmg`,
      `Modatro-${version}-x64.dmg`,
      `Modatro-${version}-x86_64.AppImage`,
      `Modatro-${version}-amd64.deb`,
    ].map((name) => ({ name, size: 100, browser_download_url: `${base}/download/${tag}/${name}` })),
  };
}
it.each([
  ['win32', 'x64', false, 'Modatro-Setup-0.2.42.exe'],
  ['darwin', 'arm64', false, 'Modatro-0.2.42-arm64.dmg'],
  ['darwin', 'x64', false, 'Modatro-0.2.42-x64.dmg'],
  ['linux', 'x64', false, 'Modatro-0.2.42-x86_64.AppImage'],
  ['linux', 'x64', true, 'Modatro-0.2.42-amd64.deb'],
] as const)('selects the matching installer for %s %s', (platform, arch, debian, name) => {
  expect(
    newestAppRelease([release()], '0.2.41', platform, arch, debian)?.downloadUrl?.endsWith(
      `/${name}`,
    ),
  ).toBe(true);
});
it('compares versions rather than release order and never offers older or same-version builds', () => {
  expect(
    newestAppRelease([release('0.2.9'), release('0.2.100'), release()], '0.2.41', 'win32', 'x64')
      ?.version,
  ).toBe('0.2.100');
  expect(newestAppRelease([release()], '0.2.42', 'win32', 'x64')).toBeUndefined();
  expect(newestAppRelease([release()], '1.0.0', 'win32', 'x64')).toBeUndefined();
  expect(newestAppRelease([release('1.0.0', 'v1.0.0')], '0.2.42', 'win32', 'x64')?.version).toBe(
    '1.0.0',
  );
  expect(
    newestAppRelease([release('0.3.0-beta.2', 'v0.3.0-beta.2')], '0.3.0-beta.1', 'win32', 'x64')
      ?.version,
  ).toBe('0.3.0-beta.2');
});
it('rejects drafts, preview tags, incomplete platforms and links outside the project', () => {
  const wrongAsset = release();
  wrongAsset.assets[0]!.browser_download_url = wrongAsset.assets[0]!.browser_download_url.replace(
    'NorthernBranch/modatro',
    'other/project',
  );
  const missing = release();
  missing.assets = [];
  for (const entry of [
    { ...release(), draft: true },
    release('0.2.42', 'v0.2.42-build.42.aaaaaaa'),
    wrongAsset,
    missing,
    { ...release(), html_url: 'https://github.com/other/project/releases/tag/v0.2.42' },
  ])
    expect(newestAppRelease([entry], '0.2.41', 'win32', 'x64')).toBeUndefined();
});
it('checks only release metadata, preserves cached notices offline and clears notices after updating', async () => {
  const f = await setup();
  roots.push(f.root);
  const json = vi.fn(async (url: string) => {
    expect(url).toBe(APP_RELEASES_ENDPOINT);
    return [release()];
  });
  const service = new AppUpdates(f.storage, '0.2.41', vi.fn(), json, 'win32', 'x64');
  await service.check();
  expect(service.state.version).toBe('0.2.42');
  expect(json).toHaveBeenCalledTimes(1);
  const offline = new AppUpdates(
    f.storage,
    '0.2.41',
    vi.fn(),
    async () => {
      throw new Error('offline');
    },
    'win32',
    'x64',
  );
  await offline.loadCache();
  await offline.check();
  expect(offline.state.version).toBe('0.2.42');
  expect(offline.state.error).toContain('unavailable');
  expect(offline.state.checking).toBe(false);
  const updated = new AppUpdates(f.storage, '0.2.42', vi.fn(), json, 'win32', 'x64');
  await updated.loadCache();
  expect(updated.state.version).toBeUndefined();
  await updated.check();
  expect(updated.state.version).toBeUndefined();
});
