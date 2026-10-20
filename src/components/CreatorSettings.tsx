import { useState } from 'react';
import { api } from '../api';
import { CREATOR_DISCLAIMER, SAVE_GUIDANCE, SAVE_NOTICE } from '../shared/creator';
import type { Reply, Snapshot, SettingsUpdate } from '../shared/model';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import { SettingsRow } from './PageElements';
import type { Requests } from '../hooks/useRequests';

export function CreatorSettings({
  snapshot,
  requests,
  callSnapshot,
}: {
  snapshot: Snapshot;
  requests: Requests;
  callSnapshot: (
    key: string,
    label: string,
    task: () => Promise<Reply<Snapshot>>,
  ) => Promise<Reply<Snapshot> | undefined>;
}) {
  const [acknowledge, setAcknowledge] = useState(false);
  const pending = requests.isPending('settings');
  async function save(input: Partial<SettingsUpdate>) {
    return callSnapshot('settings', 'Saving preferences', () =>
      api.saveSettings({
        theme: snapshot.settings.theme,
        setupComplete: snapshot.settings.setupComplete,
        ...input,
      }),
    );
  }
  return (
    <>
      <section className="settings-section">
        <h2>Balatro saves</h2>
        <p>{SAVE_NOTICE}</p>
        <p className="muted-text">{SAVE_GUIDANCE}</p>
        <SettingsRow
          title="Save-backup reminder"
          description={
            snapshot.settings.saveNoticeDismissed
              ? 'Hidden in the main interface.'
              : 'Visible in the main interface.'
          }
        >
          <AsyncButton
            className="button button-secondary"
            pending={pending}
            pendingLabel="Saving…"
            disabled={snapshot.preview || requests.isBusy('configuration')}
            onClick={() =>
              void save({ saveNoticeDismissed: !snapshot.settings.saveNoticeDismissed })
            }
          >
            {snapshot.settings.saveNoticeDismissed ? 'Show reminder again' : 'Hide reminder'}
          </AsyncButton>
        </SettingsRow>
      </section>
      <section className="settings-section" id="experimental-features" tabIndex={-1}>
        <h2>Experimental features</h2>
        <SettingsRow
          title="Mod Creator"
          description="Create local Steamodded mods, edit Lua and export ZIPs. Drafts and installed builds remain separate."
        >
          <label className="creator-toggle">
            <input
              type="checkbox"
              checked={!!snapshot.settings.creatorEnabled}
              disabled={!api.creator || snapshot.preview || requests.isBusy('configuration')}
              onChange={(e) => {
                if (e.target.checked && !snapshot.settings.creatorAcknowledged)
                  setAcknowledge(true);
                else void save({ creatorEnabled: e.target.checked });
              }}
            />{' '}
            Enable Mod Creator
          </label>
        </SettingsRow>
        <p className="muted-text">
          Disabled by default. Turning it off keeps your projects and installed mods.
        </p>
      </section>
      {acknowledge && (
        <Dialog
          title="Enable experimental Mod Creator?"
          dismissible={!pending}
          onClose={() => setAcknowledge(false)}
        >
          <p className="dialog-description">{CREATOR_DISCLAIMER}</p>
          <div className="dialog-footer">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setAcknowledge(false)}
            >
              Cancel
            </button>
            <AsyncButton
              className="button button-primary"
              pending={pending}
              pendingLabel="Enabling…"
              onClick={() =>
                void save({ creatorEnabled: true, creatorAcknowledged: true }).then((r) => {
                  if (r?.ok) setAcknowledge(false);
                })
              }
            >
              I understand — enable
            </AsyncButton>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function SaveBackupNotice({ dismiss, pending }: { dismiss: () => void; pending: boolean }) {
  return (
    <aside className="save-notice" aria-label="Save backup reminder">
      <details>
        <summary>{SAVE_NOTICE}</summary>
        <p>{SAVE_GUIDANCE}</p>
      </details>
      <button
        className="icon-button"
        aria-label="Dismiss save backup reminder"
        disabled={pending}
        onClick={dismiss}
      >
        ×
      </button>
    </aside>
  );
}
