import {
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  Grid2X2,
  Info,
  Layers3,
  List,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { AsyncButton } from '../components/AsyncButton';
import { ModArt } from '../components/ModArt';
import { EmptyState } from '../components/PageElements';
import type { AppError, ModDefinition, Snapshot } from '../shared/model';
import { plainText } from '../shared/presentation';
import { allowedDescription, approvalLabel } from '../shared/trust';
interface Props {
  snapshot?: Snapshot;
  searchRef: RefObject<HTMLInputElement | null>;
  setSelected: Dispatch<SetStateAction<ModDefinition | undefined>>;
  buttonFor: (mod: ModDefinition, compact?: boolean) => ReactNode;
  refresh: () => Promise<void>;
  refreshing: boolean;
  setError: Dispatch<SetStateAction<AppError | undefined>>;
}
export function DiscoverPage({
  snapshot,
  searchRef,
  setSelected,
  buttonFor,
  refresh,
  refreshing,
  setError,
}: Props) {
  const mods = (snapshot?.catalogue.mods ?? []).filter(
    (mod) =>
      mod.permissions?.display !== false &&
      !['opted-out', 'blocked'].includes(mod.approvalStatus ?? 'legacy-index'),
  );
  const installed = snapshot?.localMods ?? [];
  const updates = installed.filter((m) => m.state === 'update-available');
  const defaultCategories = [
    'All mods',
    'Content',
    'Jokers',
    'Quality of Life',
    'Resource Packs',
    'Extensions',
    'APIs',
    'Technical',
  ];
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All mods');
  const [filter, setFilter] = useState('all');
  const [author, setAuthor] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const catalogueRef = useRef<HTMLElement>(null);
  const visible = mods.filter(
    (mod) =>
      (!query ||
        `${mod.title} ${mod.author} ${plainText(allowedDescription(mod))}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (category === 'All mods' || mod.categories.includes(category)) &&
      (author === 'all' || mod.author === author) &&
      (filter === 'all' ||
        (filter === 'installed'
          ? installed.some((m) => m.id === mod.id)
          : filter === 'updates'
            ? updates.some((m) => m.id === mod.id)
            : !installed.some((m) => m.id === mod.id))),
  );
  const categories = [
    ...defaultCategories,
    ...new Set(mods.flatMap((m) => m.categories).filter((c) => !defaultCategories.includes(c))),
  ];
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span />A NEW HAND. A NEW POSSIBILITY.
          </div>
          <h1>
            Make the game
            <br />
            your own<span>.</span>
          </h1>
          <p>
            Fresh jokers. New possibilities. One place for all your mods.
            <br className="desktop-break" />
            Your next favourite run starts here.
          </p>
          <button
            className="button hero-button"
            onClick={() =>
              catalogueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            Find your next mod
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="hero-orbit orbit-one" />
          <div className="hero-orbit orbit-two" />
          <span className="hero-star star-one">✦</span>
          <span className="hero-star star-two">✧</span>
          <div className="playing-card card-back">
            <span>
              A<br />♠
            </span>
            <div>♠</div>
            <span>
              A<br />♠
            </span>
          </div>
          <div className="playing-card card-front">
            <span>
              J<br />✦
            </span>
            <div className="joker-face">
              <span className="jester-hat">♠</span>
              <span className="joker-eyes">• •</span>
              <span className="joker-smile">⌣</span>
            </div>
            <span>
              J<br />✦
            </span>
            <div className="card-caption">A LITTLE WILD</div>
          </div>
          <div className="art-label">
            <Sparkles size={13} />A better hand awaits
          </div>
        </div>
      </section>
      <section className="catalogue-section" ref={catalogueRef} aria-label="Mod catalogue">
        <div className="section-heading">
          <div>
            <h2>
              Discover mods<span className="count-pill">{mods.length}</span>
            </h2>
            <p>A whole new way to play your favourite game.</p>
          </div>
          <button
            className="text-button refresh-button"
            disabled={refreshing || snapshot?.catalogue.refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw
              size={14}
              className={refreshing || snapshot?.catalogue.refreshing ? 'spin' : ''}
            />
            {refreshing || snapshot?.catalogue.refreshing ? 'Refreshing…' : 'Refresh catalogue'}
          </button>
        </div>
        {snapshot?.catalogue.stale && !snapshot.preview && (
          <div className="banner subtle">
            <Info size={16} />
            <span>
              {snapshot.catalogue.error
                ? 'You’re browsing saved mods. The catalogue could not be refreshed.'
                : 'Showing your saved catalogue while we check for updates.'}
              {snapshot.catalogue.fetchedAt
                ? ` Showing catalogue from ${new Date(snapshot.catalogue.fetchedAt).toLocaleString()}.`
                : ' No successful refresh recorded.'}
            </span>
            {snapshot.catalogue.error && (
              <button
                className="text-button"
                onClick={() =>
                  setError({
                    message: snapshot.catalogue.error!,
                    details:
                      'The previous validated catalogue is preserved until a complete refresh succeeds.',
                  })
                }
              >
                Details
              </button>
            )}
          </div>
        )}
        {snapshot?.trust && !snapshot.trust.fresh && (
          <div className="banner subtle" role="status">
            <Info size={16} />
            <span>
              {snapshot.trust.error ??
                'Checking catalogue removals and release restrictions. Install and Update will become available after verification.'}
            </span>
          </div>
        )}
        <div className="catalogue-controls">
          <label className="search-field">
            <Search size={18} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search mods, creators, or something new…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search mods"
            />
            <kbd>⌘ K</kbd>
          </label>
          <button
            className={`button filter-button ${showFilters ? 'selected' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
          >
            <SlidersHorizontal size={16} />
            Filters
            {filter !== 'all' || author !== 'all' ? <span className="filter-dot" /> : null}
          </button>
          <div className="view-switch" role="group" aria-label="Catalogue view">
            <button
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <Grid2X2 size={17} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List size={18} />
            </button>
          </div>
        </div>
        {showFilters && (
          <div className="expanded-filters">
            <label>
              Installation
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All mods</option>
                <option value="installed">Installed</option>
                <option value="not-installed">Not installed</option>
                <option value="updates">Update available</option>
              </select>
            </label>
            <label>
              Creator
              <select value={author} onChange={(e) => setAuthor(e.target.value)}>
                <option value="all">All creators</option>
                {[...new Set(mods.map((m) => m.author))].sort().map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <button
              className="text-button"
              onClick={() => {
                setFilter('all');
                setAuthor('all');
              }}
            >
              Reset filters
            </button>
          </div>
        )}
        <div className="category-tabs" role="group" aria-label="Mod categories">
          {categories.map((c) => (
            <button
              key={c}
              aria-pressed={category === c}
              className={category === c ? 'selected' : ''}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="results-line">
          <span>
            {query
              ? `${visible.length} results for “${query}”`
              : category === 'All mods'
                ? 'A little of everything. A lot of possibilities.'
                : `Explore ${category.toLowerCase()} mods`}
          </span>
          <span>
            {snapshot?.preview
              ? 'Preview from Thunderstore'
              : 'From Thunderstore and registered GitHub projects'}
            <ExternalLink size={11} />
          </span>
        </div>
        {!snapshot ? (
          <div className="mod-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="mod-card skeleton" aria-label="Loading mods" />
            ))}
          </div>
        ) : visible.length ? (
          <div className={view === 'grid' ? 'mod-grid' : 'mod-list'}>
            {visible.map((mod) => (
              <article className={`mod-card ${view === 'list' ? 'list-card' : ''}`} key={mod.id}>
                <button
                  className="card-main"
                  onClick={() => setSelected(mod)}
                  aria-label={`Details for ${mod.title}`}
                >
                  <div className="card-top">
                    <ModArt mod={mod} />
                    <span className="category-tag">{mod.categories[0] ?? 'Miscellaneous'}</span>
                  </div>
                  <div className="mod-title-row">
                    <h3>{mod.title}</h3>
                    <ArrowUpRight size={16} />
                  </div>
                  <div className="mod-author">
                    by {mod.author}
                    <span title={`Version ${mod.version}`}>{mod.version}</span>
                  </div>
                  <p className="mod-description">
                    {plainText(allowedDescription(mod)) ||
                      'Explore this community-made addition to Balatro.'}
                  </p>
                  <span className="muted-text">{approvalLabel(mod)}</span>
                  <div className="requirement-badges">
                    {mod.prerequisites.length ? (
                      mod.prerequisites.slice(0, 2).map((p) => (
                        <span key={`${p.id}:${p.versionConstraint}`}>
                          <Layers3 size={11} />
                          {p.displayName}
                        </span>
                      ))
                    ) : (
                      <span className="no-requirements">No catalogue prerequisites</span>
                    )}
                  </div>
                </button>
                <div className="card-footer">
                  <button className="text-button" onClick={() => setSelected(mod)}>
                    View details
                    <ChevronRight size={13} />
                  </button>
                  {buttonFor(mod, true)}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Search}
            title={
              mods.length
                ? 'No mods found'
                : snapshot.catalogue.refreshing
                  ? 'Finding your next favourite mod'
                  : 'The catalogue isn’t here yet'
            }
            description={
              mods.length
                ? 'Try a different search or give another category a go.'
                : snapshot.catalogue.refreshing
                  ? 'We’re downloading and checking the Thunderstore catalogue.'
                  : 'Connect to the internet and refresh to load the Thunderstore catalogue.'
            }
            action={
              <AsyncButton
                className="button button-secondary"
                pending={!mods.length && refreshing}
                pendingLabel="Refreshing catalogue…"
                onClick={() => {
                  if (mods.length) {
                    setQuery('');
                    setCategory('All mods');
                    setFilter('all');
                    setAuthor('all');
                  } else void refresh();
                }}
              >
                {mods.length ? 'Clear filters' : 'Refresh catalogue'}
              </AsyncButton>
            }
          />
        )}
        <div className="catalogue-footer">
          <ShieldCheck size={14} />
          <span>
            Third-party mods are community creations. Modatro backs up every file it replaces.
          </span>
        </div>
      </section>
    </>
  );
}
