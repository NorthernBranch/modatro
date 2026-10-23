import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ReleaseOptions } from '../shared/model';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';

export function VersionsDialog({
  id,
  close,
  install,
}: {
  id: string;
  close: () => void;
  install: (key?: string) => void;
}) {
  const [options, setOptions] = useState<ReleaseOptions>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState('');
  async function load() {
    setPending(true);
    setFailure(undefined);
    try {
      const result = await api.releaseOptions!(id);
      if (!result.ok) setFailure(result.error.message);
      else {
        setOptions(result.value);
        setSelected(
          result.value.versions.find((version) => version.compatibility === 'compatible')?.key ??
            result.value.versions[0]?.key ??
            '',
        );
      }
    } catch {
      setFailure('Versions could not be checked. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  const version = options?.versions.find((entry) => entry.key === selected);
  return (
    <Dialog title={`Versions and builds${options ? ` · ${options.title}` : ''}`} onClose={close}>
      <p className="dialog-description">
        Choose a published version, or explicitly try an upstream development build. Installed mods
        are checked again before changes are made.
      </p>
      {failure && <p role="alert">{failure}</p>}
      <AsyncButton
        className="text-button"
        pending={pending}
        pendingLabel="Checking versions…"
        onClick={() => void load()}
      >
        Refresh available versions
      </AsyncButton>
      {options && (
        <>
          <p className="muted-text">{options.warning}</p>
          {options.versions.length ? (
            <>
              <label>
                Published version
                <select
                  aria-label="Published version"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {options.versions.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.version} · {entry.source}
                      {entry.compatibility === 'compatible'
                        ? ' · Published requirements fit'
                        : entry.compatibility === 'conflict'
                          ? ' · Conflicting requirements'
                          : ' · Needs inspection'}
                    </option>
                  ))}
                </select>
              </label>
              {version && (
                <p role="status" className="dialog-description">
                  {version.reason}
                </p>
              )}
              <button
                className="button button-primary"
                disabled={pending || !version}
                onClick={() => install(selected)}
              >
                Review selected version
              </button>
            </>
          ) : (
            <p>
              No supported published versions are available from this provider. Unpublished or
              removed builds cannot be downloaded.
            </p>
          )}
          <section className="conflict-item">
            <h3>Optional development build</h3>
            <p>{options.development.reason}</p>
            <p className="muted-text">
              Version metadata cannot prove gameplay compatibility. Development code may be
              unstable; no files change before you confirm the inspected plan.
            </p>
            {options.development.available && (
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={() => install()}
              >
                Try development build
              </button>
            )}
          </section>
        </>
      )}
      <div className="dialog-footer">
        <button className="button button-secondary" onClick={close}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
