import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture the real renderer with representative data. The bridge below cannot
// access Electron, the network, application data or a user's game installation.
const root = fileURLToPath(new URL('../', import.meta.url));
const preview = JSON.parse(await readFile(path.join(root, 'src/preview-catalogue.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const titles = new Set([
  'Steamodded',
  'Lovely',
  'JokerDisplay',
  'Cryptid',
  'TargetedRerolls',
  'FoolsDisplay',
  'PlayLog',
  'The Cracker Pack',
  'Sagatro',
]);
const mods = preview.mods
  .filter((mod) => titles.has(mod.title))
  .map((mod) => ({
    ...mod,
    iconUrl: undefined,
  }));
const localMods = mods
  .filter((mod) =>
    ['Steamodded', 'Lovely', 'JokerDisplay', 'PlayLog', 'FoolsDisplay'].includes(mod.title),
  )
  .map((mod) => ({
    id: mod.id,
    title: mod.title,
    version: mod.version,
    state: 'installed',
    managed: true,
    canAdopt: false,
    canDisable: mod.title !== 'Lovely',
    folderName: mod.title,
    metadataId: mod.title,
    problems: [],
    dependencies: mod.prerequisites,
    provenance: { provider: 'thunderstore', sourceType: 'registry', packageVersion: mod.version },
  }));
const snapshot = {
  settings: { theme: 'dark', setupComplete: true },
  validation: { valid: true, detectedVersion: '1.0.1o', problems: [], warnings: [] },
  catalogue: { mods, stale: false, refreshing: false, rejected: 0, fetchedAt: preview.fetchedAt },
  localMods,
  prerequisites: [
    {
      id: 'Lovely',
      displayName: 'Lovely',
      installed: true,
      installedVersion: '0.10.0',
      latestVersion: '0.10.0',
      sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
    },
    {
      id: 'Steamodded',
      displayName: 'Steamodded',
      installed: true,
      installedVersion: '26.829.0',
      latestVersion: '26.829.0',
      packageId: 'thunderstore/Steamodded-Steamodded',
      packageVersion: '26.829.0',
      latestPackageId: 'thunderstore/Steamodded-Steamodded',
      sourceUrl: 'https://github.com/Steamodded/smods',
    },
    {
      id: 'Talisman',
      displayName: 'Talisman',
      installed: false,
      sourceUrl: 'https://github.com/SpectralPack/Talisman',
    },
    {
      id: 'Balatro',
      displayName: 'Balatro',
      installed: true,
      installedVersion: '1.0.1o',
      sourceUrl: 'https://www.playbalatro.com',
    },
  ],
  candidates: [],
  platform: 'win32',
  arch: 'x64',
  appVersion: pkg.version,
  electronVersion: 'Desktop',
  trust: { fresh: true },
};
const url = 'http://127.0.0.1:5183';
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5183',
    '--strictPort',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Screenshot server stopped: ${serverOutput}`);
    try {
      // Wait for our server, not an unrelated process already using this port.
      ready = serverOutput.includes('Local:') && (await fetch(url)).ok;
    } catch {
      /* Wait for Vite. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Screenshot server did not start: ${serverOutput}`);
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === url) return route.continue();
    return route.abort();
  });
  await page.addInitScript((state) => {
    const reply = async () => ({ ok: true, value: state });
    const unavailable = async () => ({
      ok: false,
      error: { message: 'Documentation capture is read-only.' },
    });
    window.modatro = {
      snapshot: reply,
      refresh: reply,
      detect: unavailable,
      choosePath: unavailable,
      selectCandidate: unavailable,
      action: unavailable,
      cancel: unavailable,
      importDefinition: unavailable,
      launch: unavailable,
      openFolder: unavailable,
      openModFolder: unavailable,
      openLink: unavailable,
      diagnostics: unavailable,
      saveSettings: unavailable,
      checkAppUpdates: reply,
      githubStars: async () => ({ ok: true, value: {} }),
      onProgress: () => () => {},
      onSnapshot: () => () => {},
    };
  }, snapshot);
  const output = path.join(root, 'docs/images');
  await mkdir(output, { recursive: true });
  await page.goto(url);
  await page.locator('.mod-card').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'discover.png'), animations: 'disabled' });
  const websiteImages = path.join(root, 'website/images');
  await mkdir(websiteImages, { recursive: true });
  await copyFile(path.join(output, 'discover.png'), path.join(websiteImages, 'discover.png'));
  await page
    .locator('nav')
    .getByRole('button', { name: /^Installed/ })
    .click();
  await page.getByRole('heading', { name: 'Your mods, all together.' }).waitFor();
  await page.screenshot({ path: path.join(output, 'installed.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Prerequisites', exact: true }).click();
  await page.getByRole('heading', { name: 'Lovely', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'prerequisites.png'), animations: 'disabled' });
  console.log('Saved Discover, Installed and Prerequisites screenshots to docs/images/.');
} finally {
  try {
    await browser?.close();
  } finally {
    server.kill();
  }
}
