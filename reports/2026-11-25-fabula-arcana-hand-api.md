# Fabula Arcana: hand model v2 + "create a card and add it to the hand" API (v1.0.676)

2026-11-25 · branch `feat/fa-hand-api` · phase 2 of the town-duelists plan (review page: hand model, API surface,
created-card animation and safeguards all approved).

Nothing changes in today's game: no card creates anything yet. This is the groundwork for the new NPC cards
(phase 4: Willy, Rume, Pomme, Alcina, Farin create cards) and for any future "create a card" effect.

## Rules

- **A hand holds counts.** `pl.items[key]` is a number (old saved states hold 0/1/true and read the same). The six
  items still start at 1 each.
- **Created cards** live in `Catalog.ITEMS` with `created: true`. They never start in the hand, Hako never restocks
  them, and they leave the hand when used. Their effect is **data** (`fx`), read by the same steps as the items:
  `atk` / `def` (this round; Smoke Bomb ignores the DEF like Golem's), `spd` (this round, SPD cap applies),
  `heal` (before attacks), `dmg: { n, el }` (before attacks, ignores DEF and items; `el` = the element chart applies).
- **Hand cap: 8** (`CFG.HAND_MAX`). A card created into a full hand fizzles ("Hand full").
- **Registered created cards** (the approved drafts; phase 4's sims may retune): Lucky Trinket (+1 ATK +1 DEF),
  Grape Juice (+1 ATK +1 SPD), Apple Bomb (2 Fire before attacks), Hearty Stew (heal 4), Arcana: The Sun / Moon /
  Star (+2 ATK / +2 DEF / heal 2), Whetstone (+2 ATK). Icons are existing Forge art (no uploads).
- Created cards count as "items" for every existing rule that reacts to one (Mana Ray, Nullis, Raubens, Jack).

## API

```js
// engine (pure): abilities call addToHand at their own timing step (ev.added drives the duel window)
Engine.Hand.add(state, seat, key, { n, source })   // → { ok, s, k, n, fizzled, src }; logs "CARD CREATED"
Engine.Hand.count / size / list / keys / isCreated / restore / MAX
// Foundry (host / GM)
FUCompanion.api.fabulaArcana.addCardToHand(sidOrActorId, "GRAPE", { n, source, seat })
FUCompanion.api.fabulaArcana.hand.created()          // the created-card keys
```

`addCardToHand` lands at once while that seat is choosing and hasn't committed; otherwise it waits for the seat's
next choice (flushed after the step resolves). It never restarts a round clock. Every viewer gets an `added` message.

## Duel window

- Created cards in the hand: dashed gold border, "CREATED"; a duplicate shows a ×N badge. The item row lists held
  created cards (dashed) and counts. The opponent sees one face-down card per card held.
- A created card appears over the side's active card, glints and flies into the hand; a banner says who made it
  ("Pomme creates Apple Bomb" + its text). A fizzle pops "Hand full".
- Playing one: the matching item burst + sound from its `fx` (Strength / Golem / Remedy / fire hit / Café).

## Also in this branch (phase 1 fix)

- `fa-entry.js`: the NPC's challenge bubble closed itself only after a long hold and sat ABOVE the duel window
  (seen over the duel's title). It is now closed on every client when the party picks **Duel!**
  (`FU.DialogUI.control(bubbleId, "close")`).

## Engine + Hako + AI

- `supplyStep` (Hako) restocks base items only, via `Hand.restore`; its "3 used" count reads base items only.
- AI: created cards are weighed from their `fx` (kill chances through the normal damage estimate, DEF when about to
  fall, heals when hurt, SPD to win a race, `dmg` lethal checks with the element chart). The Hako switch heuristic
  counts base items only.

## Tests

- Engine: **195 pass** (22 new: counts, cap/fizzle, log, validation, duplicates, Grape SPD/ATK, Moon DEF vs Smoke,
  Stew, Apple Bomb + Weak, `ev.added` mirroring, Hako ignores created cards, casual + skilled AI play a lethal
  created card, old 0/1/true hands). Drops tests pass.
- **Balance unchanged:** 1,100 seeded AI games (800 casual + 300 skilled, identical teams and RNG) produce a
  byte-identical report on `main` and on this branch.
- Sandbox (today's world copy, headless): **16/16** — live Willy duel: add while choosing (flight, created style,
  item row, banner), cap 8 (1 lands, 2 fizzle, ×2 badge), Apple Bomb resolves before attacks and leaves the hand,
  queued add after a commit lands on the next choice, a card for the AI seat by session id, face-down count,
  refusals. Phase 1's sandbox suite re-run on this branch: **26/26**. 0 related console errors.
