import type { DependencyRequirement, ModAction, ModDefinition, Snapshot } from '../shared/model';
import { evaluateDependency, externalLoaderRequirement, hasUpdate } from '../shared/dependencies';
import { eligibility } from '../shared/presentation';
import { AsyncButton } from './AsyncButton';
import type { Requests } from '../hooks/useRequests';

interface Props {
  requirement: DependencyRequirement;
  snapshot: Snapshot;
  requests: Requests;
  requestAction: (id: string, action: ModAction, title: string, mod?: ModDefinition) => void;
  review: (mod: ModDefinition) => void;
  openLink: (url: string) => Promise<void>;
}
export function PrerequisiteAction({
  requirement,
  snapshot,
  requests,
  requestAction,
  review,
  openLink,
}: Props) {
  const prerequisite =
    snapshot.prerequisites.find((p) =>
      requirement.packageId
        ? p.packageId === requirement.packageId
        : p.id.toLowerCase() === requirement.id.toLowerCase(),
    ) ??
    (externalLoaderRequirement(requirement)
      ? snapshot.prerequisites.find(
          (p) => !p.packageId && p.id.toLowerCase() === requirement.id.toLowerCase(),
        )
      : undefined);
  const matches = snapshot.catalogue.mods.filter((mod) =>
    requirement.packageId
      ? !!mod.source && mod.source.externalId.toLowerCase() === requirement.packageId.toLowerCase()
      : mod.title.toLowerCase() === requirement.id.toLowerCase() ||
        (mod.metadataId ?? mod.id.split(/[@/]/).pop())?.toLowerCase() ===
          requirement.id.toLowerCase(),
  );
  const mod = matches.length === 1 ? matches[0] : undefined;
  const status = evaluateDependency(requirement, snapshot.prerequisites);
  const busy = requests.isBusy('configuration');
  if (snapshot.preview) return null;
  if (requirement.id.toLowerCase() === 'lovely' && externalLoaderRequirement(requirement)) {
    const managed = snapshot.localMods.find(
      (entry) => entry.managed && (entry.metadataId === 'Lovely' || entry.id === 'Lovely'),
    );
    const update =
      managed &&
      (hasUpdate(prerequisite?.installedVersion ?? '', prerequisite?.latestVersion ?? '') ||
        status.state === 'outdated');
    const actionable =
      ['win32', 'linux', 'darwin'].includes(snapshot.platform) && (!managed || update);
    return (
      <>
        {actionable && (
          <AsyncButton
            className="button button-primary"
            pending={requests.isPending('mod-action')}
            pendingLabel="Preparing Lovely…"
            disabled={
              busy ||
              !snapshot.validation?.valid ||
              !!snapshot.safetyError ||
              snapshot.trust?.fresh === false
            }
            onClick={() =>
              requestAction('prerequisite:Lovely', managed ? 'update' : 'install', 'Lovely')
            }
          >
            {managed
              ? 'Update Lovely'
              : prerequisite?.installed
                ? 'Manage Lovely'
                : 'Install Lovely'}
          </AsyncButton>
        )}
        <AsyncButton
          className="button button-secondary"
          pending={requests.isPending('link:https://github.com/ethangreen-dev/lovely-injector')}
          pendingLabel="Opening instructions…"
          disabled={requests.isBusy('external-link')}
          onClick={() => void openLink('https://github.com/ethangreen-dev/lovely-injector')}
        >
          Lovely instructions
        </AsyncButton>
      </>
    );
  }
  if (mod && !mod.unavailableReason && mod.installation.type !== 'unsupported') {
    const local = snapshot.localMods.find((entry) => entry.managed && entry.id === mod.id);
    const external = snapshot.localMods.filter(
      (entry) => !entry.managed && entry.canAdopt && entry.catalogueId === mod.id,
    );
    if (prerequisite?.installed && !local && external.length === 1)
      return (
        <button
          className="button button-secondary"
          disabled={busy || !!snapshot.safetyError}
          onClick={() => requestAction(external[0]!.id, 'adopt', external[0]!.title)}
        >
          Adopt {requirement.displayName} to manage updates
        </button>
      );
    const candidateStatus = evaluateDependency(requirement, [
      {
        id: requirement.id,
        displayName: requirement.displayName,
        installed: true,
        installedVersion:
          mod.source?.provider === 'thunderstore' && !requirement.packageId
            ? undefined
            : mod.version,
        packageId: mod.source?.externalId,
        packageVersion: mod.source?.provider === 'thunderstore' ? mod.version : undefined,
        sourceUrl: mod.repositoryUrl ?? mod.downloadUrl,
      },
    ]);
    const canInstall = !prerequisite?.installed && !local;
    const canUpdate =
      local && prerequisite?.installed && hasUpdate(local.version ?? '', mod.version);
    if (
      (canInstall || canUpdate) &&
      (candidateStatus.state === 'satisfied' ||
        (mod.source?.provider === 'thunderstore' && candidateStatus.state === 'unknown'))
    ) {
      const reason = eligibility(mod, snapshot);
      return (
        <>
          <AsyncButton
            className="button button-primary"
            pending={requests.isPending('mod-action')}
            pendingLabel={`Installing ${requirement.displayName}…`}
            disabled={busy || !!snapshot.safetyError}
            onClick={() =>
              reason
                ? review(mod)
                : requestAction(mod.id, canUpdate ? 'update' : 'install', mod.title, mod)
            }
          >
            {reason
              ? `Review ${requirement.displayName} requirements`
              : `${canUpdate ? 'Update' : 'Install'} ${requirement.displayName}`}
          </AsyncButton>
          {!reason && mod.prerequisites.some((entry) => entry.required) && (
            <button className="button button-secondary" disabled={busy} onClick={() => review(mod)}>
              Review {requirement.displayName} requirements
            </button>
          )}
        </>
      );
    }
    if (local?.state === 'disabled')
      return (
        <button
          className="button button-primary"
          disabled={busy || !!snapshot.safetyError}
          onClick={() => requestAction(local.id, 'enable', local.title)}
        >
          Enable {requirement.displayName}
        </button>
      );
  }
  const url = prerequisite?.sourceUrl ?? mod?.repositoryUrl;
  if (!url || status.state === 'satisfied') return null;
  return (
    <AsyncButton
      className="button button-secondary"
      pending={requests.isPending(`link:${url}`)}
      pendingLabel="Opening instructions…"
      disabled={requests.isBusy('external-link')}
      onClick={() => void openLink(url)}
    >
      {requirement.displayName} instructions
    </AsyncButton>
  );
}
