# Valley boss arenas: four new battle backdrops (v1.0.637)

Asura, Rakshasa and Deva each get their own boss room, and the Sealed Cavern gets its own poison cavern instead of reusing the Underground art. All four run the 3D battle camera and have their own scenery effects. The Great Seal (`Valley_Battlemap003`, your seal circle for Nidhogg) is untouched.

## What you need to do
- Pull and restart the server (version bump). No migration: the scenes ship in the world data commit.
- Your save slots don't need patching. Slots don't store battle-map links, and none of them stores Valley_Battlemap004's background.

## The arenas
| Battle scene | Art (Forge `Battlemap/`) | Used by | Event |
|---|---|---|---|
| `Valley_Battlemap005` (new) | `Valley_Battlemap005.webp` | Abandoned Monastery Interior (`Valley_Map017`), Asura | Lightning Storm |
| `Valley_Battlemap006` (new) | `Valley_Battlemap006.webp` | Feeding Pit (`Valley_Map020`), Rakshasa | Lightning Storm |
| `Valley_Battlemap007` (new) | `Valley_Battlemap007.webp` | The Kneeling Colossus (`Valley_Map029`), Deva | Lightning Storm |
| `Valley_Battlemap004` (new art) | `Valley_Battlemap004.webp` | Sealed Cavern (`Valley_Map010`), Nox Legion | Soul Tithe (unchanged) |

- 005-007 are copies of `Valley_Battlemap001`, so they keep its stage walls, the Lightning Storm event (Asura is designed around its MP), the Lightning + Air wellsprings and the camera-lock flags. They drop 001's fxmaster clouds and its leftover per-session `world` flags.
- The three boss maps' `oniDungeon.battleMap` now point at their own arena instead of `Valley_Battlemap001`. Any battle started on those maps uses it.
- `Valley_Battlemap004` drops its `stageAmbientNoArcs` flag (it no longer borrows the Underground's crystal ambience).

## Code
- `battle-stage-3d-rules.js` PRESETS: `Valley_Battlemap004`-`007`, relief camera, horizons from the depth-model floor fit, strength by the back-row 0.72 rule. Depth maps in `assets/battle-depth/`.
- `battle-stage-ambient-fx.js`: nine new effect kinds (`beam`, `pulse`, `motes`, `haze`, `rain`, `splash`, `bubble`, `slime`, `flash`). `rain`, `splash`, `bubble`, `slime` and `flash` draw into the shared Graphics and take `n: 1`, with their own count key, so they cost no sprites.
- Tests: `battle-stage-3d-rules.test.mjs` 215/215 (the four arenas resolve with a relief camera, back row ~0.72, depth map present, ambience within budget).

## Also in the world commit (your v1.0.636 migrations, first GM boot here)
- Created: Nox Ghoul, Hound, Priest, Viper, Wraith, Executioner; the Sealed Cavern folder; the two Sealed Cavern tables. Valley_Map010 points at the new tables.
- Modified: the Debuff library gained Corroded (62 to 63 effects, none lost); Inferex, Inferex (Backup) and Bandit Zombie gained the Undead species effect. Two playlists only changed their shuffle seed.

## Checked
- A sandbox copy of the world ran one real fight per arena (Asura, Rakshasa, Deva, 2 Nox Ghouls + Nox Priest): 3D camera on, the right event, effects on (51 / 40 / 11 / 37 sprites), every battler on the floor.
- In the real world after the build: each arena starts the 3D camera and its effects.
- Preflight: 0 FAIL; only the changed scenes were re-blessed.

## Owed
- A real-table look at each boss fight on its new arena.
