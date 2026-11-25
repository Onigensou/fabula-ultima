# Fabula Arcana: 12 town NPC cards (v1.0.679)

2026-11-25 · branch `feat/fa-npc-cards` · phase 4 of the town-duelists plan. Designs approved on the review page
(rounds 1–3), numbers approved after the sims (round 4). The pool grows from 39 to 51 cards. They are character cards
(never monster drops, never starter gifts); players win them from the NPCs (phase 5 sets up the duelists).

## The cards (ATK / HP / DEF / SPD · win % vs random full teams, casual / skilled)

| Card | | Stats | Ability | Win % |
|---|---|---|---|---|
| Willy | ★ Bolt Support | 3/10/1/2 | The first time this unit is Switched In: create 1 Lucky Trinket. Once per Match. | 52.8 / 52.3 |
| Rume | ★★ Light Support | 3/11/1/2 | When this unit Passes: create 1 Grape Juice. Max 1 in hand. | 52.6 / 48.2 |
| Pomme | ★★ Fire Striker | 4/10/0/2 | After this unit's attack deals damage: create 1 Apple Bomb. Max 1 in hand. | 52.2 / 51.2 |
| Canis | ★★ Phys Striker | 3/11/1/2 | After this unit's attack deals damage: the target loses 1 DEF for the match (min 0). | 53.8 / 52.6 |
| Albero | ★★ Earth Guardian | 3/11/1/2 | Takes −1 DMG from attacks while your side has fewer cards standing. | 45.5 / 43.3 |
| Alcina | ★★ Light Support | 3/11/1/2 | When this unit is Switched Out: create 1 Hearty Stew. Once per Match. | 51.3 / 45.5 |
| Wagner | ★★ Phys Survivor | 3/11/1/2 | The first time this unit would be KO'd by an attack, it stays at 1 HP. Once per Match. | 52.3 / 54.8 |
| Roselie | ★★ Fire Striker | 3/9/0/3 | When this unit attacks: 1 Piercing Fire DMG to each enemy Bench card. | 47.5 / 47.8 |
| Thomas | ★★ Earth Support | 3/12/1/2 | When this unit is KO'd: your next card gains +2 DEF for 2 rounds. | 50.3 / 53.2 |
| King Seigfried | ★★★ Light Support | 4/12/1/1 | While active: your items with a number get +1. | 52.4 / 53.4 |
| Guy | ★★ Phys Guardian | 3/10/1/2 | +1 DEF after a full round as the active card; resets when he leaves. | 49.2 / 49.9 |
| Farin | ★★★ Dark Support | 3/11/1/2 | Start of round, while active: create 1 random Arcana. Max 1 in hand. | 45.9 / 46.3 |

**Apple Bomb now deals 1 Piercing Fire DMG** (was 2): the 2-damage draft made Pomme 69 / 76%.
Created cards are named on the cards with keyword tooltips (Lucky Trinket, Grape Juice, Apple Bomb, Hearty Stew, Arcana).

## Balance (fa-balance 6000 casual + 3000 skilled, seeds 11 + 23, all 12 in the pool)

- 11 of 12 in the 45–55% band in both modes; Albero 1.7 points under for skilled (noise is about ±2).
- Round cap 3.6–3.8% / 1.3–1.5% (today 3.2% / 1.4%); draws 3.6–4.0% / 2.0–2.6%; median 13 rounds (today 12).
- The draft Albero (2/12/2/1) sat in 4.5× more round-cap games than chance (cap 6.5–7.6%); a hitting Albero fixes it.
- Existing cards, casual: Love +8.5, Rock Golem +5.1, Blanche +4.1; Hako −5.1 (already the weakest), Hilde −4.0.
- **Same rules as simmed:** with a seeded RNG (scratchpad `seeded-balance.mjs`), the sim harness and this branch's
  engine produce byte-identical reports (headline + 102 per-card lines). Note: `fa-balance.mjs` picks teams with an
  unseeded `Math.random`, so two plain runs never play the same games; use the seeded wrapper to compare versions.

## Code

| File | Change |
|---|---|
| `fa-catalog.js` | 12 cards + SPD; constants WILDFIRE 1, ARMOR_BREAK 1, ELDER 1, LAST_CALL 2, TRAVELER_MAX 1, DECREE 1; Apple Bomb 1 dmg; 5 keyword tooltips |
| `fa-engine.js` | the 12 abilities (DEF step: Armor Break / Seasoned Traveler / Last Call; Royal Decree on the six items; Village Elder; Hearty Laugh; Wildfire Kiss; card creation via the hand API for Willy / Rume / Pomme / Alcina / Farin); AI hints: Rume Passes for juice, Alcina switches out to leave the stew |
| `fa-const.js`, `duel-assets.js` | card art (Forge `Fabula Arcana/Character Cards/<Name>.png`, shadow-free stills of the NPC sprites, uploaded 11-25); FACE_LEFT for the 12 |
| `fa-balance.mjs` | ability-fired patterns for the new cards |
| `fa-engine.test.mjs` | pool 51, Apple Bomb at 1, 16 new checks (one per ability, stars, no gendered pronouns, Willy + Hilde legal) |

## Tests

- Engine **211 pass** (16 new), drops pass.
- Sandbox (today's world copy, headless): 12 card items granted with catalog text, all 12 arts load from Forge,
  pool 51, team select lists and draws them with art, created-card keyword tooltips, and a live practice duel where
  Rume's Grape Juice and Pomme's Apple Bomb are created and the bomb lands. 0 related console errors.
