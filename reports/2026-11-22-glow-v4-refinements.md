# Gunblade glint glow (engine 1.2.1), mockup v4, two refinements

2026-11-22 · branch `feat/glow-v4` · follows v1.0.657 (reports/2026-11-22-skill-calls.md).

## What changed
1. **Gunblade Transform glow matches the mockup** (engine 1.2.1). The mockup's CSS glow keeps full strength and SHRINKS
   (14 px → 0); 1.2.0 faded one 14 px glow out, which read softer. Now a few glow sizes are rendered once before playback and
   each frame draws the size of the moment behind the art. Still no per-frame blur (the 100 ms hitch 1.2.0 fixed stays fixed).
   Migration **`2026-11-22-gunblade-move-engine-1-2-1`** refreshes the two Gunblade scripts (shared `_move-engine-refresh.js`).
2. **Mockup v4 published** (same link, https://claude.ai/artifact/JMwhSYL9JFS3F8i9sAg1oQ; review kit + earlier reviews kept):
   result picker, the "Game item" card with Sonic Blow's measured game numbers, engine 1.2.1.
3. **Refinement: game numbers in about a minute.** `move-engine pack` now runs the battles with the canvas off at the sim's
   "batch" pace and reads each number where the Battle Director emits it (new hook `fuDamageNumberEmitted` in
   `emitDamageNumber`, one line, nothing listens in play). 3 Sonic Blow battles: **57 s** including the boot (was ~20 min).
   `--full` keeps the old way (numbers read as drawn).
4. **Refinement: the "numbers are from before your slider change" note** only appears for sliders that change the numbers.
   A binding can say `numbers: false`; Sonic Blow's MP cost does.

## Verified
- Side-by-side at the glint (parity frames, 250 ms): the game's halo is now tight around the outline like the mockup's,
  where 1.2.0's was a wider, fainter haze.
- Parity timing: 1.2.1 runs flagged frames of 101-146 ms, but so did 1.2.0 run the same way (110 ms): the real game was open
  on this machine and sharing the GPU. The slowest 1.2.1 frames were at the move's start (23 / 63 ms), before the glint; during
  the glint both versions sat at 70-110 ms. Not a regression; a clean-machine parity run can confirm when the game is closed.
- Dry run exact (18 events), result picker, `test/skill-panel-check.js` (incl. MP → not stale, penalty → stale),
  `test/pack-read.js`.
- Real-server first boot (copy of your live world, Node server + headless GM, since your game was open): **1 ran, 0 failed**:
  both Gunblade scripts 1.2.0 → 1.2.1, 0 page errors. Sandbox torn down; your game untouched.

## New Sonic Blow numbers (fast mode, Blanche vs Test Target Enemy)
45 (8/8 Perfect + 15, crit, Physical) · 42 (6/8, Bolt into weakness) · 23 (7/8, Bolt). Battle 3 reads Bolt vs NE: the dummy's
affinity line for that battle; Blanche's Inner Wellspring picks her element at battle start.
