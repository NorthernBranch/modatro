import { useId, useState } from 'react';
import { Plus, Minus, ShieldCheck, Info, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import type { Snapshot } from '../shared/model';
import type { ProfileOperation, ProfilePlan } from '../shared/features';
import type { Requests } from '../hooks/useRequests';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import { ProfileTransfer } from './ProfileTransfer';

export function ProfileControls({
  snapshot,
  requests,
  changed,
  open,
  setOpen,
  prerequisites,
  installed,
}: {
  snapshot: Snapshot;
  requests: Requests;
  changed: (s: Snapshot) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  prerequisites: () => void;
  installed: () => void;
}) {
  const [plan, setPlan] = useState<ProfilePlan>();
  const [transfer, setTransfer] = useState<{ exportId?: string }>();
  const [editing, setEditing] = useState<{
    operation: 'create' | 'rename' | 'duplicate' | 'delete';
    id?: string;
  }>();
  const [name, setName] = useState('');
  const [preserve, setPreserve] = useState(false);
  const fieldId = useId();
  const profiles = snapshot.profiles;
  if (!profiles || !api.profileOperation) return null;
  const active = profiles.items.find((p) => p.id === profiles.activeId)!;
  const busy = requests.isBusy('configuration');
  const switching = requests.isPending('profile-switch');
  async function operation(request: ProfileOperation) {
    const reply = await requests.run(
      'profile-operation',
      'Saving profile',
      () => api.profileOperation!(request),
      { group: 'configuration' },
    );
    if (reply?.ok) {
      changed(reply.value);
      setEditing(undefined);
    }
  }
  async function preview(id: string) {
    const reply = await requests.run(
      'profile-preview',
      'Checking profile selection',
      () => api.previewProfile!(id),
      { group: 'configuration' },
    );
    if (reply?.ok) {
      setOpen(false);
      setPlan(reply.value);
    }
  }
  function edit(operation: 'create' | 'rename' | 'duplicate' | 'delete', id?: string) {
    setEditing({ operation, id });
    setName(operation === 'rename' ? profiles!.items.find((p) => p.id === id)!.name : '');
    setPreserve(false);
  }
  return (
    <>
      <div className="profile-control">
        <label htmlFor={`${fieldId}-selector`}>Profile</label>
        <select
          id={`${fieldId}-selector`}
          aria-label="Profile"
          value={active.id}
          disabled={busy || !!snapshot.safetyError}
          onChange={(event) => void preview(event.target.value)}
        >
          {profiles.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="text-button" onClick={() => setOpen(true)}>
          Manage profiles
        </button>
        {profiles.unsaved && <span className="profile-unsaved">Unsaved changes</span>}
      </div>
      {open && (
        <Dialog
          title="Mod profiles"
          onClose={() => {
            setOpen(false);
            setEditing(undefined);
          }}
          wide
        >
          <div className="profile-management">
            <p>
              Profiles select managed mods. Versions and configurations are shared; updating a mod
              affects every profile. Profiles do not change Balatro save slots.
            </p>
            <p>
              Unmanaged mods remain untouched and may affect gameplay. Shared Lovely game files
              remain installed.
            </p>
            <div className="profile-summary">
              <strong>Active: {active.name}</strong>
              <span>{profiles.unsaved ? 'Unsaved changes' : 'Saved selection'}</span>
            </div>
            {profiles.unsaved && (
              <>
                <p>
                  Selection differences: {profiles.differences.join(', ')}. Missing mods will not be
                  automatically reinstalled.
                </p>
                <div className="feature-actions">
                  <AsyncButton
                    className="button button-primary"
                    pending={requests.isPending('profile-operation')}
                    disabled={busy}
                    onClick={() => void operation({ operation: 'save', id: active.id })}
                  >
                    Save to profile
                  </AsyncButton>
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => edit('create')}
                  >
                    Save as new profile
                  </button>
                  <AsyncButton
                    className="button button-primary"
                    pending={requests.isPending('profile-preview')}
                    disabled={busy}
                    onClick={() => void preview(active.id)}
                  >
                    Revert to saved selection
                  </AsyncButton>
                </div>
              </>
            )}
            <div className="profile-list">
              {profiles.items.map((p) => (
                <div className="profile-row" key={p.id}>
                  <div>
                    <strong>
                      {p.name}
                      {p.id === active.id ? ' · Active' : ''}
                    </strong>
                    <small>
                      {p.selection.filter((e) => e.enabled).length} enabled ·{' '}
                      {p.selection.filter((e) => !e.enabled).length} disabled
                    </small>
                  </div>
                  <div className="feature-actions">
                    <button
                      className="text-button"
                      disabled={busy || !api.profileTransfer || snapshot.preview}
                      aria-label={`Export ${p.name}`}
                      onClick={() => {
                        setOpen(false);
                        setTransfer({ exportId: p.id });
                      }}
                    >
                      Export
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void preview(p.id)}
                      aria-label={`Review switch to ${p.name}`}
                    >
                      Review switch
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit('rename', p.id)}
                      aria-label={`Rename ${p.name}`}
                    >
                      Rename
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit('duplicate', p.id)}
                      aria-label={`Duplicate ${p.name}`}
                    >
                      Duplicate
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit('delete', p.id)}
                      aria-label={`Delete ${p.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {!editing && (
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => edit('create')}
              >
                Create profile from current selection
              </button>
            )}
            <button
              className="button button-secondary"
              disabled={busy || !api.profileTransfer || snapshot.preview}
              onClick={() => {
                setOpen(false);
                setTransfer({});
              }}
            >
              Import profile from file
            </button>
            {editing && (
              <form
                className="profile-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (editing.operation === 'create') void operation({ operation: 'create', name });
                  else if (editing.operation === 'delete')
                    void operation({
                      operation: 'delete',
                      id: editing.id!,
                      preserveCurrent: preserve,
                    });
                  else void operation({ operation: editing.operation, id: editing.id!, name });
                }}
              >
                {editing.operation === 'delete' ? (
                  <>
                    <p>Delete this profile? Installed mods and their files will be preserved.</p>
                    {editing.id === active.id && (
                      <label>
                        <input
                          type="checkbox"
                          checked={preserve}
                          onChange={(e) => setPreserve(e.target.checked)}
                        />{' '}
                        Preserve the current selection as a new Default profile
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <label htmlFor={`${fieldId}-name`}>Profile name</label>
                    <input
                      id={`${fieldId}-name`}
                      autoFocus
                      required
                      maxLength={60}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </>
                )}
                <div className="feature-actions">
                  <AsyncButton
                    className="button button-primary"
                    type="submit"
                    pending={requests.isPending('profile-operation')}
                    disabled={
                      busy ||
                      (editing.operation === 'delete' && editing.id === active.id && !preserve)
                    }
                  >
                    {editing.operation === 'delete' ? 'Confirm delete' : 'Save profile'}
                  </AsyncButton>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setEditing(undefined)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {profiles.unmanagedCount > 0 && (
              <button
                className="text-button"
                onClick={() => {
                  setOpen(false);
                  installed();
                }}
              >
                Review {profiles.unmanagedCount} unmanaged mods in Installed
              </button>
            )}
          </div>
        </Dialog>
      )}
      {transfer && (
        <ProfileTransfer
          snapshot={snapshot}
          requests={requests}
          changed={changed}
          exportId={transfer.exportId}
          onClose={() => {
            setTransfer(undefined);
            setOpen(true);
          }}
        />
      )}
      {plan && (
        <Dialog
          title={`Review profile: ${plan.name}`}
          onClose={() => setPlan(undefined)}
          wide
          dismissible={!switching}
        >
          <div className="profile-switch" aria-busy={switching}>
            <div className="profile-switch-intro">
              <p>Review the changes to your managed mod selection.</p>
              <span className="profile-switch-total">
                {plan.enable.length + plan.disable.length} changes
              </span>
            </div>
            <div className="profile-switch-changes">
              {(
                [
                  { kind: 'enable', label: 'Enable', ids: plan.enable, icon: Plus },
                  { kind: 'disable', label: 'Disable', ids: plan.disable, icon: Minus },
                ] as const
              ).map(({ kind, label, ids, icon: Icon }) => (
                <section
                  className={`profile-switch-card profile-switch-${kind}`}
                  key={kind}
                  aria-label={`Mods to ${kind}`}
                >
                  <div className="profile-switch-card-heading">
                    <Icon size={17} aria-hidden="true" />
                    <h3>{label}</h3>
                    <span className="profile-switch-count">{ids.length}</span>
                  </div>
                  {ids.length ? (
                    <ul
                      className="profile-switch-mods"
                      tabIndex={ids.length > 5 ? 0 : undefined}
                      aria-label={`Mods to ${kind}`}
                    >
                      {ids.map((id) => {
                        const mod = snapshot.localMods.find((m) => m.id === id);
                        return (
                          <li key={id}>
                            <span>{mod?.title ?? id}</span>
                            {mod?.version && <small>{mod.version}</small>}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="profile-switch-empty">Nothing to {kind}</p>
                  )}
                </section>
              ))}
            </div>
            {plan.retained.length > 0 && (
              <section className="profile-switch-retained" aria-label="Retained dependencies">
                <div className="profile-switch-section-heading">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <h3>Dependencies staying enabled</h3>
                </div>
                <ul className="profile-switch-tags">
                  {plan.retained.map((id) => (
                    <li key={id}>{snapshot.localMods.find((m) => m.id === id)?.title ?? id}</li>
                  ))}
                </ul>
                <p>
                  Required dependencies and shared prerequisites will be kept. Confirming saves this
                  effective selection to the profile.
                </p>
              </section>
            )}
            <aside className="profile-switch-note">
              <Info size={18} aria-hidden="true" />
              <div>
                <strong>Before you confirm</strong>
                <p>
                  Balatro must be closed. Versions and configurations are shared across profiles;
                  save files stay untouched.
                </p>
              </div>
            </aside>
            {plan.warnings.length > 0 && (
              <section className="profile-switch-warnings" aria-label="Profile warnings">
                <h3>Things to keep in mind</h3>
                <ul>
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}
            {plan.blockers.length > 0 && (
              <section role="status" className="profile-switch-blockers">
                <div className="profile-switch-section-heading">
                  <TriangleAlert size={18} aria-hidden="true" />
                  <h3>Switch blocked</h3>
                </div>
                <p>Resolve these issues, then review a fresh preview.</p>
                <ul>
                  {plan.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                <div className="profile-switch-review-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setPlan(undefined);
                      prerequisites();
                    }}
                  >
                    Review Prerequisites
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setPlan(undefined);
                      installed();
                    }}
                  >
                    Review Installed mods
                  </button>
                </div>
              </section>
            )}
            <div className="profile-switch-footer">
              <p role={switching ? 'status' : undefined}>
                {switching
                  ? 'Switching profile. Please keep Modatro open.'
                  : plan.blockers.length
                    ? 'No files will change until the issues are resolved.'
                    : 'Applied together in one recoverable transaction.'}
              </p>
              <div>
                <button
                  className="button button-secondary"
                  onClick={() => setPlan(undefined)}
                  disabled={switching}
                >
                  Cancel
                </button>
                <AsyncButton
                  className="button button-primary"
                  pending={requests.isPending('profile-switch')}
                  pendingLabel="Applying selection…"
                  disabled={busy || !!plan.blockers.length}
                  onClick={async () => {
                    const reply = await requests.run(
                      'profile-switch',
                      'Switching profile',
                      () => api.switchProfile!({ profileId: plan.profileId, token: plan.token }),
                      { group: 'configuration' },
                    );
                    if (reply?.ok) {
                      changed(reply.value);
                      setPlan(undefined);
                    }
                  }}
                >
                  Confirm profile switch
                </AsyncButton>
              </div>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
