import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type { Snapshot } from '../shared/model';
import type { Requests } from '../hooks/useRequests';
import type { SetupRecoveryMode, SetupRecoveryPlan } from '../shared/setup-recovery';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import { storageSize } from '../shared/presentation';

export function SetupRecoveryDialog({
  snapshot,
  requests,
  changed,
  onClose,
  onDiscover,
}: {
  snapshot: Snapshot;
  requests: Requests;
  changed: (snapshot: Snapshot) => void;
  onClose: () => void;
  onDiscover: () => void;
}) {
  const [mode, setMode] = useState<SetupRecoveryMode>(
    snapshot.localMods.some((mod) => mod.managed && mod.state === 'broken') ? 'missing' : 'reset',
  );
  const [plan, setPlan] = useState<SetupRecoveryPlan>();
  const [failure, setFailure] = useState<string>();
  const [backup, setBackup] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [visibleFiles, setVisibleFiles] = useState(100);
  const pending = requests.isPending('setup-recovery');
  async function review(next = mode) {
    setMode(next);
    setPlan(undefined);
    setFailure(undefined);
    setAcknowledged(false);
    setVisibleFiles(100);
    const reply = await requests.run(
      'setup-recovery',
      'Checking your mod setup',
      () => api.setupRecovery!({ operation: 'review', mode: next }),
      { group: 'configuration', reportError: false },
    );
    if (reply?.ok && reply.value.status === 'review') setPlan(reply.value.plan);
    else
      setFailure(
        reply && !reply.ok
          ? reply.error.message
          : 'Another operation is running. Try again when it finishes.',
      );
  }
  useEffect(() => {
    void review();
  }, []);
  async function apply() {
    if (!plan) return;
    setFailure(undefined);
    const reply = await requests.run(
      'setup-recovery',
      'Backing up and repairing your setup',
      () => api.setupRecovery!({ operation: 'apply', token: plan.token }),
      { group: 'configuration', reportError: false },
    );
    if (reply?.ok && reply.value.status === 'complete') {
      changed(reply.value.snapshot);
      setBackup(reply.value.backupFolder);
    } else {
      setPlan(undefined);
      setFailure(
        reply && !reply.ok
          ? reply.error.message
          : 'Recovery did not start. Review your setup again.',
      );
    }
  }
  return (
    <Dialog
      title={backup ? 'Your setup is ready' : 'Repair or reset mod setup'}
      onClose={onClose}
      dismissible={!pending}
      wide
    >
      <div className="setup-recovery-content">
        {backup ? (
          <>
            <p>
              {mode === 'missing'
                ? 'Missing installation entries have been cleared from Installed and your profiles.'
                : 'Mod files and Lovely have been removed from the reviewed locations. You can start again in Discover.'}
            </p>
            <p>Balatro saves, application settings and editable creator projects were preserved.</p>
            <p>A recovery copy of the previous records and available files is kept here:</p>
            <code className="recovery-backup-path">{backup}</code>
            <p className="muted">Already-missing files cannot be recovered from this copy.</p>
            <div className="dialog-actions">
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('folder:recovery')}
                pendingLabel="Opening backups…"
                onClick={() =>
                  void requests.run('folder:recovery', 'Opening recovery copies', () =>
                    api.openFolder('backups'),
                  )
                }
              >
                Open backups
              </AsyncButton>
              <button className="button button-primary" onClick={onDiscover}>
                Go to Discover
              </button>
              <button className="button button-secondary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Close Balatro, then choose how you want to recover. Review the locations before
              confirming.
            </p>
            <label className="recovery-choice">
              <input
                type="radio"
                name="setup-recovery-mode"
                checked={mode === 'missing'}
                disabled={pending}
                onChange={() => void review('missing')}
              />
              <span>
                <strong>Clear missing installation entries</strong>
                <small>
                  Remove saved entries only when all their managed files are absent. Existing files
                  stay untouched.
                </small>
              </span>
            </label>
            <label className="recovery-choice">
              <input
                type="radio"
                name="setup-recovery-mode"
                checked={mode === 'reset'}
                disabled={pending}
                onChange={() => void review('reset')}
              />
              <span>
                <strong>Back up and reset mod setup</strong>
                <small>
                  Remove current mod files, disabled copies and identified Lovely libraries,
                  including legacy versions. Includes external mods and mod configuration.
                </small>
              </span>
            </label>
            {pending && (
              <p role="status">
                <LoaderCircle className="spin" size={16} />{' '}
                {plan
                  ? 'Creating verified recovery copies and applying the reviewed changes. Keep Modatro open.'
                  : 'Checking files and saved installation entries…'}
              </p>
            )}
            {failure && (
              <p role="alert" className="feature-warning">
                {failure}
              </p>
            )}
            {plan && (
              <>
                <dl className="diagnostic-overview">
                  <div>
                    <dt>Game folder</dt>
                    <dd>{plan.gamePath}</dd>
                  </div>
                  <div>
                    <dt>Mods folder</dt>
                    <dd>{plan.modsPath}</dd>
                  </div>
                  <div>
                    <dt>Installation entries to clear</dt>
                    <dd>{plan.records.length}</dd>
                  </div>
                  <div>
                    <dt>Files to back up and remove</dt>
                    <dd>
                      {plan.files.length} · {storageSize(plan.sizeBytes)}
                    </dd>
                  </div>
                </dl>
                <p>
                  Balatro saves, base game files, editable creator projects and existing backups
                  stay safe. A local recovery copy is verified before anything is removed.
                </p>
                {plan.records.length > 0 && (
                  <details>
                    <summary>Installation entries ({plan.records.length})</summary>
                    <ul>
                      {plan.records.map((record) => (
                        <li key={record.id}>{record.title}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.files.length > 0 && (
                  <details>
                    <summary>Files to remove ({plan.files.length})</summary>
                    <ul className="recovery-file-list">
                      {plan.files.slice(0, visibleFiles).map((file) => (
                        <li key={`${file.root}/${file.path}`}>
                          <code>
                            {file.root}/{file.path}
                          </code>
                        </li>
                      ))}
                    </ul>
                    {visibleFiles < plan.files.length && (
                      <button
                        className="text-button"
                        onClick={() => setVisibleFiles((count) => count + 100)}
                      >
                        Show more files ({plan.files.length - visibleFiles} remaining)
                      </button>
                    )}
                  </details>
                )}
                {plan.warnings.map((warning) => (
                  <p className="feature-warning" key={warning}>
                    {warning}
                  </p>
                ))}
                {!plan.records.length && !plan.files.length ? (
                  <p role="status">Nothing needs clearing in this mode.</p>
                ) : mode === 'reset' ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={pending}
                      onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    I understand that all reviewed mod files and their profile entries will be
                    removed after backup.
                  </label>
                ) : null}
              </>
            )}
            <div className="dialog-actions">
              <button className="button button-secondary" disabled={pending} onClick={onClose}>
                Cancel
              </button>
              {!plan ? (
                <button
                  className="button button-secondary"
                  disabled={pending}
                  onClick={() => void review()}
                >
                  Check again
                </button>
              ) : (
                <AsyncButton
                  className={mode === 'reset' ? 'button button-danger' : 'button button-primary'}
                  pending={pending}
                  pendingLabel="Applying recovery…"
                  disabled={
                    (mode === 'reset' && !acknowledged) ||
                    (!plan.records.length && !plan.files.length)
                  }
                  onClick={() => void apply()}
                >
                  {mode === 'reset' ? 'Back up and reset' : 'Clear missing entries'}
                </AsyncButton>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
