# Cutscene port: Camera Pan map point + tools/cutscene-port (v1.0.686)

2026-11-26 · branch `feat/cutscene-port` · built at the user's request (chat, 2026-11-26).

## Why

A story cutscene was designed twice:
1. A playable mockup was written in canvas code.
2. After approval, the same scene was rebuilt by hand as Event rows, for example `build-return-to-ruhig.js`.

The two copies drift apart, and the user approves the first while the second is what ships. Now the
mockup is written in the game's own event rows (`flags["oni-event-system"].eventRows`, same types and
field names as the Event editor). Porting it copies those rows; nothing is written a second time.

## What changed in the game

**`event-rows-camera.js`**: Camera Pan has a new target, **"A point on the map"** (mode `point`).
- **Coordinates.** `x` and `y` are in pixels of the map image (0, 0 is its top-left corner). The
  scene's padding is added at play time from `canvas.dimensions.sceneX/Y`.
- **Zoom and behaviour.** Zoom, duration, motion and wait work as for the other targets, and the GM's
  camera still never moves.
- **Editor.** The editor shows an X / Y field pair when this target is picked. The summary reads
  "Map point (x, y) at zoom z".
- **Existing events.** No existing event changes: the old modes are untouched.

**`event-lint.js`**: warns when a map point has no x / y, or lies outside the map.

## New tool: `tools/cutscene-port/`

Added to the `.gitignore` allowlist, like the other tools there.
- **`port-cutscene.mjs <rows.js> --lines <lines.json> [--profile p] [--out dir] [--draft] [--stage-tokens]`**
  - **Input.** Reads a cutscene mockup's rows file.
  - **Checks.** Every row type must be one the module registers. It refuses rows the mockup tags as
    still needing game work: a new row type, or new art. `--draft` leaves those out, for sandbox looks
    only.
  - **Output.**
    - `<id>.event.json`: the rows, with the mockup's `$` keys stripped.
    - `<id>.gm.js`: a GM script.
    - `<id>.spec.json`
- **`gm-write-event.js`**: the GM script template.
  - **Writes one tile.** It is tagged `flags["fabula-ultima-companion"].cutscenePort = <id>`, and
    re-running replaces its rows.
  - **Converts coordinates.** Image px become canvas px for Move Token and Jump To paths, and for
    Set Token Position points.
  - **Checks itself.** It checks that every type is registered, reads the rows back, lists missing
    token names and runs `runEventLint`.
- **`run-gm.mjs`**: evaluates a script in a GM page over CDP. Meant for a sandbox; the real world goes
  through the test bridge.
- **`parity.mjs install | read | diff`**: records the rows the game plays (it wraps
  `EventRegistry.executeRow`) and compares them with the mockup's timeline: the order, and the
  duration of timed rows.

The mockup side (review panel, rows player) lives outside the repo in the art folder:
`E:\…\Resource\Animation\cutscene-kit`.

## Tested

- **Unit tests.** All event-system tests pass:
  - `event-kit.test.mjs`
  - `event-rows-story.test.mjs`
  - `media-extras.test.mjs`
  - `picture-rows.test.mjs`
  - `tile-slice.test.mjs`
  - `token-jump-extras.test.mjs`
  - `check-text-banner.test.mjs`
- **Sandbox Foundry** (a world copy on :30001, this branch's module). The Fafnir Encounter mockup was
  ported in `--draft` mode:
  - **Write.** 94 rows on a new step-in tile on FafnirCastle_Map007, read back identical.
  - **Lint.** The lint found two real problems in the draft, both fixed in the mockup: the playlist
    track is "Draconic Battle" (with a space), and nothing set the gating switch.
  - **Play.** The event ran as GM to Start Battle with the step-in trigger, Pause for GM branches and
    Show Choices.
  - **Parity.** 98 of 98 recorded rows were in the mockup's order, and every timed row matched within
    tolerance.
- **Not tested:**
  - a player client watching the point pan, since the GM's camera is exempt;
  - a scene with padding (Map007 has none). The conversion is the same `sceneX/sceneY` offset that
    token centres use.

## Nothing in the world changes

No world data and no migration in this version. The Fafnir Encounter is not ported to the real world:
it is still in review, and the porting tool only writes when someone runs it.
