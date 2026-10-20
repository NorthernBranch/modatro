import luaparse from 'luaparse';
import { CREATOR_TARGET, type CreatorDraft } from './creator';
import {
  contentDescription,
  compositionCards,
  ranks,
  type RuleCondition,
  type JokerRule,
} from './creator-content';

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
  const c = d.content;
  if (c.type === 'blank')
    return atlas + '-- This legacy blank mod registers no gameplay objects.\n';
  const localization = contentDescription(c)
    .split('\n')
    .flatMap((line) => line.match(/.{1,48}(?:\s|$)|\S{1,48}/g) ?? [''])
    .map((line) => luaString(line.trim()))
    .join(', ');
  const common = `key = '${c.type === 'deck' ? 'deck' : c.type}', atlas = 'cards', pos = { x = 0, y = 0 },\n  unlocked = true, discovered = true,\n  loc_txt = { name = ${luaString(c.name)}, text = { ${localization} } }`;
  if (c.type === 'joker') {
    return (
      atlas +
      `SMODS.Joker {\n  ${common},\n  rarity = ${['Common', 'Uncommon', 'Rare', 'Legendary'].indexOf(c.rarity) + 1}, cost = ${c.cost},\n  blueprint_compat = ${c.blueprint}, eternal_compat = ${c.eternal}, perishable_compat = ${c.perishable},\n  calculate = function(self, card, context)\n    -- Each matched rule becomes its own effect, resolved in the displayed order.\n    local first, last\n    local function append(effect)\n      if last then last.extra = effect else first = effect end\n      last = effect\n    end\n${c.rules.map((rule, index) => `    -- Rule ${index + 1}\n    if ${ruleGuard(rule)} then\n      append({ ${rule.effect === 'xmult' ? 'x_mult' : rule.effect} = ${rule.amount} })\n    end`).join('\n')}\n    return first\n  end\n}\n`
    );
  }
  if (c.type === 'voucher') {
    const statements = c.effects.map((e) =>
      e.kind === 'handSize'
        ? `    G.hand:change_size(${e.amount})`
        : e.kind === 'jokerSlots'
          ? `    G.jokers.config.card_limit = G.jokers.config.card_limit + ${e.amount}`
          : e.kind === 'consumableSlots'
            ? `    G.consumeables.config.card_limit = G.consumeables.config.card_limit + ${e.amount}`
            : `    G.GAME.round_resets.${e.kind} = G.GAME.round_resets.${e.kind} + ${e.amount}`,
    );
    return (
      atlas +
      `SMODS.Voucher {\n  ${common}, cost = ${c.cost}, available = true,\n  -- Standalone ordinary voucher; no prerequisites or custom shop weights.\n  redeem = function(self, card)\n    local flag = ${luaString(`${d.prefix}_voucher_redeemed`)}\n    if G.GAME[flag] then return end\n    G.GAME[flag] = true -- saved with this run, never reapplied on load\n${statements.join('\n')}\n  end\n}\n`
    );
  }
  const r = c.resources;
  const itemKeys = (joker: boolean) =>
    c.items
      .filter((i) => i.key.startsWith('j_') === joker)
      .flatMap((i) => Array.from({ length: i.quantity }, () => luaString(i.key)))
      .join(', ');
  const config = `dollars = ${r.dollars}, hands = ${r.hands}, discards = ${r.discards}, hand_size = ${r.handSize}, joker_slot = ${r.jokerSlots}, consumable_slot = ${r.consumableSlots}${c.items.some((i) => i.key.startsWith('j_')) ? `, jokers = { ${itemKeys(true)} }` : ''}${c.items.some((i) => i.key.startsWith('c_')) ? `, consumables = { ${itemKeys(false)} }` : ''}`;
  if (c.composition.mode === 'standard')
    return atlas + `SMODS.Back {\n  ${common},\n  config = { ${config} }\n}\n`;
  const cards = compositionCards(c.composition)
    .map((card) => {
      const keys: Partial<Record<(typeof ranks)[number], string>> = {
        '10': 'T',
        Jack: 'J',
        Queen: 'Q',
        King: 'K',
        Ace: 'A',
      };
      const rank = keys[card.rank] ?? card.rank;
      return `      { s = ${luaString(card.suit[0]!)}, r = ${luaString(rank)} }`;
    })
    .join(',\n');
  return (
    atlas +
    `SMODS.Back {\n  ${common},\n  config = { ${config} },\n  -- Exclude ordinary prototypes; the explicit list below is created by the\n  -- game's normal new-run setup, before shuffle and starting-card bookkeeping.\n  initial_deck = { ranks = {} },\n  apply = function(self, back)\n    -- Back.apply runs only for a new run, never when continuing a saved run.\n    G.GAME.starting_params.extra_cards = {\n${cards}\n    }\n  end\n}\n`
  );
}

function conditionLua(c: RuleCondition) {
  if (c.kind === 'ranks')
    return `not SMODS.has_no_rank(context.other_card) and (${c.values.map((rank) => `context.other_card:get_id() == ${ranks.indexOf(rank) + 2}`).join(' or ')})`;
  if (c.kind === 'suits')
    return `(${c.values.map((suit) => `context.other_card:is_suit(${luaString(suit)})`).join(' or ')})`;
  if (c.kind === 'face') return 'context.other_card:is_face()';
  if (c.kind === 'hand') return `context.scoring_name == ${luaString(c.value)}`;
  const left =
    c.kind === 'played'
      ? '#(context.full_hand or {})'
      : c.kind === 'scoring'
        ? '#(context.scoring_hand or {})'
        : `G.GAME.current_round.${c.kind === 'hands-left' ? 'hands_left' : 'discards_left'}`;
  return `${left} ${{ equals: '==', 'at-least': '>=', 'at-most': '<=' }[c.operator]} ${c.amount}`;
}
export function ruleGuard(r: JokerRule) {
  const guard =
    r.trigger === 'scored'
      ? 'context.individual and context.cardarea == G.play and context.other_card and not context.repetition'
      : r.trigger === 'main'
        ? 'context.joker_main'
        : 'context.end_of_round and not context.individual and not context.repetition and not context.game_over';
  return [guard, ...r.conditions.map((c) => `(${conditionLua(c)})`)].join(' and ');
}
