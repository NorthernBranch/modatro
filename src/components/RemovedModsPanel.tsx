import { useState } from 'react';
import type { Snapshot } from '../shared/model';
export function RemovedModsPanel({
  warning,
  items,
  working,
  restore,
}: {
  warning?: string;
  items: NonNullable<Snapshot['removedMods']>;
  working: boolean;
  restore: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="info-panel">
      <div>
        {warning && <p role="alert">{warning}</p>}
        <button
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Recently uninstalled · {items.length}
        </button>
        <p>
          The 20 most recent uninstall backups are kept locally. Restore works without the original
          download, and checks recorded requirements before changing files. Restore the required
          dependencies first if they are missing.
        </p>
        {expanded &&
          (items.length ? (
            items.map((item) => (
              <div className="conflict-item" key={item.id}>
                <strong>
                  {item.title} · {item.version}
                </strong>
                <p>Uninstalled {new Date(item.removedAt).toLocaleString()}</p>
                <button
                  className="button button-secondary"
                  disabled={working}
                  onClick={() => restore(item.id)}
                >
                  Review restore
                </button>
              </div>
            ))
          ) : (
            <p>
              No uninstall backups yet. Backups cannot recover mods removed before this feature was
              installed.
            </p>
          ))}
      </div>
    </section>
  );
}
