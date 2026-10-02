import { contextBridge, ipcRenderer } from 'electron';
import type { ModatroApi, Progress, Snapshot } from '../src/shared/model';
const api: ModatroApi = {
  snapshot: () => ipcRenderer.invoke('modatro:snapshot'),
  refresh: () => ipcRenderer.invoke('modatro:refresh'),
  detect: () => ipcRenderer.invoke('modatro:detect'),
  choosePath: (kind) => ipcRenderer.invoke('modatro:choosePath', kind),
  selectCandidate: (path) => ipcRenderer.invoke('modatro:selectCandidate', path),
  saveSettings: (settings) => ipcRenderer.invoke('modatro:saveSettings', settings),
  githubStars: () => ipcRenderer.invoke('modatro:githubStars'),
  action: (id, action, decisions, confirmationToken, acceptedUnverified) =>
    ipcRenderer.invoke('modatro:action', {
      id,
      action,
      decisions,
      confirmationToken,
      acceptedUnverified,
    }),
  openModFolder: (id) => ipcRenderer.invoke('modatro:openModFolder', id),
  cancel: () => ipcRenderer.invoke('modatro:cancel'),
  previewPlan: (id) => ipcRenderer.invoke('modatro:previewPlan', id),
  openFolder: (kind) => ipcRenderer.invoke('modatro:openFolder', kind),
  openLink: (url) => ipcRenderer.invoke('modatro:openLink', url),
  launch: (modded) => ipcRenderer.invoke('modatro:launch', modded),
  diagnostics: () => ipcRenderer.invoke('modatro:diagnostics'),
  importDefinition: () => ipcRenderer.invoke('modatro:importDefinition'),
  onProgress: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, progress: Progress) => callback(progress);
    ipcRenderer.on('modatro:progress', listener);
    return () => ipcRenderer.removeListener('modatro:progress', listener);
  },
  onSnapshot: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('modatro:changed', listener);
    return () => ipcRenderer.removeListener('modatro:changed', listener);
  },
};
contextBridge.exposeInMainWorld('modatro', api);
