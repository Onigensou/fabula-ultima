# Dullahan Armor scales with the HP-% gap + adjust_damage op "percent" (v1.0.689)

2026-11-27 · branch `feat/dullahan-pct` · user-approved after a balance-metric sweep (2026-11-26).

## The item

Dullahan Armor (Rare martial, DEF 13 / M.DEF 11, stolen from the Nox Executioner). The shipped
effect was a flat +5 damage dealt to, and 5 less damage taken from, creatures with a lower HP % than
the wearer. Now:

> gap = your HP % − the other creature's HP % (only while > 0)
> bonus = min(10, 5 + floor(gap / 10)): 5 % at any gap, +1 % per 10 points, max 10 % (gap 50+)
> Deal bonus % more damage to them; take bonus % less damage from them.

**Why these numbers.** Mindscape `check-item`, 500 runs per arm, on a new Sealed Cavern encounter set
(`tools/mindscape/specs/encounters/sealed-cavern-set.json`, the 12 Map010 rows) and the house roster.
Each arm is paired against the chassis alone.

| Sealed Cavern, default armor wearer (Rare budget 15 %) | Passive alone | Whole item |
|---|---|---|
| chassis only | – | 11.0 |
| shipped flat ±5 | 18.2 | 29.2 |
| ±10 → 15 % (first proposal) | 15.2 | 26.1 |
| **±5 → 10 % (shipped now)** | **8.5** | **19.5** (median 16.4) |

The shipped flat version read about 2× Rare where the armor drops. The approved ladder brings the
whole item to about 1.1–1.3× Rare. The L20 check doesn't apply (steal-only at L45+); L50 ≥ ½ budget
passes.

## Engine: adjust_damage op `percent`

A signed % carried by a reaction (+7 = 7 % more, −7 = 7 % less) that follows the 2026-11-26 % rules
instead of compounding:

- **outgoing**: added to the attacker's **Damage %** family for that one target. `buildPerTarget`
  re-derives that target's multiplier as `(atkDmgMult / _outPctMult) × (1 + (_outPct + pctExtra) / 100)`
  and shows it as its own breakdown line ("Dullahan Armor (Passive) +10%").
- **incoming**: added to the defender's **damage-reduction %** before the quiet curve
  (`resolveIncomingReduction({ extraPct })`), read from the target's damage-override ops.
- The reaction fold, the recompute's override re-apply and the final-stage soak prediction skip
  `percent`, because it is already counted. Every other path folds it as ×(1 + X/100) through the
  `applyAdjustOp` fallback. `DAMAGE_OPS` accepts it.

Migration **`2026-11-26-dullahan-pct`** (after `2026-11-26-nox-steals`) rewrites the passive rows and
the text on every copy: world item, actor and token copies, the Executioner's loot shell, and its
steal-catalog text.

## Tests

- Snapshot runner `checks/dullahan-pct.js` 7/7:
  - rows, text, shell and catalog;
  - the ladder 5 → 7 → 9 → 10 (cap);
  - outgoing +7 % at gap 25, +10 % at gap 60, nothing at gap 0;
  - **additive** with a sheet Damage +20 %: 207 → 269 = ×1.30, not 272 (×1.32);
  - incoming reduction joins the pool; 25 % sheet DR + 10 % → "Reduction (34%)" through the curve.
- Fingerprint A/B vs v1.0.688 on the bench: **502 / 502 identical**. skill-regression `parity` and
  `census` clean.
- **Real Foundry server** (private headless server, fresh Staging World, module from the branch;
  Imp as the attacker since the Staging World has no Nox):
  - the migration ran on a real GM boot;
  - ladder, outgoing and incoming-alone pass;
  - additive 209 → 271 (×1.30);
  - curve "Reduction (34%)".
  - The text/catalog check can't run there (no Nox Executioner in the Staging World); the runner
    covers it.

Notes:
- The % rules round reduced damage **up**, so a 10 % cut on a hit under 10 damage shows "0".
- Mindscape (`tools/mindscape`) gained function factors and `damage_taken_add`, and now models both
  Dullahan versions.

## After pull

GM boot runs `2026-11-26-dullahan-pct` once. Not yet seen: a real-table look.
