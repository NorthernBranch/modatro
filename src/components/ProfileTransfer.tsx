import { useEffect, useState } from 'react';
import { api } from '../api';
import { Dialog } from './Dialog';
import type { Requests } from '../hooks/useRequests';
import type { Snapshot, Reply, Progress } from '../shared/model';
import type { ProfileTransferRequest, ProfileTransferResult } from '../shared/profile-transfer';

export function ProfileTransfer({
  requests,
  changed,
  exportId,
  snapshot,
  onClose,
}: {
  requests: Requests;
  changed: (s: Snapshot) => void;
  exportId?: string;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ProfileTransferResult>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<Progress>();
  const pending = requests.isPending('profile-transfer');
  useEffect(() => api.onProgress(setProgress), []);
  async function call(request: ProfileTransferRequest) {
    setError(undefined);
    setProgress(undefined);
    const outer = await requests.run(
      'profile-transfer',
      request.operation === 'export'
        ? 'Exporting profile'
        : request.operation === 'choose-import'
          ? 'Checking profile'
          : 'Importing profile',
      async () => {
        let reply: Reply<ProfileTransferResult>;
        try {
          reply = await api.profileTransfer!(request);
        } catch {
          reply = {
            ok: false,
            error: {
              message:
                'The desktop connection was interrupted. Reopen Profiles to check its state.',
            },
          };
        }
        return { ok: true, value: reply };
      },
      { group: 'configuration' },
    );
    if (!outer?.ok) return;
    const reply = outer.value;
    if (!reply.ok) {
      setError(reply.error.message);
      return;
    }
    if (reply.value.snapshot) changed(reply.value.snapshot);
    if (reply.value.status === 'cancelled') {
      onClose();
      return;
    }
    setResult(reply.value);
  }
  // The component opens only in response to an explicit import/export action.
  useEffect(() => {
    void call(exportId ? { operation: 'export', id: exportId } : { operation: 'choose-import' });
  }, []);
  const close = () => {
    if (result?.token && result.status === 'review')
      void call({ operation: 'cancel', token: result.token });
    else onClose();
  };
  const stages = [
    'Check profile integrity',
    'Review required mods',
    'Install prerequisites and mods',
    'Save profile selection',
  ];
  return (
    <Dialog
      title={exportId ? 'Export profile' : 'Import profile'}
      dismissible={!pending}
      onClose={close}
      wide
    >
      <div className="profile-transfer" aria-busy={pending}>
        {!exportId && (
          <ol className="profile-transfer-steps">
            {stages.map((stage, i) => (
              <li
                key={stage}
                className={
                  result?.status === 'complete' || (result?.status === 'review' && i === 0)
                    ? 'done'
                    : ''
                }
              >
                {stage}
              </li>
            ))}
          </ol>
        )}
        {!result && (
          <p role="status">
            {pending
              ? 'Choose a file in the system dialog. Checking the profile…'
              : 'No file selected.'}
          </p>
        )}
        {result?.status === 'exported' && (
          <p role="status">{result.name} was exported to your chosen location.</p>
        )}
        {result?.status === 'complete' && (
          <>
            <h3>{result.name} is ready</h3>
            <p role="status">
              Required mods are installed and the imported profile is active. Existing profiles are
              preserved.
            </p>
          </>
        )}
        {result?.status === 'review' && (
          <>
            <h3>Import as {result.name}</h3>
            <p>
              The import creates a new profile and activates it after installation. Only continue
              with a profile from someone you trust.
            </p>
            <ul className="profile-transfer-mods">
              {result.mods?.map((mod, i) => (
                <li key={i}>
                  <strong>{mod.title}</strong>
                  <span>
                    {mod.version} · {mod.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                    {mod.status === 'installed' ? 'Already installed' : 'Download required'}
                  </span>
                </li>
              ))}
            </ul>
            {result.confirmation && (
              <p>
                Ready to install {result.confirmation.plan.packages?.length ?? 1} packages.{' '}
                {result.confirmation.plan.create.length} files added;{' '}
                {result.confirmation.plan.replace.length} replaced;{' '}
                {result.confirmation.plan.remove.length} removed. Existing recovery backups are
                retained.
              </p>
            )}
            {result.confirmation?.plan.packages?.map((item) => (
              <p key={item.id}>
                {item.title} · {item.version} · {item.source ?? 'Author source'}
              </p>
            ))}
          </>
        )}
        {!!result?.warnings?.length && (
          <details>
            <summary>What this includes</summary>
            {result.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        )}
        {!!result?.blockers?.length && (
          <ul className="creator-validation" role="alert">
            {result.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="creator-validation">
            {error}
          </p>
        )}
        {pending && progress && (
          <p role="status">
            {(
              {
                downloading: 'Downloading',
                planning: 'Checking downloaded files',
                'backing-up': 'Backing up existing files',
                installing: 'Installing',
                verifying: 'Verifying',
                rolling_back: 'Recovering',
              } as Record<string, string>
            )[progress.phase] ?? progress.phase}
            {progress.percent !== undefined ? ` · ${Math.round(progress.percent)}%` : ''} ·{' '}
            {result?.confirmation?.plan.packages?.find((p) => p.id === progress.modId)?.title ??
              snapshot.catalogue.mods.find((m) => m.id === progress.modId)?.title ??
              (progress.modId.toLowerCase().includes('lovely') ? 'Lovely' : undefined) ??
              'Required package'}
          </p>
        )}
        <div className="dialog-footer">
          <button className="button button-secondary" disabled={pending} onClick={close}>
            {result?.status === 'review' ? 'Cancel import' : 'Close'}
          </button>
          {result?.status === 'review' && (
            <button
              className="button button-primary"
              disabled={pending || !!result.blockers?.length}
              onClick={() =>
                void call({
                  operation: 'install',
                  token: result.token!,
                  confirmationToken: result.confirmation?.token,
                })
              }
            >
              {pending
                ? 'Working…'
                : result.confirmation
                  ? 'Confirm file changes and import'
                  : 'Install required mods and import'}
            </button>
          )}
          {error && !result && (
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() =>
                void call(
                  exportId ? { operation: 'export', id: exportId } : { operation: 'choose-import' },
                )
              }
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
