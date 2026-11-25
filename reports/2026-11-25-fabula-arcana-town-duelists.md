# Fabula Arcana: town duelists (v1.0.680)

2026-11-25 · branch `feat/fa-duelists` · phase 5, the last phase of the town-duelists plan (review page approved).
After the next GM boot, every unique NPC in Ruhig, Eisendrache and Midgard plays Fabula Arcana with its own deck,
prize order and dialogue, Midgard's residents duel with their own monster's card, and a few generic townsfolk duel too.

## Rules

- **Setup per token.** A duel setup can live on one token (`setDuelist(tokenOrUuid, cfg)`), and wins over its actor's.
  Townsfolk who share one actor (Midgard's residents on `Generic NPC`, villagers, the castle guard) each get their own.
  The "beaten" record is per token for them (`tok_<uuid>`), per actor otherwise.
- **Prize order.** `prizes: [cid, …]`: the challenge box antes the first card you don't own yet; after you win it, a
  rematch antes the next. All owned → "Friendly match", no reward. An old single `prize` reads as a one-card list.
- **Names.** A token's own name is used for the seat and the box ("Card duel with Ulfar?"), not the shared actor's.
- **Gates.** Every setup needs the "Fabula Arcana Unlocked" switch. Hidden tokens can't be challenged, so NPCs the
  story hasn't shown (Albero, Alcina, the festival cast, the King, Hilde, Geist) stay dormant until it does.

## Who duels (migration `2026-11-25-fa-town-duelists`)

- **22 actors:** Willy, Rume, Pomme (both actors), Canis, Albero, Alcina, Bruce, Wagner, Roselie, Thomas, King Seigfried,
  Nullis, Gardner, Guy, Farin, Princess Hilde, Geist (Overworld), and Midgard's Brandr, Sigrun, Solveig, Freydis.
  Their own card first in the prize order, then a deck card where approved (Rume → Roper, Canis → Rock Golem, …).
- **17 tokens:** Midgard_Map001 Ulfar, Wilhelm, Otto, Ingrid, Gunther, Hedwig, Greta, Runa; Midgard_Map005 Dietrich,
  Geirolf; Ruhig_Village011 Carpenter, Builder, Old Villager; Eisendrache Kingdom Castle Guard (×2), Villager F, Villager J.
  Generic lines; prize = one card of their deck.
- Dialogue = the approved lines (review page 1d, no edits). Existing non-empty lines are kept (Willy's challenge line).
- **Deck changes from the review page** (each approved deck must be 3 cards / 5★; three listed only two):
  King Seigfried + Bandit Archer + Wolf; Princess Hilde + Salamander + Sylph; Geist + Hellhound + Roo.
  **Greta** loses Carlbero (a Fafnir Castle monster: unseen content) for Bandit Scorpion + Pyrefly + Roper.
- Every deck is checked legal against the engine when the migration is generated.

## Also fixed (dialogue system, `dialog-ui.js`)

A token speech bubble still on screen when the scene changed kept placing itself on its destroyed token every frame:
5× "Cannot read properties of null (reading 'position')". The bubble now closes itself once its token is gone.
Shows up more now that NPC duel lines put bubbles up right before a scene can change.

## Tests

- Engine + drops tests pass (no rule change).
- Sandbox (fresh copy of today's world, headless): **12/12** — migration (22 actors, 17 tokens, Willy keeps his line,
  the shared actor itself has no setup); a Midgard townsfolk duel (box "Card duel with Ulfar?", ante Wolf, seat
  "Ulfar", themed deck, won; beaten record on Ulfar's token only; Wilhelm on the same actor stays a separate duelist
  with his Rock Golem ante); Rume's prize order (antes Rume, after winning it the rematch antes Roper).
  Bubble-across-scene-change: 0 errors (was 5).

## World data

The migration writes actor and token flags at the next GM boot; commit the world afterwards (world-export procedure).
