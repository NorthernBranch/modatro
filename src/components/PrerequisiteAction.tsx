import type { DependencyRequirement, ModAction, ModDefinition, Snapshot } from '../shared/model';
import { evaluateDependency, hasUpdate } from '../shared/dependencies';
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
  const prerequisite = snapshot.prerequisites.find(
    (p) => p.id.toLowerCase() === requirement.id.toLowerCase(),
  );
  const matches = snapshot.catalogue.mods.filter(
    (mod) =>
      mod.title.toLowerCase() === requirement.id.toLowerCase() ||
      (mod.metadataId ?? mod.id.split(/[@/]/).pop())?.toLowerCase() ===
        requirement.id.toLowerCase(),
  );
  const mod = matches.length === 1 ? matches[0] : undefined;
  const status = evaluateDependency(requirement, snapshot.prerequisites);
  const busy = requests.isBusy('configuration');
  if (snapshot.preview) return null;
  if (
    requirement.id === 'Lovely' &&
    ['win32', 'linux'].includes(snapshot.platform) &&
    (!prerequisite?.installed ||
      snapshot.localMods.some((mod) => mod.managed && mod.id === 'Lovely'))
  )
    return (
      <AsyncButton
        className="button button-primary"
        pending={requests.isPending('mod-action')}
        pendingLabel="Installing Lovely…"
        disabled={
          busy ||
          !snapshot.validation?.valid ||
          !!snapshot.safetyError ||
          snapshot.trust?.fresh === false
        }
        onClick={() =>
          requestAction(
            'prerequisite:Lovely',
            prerequisite?.installed ? 'update' : 'install',
            'Lovely',
          )
        }
      >
        {prerequisite?.installed ? 'Update Lovely' : 'Install Lovely'}
      </AsyncButton>
    );
  if (mod && !mod.unavailableReason && mod.installation.type !== 'unsupported') {
    const local = snapshot.localMods.find((entry) => entry.managed && entry.id === mod.id);
    const external = snapshot.localMods.filter(
      (entry) =>
        !entry.managed && entry.canAdopt && entry.title.toLowerCase() === mod.title.toLowerCase(),
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
        installedVersion: mod.version,
        sourceUrl: mod.repositoryUrl ?? mod.downloadUrl,
      },
    ]);
    const canInstall = !prerequisite?.installed && !local;
    const canUpdate =
      local && prerequisite?.installed && hasUpdate(local.version ?? '', mod.version);
    if ((canInstall || canUpdate) && candidateStatus.state === 'satisfied') {
      const reason = eligibility(mod, snapshot);
      return (
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
