# preflight — a pre-session checkup for the world

## What it's for

Every week the world is edited between sessions and exchanged with the co-dev.
World-import/export mistakes and rollbacks slip through manual testing and only
surface at the table:

- **Dungeon tiles that do nothing** — a tile was reconfigured but its saved
  state wasn't refreshed, so at runtime it's inert.
- **Actions with no automation** — an authored edit landed on the folder copy
  of a skill instead of the copy embedded in the actor.
- **Scenes that rolled back** — a pre-placed token or a linked map note quietly
  vanished during a world exchange.

`preflight` automates the manual "double-check everything" pass: it reads the
world **offline** (LevelDB on disk, game closed) and runs semantic validity
checks, printing a categorized report and exiting non-zero on hard failures.

It runs entirely **outside Foundry**, so no matter how many checks it grows, it
has **zero in-game performance cost**. It never writes to the world — the only
files it creates are the on-disk scene "golden" snapshots under
`preflight/expectations/` (deliberately NOT stored in the world; the world is
near the V8 payload ceiling).

`preflight` is the **"is it correct?"** companion to `world-export`'s **"what
changed?"** — see [WORLD-EXPORT.md](WORLD-EXPORT.md). Export is a git-diff
tripwire over authored docs; preflight is a semantic validator that also covers
scenes (which export excludes entirely).

## Usage

```
# the pre-session checkup (run the night before, game closed):
node tools/safe-edit/bin/preflight.js run

# emit an HTML dashboard you can glance at:
node tools/safe-edit/bin/preflight.js run --html [optional/path.html]

# list the automation drifts hidden by default (hunting one stale actor):
node tools/safe-edit/bin/preflight.js run --show-drift

# scene rollback protection — bless a scene once you've set it up correctly:
node tools/safe-edit/bin/preflight.js list-scenes        # ids + names
node tools/safe-edit/bin/preflight.js bless <sceneNameOrId>
```

`run` exits **1** if any check FAILs (gate a commit / CI), **3** if Foundry is
running (LevelDB LOCK — close the world first), **0** otherwise.

## Detection and fixing are SEPARATE

`run` **never writes to the world** — it only ever detects, plus writes the
on-disk golden files. Fixing is a different command (`fix`) you invoke on
purpose, and it **previews by default**. Nothing is ever detected-and-fixed in
one motion. The flow is always: **detect → you investigate → preview → you
decide → apply.**

```
# 1. detect
node tools/safe-edit/bin/preflight.js run

# 2. preview a fix (writes NOTHING; prints old→new per finding, saves a plan)
node tools/safe-edit/bin/preflight.js fix --suite tiles
node tools/safe-edit/bin/preflight.js fix --suite automation --only Guardian

# 3. apply (only this writes)
node tools/safe-edit/bin/preflight.js fix --suite tiles --apply
```

### Two fix mechanisms

| Suite | Mechanism | Game state | Reversal |
|-------|-----------|-----------|----------|
| **tiles** | offline `safeEdit` (scene flag) | **closed** for both preview and apply | backed up + journaled → `node bin/safe-edit.js rollback <entryId>` |
| **scenes**, **automation** | live world via the test-bridge | **closed** to preview, **open** to apply | make a git safety-commit first |

The tile fix is fully offline and reversible. The scenes/automation fixes touch
the live game, so they use a **two-step, plan-then-apply** flow to bridge the
game-state gap (planning needs the world on disk = game closed; the bridge needs
the game open):

1. `fix --suite scenes` (game **closed**) — previews and saves a plan to
   `preflight/fixplans/scenes.json`. Review it.
2. Commit a git safety-point, open Foundry with the bridge active.
3. `fix --suite scenes --apply` (game **open**) — executes the saved plan.

### Fix rules (what each fixer will and won't do)

- **tiles** — sets a tile's `initialType` to its inferred type; sets
  `currentType` to the inferred type **only if it's currently inert** (never
  overwrites a real type a tile was legitimately consumed into); creates a full
  state entry for a real-typed tile that has none.
- **scenes** — re-places a blessed token that rolled off, at its original
  position, from the golden's `tokensFull`. A scene blessed before this field
  existed reports "re-bless to enable restore". (Unlinked tokens restore base
  placement only.)
- **automation** — copies a source item's automation onto an actor action whose
  copy is **empty** (never overwrites existing wiring), and only on actors that
  are automated elsewhere. Run it `--only <actorId>` to go one actor at a time.

Safety flags: `--apply` refuses to run across all suites at once — you must pass
`--suite`. `--only <id|name>` scopes to a single scene/tile/actor.

## The suites

| Suite | Catches | Worst severity |
|-------|---------|----------------|
| **refs** | token → deleted actor, map note → deleted journal, doc → missing folder | FAIL |
| **scenes** | a *blessed* scene's pre-placed token / note rolled back, **or any config drift** — lighting, token vision, walls/lights removed, per-player ownership, scene mode, dungeon config, scene network, wellsprings | FAIL |
| **tiles** | dungeon tile that infers a real type but whose saved state is inert ("does nothing at runtime"); corrupt `currentType`; tiles with no state; stale orphan states | FAIL / WARN |
| **tables** | a RollTable result row (dungeon loot/encounter roulette) referencing an Item/Actor that no longer exists | FAIL |
| **automation** | an action's automation is EMPTY on the actor while its source item is wired up, on an actor that's otherwise automated (the "edit landed on the folder copy" regression) | WARN |

### Full-fidelity scene capture

`bless` captures the **entire** scene document — every setting in Configure
Scene (lighting/`environment`, token vision, fog, walls, ambient lights, scene
mode, Dungeon Configuration, Fast Travel, Scene Type tags, Invoker Wellsprings,
Scene Network, and per-player `ownership`/visibility). The scenes suite diffs all
of it, reporting a changed value as WARN and a removed embedded set (walls/lights
gone) as FAIL. A short, documented list of fields that legitimately churn every
session — consumed-tile state, visited/fog maps, which scene is `active` — is
captured but **excluded from the comparison** (see `preflight/scene-diff.js`
`VOLATILE_PATHS`) so the tool doesn't cry drift after every session. Token+tile
arrays are stripped from the config snapshot (guarded separately, and huge), so a
golden stays small (hundreds of KB even for a 39-token city scene).

### Severity philosophy

- **FAIL** = unambiguously broken; do not start the session. (Broken reference,
  corrupt tile type, a blessed pre-placed token that's missing.)
- **WARN** = a smell to review; not a hard block. (Reconfigured-but-inert tile,
  an automated actor with one empty action.)
- **INFO** = context / expected noise, collapsed to summary counts (orphan tile
  states, actions that merely differ from their base template).

The suites are deliberately calibrated to stay **high-signal** — expected noise
(a customised actor copy differing from its base template; orphan states for
deleted tiles) is summarised, not spammed, so a real FAIL never hides in a wall
of benign lines.

## The `bless` workflow (scene rollback protection)

Scenes aren't in `world-export`, so a rolled-back scene is invisible until you
run the session. To guard a scene:

1. Set the scene up correctly (place tokens, link notes).
2. `preflight bless <scene>` — captures the full scene config to
   `preflight/expectations/scenes/<id>.json`.
3. From then on `preflight run` FAILs if a blessed token/note goes missing and
   WARNs on any config drift.
4. Re-run `bless` after any *intentional* change to re-baseline it (a re-bless
   overwrites that scene's golden — it's a checkpoint).

A golden is **per scene**, but a dungeon is usually a *set* of scenes, so bless
them as a group (each still gets its own checkpoint):

```
preflight bless <id> <id> …                one or more scenes
preflight bless --match Wyrmwood_Map        every scene whose name contains this
preflight bless --folder "The Wyrmwood"     every scene in this scene folder (nested too)
preflight bless --all                       every scene — use sparingly
preflight list-scenes [--match <text>]      ids + folder + token/tile counts
```

Blessing is offline and cheap (goldens are small on-disk files — no gameplay or
payload cost), so blessing a whole dungeon folder is fine. Avoid `--all` /
blessing WIP scenes, though: a scene you're still editing will report drift every
run. Bless the *staged, stable* scenes. Commit the `expectations/` files so the
co-dev shares the same guards.

## Adding a check

Each suite is a module in `preflight/checks/` exporting
`{ id, title, run(world, opts) -> findings[] }`. Drop a file, list it in
`preflight/registry.js`. `world` is the in-memory model from `preflight/loader.js`
(`.actors`, `.items`, `.folders`, `.scenes`, `.journal`, `.byId`, `.has(c,id)`).
Build a finding with `util.finding(suite, SEVERITY.*, message, ref)`.

## Known limitation (and the v2 direction)

The **automation** suite is an *absolute* check: "is this action's copy empty
while the source is wired up?" It can't tell a never-automated action from one
whose automation was *reverted by an import* — both look empty. The precise tool
for "did **this import** revert something" is a **before/after guard**: snapshot
the critical set before an import, snapshot after, diff. That's the planned v2
`preflight guard --ref <import-commit>`. For now, the asymmetry heuristic
(automated actor + one empty action) surfaces the most likely regressions, and
`--show-drift` lets you audit a specific actor by hand.

The precise tool for "did **this import** revert something" is a **before/after
guard**: snapshot the critical set before an import, snapshot after, diff. That's
the planned `preflight guard --ref <import-commit>`. It would also let the
automation FIX target only the actions an import actually changed, instead of the
absolute empty-copy heuristic.

Also planned:
- **guard** — before/after import diff (the regression-precision tool above).
- extend `world-export` to give scenes a reviewable JSON companion + removal
  tripwire; optionally wire `preflight run` into the pre-commit hook.
- live smoke tests via the test-bridge (game open, on test day): actually spawn a
  token, fire one automated action, step a dungeon tile, assert runtime behaviour.
