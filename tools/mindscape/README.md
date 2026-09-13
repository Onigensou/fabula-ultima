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

# a monster that does not exist yet -- measure the design before building it
node bin/mindscape.js --enemy-file specs/rakshasa.json --runs 500 --force

# find the value of a dial by measuring instead of arguing
node bin/sweep.js -f specs/rakshasa.json --dial mindscape_read_curve \
  --on "Adaptive Defense" --values "25,40,60,80|50,65,80,95" --runs 400

node test/rules.test.js && node test/reactions.test.js && node test/weapon-read.test.js && node test/equip.test.js && node test/loadout.test.js

# loadout round-trip gate: can the model rebuild every PC's real kit? (read-only)
node bin/verify-loadouts.js
```

## Measuring a design before it is built

`--enemy-file` takes a JSON spec — an actor document carrying the same
`system.props` keys a real CSB actor does, loaded through the **same**
`toCombatModel` as a world actor. That constraint is the point: a spec that could
describe a creature the world cannot hold would be measuring something that can
never exist. Runs print a loud `PAPER DESIGN` banner so a verdict about a
proposal can never be mistaken for one about a monster on the sheet.

Specs may also carry `mindscape_*` fields — modelling scaffolding that has no CSB
equivalent (stance cycles, reaction dials). They are namespaced so they can never
collide with a sheet column, and they let a balance sweep be a data edit rather
than a source edit. See `specs/rakshasa.json`.

> ⚠ **Solo bosses read very pessimistically.** The published calibration is a
> *two-enemy* fight, and the party's multi-target actions collapse to one target
> against a single monster — measured 164.6 DPR vs a pair, 95.2 vs solo Asura.
> Worse, Blanche contributes **zero** modelled damage (her Twin Shields is an
> AE-exposed virtual attack the loader does not model). Read a solo verdict
> through `expectations/asura-solo.json`, not the Inferex one.

| flag | |
|---|---|
| `--enemies, -e` | comma-separated actor names from the world |
| `--enemy-file, -f` | JSON spec for a monster not in the world yet (repeatable) |
| `--equip` | `"<PC>=<item.json>"` — swap that PC's main-hand weapon for a paper item, in memory (repeatable, one per PC) |
| `--runs, -n` | iterations (default 1000) |
| `--seed` | run label; same seed reproduces the run exactly |
| `--party` | override the Current Game party |
| `--expected` | round budget before "unresolved" (default 7) |
| `--force` | report even when coverage is below the bar |
| `--verbose, -v` | print every coverage warning |

## Measuring paper equipment

`--equip "<PC>[:<slot>]=<source>"` changes one slot of a party member's loadout, in
memory — the world loadout is never touched. Slots: `main` (default), `off`, `armor`,
`acc1`, `acc2`. A source is a paper spec (an item document — paste one out of
`_authored-export/items/` — plus optional `effects` and gear-skill sub-items) or
`item:<name>` / `item:#<id>` for a real world item, or `own:<name>` / `own:#<id>` for an
item the PC already carries (a refined weapon lives on the actor, not among the world
items). `--unequip "<PC>:<slot>"` empties a
slot. The sheet is re-derived (DEF, MDEF, HP, affinities, modifiers, attribute dice) and
set bonuses are reconciled — take off a Swift Swimmers piece and Wet goes with it. A PC
whose real kit does not rebuild (`node bin/verify-loadouts.js`) is refused. Ruleset
Parts 6d–6f.

```bash
node bin/mindscape.js -e "Inferex,Centuaros" --force \
  --equip "Zarg:armor=item:Brigadine" --unequip "Keren:acc1"
```

`--baseline-gear "all"` (or `"Hina,Zarg"`) swaps every slot to its same-class **basic**
item — the 0% loadout the equipment guide prices against. Run it beside the real loadout
on the same seed to see what the gear is worth, or add an `--equip` on top to measure one
item against basic gear:

```bash
node bin/mindscape.js -e "Inferex,Centuaros" --force --seed gear --baseline-gear all
node bin/mindscape.js -e "Inferex,Centuaros" --force --seed gear --baseline-gear all \
  --equip "Zarg=own:+5 Zarg's Bow"
```

A gear skill is modelled when its name is in `REACTION_REGISTRY`. For an A/B, run a
control arm with the same stats and no passive, on the same seed, and compare the PC's
row in `party output`:

```bash
for arm in chassis-whip explosion-whip; do
  node bin/mindscape.js -f specs/equipment/dummies-n3.json \
    --equip "Zarg=specs/equipment/$arm.json" --runs 1000 --seed whip-n3 --force
done
```

> ⚠ A rider on BASIC attacks is only measurable on a PC whose modelled kit is
> weapon-only (Zarg today): party policy swings the weapon only when no skill is
> affordable. See ruleset Part 6d.

## Blank-slate parties and neutral encounters

The Current Game party is one roster at one level. To balance for any party, build one by
the rulebook's character-creation rules and fight enemies built by its NPC rules (ruleset
Part 6g):

```bash
# a generic party at level 30, table power, vs four rulebook soldiers of level 30
node bin/mindscape.js --party-archetype standard --level 30 --neutral-encounter normal --force

# the rulebook floor (no class skills) against two elites
node bin/mindscape.js --party-archetype physical --level 20 --power raw --neutral-encounter elite-pair --force

node bin/calibrate-archetypes.js     # re-fit the table-power skill layer (k)
node bin/archetype-sweep.js --out expectations/archetype-sweep.json   # the baseline table

# equipment: price the reference ladder, then check full loadouts per rarity (spec Part 6i)
node bin/reference-set.js --out expectations/reference-set.json
node bin/reference-set.js --enemy-defense dice --out expectations/reference-set-dice.json
node bin/reference-loadout.js --out expectations/reference-loadout.json
```

Presets: `standard`, `double-caster`, `no-healer`, `physical`. `--equip` and
`--baseline-gear` work on archetypes exactly as on a loaded party.

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

### Conflict events — pass them explicitly, here and in the live sim
Training Ground carries `conflictEvent: "lightning-storm"`, but neither `sim.run()` nor
this tool reads the scene's own flag; both only arm an event when **passed one**. The
calibration runs above logged `conflict event: none`.

Mindscape models the Lightning Storm as of 2026-08-20 — use `--conflict-event
lightning-storm`. It is worth a lot on the Valley roster: on `Skizzik,Skizzik` it moves
the fight from 75% party HP to 60% and turns a 0% defeat rate into 13%, because those
monsters are *built* to be fed by it. If you are balancing a hazard scene and you omit
the flag, you are evaluating a different monster than the one on the sheet.

## Layout

```
bin/mindscape.js       CLI: load → validate → coverage gate → Monte Carlo → report
lib/load-actors.js     offline LevelDB read (reuses tools/safe-edit/lib/db.js)
lib/skills.js          item → action extraction, utility registry, coverage manifest
lib/formula.js         safe evaluator for sheet formulas; refuses runtime state
lib/rules.js           checks + the damage pipeline (spec Parts 1-2), pure
lib/reactions.js       reaction registry + gates (spec Part 6b), pure
lib/conflict-events.js layered scene rules — Lightning Storm (spec Part 6c)
lib/equip-file.js      --equip: paper main-hand weapons, in memory (spec Part 6d)
lib/loadout.js         rebuilds a PC's gear-dependent sheet numbers from scratch (spec Part 6e)
bin/verify-loadouts.js round-trip gate: every PC's real kit must reproduce (read-only)
lib/archetype-party.js blank-slate parties by the character-creation rules (spec Part 6g)
lib/neutral-encounter.js enemies by the rulebook NPC formula, no affinities (spec Part 6g)
bin/calibrate-archetypes.js fit the table-power skill layer k (read-only)
bin/archetype-sweep.js presets x levels x power x encounter baseline table
test/archetype.test.js rulebook goldens (Camilla, Soldier, Sage, Healer, Ranger), rules
test/neutral-encounter.test.js rulebook NPC numbers
test/loadout.test.js   effect evaluator, armor/Dodge/Wet rules, max_hp, the gate
lib/engine.js          the combat loop
lib/rng.js             seeded RNG — same seed, same run
test/rules.test.js     30 tests, plain node
test/reactions.test.js 22 tests, plain node
test/equip.test.js     --equip loading, array registry rows, attack-declaration riders
```

`node_modules` is resolved from `tools/safe-edit`; this directory must never carry one.

## Extending coverage

Damage actions extract automatically from the sheet. **Utility actions cannot** — what
they do is structural (grant an action, redirect a hit, strip an activation) and none of
it is on the sheet — so they are declared in `UTILITY_REGISTRY` in `lib/skills.js`. That
registry is an allowlist: anything not in it counts as a gap. Filling it in is the main
route to a calibrated model.

**Monster reactions work the same way**, in `REACTION_REGISTRY` in `lib/reactions.js`.
Each entry names one of three trigger points, a `gate(ctx)` predicate, and an effect
(`free_attack` / `stack_burst` / `burst` / `grant_mp`). Undeclared passives are listed
on their own line and are *not* folded into the turn-spendable coverage bar — a reaction
is not turn-spendable, so counting it there would change what that percentage means.
Adding a monster's reactions is usually the difference between a verdict that means
something and one that measures its HP bar.

Party policy is transcribed from
[`sim/profiles.js`](../../modules/fabula-ultima-companion/scripts/battle-director/sim/profiles.js),
not reinvented — same TUNING constants, same rotations. When calibration drifts, check
that transcription first.
