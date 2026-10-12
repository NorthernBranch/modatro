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
    state: mod.title === 'JokerDisplay' ? 'disabled' : 'installed',
    disabled: mod.title === 'JokerDisplay',
    managed: true,
    canAdopt: false,
    canDisable: mod.title !== 'Lovely',
    folderName: mod.title,
    metadataId: mod.title,
    problems: [],
    dependencies: mod.prerequisites,
    provenance: { provider: 'thunderstore', sourceType: 'registry', packageVersion: mod.version },
  }));
const profileId = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  profiles: {
    schemaVersion: 1,
    activeId: profileId,
    unsaved: false,
    differences: [],
    unmanagedCount: 0,
    items: [
      {
        id: profileId,
        name: 'Everyday',
        selection: localMods.map((mod) => ({ id: mod.id, enabled: !mod.disabled })),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Just the essentials',
        selection: localMods.map((mod) => ({
          id: mod.id,
          enabled: ['Lovely', 'Steamodded', 'JokerDisplay'].includes(mod.title),
        })),
      },
    ],
  },
  settings: {
    theme: 'dark',
    setupComplete: true,
    gamePath: 'C:\\Games\\Steam\\steamapps\\common\\Balatro',
    modsPath: 'C:\\Users\\Example\\AppData\\Roaming\\Balatro\\Mods',
  },
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
      profileOperation: unavailable,
      previewProfile: async (id) => ({
        ok: true,
        value: {
          profileId: id,
          name: state.profiles.items.find((p) => p.id === id).name,
          token: '44444444-4444-4444-8444-444444444444',
          expiresAt: '2026-10-12T12:05:00Z',
          enable: state.localMods.filter((m) => m.title === 'JokerDisplay').map((m) => m.id),
          disable: state.localMods
            .filter((m) => ['PlayLog', 'FoolsDisplay'].includes(m.title))
            .map((m) => m.id),
          retained: state.localMods
            .filter((m) => ['Lovely', 'Steamodded'].includes(m.title))
            .map((m) => m.id),
          selection: state.profiles.items.find((p) => p.id === id).selection,
          blockers: [],
          warnings: [
            'Unmanaged mods, if present, remain untouched and may still affect gameplay. Review them in Installed if you want to adopt them.',
          ],
        },
      }),
      switchProfile: unavailable,
      troubleshoot: async () => ({
        ok: true,
        value: {
          generatedAt: '2026-10-12T12:00:00Z',
          appVersion: state.appVersion,
          platform: state.platform,
          arch: state.arch,
          gameVersion: state.validation.detectedVersion,
          prerequisites: state.prerequisites.map((p) => ({
            id: p.id,
            installed: p.installed,
            version: p.installedVersion,
          })),
          mods: state.localMods.map((m) => ({
            id: m.id,
            title: m.title,
            version: m.version,
            enabled: !m.disabled,
            managed: true,
          })),
          profile: state.profiles,
          findings: [],
          history: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              time: '2026-10-12T11:55:00Z',
              type: 'profile-switch',
              ids: [],
              versions: [],
              outcome: 'success',
              profile: 'Everyday',
            },
          ],
          logs: [
            {
              id: 'synthetic-loader-log',
              name: 'example-run.log',
              source: 'Lovely / Steamodded',
              modifiedAt: '2026-10-12T11:50:00Z',
              stale: false,
            },
          ],
          report: '# Synthetic support report\nNo personal data is used.',
        },
      }),
      chooseDiagnosticLog: unavailable,
      exportReport: unavailable,
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
  await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
  await page.getByRole('heading', { name: 'Mod profiles', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'profiles.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Profile', { exact: true })
    .selectOption('22222222-2222-4222-8222-222222222222');
  await page
    .getByRole('heading', { name: 'Review profile: Just the essentials', exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(output, 'profile-switch.png'), animations: 'disabled' });
  // Inspect the same real dialog at a narrow width without changing any files.
  await page.setViewportSize({ width: 375, height: 812 });
  const contained = await page
    .getByRole('dialog')
    .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth);
  if (!contained) throw new Error('The profile switch dialog overflows at a narrow width.');
  await page
    .getByRole('button', { name: 'Confirm profile switch', exact: true })
    .scrollIntoViewIfNeeded();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({
    path: path.join(root, 'test-results/profile-switch-mobile.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
  await page.getByRole('heading', { name: 'Setup overview', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'troubleshooting.png'), animations: 'disabled' });
  await copyFile(path.join(output, 'profiles.png'), path.join(websiteImages, 'profiles.png'));
  await copyFile(
    path.join(output, 'troubleshooting.png'),
    path.join(websiteImages, 'troubleshooting.png'),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Just the way you like it.', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'settings.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('heading', { name: 'Keep your next run fresh.', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'updates.png'), animations: 'disabled' });
  const issues = [];
  for (const width of [1440, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      'Discover',
      'Installed',
      'Updates',
      'Prerequisites',
      'Troubleshooting',
      'Settings',
    ]) {
      await page
        .locator('nav')
        .getByRole('button', { name: new RegExp('^' + name) })
        .click();
      if (name === 'Troubleshooting')
        await page.getByRole('heading', { name: 'Setup overview' }).waitFor();
      const layout = await page.evaluate(() => {
        const main = document.querySelector('.main-content'),
          bar = document.querySelector('.topbar-actions');
        return {
          document: document.documentElement.scrollWidth > innerWidth,
          content: main.scrollWidth > main.clientWidth + 1,
          header: bar.getBoundingClientRect().right > innerWidth + 1,
        };
      });
      if (layout.document || layout.content || layout.header)
        issues.push({ width, page: name, ...layout });
    }
  }
  if (issues.length) throw new Error('App layout overflow: ' + JSON.stringify(issues));
  console.log('Layout review passed on all six pages at 1440, 1024, 768 and 375 pixels.');
  console.log(
    'Saved Discover, Installed, Updates, Prerequisites, Settings, Profiles, Profile switch and Troubleshooting screenshots to docs/images/.',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    server.kill();
  }
}
