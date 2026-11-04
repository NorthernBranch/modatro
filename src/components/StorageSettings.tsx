import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api } from '../api';
import type {
  StorageMaintenanceRequest,
  StorageMaintenanceStatus,
} from '../shared/storage-maintenance';
import { storageSize } from '../shared/presentation';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';

export function StorageSettings() {
  const [status, setStatus] = useState<StorageMaintenanceStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  async function run(request: StorageMaintenanceRequest) {
    if (!api.storageMaintenance || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const reply = await api.storageMaintenance(request);
      if (reply.ok) {
        setStatus(reply.value);
        return true;
      }
      setError(reply.error.message);
    } catch {
      setError(
        'Storage checks could not finish. Try again when the current operation has finished.',
      );
    } finally {
      setPending(false);
    }
    return false;
  }
  return (
    <details
      className="settings-section advanced-settings"
      onToggle={(event) => {
        if (event.currentTarget.open && !status && !pending) void run({ operation: 'inspect' });
      }}
    >
      <summary>
        Storage and recovery copies <ChevronRight size={16} aria-hidden="true" />
      </summary>
      <p>
        Modatro removes completed transaction backups and abandoned temporary files. Logs keep five
        rotated files and the current log. Uninstall recovery is managed in Installed → Recently
        uninstalled.
      </p>
      <p>
        Setup recovery aims to keep at most 20 copies within 1 GiB, oldest first. The newest copy is
        kept even if it exceeds that target. Required originals and incomplete copies are retained.
        Creator projects, artwork and build history are kept until you manage them yourself.
      </p>
      {!api.storageMaintenance && <p>Storage controls are available in the desktop app.</p>}
      <div className="feature-actions">
        <AsyncButton
          className="button button-secondary"
          pending={pending}
          pendingLabel="Checking storage…"
          disabled={!api.storageMaintenance}
          onClick={() => run({ operation: 'clean' })}
        >
          Clean up eligible files
        </AsyncButton>
        <button
          className="text-button"
          disabled={pending || !status?.snapshots.some((item) => !item.protected)}
          onClick={() => setDeleting('all')}
        >
          Clear setup recovery copies
        </button>
      </div>
      {pending && <p role="status">Checking recovery copies…</p>}
      {error && <p role="alert">{error}</p>}
      {status && (
        <>
          <p className="numeric-value">
            {storageSize(status.sizeBytes)} in {status.snapshots.length} checked setup recovery{' '}
            {status.snapshots.length === 1 ? 'copy' : 'copies'}.
          </p>
          {status.warnings.map((warning) => (
            <p role="status" key={warning}>
              {warning}
            </p>
          ))}
          {!status.snapshots.length && (
            <p>
              No checked setup recovery copies. Any copies that could not be checked are retained.
            </p>
          )}
          <div className="storage-backups">
            {[...status.snapshots].reverse().map((item) => (
              <article key={item.id}>
                <strong>
                  {item.mode === 'reset'
                    ? 'Setup reset'
                    : item.mode === 'repair'
                      ? 'Updated files'
                      : 'Installation records'}
                </strong>
                <p className="numeric-value">
                  {new Date(item.createdAt).toLocaleString()} · {storageSize(item.sizeBytes)}
                </p>
                {item.protected && <p>Contains original files still required for recovery.</p>}
                {!item.complete && (
                  <p>
                    Retained for manual review. This copy predates automatic retention or its
                    operation did not finish.
                  </p>
                )}
                <button
                  className="button button-secondary"
                  disabled={pending || item.protected}
                  onClick={() => setDeleting(item.id)}
                >
                  Delete recovery copy
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {deleting && (
        <Dialog
          title="Delete setup recovery copies?"
          dismissible={!pending}
          onClose={() => setDeleting(undefined)}
        >
          <p>
            Recovery from the deleted {deleting === 'all' ? 'copies' : 'copy'} will no longer be
            available. Required originals and copies that cannot be checked will be retained.
          </p>
          <div className="dialog-footer">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </button>
            <AsyncButton
              className="button button-danger"
              pending={pending}
              pendingLabel="Deleting…"
              onClick={async () => {
                if (await run({ operation: 'delete', id: deleting })) setDeleting(undefined);
              }}
            >
              Delete recovery {deleting === 'all' ? 'copies' : 'copy'}
            </AsyncButton>
          </div>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </details>
  );
}
