---
id: 2026-11-26-percent-stat-rules
title: Heads-up — % stat rules now live in the Battle Director damage path
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-formulas, battle-director/action-profile
introduced_in: 4bbd74b5
fixed_in:
---

Not a bug: a design change onigensou approved on 2026-11-26 that touches two of your
files. Read-only for you unless something looks wrong. Close it (`status: verified`)
once you've had a look.

## What changed

One shared file now decides how % bonuses combine:
`modules/fabula-ultima-companion/scripts/shared/stat-rules.js`.

1. **Damage reduction %** (`damage_receiving_percentage_*`): still summed (All + range +
   element + Orbment), then run through a quiet diminishing curve before `1 − pct/100`:
   exact up to 30%, then each point counts for less, never 100%
   (30 → 30, 40 → 38, 60 → 51, 100 → 65). Negative totals (vulnerability) are not curved.
   - `skill-formulas.js` `resolveIncomingReduction`: one line, `pct = effectiveReductionPct(pct)`.
     The breakdown part now reads the final number, e.g. `Reduction (38%)`.
   - `apply-damage-core.js` `getTargetPctMultiplier`: same curve; Orbment % now joins the
     sum before the curve (it used to multiply separately on this path only).
2. **Damage % (outgoing)**: new `damage_outgoing_percentage_{all, melee, ranged, spell,
   <element>}` family (hidden sheet props, migration `2026-11-26-percent-stat-keys`).
   Summed, then folded into the attacker multiplier.
   - `skill-formulas.js`: new export `resolveOutgoingPct()`.
   - `action-profile.js`: the primary builders carry `outgoingPct`; `atkDmgMult` gains
     `× (1 + outgoingPct/100)`; `atkMultSource()` labels it `Damage +X%` when it is the only
     multiplier.
3. **Max HP / MP %**: MULTIPLY effects on `max_hp` / `max_mp` ADD together (×1.10 + ×1.05 =
   +15%) instead of compounding, floored. Hooked at `ActiveEffect._applyMultiply` (libWrapper,
   installed at init). Real Actor documents only.

## Evidence (sandbox boot, real server)

- Hina, +25% and +15% damage reduction: a 100 Physical melee hit → 100 − 7 flat = 93 → ×0.62
  = **58** (`resolveIncomingReduction`); `apply-damage-core.compute` agrees (×0.62).
- Hina attack, weapon HR 5 + 10: preAffinity **15 → 16** with Damage +10% (`computeActionProfile`).
- Max HP: base 97, ×1.10 and ×1.05 → 143 (compounding would be 144).
- `node modules/fabula-ultima-companion/scripts/shared/stat-rules.test.mjs` passes.

## Notes

- The old AdvanceDamage macro (pre-Director pipeline) is NOT updated.
- Monsters never had `damage_receiving_percentage_*` fields; the migration adds them, so a
  damage-reduction % effect on an enemy now actually works.
