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
  const value = [...mod.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const Icon = icons[value % icons.length]!;
  return (
    <div aria-hidden="true" className={`mod-art art-${value % 6} ${large ? 'mod-art-large' : ''}`}>
      <div className="art-orbit" />
      <Icon size={large ? 58 : 27} strokeWidth={1.6} />
      <span className="art-spark">✦</span>
    </div>
  );
}
