import { ArrowUpRight, ChevronRight, Layers3, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ModDefinition } from '../shared/model';
import { plainText } from '../shared/presentation';
import { allowedDescription, approvalLabel } from '../shared/trust';
import { ModArt } from './ModArt';

interface Props {
  mod: ModDefinition;
  list: boolean;
  stars?: number;
  onSelect: (mod: ModDefinition) => void;
  action: ReactNode;
}

export function ModCard({ mod, list, stars, onSelect, action }: Props) {
  return (
    <article className={`mod-card ${list ? 'list-card' : ''}`}>
      <button
        className="card-main"
        onClick={() => onSelect(mod)}
        aria-label={`Details for ${mod.title}`}
      >
        <div className="card-top">
          <ModArt mod={mod} />
          <span className="category-tag">{mod.categories[0] ?? 'Miscellaneous'}</span>
        </div>
        <div className="mod-title-row">
          <h3>{mod.title}</h3>
          {mod.repositoryUrl?.startsWith('https://github.com/') && (
            <span
              className="github-stars"
              title={
                stars === undefined
                  ? 'GitHub star count unavailable'
                  : `${stars.toLocaleString()} GitHub stars`
              }
              aria-label={
                stars === undefined ? 'GitHub stars unavailable' : `${stars} GitHub stars`
              }
            >
              <Star size={12} aria-hidden="true" />
              {stars === undefined
                ? '—'
                : Intl.NumberFormat(undefined, {
                    notation: 'compact',
                    maximumFractionDigits: 1,
                  }).format(stars)}
            </span>
          )}
          <ArrowUpRight size={16} />
        </div>
        <div className="mod-author">
          by {mod.author}
          <span title={`Version ${mod.version}`}>{mod.version}</span>
        </div>

        <p className="mod-description">
          {plainText(allowedDescription(mod)) || 'Explore this community-made addition to Balatro.'}
        </p>
        <span className="muted-text">{approvalLabel(mod)}</span>
        {mod.deprecated && <span className="state-badge missing">Installed · Deprecated</span>}
        <div className="requirement-badges">
          {mod.prerequisites.slice(0, 2).map((p) => (
            <span key={`${p.id}:${p.versionConstraint}`}>
              <Layers3 size={11} />
              {p.displayName}
            </span>
          ))}
        </div>
      </button>
      <div className="card-footer">
        <button className="text-button" onClick={() => onSelect(mod)}>
          View details
          <ChevronRight size={13} />
        </button>
        {action}
      </div>
    </article>
  );
}
