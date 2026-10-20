import { contentDescription, ruleSummary, type CreatorContent } from './creator-content';

// Only generated descriptions receive automatic styling. Manual localization is
// passed through unchanged; custom Lua is never decoded or regenerated here.
export function localizedDescription(content: CreatorContent): string {
  if (content.type !== 'joker' || content.manualDescription !== undefined)
    return contentDescription(content);
  return content.rules
    .map((rule) =>
      ruleSummary(rule, (text, style) =>
        style === 'xmult' ? `{X:mult,C:white}${text}{}` : `{C:${style}}${text}{}`,
      ),
    )
    .join('\n');
}

// Wrap by visible characters, never through a localization control or word.
// Each game localization line is parsed separately, so restore active styles.
export function descriptionLines(text: string, width = 32): string[] {
  return text.split('\n').flatMap((paragraph) => {
    const lines: string[] = [];
    let line = '',
      visible = 0,
      active = '',
      space = false;
    const finish = () => {
      lines.push(line.trimEnd() + (active ? '{}' : ''));
      line = active;
      visible = 0;
      space = false;
    };
    for (const token of paragraph.split(/(\{[^{}]*\}|\s+)/).filter(Boolean)) {
      if (/^\{[^{}]*\}$/.test(token)) {
        active = token === '{}' ? '' : token;
        line += token;
      } else if (/^\s+$/.test(token)) {
        space = visible > 0;
      } else {
        const length = [...token].length;
        if (visible && visible + (space ? 1 : 0) + length > width) finish();
        if (space) {
          line += ' ';
          visible++;
        }
        line += token;
        visible += length;
        space = false;
      }
    }
    if (visible || !lines.length) finish();
    return lines;
  });
}

export const descriptionColours = [
  'chips',
  'mult',
  'money',
  'attention',
  'white',
  'blue',
  'red',
  'green',
  'inactive',
] as const;
export interface DescriptionSegment {
  text: string;
  colour?: string;
  background?: string;
}
// A safe visual approximation of standard localization colours, not a game renderer.
// React escapes all text; localization can never introduce HTML, CSS or scripts.
export function descriptionSegments(line: string): DescriptionSegment[] {
  let colour: string | undefined, background: string | undefined;
  const result: DescriptionSegment[] = [];
  for (const token of line.split(/(\{[^{}]*\})/).filter(Boolean)) {
    if (/^\{[^{}]*\}$/.test(token)) {
      const controls = token.slice(1, -1).split(',');
      const allowed = (key: string) =>
        controls
          .map((c) => c.split(':'))
          .find(
            ([k, v]) => k === key && (descriptionColours as readonly string[]).includes(v!),
          )?.[1];
      colour = allowed('C');
      background = allowed('X');
    } else result.push({ text: token, colour, background });
  }
  return result;
}
