---
id: 2026-11-28-barrage-no-other-target
title: Fix — Barrage "No other target" check counted allies, so the pill stuck pending vs a lone boss
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/state-handlers, battle-director/action-card, battle-director/skill-effects, battle-director/skill-targeting
introduced_in: 7ac05eb0
fixed_in: v1.0.694
---

A bug fix in your files. Have a look, and close it (`status: verified`) if it reads right.

## The bug

The "No other target" pre-check on the Barrage (`_addTarget`) pill counted spare targets
from `director.ctx.eligibleTargets`, which is the attack's whole pick pool. Zarg's bow is
"Up to two creatures", so that pool holds his allies too. Barrage's own pick row
(`barrage_pick`) is `category: "enemy"`.

Against a lone boss, the check found "spare" allies and left the pill live. Apply then
found no enemy (`barrage_add returned ok=false (no-candidates)`,
`add_target apply failed — pill stays pending`). Confirm stayed locked until the
player pressed Skip on the pill. In the snapshot runner this was about 5 failed
Barrage applies per Asura or Rakshasa fight, plus one stuck CONFIRM.

## The fix

1. `skill-targeting.js`: new export `tokenMatchesTargetCategory(token, category, { reactorToken })`,
   a thin wrapper over the existing `matchesCategory`, so allegiance overrides still apply.
2. `skill-effects.js`:
   - `effectRefAddTargetCategories(effectTable, ref)` walks the chain (as
     `effectRefUsesAddTarget` does) and collects the `category` of each add_target's
     targeting row.
   - Candidates now carry it as `addTargetCategories` (at all 3 sites that set
     `usesAddTarget`).
   - New export `spareAddTargets({ eligible, alreadyTokenUuids, categories, attackerTokenUuid })`
     filters the pool down to that side. With no category, or no attacker token, it
     behaves exactly as before.
3. Both checks use it: the CONFIRM offer (`state-handlers.js`, creature_performs_action
   scan) and the card re-gate (`action-card.js`, `computeStaleReactions`, reason 2).

## Checked

- Runner, 6 fights: vs Asura and Rakshasa the pill now shows "unavailable (No other
  target)", with 0 failed applies. Vs Deva with Missile Fists out, Barrage still fires.
- `gm-card-override` 187 passed, `card-reaction-order` 7 passed, `massive-keyword` 20 passed.

Unchanged: Potion Rain, Follow my lead and Rondo of Nightmare spreads (the side filter is
Attack-only, and Massive candidates carry no categories).
