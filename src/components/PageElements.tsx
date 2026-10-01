import { Layers3, Search, Sparkles, FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LocalMod, ModAction, ModDefinition } from '../shared/model';
import { ModArt } from './ModArt';
import { AsyncButton } from './AsyncButton';
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  busy = false,
}: {
  icon: typeof Search;
  title: string;
  description: string;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="empty-state" aria-busy={busy || undefined} role={busy ? 'status' : undefined}>
      <div className="empty-icon">
        <Icon size={29} strokeWidth={1.4} className={busy ? 'spin' : undefined} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-row-actions">{children}</div>
    </div>
  );
}
export function LocalRow({
  local,
  mod,
  working,
  onDetails,
  onAction,
  onOpenFolder,
  onOpenProject,
  folderPending,
  projectPending,
}: {
  local: LocalMod;
  mod?: ModDefinition;
  working: boolean;
  onDetails: (mod: ModDefinition) => void;
  onAction: (action: ModAction, mod?: ModDefinition) => void;
  onOpenFolder?: () => void;
  onOpenProject?: (url: string) => void;
  folderPending?: boolean;
  projectPending?: boolean;
}) {
  return (
    <article className="local-row">
      {mod ? (
        <ModArt mod={mod} />
      ) : (
        <div className="external-mod-icon">
          <Layers3 size={24} />
        </div>
      )}
      <div className="local-row-info">
        <button className="local-title" disabled={!mod} onClick={() => mod && onDetails(mod)}>
          {local.title}
        </button>
        <p>
          {local.version ? `Installed ${local.version}` : 'Version unknown'}
          {local.state === 'update-available' && mod ? ` → Latest ${mod.version}` : ''}
          <span>·</span>
          {local.managed ? 'Managed by Modatro' : 'Installed externally'}
        </p>
        {local.availabilityReason && <p className="muted-text">{local.availabilityReason}</p>}
        {local.releaseWarning && <p role="status">{local.releaseWarning}</p>}
        {local.managed && (
          <details>
            <summary>Source and file record</summary>
            <p>
              Source:{' '}
              {local.provenance?.sourceType === 'external'
                ? 'Installed externally; adopted by Modatro'
                : !local.provenance || local.provenance.sourceType === 'legacy'
                  ? 'Legacy installation'
                  : local.provenance.sourceType}
            </p>
            {local.provenance?.downloadUrl && <p>Download: {local.provenance.downloadUrl}</p>}
            {local.provenance?.releaseTag && <p>Release: {local.provenance.releaseTag}</p>}
            {local.provenance?.commitSha && <p>Commit: {local.provenance.commitSha}</p>}
            {local.provenance?.downloadedAt && (
              <p>Downloaded: {new Date(local.provenance.downloadedAt).toLocaleString()}</p>
            )}
            <p>
              Archive SHA-256: <code>{local.provenance?.sha256 ?? 'Not recorded'}</code>
            </p>
            {local.files && (
              <>
                <p>
                  Recorded files:{' '}
                  {local.files.filter((file) => file.operation === 'created').length} created;{' '}
                  {local.files.filter((file) => file.operation === 'replaced').length} replaced.
                </p>
                <ul>
                  {local.files.map((file) => (
                    <li key={`${file.root}:${file.path}`}>
                      <code>
                        {file.root}/{file.path}
                      </code>{' '}
                      · {file.operation}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}
        {local.problems.length > 0 && (
          <details>
            <summary>
              {local.problems.length} file {local.problems.length === 1 ? 'needs' : 'need'}{' '}
              attention
            </summary>
            <ul>
              {local.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <span
        className={`state-badge ${local.state === 'update-available' ? 'update' : local.state === 'broken' ? 'missing' : local.state === 'disabled' || !local.managed ? '' : 'ready'}`}
      >
        {
          {
            installed: '✓ Installed',
            'update-available': '↑ Update available',
            disabled: '○ Disabled',
            broken: '! Check files',
            unmanaged: 'External',
            'not-installed': 'Not installed',
            installing: 'Installing',
            updating: 'Updating',
          }[local.state]
        }
      </span>
      <div className="local-actions">
        {local.managed ? (
          <>
            <button
              className="button button-secondary"
              disabled={
                working ||
                local.state === 'broken' ||
                (local.state !== 'update-available' &&
                  local.state !== 'disabled' &&
                  local.canDisable === false)
              }
              onClick={() =>
                onAction(
                  local.state === 'update-available'
                    ? 'update'
                    : local.state === 'disabled'
                      ? 'enable'
                      : 'disable',
                  mod,
                )
              }
            >
              {local.state === 'update-available'
                ? 'Update'
                : local.state === 'disabled'
                  ? 'Enable'
                  : 'Disable'}
            </button>
            <button
              className="text-button uninstall-button"
              disabled={working}
              onClick={() => onAction('uninstall')}
            >
              Uninstall
            </button>
          </>
        ) : local.canAdopt ? (
          <button
            className="button button-secondary"
            disabled={working}
            onClick={() => onAction('adopt')}
          >
            Adopt into Modatro
          </button>
        ) : (
          <span className="muted-text">Managed externally</span>
        )}
        {onOpenFolder && (
          <AsyncButton
            className="text-button"
            disabled={working}
            pending={folderPending}
            pendingLabel="Opening folder…"
            onClick={onOpenFolder}
          >
            <FolderOpen size={14} />
            Open mod folder
          </AsyncButton>
        )}
        {local.repositoryUrl && onOpenProject && (
          <AsyncButton
            className="text-button"
            pending={projectPending}
            pendingLabel="Opening…"
            onClick={() => onOpenProject(local.repositoryUrl!)}
          >
            Open project page
          </AsyncButton>
        )}
      </div>
    </article>
  );
}
export function PaletteIcon() {
  return <Sparkles size={19} />;
}
