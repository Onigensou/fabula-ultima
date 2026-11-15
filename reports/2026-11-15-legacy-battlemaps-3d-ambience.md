# Legacy battlemaps: v2 canvas + 3D stage + scenery ambience (v1.0.613)

Heads-up, not a bug. The 14 old 1682×788 battle arenas are now v2 (2560×1270 with painted bleed) and run the 3D stage, like Training Ground and the Valley maps. Fafnir Castle 001/002 (already v2) get depth maps and presets. 12 of them also get idle scenery effects. World data: the 14 scenes (scenes store) + their preflight goldens.

## Scenes (world)

| Scene | Backdrop now |
|---|---|
| Eisendrache_Battlemap001 (Arena) | Training Ground's `Eisendrache_Battlemap001_v2.webp` (same painting re-rendered). Its 2 torch lights were removed: that image crops the torches off. |
| Eisendrache_Battlemap002 (Highroad), _003 (Burning, art `_004`) | `Eisendrache_Battlemap002_v2.webp`, `Eisendrache_Battlemap004_v2.webp` |
| Hideout_Battlemap001–005 | `Hideout_Battlemap00N_v2.webp` |
| Ruhig_Battlemap001/002, Vastwind_Battlemap001/002, Wyrmwood_Battlemap001/002 | `<name>_v2.webp` |

All on Forge under `Campaign/The Legend of Dragonslayer/Image/Battlemap/`. The old PNGs are still there (nothing overwritten), so your world keeps working until you pull; we'll delete them later.

Each scene: size 2560×1270, `flags.fabula-ultima-companion.conflict = { version: 2, stage: {439, 241, 1682, 788} }`, `initial` nulled, the 4 old edge walls replaced by the stage-rect walls, lights/tiles shifted by (+439, +241). Done live with the same steps as the Training Ground retrofit. Preflight goldens re-blessed for all 14.

**Art:** each `_v2` is the ORIGINAL painting, unchanged on the stage, with ChatGPT-outpainted bleed around it (stage pixels identical apart from a narrow seam). Exceptions:
- Highroad and Hideout 003 (stepped hall) are raised 110 px and Hideout 002 (waterwheel) 120 px. The old art put the horizon / back ledge at the back-row feet (canvas y 458), so the top party slot stood on the wall.
- Hideout 002's waterwheel was cut flat by the old frame edge. It was completed with a ChatGPT edit.
- Hideout 003/005 had a heavy painted edge vignette, now relit at the stage rim.

## Code

- `battle-stage-3d-rules.js`: presets `*_v2` for the 13 backdrops + `FafnirCastle_Battlemap001/002`, all `stage3d: { relief: true }`. Horizons are floor fits of Depth Anything V2. We don't have `tools/battle-depth/encode.py`, so we used our own encoder. Given your Highroad horizon (175.3), it reproduced your shipped depth map at r 0.994, and strength came out at 0.178 exactly. Strengths follow the usual back-row-0.72 rule. The old `Eisendrache_Battlemap002` key stays, so a save that restores the old URL still resolves.
- `assets/battle-depth/`: 15 new depth maps.
- `battle-stage-ambient.js`: new generic `ambient.fx` list next to the Underground crystals (that path is unchanged). New file `battle-stage-ambient-fx.js` has 18 sprite kinds: gusts, torch/flame/bark glows, washes, embers, dust, leaves, mist, ground fog, smoke, puffs, ripples, cave drips (ported from map-ambience point drips), shafts, glints, butterflies, cloud shadows.
  - Back effects share the existing container over the backdrop. Front effects get a new container over the tokens (`SORT_LAYERS.TOKENS`, sort 1000000, like map-ambience).
  - Pinned through `paintedPoint`, like the crystals.
  - Textures are made once, no filters, at most 70 sprites a map (tested).
  - Highroad has no ambience on purpose (first battle of the game).
- `battle-stage-3d-rules.test.mjs`: 199 pass (new: depth file per preset, back row ≈0.72 per retrofit, fx kinds drawable, sprite budget).

Verified on the Staging World: all 14 converted, every scene resolves its preset in 3D mode, a real (resumed) battle on Vastwind_Battlemap001 ran the 3D camera with battlers on the stage and no void, and the ambient layer runs on every scene with effects.

## Heads-up

- **Your saves:** a slot stores `sceneBackgrounds` per scene. Loading an old slot puts the old 1682 PNG back on a 2560 scene, which shows it stretched. We patched ours. To patch yours, rewrite `data.sceneBackgrounds[<scene id>]` in each `fu-saves/slot-N.json` to the `_v2` URLs above.
- fxmaster particle density on the 2.8× larger canvas is unchanged and unchecked (same as Training Ground).
- Approved mockup (positions, budget): https://claude.ai/artifact/57hybzRqFThPkoyGW3ErZ1
