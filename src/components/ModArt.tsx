import {
  Clock3,
  Clover,
  Code2,
  Diamond,
  Eye,
  Layers3,
  Palette,
  Puzzle,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import type { ModDefinition } from '../shared/model';
import { useState } from 'react';
const icons = [
  Layers3,
  Sparkles,
  Eye,
  Palette,
  Puzzle,
  Clock3,
  Diamond,
  WandSparkles,
  Clover,
  Code2,
];
export function ModArt({ mod, large = false }: { mod: ModDefinition; large?: boolean }) {
  const [failed, setFailed] = useState<string>();
  const value = [...mod.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const Icon = icons[value % icons.length]!;
  return (
    <div aria-hidden="true" className={`mod-art art-${value % 6} ${large ? 'mod-art-large' : ''}`}>
      <div className="art-orbit" />
      {mod.iconUrl && failed !== mod.iconUrl ? (
        <img
          src={mod.iconUrl}
          loading="lazy"
          referrerPolicy="no-referrer"
          alt=""
          onError={() => setFailed(mod.iconUrl)}
          style={{
            width: large ? 80 : 48,
            height: large ? 80 : 48,
            objectFit: 'contain',
            zIndex: 1,
          }}
        />
      ) : (
        <Icon size={large ? 58 : 27} strokeWidth={1.6} />
      )}
      <span className="art-spark">✦</span>
    </div>
  );
}
