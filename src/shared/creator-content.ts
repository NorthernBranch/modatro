import { z } from 'zod';

export const ranks = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'Jack',
  'Queen',
  'King',
  'Ace',
] as const;
export const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'] as const;
export const pokerHands = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Five of a Kind',
  'Flush House',
  'Flush Five',
] as const;
export const rarities = ['Common', 'Uncommon', 'Rare', 'Legendary'] as const;
const Rank = z.enum(ranks),
  Suit = z.enum(suits);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const rankList = z.array(Rank).min(1).max(13).refine(unique, 'Choose each rank once.');
const suitList = z.array(Suit).min(1).max(4).refine(unique, 'Choose each suit once.');
const count = z.number().int().min(0).max(52);
const comparison = { operator: z.enum(['equals', 'at-least', 'at-most']), amount: count };
export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ranks'), values: rankList }).strict(),
  z.object({ kind: z.literal('suits'), values: suitList }).strict(),
  z.object({ kind: z.literal('face') }).strict(),
  z.object({ kind: z.literal('hand'), value: z.enum(pokerHands) }).strict(),
  z.object({ kind: z.literal('played'), ...comparison }).strict(),
  z.object({ kind: z.literal('scoring'), ...comparison }).strict(),
  z.object({ kind: z.literal('hands-left'), ...comparison }).strict(),
  z.object({ kind: z.literal('discards-left'), ...comparison }).strict(),
]);
export type RuleCondition = z.infer<typeof ConditionSchema>;
export const triggers = {
  scored: 'Each played card scores',
  main: 'Joker’s main scoring evaluation',
  round: 'Round ends',
} as const;
export const effects = {
  chips: 'Add Chips',
  mult: 'Add Mult',
  xmult: 'Multiply Mult',
  dollars: 'Earn money at round end',
} as const;
export function allowedConditions(trigger: JokerRule['trigger']) {
  return trigger === 'round'
    ? (['hands-left', 'discards-left'] as const)
    : trigger === 'scored'
      ? (['ranks', 'suits', 'face', 'hand', 'played', 'scoring'] as const)
      : (['hand', 'played', 'scoring'] as const);
}
export const RuleSchema = z
  .object({
    trigger: z.enum(['scored', 'main', 'round']),
    conditions: z.array(ConditionSchema).max(8),
    effect: z.enum(['chips', 'mult', 'xmult', 'dollars']),
    amount: z.number().finite().min(0).max(100000),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const problem = (message: string, path: string[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if ((rule.trigger === 'round') !== (rule.effect === 'dollars'))
      problem('Round-end rules earn money; scoring rules add Chips/Mult or multiply Mult.', [
        'effect',
      ]);
    if (
      rule.effect === 'xmult'
        ? rule.amount < 1 || rule.amount > 1000
        : !Number.isInteger(rule.amount) || rule.amount > (rule.effect === 'chips' ? 100000 : 1000)
    )
      problem(
        'Use whole bonuses up to 1,000 (100,000 Chips), or a multiplier between 1 and 1,000.',
        ['amount'],
      );
    if (
      rule.conditions.some(
        (c) => !(allowedConditions(rule.trigger) as readonly string[]).includes(c.kind),
      )
    )
      problem('This condition is unavailable for the selected trigger.', ['conditions']);
    if (!unique(rule.conditions.map((c) => c.kind)))
      problem('Use one condition of each kind; conditions are joined by ALL.', ['conditions']);
  });
export type JokerRule = z.infer<typeof RuleSchema>;
const details = {
  name: z.string().trim().min(1).max(80),
  manualDescription: z.string().max(1600).optional(),
};
export const JokerSchema = z
  .object({
    type: z.literal('joker'),
    ...details,
    rarity: z.enum(rarities),
    cost: z.number().int().min(0).max(1000),
    blueprint: z.boolean(),
    eternal: z.boolean(),
    perishable: z.boolean(),
    rules: z.array(RuleSchema).min(1).max(20),
  })
  .strict();

export const startingItems = [
  { key: 'j_joker', name: 'Joker', set: 'Joker' },
  { key: 'j_greedy_joker', name: 'Greedy Joker', set: 'Joker' },
  { key: 'j_lusty_joker', name: 'Lusty Joker', set: 'Joker' },
  { key: 'j_wrathful_joker', name: 'Wrathful Joker', set: 'Joker' },
  { key: 'j_gluttenous_joker', name: 'Gluttonous Joker', set: 'Joker' },
  { key: 'j_jolly', name: 'Jolly Joker', set: 'Joker' },
  { key: 'c_fool', name: 'The Fool', set: 'Tarot' },
  { key: 'c_magician', name: 'The Magician', set: 'Tarot' },
  { key: 'c_empress', name: 'The Empress', set: 'Tarot' },
  { key: 'c_emperor', name: 'The Emperor', set: 'Tarot' },
  { key: 'c_hermit', name: 'The Hermit', set: 'Tarot' },
  { key: 'c_mercury', name: 'Mercury', set: 'Planet' },
  { key: 'c_venus', name: 'Venus', set: 'Planet' },
  { key: 'c_earth', name: 'Earth', set: 'Planet' },
  { key: 'c_mars', name: 'Mars', set: 'Planet' },
] as const;
export const CompositionSchema = z
  .object({
    mode: z.enum(['standard', 'modified', 'rank', 'card']),
    ranks: z.array(Rank).max(13).refine(unique),
    suits: z.array(Suit).max(4).refine(unique),
    copies: z.number().int().min(1).max(10),
    rank: Rank,
    suit: Suit,
    total: z.number().int().min(1).max(260),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.mode === 'modified' && !c.ranks.length)
      ctx.addIssue({
        code: 'custom',
        path: ['ranks'],
        message: 'Include at least one starting rank.',
      });
    if ((c.mode === 'modified' || c.mode === 'rank') && !c.suits.length)
      ctx.addIssue({
        code: 'custom',
        path: ['suits'],
        message: 'Include at least one starting suit.',
      });
  });
export type Composition = z.infer<typeof CompositionSchema>;
export interface StartingCard {
  rank: (typeof ranks)[number];
  suit: (typeof suits)[number];
}
export function compositionCards(c: Composition): StartingCard[] {
  if (c.mode === 'rank')
    return Array.from({ length: Math.max(0, Math.min(260, Math.floor(c.total))) }, (_, i) => ({
      rank: c.rank,
      suit: c.suits[i % c.suits.length]!,
    }));
  if (c.mode === 'card')
    return Array.from({ length: Math.max(0, Math.min(260, Math.floor(c.total))) }, () => ({
      rank: c.rank,
      suit: c.suit,
    }));
  return (c.mode === 'standard' ? [...ranks] : c.ranks).flatMap((rank) =>
    (c.mode === 'standard' ? [...suits] : c.suits).flatMap((suit) =>
      Array.from(
        { length: Math.max(0, Math.min(10, Math.floor(c.mode === 'standard' ? 1 : c.copies))) },
        () => ({ rank, suit }),
      ),
    ),
  );
}
export function compositionSummary(c: Composition) {
  const cards = compositionCards(c);
  if (c.mode === 'standard') return '52 cards: one of every base-game rank and suit.';
  if (c.mode === 'card') return `${cards.length} copies of the ${c.rank} of ${c.suit}.`;
  if (c.mode === 'rank')
    return `${cards.length} ${c.rank === 'Ace' ? 'Aces' : `${c.rank}s`}: ${c.suits.map((s) => `${cards.filter((card) => card.suit === s).length} ${s}`).join(', ')}.`;
  return `${cards.length} cards: ${c.ranks.join(', ')} in ${c.suits.join(', ')}; ${c.copies} of each combination.`;
}
const adjustment = (min: number, max: number) => z.number().int().min(min).max(max);
export const resourcesSchema = z
  .object({
    dollars: adjustment(-4, 1000),
    hands: adjustment(-3, 10),
    discards: adjustment(-3, 10),
    handSize: adjustment(-7, 10),
    jokerSlots: adjustment(-5, 10),
    consumableSlots: adjustment(-2, 10),
  })
  .strict();
export const resourceLabels = {
  dollars: 'Starting money',
  hands: 'Hands per round',
  discards: 'Discards per round',
  handSize: 'Hand size',
  jokerSlots: 'Joker slots',
  consumableSlots: 'Consumable slots',
} as const;
export const baseResources = {
  dollars: 4,
  hands: 4,
  discards: 3,
  handSize: 8,
  jokerSlots: 5,
  consumableSlots: 2,
};
export const DeckSchema = z
  .object({
    type: z.literal('deck'),
    ...details,
    composition: CompositionSchema,
    resources: resourcesSchema,
    items: z
      .array(
        z
          .object({
            key: z
              .string()
              .refine(
                (key) => startingItems.some((i) => i.key === key),
                'Choose a supported vanilla starting item.',
              ),
            quantity: z.number().int().min(1).max(15),
          })
          .strict(),
      )
      .max(15),
  })
  .strict()
  .superRefine((deck, ctx) => {
    const cards = compositionCards(deck.composition);
    if (!cards.length || cards.length > 260)
      ctx.addIssue({
        code: 'custom',
        path: ['composition'],
        message: 'Starting decks must contain 1–260 cards.',
      });
    if (!unique(deck.items.map((i) => i.key)))
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Adjust the quantity instead of adding the same item twice.',
      });
    for (const isJoker of [true, false]) {
      const used = deck.items
        .filter((i) => i.key.startsWith('j_') === isJoker)
        .reduce((sum, i) => sum + i.quantity, 0);
      const capacity = isJoker ? 5 + deck.resources.jokerSlots : 2 + deck.resources.consumableSlots;
      if (used > capacity)
        ctx.addIssue({
          code: 'custom',
          path: ['items'],
          message: `Starting ${isJoker ? 'Jokers' : 'consumables'} exceed the configured ${capacity} slots. Nothing will be discarded or given a Negative edition.`,
        });
    }
  });
export const voucherEffects = {
  handSize: 'Increase hand size',
  hands: 'Increase hands per round',
  discards: 'Increase discards per round',
  jokerSlots: 'Increase Joker slots',
  consumableSlots: 'Increase consumable slots',
} as const;
export const VoucherSchema = z
  .object({
    type: z.literal('voucher'),
    ...details,
    cost: z.number().int().min(0).max(1000),
    effects: z
      .array(
        z
          .object({
            kind: z.enum(['handSize', 'hands', 'discards', 'jokerSlots', 'consumableSlots']),
            amount: z.number().int().min(1).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(5)
      .refine(
        (values) => unique(values.map((v) => v.kind)),
        'Use each redemption effect once; increase its amount instead.',
      ),
  })
  .strict();
export const ContentSchema = z.discriminatedUnion('type', [
  JokerSchema,
  DeckSchema,
  VoucherSchema,
  z.object({ type: z.literal('blank'), ...details }).strict(),
]);
export type CreatorContent = z.infer<typeof ContentSchema>;
export type JokerContent = z.infer<typeof JokerSchema>;
export type DeckContent = z.infer<typeof DeckSchema>;
export type VoucherContent = z.infer<typeof VoucherSchema>;
export type ContentType = 'joker' | 'deck' | 'voucher';
export function defaultContent(type: ContentType, name: string): CreatorContent {
  if (type === 'joker')
    return {
      type,
      name,
      rarity: 'Common',
      cost: 3,
      blueprint: true,
      eternal: true,
      perishable: true,
      rules: [{ trigger: 'main', conditions: [], effect: 'mult', amount: 4 }],
    };
  if (type === 'voucher')
    return { type, name, cost: 10, effects: [{ kind: 'handSize', amount: 1 }] };
  return {
    type,
    name,
    composition: {
      mode: 'standard',
      ranks: [...ranks],
      suits: [...suits],
      copies: 1,
      rank: 'Ace',
      suit: 'Hearts',
      total: 52,
    },
    resources: {
      dollars: 0,
      hands: 0,
      discards: 0,
      handSize: 0,
      jokerSlots: 0,
      consumableSlots: 0,
    },
    items: [],
  };
}
export const deckPresets = [
  'Standard deck',
  'No face cards',
  'All Aces',
  'All Kings of Hearts',
  'Two-suit deck',
  'Extra money, fewer discards',
  'Larger hand, fewer Joker slots',
] as const;
export function deckPreset(index: number, current: DeckContent): DeckContent {
  const d = defaultContent('deck', current.name) as DeckContent;
  d.manualDescription = current.manualDescription;
  if (index === 1) {
    d.composition.mode = 'modified';
    d.composition.ranks = ranks.filter((r) => !['Jack', 'Queen', 'King'].includes(r));
  }
  if (index === 2) {
    d.composition.mode = 'rank';
    d.composition.total = 40;
  }
  if (index === 3) {
    d.composition.mode = 'card';
    d.composition.rank = 'King';
  }
  if (index === 4) {
    d.composition.mode = 'modified';
    d.composition.suits = ['Hearts', 'Spades'];
  }
  if (index === 5) {
    d.resources.dollars = 10;
    d.resources.discards = -1;
  }
  if (index === 6) {
    d.resources.handSize = 2;
    d.resources.jokerSlots = -1;
  }
  return d;
}
export function conditionSummary(c: RuleCondition): string {
  if (c.kind === 'ranks') return `scored card rank is ${c.values.join(' or ')}`;
  if (c.kind === 'suits') return `scored card is ${c.values.join(' or ')}`;
  if (c.kind === 'face') return 'scored card is a face card';
  if (c.kind === 'hand') return `the scored hand is a ${c.value}`;
  return `${{ played: 'played cards', scoring: 'scoring cards', 'hands-left': 'remaining hands', 'discards-left': 'remaining discards' }[c.kind]} ${c.operator.replaceAll('-', ' ')} ${c.amount}`;
}
export function ruleSummary(r: JokerRule) {
  const effect =
    r.effect === 'dollars'
      ? `Earn $${r.amount}`
      : r.effect === 'xmult'
        ? `Gives ×${r.amount} Mult`
        : `Gives +${r.amount} ${r.effect === 'chips' ? 'Chips' : 'Mult'}`;
  return `${effect}${r.trigger === 'scored' ? ' for each played card that scores' : r.trigger === 'round' ? ' at the end of the round' : ' during Joker scoring'}${r.conditions.length ? ` when ${r.conditions.map(conditionSummary).join(' AND ')}` : ''}.`;
}
export const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;
export function automaticDescription(c: CreatorContent): string {
  if (c.type === 'blank') return 'A blank Steamodded entry point, ready for your own trusted Lua.';
  if (c.type === 'joker') return c.rules.map(ruleSummary).join('\n');
  if (c.type === 'voucher')
    return c.effects
      .map(
        (e) =>
          `${resourceLabels[e.kind]}: +${e.amount} for this run.${['hands', 'discards'].includes(e.kind) ? ' Applies to future round allowances; no remaining hands/discards granted immediately.' : ''}`,
      )
      .join('\n');
  return [
    compositionSummary(c.composition),
    ...Object.entries(c.resources)
      .filter(([, n]) => n !== 0)
      .map(
        ([key, n]) =>
          `${resourceLabels[key as keyof typeof resourceLabels]}: ${key === 'dollars' ? `${n < 0 ? '−' : '+'}$${Math.abs(n)}` : signed(n)}${key === 'dollars' ? ' once at new-run setup' : key === 'hands' || key === 'discards' ? ' each round' : ' for this run'}.`,
      ),
    ...c.items.map(
      (i) =>
        `Start with ${i.quantity} × ${startingItems.find((item) => item.key === i.key)!.name}.`,
    ),
  ].join('\n');
}
export const contentDescription = (c: CreatorContent) =>
  c.manualDescription ?? automaticDescription(c);
