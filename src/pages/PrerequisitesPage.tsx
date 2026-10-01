import { Info, PackageCheck, RefreshCw } from 'lucide-react';
import { AsyncButton } from '../components/AsyncButton';
import { PrerequisiteAction } from '../components/PrerequisiteAction';
import type { Requests } from '../hooks/useRequests';
import { PageHeading } from '../components/PageElements';
import type { ModAction, ModDefinition, Snapshot } from '../shared/model';
import { isNewer } from '../shared/presentation';
import { cleanVersion } from '../shared/dependencies';

interface Props {
  snapshot?: Snapshot;
  refreshing: boolean;
  refresh: () => Promise<void>;
  review: (mod: ModDefinition) => void;
  requestAction: (id: string, action: ModAction, title: string, mod?: ModDefinition) => void;
  requests: Requests;
  openLink: (url: string) => Promise<void>;
}
export function PrerequisitesPage({
  snapshot,
  refreshing,
  refresh,
  review,
  requestAction,
  requests,
  openLink,
}: Props) {
  return (
    <>
      <PageHeading
        eyebrow="THE FOUNDATION"
        title="A little setup. A lot more game."
        description="Everything your mods need, with nothing left to guess."
      />
      {snapshot && (
        <div className="prerequisites-grid">
          {snapshot.prerequisites
            .filter((p) => ['Lovely', 'Steamodded', 'Talisman'].includes(p.id))
            .map((prerequisite, index) => {
              const update = isNewer(prerequisite.installedVersion, prerequisite.latestVersion);
              const unknown =
                prerequisite.installed &&
                (!cleanVersion(prerequisite.installedVersion) ||
                  !cleanVersion(prerequisite.latestVersion) ||
                  !!prerequisite.latestError);
              return (
                <article className="prerequisite-card" key={prerequisite.id}>
                  <div className={`prerequisite-icon prerequisite-${index}`}>
                    <PackageCheck size={25} />
                  </div>
                  <div className="prerequisite-heading">
                    <h2>{prerequisite.displayName}</h2>
                    <span
                      className={`state-badge ${prerequisite.installed ? (update ? 'update' : unknown ? 'missing' : 'ready') : 'missing'}`}
                    >
                      {prerequisite.installed
                        ? update
                          ? '↑ Update available'
                          : unknown
                            ? 'Unable to determine'
                            : '✓ Ready'
                        : prerequisite.id === 'Talisman'
                          ? '○ Optional'
                          : '× Missing'}
                    </span>
                  </div>
                  <p>
                    {index === 0
                      ? 'The runtime injector that brings Lovely patches to your game.'
                      : index === 1
                        ? 'The modding framework behind a world of new Balatro content.'
                        : 'Big-number support for mods that push your score a little further.'}
                  </p>
                  <dl className="version-facts">
                    <div>
                      <dt>Installed version</dt>
                      <dd>
                        {prerequisite.installed
                          ? (prerequisite.installedVersion ?? 'Version unknown')
                          : 'Not installed'}
                      </dd>
                    </div>
                    <div>
                      <dt>Latest version</dt>
                      <dd aria-busy={refreshing || undefined}>
                        {refreshing
                          ? 'Checking…'
                          : (prerequisite.latestVersion ??
                            prerequisite.latestError ??
                            'Not checked yet')}
                      </dd>
                    </div>
                  </dl>
                  {prerequisite.latestError && (
                    <p role="status" className="muted-text">
                      {prerequisite.latestError}.{' '}
                      {prerequisite.latestVersion
                        ? 'Showing the last known release.'
                        : 'Installed status is preserved.'}
                    </p>
                  )}
                  {prerequisite.instructions && (
                    <details>
                      <summary>Installation instructions</summary>
                      <p>{prerequisite.instructions}</p>
                    </details>
                  )}
                  <div className="prerequisite-actions">
                    <PrerequisiteAction
                      requirement={{
                        id: prerequisite.id,
                        displayName: prerequisite.displayName,
                        required: true,
                        versionConstraint: update ? `>=${prerequisite.latestVersion}` : undefined,
                      }}
                      snapshot={snapshot}
                      requests={requests}
                      requestAction={requestAction}
                      review={review}
                      openLink={openLink}
                    />
                    {prerequisite.installed && !update && (
                      <AsyncButton
                        className="text-button"
                        pending={requests.isPending(`link:${prerequisite.sourceUrl}`)}
                        pendingLabel="Opening…"
                        disabled={requests.isBusy('external-link')}
                        onClick={() => void openLink(prerequisite.sourceUrl)}
                      >
                        Open project
                      </AsyncButton>
                    )}
                  </div>
                </article>
              );
            })}
        </div>
      )}
      <div className="info-panel">
        <Info size={20} />
        <div>
          <strong>Installed doesn’t always mean compatible</strong>
          <p>
            Each mod’s requirements are checked separately. If a mod doesn’t specify a version,
            Modatro won’t invent one. Required dependencies found in an archive are checked again
            before any files change.
          </p>
        </div>
      </div>
      <AsyncButton
        className="button button-secondary"
        onClick={() => void refresh()}
        pending={refreshing}
        pendingLabel="Checking prerequisites…"
      >
        <RefreshCw size={15} />
        Check prerequisites again
      </AsyncButton>
    </>
  );
}
