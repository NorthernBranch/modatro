import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, Save, Hammer, Download, Play } from 'lucide-react';
import { api } from '../api';
import { AsyncButton } from '../components/AsyncButton';
import { Dialog } from '../components/Dialog';
import { LuaEditor } from '../components/LuaEditor';
import { PageHeading } from '../components/PageElements';
import type { Requests } from '../hooks/useRequests';
import {
  CREATOR_DISCLAIMER,
  CREATOR_TARGET,
  CreatorDraftSchema,
  cropRectangle,
  recipeDescription,
  recipes,
  type CreatorDraft,
  type CreatorProject,
  type CreatorRequest,
  type CreatorSummary,
} from '../shared/creator';
import { generateLua } from '../shared/creator-lua';
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
  const [name, setName] = useState('My first Joker');
  const [author, setAuthor] = useState('');
  const [recipe, setRecipe] = useState<CreatorDraft['recipe']>('joker-mult');
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
  const code = draft?.mode === 'template' ? generateLua(draft) : (draft?.lua ?? '');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!project || !draft) return;
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active || !canvas.current) return;
      const context = canvas.current.getContext('2d');
      if (!context) return;
      const r = project.artwork
        ? cropRectangle(image.width, image.height, draft.crop)
        : { x: 0, y: 0, width: image.width, height: image.height };
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, 71, 95);
      context.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, 71, 95);
    };
    image.src = project.artwork?.dataUrl ?? project.previewUrl;
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
          Templates target Steamodded {CREATOR_TARGET} and require Lovely. Static validation does
          not verify game behaviour.
        </p>
      </details>
      <div className="creator-layout">
        <aside className="creator-projects" aria-label="Local projects">
          <h2>Your projects</h2>
          {!projects.length && (
            <p className="muted-text">Start with a small Joker, a deck or a blank mod.</p>
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
                  Description
                  <textarea
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
            </section>
            <section className="creator-section">
              <div className="creator-section-heading">
                <h2>{draft.mode === 'template' ? 'Template' : 'Custom code'}</h2>
                <button
                  className="button button-secondary"
                  disabled={busy}
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
                  {draft.mode === 'template' ? 'Edit custom Lua' : 'Return to template'}
                </button>
              </div>
              {draft.mode === 'template' ? (
                <>
                  <div className="creator-fields">
                    <label>
                      Recipe
                      <select
                        disabled={busy}
                        value={draft.recipe}
                        onChange={(e) => update('recipe', e.target.value as CreatorDraft['recipe'])}
                      >
                        {recipes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {draft.recipe.startsWith('joker-') && (
                      <label>
                        {draft.recipe === 'joker-chips' ? 'Chips' : 'Mult'}
                        <input
                          type="number"
                          min={0}
                          max={draft.recipe === 'joker-chips' ? 100000 : 1000}
                          step={1}
                          value={draft.amount}
                          disabled={busy}
                          onChange={(e) => update('amount', Number(e.target.value))}
                        />
                      </label>
                    )}
                    {draft.recipe === 'joker-suit' && (
                      <label>
                        Scored suit
                        <select
                          value={draft.suit}
                          disabled={busy}
                          onChange={(e) => update('suit', e.target.value as CreatorDraft['suit'])}
                        >
                          {['Hearts', 'Diamonds', 'Clubs', 'Spades'].map((suit) => (
                            <option key={suit}>{suit}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {draft.recipe === 'deck' &&
                      (['dollars', 'hands', 'discards'] as const).map((key) => (
                        <label key={key}>
                          Bonus {key}
                          <input
                            type="number"
                            min={0}
                            max={key === 'dollars' ? 1000 : 10}
                            step={1}
                            value={draft[key]}
                            disabled={busy}
                            onChange={(e) => update(key, Number(e.target.value))}
                          />
                        </label>
                      ))}
                  </div>
                  <p className="muted-text">{recipeDescription(draft)}</p>
                  <p className="muted-text">
                    Whole nonnegative bonuses only. Creator limits: 1,000 Mult, 100,000 Chips,
                    $1,000 and 10 extra hands/discards. These limits do not guarantee balance or
                    compatibility.
                  </p>
                </>
              ) : (
                <p className="muted-text">
                  Paste only code you trust. A fragment may need surrounding code and additional
                  dependencies. Modatro parses LuaJIT syntax; it never runs your Lua. Recipe
                  controls do not rewrite custom code.
                </p>
              )}
              <LuaEditor
                source={code}
                readOnly={draft.mode === 'template' || busy}
                onChange={(value) => update('lua', value)}
              />
            </section>
            <section className="creator-section">
              <h2>{draft.recipe === 'deck' ? 'Deck-back artwork' : 'Card artwork'}</h2>
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
                    {project.artwork
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
                      disabled={busy || dirty || !project.artwork}
                      onClick={() => void artwork('reset-art')}
                    >
                      Reset to placeholder
                    </button>
                  </div>
                  {dirty && (
                    <p className="muted-text">
                      Save the draft before importing or resetting artwork.
                    </p>
                  )}
                  {project.artwork &&
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
            </section>
            <section className="creator-section">
              <h2>Save, build and test</h2>
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
              void call({ operation: 'create', name, author, recipe }, 'Creating project').then(
                (result) => {
                  if (result?.project) {
                    accept(result.project);
                    setNewProject(false);
                    setMessage('Draft saved. Build it when you’re ready.');
                  }
                },
              );
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
              <label className="creator-wide">
                Starting recipe
                <select
                  value={recipe}
                  disabled={busy}
                  onChange={(e) => setRecipe(e.target.value as CreatorDraft['recipe'])}
                >
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
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
