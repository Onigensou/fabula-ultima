# Trio elite steals (v1.0.681)

2026-11-26 · branch `feat/trio-elite-steals` · tuning page approved (picks pasted back 2026-11-25).
After the next GM boot, each of the Valley trio elites holds one Legendary item at a 100% steal rate.

## Items (migration `2026-11-25-trio-elite-steals`, fixed ids `TrEl…`)

| Item | Stolen from | Stats | Effect |
|---|---|---|---|
| **Asura Blade** | Asura | Sword · Two-handed · Melee · Martial · DEX+MIG +0 · HR+10 Physical · 4000z | On hit, you may spend 10 MP to change the damage type to Air, Bolt, Fire or Ice. Grants **Asura Strike**. |
| **Asura Strike** (granted) | — | 30 MP · All enemies · DEX+MIG vs M.DEF | `pierce, chain 4 seek`; strikes are Bolt, Fire, Ice, Air (`flags.chainElements`), HR+10 each. The monster's move without the Mark reset. |
| **Rakshasa Armor** | Rakshasa | Martial · DEF 13 / M.DEF 12 · 3800z | Attacks and skills with Bow, Flail, Sword or Thrown weapons deal 5 extra damage, 10 in Crisis. |
| **Mukuta** | Deva | Accessory · 4000z | Max HP +12%, Max MP +12%, 6% more damage. |

## How they are built

- **Asura Blade's switch** is a card pill, Thermokinesis's pattern: `creature_will_deal_damage` ask →
  `open_action_menu` (Air/Bolt/Fire/Ice) → `consume_resource` 10 MP + `change_damage_element`. The card
  re-computes the hit with the new element before RESOLVE (Barrage-style: you see the card, add the modifier).
  A `creature_performs_action` prompt was tried first and does NOT work: it applies after the damage pass.
- **Rakshasa Armor**: one `creature_will_deal_damage` force row, `adjust_damage` add `5 + 5 * HAS_STATUS_CRISIS`,
  gated `DAMAGE_IS_HP == 1 && ((ACTION_IS_ATTACK == 1 && USED_WEAPON_CATEGORY_IS_<bow|flail|sword|thrown>) ||
  (ACTION_IS_SKILL == 1 && HAS_WEAPON_CATEGORY_<…>))`. Flat on purpose: % bonuses compound when stacked.
- **Mukuta**: two transfer effects on `max_hp` / `max_mp`, MULTIPLY 1.12 at priority 50 (after flat adds),
  `flags.roundUp` (csb-ae-round-up.js); passive multiply 1.06 outgoing.
- **Steal tables**: one row at 100% each. Asura's Demongrin placeholder row + catalog entry are replaced (the
  Demongrin item stays on Asura). Each elite holds an unequipped shell whose `_stats.compendiumSource` points at
  the world item, so a steal hands over the world item with its skill + passive.

## Engine

- New formula identifier **`ACTION_IS_SKILL`** (skill-formulas.js): 1 for a non-spell Skill (`actionKind` skill,
  `actionSkillType` not spell). Attacks, spells and items read 0.

## Tests (snapshot runner, `tools/snapshot-runner/checks/`)

- `trio-steals.js` 18/18: data, steal tables, steal hand-over (skill + passive copied), Mukuta 129→145 HP /
  122→137 MP and back, Rakshasa DEF 13 / M.DEF 12, item cards (Grants · Asura Strike).
- `trio-battle.js` 8/8: gates (attack yes, weapon skill yes, spell/item/MP no; 5 → 10 in Crisis), a sim fight:
  Asura Blade hit switched to Air (card 17 → 23 with +5 and ×1.06), Asura Strike 4 strikes Bolt/Fire/Ice/Air.
- skill-regression `parity` + `census` clean.
- Runner notes: CSB derived props keep a `-=` deleted key until reload (read `_source`); a sim clone can start
  with MP above max ("debited 24" for a 10 MP cost is the clamp); Hina's Lucky Number flips hits when the sim
  auto-applies it.

## After pull

GM boot runs the migration once. Not yet seen: a real-server first boot and a real-table look (Sat 11-28).
