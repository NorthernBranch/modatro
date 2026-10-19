import luaparse from 'luaparse';
import { CREATOR_TARGET, type CreatorDraft } from './creator';

export function luaString(value: string) {
  return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, (ch) => (ch === '\\' ? '\\\\' : ch === '"' ? '\\"' : `\\${ch.charCodeAt(0).toString().padStart(3, '0')}`))}"`;
}
export interface LuaDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}
export function luaDiagnostics(source: string): LuaDiagnostic[] {
  if (source.length > 128 * 1024 || new TextEncoder().encode(source).byteLength > 128 * 1024)
    return [{ file: 'main.lua', line: 1, column: 1, message: 'Lua source exceeds 128 KiB.' }];
  try {
    luaparse.parse(source, { luaVersion: 'LuaJIT', locations: true, comments: false });
    return [];
  } catch (error) {
    const e = error as { line?: number; column?: number; message?: string };
    return [
      {
        file: 'main.lua',
        line: e.line ?? 1,
        column: (e.column ?? 0) + 1,
        message: e.message ?? 'Lua could not be parsed.',
      },
    ];
  }
}
export function generateLua(d: CreatorDraft) {
  const atlas = `-- Generated for Steamodded ${CREATOR_TARGET}. Edit in custom-code mode.\nSMODS.Atlas { key = 'cards', path = 'card.png', px = 71, py = 95 }\n\n`;
  if (d.recipe === 'blank') return atlas + '-- This blank mod registers no gameplay objects.\n';
  if (d.recipe === 'deck')
    return (
      atlas +
      `SMODS.Back {\n  key = 'deck', unlocked = true, discovered = true, atlas = 'cards', pos = { x = 0, y = 0 },\n  loc_txt = { name = ${luaString(d.name)}, text = { ${luaString(`+$${d.dollars} starting money`)}, ${luaString(`+${d.hands} hands per round`)}, ${luaString(`+${d.discards} discards per round`)} } },\n  config = { dollars = ${d.dollars}, hands = ${d.hands}, discards = ${d.discards} }\n}\n`
    );
  const text =
    d.recipe === 'joker-suit'
      ? [`Each scored ${d.suit} card`, `gives +${d.amount} Mult`, 'Retriggers apply again']
      : [`+${d.amount} ${d.recipe === 'joker-chips' ? 'Chips' : 'Mult'}`, 'for each played hand'];
  const localization = text.map(luaString).join(', ');
  const field = d.recipe === 'joker-chips' ? 'chips' : 'mult';
  const condition =
    d.recipe === 'joker-suit'
      ? `context.individual and context.cardarea == G.play and context.other_card:is_suit(${luaString(d.suit)})`
      : 'context.joker_main';
  return (
    atlas +
    `SMODS.Joker {\n  key = 'joker', atlas = 'cards', pos = { x = 0, y = 0 },\n  rarity = 1, cost = 3, unlocked = true, discovered = true, blueprint_compat = true,\n  loc_txt = { name = ${luaString(d.name)}, text = { ${localization} } },\n  config = { extra = { ${field} = ${d.amount} } },\n  calculate = function(self, card, context)\n    if ${condition} then\n      return { ${field} = card.ability.extra.${field} }\n    end\n  end\n}\n`
  );
}
