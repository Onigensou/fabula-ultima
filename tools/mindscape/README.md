# Mindscape — offline Monte Carlo combat model

A cheap statistical step **before** a live playtest, so live time is spent confirming a
fight rather than discovering it. Thousands of runs in under a second, game closed.

**The rules it implements are specified in
[`docs/mindscape-ruleset.md`](../../modules/fabula-ultima-companion/docs/mindscape-ruleset.md).**
That document is the thing to disagree with; this directory is just its implementation.

```bash
# the game must be CLOSED — Foundry holds an exclusive lock on the world DB
node bin/mindscape.js --enemies "Inferex,Centuaros" --runs 2000
node bin/mindscape.js --enemies Asura --runs 500 --seed asura-v3 --verbose
node test/rules.test.js
```

| flag | |
|---|---|
| `--enemies, -e` | comma-separated actor names (required) |
| `--runs, -n` | iterations (default 1000) |
| `--seed` | run label; same seed reproduces the run exactly |
| `--party` | override the Current Game party |
| `--expected` | round budget before "unresolved" (default 7) |
| `--force` | report even when coverage is below the bar |
| `--verbose, -v` | print every coverage warning |

## What it is for, and what it is not

It answers **"is the math right?"** — rounds, HP remaining, KO risk, action economy. It
does **not** answer "does it actually work?": absorb loops, unpayable skills, invisible
preconditions and forfeited grants are invisible here by construction. That is the live
playtest sim's job, and a clean Mindscape result is permission to spend *one* live run
instead of five, never permission to skip live.

## It refuses rather than guessing

This is the whole point. A previous log-only attempt failed by producing plausible numbers
over an incomplete picture, so every path that could approximate instead **stops**:

- an actor whose sheet lacks a stored `max_hp` is refused, not given a derived one
  (the formula undershoots by 17–60 HP on the live party)
- a formula it cannot evaluate offline (`OWN_SUMMON_COUNT`) makes its action unmodelled,
  rather than resolving to a number
- past **34%** of turn-spendable actions unmodelled, no verdict is emitted at all
- constants measured from a run where PCs died are suppressed, not published

`--force` overrides the coverage bar and says so loudly in the output.

## Status — calibrated against live, with a known bias

Measured head-to-head on **Inferex + Centuaros**, 2026-08-19
(`expectations/inferex-centuaros.json`):

| | rounds | party HP | outcome |
|---|---|---|---|
| live sim (n=3) | **2** (median) | **82%** | 3/3 victory |
| Mindscape (n=2000) | **3** | **53%** | 100% victory |

**Mindscape runs about one round long and ~25–30 points low on party HP.** The bias is
consistent and in the *safe* direction — it under-rates the party, so a fight it calls
hard is genuinely hard. Do not close the gap by inflating party output.

**How to read a verdict:** subtract a round, add ~25–30 points of party HP. "3 rounds at
53%" corresponds to a real fight of roughly 2 rounds at 80%.

Known causes of the remaining gap, none arithmetic: summons (live fields 1–2 Fox fire
phantasms that soak and deal damage), the reaction layer, Zero Power, and Fabula Point
invokes. All are in the spec's Not Modelled list.

### Conflict events are NOT modelled — and the live sim drops them too
Training Ground carries `conflictEvent: "lightning-storm"`, but `sim.run()` only arms an
event when you **pass one explicitly** — it never reads the scene's own flag. Every live
run above logged `conflict event: none`. Measured separately, the storm barely moves the
outcome (it damages both sides; 2 rounds, 73%/89%) but it did KO Zarg in one run.

If you are balancing a hazard scene, pass `conflictEvent` to `sim.run()` — otherwise the
hazard is silently absent on **both** sides of this comparison.

## Layout

```
bin/mindscape.js    CLI: load → validate → coverage gate → Monte Carlo → report
lib/load-actors.js  offline LevelDB read (reuses tools/safe-edit/lib/db.js)
lib/skills.js       item → action extraction, utility registry, coverage manifest
lib/formula.js      safe evaluator for sheet formulas; refuses runtime state
lib/rules.js        checks + the damage pipeline (spec Parts 1-2), pure
lib/engine.js       the combat loop
lib/rng.js          seeded RNG — same seed, same run
test/rules.test.js  30 tests, plain node
```

`node_modules` is resolved from `tools/safe-edit`; this directory must never carry one.

## Extending coverage

Damage actions extract automatically from the sheet. **Utility actions cannot** — what
they do is structural (grant an action, redirect a hit, strip an activation) and none of
it is on the sheet — so they are declared in `UTILITY_REGISTRY` in `lib/skills.js`. That
registry is an allowlist: anything not in it counts as a gap. Filling it in is the main
route to a calibrated model.

Party policy is transcribed from
[`sim/profiles.js`](../../modules/fabula-ultima-companion/scripts/battle-director/sim/profiles.js),
not reinvented — same TUNING constants, same rotations. When calibration drifts, check
that transcription first.
