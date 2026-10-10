---
id: 2026-10-10-commander-skill-guards
title: Commander's four skills (yours, from f6a14134) — five guards added after a harness pass
status: fixed
severity: major
reporter: sarunphat
assignee: sarunphat
component: world-data / Commander skills
introduced_in: f6a14134
fixed_in:
---

# What happened

We both automated Queen's Gambit, Charging Cavalry, Bishop's Edict and King's
Castle at the same time (mine was never pushed). On the merge **your versions
were kept**: library items `f7LAMimGFhqpUUWX`, `ckL5UZGRslPt1cZa`,
`cy0XWEqKnjvJ9B4c`, `j2zsAZo4RuolWM6b` plus the copies on the `Commander` class
actor `3KulR3t3i0HpcCid`. Your design is unchanged. I ran my old test scripts
against it and added only the guards mine had. Fixed in the commit that carries
this file.

**Please don't overwrite these on your next world push.** If your world still
has the pre-fix docs, pull first.

# The five defects (all reproduced in the harness before the fix)

| skill | symptom | fix |
|---|---|---|
| Bishop's Edict / Charging Cavalry / King's Castle | My **Crushing Chariot** offers on `SKILL_HAS_TAG_COMMAND == 1`; your three had no tag, so it never offered | `skill_tags: "command"` on all six docs |
| Charging Cavalry | The picker counts the caster as an ally (`includeSelfInAlly` defaults true), so the Commander could give **themselves** the free attack | `target_eligibility: "IS_SOURCE == 0"` |
| Queen's Gambit, Rally (`qg_pick`) | `skip_when_passive` defaults **true** and `qg_after` runs passively, so the pick took the **whole ally pool** (caster included) and healed everyone | `skip_when_passive: false`, `exclude_self: true`, `iteration_mode: together`, `target_prompt` |
| Queen's Gambit, Command (`qg_skill`) | Offered even when the Commander owns none of the three; it then grants a free Skill action that can pick nothing | `condition_formula: OWN_SKILL_TAG_COUNT_COMMAND >= 1`, `disable_ui_type: dim`, reason text |
| King's Castle Siege (library AE) | `*_mod_all -1` zeroes the base amount only; any flat bonus (e.g. Supply) still restored MP | added `heal_receiving_flat_all` / `mp_receiving_flat_all` = `-999` (the receiver clamps at 0) |

Also: **Tithe** (library AE) now reads `ACTION_COST_MP > 0 && ACTION_IS_FREE_CAST == 0`.
A free cast has no MP cost to double. This differs on purpose from the Cataclysm
ruling, which is about a skill's *own* surcharge.

# Evidence

The headless harness ran on Training Ground with Test Caster, Test Target Ally,
Test Target Enemy and Hina placed as ephemeral fixtures. Results: 21/21 pass.
The Rally test used two allies, because with a single ally the whole-pool bug
reads green. Charging Cavalry was checked through the real
`surveyActionTargets`, against a control with the gate blanked (the control
includes the caster). Bishop's Edict and King's Castle needed no change. Your
Zeal works, but only if the attack harness is told `acceptReactions: true`; by
default it skips the will-deal-damage pre-pass, so Zeal reads as dead.

Still unproven in a real battle (true of both versions): the real picker UI,
the ally actually taking the Charging Cavalry attack, and Rally with a live
player picker.

# Notes
