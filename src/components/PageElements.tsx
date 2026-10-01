import { Layers3, Search, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LocalMod, ModAction, ModDefinition } from '../shared/model';
import { ModArt } from './ModArt';
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
}: {
  local: LocalMod;
  mod?: ModDefinition;
  working: boolean;
  onDetails: (mod: ModDefinition) => void;
  onAction: (action: ModAction, mod?: ModDefinition) => void;
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
              disabled={working || local.state === 'broken'}
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
      </div>
    </article>
  );
}
export function PaletteIcon() {
  return <Sparkles size={19} />;
}
