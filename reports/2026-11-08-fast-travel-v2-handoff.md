---
id: 2026-11-08-fast-travel-v2-handoff
title: Hand-off — Fast Travel v2 (v1.0.569) touches the teleporter, dungeon links, fog, tile config and scene config
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: dungeon-pathing-system (dp-fast-travel, dp-scene-travel, dp-tile-config, dp-links, dp-fog), teleporter-system (tp-api, tp-bootstrap), custom-ui/dungeon-configuration-ui
introduced_in: 0ecd8def..cc16d406
fixed_in:
---

# Fast Travel v2: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists the shared
files this feature touched, so a merge or a later change doesn't undo it by accident.

## 1. Why

Session 2026-11-07: Fast Travel in the Valley Underground Area said "No visited landmarks" although the party had
visited 3 camps, the Ancient Mural and the Nether Bridge. Two causes:

- The tile presets (`tools/auto-link-dungeon-tiles.js`, `tools/apply-dungeon-tiles.js`, local-only) stamped
  `dungeonPathing.eligibleForFastTravel: false` on every tile they placed — 510 tiles world-wide. The code read
  that as a GM opt-out, so every camp of a preset-built dungeon was hidden.
- Door / teleporter tiles only counted on the world map.

## 2. What players see now

- **Fast Travel (eagle), same look as before.** Camps, Event, Story / Final Story tiles and every tile with a
  working teleporter count once visited. The tile the party stands on is left out. Landing on a door offers that
  door's own "Enter <place>?" prompt.
- **Travel button (town / mountain icon).** Two bookmark tabs:
  - **Dungeons**: every region (scene folder) with a dungeon map, its Dungeon maps first, then its Places. A dungeon
    map opens a full-screen map preview drawn like the board (paths, tiles, fog) where the party cycles the landing
    points like Fast Travel and lands exactly there.
  - **Towns**: towns, the World Map, and regions made only of places (Midgard, Eisendrache).
  - Towns, places and the World Map land on one fixed point, no choosing. World Map: the location node that leads
    into the area the party is in now.
- The gryphon pick-up / drop-off is sized from the party sprite as drawn, so it follows perspective depth.

## 3. Data rules (no new stored data except one scene flag)

- Per tile: `dungeonPathing.fastTravelMode` = `auto` | `always` | `never` (Tile Config select). The legacy
  `eligibleForFastTravel: true` still reads as Always; legacy `false` is **ignored** (it was preset noise).
- Per scene: `oniFabula.general.noTravelDestination` (Scene Config "Not a Travel Destination"). Ticked on Misty
  Field (`JwoxmfwqrdrjogW5`, world commit `99fc81d9`, scene re-blessed).
- Arriving through a door marks the landing tile visited (`visitedTiles`), like walking onto it. An unplayed Story /
  Final Story tile is skipped.
- Map lists are derived from existing data: `sceneVisited`, `visitedTiles`, teleporter destinations, scene folders.

## 4. Shared files touched

| File | Change |
|---|---|
| `teleporter-system/tp-api.js` | `teleportToken` calls `DungeonPathing.FastTravel.markArrival(sceneId, tileId, x, y)` before moving the token (marks the landing tile visited on dungeon maps). |
| `teleporter-system/tp-bootstrap.js` | New `TeleporterSystem.offerTeleport(tileDoc, tokenDoc)`: the same prompt + teleport a dungeon turn ending on the door runs, **without** firing `dungeonPathing.turnEnd` (no AE tick, no step counted). |
| `dungeon-pathing-system/dp-links.js` | New read-only `LinkLayer.playerLinks(scene)`: a player's view of any scene's paths (same `lookOf` rules), for drawing off the canvas. |
| `dungeon-pathing-system/dp-fog.js` | `DP.Fog` now also exposes `getFogMode` and `TEXTURES` (read-only). |
| `dungeon-pathing-system/dp-tile-config.js` | Fast Travel checkbox replaced by the Auto / Always / Never select; rules come from `DP.FastTravel`. |
| `custom-ui/dungeon-configuration-ui.js` | Scene Config General: "Not a Travel Destination" checkbox + prefill. |
| `dungeon-pathing-system/dp-fast-travel.js` | Landmark rules (`isLandmark`, `landmarkLabel`, `markArrival`, …), door offer after landing, gryphon sizing. |
| `dungeon-pathing-system/dp-scene-travel.js` | Region list, tabs, map preview (MirrorPrompt kind `dp.mapPreview`), fixed landing points, `executeTravelTo(scene, point)`. |

`getSceneType` no longer maps `sceneMode: exploration` to `"town"` (only an explicit `isTown` makes a town). Nothing
else in the module read it.

## 5. Not covered / open

- Tested in a sandbox copy with the GM standing in for the Main Controller. Not yet tested: a real player client as
  controller, and what watching clients see during a real session.
- "Multi-state maps" (Ruhig Village vs Ruhig Village Ruin as one place) are a known gap, deferred to their own task.
