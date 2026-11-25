# Fabula Arcana: card text, Genius Invokation style (v1.0.677)

2026-11-25 · branch `feat/fa-card-text` · phase 3 of the town-duelists plan. Every row of the text review was
approved, plus two rules from the user: **"this unit" instead of any pronoun**, and **"Bench" stays**.

Only words change. No number, timing or rule changed (engine tests 195/195 unchanged).

## The house rules (now in the design guide's decision log too)

1. Trigger first, then a colon: "When Switched In:", "After this unit attacks:", "When this unit is KO'd:", "While active:".
2. "+X ATK" boosts an attack, "Deal X DMG" is direct damage, "Heal X HP".
3. Statuses are named on the card and defined once, as a keyword tooltip.
4. Limits are short trailing tags: "Once per Match." · "Duration (Rounds): 3." · "Max 1 in hand."
5. "Piercing DMG" = ignores DEF and items, Elementless unless an element is named.
6. "this unit" for the card itself, never he / she / it. Board words: active, Bench, your / enemy, "card".
7. Defaults and edge cases (SPD max 5, ties) live in the rules panel, not on cards.

## What changed

| Where | Change |
|---|---|
| `fa-catalog.js` | 39 card texts (every card in play), 3 item texts (Smoke Bomb, Elemental Shard, Café au Lait), new `Catalog.KEYWORDS` (8) |
| `assets/fabula-arcana/duel.html` | its own 23 monster texts (standalone mockup copy; in game the catalog wins); `kwText()` wraps keywords in card text with a dotted underline + definition on hover / focus; the keyword list comes from the catalog in game |
| `data-migrations/2026-11-25-fa-card-item-text.js` | **idempotent**: rebuilds the description of every owned card item from the catalog (only those that differ). After a later text change, bump `TEXT_VERSION` |

Keywords: Switched In · Enters · Piercing DMG · Burn · Charmed · Berserk · Regen · Dive Ready.
Burn's definition was reworded for the no-pronoun rule ("Pyrefly's next attack on this unit uses up Burn for +4 ATK.").
Hina keeps "as soon as it's placed": that "it" is the opponent's card, not the unit.

## Tests

- Engine tests 195/195 (no rule touched).
- Sandbox (today's world copy, headless): migration ran on first boot; **21/21** owned card items on 5 actors carry
  the new text; catalog keywords and item texts present; team select draws the new text with the keyword
  tooltips (Piercing DMG, Dive Ready, Regen, Burn, Berserk, Switched In, Charmed seen). 0 related console errors.

## World data

The migration edits card items on actors at the next GM boot; commit the world afterwards with the usual
world-export procedure.
