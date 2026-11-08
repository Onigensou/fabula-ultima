---
id: 2026-11-09-pixelfx-lunar-bow-handoff
title: Hand-off — v1.0.572 adds oni.pxfx (layered pixel VFX), map-ambience clips, and Hina's Lunar Bow attack animation
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: anim-studio (oni-helpers), map-system (map-ambience), world items (Lunar Bow)
introduced_in: 4d2dd803..da47bb91
fixed_in:
---

# v1.0.572: pixelfx clips in animations, and Lunar Bow's own attack animation

Written for sarunphat and the Claude session that runs the pull. Nothing to do beyond a normal pull and reload
(no new script files in `module.json`). This lists what changed in shared code so a merge doesn't undo it.

## 1. What players see

- **Hina's Lunar Bow** has its own attack animation. Moon-dust gathers at the bow, a moonlight arrow flies
  chest to chest, and a crescent moon blooms on the hit (damage lands on the flash, then a 70 ms hitstop).
  On a miss, the arrow streaks past the target and fades out.
  - Hina's live main hand is still Glowstick, so this only shows when she equips Lunar Bow.
- The effects are original pixel-art code written with the pixelfx method (github.com/patch-gg/pixelfx, MIT),
  not ripped assets. They live in the art library at `E:\…\Animation\pixelfx\src\fx\fu\` (lunar-arrow,
  lunar-impact) and as webm clips on Forge under `Animation/pixelfx/`.

## 2. Shared code that changed

- `scripts/anim-studio/oni-helpers.js`: new **`oni.pxfx(clip, { token, x, y, k, mirror, rate })`**. It plays a
  pixelfx export's three layers:
  - `<base>_back.webm` under the battlers (kept just below the first Token in `canvas.primary`);
  - `<base>_front.webm` over them;
  - `<base>_light.webm` over them with ADD blend.

  With `token`, it stands on the token's DRAWN feet (3D stage) and scales with depth. It is additive: nothing
  existing calls it, and `vfx` is unchanged.
- `scripts/map-system/map-ambience.js`: the scene flag `ambience.clips: [{ base, x, y, w, alpha }]` loops
  pixelfx decor clips on a walk map. It is skipped for reduced motion, and the videos are released on teardown.
  No scene uses it yet (fireflies were tried on the Valley camp and not kept).

## 3. World data

- `Lunar Bow` (world item `6pUwTZO1peHgSBya` + Hina's copy): weapon props `animation_script`,
  `animation_damage_timing_options = default`, `animation_preload_urls` (the 6 clip URLs).
- Source of truth: `tools/anim-studio/hina-lunar-bow.js`. Re-apply offline with
  `node tools/safe-edit/bin/_build-lunar-bow-animation.js --write` (game closed).
- World-export report for the push: 2 modified, 0 removed.

## 4. Verified

- Staging World, rebuilt from this data. A real sim battle with Hina main-handing Lunar Bow played
  `anim-studio/hina-lunar-bow`. The damage gate fired 751 ms after the start when warm (2.9 s on the very first,
  cold download).
- Anim Studio preview of both the hit and the miss passed. Preflight: 0 FAIL.
