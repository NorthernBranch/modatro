import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronRight,
  Compass,
  Download,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  Info,
  Layers3,
  LoaderCircle,
  PackageCheck,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Spade,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AsyncButton } from './components/AsyncButton';
import { EmptyState } from './components/PageElements';
import { useRequests } from './hooks/useRequests';
import { Dialog } from './components/Dialog';
import { ModArt } from './components/ModArt';
import { PrerequisiteAction } from './components/PrerequisiteAction';
import { DiscoverPage } from './pages/DiscoverPage';
import { InstalledPage } from './pages/InstalledPage';
import { PrerequisitesPage } from './pages/PrerequisitesPage';
import { SettingsPage } from './pages/SettingsPage';
import type {
  AppError,
  ConflictDecision,
  ModAction,
  ModDefinition,
  InstallPlan,
  OperationReport,
  Progress,
  Reply,
  Snapshot,
  UnverifiedPrerequisite,
} from './shared/model';
import { eligibility, plainText, requirements } from './shared/presentation';
import {
  allowedDescription,
  approvalLabel,
  automationReason,
  sourceType,
  sourceLabel,
} from './shared/trust';

type Page = 'discover' | 'installed' | 'updates' | 'prerequisites' | 'settings';
const navigation: { id: Page; label: string; icon: typeof Compass }[] = [
  { id: 'discover', label: 'Discover', icon: Compass },
  { id: 'installed', label: 'Installed', icon: Layers3 },
  { id: 'updates', label: 'Updates', icon: Download },
  { id: 'prerequisites', label: 'Prerequisites', icon: PackageCheck },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [page, setPage] = useState<Page>('discover');

  const [selected, setSelected] = useState<ModDefinition>();
  const [requirementTrail, setRequirementTrail] = useState<ModDefinition[]>([]);
  const [progress, setProgress] = useState<Progress>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [detectionMessage, setDetectionMessage] = useState<string>();
  const [error, setError] = useState<AppError>();
  const [notification, setNotification] = useState<string>();
  const [operationReport, setOperationReport] = useState<OperationReport>();
  const [setup, setSetup] = useState(false);
  const [about, setAbout] = useState(false);
  const [inspectedPlan, setInspectedPlan] = useState<InstallPlan>();
  useEffect(() => setInspectedPlan(undefined), [selected?.id]);
  const [confirmation, setConfirmation] = useState<{
    id: string;
    action: ModAction;
    title: string;
    mod?: ModDefinition;
    token?: string;
    plan?: InstallPlan;
    acceptedUnverified?: UnverifiedPrerequisite[];
  }>();
  const [conflictAction, setConflictAction] = useState<{
    id: string;
    action: ModAction;
    acceptedUnverified?: UnverifiedPrerequisite[];
  }>();
  const [decisions, setDecisions] = useState<ConflictDecision[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const setupOpened = useRef(false);
  const reportError = useCallback((failure: AppError) => {
    setConflictAction(undefined);
    setDecisions([]);
    if (failure.confirmation) {
      setError(undefined);
      setConfirmation({
        id: failure.confirmation.plan.modId,
        action: 'install',
        title: 'selected packages',
        token: failure.confirmation.token,
        plan: failure.confirmation.plan,
      });
    } else setError(failure);
  }, []);
  const requests = useRequests(reportError);
  const { run } = requests;
  const working = requests.isPending('mod-action');
  const configuring = requests.isBusy('configuration');
  const refreshing = requests.isPending('refresh') || !!snapshot?.catalogue.refreshing;
  const callSnapshot = useCallback(
    async (key: string, label: string, task: () => Promise<Reply<Snapshot>>) => {
      const reply = await run(key, label, task, {
        group: ['load', 'refresh'].includes(key) ? undefined : 'configuration',
      });
      if (reply?.ok) setSnapshot(reply.value);
      return reply;
    },
    [run],
  );
  const load = useCallback(async () => {
    const reply = await callSnapshot('load', 'Loading Modatro', () => api.snapshot());
    if (reply) setLoadFailed(!reply.ok);
  }, [callSnapshot]);
  useEffect(() => {
    void load();
    const removeProgress = api.onProgress(setProgress),
      removeSnapshot = api.onSnapshot(setSnapshot);
    return () => {
      removeProgress();
      removeSnapshot();
    };
  }, [load]);
  useEffect(() => {
    if (snapshot && !snapshot.preview && !snapshot.settings.setupComplete && !setupOpened.current) {
      setSetup(true);
      setupOpened.current = true;
    }
    const mode = snapshot?.settings.theme ?? 'dark';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [snapshot]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPage('discover');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (!selected) setRequirementTrail([]);
  }, [selected]);
  useEffect(() => {
    setSelected((previous) =>
      previous
        ? (snapshot?.catalogue.mods.find((mod) => mod.id === previous.id) ?? previous)
        : undefined,
    );
  }, [snapshot]);
  function reviewRequirement(mod: ModDefinition) {
    if (selected && selected.id !== mod.id) setRequirementTrail((trail) => [...trail, selected]);
    setSelected(mod);
    setError(undefined);
  }
  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => setNotification(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notification]);
  async function refresh() {
    if (refreshing) return;
    const reply = await callSnapshot('refresh', 'Refreshing catalogue and prerequisites', () =>
      api.refresh(),
    );
    if (reply?.ok) {
      const problems = [
        reply.value.catalogue.error,
        ...reply.value.prerequisites.map((p) => p.latestError),
      ].filter(Boolean);
      if (problems.length)
        reportError({
          message:
            'Some updates could not be checked. Your saved catalogue and installed mods are preserved.',
          details: problems.join('\n'),
        });
      else setNotification('Catalogue and prerequisites refreshed.');
    }
  }
  async function detect() {
    setDetectionMessage(undefined);
    const reply = await callSnapshot('detect', 'Finding Balatro', () => api.detect());
    if (!reply?.ok) return;
    const message = reply.value.validation?.valid
      ? 'Your Balatro installation is verified and connected.'
      : reply.value.candidates.length
        ? 'Choose an installation below to connect Balatro.'
        : 'No Balatro installation was found in Steam’s libraries. Choose your game folder manually.';
    setDetectionMessage(message);
    setNotification(message);
  }
  async function perform(
    id: string,
    action: ModAction,
    choices?: ConflictDecision[],
    token?: string,
    acceptedUnverified?: UnverifiedPrerequisite[],
  ) {
    if (configuring) return;
    setError(undefined);
    setConfirmation(undefined);
    setProgress(undefined);
    const reply = await run(
      'mod-action',
      {
        install: 'Installing mod',
        update: 'Updating mod',
        uninstall: 'Uninstalling mod',
        disable: 'Disabling mod',
        enable: 'Enabling mod',
        adopt: 'Adopting mod',
      }[action],
      () => api.action(id, action, choices, token, acceptedUnverified),
      {
        group: 'configuration',
        failureMessage:
          'The desktop service could not complete this operation. Reopen Modatro to check recovery.',
      },
    );
    if (reply?.ok) {
      setSnapshot(reply.value);
      const report = reply.value.operationReport;
      if (report && (report.retainedFiles.length || report.cleanupProblems.length))
        setOperationReport(report);
      setNotification(
        {
          install: 'Mod installed. You’re ready for your next run.',
          update: 'Mod updated. Your backups are preserved.',
          uninstall: choices?.some((c) => c.action === 'keep')
            ? 'Mod uninstalled. Your changed files were kept.'
            : 'Mod uninstalled. Original files were restored where needed.',
          disable: 'Mod disabled. Its files are stored safely outside Mods.',
          enable: 'Mod enabled. Ready for your next run.',
          adopt: 'Mod adopted. Existing files are now tracked by Modatro.',
        }[action],
      );
    } else if (reply && !reply.ok) {
      if (reply.error.confirmation) {
        setError(undefined);
        setConfirmation({
          id,
          action,
          title: snapshot?.catalogue.mods.find((mod) => mod.id === id)?.title ?? id,
          token: reply.error.confirmation.token,
          plan: reply.error.confirmation.plan,
          acceptedUnverified,
        });
      } else setConflictAction({ id, action, acceptedUnverified });
      setDecisions(
        (reply.error.conflicts ?? []).map((c) => ({ root: c.root, path: c.path, action: 'keep' })),
      );
    }
    setProgress(undefined);
  }
  async function openLink(url: string) {
    await run(`link:${url}`, 'Opening project page', () => api.openLink(url), {
      group: 'external-link',
    });
  }
  async function launch() {
    const reply = await run(
      'launch',
      'Launching Balatro',
      () =>
        api.launch(
          snapshot?.platform === 'darwin' &&
            !!snapshot.prerequisites.find((p) => p.id === 'Lovely')?.installed,
        ),
      { group: 'configuration' },
    );
    if (reply?.ok) setNotification('Balatro is launching. Enjoy your run.');
  }
  function requestAction(id: string, action: ModAction, title: string, mod?: ModDefinition) {
    if (configuring || !snapshot) return;
    if (action === 'uninstall') setConfirmation({ id, action, title, mod });
    else if (action === 'adopt') setConfirmation({ id, action, title });
    else void perform(id, action);
  }
  const mods = snapshot?.catalogue.mods ?? [];
  const updates = snapshot?.localMods.filter((m) => m.state === 'update-available') ?? [];
  const installed = snapshot?.localMods ?? [];

  const gameReady = snapshot?.validation?.valid ?? false;

  function buttonFor(mod: ModDefinition, compact = false) {
    const local = installed.find((m) => m.id === mod.id || m.catalogueId === mod.id),
      reason = snapshot ? eligibility(mod, snapshot) : 'Loading…';
    const active = working && progress?.modId === mod.id;
    if (active)
      return (
        <button className="button button-progress" disabled>
          <LoaderCircle className="spin" size={14} />
          {progress?.phase === 'downloading'
            ? `Downloading${progress.percent === undefined ? '…' : ` ${progress.percent}%`}`
            : 'Installing…'}
        </button>
      );
    if (local?.state === 'installed')
      return (
        <button className="button button-installed" onClick={() => setSelected(mod)}>
          <Check size={14} />
          Installed
        </button>
      );
    if (local?.state === 'disabled')
      return (
        <button
          className="button button-secondary"
          onClick={() => requestAction(mod.id, 'enable', mod.title)}
          disabled={configuring || !snapshot}
        >
          Enable
        </button>
      );
    if (local?.state === 'broken')
      return (
        <button
          className="button button-secondary"
          onClick={() => {
            setSelected(undefined);
            setPage('installed');
          }}
        >
          <TriangleAlert size={14} />
          Check files
        </button>
      );
    if (local && !local.managed)
      return (
        <button
          className="button button-secondary"
          onClick={() => {
            setSelected(undefined);
            setPage('installed');
          }}
        >
          Installed externally
        </button>
      );
    if (automationReason(mod, !!local?.managed) || (snapshot?.trust && !snapshot.trust.fresh))
      return (
        <button className="button button-secondary" onClick={() => setSelected(mod)} title={reason}>
          View availability
        </button>
      );
    return (
      <button
        className={`button ${local?.state === 'update-available' ? 'button-primary' : 'button-install'}`}
        disabled={configuring || !snapshot}
        onClick={() =>
          reason
            ? setSelected(mod)
            : requestAction(
                mod.id,
                local?.state === 'update-available' ? 'update' : 'install',
                mod.title,
                mod,
              )
        }
        title={reason ?? `Install ${mod.title}`}
      >
        <ArrowDownToLine size={14} />
        {local?.state === 'update-available'
          ? 'Update'
          : mod.unavailableReason
            ? 'Unavailable'
            : 'Install'}
        {reason && !compact ? <span className="sr-only">: {reason}</span> : null}
      </button>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="window-grip" />
        <a
          className="brand"
          href="#discover"
          onClick={(e) => {
            e.preventDefault();
            setPage('discover');
          }}
          aria-label="Modatro home"
        >
          <span className="brand-mark">
            <Spade size={25} fill="currentColor" />
          </span>
          <span>
            modatro<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-label">YOUR MOD SPACE</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setPage(id);
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'updates' && updates.length > 0 ? (
                <span className="nav-count">{updates.length}</span>
              ) : id === 'installed' && installed.length > 0 ? (
                <span className="nav-count muted">{installed.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="game-panel">
            <div className="game-panel-top">
              <span className="game-icon">
                <Gamepad2 size={20} />
              </span>
              <div>
                <strong>Balatro</strong>
                <span className={gameReady ? 'ready-text' : ''}>
                  {gameReady ? 'Installation connected' : 'Let’s get you connected'}
                </span>
              </div>
              {gameReady ? <Check size={14} className="ready-text" /> : null}
            </div>
            <AsyncButton
              pending={requests.isPending('detect')}
              pendingLabel="Checking…"
              disabled={!snapshot || configuring}
              onClick={() => (gameReady ? void detect() : setSetup(true))}
            >
              {gameReady ? 'Check installation' : 'Find Balatro'}
              <ArrowUpRight size={14} />
            </AsyncButton>
          </div>
          <div className="safety-note">
            <ShieldCheck size={16} />
            <span>Your game. Safely modded.</span>
          </div>
          <button className="version-button" disabled={!snapshot} onClick={() => setAbout(true)}>
            v{snapshot?.appVersion ?? '…'}
            <span>
              Made for the community
              <ArrowUpRight size={12} />
            </span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Your library
            <ChevronRight size={13} />
            <span>{navigation.find((n) => n.id === page)?.label}</span>
          </div>
          <div className="topbar-actions">
            {snapshot?.preview ? (
              <span className="preview-label">
                <EyeIcon />
                Read-only preview
              </span>
            ) : (
              <span className="connection-status">
                <span className={`status-dot ${snapshot?.catalogue.stale ? 'offline' : ''}`} />
                {!snapshot
                  ? 'Connecting…'
                  : snapshot.catalogue.refreshing
                    ? 'Refreshing catalogue…'
                    : snapshot.catalogue.error
                      ? 'Catalogue unavailable'
                      : snapshot.catalogue.stale
                        ? 'Cached catalogue'
                        : 'Connected'}
              </span>
            )}
            <AsyncButton
              className="button launch-button"
              pending={requests.isPending('launch')}
              pendingLabel="Launching…"
              disabled={!snapshot || configuring}
              onClick={() => (gameReady ? void launch() : setSetup(true))}
            >
              <Play size={14} fill="currentColor" />
              {snapshot?.platform === 'darwin' &&
              snapshot.prerequisites.find((p) => p.id === 'Lovely')?.installed
                ? 'Launch Modded Balatro'
                : 'Launch Balatro'}
            </AsyncButton>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {snapshot?.safetyError && (
            <div className="banner danger">
              <ShieldCheck size={19} />
              <span>{snapshot.safetyError}</span>
            </div>
          )}
          {!snapshot && !loadFailed && (
            <section aria-busy="true" aria-label="Loading library">
              <h1>Loading Modatro…</h1>
              <p role="status">Connecting to the desktop service and checking your library.</p>
              <div className="mod-grid" aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="mod-card skeleton" />
                ))}
              </div>
            </section>
          )}
          {!snapshot && loadFailed && (
            <EmptyState
              busy={!loadFailed}
              icon={loadFailed ? TriangleAlert : LoaderCircle}
              title={loadFailed ? 'Modatro could not load' : 'Loading Modatro…'}
              description={
                loadFailed
                  ? 'The desktop service could not be reached. Try again to load your library.'
                  : 'Connecting to the desktop service and checking your library.'
              }
              action={
                loadFailed ? (
                  <AsyncButton
                    className="button button-primary"
                    pending={requests.isPending('load')}
                    pendingLabel="Retrying…"
                    onClick={() => void load()}
                  >
                    Try again
                  </AsyncButton>
                ) : undefined
              }
            />
          )}
          {snapshot && page === 'discover' && (
            <DiscoverPage
              snapshot={snapshot}
              searchRef={searchRef}
              setSelected={setSelected}
              buttonFor={buttonFor}
              refresh={refresh}
              refreshing={refreshing}
              setError={setError}
            />
          )}
          {snapshot && (page === 'installed' || page === 'updates') && (
            <InstalledPage
              page={page}
              installed={installed}
              updates={updates}
              mods={mods}
              working={configuring}
              refreshing={refreshing}
              catalogueStale={snapshot.catalogue.stale}
              refresh={refresh}
              setSelected={setSelected}
              requestAction={requestAction}
              setPage={setPage}
              openModFolder={
                api.openModFolder
                  ? async (id) => {
                      await run(`folder:mod:${id}`, 'Opening mod folder', () =>
                        api.openModFolder!(id),
                      );
                    }
                  : undefined
              }
              openLink={openLink}
              folderPending={(id) => requests.isPending(`folder:mod:${id}`)}
              projectPending={(url) => requests.isPending(`link:${url}`)}
            />
          )}
          {snapshot && page === 'prerequisites' && (
            <PrerequisitesPage
              snapshot={snapshot}
              refreshing={refreshing}
              refresh={refresh}
              review={reviewRequirement}
              requestAction={requestAction}
              requests={requests}
              openLink={openLink}
            />
          )}
          {snapshot && page === 'settings' && (
            <SettingsPage
              snapshot={snapshot}
              gameReady={gameReady}
              callSnapshot={callSnapshot}
              requests={requests}
              refresh={refresh}
              refreshing={refreshing}
              setNotification={setNotification}
              setAbout={setAbout}
            />
          )}
        </main>
      </div>
      {selected && snapshot && (
        <Dialog title={selected.title} onClose={() => setSelected(undefined)} wide>
          {requirementTrail.length > 0 && (
            <div className="requirement-trail">
              <p>Required by {requirementTrail.map((mod) => mod.title).join(' → ')}</p>
              <button
                className="text-button"
                onClick={() => {
                  setSelected(requirementTrail.at(-1));
                  setRequirementTrail((trail) => trail.slice(0, -1));
                }}
              >
                Back to {requirementTrail.at(-1)?.title}
              </button>
            </div>
          )}
          <div className="detail-intro">
            <ModArt mod={selected} large />
            <div>
              <div className="eyebrow">{selected.categories.join(' / ')}</div>
              <p className="detail-author">
                by {selected.author} <span>Version {selected.version}</span>
              </p>
              <p>
                {plainText(allowedDescription(selected)) ||
                  'A community-made Balatro mod. Visit its source page for more information.'}
              </p>
            </div>
          </div>
          <section className="detail-provenance">
            <h3>Source and provenance</h3>
            <dl className="version-facts">
              <div>
                <dt>Catalogue status</dt>
                <dd>{approvalLabel(selected)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {selected.repositoryUrl
                    ? new URL(selected.repositoryUrl).pathname.slice(1)
                    : selected.source
                      ? `${selected.source.provider}: ${selected.source.namespace ?? ''}/${selected.source.packageName ?? selected.source.externalId}`
                      : 'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Download source</dt>
                <dd>
                  {sourceLabel(
                    selected.releaseSource?.sourceType ?? sourceType(selected.downloadUrl),
                  )}
                </dd>
              </div>
              <div>
                <dt>Managed by Modatro</dt>
                <dd>
                  {installed.some((local) => local.id === selected.id && local.managed)
                    ? 'Yes'
                    : 'No'}
                </dd>
              </div>
              {selected.licence && (
                <div>
                  <dt>Licence (informational)</dt>
                  <dd>{selected.licence}</dd>
                </div>
              )}
            </dl>
            <p className="muted-text">
              Author approval concerns catalogue inclusion. Modatro does not certify third-party
              code as safe.
            </p>
          </section>
          <section className="detail-requirements">
            <h3>What you’ll need</h3>
            {requirements(selected, snapshot).length ? (
              requirements(selected, snapshot).map((r) => (
                <div className="requirement-row" key={`${r.id}:${r.versionConstraint}`}>
                  <span className={`requirement-symbol ${r.state}`} title={r.reason}>
                    {r.state === 'satisfied' || r.state === 'unknown' ? '✓' : '×'}
                  </span>
                  <div>
                    <strong>{r.displayName}</strong>
                    <span>
                      {r.packageId ? 'Thunderstore package ' : ''}
                      {r.versionConstraint ?? 'Required version: not specified by mod'}
                    </span>
                  </div>
                  <div>
                    <strong>
                      {r.state === 'satisfied' || r.state === 'unknown'
                        ? 'Installed'
                        : r.state === 'outdated'
                          ? 'Update required'
                          : r.state === 'missing'
                            ? 'Not installed'
                            : 'Check version'}
                    </strong>
                    <span>
                      {r.state === 'unknown'
                        ? r.packageId
                          ? 'Package version unverified'
                          : 'Version unverified'
                        : (r.installedVersion ??
                          (r.state === 'satisfied'
                            ? 'Version unknown'
                            : r.required
                              ? 'Required'
                              : 'Optional'))}
                    </span>
                  </div>
                  {r.state !== 'satisfied' && (
                    <PrerequisiteAction
                      requirement={r}
                      snapshot={snapshot}
                      requests={requests}
                      requestAction={requestAction}
                      review={reviewRequirement}
                      openLink={openLink}
                    />
                  )}
                </div>
              ))
            ) : (
              <p className="muted-text">
                No prerequisites are listed in the catalogue. The downloaded mod’s structured
                metadata and Lovely patches are checked before installation.
              </p>
            )}
            <button
              className="text-button"
              onClick={() => {
                setSelected(undefined);
                setPage('prerequisites');
              }}
            >
              Manage prerequisites
              <ArrowUpRight size={14} />
            </button>
          </section>
          <div className="detail-install">
            {selected.thunderstore &&
              selected.repositoryUrl &&
              selected.metadataId !== 'Lovely' && (
                <p className="muted-text">Downloads use the project’s GitHub manual archive.</p>
              )}
            {selected.deprecated && (
              <p className="muted-text">Deprecated · Existing installations remain manageable.</p>
            )}
            {api.previewPlan && (
              <>
                <AsyncButton
                  className="text-button"
                  pending={requests.isPending('plan')}
                  pendingLabel="Inspecting download…"
                  disabled={configuring || !!eligibility(selected, snapshot)}
                  onClick={() =>
                    void run(
                      'plan',
                      'Inspecting install plan',
                      () => api.previewPlan!(selected.id),
                      { group: 'configuration' },
                    ).then((reply) => {
                      setProgress(undefined);
                      if (reply?.ok) setInspectedPlan(reply.value);
                    })
                  }
                >
                  Preview file changes
                </AsyncButton>
                {inspectedPlan?.modId === selected.id && (
                  <details open>
                    <summary>
                      File changes · Create {inspectedPlan.create.length} · Replace{' '}
                      {inspectedPlan.replace.length} · Remove {inspectedPlan.remove.length}
                    </summary>
                    <ul>
                      {(['create', 'replace', 'remove'] as const).flatMap((operation) =>
                        inspectedPlan[operation].map((file) => (
                          <li key={`${operation}:${file.root}:${file.path}`}>
                            <code>
                              {operation}: {file.root}/{file.path}
                            </code>
                          </li>
                        )),
                      )}
                    </ul>
                  </details>
                )}
              </>
            )}
            <div>
              <ShieldCheck size={17} />
              <span>
                {['game-replacement', 'lovely-injector'].includes(selected.installation.type)
                  ? 'Changes game files. Original files will be backed up.'
                  : 'Staged, checked, and installed with a file-by-file record.'}
              </span>
            </div>
            {eligibility(selected, snapshot) && (
              <p className="install-reason">
                <Info size={15} />
                {eligibility(selected, snapshot)}
              </p>
            )}
            <div className="detail-actions">
              {selected.source?.url && (
                <AsyncButton
                  className="button button-secondary"
                  pending={requests.isPending(`link:${selected.source.url}`)}
                  pendingLabel="Opening…"
                  disabled={requests.isBusy('external-link')}
                  onClick={() => void openLink(selected.source!.url!)}
                >
                  <ExternalLink size={15} />
                  Source: {selected.source.provider}
                </AsyncButton>
              )}
              <AsyncButton
                className="button button-secondary"
                pending={requests.isPending(`link:${selected.repositoryUrl}`)}
                pendingLabel="Opening…"
                disabled={!selected.repositoryUrl || requests.isBusy('external-link')}
                onClick={() => selected.repositoryUrl && void openLink(selected.repositoryUrl)}
              >
                <ExternalLink size={15} />
                Repository
              </AsyncButton>
              {eligibility(selected, snapshot) &&
              !automationReason(
                selected,
                installed.some((local) => local.id === selected.id && local.managed),
              ) &&
              snapshot.trust?.fresh !== false ? (
                <button
                  className="button button-primary"
                  onClick={() => {
                    setSelected(undefined);
                    if (!gameReady) setSetup(true);
                    else setPage('prerequisites');
                  }}
                >
                  {!gameReady ? 'Set up Balatro' : 'Check requirements'}
                  <ArrowUpRight size={15} />
                </button>
              ) : (
                buttonFor(selected)
              )}
            </div>
          </div>
          {working && (
            <p className="request-status" role="status">
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
              {requests.pending['mod-action']?.label}…
            </p>
          )}
        </Dialog>
      )}
      {setup && snapshot && (
        <Dialog title="Welcome to Modatro." onClose={() => setSetup(false)}>
          <p className="dialog-description">Your next favourite run is just a few steps away.</p>
          {snapshot.discoveryError && (
            <div className="banner subtle" role="alert">
              <TriangleAlert size={17} />
              <span>{snapshot.discoveryError}</span>
            </div>
          )}
          <ol className="setup-steps">
            <li>
              <span className={gameReady ? 'done' : ''}>
                {gameReady ? <Check size={16} /> : '1'}
              </span>
              <div>
                <h3>Find Balatro</h3>
                <p>
                  {gameReady
                    ? 'Your installation is verified and connected.'
                    : 'We check Steam’s libraries first, then validate your game files.'}
                </p>
                {!gameReady && snapshot.candidates.length > 0 && (
                  <div className="candidate-list">
                    {snapshot.candidates.map((c) => (
                      <AsyncButton
                        className="button button-secondary"
                        key={c.path}
                        disabled={configuring}
                        pending={requests.isPending('select-game')}
                        pendingLabel="Connecting Balatro…"
                        onClick={() =>
                          void callSnapshot('select-game', 'Connecting Balatro', () =>
                            api.selectCandidate(c.path),
                          )
                        }
                      >
                        {c.path}
                      </AsyncButton>
                    ))}
                  </div>
                )}
                {detectionMessage && (
                  <p role="status" className="setup-result">
                    {detectionMessage}
                  </p>
                )}
                <div className="setup-actions">
                  <AsyncButton
                    className="button button-secondary"
                    pending={requests.isPending('detect')}
                    pendingLabel="Finding Balatro…"
                    disabled={configuring || snapshot.preview}
                    onClick={() => void detect()}
                  >
                    <RefreshCw size={14} />
                    Find automatically
                  </AsyncButton>
                  <AsyncButton
                    className="text-button"
                    pending={requests.isPending('choose-game')}
                    pendingLabel="Choosing folder…"
                    disabled={configuring || snapshot.preview}
                    onClick={() =>
                      void callSnapshot('choose-game', 'Choosing Balatro folder', () =>
                        api.choosePath('game'),
                      )
                    }
                  >
                    Choose folder
                    <FolderOpen size={14} />
                  </AsyncButton>
                </div>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Check your prerequisites</h3>
                <p>Lovely and Steamodded open the door to most mods.</p>
                <button
                  className="text-button"
                  onClick={() => {
                    setSetup(false);
                    setPage('prerequisites');
                  }}
                >
                  See prerequisite status
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Make it your game</h3>
                <p>Discover a mod, check its requirements, and install.</p>
              </div>
            </li>
          </ol>
          {snapshot.preview && (
            <div className="banner subtle">
              <Info size={17} />
              This browser preview is read-only. Setup runs in the desktop app.
            </div>
          )}
          <div className="dialog-footer">
            <button className="text-button" onClick={() => setSetup(false)}>
              Browse for now
            </button>
            <AsyncButton
              className="button button-primary"
              pending={requests.isPending('settings')}
              pendingLabel="Saving setup…"
              disabled={!gameReady || snapshot.preview || configuring}
              onClick={() =>
                void callSnapshot('settings', 'Saving setup', () =>
                  api.saveSettings({ theme: snapshot.settings.theme, setupComplete: true }),
                ).then((reply) => {
                  if (reply?.ok) {
                    setSetup(false);
                    setPage('discover');
                  }
                })
              }
            >
              Start exploring
              <ArrowUpRight size={15} />
            </AsyncButton>
          </div>
        </Dialog>
      )}
      {confirmation && (
        <Dialog
          title={
            confirmation.action === 'uninstall'
              ? `Uninstall ${confirmation.title}?`
              : confirmation.action === 'adopt'
                ? `Adopt ${confirmation.title}?`
                : `Install ${confirmation.title}?`
          }
          onClose={() => setConfirmation(undefined)}
        >
          <p className="dialog-description">
            {confirmation.action === 'uninstall'
              ? 'Modatro removes only recorded files and restores verified originals. If a file has changed, you’ll choose how to handle it.'
              : confirmation.action === 'adopt'
                ? 'Modatro will inspect and record the existing files before managing them. Future uninstall removes these recorded files only; changes will be protected.'
                : 'Review the packages and file changes below. Modatro will back up existing files before replacing them.'}
          </p>
          {!!confirmation.plan?.packages?.length && (
            <ul>
              {confirmation.plan.packages.map((entry) => (
                <li key={entry.id}>
                  {entry.title} {entry.version} · {entry.update ? 'Update' : 'Install'}
                </li>
              ))}
            </ul>
          )}
          {confirmation.plan && (
            <details open>
              <summary>
                View file changes · Create {confirmation.plan.create.length} · Replace{' '}
                {confirmation.plan.replace.length} · Remove {confirmation.plan.remove.length}
              </summary>
              <ul className="replacement-files">
                {(['create', 'replace', 'remove'] as const).flatMap((operation) =>
                  confirmation.plan![operation].map((file) => (
                    <li key={`${operation}:${file.root}:${file.path}`}>
                      <code>
                        {operation}: {file.root}/{file.path}
                      </code>
                    </li>
                  )),
                )}
              </ul>
              <p>Files marked “replace” will be backed up before the transaction commits.</p>
            </details>
          )}
          <div className="dialog-footer">
            <button className="button button-secondary" onClick={() => setConfirmation(undefined)}>
              Cancel
            </button>
            <button
              className={`button ${confirmation.action === 'uninstall' ? 'button-danger' : 'button-primary'}`}
              onClick={() =>
                void perform(
                  confirmation.id,
                  confirmation.action,
                  undefined,
                  confirmation.token,
                  confirmation.acceptedUnverified,
                )
              }
            >
              {confirmation.action === 'uninstall'
                ? 'Uninstall'
                : confirmation.action === 'adopt'
                  ? 'Adopt existing files'
                  : 'Back up & install'}
            </button>
          </div>
        </Dialog>
      )}
      {error && (
        <Dialog title="Let’s sort this out." onClose={() => setError(undefined)}>
          <div className="error-message" role="alert">
            <TriangleAlert size={23} />
            <p>{error.message}</p>
          </div>
          {error.conflicts?.map((conflict) => (
            <div className="conflict-item" key={`${conflict.root}:${conflict.path}`}>
              <strong>
                {conflict.root}/{conflict.path}
              </strong>
              <p>{conflict.reason}</p>
              {conflictAction?.action === 'uninstall' && (
                <label>
                  Keep your changes
                  <select
                    aria-label={`Resolution for ${conflict.path}`}
                    value={
                      decisions.find((d) => d.root === conflict.root && d.path === conflict.path)
                        ?.action ?? 'keep'
                    }
                    onChange={(e) =>
                      setDecisions((ds) =>
                        ds.map((d) =>
                          d.root === conflict.root && d.path === conflict.path
                            ? { ...d, action: e.target.value as 'keep' | 'restore' }
                            : d,
                        ),
                      )
                    }
                  >
                    <option value="keep">Keep current file</option>
                    {conflict.canRestore && (
                      <option value="restore">Restore original (overwrites current file)</option>
                    )}
                  </select>
                </label>
              )}
            </div>
          ))}
          {snapshot &&
            error.requirements?.map((requirement) => (
              <div
                className="conflict-item"
                key={`${requirement.id}:${requirement.versionConstraint}`}
              >
                <strong>{requirement.displayName}</strong>
                <p>{requirement.reason}</p>
                <PrerequisiteAction
                  requirement={requirement}
                  snapshot={snapshot}
                  requests={requests}
                  requestAction={(...args) => {
                    setError(undefined);
                    requestAction(...args);
                  }}
                  review={reviewRequirement}
                  openLink={openLink}
                />
              </div>
            ))}
          {error.details && (
            <details className="technical-details">
              <summary>Technical details</summary>
              <pre>{error.details}</pre>
            </details>
          )}
          {!!error.unverifiedPrerequisites?.length && conflictAction && (
            <p>
              Modatro cannot confirm that these installed prerequisite versions meet this mod’s
              requirements. Continuing may cause crashes or prevent mods from working. This choice
              applies only to this operation.
            </p>
          )}
          <div className="dialog-footer">
            <button className="button button-secondary" onClick={() => setError(undefined)}>
              Close
            </button>
            {error.conflicts?.length && conflictAction?.action === 'uninstall' ? (
              <button
                className="button button-danger"
                onClick={() => void perform(conflictAction.id, 'uninstall', decisions)}
              >
                Continue uninstall
              </button>
            ) : null}
            {error.retryable && conflictAction && (
              <button
                className="button button-primary"
                onClick={() => void perform(conflictAction.id, conflictAction.action)}
              >
                Check again
              </button>
            )}
            {!!error.unverifiedPrerequisites?.length && conflictAction && (
              <AsyncButton
                className="button button-danger"
                pending={working}
                pendingLabel="Continuing…"
                disabled={configuring}
                onClick={() =>
                  void perform(conflictAction.id, conflictAction.action, undefined, undefined, [
                    ...(conflictAction.acceptedUnverified ?? []),
                    ...error.unverifiedPrerequisites!.map(
                      ({ id, versionConstraint, installedVersion, packageId }) => ({
                        id,
                        versionConstraint,
                        installedVersion,
                        packageId,
                      }),
                    ),
                  ])
                }
              >
                Proceed at my own risk
              </AsyncButton>
            )}
          </div>
        </Dialog>
      )}
      {operationReport && (
        <Dialog title={operationReport.title} onClose={() => setOperationReport(undefined)}>
          {operationReport.retainedFiles.length > 0 && (
            <>
              <p>
                Your changed and untracked files were preserved. They are no longer managed by
                Modatro:
              </p>
              <ul>
                {operationReport.retainedFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {operationReport.cleanupProblems.length > 0 && (
            <>
              <p>Some cleanup could not finish:</p>
              <ul>
                {operationReport.cleanupProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-footer">
            <button className="button button-primary" onClick={() => setOperationReport(undefined)}>
              Done
            </button>
          </div>
        </Dialog>
      )}
      {about && snapshot && (
        <Dialog title="A little about Modatro." onClose={() => setAbout(false)}>
          <div className="about-brand">
            <span className="brand-mark">
              <Spade size={28} fill="currentColor" />
            </span>
            <div>
              <h3>modatro.</h3>
              <span>A better hand awaits.</span>
            </div>
          </div>
          <dl className="version-facts">
            <div>
              <dt>Modatro</dt>
              <dd>{snapshot.appVersion}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{snapshot.electronVersion}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>
                {snapshot.platform} / {snapshot.arch}
              </dd>
            </div>
            <div>
              <dt>Balatro</dt>
              <dd>{gameReady ? 'Validated' : 'Not connected'}</dd>
            </div>
            {snapshot.prerequisites
              .filter((p) => ['Lovely', 'Steamodded'].includes(p.id))
              .map((p) => (
                <div key={p.id}>
                  <dt>{p.displayName}</dt>
                  <dd>
                    {p.installed
                      ? (p.installedVersion ?? 'Installed · version unknown')
                      : 'Not installed'}
                  </dd>
                </div>
              ))}
          </dl>
          <p className="dialog-description">
            Modatro is an independent community project and is not affiliated with, endorsed by, or
            sponsored by LocalThunk or Playstack. Mod authors retain ownership of their mods.
            Modatro downloads directly from upstream sources and does not claim ownership. Authors
            may request removal; existing user copies are never remotely deleted.
          </p>
          <div className="about-links">
            {[
              ['Thunderstore Balatro catalogue', 'https://thunderstore.io/c/balatro/'],
              ['Lovely', 'https://github.com/ethangreen-dev/lovely-injector'],
              ['Steamodded', 'https://github.com/Steamodded/smods'],
              [
                'Content and removal policy',
                'https://github.com/NorthernBranch/modatro/blob/main/docs/content-policy.md',
              ],
            ].map(([label, url]) => (
              <AsyncButton
                className="text-button"
                key={url}
                disabled={requests.isBusy('external-link')}
                pending={requests.isPending(`link:${url}`)}
                pendingLabel="Opening…"
                onClick={() => void openLink(url!)}
              >
                {label}
                <ExternalLink size={13} />
              </AsyncButton>
            ))}
          </div>
          <p className="muted-text">
            Application updates are manual in this release. Download a new installer when an update
            is available.
          </p>
        </Dialog>
      )}
      {working && (
        <div className="operation-toast" role="status">
          <LoaderCircle size={18} className="spin" />
          <div>
            <strong>{requests.pending['mod-action']?.label}</strong>
            <span>
              {progress?.phase === 'downloading' && progress.percent !== undefined
                ? `${progress.percent}%`
                : (progress?.phase.replaceAll('-', ' ') ?? 'Preparing and checking files…')}
            </span>
          </div>
          {progress && ['downloading', 'validating', 'planning'].includes(progress.phase) && (
            <AsyncButton
              className="text-button"
              pending={requests.isPending('cancel')}
              pendingLabel="Cancelling…"
              onClick={() => void run('cancel', 'Cancelling download', () => api.cancel())}
            >
              Cancel
            </AsyncButton>
          )}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {Object.values(requests.pending)
          .map((request) => request.label)
          .join('. ') ||
          notification ||
          (progress ? `${progress.phase} ${progress.percent ?? ''}` : '')}
      </div>
      {notification && (
        <div className="notification">
          <span>
            <Check size={16} />
          </span>
          <p>{notification}</p>
          <button
            className="icon-button"
            onClick={() => setNotification(undefined)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function EyeIcon() {
  return <Info size={12} />;
}
