# move-engine: one move file for the mockup AND the game (Phase 1 + Gunblade pilot)

2026-11-22 · branch `feat/move-engine` · tools/move-engine/README.md has the full how-to.

## Why
Approved animation mockups were re-typed into a game "kit" by hand: the mockup said "wait 115 ms, then strike", the game
needed fixed ms, so a port meant measuring the mockup, pasting numbers and re-typing the drawing code (12 kits, ~2,270
lines). Ports were slow and drifted from what was approved (Renzokuken shipped 650 ms vs 460 ms approved).

## What changed
- **tools/move-engine** (new): the Nox / Lionheart mockup engine as one package in the repo.
  - shared/: core (easing, seeded jitter, trace), fx-core, common, fx-melee, moves (def / T / TO) — loaded verbatim by both hosts.
  - mockup/engine.js: the mockup host, with a **beat clock** (wait / tween on the move's virtual ms: no timer drift).
  - game/runtime.js: the game host. A move's own beats run once on a virtual clock while the animation loads (~30 ms),
    every command recorded at its ms; oni.timeline then plays the recording on the LIVE board.
  - build/game-build.js: move files → animation_script (inner stored as an escaped string: no backtick / dollar-brace
    rules for move-engine scripts). build/mockup-parts.js: what a mockup page assembles from.
  - moves/sonic-katar/: the pilot family (head + the three Gunblade moves), the same files the Sonic Katar page runs.
- **BD (director-animation.js, shared)**: `payload.outcomes` rows now also carry `total` and `fumble` (the card's one
  Accuracy Check). Additive; nothing read them before. RELOAD-REQUIRED module.
- **Migration `2026-11-22-gunblade-move-engine`**: writes the Gunblade's attack script (plays Sword or Firearm by the
  weapon's active form; fires the blade on a hit with an odd total or a crit) and Gunblade: Transform's script (#gun /
  #sword). Only fields that are empty (v1.0.652 shipped them empty) or hold an older move-engine script are written.
- tools/snapshot-runner/checks/gunblade-move-engine.js (new check).

## Verified
- Dry run vs mockup: all 5 Sonic Katar / Gunblade moves match the page's trace event for event (time, sound, clip,
  volume, size, position).
- Real playback (runner, GPU, Valley_Battlemap001 3D): ran = planned length, 49-58 fps, hit cues within 0-34 ms, no leftovers.
- Real sim battles (runner, Blanche): migration wrote both scripts; Sword / Firearm by form; odd 9 and crit 12 fire,
  even physical, fumble misses; both transform directions.
- Real-server first boot (sandbox copy of the real world, V12): `2 ran, 0 failed` (sonic-gunblade then this one); BD
  decodes both stored scripts, they parse.
- Side-by-sides mockup vs game at the same ms: same choreography / effects. A video clip's first frame shows ~2-3 frames
  after its cue in the game.

## For you (co-dev)
- On pull: the migration runs on the GM boot. Nothing else to do.
- Nothing changes for existing animations; old scripts and kits are untouched (moved to move-engine only when worked on).
- New mockups: build from tools/move-engine/build/mockup-parts.js, write moves with the host roles (moveCaster,
  moveTarget, moveResult); `node tools/move-engine/bin/move-engine.js commands` lists what a move can call.

## Not done / known
- Scripts are ~84 KB each (the whole shared library rides along); no tree-shaking yet.
- Phase 2 (results contract beyond outcomes/strikes), Phase 3 (one-command parity check), Phase 4 (skill logic) not started.
- Real-table look with players owed.
