# Geist: Shadowbringers animation (v1.0.620)

Geist's Shadowbringers now plays its new animation, which the user approved in the legacy-boss mockup (v25, locked settings). It finishes the legacy boss pass: v1.0.618 shipped the other moves, and this one was held back for extra tuning.

The world data changes too: **Geist's actor only**. That covers the Shadowbringers item's `animation_script`, timing and preload, plus his other 7 scripts, which were rebuilt with no change in behaviour.

## What it does

The move runs as a full camera takeover, like Apex Arrow, Night of Hundred Bandits and Rebellious Wing. It is a big move, so the camera is allowed to move.

1. **Darkness implodes:** pxfx_dark_implosion pulls into him while the camera pushes in.
2. **Violet burst:** pxfx_dark_plasma bursts with a flash.
3. **Beam into the sky:** pxfx_dark_column.
4. **Dark vortex:** the camera holds wide.
   - **Smoke dome:** a churning dome of black, crimson-lit pixel smoke boils up out of him and swallows the screen. It is a new pixelfx effect, `fu/dark-vortex`, on Forge as `Animation/pixelfx/pxfx_dark_vortex_front.webm` / `_light.webm`. It plays stretched 1.55× sideways over a plasma burst at his core.
   - **Dim:** a whole-screen dim covers the map and the party, but stays under the effects.
   - **Geist on top:** he is repainted above everything, brighter, with a pulsing crimson outline, and trembling with power.
   - **Wisps:** the defeat wisps (from `particles/wisps.js`), in black and red, swirl out of him as free particles over the whole view and fade at the screen edge. They ramp from 33/s to 180/s over 2.3 s, at 250% speed, 170% size, 1.8 s life, 45% black and 50% opacity.
   - **Streaks:** semi-transparent red lightning streaks, ramping up to 28/s.
   - **Shake:** a heavy shake, plus a hit on each of three red strikes.
   - **End:** the buff beat, then the damage gate at about 5.7 s. The shot ends at about 5.9 s.

Nothing in this move uses white: no twinkles and no white glints.

## Code

- `tools/anim-studio/lib/legacy-shots/geist-shadowbringers.inner.js`, plus the `LX.shadowbringers` entry in `legacy-geist-signatures.js` and in `legacy-boss-registry.js`.
- `geist-kit.inner.js` gains `cfg.live`, which defaults to true, so Geist's other moves stay on the live board.
- Wisp cost:
  - The halo and core come from pre-rendered stamps (3 size buckets), so no gradients are built per frame.
  - Trails are drawn as plain strokes.
- The `_light` layers use the luminance-to-alpha filter from v1.0.618, so there are no black boxes.

## Tests

Staging World, GPU window (rAF checked at about 60/s):
- **Shadowbringers:** 9 runs, 0 errors.
  - Warm runs hold 60 fps in the vortex. A first play in a fresh browser hitches once, about 130–150 ms, while assets load.
  - Peak of about 61 live wisps.
  - Every token comes back visible at alpha 1.
- **Regressions:** Torcleaver and Dark Bane show no regression and no black box.

## Heads-up

- **Beam beat:** the beam into the sky is mostly swallowed by the vortex, which starts about 0.9 s into the beam beat. This matches the approved mockup.
- **Camera:** it returns to the arena rest framing, as the other takeovers do, not to the GM's own view.
- **Not yet seen at a real table.**
