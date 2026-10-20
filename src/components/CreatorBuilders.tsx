import { useState } from 'react';
import {
  allowedConditions,
  automaticDescription,
  baseResources,
  compositionCards,
  compositionSummary,
  conditionSummary,
  deckPreset,
  deckPresets,
  effects,
  pokerHands,
  ranks,
  rarities,
  resourceLabels,
  ruleSummary,
  signed,
  startingItems,
  suits,
  triggers,
  voucherEffects,
  type CreatorContent,
  type DeckContent,
  type JokerContent,
  type JokerRule,
  type RuleCondition,
  type VoucherContent,
} from '../shared/creator-content';

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 1000,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </label>
  );
}
function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <fieldset className="creator-choices">
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={value.includes(option)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? options.filter((v) => value.includes(v) || v === option)
                    : value.filter((v) => v !== option),
                )
              }
            />
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function ContentDescription({
  content,
  onChange,
}: {
  content: CreatorContent;
  onChange: (value: CreatorContent) => void;
}) {
  const label = content.type === 'deck' ? 'Deck' : content.type === 'voucher' ? 'Voucher' : 'Joker';
  return (
    <div className="creator-description">
      <label>
        {label} description ·{' '}
        {content.manualDescription === undefined ? 'Automatic' : 'Manual override'}
        <textarea
          aria-label={label + ' description'}
          rows={4}
          maxLength={1600}
          readOnly={content.manualDescription === undefined}
          value={content.manualDescription ?? automaticDescription(content)}
          onChange={(e) => onChange({ ...content, manualDescription: e.target.value })}
        />
      </label>
      <button
        className="text-button"
        onClick={() =>
          onChange({
            ...content,
            manualDescription:
              content.manualDescription === undefined
                ? automaticDescription(content).slice(0, 1600)
                : undefined,
          })
        }
      >
        {content.manualDescription === undefined
          ? 'Write a manual description'
          : 'Restore automatic description'}
      </button>
      <p className="muted-text">
        Configuration preview, not an in-game simulation.{' '}
        {content.manualDescription !== undefined &&
          'Manual text is preserved when configuration changes; check that it still describes the effect.'}
      </p>
    </div>
  );
}
const conditionLabels = {
  ranks: 'Scored card ranks',
  suits: 'Scored card suits',
  face: 'Scored card is a face card',
  hand: 'Resolved scoring hand',
  played: 'Number of played cards',
  scoring: 'Number of scoring cards',
  'hands-left': 'Remaining hands at round end',
  'discards-left': 'Remaining discards at round end',
};
function newCondition(kind: RuleCondition['kind']): RuleCondition {
  if (kind === 'ranks') return { kind, values: ['King'] };
  if (kind === 'suits') return { kind, values: ['Hearts'] };
  if (kind === 'face') return { kind };
  if (kind === 'hand') return { kind, value: 'Flush' };
  return { kind, operator: 'equals', amount: 1 };
}
function ConditionEditor({
  condition: c,
  onChange,
}: {
  condition: RuleCondition;
  onChange: (v: RuleCondition) => void;
}) {
  if (c.kind === 'ranks')
    return (
      <Choices
        label="Any selected rank"
        options={ranks}
        value={c.values}
        onChange={(values) => onChange({ ...c, values })}
      />
    );
  if (c.kind === 'suits')
    return (
      <Choices
        label="Any selected suit"
        options={suits}
        value={c.values}
        onChange={(values) => onChange({ ...c, values })}
      />
    );
  if (c.kind === 'face')
    return (
      <p>
        {conditionSummary(c)}. Uses the game’s face-card helper, including effects from other mods.
      </p>
    );
  if (c.kind === 'hand')
    return (
      <label>
        Resolved scoring hand
        <select
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value as typeof c.value })}
        >
          {pokerHands.map((hand) => (
            <option key={hand}>{hand}</option>
          ))}
        </select>
        <small>
          Matches the resolved hand exactly. A Straight Flush does not match Flush here.
        </small>
      </label>
    );
  return (
    <div className="creator-fields">
      <label>
        {conditionLabels[c.kind]}
        <select
          value={c.operator}
          onChange={(e) => onChange({ ...c, operator: e.target.value as typeof c.operator })}
        >
          <option value="equals">Equals</option>
          <option value="at-least">At least</option>
          <option value="at-most">At most</option>
        </select>
      </label>
      <NumberField
        label="Condition count"
        value={c.amount}
        max={52}
        onChange={(amount) => onChange({ ...c, amount })}
      />
    </div>
  );
}
export function JokerBuilder({
  value: c,
  onChange,
}: {
  value: JokerContent;
  onChange: (value: JokerContent) => void;
}) {
  const changeRule = (index: number, rule: JokerRule) =>
    onChange({ ...c, rules: c.rules.map((r, i) => (i === index ? rule : r)) });
  const move = (index: number, delta: number) => {
    const rules = [...c.rules];
    [rules[index], rules[index + delta]] = [rules[index + delta]!, rules[index]!];
    onChange({ ...c, rules });
  };
  return (
    <>
      <div className="creator-fields">
        <label>
          Joker rarity
          <select
            value={c.rarity}
            onChange={(e) => onChange({ ...c, rarity: e.target.value as typeof c.rarity })}
          >
            {rarities.map((rarity) => (
              <option key={rarity}>{rarity}</option>
            ))}
          </select>
        </label>
        <NumberField
          label="Shop cost"
          value={c.cost}
          onChange={(cost) => onChange({ ...c, cost })}
        />
      </div>
      {c.rarity === 'Legendary' && (
        <p className="banner subtle">
          Legendary uses rarity 4: acquired through The Soul’s Legendary pool, not ordinary shop
          rolls. Other mods can change acquisition; the price is still its base value.
        </p>
      )}
      <h3>Scoring rules</h3>
      <details className="creator-advanced">
        <summary>Timing, conditions and retriggers</summary>
        <p>
          Each scored-card rule applies again when that card is retriggered. Main-scoring rules
          apply once per Joker evaluation for the played hand, including Joker retriggers from other
          mods. Matching rules resolve from top to bottom, so +Mult before ×Mult differs from the
          reverse order. Round-end rules are excluded from held-card and repetition evaluations.
        </p>
        <p className="muted-text">
          Within a rank/suit selection, ANY selected value matches. Separate conditions must ALL
          match. Suit checks include Wild Cards and respect suitless cards; rank checks exclude
          rankless cards.
        </p>
      </details>
      {c.rules.map((r, index) => (
        <section className="creator-rule" key={index} aria-label={`Rule ${index + 1}`}>
          <div className="creator-section-heading">
            <h4>Rule {index + 1}</h4>
            <div className="creator-actions">
              <button
                className="text-button"
                disabled={index === 0}
                aria-label={`Move rule ${index + 1} up`}
                onClick={() => move(index, -1)}
              >
                Up
              </button>
              <button
                className="text-button"
                disabled={index === c.rules.length - 1}
                aria-label={`Move rule ${index + 1} down`}
                onClick={() => move(index, 1)}
              >
                Down
              </button>
              <button
                className="text-button"
                disabled={c.rules.length >= 20}
                onClick={() =>
                  onChange({
                    ...c,
                    rules: [
                      ...c.rules.slice(0, index + 1),
                      structuredClone(r),
                      ...c.rules.slice(index + 1),
                    ],
                  })
                }
              >
                Duplicate rule
              </button>
              <button
                className="text-button"
                disabled={c.rules.length === 1}
                onClick={() => onChange({ ...c, rules: c.rules.filter((_, i) => i !== index) })}
              >
                Delete rule
              </button>
            </div>
          </div>
          <label>
            When
            <select
              aria-label="When"
              value={r.trigger}
              onChange={(e) => {
                const trigger = e.target.value as JokerRule['trigger'];
                changeRule(index, {
                  ...r,
                  trigger,
                  effect:
                    trigger === 'round' ? 'dollars' : r.effect === 'dollars' ? 'mult' : r.effect,
                  conditions: r.conditions.filter((condition) =>
                    (allowedConditions(trigger) as readonly string[]).includes(condition.kind),
                  ),
                });
              }}
            >
              {Object.entries(triggers).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="creator-condition-list">
            <strong>If · ALL conditions (optional)</strong>
            {r.conditions.map((condition, i) => (
              <div className="creator-condition" key={condition.kind}>
                <ConditionEditor
                  condition={condition}
                  onChange={(value) =>
                    changeRule(index, {
                      ...r,
                      conditions: r.conditions.map((v, n) => (n === i ? value : v)),
                    })
                  }
                />
                <button
                  className="text-button"
                  aria-label={`Remove ${conditionLabels[condition.kind]}`}
                  onClick={() =>
                    changeRule(index, { ...r, conditions: r.conditions.filter((_, n) => n !== i) })
                  }
                >
                  Remove condition
                </button>
              </div>
            ))}
            <label>
              Add condition
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    changeRule(index, {
                      ...r,
                      conditions: [
                        ...r.conditions,
                        newCondition(e.target.value as RuleCondition['kind']),
                      ],
                    });
                }}
              >
                <option value="">Choose an optional condition…</option>
                {allowedConditions(r.trigger)
                  .filter((kind) => !r.conditions.some((v) => v.kind === kind))
                  .map((kind) => (
                    <option key={kind} value={kind}>
                      {conditionLabels[kind]}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="creator-fields">
            <label>
              Then
              <select
                aria-label="Then"
                value={r.effect}
                onChange={(e) =>
                  changeRule(index, {
                    ...r,
                    effect: e.target.value as JokerRule['effect'],
                    amount:
                      e.target.value === 'xmult' ? Math.max(1, r.amount) : Math.floor(r.amount),
                  })
                }
              >
                {Object.entries(effects)
                  .filter(([key]) => (r.trigger === 'round') === (key === 'dollars'))
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <NumberField
              label="Effect amount"
              value={r.amount}
              min={r.effect === 'xmult' ? 1 : 0}
              max={r.effect === 'chips' ? 100000 : 1000}
              step={r.effect === 'xmult' ? 0.1 : 1}
              onChange={(amount) => changeRule(index, { ...r, amount })}
            />
          </div>
          <p className="creator-rule-summary">{ruleSummary(r)}</p>
        </section>
      ))}
      <button
        className="button button-secondary"
        disabled={c.rules.length >= 20}
        onClick={() =>
          onChange({
            ...c,
            rules: [...c.rules, { trigger: 'main', conditions: [], effect: 'mult', amount: 4 }],
          })
        }
      >
        Add rule
      </button>
      <details className="creator-advanced">
        <summary>Advanced Joker compatibility</summary>
        <p>
          The generated fixed effects do not destroy or permanently scale the Joker, so Blueprint,
          Eternal and Perishable are supported. These declarations do not certify custom Lua.
        </p>
        {(['blueprint', 'eternal', 'perishable'] as const).map((key) => (
          <label className="creator-toggle" key={key}>
            <input
              type="checkbox"
              checked={c[key]}
              onChange={(e) => onChange({ ...c, [key]: e.target.checked })}
            />
            {key === 'blueprint' ? 'Blueprint' : key === 'eternal' ? 'Eternal' : 'Perishable'}{' '}
            compatibility
          </label>
        ))}
      </details>
    </>
  );
}

export function DeckBuilder({
  value: c,
  onChange,
}: {
  value: DeckContent;
  onChange: (value: DeckContent) => void;
}) {
  const [search, setSearch] = useState('');
  const composition = c.composition,
    cards = compositionCards(composition);
  const update = (change: Partial<typeof composition>) =>
    onChange({ ...c, composition: { ...composition, ...change } });
  return (
    <>
      <label>
        Example deck preset
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onChange(deckPreset(Number(e.target.value) - 1, c));
          }}
        >
          <option value="">Choose an editable example…</option>
          {deckPresets.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <small>
          Examples, not balanced designs. Replaces the starting setup below; mod metadata, name and
          artwork are kept.
        </small>
      </label>
      <h3>Starting cards</h3>
      <label>
        Starting-card mode
        <select
          value={composition.mode}
          onChange={(e) => update({ mode: e.target.value as typeof composition.mode })}
        >
          <option value="standard">Standard deck</option>
          <option value="modified">Modify the standard deck</option>
          <option value="rank">All one rank · any included suits</option>
          <option value="card">All one specific card · one suit</option>
        </select>
      </label>
      {composition.mode === 'standard' && (
        <p>
          Normal starting composition. No card-composition changes are generated. Base game: 52
          cards.
        </p>
      )}
      {composition.mode === 'modified' && (
        <>
          <label className="creator-toggle">
            <input
              type="checkbox"
              checked={['Jack', 'Queen', 'King'].every(
                (rank) => !composition.ranks.includes(rank as (typeof ranks)[number]),
              )}
              onChange={(e) =>
                update({
                  ranks: e.target.checked
                    ? composition.ranks.filter((rank) => !['Jack', 'Queen', 'King'].includes(rank))
                    : ranks.filter(
                        (rank) =>
                          composition.ranks.includes(rank) ||
                          ['Jack', 'Queen', 'King'].includes(rank),
                      ),
                })
              }
            />
            Remove all face cards (Jacks, Queens and Kings)
          </label>
          <p className="muted-text">
            Base-game starting selection only; not a dynamic interpretation of face-card effects
            from other mods.
          </p>
          <Choices
            label="Included ranks"
            options={ranks}
            value={composition.ranks}
            onChange={(values) => update({ ranks: values })}
          />
          <Choices
            label="Included suits"
            options={suits}
            value={composition.suits}
            onChange={(values) => update({ suits: values })}
          />
          <NumberField
            label="Copies of each rank-and-suit combination"
            value={composition.copies}
            min={1}
            max={10}
            onChange={(copies) => update({ copies })}
          />
          <p>
            Computed starting size: {cards.length} cards. Change the selections or copies to change
            this total.
          </p>
        </>
      )}
      {(composition.mode === 'rank' || composition.mode === 'card') && (
        <>
          <label>
            Starting rank
            <select
              value={composition.rank}
              onChange={(e) => update({ rank: e.target.value as typeof composition.rank })}
            >
              {ranks.map((rank) => (
                <option key={rank}>{rank}</option>
              ))}
            </select>
          </label>
          {composition.mode === 'rank' ? (
            <Choices
              label="Included suits for this rank"
              options={suits}
              value={composition.suits}
              onChange={(values) => update({ suits: values })}
            />
          ) : (
            <label>
              Starting suit
              <select
                value={composition.suit}
                onChange={(e) => update({ suit: e.target.value as typeof composition.suit })}
              >
                {suits.map((suit) => (
                  <option key={suit}>{suit}</option>
                ))}
              </select>
            </label>
          )}
          <NumberField
            label="Total starting deck size"
            min={1}
            max={260}
            value={composition.total}
            onChange={(total) => update({ total })}
          />
          {composition.mode === 'rank' && (
            <p className="muted-text">
              Cards are distributed in the displayed suit order. Any remainder goes to the first
              suits. The exact counts appear below.
            </p>
          )}
        </>
      )}
      <div className="creator-composition" aria-label="Starting composition preview">
        <strong>{compositionSummary(composition)}</strong>
        <p>Total cards: {cards.length}</p>
        <p>
          Rank counts:{' '}
          {ranks
            .map((rank) => `${rank}: ${cards.filter((card) => card.rank === rank).length}`)
            .join(' · ')}
        </p>
        <p>
          Suit counts:{' '}
          {suits
            .map((suit) => `${suit}: ${cards.filter((card) => card.suit === suit).length}`)
            .join(' · ')}
        </p>
        {cards.length < 20 && (
          <p className="creator-validation">
            Unusually small starting deck. This may make runs impractical; the preview does not
            establish balance.
          </p>
        )}
        <details>
          <summary>Expand card preview</summary>
          <ol className="creator-card-list">
            {cards.map((card, i) => (
              <li key={i}>
                {card.rank} of {card.suit}
              </li>
            ))}
          </ol>
        </details>
      </div>
      <h3>Starting resources</h3>
      <p>
        Starting money changes the initial balance once. Hands and discards change each round’s
        allowance. Hand size and slots remain adjusted for this run. Values are relative
        adjustments.
      </p>
      <div className="creator-fields">
        {(['dollars', 'hands', 'discards'] as const).map((key) => (
          <NumberField
            key={key}
            label={`${resourceLabels[key]} adjustment`}
            value={c.resources[key]}
            min={key === 'dollars' ? -4 : -3}
            max={key === 'dollars' ? 1000 : 10}
            onChange={(n) => onChange({ ...c, resources: { ...c.resources, [key]: n } })}
          />
        ))}
      </div>
      <h3>Capacity</h3>
      <div className="creator-fields">
        {(['handSize', 'jokerSlots', 'consumableSlots'] as const).map((key) => (
          <NumberField
            key={key}
            label={`${resourceLabels[key]} adjustment`}
            value={c.resources[key]}
            min={key === 'handSize' ? -7 : key === 'jokerSlots' ? -5 : -2}
            max={10}
            onChange={(n) => onChange({ ...c, resources: { ...c.resources, [key]: n } })}
          />
        ))}
      </div>
      <p>
        Base-game result preview:{' '}
        {Object.entries(c.resources)
          .map(
            ([key, n]) =>
              `${resourceLabels[key as keyof typeof resourceLabels]} ${signed(n)} → ${baseResources[key as keyof typeof baseResources] + n}`,
          )
          .join(' · ')}
        . Stakes and other mods can change final values.
      </p>
      <button
        className="text-button"
        onClick={() =>
          onChange({
            ...c,
            resources: {
              dollars: 0,
              hands: 0,
              discards: 0,
              handSize: 0,
              jokerSlots: 0,
              consumableSlots: 0,
            },
          })
        }
      >
        Reset resource and capacity defaults
      </button>
      <details className="creator-advanced">
        <summary>Advanced starting items</summary>
        <p>
          A curated vanilla selection, created once at new-run setup. No third-party items, overflow
          or Negative editions. Capacities use the configured base-game slots; other mods may change
          them.
        </p>
        <label>
          Search vanilla starting items
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Add starting item
          <select
            value=""
            onChange={(e) => {
              if (e.target.value)
                onChange({ ...c, items: [...c.items, { key: e.target.value, quantity: 1 }] });
            }}
          >
            <option value="">Choose a vanilla Joker or consumable…</option>
            {startingItems
              .filter(
                (item) =>
                  !c.items.some((i) => i.key === item.key) &&
                  `${item.name} ${item.set}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name} · {item.set}
                </option>
              ))}
          </select>
        </label>
        {c.items.map((item, index) => (
          <div className="creator-starting-item" key={item.key}>
            <NumberField
              label={`${startingItems.find((i) => i.key === item.key)!.name} quantity`}
              min={1}
              max={15}
              value={item.quantity}
              onChange={(quantity) =>
                onChange({
                  ...c,
                  items: c.items.map((v, i) => (i === index ? { ...v, quantity } : v)),
                })
              }
            />
            <button
              className="text-button"
              onClick={() => onChange({ ...c, items: c.items.filter((_, i) => i !== index) })}
            >
              Remove item
            </button>
          </div>
        ))}
      </details>
      <h3>Final deck summary</h3>
      <p className="creator-rule-summary">{automaticDescription(c)}</p>
      <p className="muted-text">
        Composition is set only at new-run initialisation, before normal shuffle. Continuing a save
        keeps its cards and modifiers. Custom composition replaces ordinary starting cards; other
        mods that change initial cards or starting resources can conflict. Test a separate run.
      </p>
    </>
  );
}
export function VoucherBuilder({
  value: c,
  onChange,
}: {
  value: VoucherContent;
  onChange: (value: VoucherContent) => void;
}) {
  return (
    <>
      <NumberField
        label="Purchase cost"
        value={c.cost}
        onChange={(cost) => onChange({ ...c, cost })}
      />
      <h3>Effect when redeemed</h3>
      <p>
        Standalone Voucher with ordinary shop availability and no prerequisite chain. The supported
        effects apply on redemption and persist for the run. Loading a save does not apply them
        again.
      </p>
      {c.effects.map((effect, index) => (
        <div className="creator-redemption" key={effect.kind}>
          <div className="creator-fields">
            <label>
              Redemption effect
              <select
                value={effect.kind}
                onChange={(e) =>
                  onChange({
                    ...c,
                    effects: c.effects.map((v, i) =>
                      i === index ? { ...v, kind: e.target.value as typeof effect.kind } : v,
                    ),
                  })
                }
              >
                {Object.entries(voucherEffects)
                  .filter(([key]) => key === effect.kind || !c.effects.some((v) => v.kind === key))
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <NumberField
              label="Increase by"
              value={effect.amount}
              min={1}
              max={10}
              onChange={(amount) =>
                onChange({
                  ...c,
                  effects: c.effects.map((v, i) => (i === index ? { ...v, amount } : v)),
                })
              }
            />
          </div>
          {['hands', 'discards'].includes(effect.kind) && (
            <p className="muted-text">
              Increases the allowance for future rounds. Does not immediately grant additional
              remaining hands or discards.
            </p>
          )}
          <button
            className="text-button"
            disabled={c.effects.length === 1}
            onClick={() => onChange({ ...c, effects: c.effects.filter((_, i) => i !== index) })}
          >
            Remove effect
          </button>
        </div>
      ))}
      <button
        className="button button-secondary"
        disabled={c.effects.length >= 5}
        onClick={() => {
          const kind = (Object.keys(voucherEffects) as (keyof typeof voucherEffects)[]).find(
            (key) => !c.effects.some((v) => v.kind === key),
          );
          if (kind) onChange({ ...c, effects: [...c.effects, { kind, amount: 1 }] });
        }}
      >
        Add redemption effect
      </button>
    </>
  );
}
