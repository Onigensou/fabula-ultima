# Nox Legion steal tables + Mana Burn (v1.0.684)

2026-11-26 · branch `feat/nox-steals` · plan approved in chat 2026-11-26.
Before this, every Nox monster's steal table was a single "(Empty) 100" row. After the next GM boot,
all six have real tables, and two pieces of handed-out gear do what their text says.

## Steal tables (migration `2026-11-26-nox-steals`, fixed ids `NoxSt…`, flag `noxSteals`)

| Monster | Empty | Material | Consumable | Equipment |
|---|---|---|---|---|
| Nox Ghoul | 45 | Rotten Nail 22 · Nox Cinder 13 | Acid Flask 13 | Old Bandages 7 |
| Nox Hound | 46 | Animal Fang 22 · Nox Cinder 14 | Tincture of Strength 12 | Bloodthirster 6 |
| Nox Wraith | 44 | Regret 22 · Nox Cinder 14 | Tincture of Spirit 13 | Soul Ring 7 |
| Nox Viper | 45 | Clear Liquid 22 · Nox Cinder 14 | Poison 13 | Gorgonis Shield 6 |
| Nox Priest (elite) | 40 | Torned Fabric 18 · Nox Cinder 14 | Phoenix Feather 16 | Shadow Grimoire 12 |
| Nox Executioner (elite) | 40 | Steel 18 · Nox Cinder 14 | Tincture of Endurance 16 | **Dullahan Armor 12** |

Each monster holds unequipped shells whose `_stats.compendiumSource` points at the world item (same as the
trio steals), so a steal hands over the world item with its passive. The Map010 guests (Kurona, Roo,
Carlbero, Obsidrax) already had tables and are untouched. No set items: monsters never steal-drop set gear.

## New items

| Item | Stats | Effect |
|---|---|---|
| **Dullahan Armor** | Rare · Martial · DEF 13 / M.DEF 11 · 3200z | Deal 5 extra damage to creatures with a lower HP percentage than yours. Take 5 less damage from them. |
| **Nox Cinder** | Uncommon material · 250z · not an ingredient | The Sealed Cavern's signature material. |

Dullahan Armor is tagged `flags.fabula-ultima-companion.monsterFamily: "dullahan"`, meant as the Dullahan
family's drop (a future palette-swap Dullahan gets the same item). Its passive has two force rows:
- `creature_will_deal_damage`: `DAMAGE_IS_HP == 1 && TARGET_CURRENT_HP * MAX_HP < CUR_HP * TARGET_MAX_HP` → add 5 outgoing.
- `creature_targeted_by_action`: `INCOMING_DAMAGE > 0 && ATTACKER_CURRENT_HP * MAX_HP < CUR_HP * ATTACKER_MAX_HP` → subtract 5 incoming.

Cross-multiplied so an unresolved creature (0/0) fails closed; strict `<`, so both at full HP gives nothing.

## Gear authored (text existed, wiring didn't — carrier-scan)

- **Shadow Grimoire**: `defense_target_type: "mdef"` (Magic Damage) + action keyword `mana burn`.
- **Gorgonis Shield**: Poison Resistance AE (`affinity_9`, same form as Emerald Pendant / Old Bandages).
- **Bloodthirster**: cleared the `set_name: "<Set Name>"` clone leftover (`isSet` was already false).

## Engine

- **`ATTACKER_CURRENT_HP` / `ATTACKER_MAX_HP`** (skill-formulas.js, schema 13): the HP twins of
  `ATTACKER_SPECIES_IS_<X>`, read from `attackerActorUuid` / `causeActorUuid`. On `creature_targeted_by_action`
  the payload subject is the reactor itself, so `TARGET_*` there reads the wearer. Documented in the authoring guideline.
- **Mana Burn keyword** (action-profile.js `resourceForKeywords`): a `mana burn` action keyword (weapon
  `action_keywords` or a skill's keywords) makes the hit's **resource MP**. Unlike the element-less `"mp"`
  damage type (`isMpDamage`), the hit stays a normal elemental hit: DR, crit, efficiency and **affinity apply**
  (user ruling: a Dark Mana Burn is resisted / doubled / absorbed like any Dark hit).
  - Benign's HP cap and the final-stage predicted HP skip MP-resource hits.
  - `applyDamageToTarget` MP branch: **Absorb restores MP** (clamped to max), Immune shows its cue, the loss
    number and battle log carry the real affinity / element / crit. Drain spells are unchanged (always NE).
  - state-handlers.js: the Attack COMPUTE result now carries `damageResource` (the Skill path already did by
    spreading the projection). Without it a Grimoire hit wrote nothing.
- Anti-Magic Bullet and Banshee Wail also cite Mana Burn in their text but do not carry the keyword yet.

## Tests (snapshot runner, `tools/snapshot-runner/checks/`, snapshot `snap-nox`)

- `nox-steals.js` 21/21: new docs, six tables (rows, sums, shells, uuids), steal hand-over (Bloodthirster,
  Dullahan Armor, Shadow Grimoire bring their children), both Dullahan gates both ways, `ATTACKER_*` values,
  Gorgonis Poison RS when equipped, item cards.
- `nox-battle.js` 9/9 (real sim fights): outgoing card 7 → 12 vs a 60% dummy, 15 → 15 vs a full one;
  incoming `subtract 5 … via Dullahan Armor` fires vs a hurt Ghoul and never when the wearer is the lower one;
  Mana Burn writes MP and never HP, VU swing doubled, Absorb restored MP (10 → 34 → 60), Immune took nothing.
- skill-regression `parity` + `census` clean on the branch code.

Runner notes: equipping an item in the same tick it was created leaves its AEs disabled (wait ~1 s);
Test Target Enemy Guards on its own turn (RS to everything); an NPC's `force: "hit"` doesn't always take;
sim fights act on `[SIM]` clones, so read the engine log or `updateActor` writes, not the original actor.

## Found, not changed

- **Hina's Dark Blood** writes `affinity_4` / `affinity_9` at priority 3 as `aeWhen("Crisis", "RS")`. Outside
  Crisis that resolves to NA and overrides any priority-1 gear resistance she wears (Emerald Pendant, Old
  Bandages, Gorgonis Shield). Pre-existing; for the user to decide.

## After pull

GM boot runs the migration once, then a whole-world commit. Not yet seen: a real-server first boot and a
real-table look (Sat 11-28).
