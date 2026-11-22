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

## Parity check (Phase 3): is the game playing what the mockup shows?

```
node tools/move-engine/bin/move-engine.js parity sonic-katar [gb_sword gb_tf …] [--cpu] [--no-game] [--code <gitref>] [--out <dir>]
```

One command, about 2 minutes for 5 moves (GPU). It:
1. builds the family's mockup page from the repo (`moves/<family>/page.js`);
2. plays each move on it twice: a clean run (trace, wall-clock lag) and a run frozen at each moment for a frame;
3. runs the game runtime's dry run on the mockup's geometry with the GAME's result (`family.json` gameOutcome /
   gameStrikes) and diffs it event by event, exactly (time, sound, clip, volume, size, position, result);
4. plays the moves for real in the snapshot runner (`family.json` game: snapshot, scene, caster, target) on the GPU:
   ran vs planned length, fps, every frame over 40 ms with its move time, each hit cue's on-screen time vs plan, and the
   board + overlay at the same moments;
5. writes `out/parity/<family>/<time>/report.html` (+ report.json): PASS / FAIL per move with every reason, differences
   that are by design named, side-by-side frames, and which engine version built what the game SHIPS for each move.

PASS = every dry-run event matches the mockup, and in playback the move ran within 100 ms of plan, every hit cue within
50 ms, no frame over 100 ms, no errors. A new family needs `moves/<family>/family.json` + `page.js` (see sonic-katar).
Its first findings (engine 1.2.0): the transform glint's per-frame blur filter (100-130 ms hitch) and an unregistered blank
pose (token drawn twice). Runner frames of 40-90 ms appear at random on this machine; only 100+ fails.

## Tests

```
node test/assemble-sonic.js                     # the Sonic Katar test page (moves/sonic-katar/page.js) → out/
node test/mockup-clock.js --gpu --json out/clock.json   # beat clock: identical timelines run to run; drift
node test/game-dry.js gb_sword [--result hit:9 | --strikes hit,miss,…,perfect | --variant sword]   # dry run vs mockup / a game result
node test/picker-check.js --gpu                 # the page's result picker overrides a move's sliders
```

Results 2026-11-22 (Phase 1): all 5 Sonic Katar / Gunblade moves match the mockup event for event in the dry run; in the
game they ran their planned length (Sonic Blow 4880 / 4880 ms) at 49-58 fps, every hit cue within 0-34 ms, no leftovers.

## The pilot: Gunblade (2026-11-22)

`moves/sonic-katar/head.js` + `gunblade.js` are the Sonic Katar page's family head and its three approved Gunblade moves,
host-neutral. The page (test/assemble-sonic.js) and the game (build/pilot-gunblade.js → migration
`2026-11-22-gunblade-move-engine`) load the SAME two files.

- Host roles a move uses: `moveCaster()`, `moveTarget(i)`, `moveResult(t)` (the game's real Accuracy result: hit, crit, total,
  fumble; null on a page → the move's sliders), `moveStrikes()` (a Chain plan), `moveVariant()` (a play_animation `#variant`).
- One script per form weapon: `playOpts.byForm = ["gb_sword", "gb_gun"]` picks by the equipped weapon's active form.
- `playOpts.variantTune = { gun: { dir: 0 }, sword: { dir: 1 } }` tunes by the transform row's `#gun` / `#sword`.
- The damage gate in the game = the move's first hit number (where the mockup shows the number), else its markGate.
- BD passes the card's Accuracy `total` / `fumble` in `payload.outcomes` (director-animation outcomesFromDirector).

Checks: `test/game-dry.js gb_sword --result hit:9` (or `crit:12`, `miss:7`, `--variant sword` for gb_tf) shows what the move
picks for a game outcome; `tools/snapshot-runner/checks/gunblade-move-engine.js` runs real sim battles (migration result,
Sword / Firearm by form, odd / even / crit / fumble, both transform directions); side-by-sides:
`node test/mockup-shots.js --gpu` + `node test/game-play.js --shots` (runner) + `node test/side-by-side.js`.

## Results (Phase 2, engine 1.1.0)

`shared/results.js` gives every move ONE shape for what happened, whoever decided it:

```
RESULT = { kind, hit, crit, fumble, total, amount, element, affinity, perfect, a, b }   (+ tot / fum aliases)
const r = moveCheck(target, () => pageSliderResult, bonus);    // one Accuracy Check
const list = moveChain(target, n, (n) => pageSliderResults);   // a Chain's strikes (+ the game's Perfect strike, perfect: true)
```

Order: (1) the game: BD's `payload.outcomes` (hit, crit, total, fumble, planned amount / element / affinity) or its Chain
plan (`payload.strikes`, per target); (2) a page's result picker (`mountResultPicker(el)`, `mockup/result-picker.js`:
Hit · odd, Hit · even, Critical, Miss, Fumble / All land, 3 of 4, Half, 1 of 4, None); (3) the move's own sliders. Each call
traces a `result` event, so the port check compares which result each side used. The dice rule (`rollCheck`, `accOdds`,
`CHECK_PRESETS`, `forcedChain`) lives here too.

"Planned" amount = what the action result holds when the animation starts: reactions folded in before it are included
(Gunblade's +10 Fire shows as 23 fire), anything RESOLVE still changes is not.

Checks: `node test/picker-check.js --gpu` (picker overrides sliders), `node test/game-dry.js sonicblow --strikes
hit,miss,…,perfect` (a BD-shaped Chain plan), the battle check (amount / element / affinity per outcome).
Sonic Blow + the plain attack now live in `moves/sonic-katar/sonic.js` (comparison; v1.0.652 ships Sonic Blow's hand port).

## Skill logic export (Phase 4)

A skill's RULES live next to its move, as plain data: `moves/<family>/skills.js` (`MOVE_SKILLS`, one block per game
document). A block names only logic fields: `props` (system.props keys), `effects` / `reactions` (the two row tables, replaced
whole), `flags` (module flags) and `aes` (embedded Active Effects by name: `changes` + `transfer`; other AEs are left alone).
`bind` ties a page slider to a field (`{ mp: { path: "props.cost", to: (v) => v + " MP" } }`), so the approved slider value
IS the skill's value. Rules-only families (no move, no family.json) work too: `moves/class-skills/skills.js`.

```
node bin/move-engine.js export <family> [skill…]                       # resolve: what each block + its sliders give
node bin/move-engine.js export <family> [skill…] --check --code <ref> [--snapshot <dir> --port <n>]
                                                                       # dry run in the snapshot runner: per copy, what differs
                                                                       # from the world (after its migrations) + the skill validator
node bin/move-engine.js export <family> [skill…] --write <key> --desc "<text>"   # data-migrations/<key>.js + manifest entry
```

One game-side helper does both the check and the write: `data-migrations/_move-engine-skill-seed.js` (every copy: the world
item by id + actor / unlinked-token copies by name). Workflow: round trip first (a block that mirrors today's item must show
"every logic field matches"), then change the block, `--check` shows exactly the intended diffs, `--write`, real-server boot.

Pilots: Sonic Blow + Gunblade (Passive) (round trip, `moves/sonic-katar/skills.js`); Blade Adept (forward, v1.0.656: the
new `weapon_category_alias` AE key, `scripts/battle-director/weapon-alias.js`).

**On the page** (`mockup/skill-panel.js`, part `skillPanel(family)`): a "Game item" card under the balance read shows each
block of the move on screen, its slider-bound fields following the sliders live, changes from the approved values marked,
and "Copy my changes" (block, slider, field, old → new) for the review. Under it, the game's own numbers: a **pack**
(`moves/<family>/packs/<block>.json`) measured in real Battle Director sim battles (`move-engine.js pack <family> <block> [--runs 3]`:
canvas off, batch pace, ~20 s a battle; `--full` = canvas on, read as drawn, ~7 min a battle), flagged when a slider that changes
the numbers moved since (a binding marked `numbers: false`, like the MP cost, never flags them).
Check: `node test/skill-panel-check.js`.

## Known limits (Phase 1)

- Scripts carry the whole shared library (~97 KB each); unused helpers are not stripped yet.
- Mid-tween state a move READS in the game is the dry run's estimate (exact at awaited points).
- The beat clock makes old approved pages a little quicker than they played: the old engine's timers drifted ~4.6 ms per
  wait (Sonic Blow: 3910 vs 3998 ms to its last beat). Pages built on this package play their authored numbers.
- Phases 2-4 shipped: results contract, parity command, skill logic export (sections above).
