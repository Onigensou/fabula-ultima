---
id: 2026-11-01-skill-regression-world-state-drift
title: skill-regression reports 3 changed skills that come from world state, not from any skill or engine change
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: tools/skill-regression
introduced_in: 65306106
fixed_in:
---

# Not a game bug, but worth a look

Written for sarunphat, who owns this tool. Nothing here blocks play. The skills work; the check
reports them as changed because it fingerprints live character state and has no human to answer
prompts. Please decide whether the tool should change.

## Symptom

On v1.0.505 against `goldens/skills.json` (captured on 1.0.426), compute mode, 487 skills:

```
Summary: 3 changed, 4 new, 16 removed.
~ Esper / Life Transference          offensive: false -> true
~ Hina / Bind and Summon (variant)   ok: true -> false, reason: compute_refused:TARGET_BACK
~ Keren / Soul Steal                 ok: true -> false, reason: timeout
```

The 4 new and 16 removed are roster changes (`Hina (Backup)` left, Keren's Multi Shatter and Zarg's
traps arrived, and so on). Because of the removed entries, `check --update` would drop coverage, so
this golden has not been updated.

## Evidence that it is world data, not code

- Same three results with the scripts of 3f360b58 (10-29, when this check last showed 0 changed),
  a8af2444 (your tip), b37a02ee (our tip before the merge) and 934696d4 (main), all on today's world.
- Undoing the data change in a sandbox made each skill match the golden again, on the Unleash
  branch's scripts.

## Cause of each

| Skill | Cause | Commit |
|---|---|---|
| Hina / Bind and Summon | Saved merged with Avatar of Vengeance, so the Arcanum menu has only its disabled "Dismiss your Arcanum first" row and pre_activate refuses | 65306106, post-session state |
| Keren / Soul Steal | At the last clean check she was Wet, so Swift Swimmer's `override_dex` made DEX 12. The session state has no Wet, so DEX is 8, Psychokinesis offers its WLP swap on a DEX + WLP check, and `DieSwapPicker` waits for a player until the tool's 12 s timeout | 65306106, post-session state (the Wet removal itself was not traced further) |
| Esper / Life Transference | The blank Esper class copy was completed from Keren's copy, adding `type_damage: heal` and `defense_target_type: def`. `isOffensive` in `lib/collect.js` returns true for any `type_damage` or a `def` target | 4786051d, level-up work |

## Worth investigating

1. **Character state in the fingerprint.** Formula values are pinned, but merge state, statuses and
   resources are read live, so every post-session world commit can move the check with no skill
   touched. Should the bench reset them, or use fixture actors?
2. **Ask pickers in compute mode.** `rollCheck` skips the picker when `__FU_HARNESS_HEADLESS__` is
   set, and this run still spawned one. Should compute runs set it? Soul Steal is in `skipSimulate`,
   but that list doesn't cover compute mode.
3. **`isOffensive`.** A heal with a `def` target counts as offensive, so Life Transference is aimed at
   the enemy dummy. Should `type_damage: heal` be excluded?
4. **Golden age.** 1.0.426 with a roster that no longer matches. A re-baseline needs a matching roster
   first.
5. **Life Transference's data.** Is `defense_target_type: def` right on a heal? It came across with
   Keren's props and wasn't checked here.

## Not checked

Only these three skills were traced. The simulate and wide goldens were not run.
