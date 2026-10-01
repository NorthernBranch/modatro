import {
  ArrowUpRight,
  Layers3,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { AsyncButton } from '../components/AsyncButton';
import { EmptyState, LocalRow, PageHeading } from '../components/PageElements';
import type { LocalMod, ModAction, ModDefinition } from '../shared/model';

interface Props {
  page: 'installed' | 'updates';
  installed: LocalMod[];
  updates: LocalMod[];
  mods: ModDefinition[];
  working: boolean;
  refreshing: boolean;
  catalogueStale: boolean;
  refresh: () => Promise<void>;
  setSelected: Dispatch<SetStateAction<ModDefinition | undefined>>;
  requestAction: (id: string, action: ModAction, title: string, mod?: ModDefinition) => void;
  setPage: (page: 'discover') => void;
}
export function InstalledPage({
  page,
  installed,
  updates,
  mods,
  working,
  refreshing,
  catalogueStale,
  refresh,
  setSelected,
  requestAction,
  setPage,
}: Props) {
  return (
    <>
      <PageHeading
        eyebrow="YOUR COLLECTION"
        title={page === 'installed' ? 'Your mods, all together.' : 'Keep your next run fresh.'}
        description={
          page === 'installed'
            ? 'Manage your collection. Keep the good stuff. Try something new.'
            : 'New versions, with the same care for your game files.'
        }
        action={
          <AsyncButton
            className="button button-secondary"
            onClick={() => void refresh()}
            pending={refreshing}
            pendingLabel="Checking for updates…"
          >
            <RefreshCw size={15} />
            Check for updates
          </AsyncButton>
        }
      />
      {(page === 'installed' ? installed : updates).length ? (
        <div className="installed-list">
          {(page === 'installed' ? installed : updates).map((local) => (
            <LocalRow
              key={local.id}
              local={local}
              mod={mods.find((m) => m.id === local.id)}
              working={working}
              onDetails={(mod) => setSelected(mod)}
              onAction={(action, mod) => requestAction(local.id, action, local.title, mod)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={page === 'installed' ? Layers3 : refreshing ? LoaderCircle : PackageCheck}
          busy={page === 'updates' && refreshing}
          title={
            page === 'installed'
              ? 'A fresh deck. Endless possibilities.'
              : refreshing
                ? 'Checking for updates…'
                : catalogueStale
                  ? 'Refresh to check for updates'
                  : 'You’re all caught up.'
          }
          description={
            page === 'installed'
              ? 'Installed mods will appear here. Find something you love in Discover.'
              : refreshing
                ? 'Checking the catalogue and prerequisites for new versions.'
                : catalogueStale
                  ? 'The catalogue has not been refreshed successfully. Check again when your connection is available.'
                  : 'Updates for your managed mods will appear here after a catalogue refresh. Nonstandard versions are never guessed.'
          }
          action={
            <button className="button button-primary" onClick={() => setPage('discover')}>
              Discover mods
              <ArrowUpRight size={16} />
            </button>
          }
        />
      )}
      <div className="info-panel">
        <ShieldCheck size={20} />
        <div>
          <strong>
            {page === 'installed'
              ? 'A safe place for your collection'
              : 'Every update has a way back'}
          </strong>
          <p>
            {page === 'installed'
              ? 'Managed mods have a file-by-file record. Externally installed mods stay yours until you choose to adopt them.'
              : 'Updates are staged and checked before installation. If a commit fails, Modatro restores the previous files.'}
          </p>
        </div>
      </div>
    </>
  );
}
