# Monster of Frankensteiner rework

2026-11-26 · branch `feat/frankensteiner-rework` · design from the review page (rounds 1–2 + v3 cards), convert call = option B (page default).
Goal: no permanent Bolt Absorb on gear (it shut down Bolt monsters, and Fafnir is a Bolt boss). Pieces are Rare, the 2-Piece is priced at Rare, the 3-Piece at Legendary.
**The set's gacha banner is out of the gacha for now** (user call). The pieces stay in the world, unowned.

## Items (migration `2026-11-26-frankensteiner-rework`, flag `mofRework`)

| Piece | Stats | Effect (as written on the item) |
|---|---|---|
| **Stitched-Up Jacket** | Rare armor · DEF +1 / M.DEF +1 · 3000z | Absorb the next Bolt damage you take. Recharges at the start of your turn. |
| **Silver Bolt** | Rare accessory · 1500z | When you take or Absorb Bolt damage, gain Strong. · When you take damage, you may change it to Bolt damage. Recharges at the start of your turn. · Converted damage can't be Absorbed. |
| **Lightning Rod** | Rare spear · MIG+WLP · HR +6 (was +8) · 2500z | When you take or Absorb Bolt damage, gain 1 Overcharge: this weapon deals 5 extra damage. Lasts 2 turns. Each stack has its own timer. Max 3 stacks. · On hit, 10% chance to inflict Paralyzed, +10% per Overcharge. |
| **2 Piece** · Galvanic Feedback | | When you Absorb damage, recover MP equal to the amount absorbed. Once per round. |
| **3 Piece** · Spark of Life (new) | | When you Absorb Bolt damage, gain 1 Spark of Life (max 3). At 3, a hit that would reduce you to 0 HP leaves you at your Crisis score instead, and the stacks are spent. Spark of Life is lost at the end of the scene. |

## How they are built

- **Damage triggers use the resource ledger.** A hit taken is `creature_lose_resource` (HP), and an absorbed hit is `creature_gain_resource` (HP). Both carry the true element, so the rows gate on `TRIGGER_DAMAGE_IS_BOLT == 1`. The Bolt rows have no cause filter, so a Bolt hazard (Lightning Storm) feeds Strong, Overcharge and Spark too. The 2-Piece uses cause `damage`, so only absorbed hits from creatures give MP.
- **Jacket:** a `Bolt Absorb` AE (`affinity_3` = AB, priority 30) on the Jacket's passive.
  - It is applied at turn start and conflict start with duplicate mode `skip`, deleted when a Bolt hit is absorbed, and removed at conflict end.
  - Why `skip`: a `replace` over an unspent charge reads its AB as native, and the apply guard then drops the new copy's override.
- **Silver Bolt's convert** is a defender card pill on `creature_targeted_by_action` (ask), shown when `INCOMING_DAMAGE > 0`, the hit is not already Bolt, and the `Silver Bolt Ready` charge is up.
  - The chain is `change_damage_element bolt` + `consume_charge silverbolt`, refilled at turn start.
  - The card recompute already folds a defender candidate's element op (`computeSenderDamageBonuses` reads its subject), so the retype needed no new card code.
- **Overcharge:** one AE per stack (`stack`, `ae_duration_rounds 2`, `target_turn_end`), capped by `AE_COUNT_OVERCHARGE < 3`.
  - Damage is a `creature_will_deal_damage` force row: `+5 * AE_COUNT_OVERCHARGE`, weapon-used gate.
  - Paralyze uses the Rusty Pipe shape: `creature_deals_damage`, weapon-used, `trigger_subject`, `ae_chance_percent 10 + 10 * AE_COUNT_OVERCHARGE`.
- **Spark of Life:** a counter AE (`chargeKey spark`, max 3) added on a Bolt absorb.
  - The KO save rides the AE's own `reactionConfig` (Life Charm's chain): incoming `cap CUR_HP - 1`, then the card, KO pose, revive FX, `set_resource hp = floor(MAX_HP / 2)`, rise.
  - `consume_self` spends the stacks. `reaction_last_resort`, so another save goes first.
- **Set table:** 2 → Galvanic Feedback (rewritten), 3 → Spark of Life (new skill inside the set doc). `set_description` is the same on all three pieces.
- **Banner:** table `5vK0Z321GuAYlywn` moved to a new RollTable folder "Retired Banners" inside Wonderous Gachapon. `listBanners()` only reads the banner folder itself, so moving the table back restores the banner. No other banner's pool holds these pieces, and Hako's roster already skips set pieces.

## Engine

- `change_damage_element` gets a new row field **`element_no_absorb`** (registry column "Can't Be Absorbed"; the boot sync adds it to the templates).
- When set, an Absorb affinity to the new element reads as normal damage (`action-profile` AB → NE). Resistance and Immunity are unchanged.
- Files: `template-field-registry.js`, `skill-effects.js` (element op `noAbsorb`), `action-profile.js`.

## Tests

- Snapshot runner `checks/mof-rework.js` on snap-mof: **17/17**.
  - Covers data, set grants, banner list, a 4-round sim (Jacket absorb, spend and refill; convert Fire → Bolt not absorbed; Strong; Overcharge timers; Rod +5 per stack; Paralyze at a forced 100%; 2-Piece MP = absorbed amount; Spark 1 → 3, then cleared at conflict end), and the Spark save directly (no save at 2, save at 3).
- skill-regression parity + census: clean.
- **Not run:** real-server first boot, real-table look, the save against Fafnir's actual Cruel Ultimatum, and which bosses are immune to Paralyzed.

## Owed

- Data/ pull. The first GM boot runs the migration; then commit the world.
- Real-table look.
