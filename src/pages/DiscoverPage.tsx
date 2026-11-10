import {
  ArrowUpRight,
  ExternalLink,
  Grid2X2,
  Info,
  List,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  useRef,
  useMemo,
  useDeferredValue,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { AsyncButton } from '../components/AsyncButton';
import { api } from '../api';
import { ModCard } from '../components/ModCard';
import { EmptyState } from '../components/PageElements';
import type { AppError, ModDefinition, Snapshot } from '../shared/model';
import { plainText } from '../shared/presentation';
import { allowedDescription } from '../shared/trust';
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
  const mac =
    snapshot?.platform === 'darwin' ||
    ((!snapshot || snapshot.platform === 'browser') && /Mac/i.test(navigator.platform));
  const mods = useMemo(
    () =>
      (snapshot?.catalogue.mods ?? []).filter(
        (mod) =>
          !mod.creator &&
          mod.permissions?.display !== false &&
          (!mod.deprecated ||
            snapshot?.localMods.some(
              (local) => local.id === mod.id || local.catalogueId === mod.id,
            )) &&
          !['opted-out', 'blocked'].includes(mod.approvalStatus ?? 'legacy-index'),
      ),
    [snapshot?.catalogue.mods, snapshot?.localMods],
  );
  const installed = useMemo(() => snapshot?.localMods ?? [], [snapshot?.localMods]);
  const installedIds = useMemo(() => new Set(installed.map((m) => m.id)), [installed]);
  const updateIds = useMemo(
    () => new Set(installed.filter((m) => m.state === 'update-available').map((m) => m.id)),
    [installed],
  );
  const searchText = useMemo(
    () =>
      new Map(
        mods.map((mod) => [
          mod.id,
          `${mod.title} ${mod.author} ${plainText(allowedDescription(mod))}`.toLowerCase(),
        ]),
      ),
    [mods],
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All mods');
  const [filter, setFilter] = useState('all');
  const [author, setAuthor] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('default');
  const [stars, setStars] = useState<Record<string, number>>({});
  const catalogueKey = useMemo(
    () => mods.map((mod) => `${mod.id}:${mod.repositoryUrl ?? ''}`).join('|'),
    [mods],
  );
  useEffect(() => {
    let cancelled = false;
    setStars({});
    if (!snapshot?.preview && api.githubStars) {
      void api
        .githubStars()
        .then((reply) => {
          if (!cancelled && reply.ok) setStars(reply.value);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [catalogueKey, snapshot?.catalogue.fetchedAt, snapshot?.preview]);
  const [limit, setLimit] = useState(60);
  useEffect(() => setLimit(60), [query, category, author, filter, sort]);
  const catalogueRef = useRef<HTMLElement>(null);
  const needle = useDeferredValue(query.trim().toLowerCase());
  const visible = useMemo(() => {
    const result = mods.filter(
      (mod) =>
        (!needle || searchText.get(mod.id)?.includes(needle)) &&
        (category === 'All mods' || mod.categories.includes(category)) &&
        (author === 'all' || mod.author === author) &&
        (filter === 'all' ||
          (filter === 'installed'
            ? installedIds.has(mod.id)
            : filter === 'updates'
              ? updateIds.has(mod.id)
              : !installedIds.has(mod.id))),
    );
    if (sort === 'popular')
      result.sort(
        (a, b) => (stars[b.id] ?? -1) - (stars[a.id] ?? -1) || a.title.localeCompare(b.title),
      );
    if (sort === 'name') result.sort((a, b) => a.title.localeCompare(b.title));
    return result;
  }, [mods, searchText, needle, category, author, filter, installedIds, updateIds, sort, stars]);
  const categories = useMemo(
    () => [
      'All mods',
      ...[...new Set(mods.flatMap((m) => m.categories))].sort((a, b) => a.localeCompare(b)),
    ],
    [mods],
  );
  const authors = useMemo(() => [...new Set(mods.map((m) => m.author))].sort(), [mods]);
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Make the game
            <br />
            your own<span>.</span>
          </h1>
          <p>Find, install and manage your Balatro mods in one place.</p>
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
              aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
            />
            <kbd>{mac ? '⌘ K' : 'Ctrl K'}</kbd>
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
          <select
            aria-label="Sort mods"
            className="mod-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="default">Default order</option>
            <option value="popular">Popularity · GitHub stars</option>
            <option value="name">Name A–Z</option>
          </select>
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
                {authors.map((a) => (
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
              ? `${visible.length} ${visible.length === 1 ? 'result' : 'results'} for “${query}”`
              : `${visible.length} ${category === 'All mods' ? '' : `${category.toLowerCase()} `}${visible.length === 1 ? 'mod' : 'mods'}`}
          </span>
          <span>
            {snapshot?.preview
              ? 'Preview from Thunderstore'
              : snapshot?.settings.modIndexUrl
                ? 'Thunderstore + additional index'
                : 'Source: Thunderstore'}
            <ExternalLink size={11} />
          </span>
        </div>
        {sort === 'popular' && (
          <p className="muted-text">
            Popularity uses GitHub repository stars. Mods without a known count appear last.
          </p>
        )}
        {!snapshot ? (
          <div className="mod-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="mod-card skeleton" aria-label="Loading mods" />
            ))}
          </div>
        ) : visible.length ? (
          <div className={view === 'grid' ? 'mod-grid' : 'mod-list'}>
            {visible.slice(0, limit).map((mod) => (
              <ModCard
                key={mod.id}
                mod={mod}
                list={view === 'list'}
                stars={stars[mod.id]}
                onSelect={setSelected}
                action={buttonFor(mod, true)}
              />
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
        {visible.length > limit && (
          <button
            className="button button-secondary"
            onClick={() => setLimit((value) => value + 60)}
          >
            Show more mods ({visible.length - limit} remaining)
          </button>
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
