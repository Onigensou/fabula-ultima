---
id: 2026-07-28-botc-summon-max
title: Birth of the Cruel never spawns its minion — summon_max counts phantasms
status: open
severity: blocker
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-effects
introduced_in: 8b8d6f56
fixed_in:
---

# Birth of the Cruel never spawns its minion

Keren's Birth of the Cruel fires and its chain runs, but **no Minion ever joins the
fight**. Instead a junk actor `Inferex (Reanimated)` is silently left in the world:
`species: BEAST`, `npc_rank: elite`, `max_hp: 178` (should be ~89), `current_hp: 0`.
It is a verbatim corpse snapshot with none of `summon_overrides` applied.

Not a regression from the 2026-07-28 pull — that pull did not touch the summon
handler. As far as I can tell the feature has **never** worked end to end: searching
all history, no `(Reanimated)` actor exists in any commit before 2026-07-28, and
`7f93fb61` notes "No reanimated test creatures included."

## Root cause

`countOwnSummons()` — `skill-effects.js:8597` — counts phantasms toward a
*non-phantasm* summon's cap:

```js
if (asPhantasm) { if (f.isPhantasm) n++; continue; }
if (f.isSummon || f.isPhantasm) n++;   // <- counts phantasms for a plain summon
```

Keren reliably has a **Fox fire** phantasm on the field from Create Phantasm, and it
occupies BotC's single `summon_max: 1` slot. Captured live from the console:

```
[BD] skill-effects.summon: at summon_max=1 for "botc_summon" — skipping spawn of Inferex (Reanimated)
[BD] skill-effects.summon: summon limit reached (max 1).
[BD] skill-effects.chain: step "botc_summon" returned ok=false (summon_max); stopping chain
```

So `summon_overrides` is **not** broken — execution `break`s at `8684-8688`, before
the override write at `8691-8694` is ever reached.

## Why a junk actor is left behind

The clone `Actor.create` happens in the spawn-plan **build** phase (`8632-8669`), but
the cap check is in the **spawn** phase. By the time the cap blocks, the clone has
already been created and persisted.

## It compounds

Those orphans are tagged `isPersistentSummon`, so the skill's own gate
`OWN_PERSISTENT_SUMMON_COUNT == 0` then evaluates falsy on later deaths. Observed
live — by the second enemy death BotC no longer even attempted:

```
[BD] passive Birth of the Cruel: condition_formula="... && OWN_PERSISTENT_SUMMON_COUNT == 0
     && AE_CHARGES_GRAVE_POINTS >= 2" -> 0 (falsy)
```

Each failed attempt makes the next one less likely.

## Evidence

Instrumented run: console captured, `createActor` hooked to snapshot the clone at
birth and again 3s later, every `updateActor` on it logged.

- Clone at creation and at +3s: **byte-identical**, corpse values throughout.
- Only updates it ever received: `isShaken: false`, `isSlow: false` (routine status
  clearing). **Not one override write.**
- Zero exceptions captured, so this is not a throwing formula.

## Repro

1. Sim battle, party vs Inferex + Centuaros; Keren needs `clock_grave >= 2`.
2. Let Keren cast Create Phantasm (the sim does this on its own).
3. Kill Inferex.
4. Watch the console for the `summon_max` lines above; check `game.actors` for a new
   `(Reanimated)` actor with unmodified stats.

## Suggested fix — needs your design call

Excluding phantasms from a plain summon's cap (mirror the `asPhantasm` branch one
line above) fixes BotC. **But** `summon_max` counting *all* summons may be deliberate
for other skills — if so the right fix is a separate cap for clone summons rather
than changing shared behaviour. Your call.

Independently: moving the clone creation to *after* the cap check would stop blocked
attempts from leaving debris in the world.

## Notes

- 2026-07-28 (onigensou): Both orphan actors deleted from the live world
  (`09izWspo66G7mMIW`, `Q10cCMKJE6qcBgpt`). The first is recoverable from `3bff986e`.
- 2026-07-28 (onigensou): skill-regression `check` is 482/482 green against your
  golden, so nothing else moved.
