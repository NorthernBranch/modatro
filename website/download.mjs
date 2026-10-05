import {
  detectPlatform,
  downloadFor,
  newestRelease,
  RELEASES_API,
  RELEASES_URL,
} from './releases.mjs';

const link = document.querySelector('#download');
const label = document.querySelector('#download-label');
const status = document.querySelector('#download-status');
const select = document.querySelector('#platform');
const titles = {
  windows: 'Windows',
  'mac-arm64': 'Mac · Apple silicon',
  'mac-x64': 'Mac · Intel',
  linux: 'Linux / Steam Deck',
  'linux-deb': 'Debian / Ubuntu',
};
let release;
let failed = false;

function render() {
  const platform = select.value;
  const url = downloadFor(release, platform);
  link.href = url ?? release?.html_url ?? RELEASES_URL;
  label.textContent = url ? `Download for ${titles[platform]}` : 'Download Modatro';
  if (failed) {
    status.textContent =
      'Downloads are available on GitHub. Choose the installer for your computer.';
  } else if (platform === 'mac') {
    status.textContent = 'Choose Apple silicon or Intel below for your Mac’s installer.';
  } else if (platform === 'unknown') {
    status.textContent = 'Choose your platform below, or browse all downloads on GitHub.';
  } else if (!release) {
    status.textContent = 'Finding the latest download…';
  } else if (!url) {
    status.textContent = 'This release has no matching installer. Browse the downloads on GitHub.';
  } else {
    const version = /^v(\d+\.\d+\.\d+)/.exec(release.tag_name)?.[1];
    status.textContent = `Version ${version} · ${release.prerelease ? 'Beta release' : 'Latest release'} · Free and open source`;
  }
}

async function start() {
  let hints = {};
  try {
    hints =
      (await navigator.userAgentData?.getHighEntropyValues([
        'architecture',
        'bitness',
        'platform',
      ])) ?? {};
  } catch {
    /* Browser privacy settings may prevent architecture detection. */
  }
  select.value = detectPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    mobile:
      navigator.userAgentData?.mobile ||
      (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1),
    ...hints,
  });
  document.querySelector('#platform-choice').hidden = false;
  select.addEventListener('change', render);
  render();
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('Release lookup unavailable');
    release = newestRelease(await response.json());
    if (!release) throw new Error('No published release');
  } catch {
    failed = true;
  }
  render();
}

void start();
