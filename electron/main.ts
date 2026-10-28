import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ModId, RelativePath, RootSchema, SettingsUpdateSchema } from '../src/shared/model';
import { allowedExternalLink } from '../src/shared/trust';
import { CreatorRequestSchema } from '../src/shared/creator';
import { ProfileTransferRequestSchema } from '../src/shared/profile-transfer';
import { ModatroApplication } from './application';
import { errorReply, UserError } from './services/errors';
import { contained, exists, safeDestination } from './services/files';
import { launchModdedMac } from './services/launch';
import {
  ProfileOperationSchema,
  ProfileConfirmationSchema,
  ProfilePlanSchema,
  DiagnosticRequestSchema,
  ReportExportSchema,
} from '../src/shared/features';

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
  const theme = application.storage.state.settings.theme;
  const resolved =
    theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme;
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: 'Modatro',
    show: false,
    backgroundColor: { dark: '#141b1a', light: '#f3f5f0', balatro: '#174b43' }[resolved],
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--modatro-theme=${theme}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: development,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question',
      title: 'Unsaved creator draft',
      message: 'Discard unsaved changes and close Modatro?',
      detail: 'Your last saved draft and installed build will be kept.',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
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
    application.profileTransfer.native = {
      open: async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: 'Import Modatro profile',
          properties: ['openFile'],
          filters: [{ name: 'Modatro profile', extensions: ['json'] }],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      save: async (name) => {
        const result = await dialog.showSaveDialog(window!, {
          title: 'Export Modatro profile',
          defaultPath: name,
          filters: [{ name: 'Modatro profile', extensions: ['json'] }],
        });
        return result.canceled ? undefined : result.filePath;
      },
    };
    handle('profileTransfer', ProfileTransferRequestSchema, async (request) => {
      const result = await application.profileTransfer.perform(request);
      await application.publish();
      return result;
    });
    application.creator.native = {
      artwork: async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: 'Import original PNG artwork',
          properties: ['openFile'],
          filters: [{ name: 'PNG artwork', extensions: ['png'] }],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      export: async (name) => {
        const result = await dialog.showSaveDialog(window!, {
          title: 'Export built mod ZIP',
          defaultPath: name,
          filters: [{ name: 'Mod ZIP', extensions: ['zip'] }],
        });
        return result.canceled ? undefined : result.filePath;
      },
      open: async (folder) => {
        const error = await shell.openPath(folder);
        if (error) throw new UserError('The project folder could not be opened.', undefined, error);
      },
    };
    handle('creator', CreatorRequestSchema, async (request) => {
      const result = await application.creator.perform(request);
      await application.publish();
      return result;
    });
    handle('snapshot', z.undefined(), () => application.snapshot());
    handle('profileOperation', ProfileOperationSchema, (request) =>
      application.profileOperation(request),
    );
    handle('previewProfile', z.uuid(), async (id) =>
      ProfilePlanSchema.parse(await application.profiles.preview(id)),
    );
    handle('switchProfile', ProfileConfirmationSchema, (request) =>
      application.switchProfile(request),
    );
    handle('troubleshoot', DiagnosticRequestSchema, (request) =>
      application.troubleshooting.inspect(request),
    );
    handle('chooseDiagnosticLog', z.undefined(), async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Select a saved game or loader log',
        properties: ['openFile'],
        filters: [{ name: 'Text logs', extensions: ['log', 'txt'] }],
      });
      return result.canceled ? undefined : application.troubleshooting.choose(result.filePaths[0]!);
    });
    handle('exportReport', ReportExportSchema, async (request) => {
      const result = await dialog.showSaveDialog(window!, {
        title: 'Export reviewed support report',
        defaultPath: 'modatro-support-report.md',
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] },
        ],
      });
      if (result.canceled || !result.filePath) return false;
      await application.troubleshooting.export(result.filePath, request.text);
      return true;
    });
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
    handle('saveSettings', SettingsUpdateSchema, (settings) => application.saveSettings(settings));
    handle('releaseOptions', ModId, (id) => application.releaseOptions(id));
    handle('deleteRemovedBackup', z.object({ id: z.uuid().optional() }).strict(), (request) =>
      application.deleteRemovedBackup(request.id),
    );
    handle(
      'restoreMod',
      z.object({ id: z.uuid(), token: z.uuid().optional() }).strict(),
      (request) => application.restoreMod(request.id, request.token),
    );
    handle(
      'action',
      z
        .object({
          id: z.string().max(200),
          action: z.enum(['install', 'update', 'uninstall', 'disable', 'enable', 'adopt']),
          confirmationToken: z.uuid().optional(),
          developmentDependencies: z.array(z.string().min(1).max(200)).max(8).optional(),
          selectedVersions: z
            .array(z.object({ id: ModId, key: z.string().min(1).max(220) }).strict())
            .max(8)
            .optional(),
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
          request.developmentDependencies,
          request.selectedVersions,
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
      if (!allowedExternalLink(url))
        throw new UserError('This external link is not on a supported upstream website.');
      await shell.openExternal(url);
    });
    handle('githubStars', z.undefined(), () => application.githubStars());
    handle('checkAppUpdates', z.undefined(), () => application.checkAppUpdates());
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
