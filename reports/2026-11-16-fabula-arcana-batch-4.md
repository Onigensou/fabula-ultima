# Fabula Arcana: batch 4 cards (Bruce V, Nullis, Gardner) + Jack's Thief Bow (v1.0.619)

Three new ★★ character cards and a new ability for Jack. No world data. Branch `feat/fa-batch4`.

## Cards

| Card | Element / Role | ATK/HP/DEF/SPD | Ability |
|---|---|---|---|
| **Bruce V** ★★ | Physical Striker | 4/10/0/2 | **Teleportation Strike**: his attacks ignore 2 DEF. |
| **Nullis** ★★ | Light Punisher | 3/11/1/2 | **Null Guard**: +3 DEF in a round the opponent uses an item. **Rival**: +1 DEF for the rest of the match once Gardner falls. |
| **Gardner** ★★ | Earth Guardian | 3/10/2/1 | **Heavy Armor**: +2 DEF in a round the opponent Passes. **Rival**: +1 DEF for the rest of the match once Nullis falls. |
| **Jack** ★★ (changed) | Poison Hunter | 3/**11**/0/3 (HP was 10) | **Thief Bow**: +2 ATK in a round the opponent uses an item. Twin unchanged. This replaces "attacks ignore DEF". |

- Bruce V is the game's "tutorial boss", so he's tuned to sit mid-pack.
- Nullis and Gardner are rivals. Both are ★★, so they fit on one team with a ★ card, like Jack and Jill. Rival is a second ability, an exception for story reasons like Twin.
- "Uses an item" counts all six items (same trigger as Mana Ray). Only the opponent's item counts, not your own.

## Rules details

- These DEF bonuses add to card DEF, so the usual rule applies: a hit always does at least 1.
- Smoke Bomb ignores all of them.
- Bruce's "ignore 2 DEF" applies to card DEF only (printed DEF plus these bonuses), never below 0. Golem Fragment's +3 block still applies in full against him.
- **Deferred (user, 11-16):** making Golem Fragment a true DEF buff (with the min-1 rule) is noted for later rule work. It's not part of this change.

## Code

- **fa-catalog.js:** the three cards, Jack's text and HP, SPD values, and the tuning numbers `CFG.PIERCE 2 / THIEF_BOW 2 / NULL_GUARD 3 / HEAVY_ARMOR 2 / RIVAL 1`.
- **fa-engine.js `calcAttack`:** Thief Bow, Null Guard, Heavy Armor, Rival (reuses the Twin KO check), and Bruce's pierce. Each one names itself in the attack breakdown. The AI's damage estimate uses the same function, so no AI hints were needed.
- **Duel window:**
  - Ability bands for all five (Thief Bow and Teleportation Strike on offence; Null Guard, Heavy Armor and Rival on defence).
  - A Rival status tile, and Rival shown in the DEF stat chip.
- **Art:**
  - New stills at `Fabula Arcana/Character Cards/Bruce V.png`, `Nullis.png` and `Gardner.png`. They come from the NPC art with the baked ground shadow removed (only the semi-transparent shadow pixels were deleted; nothing was painted).
  - All three face left, so they're added to `FACE_LEFT`.
- **Tests:**
  - `fa-engine.test.mjs`: 156 pass. Added checks for Thief Bow (own item doesn't count), Bruce against DEF and against Golem, Null Guard (and Smoke ignoring it), Heavy Armor (Pass vs item round), Bruce against Heavy Armor, and Rival on/off. The pool is now 38 cards.
  - `fa-drops.test.mjs` passes.

## Balance

fa-balance, 6000 casual / 3000 skilled, seed 11:

| Card | Casual | Skilled |
|---|---|---|
| Nullis | 56.5% | 44.9% |
| Gardner | 53.3% | 49.0% |
| Jack (Thief Bow, HP 11) | 52.0% | 48.5% |
| Bruce V | 46.7% | 44.5% |

- Draws: 3.7% casual / 1.9% skilled.
- Round cap: 4.8% / 1.6%. Main with the same seed was 3.6% / 2.2%.
- With HP 10, Thief Bow Jack fell to 39.8% skilled, because the skilled AI simply stops using items into him. HP 11 brings him back to his old level.

## Heads-up

The duel window was checked headless only (net mode with the engine in the page): bands, attack lines, the Rival tile and chip, art, and facing. It hasn't been checked on the Staging World or at a real table yet.
