# Hako's randomized equipment roster (2026-11-25, branch feat/hako-roster)

The developer no longer hand-picks Hako's equipment every chapter. Her weapons, armor, shields and accessories reroll at
the camp Rest from a curated pool; consumables refill, tackle stays. Designed with a playable mockup first:
https://claude.ai/artifact/FnYQgjue2mmgoLXj5A5VJG

## What the table sees
- Players: Hako's shop simply has different equipment after a Rest. Nothing else changes for them; they never see the
  GM card or console.
- GM: a whisper after the Rest ("🎲 Hako restocked"), grouped by category with rarity dots, prices and tags
  (SIGNATURE = the guaranteed Legendary, REPEAT = something the party already owns, PIN). Buttons: Reroll, Undo,
  Lock roster, Open console.
- GM console (card button, or the GM-only **Roster** button on Hako's shop window): **Pool** (status of every item, odds
  of appearing next roll from 400 simulated rolls, editable price, Pin / Off / Authored ✓ / remove, drop a world item to
  add it), **Roll rules** (slots per category, rarity weights with the average per roster, signature + Legendary cap,
  repeat weight, cooldown, stock rules), **History** (every roll with its seed).

## Rules of one roll (scripts/shop-system/shop-roster-engine.js, unit-tested)
1. Never rolls: set pieces, retired items, switched off, **needs authoring**, and (stock rules) items stealable from any
   monster or sold by another shop right now.
2. Owned gear is the **last tier**, not excluded (user 2026-11-25): it only fills a slot when a category has no unowned
   item left, so Hako never runs out. Ownership = party PCs + stash, matched by source id or by name with the refine
   prefix stripped ("+7 Psychic Dagger" counts as Psychic Dagger).
3. Pins first, then one unowned Legendary (signature), then each slot picks a rarity by weight (Rare 55, Uncommon 32,
   Legendary 8, Common 5; cap 2 Legendary), then an item; the roster being replaced rolls at ×0.25.
4. Default slots 8 weapons / 4 armor / 2 shields / 5 accessories (Hako's current stock shape).

## When it runs
`RestAPI.perform()` awaits it after the party is restored, before the save ceremony, so the save holds the new stock.
Primary GM only; once per 12 h (a second Rest the same night keeps the roster); Lock keeps equipment but still refills
consumables. Shop listings carry `flags.fabula-ultima-companion.rosterSource`; state lives in Hako's
`flags.fabula-ultima-companion.shopRoster` (saved with her by the shop extractor).

**Save/load:** the save system keeps shop stock that differs from its world master (authored-kit safety rule), which
left the newer roll on sale next to the restored stock. A phase-2 extractor `shopRosterSync` (stores nothing) now lines
roster shops up with their restored record after the load; matching listings are untouched, so sold-out states survive.

## Migration 2026-11-25-hako-shop-roster (seed-only)
Pool = 80 equipment items from Hako's stock ledger (`_source` stealable_loot: CSB re-derives the live field from current
items only) + current listings; 21 items marked "needs authoring" (carrier-scan: effect text with no automation);
Emergency-Radio retired; consumable `baseQty` from the Chapter 4 stock; Biker Suit + Heat HANDS Replica → Rare.

## Tested
- Unit: `node modules/fabula-ultima-companion/scripts/shop-system/shop-roster-engine.test.mjs` (34 checks).
- Snapshot runner: `tools/snapshot-runner/checks/shop-roster.js` 31/31 (migration, rules, purchase → owned, all shields
  owned → REPEAT fallback, undo, lock, cooldown, real RestAPI path, console, shop-window button).
- Real server sandbox (2 clients): first-boot migration 0 failed; rerolls 0 errors / 0 toasts / 0 orphans; player sees no
  card; save → reroll → load returns the exact saved stock and record; a sold-out listing comes back sold out.

## Owed / follow-ups
- First GM boot after the pull runs the migration (live world).
- Authoring pass for the 21 text-only items (Dominatrix Leotard, Biker Suit, Little Devil, Witch Hat are on sale now).
- Party-shared tackle (separate to-do; fishing minigame update).
