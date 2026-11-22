# move-engine Phase 3: the parity command (+ engine 1.2.0 fixes it found)

2026-11-22 · branch `feat/move-parity` · how-to: tools/move-engine/README.md "Parity check".

## What changed
- **`node tools/move-engine/bin/move-engine.js parity <family> [moves…]`** (new): builds the family's mockup page from the
  repo, plays the moves there, runs the game runtime's dry run with the game's result (exact event diff), plays them for
  real in the snapshot runner on the GPU (length, fps, frames over 40 ms, hit-cue timing, frames at the same moments) and
  writes one report (`out/parity/<family>/<time>/report.html`) with PASS / FAIL per move and side-by-side frames.
  Families describe themselves in `moves/<family>/family.json` + `page.js`; the Sonic Katar page parts moved there.
- **Engine 1.2.0** (found by the first parity run, on the Gunblade Transform):
  - the glint's glow was a canvas blur filter on the art every frame: a 100-130 ms frame hitch in 5 of 5 runs (bisected in
    real playback: glow off = no hitch). Now each glow colour is rendered once before playback; worst frame 63-86 ms;
  - the runtime's "blank" pose was not registered, so a self-painted actor was also drawn by the timeline (a double-bright
    token during the glint). Fixed.
  - forced Chain results on a page no longer use up the move's jitter stream (1.1.1).
- **Migration `2026-11-22-gunblade-move-engine-1-2`**: Gunblade scripts → engine 1.2.0, through the new shared
  `data-migrations/_move-engine-refresh.js` (a future engine bump = a 2-line migration). Hand-made scripts are left alone.

## Verified
- `parity sonic-katar`: all 5 moves PASS (dry run identical to the mockup; playback ran its planned length, cues within
  0-25 ms, no frame over 100 ms).
- Real-server first boot (sandbox copy of the real world, V12): `4 ran, 0 failed`; forced upgrade from the v1.0.654 (1.1.0)
  scripts → 1.2.0, second run a no-op, the stored transform script parses.

## Known
- The game's glint glow reads slightly softer than the mockup's CSS glow (tunable).
- This runner machine shows random 40-90 ms frames; parity fails only at 100 ms or more.
- Phase 4 (skill logic authored in the mockup) not started.
