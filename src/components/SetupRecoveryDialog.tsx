import { useEffect, useRef, useState } from 'react';
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
  initialModId,
  initialMode = 'repair',
}: {
  snapshot: Snapshot;
  requests: Requests;
  changed: (snapshot: Snapshot) => void;
  onClose: () => void;
  onDiscover: () => void;
  initialModId?: string;
  initialMode?: 'repair' | 'remove';
}) {
  const broken = snapshot.localMods.filter(
    (mod) =>
      mod.managed && mod.state === 'broken' && mod.canDisable !== false && !mod.provenance?.creator,
  );
  const [modId, setModId] = useState(initialModId ?? broken[0]?.id ?? '');
  const [mode, setMode] = useState<SetupRecoveryMode>(
    (initialModId ? broken.find((mod) => mod.id === initialModId) : broken[0])?.filesMissing
      ? 'remove'
      : initialModId
        ? initialMode
        : broken.length
          ? 'repair'
          : 'reset',
  );
  const [plan, setPlan] = useState<SetupRecoveryPlan>();
  const [failure, setFailure] = useState<string>();
  const [backup, setBackup] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [visibleFiles, setVisibleFiles] = useState(100);
  const pending = requests.isPending('setup-recovery');
  const started = useRef(false);
  const removingMissing = mode === 'remove' && plan?.files.length === 0;
  const selectedMod = broken.find((mod) => mod.id === modId);
  const deleted = !!selectedMod?.filesMissing || removingMissing;
  const hasMissing = snapshot.localMods.some((mod) => mod.managed && mod.filesMissing);
  async function review(next = mode, selected = modId) {
    setMode(next);
    setPlan(undefined);
    setFailure(undefined);
    setAcknowledged(false);
    setVisibleFiles(100);
    const reply = await requests.run(
      'setup-recovery',
      'Checking your mod setup',
      () =>
        api.setupRecovery!(
          next === 'repair' || next === 'remove'
            ? { operation: 'review', mode: next, modId: selected }
            : { operation: 'review', mode: next },
        ),
      { group: 'configuration', reportError: false },
    );
    if (reply?.ok && reply.value.status === 'review') {
      setPlan(reply.value.plan);
      setFailure(undefined);
    } else
      setFailure(
        reply && !reply.ok
          ? reply.error.message
          : 'Another operation is running. Try again when it finishes.',
      );
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
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
                : mode === 'repair'
                  ? 'The current mod files and detected version are now tracked. Your profile selections have been kept.'
                  : mode === 'remove'
                    ? removingMissing
                      ? 'The missing installation entry and its profile references have been removed.'
                      : 'The reviewed mod files and its entries in your profiles have been removed.'
                    : 'Mod files and Lovely have been removed from the reviewed locations. You can start again in Discover.'}
            </p>
            <p>Balatro saves, application settings and editable creator projects were preserved.</p>
            <p>
              {plan?.files.length
                ? 'A recovery copy of the previous records and available files is kept here.'
                : 'A copy of the removed installation records is kept here.'}
            </p>
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
            <p>Close Balatro, then review the selected mod or choose whole-setup recovery.</p>
            {!initialModId && (
              <label className="recovery-mod-picker">
                Choose what to recover
                <select
                  value={modId}
                  disabled={pending}
                  onChange={(event) => {
                    const id = event.target.value;
                    setModId(id);
                    const selected = broken.find((mod) => mod.id === id);
                    void review(
                      id
                        ? selected?.filesMissing
                          ? 'remove'
                          : 'repair'
                        : hasMissing
                          ? 'missing'
                          : 'reset',
                      id,
                    );
                  }}
                >
                  {broken.map((mod) => (
                    <option key={mod.id} value={mod.id}>
                      {mod.title} · {mod.filesMissing ? 'Files missing' : 'Files changed'}
                    </option>
                  ))}
                  <option value="">Whole setup</option>
                </select>
              </label>
            )}
            {initialModId && <h3>{selectedMod?.title ?? 'Selected mod'}</h3>}
            {!!modId && !deleted && (
              <>
                <label className="recovery-choice">
                  <input
                    type="radio"
                    name="setup-recovery-mode"
                    checked={mode === 'repair'}
                    disabled={pending}
                    onChange={() => void review('repair')}
                  />
                  <span>
                    <strong>Adopt updated files</strong>
                    <small>
                      Identify an externally updated mod, review its detected version and track its
                      current files after backup.
                    </small>
                  </span>
                </label>
                <label className="recovery-choice">
                  <input
                    type="radio"
                    name="setup-recovery-mode"
                    checked={mode === 'remove'}
                    disabled={pending}
                    onChange={() => void review('remove')}
                  />
                  <span>
                    <strong>Back up and uninstall one mod</strong>
                    <small>
                      Remove the selected installation entry and its reviewed files, including
                      changed files. Other mods stay installed.
                    </small>
                  </span>
                </label>
              </>
            )}
            {!modId && (
              <>
                {hasMissing && (
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
                        Remove saved entries only when all their managed files are absent. Existing
                        files stay untouched.
                      </small>
                    </span>
                  </label>
                )}
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
              </>
            )}
            {pending && (
              <p role="status">
                <LoaderCircle className="spin" size={16} />{' '}
                {plan
                  ? plan.files.length
                    ? 'Creating verified recovery copies and applying the reviewed changes. Keep Modatro open.'
                    : 'Clearing saved installation entries. Keep Modatro open.'
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
                  {!modId && (
                    <>
                      <div>
                        <dt>Game folder</dt>
                        <dd>{plan.gamePath}</dd>
                      </div>
                      <div>
                        <dt>Mods folder</dt>
                        <dd>{plan.modsPath}</dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>
                      {mode === 'repair'
                        ? 'Installation entries to update'
                        : 'Installation entries to clear'}
                    </dt>
                    <dd>{plan.records.length}</dd>
                  </div>
                  {!!plan.files.length && (
                    <div>
                      <dt>
                        {mode === 'repair'
                          ? 'Files to back up and adopt'
                          : 'Files to back up and remove'}
                      </dt>
                      <dd>
                        {plan.files.length} · {storageSize(plan.sizeBytes)}
                      </dd>
                    </div>
                  )}
                </dl>
                {plan.detectedVersion && (
                  <p>
                    <strong>Detected version {plan.detectedVersion}</strong> · {plan.detectedFolder}
                  </p>
                )}
                {removingMissing && (
                  <p>
                    All recorded files are already missing. Remove this saved entry and its
                    references in profiles.
                  </p>
                )}
                <p>
                  {plan.files.length
                    ? 'A local recovery copy is verified before file changes. Balatro saves and editable creator projects are preserved.'
                    : 'This clears saved installation entries and their profile references. Already-deleted files cannot be recovered.'}
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
                    <summary>
                      {mode === 'repair' ? 'Files to adopt' : 'Files to remove'} (
                      {plan.files.length})
                    </summary>
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
                  <p role="status">
                    Nothing needs clearing in this mode. If a mod still has files, choose Adopt
                    updated files or Back up and uninstall one mod.
                  </p>
                ) : mode === 'reset' || (mode === 'remove' && !removingMissing) ? (
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
                  className={
                    mode === 'reset' || mode === 'remove'
                      ? 'button button-danger'
                      : 'button button-primary'
                  }
                  pending={pending}
                  pendingLabel="Applying recovery…"
                  disabled={
                    ((mode === 'reset' || (mode === 'remove' && !removingMissing)) &&
                      !acknowledged) ||
                    (!plan.records.length && !plan.files.length)
                  }
                  onClick={() => void apply()}
                >
                  {mode === 'reset'
                    ? 'Back up and reset'
                    : mode === 'repair'
                      ? 'Adopt updated files'
                      : mode === 'remove'
                        ? removingMissing
                          ? 'Remove missing entry'
                          : 'Back up and uninstall'
                        : 'Clear missing entries'}
                </AsyncButton>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
