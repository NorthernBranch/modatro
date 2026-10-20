import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CreatorDraftSchema,
  creatorIdentities,
  migrateCreatorProject,
  type CreatorDraft,
} from '../src/shared/creator';
import {
  compositionCards,
  compositionSummary,
  ContentSchema,
  RuleSchema,
  automaticDescription,
  deckPreset,
  defaultContent,
  ranks,
  type ContentType,
  type DeckContent,
  type JokerContent,
  type VoucherContent,
} from '../src/shared/creator-content';
import { generateLua, luaDiagnostics } from '../src/shared/creator-lua';
import { builtinPixels } from '../src/shared/creator-artwork';
import {
  descriptionLines,
  descriptionSegments,
  localizedDescription,
} from '../src/shared/creator-description';

// Test-only VM. The application never loads this dependency or executes project Lua.
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)(
  'fengari',
);
function executeGenerated(source: string, assertions: string) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const setup = `SMODS = { Atlas = function(a) atlas = a end, Joker = function(c) center = c end, Back = function(c) center = c end, Voucher = function(c) center = c end, has_no_rank = function(c) return c.rankless end }
G = { play = {}, GAME = { starting_params = {}, round_resets = {hands=4,discards=3}, current_round={hands_left=2,discards_left=1} }, hand = { config={card_limit=8} }, jokers={config={card_limit=5}}, consumeables={config={card_limit=2}} }
function G.hand:change_size(amount) self.config.card_limit = self.config.card_limit + amount end
function apply_effects(effect, mult, chips, dollars)
  if not effect then return mult, chips, dollars end
  mult = mult + (effect.mult or 0); chips = chips + (effect.chips or 0); dollars = dollars + (effect.dollars or 0)
  mult = mult * (effect.x_mult or 1)
  return apply_effects(effect.extra, mult, chips, dollars)
end
function new_card(id, suit, wild, rankless)
  return { rankless=rankless, get_id=function() return id end, is_suit=function(self,s) return not self.suitless and (wild or suit == s) end, is_face=function(self) return not self.rankless and id >= 11 and id <= 13 end }
end
`;
  const result = lauxlib.luaL_dostring(L, to_luastring(setup + source + '\n' + assertions));
  const message = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
  lua.lua_close(L);
  expect(message).toBe('');
}
function draft(type: ContentType): CreatorDraft {
  return {
    configVersion: 2,
    name: 'Test mod',
    author: 'Author',
    description: 'Description',
    version: '1.0.0',
    ...creatorIdentities('11111111-1111-4111-8111-111111111111'),
    content: defaultContent(type, 'Test ' + type),
    artwork: { source: 'builtin', builtinId: type + '-1' },
    mode: 'template',
    lua: '',
    crop: { x: 0.5, y: 0.5, zoom: 1 },
  };
}
describe('typed creator generation', () => {
  it('retrigger rules match ranks/faces and stack only during played-card repetition checks', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      {
        trigger: 'scored',
        conditions: [{ kind: 'ranks', values: ['Jack'] }],
        effect: 'repetitions',
        amount: 2,
      },
      { trigger: 'scored', conditions: [{ kind: 'face' }], effect: 'repetitions', amount: 1 },
      { trigger: 'scored', conditions: [], effect: 'mult', amount: 4 },
    ];
    expect(CreatorDraftSchema.safeParse(d).success).toBe(true);
    executeGenerated(
      generateLua(d),
      `
      local joker={}; local jack=new_card(11,'Hearts')
      local ctx={repetition=true,cardarea=G.play,other_card=jack}
      local effect=center:calculate(joker,ctx)
      assert(effect.repetitions==2 and effect.card==joker and effect.extra.repetitions==1 and not effect.extra.extra)
      ctx.other_card=new_card(12,'Hearts'); assert(center:calculate(joker,ctx).repetitions==1)
      ctx.other_card=new_card(10,'Hearts'); assert(center:calculate(joker,ctx)==nil)
      ctx.other_card=jack; ctx.other_card.rankless=true; assert(center:calculate(joker,ctx)==nil)
      ctx.other_card=jack; ctx.other_card.rankless=false; ctx.cardarea=G.hand; assert(center:calculate(joker,ctx)==nil)
      ctx.cardarea=G.play; ctx.repetition_only=true; assert(center:calculate(joker,ctx)==nil)
      ctx.repetition_only=nil; ctx.repetition=nil; ctx.individual=true
      assert(center:calculate(joker,ctx).mult==4 and not center:calculate(joker,ctx).repetitions)
      ctx.other_card.repetition_trigger=2; assert(center:calculate(joker,ctx).mult==4)
      assert(center:calculate(joker,{joker_main=true})==nil)
      assert(center:calculate(joker,{end_of_round=true})==nil)
    `,
    );
  });
  it('filters first/last scoring cards and remaining hands without mistaking unscored played cards', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      {
        trigger: 'scored',
        conditions: [
          { kind: 'position', value: 'first' },
          { kind: 'hands-left', operator: 'equals', amount: 0 },
        ],
        effect: 'repetitions',
        amount: 2,
      },
      {
        trigger: 'scored',
        conditions: [{ kind: 'position', value: 'last' }],
        effect: 'repetitions',
        amount: 1,
      },
    ];
    executeGenerated(
      generateLua(d),
      `
      local a,b,unscored=new_card(11,'Hearts'),new_card(13,'Spades'),new_card(2,'Clubs')
      local ctx={repetition=true,cardarea=G.play,full_hand={unscored,a,b},scoring_hand={a,b},other_card=a}
      G.GAME.current_round.hands_left=0
      assert(center:calculate({},ctx).repetitions==2)
      ctx.other_card=b; assert(center:calculate({},ctx).repetitions==1)
      ctx.other_card=unscored; assert(center:calculate({},ctx)==nil)
      ctx.other_card=a; G.GAME.current_round.hands_left=1; assert(center:calculate({},ctx)==nil)
      G.GAME.current_round.hands_left=0; ctx.scoring_hand={a}
      local effect=center:calculate({},ctx); assert(effect.repetitions==2 and effect.extra.repetitions==1)
      ctx.scoring_hand={}; assert(center:calculate({},ctx)==nil)
      ctx.scoring_hand=nil; assert(center:calculate({},ctx)==nil)
    `,
    );
  });
  it('rejects retriggers outside scored-card rules and non-whole or excessive repetitions', () => {
    for (const trigger of ['main', 'round'] as const)
      expect(
        RuleSchema.safeParse({ trigger, conditions: [], effect: 'repetitions', amount: 1 }).success,
      ).toBe(false);
    for (const amount of [0, -1, 1.5, 11, Infinity, NaN])
      expect(
        RuleSchema.safeParse({ trigger: 'scored', conditions: [], effect: 'repetitions', amount })
          .success,
      ).toBe(false);
    for (const amount of [1, 10])
      expect(
        RuleSchema.safeParse({ trigger: 'scored', conditions: [], effect: 'repetitions', amount })
          .success,
      ).toBe(true);
    expect(
      RuleSchema.safeParse({
        trigger: 'main',
        conditions: [{ kind: 'position', value: 'first' }],
        effect: 'mult',
        amount: 4,
      }).success,
    ).toBe(false);
  });
  it('generates standard highlights and compact, visibly wrapped localization without breaking controls', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      { trigger: 'main', conditions: [], effect: 'chips', amount: 30 },
      {
        trigger: 'main',
        conditions: [{ kind: 'hand', value: 'Flush' }],
        effect: 'xmult',
        amount: 2,
      },
      { trigger: 'round', conditions: [], effect: 'dollars', amount: 3 },
      {
        trigger: 'scored',
        conditions: [{ kind: 'ranks', values: ['Jack'] }],
        effect: 'repetitions',
        amount: 2,
      },
    ];
    const text = localizedDescription(c);
    expect(text).toContain('{C:chips}+30{} Chips');
    expect(text).toContain('{X:mult,C:white}X2{} Mult');
    expect(text).toContain('{C:attention}Flush{}');
    expect(text).toContain('{C:money}$3{}');
    expect(text).toContain('{C:attention}Jack{}');
    expect(automaticDescription(c)).not.toContain('{');
    const lines = descriptionLines(text);
    expect(lines.every((line) => [...line.replace(/\{[^{}]*\}/g, '')].length <= 32)).toBe(true);
    executeGenerated(
      generateLua(d),
      `for _,line in ipairs(center.loc_txt.text) do assert(not string.find(line, '{[^}]*$')) end; assert(string.find(table.concat(center.loc_txt.text, ' '), '{C:chips}+30{} Chips', 1, true))`,
    );
    expect(
      descriptionLines('{C:attention}A long highlighted phrase that spans lines{}', 20),
    ).toEqual([
      '{C:attention}A long highlighted{}',
      '{C:attention}phrase that spans{}',
      '{C:attention}lines{}',
    ]);
    c.manualDescription = '{C:mult}+7{} Mult\nLiteral " quote and backslash \\';
    expect(localizedDescription(c)).toBe(c.manualDescription);
    expect(luaDiagnostics(generateLua(d))).toEqual([]);
    expect(descriptionSegments('{X:mult,C:white}X2{} Mult')).toEqual([
      { text: 'X2', colour: 'white', background: 'mult' },
      { text: ' Mult', colour: undefined, background: undefined },
    ]);
    expect(descriptionSegments('{C:javascript:alert(1)}<script>hello</script>')[0]?.text).toBe(
      '<script>hello</script>',
    );
  });
  it.each(['joker', 'deck', 'voucher'] as const)(
    'generates parsable %s source with correct atlas references and escaped text',
    (type) => {
      const d = draft(type);
      d.content.name = 'Quotes " \\ \n ☃';
      d.content.manualDescription = 'Literal " text \\ with newline\nOther line';
      const source = generateLua(d);
      expect(luaDiagnostics(source)).toEqual([]);
      executeGenerated(
        source,
        `assert(atlas.px == 71 and atlas.py == 95 and atlas.path == 'card.png'); assert(center.atlas == 'cards'); assert(center.loc_txt.name == [=[${d.content.name}]=])`,
      );
      expect(CreatorDraftSchema.safeParse(d).success).toBe(true);
    },
  );
  it.each(['Common', 'Uncommon', 'Rare', 'Legendary'] as const)(
    'maps %s rarity without overriding ordinary acquisition',
    (rarity) => {
      const d = draft('joker');
      (d.content as JokerContent).rarity = rarity;
      executeGenerated(
        generateLua(d),
        `assert(center.rarity == ${['Common', 'Uncommon', 'Rare', 'Legendary'].indexOf(rarity) + 1}); assert(center.in_pool == nil); assert(center.blueprint_compat and center.eternal_compat and center.perishable_compat)`,
      );
    },
  );
  it('composes multiple matching effects in displayed order, including additions and multipliers', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      { trigger: 'main', conditions: [], effect: 'mult', amount: 4 },
      { trigger: 'main', conditions: [], effect: 'xmult', amount: 2 },
      { trigger: 'main', conditions: [], effect: 'mult', amount: 3 },
      { trigger: 'main', conditions: [], effect: 'chips', amount: 30 },
      {
        trigger: 'main',
        conditions: [{ kind: 'hand', value: 'Flush' }],
        effect: 'chips',
        amount: 50,
      },
    ];
    executeGenerated(
      generateLua(d),
      `local m,cash,d = apply_effects(center:calculate({}, {joker_main=true, scoring_name='Flush'}), 10, 0, 0); assert(m==31 and cash==80 and d==0); local m,cash = apply_effects(center:calculate({}, {joker_main=true, scoring_name='Straight Flush'}),10,0,0); assert(m==31 and cash==30)`,
    );
    c.rules.reverse();
    executeGenerated(
      generateLua(d),
      `local m=apply_effects(center:calculate({}, {joker_main=true}),10,0,0); assert(m==30)`,
    );
  });
  it('uses any rank/suit but all separate conditions, honours Wild/rankless/suitless cards and scoring context', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      {
        trigger: 'scored',
        conditions: [
          { kind: 'ranks', values: ['King', 'Ace'] },
          { kind: 'suits', values: ['Hearts', 'Diamonds'] },
          { kind: 'played', operator: 'equals', amount: 2 },
          { kind: 'scoring', operator: 'at-least', amount: 1 },
        ],
        effect: 'mult',
        amount: 4,
      },
    ];
    executeGenerated(
      generateLua(d),
      `local ctx={individual=true,cardarea=G.play,other_card=new_card(13,'Spades',true,false),full_hand={1,2},scoring_hand={1}}; assert(center:calculate({},ctx).mult == 4); assert(center:calculate({},ctx).mult == 4); ctx.other_card.rankless=true; assert(center:calculate({},ctx)==nil); ctx.other_card.rankless=false; ctx.other_card.suitless=true; assert(center:calculate({},ctx)==nil); ctx.other_card=new_card(12,'Hearts'); assert(center:calculate({},ctx)==nil); ctx.other_card=new_card(14,'Hearts'); ctx.cardarea=G.hand; assert(center:calculate({},ctx)==nil); ctx.cardarea=G.play; ctx.repetition=true; assert(center:calculate({},ctx)==nil)`,
    );
  });
  it('guards round-end rewards from held cards, repetition and game over; face rules use the card helper', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules = [
      {
        trigger: 'round',
        conditions: [
          { kind: 'hands-left', operator: 'equals', amount: 2 },
          { kind: 'discards-left', operator: 'at-most', amount: 1 },
        ],
        effect: 'dollars',
        amount: 3,
      },
      { trigger: 'round', conditions: [], effect: 'dollars', amount: 2 },
      { trigger: 'scored', conditions: [{ kind: 'face' }], effect: 'chips', amount: 15 },
    ];
    executeGenerated(
      generateLua(d),
      `local _,_,d=apply_effects(center:calculate({}, {end_of_round=true}),0,0,0); assert(d==5); for _,key in ipairs({'individual','repetition','game_over'}) do local ctx={end_of_round=true};ctx[key]=true;assert(center:calculate({},ctx)==nil) end; assert(center:calculate({}, {individual=true,cardarea=G.play,other_card=new_card(11,'Hearts')}).chips==15)`,
    );
  });
  it('rejects invalid effects, conditions, duplicates, numeric input and wrong type artwork', () => {
    const d = draft('joker'),
      c = d.content as JokerContent;
    c.rules[0]!.effect = 'dollars';
    expect(CreatorDraftSchema.safeParse(d).success).toBe(false);
    c.rules[0] = { trigger: 'main', effect: 'mult', amount: 4, conditions: [{ kind: 'face' }] };
    expect(CreatorDraftSchema.safeParse(d).success).toBe(false);
    c.rules[0] = { trigger: 'scored', effect: 'mult', amount: 4.2, conditions: [] };
    expect(CreatorDraftSchema.safeParse(d).success).toBe(false);
    c.rules[0]!.amount = NaN;
    expect(CreatorDraftSchema.safeParse(d).success).toBe(false);
    const v = draft('voucher');
    (v.content as VoucherContent).effects = [
      { kind: 'hands', amount: 1 },
      { kind: 'hands', amount: 2 },
    ];
    expect(CreatorDraftSchema.safeParse(v).success).toBe(false);
    const valid = draft('deck');
    valid.artwork.builtinId = 'joker-1';
    expect(CreatorDraftSchema.safeParse(valid).success).toBe(false);
  });
});

describe('deck starting setup', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('uses the same editable model for preset %s', (index) => {
    const d = draft('deck');
    d.content = deckPreset(index, d.content as DeckContent);
    expect(ContentSchema.safeParse(d.content).success).toBe(true);
    expect(luaDiagnostics(generateLua(d))).toEqual([]);
    const count = [52, 40, 40, 52, 26, 52, 52][index];
    expect(compositionCards(d.content.composition)).toHaveLength(count!);
    executeGenerated(
      generateLua(d),
      `assert(center.config.dollars == ${(d.content as DeckContent).resources.dollars}); ${index >= 1 && index <= 4 ? `assert(#center.initial_deck.ranks==0); center:apply({}); assert(#G.GAME.starting_params.extra_cards==${count})` : 'assert(center.apply==nil and center.initial_deck==nil)'}`,
    );
  });
  it('distributes an uneven one-rank total deterministically and keeps other mode fields', () => {
    const c = (draft('deck').content as DeckContent).composition;
    Object.assign(c, { mode: 'rank', total: 41, suits: ['Hearts', 'Spades', 'Clubs'] });
    expect(compositionSummary(c)).toBe('41 Aces: 14 Hearts, 14 Spades, 13 Clubs.');
    const original = structuredClone(c);
    c.mode = 'standard';
    expect(compositionCards(c)).toHaveLength(52);
    c.mode = 'rank';
    expect(c).toEqual(original);
    c.mode = 'card';
    c.rank = 'King';
    c.suit = 'Hearts';
    expect(compositionSummary(c)).toBe('41 copies of the King of Hearts.');
    c.mode = 'modified';
    c.ranks = ['2', 'Ace'];
    c.copies = 3;
    expect(compositionCards(c)).toHaveLength(18);
    c.total = 240;
    expect(compositionCards(c)).toHaveLength(18);
  });
  it('rejects empty, fractional, excessive and unusable configurations or item overflow', () => {
    const c = draft('deck').content as DeckContent;
    c.composition.mode = 'modified';
    c.composition.ranks = [];
    expect(ContentSchema.safeParse(c).success).toBe(false);
    c.composition.ranks = [...ranks];
    c.composition.copies = 10;
    expect(ContentSchema.safeParse(c).success).toBe(false);
    c.composition.mode = 'card';
    c.composition.total = 2.5;
    expect(ContentSchema.safeParse(c).success).toBe(false);
    c.composition.total = 52;
    c.resources.handSize = -8;
    expect(ContentSchema.safeParse(c).success).toBe(false);
    c.resources.handSize = 0;
    c.items = [{ key: 'j_joker', quantity: 6 }];
    expect(ContentSchema.safeParse(c).success).toBe(false);
    c.resources.jokerSlots = 1;
    expect(ContentSchema.safeParse(c).success).toBe(true);
    c.items = [{ key: 'third_party', quantity: 1 }];
    expect(ContentSchema.safeParse(c).success).toBe(false);
  });
  it('uses native new-run-only composition, modifiers and items and does not hook reload or rounds', () => {
    const d = draft('deck'),
      c = d.content as DeckContent;
    c.composition.mode = 'card';
    c.composition.rank = 'King';
    c.composition.total = 40;
    c.resources = {
      dollars: 5,
      hands: -1,
      discards: 1,
      handSize: 2,
      jokerSlots: 1,
      consumableSlots: 1,
    };
    c.items = [
      { key: 'j_joker', quantity: 2 },
      { key: 'c_mercury', quantity: 1 },
    ];
    const source = generateLua(d);
    expect(source).not.toMatch(/calculate =|load =|update =|negative|remove_card/);
    // Contract harness follows the inspected Game.start_run/Back.apply_to_run split.
    executeGenerated(
      source,
      `local function start(saved)
      if saved then return saved end
      G.GAME.starting_params={};center:apply({});
      return {count=#G.GAME.starting_params.extra_cards, dollars=4+center.config.dollars, hands=4+center.config.hands, discards=3+center.config.discards, hand_size=8+center.config.hand_size, joker_slots=5+center.config.joker_slot, consumable_slots=2+center.config.consumable_slot, jokers=#center.config.jokers,consumables=#center.config.consumables}
    end
    local run=start();assert(run.count==40 and run.dollars==9 and run.hands==3 and run.discards==4 and run.hand_size==10 and run.joker_slots==6 and run.consumable_slots==3 and run.jokers==2 and run.consumables==1);run.count=39;run.jokers=1;local continued=start(run);assert(continued.count==39 and continued.jokers==1);local fresh=start();assert(fresh.count==40 and fresh.jokers==2)`,
    );
  });
});
it('redeems each supported Voucher effect once, persists capacity and future-round allowance without immediate hands', () => {
  const d = draft('voucher'),
    c = d.content as VoucherContent;
  c.effects = [
    { kind: 'hands', amount: 2 },
    { kind: 'discards', amount: 1 },
    { kind: 'handSize', amount: 1 },
    { kind: 'jokerSlots', amount: 2 },
    { kind: 'consumableSlots', amount: 1 },
  ];
  executeGenerated(
    generateLua(d),
    `assert(center.requires==nil and center.available==true and center.cost==10);center:redeem({});assert(G.hand.config.card_limit==9 and G.jokers.config.card_limit==7 and G.consumeables.config.card_limit==3);assert(G.GAME.round_resets.hands==6 and G.GAME.round_resets.discards==4);assert(G.GAME.current_round.hands_left==2 and G.GAME.current_round.discards_left==1);center:redeem({});assert(G.GAME.round_resets.hands==6 and G.hand.config.card_limit==9); local saved=G.GAME;G.GAME=saved;center:redeem({});assert(G.jokers.config.card_limit==7);G.GAME.current_round.hands_left=G.GAME.round_resets.hands;assert(G.GAME.current_round.hands_left==6)`,
  );
});
it('has fifteen distinct original designs with readable type letters', () => {
  const art = new Set<string>();
  for (const type of ['joker', 'deck', 'voucher'])
    for (let i = 1; i <= 5; i++)
      art.add(Buffer.from(builtinPixels(type + '-' + i)).toString('base64'));
  expect(art.size).toBe(15);
  expect(() => builtinPixels('unknown')).toThrow();
});
it('migrates legacy semantics without regenerating Lua, changing identities or losing build relationships', () => {
  const modern = draft('deck');
  const legacy = {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    draft: {
      name: modern.name,
      author: modern.author,
      description: modern.description,
      version: modern.version,
      modId: modern.modId,
      prefix: modern.prefix,
      recipe: 'deck',
      amount: 4,
      suit: 'Hearts',
      dollars: 10,
      hands: 1,
      discards: 0,
      mode: 'custom',
      lua: '-- custom preserved\nreturn 77',
      crop: modern.crop,
    },
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
    builds: [
      { id: 'a'.repeat(64), revision: 1, version: '1.0.0', createdAt: '2026-10-19T00:00:00Z' },
    ],
  };
  const migrated = migrateCreatorProject(legacy);
  expect(migrated.draft.content).toMatchObject({
    type: 'deck',
    resources: { dollars: 10, hands: 1, discards: 0 },
    composition: { mode: 'standard' },
  });
  expect(migrated.draft.lua).toBe(legacy.draft.lua);
  expect(migrated.draft.mode).toBe('custom');
  expect(migrated.draft.modId).toBe(legacy.draft.modId);
  expect(migrated.builds).toEqual(legacy.builds);
  expect(migrated.draft.artwork).toMatchObject({ source: 'legacy', legacyDeck: true });
  for (const recipe of ['joker-mult', 'joker-chips', 'joker-suit']) {
    const p = migrateCreatorProject({
      ...legacy,
      draft: { ...legacy.draft, recipe, mode: 'template' },
    });
    expect(p.draft.content).toMatchObject({
      type: 'joker',
      rules: [
        {
          effect: recipe === 'joker-chips' ? 'chips' : 'mult',
          trigger: recipe === 'joker-suit' ? 'scored' : 'main',
          amount: 4,
        },
      ],
    });
    expect(p.draft.lua).toBe(legacy.draft.lua);
  }
  const uploaded = migrateCreatorProject({ ...legacy, artHash: 'b'.repeat(64) });
  expect(uploaded.artHash).toBe('b'.repeat(64));
  expect(uploaded.draft.artwork.source).toBe('upload');
});
