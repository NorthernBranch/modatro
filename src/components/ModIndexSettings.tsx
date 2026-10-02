import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import type { Reply, Snapshot } from '../shared/model';
import type { Requests } from '../hooks/useRequests';
import { AsyncButton } from './AsyncButton';

export function ModIndexSettings({
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
  const [url, setUrl] = useState(snapshot.settings.modIndexUrl ?? '');
  const inputId = useId();
  useEffect(() => setUrl(snapshot.settings.modIndexUrl ?? ''), [snapshot.settings.modIndexUrl]);
  return (
    <div className="mod-index-settings">
      <label htmlFor={inputId}>Additional mod index (optional)</label>
      <p className="muted-text">
        Paste the GitHub repository URL of a Balatro mod index. Thunderstore takes priority for
        duplicates. Leave blank to use Thunderstore alone.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void callSnapshot('settings:index', 'Saving additional mod index', () =>
            api.saveSettings({
              theme: snapshot.settings.theme,
              setupComplete: snapshot.settings.setupComplete,
              modIndexUrl: url,
            }),
          );
        }}
      >
        <input
          id={inputId}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/owner/balatro-mod-index"
          disabled={snapshot.preview || requests.isBusy('configuration')}
        />
        <AsyncButton
          type="submit"
          className="button button-secondary"
          pending={requests.isPending('settings:index')}
          pendingLabel="Loading index…"
          disabled={
            snapshot.preview ||
            requests.isBusy('configuration') ||
            url === (snapshot.settings.modIndexUrl ?? '')
          }
        >
          {url.trim() ? 'Save index' : 'Remove index'}
        </AsyncButton>
      </form>
      {snapshot.settings.modIndexUrl && (
        <p className="muted-text">Configured index: {snapshot.settings.modIndexUrl}</p>
      )}
      {snapshot.catalogue.error
        ?.split('\n')
        .filter((message) => message.startsWith('Additional index:'))
        .map((message) => (
          <p key={message} role="status">
            {message}
          </p>
        ))}
    </div>
  );
}
