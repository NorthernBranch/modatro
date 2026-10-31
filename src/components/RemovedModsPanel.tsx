import { useState } from 'react';
import type { Snapshot } from '../shared/model';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';
import { storageSize } from '../shared/presentation';
export function RemovedModsPanel({
  warning,
  items,
  working,
  restore,
  storage,
  pending,
  deleteBackup,
  refresh,
}: {
  warning?: string;
  items: NonNullable<Snapshot['removedMods']>;
  working: boolean;
  restore: (id: string) => void;
  storage?: Snapshot['removedModsStorage'];
  pending?: boolean;
  deleteBackup?: (id?: string) => Promise<void>;
  refresh?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState<{ id?: string; title: string }>();
  const count = storage?.count ?? items.length;
  return (
    <section className="info-panel" aria-label="Uninstall backups">
      <div>
        <button
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Recently uninstalled · {count}
        </button>
        <p>
          Recovery copies are temporary and subject to automatic cleanup. Modatro keeps up to 20
          backups within 1 GiB, removing the oldest eligible copies first. Required originals are
          preserved. Restore checks recorded requirements; install missing dependencies first.
        </p>
        <p>
          {storage?.sizeIncomplete ? 'At least ' : ''}
          {storage ? storageSize(storage.sizeBytes) : 'Storage unavailable'} used · 1 GiB limit
        </p>
        {warning && <p role="alert">{warning}</p>}
        {expanded && (
          <div className="feature-actions">
            {refresh && (
              <button className="button button-secondary" disabled={working} onClick={refresh}>
                Refresh backups
              </button>
            )}
            {deleteBackup && (
              <button
                className="button button-secondary"
                disabled={working || !count}
                onClick={() => setDeleting({ title: 'all eligible uninstall backups' })}
              >
                Clear all
              </button>
            )}
          </div>
        )}
        {pending && <p role="status">Deleting uninstall backups…</p>}
        {expanded &&
          (items.length ? (
            items.map((item) => (
              <div className="conflict-item" key={item.id}>
                <strong>
                  {item.title} · {item.version}
                </strong>
                <p>
                  Uninstalled {new Date(item.removedAt).toLocaleString()} ·{' '}
                  {item.sizeBytes === undefined ? 'Size unavailable' : storageSize(item.sizeBytes)}
                </p>
                {item.protected && <p>Protected from deletion. See the storage notice above.</p>}
                <div className="feature-actions">
                  <button
                    className="button button-secondary"
                    disabled={working || item.installed}
                    onClick={() => restore(item.id)}
                  >
                    {item.installed ? 'Already installed' : 'Review restore'}
                  </button>
                  {deleteBackup && (
                    <button
                      className="button button-secondary"
                      disabled={working || item.protected}
                      onClick={() => setDeleting({ id: item.id, title: item.title })}
                    >
                      Delete backup
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p>
              {count
                ? 'No verified uninstall backups are available to restore. Retained records are included in the storage total; see the warning above.'
                : 'No uninstall backups. Mods removed before this feature was installed cannot be recovered here.'}
            </p>
          ))}
      </div>
      {deleting && (
        <Dialog
          title={deleting.id ? 'Delete uninstall backup?' : 'Clear uninstall backups?'}
          dismissible={!pending}
          onClose={() => setDeleting(undefined)}
        >
          <p>
            Delete {deleting.title}? Recovery from the deleted {deleting.id ? 'copy' : 'copies'}{' '}
            will no longer be available. Installed mods are unaffected.
          </p>
          <p>
            Originals still required by installations or recovery records, and records that cannot
            be verified, will be retained.
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
              pendingLabel="Deleting backups…"
              disabled={working && !pending}
              onClick={async () => {
                await deleteBackup!(deleting.id);
                setDeleting(undefined);
              }}
            >
              {deleting.id ? 'Delete backup' : 'Clear all eligible backups'}
            </AsyncButton>
          </div>
        </Dialog>
      )}
    </section>
  );
}
