---
id: 2026-11-10-trap-tile-rework-handoff
title: Hand-off — Dungeon trap rework, applyDamage hpFloor/dryRun, FU.ResourcePanel
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: apply-damage-core, dungeon-pathing-system (tile effect engine, status HUD, new dp-trap-rules / dp-trap-fx), map-system/sprite-facing-runtime, new shared/resource-panel, world macro "Trap Damage"
introduced_in: 30b5003a..04c7ec0c (no version bump)
fixed_in:
---

# Dungeon trap rework: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. Nothing here needs action. It lists
the shared code this change touched, so a merge or a later change doesn't undo it by accident.

## 1. What it does

Trap tiles dealt a flat 5, which did nothing at Lv 45. Approved look and numbers:
claude.ai/artifact/EgW2YkyzCqX3PDokaiSLQY (mockup v2).

- **Damage:** 5 + floor(Party Level / 4) physical (16 at Lv 45). Party Level is the highest member
  level. It goes through the normal damage pipeline (flat DR all + physical, % DR, affinity), and a
  trap never takes a living PC below 1 HP. A tile can be set to **Heavy** (×1.5) in its effect config.
  The tile's "Amount" field is now ignored on Trap tiles.
- **On screen:** the tile's own SFX; the party token shows the shown character's `sprite_hurt` for
  about 1 s with a white hit flash; one face + −N per member floats over the token; each member's
  row in the dungeon status HUD pulses (red edge, HP drop with a draining red strip, a slide-out
  readout with −N, HP now / max, DR, Resist, Crisis, Held at 1).
- **Removed on traps:** the chat card and the screen flash.

## 2. Shared code touched

- **`apply-damage-core.js` `applyToActor`:** two new options, both off by default, so existing
  callers are unchanged.
  - `hpFloor` (default 0): HP damage never takes a living target below this.
  - `dryRun` (default false): runs the whole pipeline but writes and plays nothing; returns the
    same record with projected values.
- **`dp-tile-effect-engine.js`:** `run()` takes a 5th argument `ctx` (`{ typeKey }`), which the
  patched `TileEventRegistry.dispatch` now passes. Trap tiles (typeKey `trap` + a damage resource
  change) take a new path: the Primary GM previews every member with `dryRun`, broadcasts
  `DP_TRAP_FX` so every client shows the result at once, then writes HP one member at a time.
  Every other tile kind is unchanged. New `TileEffectEngine.runTrap()` serves macro-driven traps.
- **`dp-status-hud.js`:** rows carry `data-actor-id`; the HP bar keeps Crisis colours (yellow at
  half or below, red at a quarter or below); new `StatusHUD.pulse(rows)`. **The HUD now also
  redraws when a member's HP / MP / IP changes** (before, the bars stayed stale until an effect
  changed). The redraw waits while a pulse is playing.
- **`sprite-facing-runtime.js`:** new `FUCompanion.api.spriteFacing.flashPose(token, { field, ms })`
  for dungeon maps. The tick loop holds the pose before the standing art, then chooses the idle art
  again. `sprite_hurt` is preloaded with the other dungeon art.
- **New files:** `dp-trap-rules.js` (pure, 13 tests), `dp-trap-fx.js`,
  `shared/resource-panel.js` + `resource-panel-rules.js` (11 tests). All are registered in
  `module.json` esmodules.

## 3. New shared API: FU.ResourcePanel

This is a general tool for scenes with **no** resource HUD (events, story scenes, conflict events).
It shows one card per member (1–4) with −N / +N, a bar with a red drain or a green sweep, and tags.
It uses the FU.SystemMessage frame and position.

```js
FU.ResourcePanel.show({ label: "Healing Spring", rows: [{ actor, resource: "hp", before: 60, after: 110 }] });
FU.ResourcePanel.broadcast({ rows });   // GM side, every client
```

Traps use it only when the map has no dungeon HUD (an older macro trap tile on a walk map).

## 4. World data

There is one doc: macro `N2SMCCEYesd38dMR` "Trap Damage" (the macros store only). Its body now calls
`DungeonPathing.TileEffectEngine.runTrap` and keeps Hit_Piercing.wav. Six older tiles use it through
Monk's Active Tiles (Hideout_Map003, Vastwind_Field001). The 19 effect-config trap tiles (Valley /
Fafnir maps) are unchanged and keep their Attack2.ogg.

## 5. Verified

Verified in the Staging World (Valley_Map006): the GM click → confirm path, worn-HP states (Held at
1, Crisis), the macro path, the no-HUD fallback to the Resource Panel, and a **player-triggered**
trap (player → GM preview → broadcast, numbers and HUD on the player screen). No chat card was
created in any run. Not yet seen in a real session.
