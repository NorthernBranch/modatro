import { expect, it } from 'vitest';
import { detectPlatform, downloadFor, newestRelease, RELEASES_URL } from '../website/releases.mjs';

function release(tag = 'v0.3.2-beta.build.13.bb583ba', published = '2026-10-02T15:08:56Z') {
  const names = [
    'Modatro-Setup-0.3.2.exe',
    'Modatro-0.3.2-arm64.dmg',
    'Modatro-0.3.2-x64.dmg',
    'Modatro-0.3.2-x86_64.AppImage',
    'Modatro-0.3.2-amd64.deb',
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: published,
    html_url: `${RELEASES_URL}/tag/${tag}`,
    assets: names.map((name) => ({
      name,
      size: 100,
      browser_download_url: `${RELEASES_URL}/download/${tag}/${name}`,
    })),
  };
}

it('detects supported desktops without treating mobile or an ambiguous Mac as x64', () => {
  expect(detectPlatform({ userAgent: 'Windows NT 10.0; Win64; x64' })).toBe('windows');
  expect(detectPlatform({ userAgent: 'Macintosh; Intel Mac OS X' })).toBe('mac');
  expect(detectPlatform({ platform: 'macOS', architecture: 'arm', bitness: '64' })).toBe(
    'mac-arm64',
  );
  expect(detectPlatform({ platform: 'macOS', architecture: 'x86', bitness: '64' })).toBe('mac-x64');
  expect(detectPlatform({ userAgent: 'X11; Linux x86_64' })).toBe('linux');
  for (const hints of [
    { userAgent: 'Android Linux' },
    { userAgent: 'iPhone' },
    { platform: 'macOS', mobile: true },
    { platform: 'Linux', architecture: 'arm' },
    { platform: 'Windows', architecture: 'arm' },
    { platform: 'Windows', bitness: '32' },
    {},
  ]) {
    expect(detectPlatform(hints)).toBe('unknown');
  }
});

it('finds the newest published beta while excluding drafts and unrelated release links', () => {
  const current = release();
  const older = release('v0.3.1-beta.build.12.fc81f14', '2026-10-02T10:47:09Z');
  const newer = release('v0.3.3-beta.build.14.abcdef0', '2026-10-05T10:00:00Z');
  expect(
    newestRelease([
      older,
      current,
      { ...newer, draft: true },
      { ...newer, html_url: 'https://example.com/releases' },
    ]),
  ).toBe(current);
  expect(newestRelease([current, newer, older])).toBe(newer);
  expect(newestRelease({ message: 'API rate limit exceeded' })).toBeUndefined();
  expect(newestRelease([])).toBeUndefined();
});

it('selects exact platform assets and never substitutes an unrelated or ambiguous download', () => {
  const current = release();
  for (const [platform, name] of [
    ['windows', 'Modatro-Setup-0.3.2.exe'],
    ['mac-arm64', 'Modatro-0.3.2-arm64.dmg'],
    ['mac-x64', 'Modatro-0.3.2-x64.dmg'],
    ['linux', 'Modatro-0.3.2-x86_64.AppImage'],
    ['linux-deb', 'Modatro-0.3.2-amd64.deb'],
  ]) {
    expect(downloadFor(current, platform)).toBe(
      `${RELEASES_URL}/download/${current.tag_name}/${name}`,
    );
  }
  expect(downloadFor(current, 'mac')).toBeUndefined();
  expect(downloadFor(current, 'unknown')).toBeUndefined();
  expect(downloadFor(undefined, 'windows')).toBeUndefined();
  expect(downloadFor({ ...current, assets: [] }, 'windows')).toBeUndefined();
  const asset = current.assets[0];
  for (const assets of [
    [{ ...asset, browser_download_url: 'https://example.com/installer.exe' }],
    [{ ...asset, size: 0 }],
    [
      {
        ...asset,
        name: 'Modatro-Setup-0.3.1.exe',
        browser_download_url: `${RELEASES_URL}/download/${current.tag_name}/Modatro-Setup-0.3.1.exe`,
      },
    ],
    [asset, asset],
  ]) {
    expect(downloadFor({ ...current, assets }, 'windows')).toBeUndefined();
  }
});
