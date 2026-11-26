# Caster gacha banners — build report (2026-11-26)

Branch `feat/caster-banners` (base origin/main b280390b, v1.0.682). Review page (approved, 5 rounds):
https://claude.ai/artifact/JERJHoc46xgsx6EjF1MbCV

## What ships

Two new Hako gacha banners, each a main set plus a filler set. Every piece is Rare.

| Banner | Tagline | Main set | Filler set |
|---|---|---|---|
| Sage of Destruction | Beyond the Three Veils | Keter Rod, Gevurah Robe, Chesed Band | Moonlight Dancer (Chakram, Robe, Ornament) |
| Fey Wanderer | Moondew Lullaby | Glimmerwing Staff, Glimmerwing Robe, Glimmerwing Earring | Eternal Traveler (Handy Knives, Traveler's Cloak, Traveler's Backpack) |

**Sage of Destruction**

- Pieces:
  - **Keter Rod:** your first MP-cost offensive spell each scene gives 1 Veil (max 3). The rod grants Ain Soph Aur.
  - **Ain Soph Aur:** costs 50 MP + 3 Veil. One creature, Pierce, 【50 + level】 Non-Elemental damage with no High Roll. Afterwards Veil resets and every spell counts as new again.
  - **Gevurah Robe:** your offensive spells deal 【3 × targets】 extra damage to each target.
  - **Chesed Band:** your offensive spells can target 1 more creature.
- Set bonuses:
  - **2-Piece Mana Return:** after a multi-target offensive spell, recover 20% of its MP.
  - **3-Piece Overflow Rite:** pay 20 MP to give an offensive spell Overflow, so it hits every enemy.

**Fey Wanderer**

- Pieces:
  - **Glimmerwing Staff:** grants the spell Sprout Ward, a heal that fires when the target falls into Crisis.
  - **Glimmerwing Robe:** you start each conflict with the companion **Fairy**. She uses the normal companion slot and can be targeted. Her stats are HP 【5 + level】, DEF 10, M.DEF 13, Flying and MP 0.
  - **Fairy (Fey Light):** on her owner's turn end she heals the most-hurt ally for 【10 + ½ level】. On even rounds she removes a debuff from an ally instead, if any ally has one.
  - **Glimmerwing Earring:** your healing spells give Fey Regen (10 HP at turn start, 2 rounds).
- Set bonuses:
  - **2-Piece Moondew:** you start each conflict with 2 Moondew. Spend 1 to make a healing spell free.
  - **3-Piece Fairy's Sacrifice:** once per scene, the Fairy takes an ally's KO blow. The ally is left at 1 HP, every ally heals 【20 + level】, and the Fairy leaves.

**Fillers.** Both filler sets were text only. They're now authored and raised to Rare.

- Eternal Traveler:
  - **Cloak:** hazards −50%.
  - **Backpack:** items cost −1 IP.
  - **Knives:** also count as Sword, Spear and Thrown weapons.
  - **2-Piece:** resting restores 50% of max IP.
  - **3-Piece Ready Pack:** a free Item action, now once per battle.
- Moonlight Dancer:
  - **Chakram:** when swapped out, it makes a free attack with no High Roll.
  - **Robe:** an extra Dance per round, which must differ from your first.
  - **Ornament:** spend a matching buff to block Slow, Dazed, Weak or Shaken.
  - **2-Piece:** +2 DEF and +2 M.DEF when you dance differently from last turn.
  - **3-Piece Waltz Points:** +3 Thrown damage per point, uncapped.

## Engine changes

- **Hazard damage reduction** (`hazard_damage_reduction_pct` flag, capped at 75%).
  - In battle it applies to status-condition ticks (Burn, Envenomed) and to effects tagged "hazard" (Scorching Ground, and the Valley storm's Lightning Rod, now tagged).
  - Outside battle it applies to dungeon traps, tiles, travel, buried explosives and event-row damage.
  - It does **not** key on the ledger cause "hazard". That cause also covers monster riders and self-recoil.
- **Rest IP** (`rest_ip_recover_pct`): applies on camp and inn rests, not on story recovery.
- **Reaction rows:**
  - `apply_ae ae_remember_from` copies another effect's remembered action.
  - `free_action exclude_skill_refs` supports `remembered:<AE>`.
  - `free_action action_ref "container"` attacks with the carrier passive's own item.
- **`status_trade` gear rule:** spend the matching buff instead of gaining the status.
- **Pseudo-weapon range:** a PC weapon staged as a free-action preset now keeps its `weapon_range`. Before, it was always Melee.
- **`reaction_max_scope: "skill"`:** once per triggering skill name per battle. The quota bucket includes the reactor's `skillCapCycle` flag, so a stacked +1 effect re-opens every quota.
- **`ignore_hr`** is now honoured on Skill/Spell damage. The action card shows "Fixed damage — no High Roll".
- **`spell_extra_targets` gear key:** +N max targets on offensive spells. An exact count becomes "up to" (N+1), and "× T MP" costs follow the real count.
- **Stale target count fixed:** `refreshReactionSubjects` now refreshes `payloadAtFire` targets after an add_target. Without this, per-target formulas saw the pre-Overflow target count.
- **New identifiers:** `ALLY_DEBUFFED_COUNT`, `ANY_ALLY_HAS_DEBUFF`.
- **Menu labels:** Veil and Moondew charges are labelled in the skill picker.

## Data migrations (seed-only, fixed ids)

1. **`2026-11-26-caster-fillers`:** Eternal Traveler and Moonlight Dancer. It also:
   - gives Hunter Boots the same hazard effect (its printed text already said so);
   - tags the Lightning Rod debuff as a hazard;
   - points the three Moonlight icons at the Forge copies in `Item Icon/Valkyrie Connect/`.
2. **`2026-11-26-fey-wanderer`:** the Fey Wanderer pieces, spell, Fairy actor and set. It also adds a `skill_tags: "heal"` tag to every Heal and Regen spell, in the world and on every actor copy.
3. **`2026-11-26-sage-of-destruction`:** the Sage pieces, spell and set, plus both banner tables (cloned from the Warden table).

## Tests

- Snapshot runner `checks/caster-fillers.js`: **16/16**.
  - Data, set grants, hazard on all three paths (with Crush and lethal formulas excluded), IP, rest flag, Knives alias.
  - Ornament status trade, Last Turn Dance snapshot, Waltz uncapped and reset, Moonlit Step buff.
- Snapshot runner `checks/caster-sets.js`: **15/15**.
  - Data, both banners (taglines, main and filler sets), Fairy actor stats.
  - Chesed Band (Iceberg up to 2, Glacies Finis up to 4), Veil cap and Ain Soph Aur cycle, Sprout Ward.
  - A sim fight where the Fairy is summoned at conflict start and Fey Light heals.
  - The Fairy's Sacrifice save row, which does nothing when no Fairy is alive.
- skill-regression parity and census: clean.

## Not tested / owed

- **Real-server first boot** of all three migrations, then a whole-world commit.
- **Live, interactive:**
  - the Robe's extra-Dance prompt;
  - the Chakram swap-out throw;
  - the Overflow Rite pill and its +20 MP;
  - Moondew's free cast;
  - Ain Soph Aur's damage on a real card;
  - the Fairy's Sacrifice save with a living Fairy in a real fight;
  - the even-round cleanse.
- **Fairy art:** the Sylph sprite (`Beastiary/Sylph_Standard.png`, scale 0.9), user pick 11-26.
- **Sprout Ward** stays 【HR + 30】 (a flat 30, since heals do not roll): user call 11-26, the value is the automatic tick, not the heal size.
