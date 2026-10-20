import {
  descriptionLines,
  descriptionSegments,
  localizedDescription,
} from '../shared/creator-description';
import type { CreatorContent } from '../shared/creator-content';

export function CreatorDescription({ content }: { content: CreatorContent }) {
  return (
    <div
      className="creator-description-preview"
      role="group"
      aria-label="In-game description styling preview"
    >
      {descriptionLines(localizedDescription(content)).map((line, i) => (
        <div key={i}>
          {descriptionSegments(line).map((segment, j) => (
            <span
              key={j}
              className={[
                segment.colour && `creator-loc-${segment.colour}`,
                segment.background && `creator-loc-bg-${segment.background}`,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {segment.text}
            </span>
          ))}
          {!line && <br />}
        </div>
      ))}
    </div>
  );
}
