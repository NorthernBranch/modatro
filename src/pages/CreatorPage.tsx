import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, Save, Hammer, Download, Play } from 'lucide-react';
import { api } from '../api';
import { AsyncButton } from '../components/AsyncButton';
import { Dialog } from '../components/Dialog';
import { LuaEditor } from '../components/LuaEditor';
import { CreatorDescription } from '../components/CreatorDescription';
import { PageHeading } from '../components/PageElements';
import type { Requests } from '../hooks/useRequests';
import {
  CREATOR_DISCLAIMER,
  CREATOR_TARGET,
  CreatorDraftSchema,
  cropRectangle,
  type CreatorDraft,
  type CreatorProject,
  type CreatorRequest,
  type CreatorSummary,
} from '../shared/creator';
import { generateLua } from '../shared/creator-lua';
import {
  JokerBuilder,
  DeckBuilder,
  VoucherBuilder,
  ContentDescription,
} from '../components/CreatorBuilders';
import { type ContentType } from '../shared/creator-content';
import { artworkColours, builtinPixels } from '../shared/creator-artwork';
import type { ModAction, ModDefinition, Snapshot } from '../shared/model';

export function CreatorPage({
  snapshot,
  requests,
  onDirty,
  requestAction,
  launch,
}: {
  snapshot: Snapshot;
  requests: Requests;
  onDirty: (dirty: boolean) => void;
  requestAction: (id: string, action: ModAction, title: string, mod?: ModDefinition) => void;
  launch: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<CreatorSummary[]>([]);
  const [project, setProject] = useState<CreatorProject>();
  const [draft, setDraft] = useState<CreatorDraft>();
  const [newProject, setNewProject] = useState(false);
  const [name, setName] = useState('My first mod');
  const [author, setAuthor] = useState('');
  const [contentType, setContentType] = useState<ContentType | 'custom'>('joker');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => void;
  }>();
  const dirty = !!draft && !!project && JSON.stringify(draft) !== JSON.stringify(project.draft);
  const busy =
    requests.isBusy('creator') ||
    requests.isBusy('configuration') ||
    requests.isPending('mod-action');
  const run = requests.run;
  const call = useCallback(
    async (request: CreatorRequest, label: string) => {
      if (!api.creator) return;
      const reply = await run('creator', label, () => api.creator!(request), { group: 'creator' });
      if (reply?.ok) {
        setProjects(reply.value.projects);
        return reply.value;
      }
    },
    [run],
  );
  const accept = (next: CreatorProject) => {
    setProject(next);
    setDraft(structuredClone(next.draft));
  };
  useEffect(() => {
    void call({ operation: 'list' }, 'Loading projects');
  }, [call]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  function guard(action: () => void) {
    if (dirty)
      setConfirm({
        title: 'Discard unsaved changes?',
        description: 'Your last saved draft and installed build will be kept.',
        action,
      });
    else action();
  }
  function update<K extends keyof CreatorDraft>(key: K, value: CreatorDraft[K]) {
    setDraft((old) => old && { ...old, [key]: value });
    setMessage('');
  }
  async function save(regenerate = false, input = draft) {
    if (!project || !input) return;
    const result = await call(
      { operation: 'save', id: project.id, token: project.token, draft: input, regenerate },
      'Saving draft',
    );
    if (result?.project) {
      accept(result.project);
      setMessage('Draft saved. Installed files are unchanged.');
      return result.project;
    }
  }
  async function load(id: string) {
    const result = await call({ operation: 'load', id }, 'Loading project');
    if (result?.project) {
      accept(result.project);
      setMessage('');
    }
  }
  async function artwork(operation: 'import-art' | 'reset-art') {
    if (!project) return;
    const result = await call(
      { operation, id: project.id, token: project.token },
      operation === 'import-art' ? 'Importing artwork' : 'Restoring placeholder',
    );
    if (result?.project) accept(result.project);
  }
  async function install(buildId: string) {
    if (!project) return;
    const result = await call(
      { operation: 'prepare-install', id: project.id, buildId },
      'Preparing local build',
    );
    if (result?.definition)
      requestAction(
        result.definition.id,
        installed ? 'update' : 'install',
        result.definition.title,
        result.definition,
      );
  }
  const installed = snapshot.localMods.find(
    (mod) => mod.provenance?.creator?.projectId === project?.id,
  );
  const latest = project?.builds.at(-1);
  const validation = draft ? CreatorDraftSchema.safeParse(draft) : undefined;
  const code =
    draft?.mode === 'template' && validation?.success ? generateLua(draft) : (draft?.lua ?? '');
  const typeLabel =
    draft?.mode === 'custom'
      ? 'Custom Lua'
      : draft?.content.type === 'deck'
        ? 'Deck'
        : draft?.content.type === 'voucher'
          ? 'Voucher'
          : draft?.content.type === 'blank'
            ? 'Legacy blank mod'
            : 'Joker';
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!project || !draft) return;
    if (draft.artwork.source === 'builtin' && canvas.current) {
      canvas.current
        .getContext('2d')
        ?.putImageData(
          new ImageData(new Uint8ClampedArray(builtinPixels(draft.artwork.builtinId)), 71, 95),
          0,
          0,
        );
      return;
    }
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active || !canvas.current) return;
      const context = canvas.current.getContext('2d');
      if (!context) return;
      const r =
        draft.artwork.source === 'upload' && project.artwork
          ? cropRectangle(image.width, image.height, draft.crop)
          : { x: 0, y: 0, width: image.width, height: image.height };
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, 71, 95);
      context.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, 71, 95);
    };
    image.src = draft.artwork.source === 'upload' ? project.artwork!.dataUrl : project.previewUrl;
    return () => {
      active = false;
    };
  }, [project, draft]);
  return (
    <>
      <PageHeading
        eyebrow="EXPERIMENTAL · LOCAL ONLY"
        title="Make a little something."
        description="Create → Save draft → Build → Install → Launch Balatro → Edit → Install changes."
        action={
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => guard(() => setNewProject(true))}
          >
            <Plus size={15} /> New project
          </button>
        }
      />
      <details className="creator-disclaimer">
        <summary>Before testing your mod</summary>
        <p>{CREATOR_DISCLAIMER}</p>
        <p>
          Guided builders target Steamodded {CREATOR_TARGET} and require Lovely. Static validation
          does not verify game behaviour.
        </p>
      </details>
      <div className="creator-layout">
        <aside className="creator-projects" aria-label="Local projects">
          <h2>Your projects</h2>
          {!projects.length && (
            <p className="muted-text">
              Create a Joker, a Deck or a Voucher. Your existing projects stay available.
            </p>
          )}
          {projects.map((item) => (
            <button
              key={item.id}
              className={`creator-project ${project?.id === item.id ? 'selected' : ''}`}
              disabled={busy}
              aria-pressed={project?.id === item.id}
              onClick={() => guard(() => void load(item.id))}
            >
              <strong>{item.name}</strong>
              <span>
                {item.builds} {item.builds === 1 ? 'build' : 'builds'}
                {item.installedBuild ? ' · Installed' : ''}
              </span>
            </button>
          ))}
        </aside>
        {project && draft ? (
          <div className="creator-workspace">
            <section className="creator-section">
              <div className="creator-section-heading">
                <div>
                  <h2>{project.draft.name}</h2>
                  <p role="status">
                    {dirty ? 'Unsaved changes' : 'Draft saved'} · Experimental local mod
                  </p>
                </div>
                <AsyncButton
                  className="text-button"
                  pending={requests.isPending('creator')}
                  pendingLabel="Working…"
                  disabled={busy}
                  onClick={() =>
                    void call({ operation: 'open', id: project.id }, 'Opening project folder')
                  }
                >
                  <FolderOpen size={15} /> Open project folder
                </AsyncButton>
              </div>
              {project.externalChanges && (
                <div className="banner subtle">
                  main.lua changed externally. It was loaded as custom code; save the draft before
                  building.
                </div>
              )}
              <details className="creator-metadata" open={draft.mode === 'custom'}>
                <summary>Mod metadata</summary>
                <div className="creator-fields">
                  <label>
                    Mod name
                    <input
                      value={draft.name}
                      maxLength={80}
                      disabled={busy}
                      onChange={(e) => update('name', e.target.value)}
                    />
                  </label>
                  <label>
                    Author
                    <input
                      value={draft.author}
                      maxLength={80}
                      disabled={busy}
                      onChange={(e) => update('author', e.target.value)}
                    />
                  </label>
                  <label className="creator-wide">
                    Mod description
                    <textarea
                      aria-label="Mod description"
                      rows={3}
                      value={draft.description}
                      maxLength={2000}
                      disabled={busy}
                      onChange={(e) => update('description', e.target.value)}
                    />
                  </label>
                  <label>
                    Version
                    <input
                      value={draft.version}
                      disabled={busy}
                      onChange={(e) => update('version', e.target.value)}
                    />
                    <small>Three numbers, for example 1.0.0</small>
                  </label>
                </div>
                <details className="creator-advanced">
                  <summary>Advanced identity</summary>
                  <p>
                    Generated once. IDs and prefixes become fixed after the first build so updates
                    keep their ownership.
                  </p>
                  <div className="creator-fields">
                    <label>
                      Mod ID
                      <input
                        value={draft.modId}
                        disabled={busy || !!project.builds.length}
                        onChange={(e) => update('modId', e.target.value)}
                      />
                    </label>
                    <label>
                      Prefix
                      <input
                        value={draft.prefix}
                        disabled={busy || !!project.builds.length}
                        onChange={(e) => update('prefix', e.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </details>
            </section>
            <section className="creator-section">
              <div className="creator-section-heading">
                <h2>{draft.mode === 'template' ? 'Guided builder' : 'Custom Lua workspace'}</h2>
                {draft.content.type !== 'blank' && (
                  <button
                    className="button button-secondary"
                    disabled={busy || !validation?.success}
                    onClick={() => {
                      if (draft.mode === 'template')
                        setDraft({ ...draft, mode: 'custom', lua: code });
                      else
                        setConfirm({
                          title: 'Regenerate from template?',
                          description:
                            'Custom code cannot be converted to form controls. The current custom source will be saved in project history before template code replaces it.',
                          action: () => {
                            void (async () => {
                              const saved = await save(false, draft);
                              if (saved) {
                                const result = await call(
                                  {
                                    operation: 'save',
                                    id: saved.id,
                                    token: saved.token,
                                    draft: { ...saved.draft, mode: 'template' },
                                    regenerate: true,
                                  },
                                  'Regenerating template',
                                );
                                if (result?.project) accept(result.project);
                              }
                            })();
                          },
                        });
                    }}
                  >
                    {draft.mode === 'template' ? 'Use Custom Lua' : 'Return to guided builder'}
                  </button>
                )}
              </div>
              {draft.mode === 'template' ? (
                <>
                  <fieldset className="creator-builder" disabled={busy}>
                    <h2>{typeLabel} builder</h2>
                    <p>One content type per project. Create a new project for a different type.</p>
                    <label>
                      {typeLabel} name
                      <input
                        value={draft.content.name}
                        maxLength={80}
                        onChange={(e) =>
                          update('content', { ...draft.content, name: e.target.value })
                        }
                      />
                    </label>
                    <>
                      {draft.content.type === 'joker' && (
                        <JokerBuilder
                          value={draft.content}
                          onChange={(value) => update('content', value)}
                        />
                      )}
                      {draft.content.type === 'deck' && (
                        <DeckBuilder
                          value={draft.content}
                          onChange={(value) => update('content', value)}
                        />
                      )}
                      {draft.content.type === 'voucher' && (
                        <VoucherBuilder
                          value={draft.content}
                          onChange={(value) => update('content', value)}
                        />
                      )}
                      <ContentDescription
                        content={draft.content}
                        onChange={(value) => update('content', value)}
                      />
                    </>
                  </fieldset>
                </>
              ) : (
                <p className="muted-text">
                  Write and edit your own trusted Lua for any Steamodded mod. No guided settings are
                  applied in this mode. Editing metadata or artwork never regenerates your source.
                  Modatro checks LuaJIT syntax without executing code. Install any additional
                  dependencies manually.
                </p>
              )}
              <LuaEditor
                source={code}
                readOnly={draft.mode === 'template' || busy}
                onChange={(value) => update('lua', value)}
              />
            </section>
            <details className="creator-section" open={draft.mode === 'template'}>
              <summary>
                {draft.mode === 'custom' ? 'Optional bundled atlas artwork' : 'Artwork selection'}
              </summary>
              <h2>{typeLabel === 'Deck' ? 'Deck back' : typeLabel + ' artwork'}</h2>
              <div className="creator-artwork-options">
                <button
                  className="button button-secondary"
                  aria-pressed={draft.artwork.source !== 'upload'}
                  disabled={busy}
                  onClick={() => update('artwork', { ...draft.artwork, source: 'builtin' })}
                >
                  Built-in artwork
                </button>
                <button
                  className="button button-secondary"
                  aria-pressed={draft.artwork.source === 'upload'}
                  disabled={busy || (dirty && !project.artwork)}
                  onClick={() =>
                    project.artwork
                      ? update('artwork', { ...draft.artwork, source: 'upload' })
                      : void artwork('import-art')
                  }
                >
                  Upload your own
                </button>
              </div>
              <div className="creator-art-grid" aria-label={typeLabel + ' built-in artwork'}>
                {artworkColours.map((colour, index) => {
                  const id =
                    (draft.content.type === 'blank' ? 'joker' : draft.content.type) +
                    '-' +
                    (index + 1);
                  return (
                    <button
                      key={id}
                      className="creator-art-choice"
                      aria-label={colour + ' ' + typeLabel + ' artwork'}
                      aria-pressed={
                        draft.artwork.source === 'builtin' && draft.artwork.builtinId === id
                      }
                      disabled={busy}
                      onClick={() => update('artwork', { source: 'builtin', builtinId: id })}
                    >
                      <img src={'/creator-art/' + id + '.png'} alt="" width={71} height={95} />
                      <span>{colour}</span>
                    </button>
                  );
                })}
              </div>
              {draft.artwork.source === 'legacy' && (
                <p className="muted-text">
                  Legacy placeholder preserved. Choose a built-in design or upload to replace it
                  explicitly.
                </p>
              )}
              <div className="creator-artwork">
                <div className="creator-card-preview">
                  <canvas
                    ref={canvas}
                    width={71}
                    height={95}
                    aria-label="Card artwork preview at 71 by 95 pixels"
                  />
                  <span>Actual size · 71 × 95</span>
                </div>
                <div className="creator-art-controls">
                  <p>
                    {draft.artwork.source === 'upload' && project.artwork
                      ? `Original PNG · ${project.artwork.width} × ${project.artwork.height}. Kept in the project for recropping.`
                      : 'Placeholder artwork—replace whenever you’re ready.'}
                  </p>
                  <p className="muted-text">
                    PNG up to 8 MiB and 2048 × 2048 pixels. Transparency is preserved. Builds
                    include 1× and 2× atlases resized with nearest-neighbour sampling.
                  </p>
                  <div className="creator-actions">
                    <button
                      className="button button-secondary"
                      disabled={busy || dirty}
                      onClick={() => void artwork('import-art')}
                    >
                      {project.artwork ? 'Replace artwork' : 'Import PNG'}
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || dirty}
                      onClick={() => void artwork('reset-art')}
                    >
                      Reset to built-in artwork
                    </button>
                  </div>
                  {dirty && (
                    <p className="muted-text">
                      Save the draft before importing or resetting artwork.
                    </p>
                  )}
                  {draft.artwork.source === 'upload' &&
                    project.artwork &&
                    (['zoom', 'x', 'y'] as const).map((key) => (
                      <label className="creator-range" key={key}>
                        {key === 'zoom'
                          ? 'Zoom'
                          : key === 'x'
                            ? 'Horizontal crop'
                            : 'Vertical crop'}
                        <input
                          type="range"
                          min={key === 'zoom' ? 1 : 0}
                          max={key === 'zoom' ? 8 : 1}
                          step={0.01}
                          value={draft.crop[key]}
                          disabled={busy}
                          onChange={(e) =>
                            update('crop', { ...draft.crop, [key]: Number(e.target.value) })
                          }
                        />
                      </label>
                    ))}
                </div>
              </div>
            </details>
            <section className="creator-section">
              <h2>{typeLabel} preview and build</h2>
              <p className="creator-rule-summary">
                {draft.mode === 'custom' ? draft.name : draft.content.name}
                {draft.mode === 'template' &&
                  (draft.content.type === 'joker'
                    ? ' / ' + draft.content.rarity + ' / $' + draft.content.cost
                    : draft.content.type === 'voucher'
                      ? ' / $' + draft.content.cost
                      : '')}
              </p>
              {draft.mode === 'custom' ? (
                <p className="creator-rule-summary">
                  Custom Lua: configuration is not a simulation of your code.
                </p>
              ) : (
                <CreatorDescription content={draft.content} />
              )}
              <p>
                Saving changes your project only. Install a build explicitly, then launch the game
                to test it. Close Balatro before installing changes.
              </p>
              {validation && !validation.success && (
                <ul className="creator-validation" role="alert">
                  {validation.error.issues.map((issue, i) => (
                    <li key={i}>
                      {issue.path.join('.')}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="creator-actions">
                <AsyncButton
                  className="button button-secondary"
                  pending={requests.isPending('creator')}
                  pendingLabel="Working…"
                  disabled={busy || !validation?.success}
                  onClick={() => void save()}
                >
                  <Save size={15} /> Save draft
                </AsyncButton>
                <button
                  className="button button-primary"
                  disabled={busy || dirty}
                  onClick={() =>
                    void call(
                      { operation: 'build', id: project.id, token: project.token },
                      'Building mod',
                    ).then((result) => {
                      if (result?.project) {
                        accept(result.project);
                        setMessage(
                          'Build created. Validation passed for syntax and package structure; no in-game test has run.',
                        );
                      }
                    })
                  }
                >
                  <Hammer size={15} /> Build mod
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy || !latest}
                  onClick={() => latest && void install(latest.id)}
                >
                  {installed ? 'Install changes' : 'Install build'}
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy || !snapshot.settings.gamePath}
                  onClick={() => void launch()}
                >
                  <Play size={15} /> Launch Balatro
                </button>
              </div>
              {latest && (
                <p className="muted-text">
                  Build created · revision {latest.revision}, version {latest.version}
                  {installed?.provenance?.creator?.buildId === latest.id
                    ? ' · Installed'
                    : ' · Latest build is not installed'}
                </p>
              )}
              {installed && (
                <p className="muted-text">
                  Installed build: {installed.provenance?.creator?.buildId.slice(0, 12)} · Manage
                  enable, disable and uninstall on Installed.
                </p>
              )}
              {message && (
                <p className="creator-result" role="status">
                  {message}
                </p>
              )}
              {!!project.builds.length && (
                <details className="creator-history">
                  <summary>Build history and export · {project.builds.length}</summary>
                  <p>
                    Older builds stay available for restoration. Installing one replaces the
                    installed copy through the normal file checks and recovery workflow. Unsaved
                    draft edits are excluded.
                  </p>
                  {[...project.builds].reverse().map((build) => (
                    <div className="creator-build" key={build.id}>
                      <div>
                        <strong>
                          Revision {build.revision} · {build.version}
                        </strong>
                        <span>
                          {new Date(build.createdAt).toLocaleString()} · {build.id.slice(0, 12)}
                          {installed?.provenance?.creator?.buildId === build.id
                            ? ' · Installed'
                            : ''}
                        </span>
                      </div>
                      <div className="creator-actions">
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void install(build.id)}
                        >
                          Install this build
                        </button>
                        <button
                          className="button button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void call(
                              { operation: 'export', id: project.id, buildId: build.id },
                              'Exporting ZIP',
                            ).then((result) => {
                              if (result?.exported)
                                setMessage(
                                  'Built mod ZIP exported. Editor state and originals were excluded.',
                                );
                            })
                          }
                        >
                          <Download size={14} /> Export ZIP
                        </button>
                      </div>
                    </div>
                  ))}
                </details>
              )}
            </section>
            <section className="creator-section">
              <h2>Project files</h2>
              <p>
                External edits to main.lua are detected when reloading or saving. Keep unsaved
                editor text elsewhere before reloading. Open the folder to recover previous custom
                source from history.
              </p>
              <div className="creator-actions">
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => guard(() => void load(project.id))}
                >
                  Reload from disk
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      title: 'Archive this project?',
                      description:
                        'The editable project moves to Modatro’s local recovery archive. Its installed mod and immutable build ZIPs are kept. Uninstall separately from Installed.',
                      action: () =>
                        void call(
                          { operation: 'delete', id: project.id, token: project.token },
                          'Archiving project',
                        ).then((result) => {
                          if (result) {
                            setProject(undefined);
                            setDraft(undefined);
                            setMessage('');
                          }
                        }),
                    })
                  }
                >
                  Archive project
                </button>
              </div>
            </section>
          </div>
        ) : (
          <section className="creator-section creator-empty">
            <h2>A small idea is a good start.</h2>
            <p>
              Choose a project or create one. Keep a backup of your Balatro saves before testing.
            </p>
          </section>
        )}
      </div>
      {newProject && (
        <Dialog title="Create a local mod" dismissible={!busy} onClose={() => setNewProject(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void call(
                { operation: 'create', name, author, contentType },
                'Creating project',
              ).then((result) => {
                if (result?.project) {
                  accept(result.project);
                  setNewProject(false);
                  setMessage('Draft saved. Build it when you’re ready.');
                }
              });
            }}
          >
            <div className="creator-fields">
              <label>
                Mod name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Author
                <input
                  required
                  maxLength={80}
                  value={author}
                  disabled={busy}
                  onChange={(e) => setAuthor(e.target.value)}
                />
              </label>
              <fieldset className="creator-wide creator-type-choice">
                <legend>What would you like to create?</legend>
                {(['joker', 'deck', 'voucher', 'custom'] as const).map((type) => (
                  <label key={type}>
                    <input
                      type="radio"
                      name="content-type"
                      checked={contentType === type}
                      disabled={busy}
                      onChange={() => setContentType(type)}
                    />
                    {type === 'custom'
                      ? 'Custom Lua'
                      : 'Create a ' +
                        (type === 'joker' ? 'Joker' : type === 'deck' ? 'Deck' : 'Voucher')}
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => setNewProject(false)}
              >
                Cancel
              </button>
              <AsyncButton
                type="submit"
                className="button button-primary"
                pending={requests.isPending('creator')}
                pendingLabel="Creating…"
                disabled={busy || !name.trim() || !author.trim()}
              >
                Create project
              </AsyncButton>
            </div>
          </form>
        </Dialog>
      )}
      {confirm && (
        <Dialog title={confirm.title} dismissible={!busy} onClose={() => setConfirm(undefined)}>
          <p className="dialog-description">{confirm.description}</p>
          <div className="dialog-footer">
            <button className="button button-secondary" onClick={() => setConfirm(undefined)}>
              Keep editing
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => {
                const action = confirm.action;
                setConfirm(undefined);
                action();
              }}
            >
              Continue
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
