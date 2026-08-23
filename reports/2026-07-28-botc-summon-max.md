---
id: 2026-07-28-botc-summon-max
title: Birth of the Cruel never spawns its minion — summon_max counts phantasms
status: fixed
severity: blocker
reporter: onigensou
assignee: sarunphat
component: battle-director/skill-effects
introduced_in: 8b8d6f56
fixed_in: 68c8542c
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

## Notes

**2026-08-23 — fixed in `68c8542c`.** Your root cause was exactly right, and the
diagnosis held all the way down: `countOwnSummons` counted own summons
"generally" for a non-phantasm row, so the Fox fire filled BotC's single slot and
the loop broke before the `summon_overrides` write.

One correction to the scope: it is not only phantasms. Every spawned token
carries `isSummon`, and a phantasm *or a Numen* carries its identity flag on top
of that — so Keren's Numen occupied the same slot by the same mechanism. The cap
is now kind-scoped in all three directions (phantasm rows count own phantasms,
Numen rows own Numen, a plain row counts own summons that are neither).

Deliberately NOT changed: `ownSummonCount` in `skill-formulas.js`, which the old
comment claimed this mirrored. That one powers the authored identifier
`OWN_SUMMON_COUNT` and is meant to be a total including phantasms, with
`OWN_PHANTASM_COUNT` / `OWN_NUMEN_COUNT` as its narrowed siblings. A per-row cap
and a corpus-wide total are different questions, and merging them is what caused
this. Blast radius of the change is exactly BotC: across the whole authored
corpus the only capped rows are the phantasm rows (max 3, untouched branch) and
BotC's plain max 1.

**Your junk actor is a second, separate defect, now also closed.** The clone path
`Actor.create()`s the persisted `(Reanimated)` actor while BUILDING the spawn
plan; the cap check runs in the loop after it. So even a *legitimate* cap-out
orphaned a world actor — which is also one source of the leftovers in
`2026-07-31-reanimated-actors-shipped-as-content`. A full cap is now detected
before anything is created, and a cap that fills part-way through deletes the
surplus clones by the ids that call created (never by name — that would reap a
standing ally from an earlier battle).

Verified live on the Training Ground, each run deleting every id it created
(post-run residue: 0 actors, 0 tokens):

| precondition | result |
|---|---|
| Keren has a PHANTASM out | `ok:true`, spawns `Test Target Enemy (Reanimated)` — was `reason:"summon_max"` |
| Keren has a PLAIN summon out | `reason:"summon_max"`, **0** new actors — cap holds, no orphan |
| overrides on a non-soldier source | `species` ELEMENTAL→UNDEAD, `npc_rank` set, `current_hp` 34 = `floor(69*0.5)` |

⚠ **One residual, pre-existing and separate — flagging rather than folding in.**
`max_hp` does NOT persist on the spawned clone (measured 69, override wanted 34)
even though `current_hp` from the same formula does. That is the known CSB
max-resource label staleness — `max_*` are computed label fields that persist
only on a sheet render — not the cap. Your original figures (`max_hp: 178`,
expected ~89) are consistent with that, so the minion may still read with the
corpse's max HP until its sheet is rendered. Worth its own report if it bites in
play; I did not want to claim it fixed under this one.
