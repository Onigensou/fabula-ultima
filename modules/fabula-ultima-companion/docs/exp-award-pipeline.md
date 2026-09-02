# EXP Award Pipeline

Every path that can hand out experience, and the single core they all call.

## Before

Four code paths wrote `system.props.experience`, each built against different
assumptions:

| Path | Status | Wrote |
|---|---|---|
| `battle-director/battle-end/battle-end-summary-logic.js` | live | exp, level, zenit, `segments` |
| Macro `[BattleEnd: SummaryLogic]` | legacy, live | same — an older copy of the module file |
| `exp-awarder/expAwarder-api.js` | live (GM sidebar only) | exp, level, **`skill_point`** |
| Macro `Victory Loadout` | orphaned | exp, `experience_ui` |
| Macros `OldVictory Loadout` (+ Boss) | dead | Foundry v9 `data.props` paths |

The amount came from the v1.2 formula, which also existed twice —
`battle-end-rewards.js` and the `BattleInit — Battle Record Writer` macro.

## After

```
  amount                    core                      effects
  ─────────────────────     ───────────────────       ─────────────────────
  battle-end-rewards.js  →  shared/exp-core.js   →    actor write
    computeExpAward()         gauge · overflow          exp · level · skill_point
  GM prompt override          segments                oni:expAwarded
  flat amount (sidebar)       skill-point mint          panel · badge · broadcast
                              actor write             segments → victory screen
```

`shared/exp-core.js` is the only place `experience`, `level` or `skill_point`
are written.

### Surface

```js
// pure
computeExpAward({ partyActors, enemyActors, isBoss, mult, floor, cap })
  → { expByActorId, detail }

computeExpAndLevel(beforeExp, beforeLevel, gained)
  → { beforeExp, afterExp, gained, beforeLevel, afterLevel, levelsGained, segments }

// effectful — the only writer
applyExpAward({ targets, amount | amountByActorId, source, playUi, mintSkillPoints })
  → { ok, runId, entries, errors }
```

ESM callers import. Classic (non-module) scripts read the mirror at
`globalThis["oni.ExpCore"]`, the same pattern `shared/code-backed-content.js`
uses. Every classic caller reaches for it at award time, long after boot, so
script/esmodule load order does not matter.

### Callers

| Caller | Call |
|---|---|
| `battle-end-summary-logic.js` | `applyExpAward({ amountByActorId, source: "Battle Victory", playUi: false })` |
| `expAwarder-api.js` | `applyExpAward({ targets, amount, source, playUi })` |
| `battle-end-rewards.js` | `computeExpAward({ partyActors, enemyActors, isBoss })` |

`playUi: false` on the battle path is deliberate: the victory summary screen is
already the presentation and animates from `segments`. Firing `oni:expAwarded`
too would stack a second EXP bar over it. The level-up badge still refreshes,
because it also listens to `updateActor`.

## What was reconciled

1. **The gauge.** Canonical is the Battle Director's: EXP runs **1 → 10**, so a
   level spans **nine** points and rolls over to 1. `expAwarder` used 0 → 10
   (ten-wide, rolling to 0). No data migration: a stored value below `EXP_START`
   is normalised up on the next award.

2. **The Skill Point.** A gained level mints one, spent later in the level-up
   window at camp or the title screen. This used to happen **only** in
   `expAwarder`, so every Battle Director level-up silently produced drift that
   a GM cleared by hand with `healPoints()`. Minting now lives in the core, so
   every path that can raise a level also mints. **This was a live bug.**

3. **Over-cap stored values.** BD reset a stored `exp >= LEVEL_UP_AT` to
   `EXP_START`, silently eating the pending level. `expAwarder` converted the
   overflow into levels. The latter is strictly better and is what
   `normaliseGauge()` does; it only fires on already-broken data.

4. **Negative awards.** `expAwarder` accepted them (clamping EXP, never reducing
   level); BD floored the gain at 0 and discarded them. The permissive behaviour
   won. Both battle paths pass non-negative amounts, so neither is affected.

5. **Segments.** The victory screen animates a per-level `segments` array that
   only BD produced; the award panel approximated multi-level gains from raw
   percentages. Every result now carries segments.

6. **The formula.** One implementation, in `computeExpAward()`. Rank
   multipliers, the global multiplier and the boss premium are still read from
   the Current Game DB actor, so balance stays a DB edit.

### The formula

```
c_ij  = B_rank[j] × clamp( 2^((E_j − L_i) / 10), 0.25, 5.0 )
R_i   = Σ_k W[k] × c_ij, contributions sorted descending
        W = [1.00, 0.70, 0.55, 0.45, 0.40], tail repeats
EXP_i = clamp( P_i × G × R_i × β × mult, floor, cap )
```

Rank multipliers: soldier 1.0, elite 1.5, champion 3.0. The boss premium (1.6)
applies when the battle is flagged boss **or** any champion is present.

`mult` and `floor` are the levers a non-combat source needs. A stealth takedown
passes `mult < 1` to pay less than the same enemies would in a fight, with its
own lower floor so the discount survives the clamp — applying the multiplier
*after* a floor of 1 would let the floor swallow it entirely on small hauls.
Both default to the values a normal fight uses, so existing callers pass
neither.

## Discontinued on purpose

- **`system.props.experience_ui`** is not written. Only the orphaned
  `Victory Loadout` macro ever maintained it, it has already drifted on live
  actors (one PC reads `experience 3.77` against `experience_ui 0`), and nothing
  in the module reads it. Writing it would revive a field no surface trusts.
- **`system.props.re_experience`** — a prestige counter from the `OldVictory`
  macros, which are dead v9 code. Untouched.
- **Macro `[BattleEnd: SummaryLogic]`** and **`BattleInit — Battle Record
  Writer`** keep their own copies and carry a DISCONTINUED banner. They only run
  for non-Director battles. A level-up through the legacy path still leaves
  drift; the level-up window's Heal button clears it.
- `Victory Loadout` and the two `OldVictory Loadout` macros exist only in the
  world database, not in the repo seed, so they carry no banner.

## Not done

**Retroactive Skill Point backfill.** Anyone who levelled in a Director battle
before this change is short a point. `expectedPoints()` derives the correct
total and the level-up window's Heal button fixes one actor at a time. A
one-shot migration reconciling every PC is mechanical, but it hands out points
retroactively, so it stays a deliberate decision rather than a refactor side
effect. Ask for it and it is a short migration script.
