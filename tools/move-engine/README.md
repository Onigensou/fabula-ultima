# move-engine

One move file runs in the **mockup page** you review AND in **the game**. No hand port, no re-timing.

Before this (up to Sonic Katar, 2026-11-21) every approved mockup was re-typed into a game "kit" by hand: the mockup said
"wait 115 ms, then strike", the game needed fixed ms, so a port meant measuring the mockup, pasting numbers and re-typing
the drawing code. That is where ports got slow and where they drifted (Renzokuken 650 ms in game vs 460 ms approved).

## How it works

```
shared/core.js       easing, maths, seeded move jitter (rnd/pick), the trace          ┐ loaded VERBATIM
shared/fx-core.js    glow, ember, dust, shards, homing, speedLines, FLINCH …          │ by both hosts
shared/common.js     moveActor, lean, squash, afterimage, fly, ring, twinkles …       │ (the old part-common.js)
shared/fx-melee.js   slashSheet, sparks, impactRays, bloom, stepIn, backHome, muzzle … ┘ (the old part-fx.js)
mockup/engine.js     the MOCKUP host: DOM / canvas stage, 3D parallax, cameras         (the old part-engine.nx.js)
game/runtime.js      the GAME host: same commands, on oni.timeline's live board
game/overrides.js    game versions of the few DOM-bound shared helpers (afterimage, chroma, camera)
```

**The beat clock.** In both hosts `wait()` and `tween()` run on the move's *virtual* ms. In the mockup they are anchored to
the run's start, so a late timer never pushes later beats back. In the game the move first runs as a *dry run* on a pure
virtual clock (while the animation loads, ~30 ms), recording every command at its ms; then `oni.timeline` plays that
recording on the live board. Same code + same clock = the same ms in both.

**Mockup space.** Moves work in mockup px on the 1682 x 788 stage. The game maps them onto the battle stage
(`KP = stage width / 1682`). An actor's `s` (depth size) is the board's own perspective factor, like the mockup's
`tokenScaleAt`.

**What the game draws itself** (the mockup only imitates it): the namecard (action card), damage numbers / MISS / flinch /
HP bar (they ride `oni.hit()` cues and BD's damage gate: a move's `gameNum()` becomes a cue), the crit cut-in (BD plays it
before the animation; a move's `critCutin()` is a no-op in the game).

## Making a mockup page

```js
const ME = require("<repo>/tools/move-engine/build/mockup-parts.js");
const stage = ME.stageScript({ preset: ME.PRESETS.valley001, actors: { ...ME.PARTY_LINE, orc: { cx: 400, cy: 320, sc: 1.84, kind: "enemy" } } });
const js = [ME.engine(), ME.common(), partHud, familyHead, ME.fxMelee(), familyMoves, partUi].join("\n");
// head: ME.pageHead() + ME.css(["hud", "dn", "hpbar", "namecard"]); window.HPBAR_T = ME.hpbarTiming(); stage <script> before js
```

No more regex patches of a private engine copy: the stage comes from `window.STAGE_PRESET` / `window.ACTORS`.
`window.__MOVE_ENGINE.TRACE.list` holds the last run's trace (virtual `at`, wall-clock `real`).

## Building a move for the game

```js
const GB = require("<repo>/tools/move-engine/build/game-build.js");
const assets = GB.assetsFromMeta(meta, { only: allSourceText, sfxUrls: { /* ripped sounds: their Forge path */ } });
const r = GB.buildScript({ key: "gb_sword", name: "Gunblade · Sword", files: [familyHead, movesFile], assets, cfg: { tune: approvedSliders } });
// r.ok / r.errors / r.warnings · r.encoded → the item's animation_script
```

- The inner script rides as an escaped string: the stored field never holds a backtick or a dollar-brace, so moves may use
  template literals freely (the old "exactly 2 backticks" rule is for String.raw scripts only).
- `params.outcomes` (hit / crit per target) and `params.strikes` (a Chain plan) reach the move.
- `node bin/move-engine.js check <files>` says whether move files can run in the game.
- `node bin/move-engine.js commands [--md]` lists every command and which host has it.

## Rules for move files

1. Only call engine / shared commands. DOM-only helpers (`sprite`, `silhouette`, `swapArt`, `groundPortal`, `impactFrame`,
   `startDance`, `wingsOn`, `castFocus` …) are refused by the game build.
2. Pick actors through the host: `CASTER`, `TARGETS`, `TARGET` in the game (the family head maps its own names, e.g.
   `const WA = () => CASTER`). The pilot (Gunblade) moves this into the family head of the move files.
3. A tween's callback should only SET state. Effects spawned inside a tween callback (a `moveActor` with `trail`) are
   recorded once, at the tween's end, in the game.
4. Randomness: `rnd` / `pick` (seeded, same in both hosts). `Math.random` is fine for things that do not move a beat.
5. Ripped sounds need their Forge path in `sfxUrls` (a mockup's `sfxSrc` for them names the rip source).

## Tests

```
node test/assemble-sonic.js                     # the approved Sonic Katar page rebuilt on the package → out/
node test/mockup-clock.js --gpu --json out/clock.json   # beat clock: identical timelines run to run; drift; vs the approved page
node test/game-dry.js gb_sword                  # game runtime dry run vs the mockup trace (time, key, volume, scale, position)
node test/game-play.js                          # → out/eval-play.js; then, from Data/tools/fvtt-playwright:
FVTT_GPU=true node ../snapshot-runner/bin/run.mjs --snapshot snap-lionheart --port 30160 --canvas full \
  --eval <this>/out/eval-play.js --dump <this>/out/play.json   # real playback on Valley_Battlemap001 (3D)
```

Results 2026-11-22 (Phase 1): all 5 Sonic Katar / Gunblade moves match the mockup event for event in the dry run; in the
game they ran their planned length (Sonic Blow 4880 / 4880 ms) at 49-58 fps, every hit cue within 0-34 ms, no leftovers.

## Known limits (Phase 1)

- Scripts carry the whole shared library (~97 KB each); unused helpers are not stripped yet.
- Mid-tween state a move READS in the game is the dry run's estimate (exact at awaited points).
- The beat clock makes old approved pages a little quicker than they played: the old engine's timers drifted ~4.6 ms per
  wait (Sonic Blow: 3910 vs 3998 ms to its last beat). Pages built on this package play their authored numbers.
- Results contract (Phase 2), a one-command parity check with side-by-sides (Phase 3) and skill logic (Phase 4) come next.
