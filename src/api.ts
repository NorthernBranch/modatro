import { version } from '../package.json';
import preview from './preview-catalogue.json';
import type { ModatroApi, ModDefinition, Reply, Snapshot } from './shared/model';
import { ModSchema } from './shared/model';
declare global {
  interface Window {
    modatro?: ModatroApi;
  }
}
const previewMods: ModDefinition[] = preview.mods.map(({ folder, metadata, description }) =>
  ModSchema.parse({
    id: folder,
    title: metadata.title,
    author: metadata.author,
    version: metadata.version,
    description,
    repositoryUrl: metadata.repo,
    downloadUrl: metadata.downloadURL,
    categories: metadata.categories.map(
      (c) =>
        (({ Joker: 'Jokers', API: 'APIs', Extension: 'Extensions' }) as Record<string, string>)[
          c
        ] ?? c,
    ),
    sourceCategories: metadata.categories,
    prerequisites: [
      metadata['requires-steamodded']
        ? { id: 'Steamodded', displayName: 'Steamodded', required: true }
        : null,
      metadata['requires-talisman']
        ? { id: 'Talisman', displayName: 'Talisman', required: true }
        : null,
    ].filter(Boolean),
    installation: { type: 'auto' },
  }),
);
const snapshot: Snapshot = {
  settings: { theme: 'dark', setupComplete: false },
  catalogue: {
    mods: previewMods,
    stale: true,
    refreshing: false,
    rejected: 0,
    fetchedAt: preview.fetchedAt,
  },
  localMods: [],
  prerequisites: [
    {
      id: 'Lovely',
      displayName: 'Lovely',
      installed: false,
      sourceUrl: 'https://github.com/ethangreen-dev/lovely-injector',
      instructions:
        'Use the official release for your platform. On macOS, liblovely.dylib lives beside Balatro.app. On Windows, winmm.dll lives beside Balatro.exe.',
    },
    {
      id: 'Steamodded',
      displayName: 'Steamodded',
      installed: false,
      sourceUrl: 'https://github.com/Steamodded/smods',
    },
    {
      id: 'Talisman',
      displayName: 'Talisman',
      installed: false,
      sourceUrl: 'https://github.com/SpectralPack/Talisman',
    },
  ],
  candidates: [],
  platform: 'browser',
  arch: 'preview',
  appVersion: version,
  electronVersion: 'Desktop only',
  preview: true,
};
const desktopOnly = async (): Promise<Reply<never>> => ({
  ok: false,
  error: {
    message:
      'This is a read-only browser preview. Open the Modatro desktop app to detect Balatro and manage files.',
  },
});
const previewApi: ModatroApi = {
  snapshot: async () => ({ ok: true, value: snapshot }),
  refresh: async () => ({ ok: true, value: snapshot }),
  detect: desktopOnly,
  choosePath: desktopOnly,
  selectCandidate: desktopOnly,
  saveSettings: async (settings) => {
    snapshot.settings = { ...snapshot.settings, theme: settings.theme };
    return { ok: true, value: { ...snapshot } };
  },
  action: desktopOnly,
  cancel: desktopOnly,
  openFolder: desktopOnly,
  launch: desktopOnly,
  diagnostics: async () => ({
    ok: true,
    value: JSON.stringify({ mode: 'Read-only browser preview', version: snapshot.appVersion }),
  }),
  importDefinition: desktopOnly,
  openLink: async (url) => {
    const u = new URL(url);
    if (
      u.protocol === 'https:' &&
      ['github.com', 'smods.dev', 'www.playbalatro.com'].includes(u.hostname)
    ) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { ok: true, value: undefined };
    }
    return desktopOnly();
  },
  onProgress: () => () => {},
  onSnapshot: () => () => {},
};
export const api = window.modatro ?? previewApi;
