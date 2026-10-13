import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PageHeading } from '../components/PageElements';
import { AsyncButton } from '../components/AsyncButton';
import { Dialog } from '../components/Dialog';
import type { Snapshot } from '../shared/model';
import type { Requests } from '../hooks/useRequests';
import {
  ReportSections,
  type ReportSection,
  type Finding,
  type Troubleshooting,
} from '../shared/features';

export function TroubleshootingPage({
  requests,
  navigate,
  profiles,
  snapshot,
}: {
  requests: Requests;
  navigate: (page: 'prerequisites' | 'installed') => void;
  profiles: () => void;
  snapshot?: Snapshot;
}) {
  const [data, setData] = useState<Troubleshooting>();
  const [selectedLogs, setSelectedLogs] = useState<string[]>([]);
  const [report, setReport] = useState<string>();
  const [notice, setNotice] = useState('');
  const [sections, setSections] = useState<ReportSection[]>([...ReportSections]);
  const revision = JSON.stringify({
    settings: snapshot?.settings,
    profiles: snapshot?.profiles,
    mods: snapshot?.localMods.map((m) => ({
      id: m.id,
      version: m.version,
      state: m.state,
      problems: m.problems,
    })),
    prerequisites: snapshot?.prerequisites.map((p) => ({
      id: p.id,
      installed: p.installed,
      version: p.installedVersion,
    })),
  });
  const [checkedRevision, setCheckedRevision] = useState<string>();
  const initialCheckStarted = useRef(false);
  const busy = requests.isBusy('configuration');
  async function load(ids = selectedLogs) {
    if (!api.troubleshoot) return;
    const reply = await requests.run(
      'troubleshooting',
      'Checking setup',
      () => api.troubleshoot!({ logIds: ids, reportSections: sections }),
      { group: 'configuration' },
    );
    if (reply?.ok) {
      setData(reply.value);
      setCheckedRevision(revision);
      return reply.value;
    }
  }
  useEffect(() => {
    // Navigation can mount this page while a profile operation is still saving.
    // Start once the shared configuration group is free; a refused request must
    // not leave the page permanently displaying "Checking setup".
    if (busy || initialCheckStarted.current) return;
    initialCheckStarted.current = true;
    void load([]);
  }, [busy]);
  function action(finding: Finding) {
    if (finding.action === 'profiles') profiles();
    else if (finding.action === 'logs')
      void requests.run('open-logs', 'Opening logs', () => api.openFolder('logs'));
    else navigate(finding.action);
  }
  if (!api.troubleshoot)
    return (
      <>
        <PageHeading
          eyebrow="HELP WITH YOUR SETUP"
          title="Troubleshooting"
          description="Setup checks and support reports are available in the desktop application."
        />
      </>
    );
  return (
    <>
      <PageHeading
        eyebrow="HELP WITH YOUR SETUP"
        title="Understand your setup."
        description="Read-only checks, clear evidence, and a support report you control."
      />
      <div className="troubleshooting-layout">
        <div className="feature-actions troubleshooting-actions">
          <AsyncButton
            className="button button-secondary"
            pending={requests.isPending('troubleshooting')}
            pendingLabel="Checking setup…"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh setup checks
          </AsyncButton>
          <button
            className="button button-secondary"
            disabled={busy || !data}
            onClick={async () => {
              const result = await load();
              if (result) {
                setReport(result.report);
                setNotice('');
              }
            }}
          >
            Generate support report
          </button>
          <span className="muted">
            {data ? `Checked ${new Date(data.generatedAt).toLocaleString()}` : 'Checking setup…'}
          </span>
        </div>
        {data && checkedRevision !== revision && (
          <p className="feature-warning" role="status">
            Setup changed since these checks. Refresh to see current findings. Reports use fresh
            checks when generated.
          </p>
        )}
        {data && (
          <>
            <section className="settings-section troubleshooting-section">
              <h2>Setup overview</h2>
              <dl className="diagnostic-overview">
                <div>
                  <dt>Application</dt>
                  <dd>
                    Modatro {data.appVersion} · {data.platform} {data.arch}
                  </dd>
                </div>
                <div>
                  <dt>Balatro</dt>
                  <dd>{data.gameVersion ?? 'Version unknown'}</dd>
                </div>
                <div>
                  <dt>Active profile</dt>
                  <dd>
                    {data.profile?.items.find((p) => p.id === data.profile?.activeId)?.name ??
                      'Unavailable'}
                    {data.profile?.unsaved ? ' · Unsaved changes' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Mod selection</dt>
                  <dd>
                    {data.mods.filter((m) => m.managed).length} managed ·{' '}
                    {data.mods.filter((m) => !m.managed).length} unmanaged ·{' '}
                    {data.mods.filter((m) => m.enabled === false).length} disabled
                  </dd>
                </div>
              </dl>
              <div className="diagnostic-prerequisites">
                {data.prerequisites
                  .filter((p) => p.id !== 'Talisman' || p.installed)
                  .map((p) => (
                    <span key={p.id}>
                      {p.id}: {p.installed ? 'Installed' : 'Missing'} ·{' '}
                      {p.version ?? 'Version unknown'}
                    </span>
                  ))}
              </div>
              <p>
                Versions and configurations are shared across profiles. Unmanaged mods may still
                affect gameplay.
              </p>
              <div className="diagnostic-mod-groups">
                {(
                  [
                    { id: 'enabled', title: 'Enabled mods', enabled: true },
                    { id: 'disabled', title: 'Disabled mods', enabled: false },
                    { id: 'unknown', title: 'Enabled state unknown', enabled: undefined },
                  ] as const
                ).map((group) => {
                  const mods = data.mods.filter((mod) => mod.enabled === group.enabled);
                  if (group.id === 'unknown' && !mods.length) return null;
                  return (
                    <section
                      className="diagnostic-mod-group"
                      aria-labelledby={`setup-mods-${group.id}`}
                      key={group.id}
                    >
                      <div className="diagnostic-mod-heading">
                        <h3 id={`setup-mods-${group.id}`}>{group.title}</h3>
                        <span className="count-pill">{mods.length}</span>
                      </div>
                      {mods.length ? (
                        <ul className="diagnostic-history">
                          {mods.map((mod) => (
                            <li key={mod.id}>
                              <strong>{mod.title}</strong>
                              <span>
                                {mod.id} · {mod.version ?? 'Version unknown'} ·{' '}
                                {mod.managed ? 'Managed' : 'Unmanaged'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No {group.id} mods.</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
            {(['problem', 'warning', 'possible'] as const).map((kind) => (
              <section className="settings-section troubleshooting-section" key={kind}>
                <h2>
                  {kind === 'problem'
                    ? 'Verified problems'
                    : kind === 'warning'
                      ? 'Warnings and unknowns'
                      : 'Possible causes from log evidence'}
                </h2>
                {!data.findings.some((f) => f.kind === kind) && (
                  <p>
                    {kind === 'possible'
                      ? 'Select log excerpts to inspect evidence. A referenced mod is not proof of the cause.'
                      : 'No findings in this category.'}
                  </p>
                )}
                {data.findings
                  .filter((f) => f.kind === kind)
                  .map((f, i) => (
                    <article className="diagnostic-finding" key={i}>
                      <strong>{f.observed}</strong>
                      <p>{f.why}</p>
                      <p>{f.next}</p>
                      <button className="text-button" onClick={() => action(f)}>
                        {f.action === 'profiles'
                          ? 'Review profiles'
                          : f.action === 'logs'
                            ? 'Open Modatro logs'
                            : f.action === 'installed'
                              ? 'Review Installed mods'
                              : 'Review Prerequisites'}
                      </button>
                    </article>
                  ))}
              </section>
            ))}
            <section className="settings-section troubleshooting-section">
              <h2>Report contents</h2>
              <fieldset className="report-selections">
                <legend>Include in the support report</legend>
                {ReportSections.map((section) => (
                  <label key={section}>
                    <input
                      type="checkbox"
                      checked={sections.includes(section)}
                      onChange={(e) =>
                        setSections(
                          e.target.checked
                            ? [...sections, section]
                            : sections.filter((value) => value !== section),
                        )
                      }
                    />{' '}
                    {section === 'setup'
                      ? 'Application, game and prerequisites'
                      : section === 'profile'
                        ? 'Active profile and differences'
                        : section === 'mods'
                          ? 'Installed mod identities and versions'
                          : section === 'findings'
                            ? 'Setup findings'
                            : 'Recent operations'}
                  </label>
                ))}
              </fieldset>
              <p>
                Selected log excerpts are included separately. Generate a fresh report after
                changing these selections.
              </p>
            </section>
            <section className="settings-section troubleshooting-section">
              <h2>Logs you choose</h2>
              <p>
                Log content is excluded until selected. Lovely and Steamodded logs are discovered in
                the configured Mods folder. Balatro may show a crash only on screen; select a saved
                console or crash log if needed.
              </p>
              <p>
                File timestamps may differ from the affected game run. Logs older than 24 hours are
                marked; all content is treated as plain text.
              </p>
              <div className="feature-actions">
                <AsyncButton
                  className="button button-secondary"
                  pending={requests.isPending('choose-log')}
                  disabled={busy}
                  onClick={async () => {
                    const reply = await requests.run(
                      'choose-log',
                      'Choosing a log',
                      () => api.chooseDiagnosticLog!(),
                      { group: 'configuration' },
                    );
                    if (reply?.ok && reply.value) {
                      const ids = [...selectedLogs, reply.value].slice(-5);
                      setSelectedLogs(ids);
                      await load(ids);
                    }
                  }}
                >
                  Choose saved text log
                </AsyncButton>
                <AsyncButton
                  className="button button-secondary"
                  pending={requests.isPending('troubleshooting')}
                  disabled={busy || !selectedLogs.length}
                  onClick={() => void load()}
                >
                  Read selected excerpts
                </AsyncButton>
              </div>
              {data.logs.map((log) => (
                <div className="diagnostic-log" key={log.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={
                        (!log.modifiedAt && !log.excerpt) ||
                        (!selectedLogs.includes(log.id) && selectedLogs.length >= 5)
                      }
                      checked={selectedLogs.includes(log.id)}
                      onChange={(e) =>
                        setSelectedLogs(
                          e.target.checked
                            ? [...selectedLogs, log.id]
                            : selectedLogs.filter((id) => id !== log.id),
                        )
                      }
                    />{' '}
                    {log.source}: {log.name}
                  </label>
                  <small>
                    {log.modifiedAt
                      ? `Modified ${new Date(log.modifiedAt).toLocaleString()}${log.stale ? ' · Older than 24 hours' : ''}`
                      : 'Timestamp unavailable'}
                  </small>
                  {log.error && <p>{log.error}</p>}
                  {log.excerpt !== undefined && <pre>{log.excerpt}</pre>}
                </div>
              ))}
            </section>
            <section className="settings-section troubleshooting-section">
              <h2>Recent operations</h2>
              {data.historyError && <p role="status">{data.historyError}</p>}
              <p>
                History is limited to 100 operations. Recovery journals and backups are retained
                separately. An uncertain operation has no verified completion.
              </p>
              {data.history.length ? (
                <ul className="diagnostic-history">
                  {[...data.history]
                    .reverse()
                    .slice(0, 20)
                    .map((entry) => (
                      <li key={entry.id}>
                        <strong>
                          {entry.type} · {entry.outcome}
                        </strong>
                        <span>
                          {new Date(entry.time).toLocaleString()} ·{' '}
                          {entry.profile ?? entry.ids.join(', ')}
                        </span>
                        {entry.versions
                          .filter((v) => v.before !== v.after)
                          .map((v) => (
                            <small key={v.id}>
                              {v.id}: {v.before ?? 'not installed'} → {v.after ?? 'not installed'}
                            </small>
                          ))}
                      </li>
                    ))}
                </ul>
              ) : data.historyError ? null : (
                <p>No recorded operations yet.</p>
              )}
            </section>
          </>
        )}
      </div>
      {report !== undefined && (
        <Dialog title="Review support report" wide onClose={() => setReport(undefined)}>
          <div className="support-report-editor">
            <p>
              Inspect and edit before sharing. Automated redaction may be incomplete. Reports are
              never uploaded automatically.
            </p>
            <label htmlFor="support-report-text">Editable support report</label>
            <textarea
              id="support-report-text"
              className="support-report"
              maxLength={100000}
              value={report}
              onChange={(e) => setReport(e.target.value)}
            />
            <div className="feature-actions">
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('copy-report')}
                onClick={async () => {
                  const reply = await requests.run('copy-report', 'Copying report', async () => {
                    await navigator.clipboard.writeText(report);
                    return { ok: true, value: undefined };
                  });
                  if (reply?.ok) setNotice('Report copied.');
                }}
              >
                Copy report
              </AsyncButton>
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending('export-report')}
                onClick={async () => {
                  const reply = await requests.run('export-report', 'Exporting report', () =>
                    api.exportReport!({ text: report }),
                  );
                  if (reply?.ok) setNotice(reply.value ? 'Report exported.' : 'Export cancelled.');
                }}
              >
                Export report
              </AsyncButton>
            </div>
            <p role="status">{notice}</p>
          </div>
        </Dialog>
      )}
    </>
  );
}
