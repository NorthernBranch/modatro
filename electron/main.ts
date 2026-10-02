import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ModIndexUrl } from '../src/shared/mod-index';
import { ModId, RelativePath, RootSchema } from '../src/shared/model';
import { ModatroApplication } from './application';
import { errorReply, UserError } from './services/errors';
import { contained, exists, safeDestination } from './services/files';
import { launchModdedMac } from './services/launch';

// Isolate Chromium's profile and the single-instance lock as well as service
// storage, so smoke tests can run alongside an installed copy of Modatro.
if (process.env.MODATRO_TEST_DATA) {
  const testData = path.resolve(process.env.MODATRO_TEST_DATA);
  app.setPath('userData', testData);
  app.setPath('sessionData', testData);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'modatro',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined;
let application: ModatroApplication;
const rendererUrl =
  !app.isPackaged && process.env.MODATRO_DEV_URL === 'http://127.0.0.1:5173'
    ? process.env.MODATRO_DEV_URL
    : 'modatro://app/index.html';
const development = !app.isPackaged && rendererUrl.startsWith('http:');
const allowLink = (url: string) => {
  const u = new URL(url);
  return (
    u.protocol === 'https:' &&
    [
      'github.com',
      'smods.dev',
      'www.playbalatro.com',
      'thunderstore.io',
      'wiki.thunderstore.io',
    ].includes(u.hostname) &&
    !u.username &&
    !u.password &&
    !u.port
  );
};
function handle<T>(channel: string, schema: z.ZodType<T>, work: (arg: T) => Promise<unknown>) {
  ipcMain.handle(`modatro:${channel}`, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      const sender = event.senderFrame;
      if (
        !window ||
        event.sender !== window.webContents ||
        sender !== window.webContents.mainFrame ||
        !sender ||
        (rendererUrl.startsWith('http:')
          ? new URL(sender.url).origin !== new URL(rendererUrl).origin
          : sender.url !== rendererUrl)
      )
        throw new UserError('This request did not come from Modatro’s application window.');
      const value = await work(schema.parse(input));
      return { ok: true, value };
    } catch (e) {
      await application?.logger.log('ipc.failed', { channel, error: String(e) });
      return { ok: false, error: errorReply(e) };
    }
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'Modatro',
    backgroundColor: '#141c1b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: development,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  await window.loadURL(rendererUrl);
  window.on('closed', () => {
    window = undefined;
  });
}
app.on('second-instance', () => {
  window?.show();
  window?.focus();
});
void app
  .whenReady()
  .then(async () => {
    app.setName('Modatro');
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'windowMenu' },
          ])
        : null,
    );
    const assetRoot = path.resolve(__dirname, '..', 'dist');
    protocol.handle('modatro', (request) => {
      const url = new URL(request.url);
      const target = path.resolve(assetRoot, `.${decodeURIComponent(url.pathname)}`);
      if (url.host !== 'app' || !contained(assetRoot, target))
        return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(target).href);
    });
    session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            `default-src 'self'; script-src 'self' ${rendererUrl.startsWith('http:') ? "'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://ccdn.thunderstore.io https://gcdn.thunderstore.io; font-src 'self'; connect-src 'self' ${rendererUrl.startsWith('http:') ? 'ws://127.0.0.1:5173' : ''}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`,
          ],
        },
      }),
    );
    const dataRoot = process.env.MODATRO_TEST_DATA
      ? process.env.MODATRO_TEST_DATA
      : app.getPath('userData');
    application = new ModatroApplication(
      dataRoot,
      app.getVersion(),
      process.versions.electron,
      (progress) => window?.webContents.send('modatro:progress', progress),
      (snapshot) => window?.webContents.send('modatro:changed', snapshot),
    );
    await application.initialize();
    handle('snapshot', z.undefined(), () => application.snapshot());
    handle('refresh', z.undefined(), () => application.refresh());
    handle('detect', z.undefined(), () => application.detect());
    handle('choosePath', z.enum(['game', 'mods']), async (kind) => {
      const result = await dialog.showOpenDialog(window!, {
        title:
          kind === 'game' ? 'Find your Balatro installation' : 'Choose a dedicated Mods folder',
        properties: ['openDirectory'],
        defaultPath: kind === 'mods' ? application.detection.defaultModsPath() : undefined,
      });
      return result.canceled
        ? application.snapshot()
        : application.setPath(kind, result.filePaths[0]!);
    });
    handle('selectCandidate', z.string().max(4096), async (p) => {
      const s = await application.snapshot();
      if (!s.candidates.some((c) => c.path === p))
        throw new UserError('Select a detected installation or browse for a folder.');
      return application.setPath('game', p);
    });
    handle(
      'saveSettings',
      z
        .object({
          theme: z.enum(['dark', 'light', 'system']),
          setupComplete: z.boolean(),
          modIndexUrl: ModIndexUrl.optional(),
        })
        .strict(),
      (settings) => application.saveSettings(settings),
    );
    handle(
      'action',
      z
        .object({
          id: z.string().max(200),
          action: z.enum(['install', 'update', 'uninstall', 'disable', 'enable', 'adopt']),
          confirmationToken: z.uuid().optional(),
          acceptedUnverified: z
            .array(
              z
                .object({
                  id: z.string().regex(/^(Lovely|Steamodded)$/i),
                  versionConstraint: z.string().max(200).optional(),
                  installedVersion: z.string().max(200).optional(),
                  packageId: ModId.optional(),
                })
                .strict(),
            )
            .max(100)
            .optional(),
          decisions: z
            .array(
              z.object({
                root: RootSchema,
                path: RelativePath,
                action: z.enum(['keep', 'restore']),
              }),
            )
            .max(20000)
            .optional(),
        })
        .strict(),
      (request) =>
        application.action(
          request.id,
          request.action,
          request.decisions,
          request.confirmationToken,
          request.acceptedUnverified,
        ),
    );
    handle('cancel', z.undefined(), async () => application.installer.cancel());
    handle('previewPlan', z.string().max(200), (id) => application.previewPlan(id));
    handle('openModFolder', z.string().max(200), async (id) => {
      const local = (await application.snapshot()).localMods.find((mod) => mod.id === id);
      if (!local)
        throw new UserError('This installed mod is no longer present. Refresh and try again.');
      const record = application.storage.state.installations.find((mod) => mod.modId === id);
      const root = record?.disabled
        ? application.storage.file('disabled')
        : record?.files.every((file) => file.root === 'game')
          ? application.storage.state.settings.gamePath
          : application.storage.state.settings.modsPath;
      if (!root) throw new UserError('The Mods folder is not configured.');
      const file =
        record?.disabled || record?.files.every((file) => file.root === 'game')
          ? record.files[0]?.path
          : local.folderName;
      if (!file) throw new UserError('This mod has no recorded location.');
      let folder = await safeDestination(root, file);
      if (
        record?.disabled ||
        record?.files.every((file) => file.root === 'game') ||
        file.endsWith('.lua')
      )
        folder = path.dirname(folder);
      if (!(await exists(folder))) throw new UserError('The mod folder no longer exists.');
      const error = await shell.openPath(folder);
      if (error) throw new UserError('The mod folder could not be opened.', undefined, error);
    });
    handle('openFolder', z.enum(['game', 'mods', 'logs', 'backups', 'cache']), async (kind) => {
      const settings = application.storage.state.settings;
      const folder =
        kind === 'game'
          ? settings.gamePath
          : kind === 'mods'
            ? settings.modsPath
            : application.storage.file(kind === 'cache' ? 'catalogue-cache' : kind);
      if (!folder || !(await exists(folder)))
        throw new UserError('This folder has not been configured or no longer exists.');
      const error = await shell.openPath(folder);
      if (error) throw new UserError('The folder could not be opened.', undefined, error);
    });
    handle('openLink', z.url(), async (url) => {
      if (!allowLink(url))
        throw new UserError('This external link is not on a supported upstream website.');
      await shell.openExternal(url);
    });
    handle('githubStars', z.undefined(), () => application.githubStars());
    handle('launch', z.boolean(), (modded) =>
      application.launchGame(modded, async (s) => {
        if (process.platform === 'darwin' && modded) {
          await launchModdedMac(s.settings.gamePath!);
        } else await shell.openExternal('steam://rungameid/2379780');
      }),
    );
    handle('diagnostics', z.undefined(), async () => {
      const s = await application.snapshot();
      return JSON.stringify(
        {
          version: s.appVersion,
          electron: s.electronVersion,
          platform: s.platform,
          arch: s.arch,
          gameValid: s.validation?.valid ?? false,
          gameProblems: s.validation?.problems,
          managedMods: s.localMods
            .filter((m) => m.managed)
            .map((m) => ({
              id: m.id,
              version: m.version,
              state: m.state,
              problemCount: m.problems.length,
            })),
          prerequisites: s.prerequisites,
          catalogue: {
            provider: 'Thunderstore',
            status: s.catalogue.stale ? 'Offline' : 'Online',
            count: s.catalogue.mods.length,
            stale: s.catalogue.stale,
            fetchedAt: s.catalogue.fetchedAt,
            error: s.catalogue.error,
          },
          safetyError: s.safetyError,
        },
        null,
        2,
      );
    });
    handle('importDefinition', z.undefined(), async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Install from file or add a mod definition',
        filters: [{ name: 'Mod ZIP or Modatro definition', extensions: ['zip', 'json'] }],
        properties: ['openFile'],
      });
      return result.canceled
        ? application.snapshot()
        : application.importDefinition(result.filePaths[0]!);
    });
    await createWindow();
    if (!process.env.MODATRO_TEST_DATA) {
      application.backgroundRefresh();
      const refreshTimer = setInterval(() => application.backgroundRefresh(), 30 * 60 * 1000);
      refreshTimer.unref();
      app.once('before-quit', () => clearInterval(refreshTimer));
    }
    app.on('activate', () => {
      if (!window) void createWindow();
    });
  })
  .catch(async (e) => {
    dialog.showErrorBox('Modatro could not start', String(e));
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
