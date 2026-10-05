export const REPOSITORY = 'NorthernBranch/modatro';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;

// macOS user agents often say Intel even on Apple silicon. Only trust explicit hints.
export function detectPlatform({
  userAgent = '',
  platform = '',
  mobile = false,
  architecture = '',
  bitness = '',
} = {}) {
  const agent = `${platform} ${userAgent}`;
  if (mobile || /Android|iPhone|iPad|iPod/i.test(agent)) return 'unknown';
  if (/Windows|Win32|Win64/i.test(agent)) {
    if (/arm|aarch/i.test(architecture) || /ARM|aarch/i.test(userAgent) || bitness === '32')
      return 'unknown';
    return 'windows';
  }
  if (/macOS|Mac/i.test(agent)) {
    if (/arm|aarch/i.test(architecture)) return 'mac-arm64';
    if (/^(x86|x64)$/i.test(architecture) && bitness !== '32') return 'mac-x64';
    return 'mac';
  }
  if (/Linux|X11/i.test(agent)) {
    if (/arm|aarch/i.test(`${architecture} ${userAgent}`) || bitness === '32') return 'unknown';
    return 'linux';
  }
  return 'unknown';
}

export function newestRelease(payload) {
  if (!Array.isArray(payload)) return undefined;
  return payload
    .filter((release) => {
      if (
        !release ||
        release.draft ||
        !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name) ||
        !Array.isArray(release.assets) ||
        !Number.isFinite(Date.parse(release.published_at))
      )
        return false;
      return release.html_url === `${RELEASES_URL}/tag/${release.tag_name}`;
    })
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

export function downloadFor(release, platform) {
  if (!release) return undefined;
  const version =
    /^v(\d+\.\d+\.\d+)-beta\.build\.\d+\.[a-f0-9]{7}$/.exec(release.tag_name)?.[1] ??
    release.tag_name.replace(/^v/, '');
  const name = {
    windows: `Modatro-Setup-${version}.exe`,
    'mac-arm64': `Modatro-${version}-arm64.dmg`,
    'mac-x64': `Modatro-${version}-x64.dmg`,
    linux: `Modatro-${version}-x86_64.AppImage`,
    'linux-deb': `Modatro-${version}-amd64.deb`,
  }[platform];
  if (!name) return undefined;
  const assets = release.assets.filter(
    (asset) =>
      asset &&
      asset.name === name &&
      asset.size > 0 &&
      asset.browser_download_url === `${RELEASES_URL}/download/${release.tag_name}/${asset.name}`,
  );
  return assets.length === 1 ? assets[0].browser_download_url : undefined;
}
