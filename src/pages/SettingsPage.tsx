import { ArrowUpRight, ChevronRight, FolderOpen, Info, Plus, ShieldCheck } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api';
import { AsyncButton } from '../components/AsyncButton';
import type { Requests } from '../hooks/useRequests';
import { PageHeading, PaletteIcon, SettingsRow } from '../components/PageElements';
import type { Reply, Snapshot } from '../shared/model';

interface Props {
  snapshot?: Snapshot;
  gameReady: boolean;
  callSnapshot: (
    key: string,
    label: string,
    task: () => Promise<Reply<Snapshot>>,
  ) => Promise<Reply<Snapshot> | undefined>;
  requests: Requests;
  refresh: () => Promise<void>;
  refreshing: boolean;
  setNotification: Dispatch<SetStateAction<string | undefined>>;
  setAbout: Dispatch<SetStateAction<boolean>>;
}
export function SettingsPage({
  snapshot,
  gameReady,
  callSnapshot,
  requests,
  refresh,
  refreshing,
  setNotification,
  setAbout,
}: Props) {
  const configuring = requests.isBusy('configuration');
  async function openFolder(kind: 'game' | 'mods' | 'logs' | 'backups' | 'cache') {
    await requests.run(`folder:${kind}`, 'Opening folder', () => api.openFolder(kind));
  }
  async function copyDiagnostics() {
    const reply = await requests.run('diagnostics', 'Copying diagnostics', async () => {
      const result = await api.diagnostics();
      if (!result.ok) return result;
      try {
        await navigator.clipboard.writeText(result.value);
        return { ok: true, value: undefined } as const;
      } catch {
        return {
          ok: false,
          error: {
            message:
              'The clipboard is unavailable. You can copy the diagnostics from Technical details.',
            details: result.value,
          },
        } as const;
      }
    });
    if (reply?.ok) setNotification('Diagnostics copied to clipboard.');
  }
  return (
    <>
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="Just the way you like it."
        description="Your installation, your preferences, and a little peace of mind."
      />
      {snapshot && (
        <div className="settings-layout">
          <section className="settings-section">
            <h2>
              <FolderOpen size={19} />
              Game & mods
            </h2>
            <SettingsRow
              title="Balatro installation"
              description={snapshot.settings.gamePath ?? 'No installation selected'}
            >
              <span className={`state-badge ${gameReady ? 'ready' : 'missing'}`}>
                {gameReady ? '✓ Validated' : '× Not connected'}
              </span>
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('choose-game')}
                pendingLabel="Choosing folder…"
                disabled={configuring}
                onClick={() =>
                  void callSnapshot('choose-game', 'Choosing Balatro folder', () =>
                    api.choosePath('game'),
                  )
                }
              >
                Choose folder
              </AsyncButton>
              <AsyncButton
                className="icon-button"
                disabled={!snapshot.settings.gamePath}
                pending={requests.isPending('folder:game')}
                pendingLabel=""
                aria-label="Open Balatro folder"
                onClick={() => void openFolder('game')}
              >
                <FolderOpen size={17} />
              </AsyncButton>
            </SettingsRow>
            <SettingsRow
              title="Mods directory"
              description={snapshot.settings.modsPath ?? 'Detected after you connect Balatro'}
            >
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('choose-mods')}
                pendingLabel="Choosing folder…"
                disabled={configuring}
                onClick={() =>
                  void callSnapshot('choose-mods', 'Choosing Mods folder', () =>
                    api.choosePath('mods'),
                  )
                }
              >
                Change folder
              </AsyncButton>
              <AsyncButton
                className="icon-button"
                disabled={!snapshot.settings.modsPath}
                pending={requests.isPending('folder:mods')}
                pendingLabel=""
                aria-label="Open Mods folder"
                onClick={() => void openFolder('mods')}
              >
                <FolderOpen size={17} />
              </AsyncButton>
            </SettingsRow>
            <div className="settings-inline-note">
              <Info size={14} />
              Game files and mods live in separate folders. Changing folders requires uninstalling
              managed mods first.
            </div>
          </section>
          <section className="settings-section">
            <h2>
              <PaletteIcon />
              Appearance
            </h2>
            <SettingsRow title="Theme" description="Choose the look that feels right for you.">
              <select
                aria-label="Theme"
                value={snapshot.settings.theme}
                disabled={configuring}
                aria-busy={requests.isPending('settings') || undefined}
                onChange={(e) =>
                  void callSnapshot('settings', 'Saving theme', () =>
                    api.saveSettings({
                      theme: e.target.value as 'dark' | 'light' | 'system',
                      setupComplete: snapshot.settings.setupComplete,
                    }),
                  )
                }
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Match system</option>
              </select>
              {requests.isPending('settings') && <span role="status">Saving theme…</span>}
            </SettingsRow>
          </section>
          <section className="settings-section">
            <h2>
              <ShieldCheck size={19} />
              Storage & safety
            </h2>
            <SettingsRow
              title="Catalogue & download cache"
              description={
                snapshot.catalogue.fetchedAt
                  ? `Last successful refresh: ${new Date(snapshot.catalogue.fetchedAt).toLocaleString('en-GB')}`
                  : 'No catalogue cached yet.'
              }
            >
              <AsyncButton
                className="text-button"
                pending={requests.isPending('folder:cache')}
                pendingLabel="Opening…"
                onClick={() => void openFolder('cache')}
              >
                Open cache
                <ArrowUpRight size={14} />
              </AsyncButton>
              <AsyncButton
                className="button button-secondary"
                pending={refreshing}
                pendingLabel="Refreshing…"
                onClick={() => void refresh()}
              >
                Refresh
              </AsyncButton>
            </SettingsRow>
            <SettingsRow
              title="Original file backups"
              description="Preserved for recovery and uninstall. Backups are never automatically deleted."
            >
              <AsyncButton
                className="text-button"
                pending={requests.isPending('folder:backups')}
                pendingLabel="Opening…"
                onClick={() => void openFolder('backups')}
              >
                Open backups
                <ArrowUpRight size={14} />
              </AsyncButton>
            </SettingsRow>
            <SettingsRow
              title="Diagnostics"
              description="Local logs help explain what happened. Personal file contents are never logged."
            >
              <AsyncButton
                className="text-button"
                pending={requests.isPending('folder:logs')}
                pendingLabel="Opening…"
                onClick={() => void openFolder('logs')}
              >
                Open logs
                <ArrowUpRight size={14} />
              </AsyncButton>
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('diagnostics')}
                pendingLabel="Copying…"
                onClick={() => void copyDiagnostics()}
              >
                Copy diagnostics
              </AsyncButton>
            </SettingsRow>
          </section>
          <details className="settings-section advanced-settings">
            <summary>
              Advanced
              <ChevronRight size={16} />
            </summary>
            <p>
              Install a local mod ZIP, or add an explicit Modatro JSON definition for a mod with a
              known installation method. File replacement definitions list every source and
              destination; you review them before installing.
            </p>
            <AsyncButton
              className="button button-secondary"
              pending={requests.isPending('import')}
              pendingLabel="Inspecting file…"
              disabled={configuring}
              onClick={() =>
                void callSnapshot('import', 'Importing mod definition', () =>
                  api.importDefinition(),
                )
              }
            >
              <Plus size={15} />
              Install from file / Add mod definition
            </AsyncButton>
          </details>
          <section className="settings-section">
            <SettingsRow
              title="About Modatro"
              description="Independent. Community-built. Made for your next run."
            >
              <button className="text-button" onClick={() => setAbout(true)}>
                Version {snapshot.appVersion}
                <ArrowUpRight size={14} />
              </button>
            </SettingsRow>
          </section>
        </div>
      )}
    </>
  );
}
