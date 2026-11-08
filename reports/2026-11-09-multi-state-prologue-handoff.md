---
id: 2026-11-09-multi-state-prologue-handoff
title: Hand-off — multi-state maps + Eisendrache prologue events (v1.0.571) touch the event system, dialog, teleporter, Story Gate and scenes
status: open
severity: info
reporter: onigensou
assignee: sarunphat
component: place-state (new), story-gate, event-system (flow, executeCore, showText, choices, gameState, logic, new rows-story), dialog-system (core, ui), teleporter-system (tp-api), dungeon-pathing-system (dp-scene-travel), camp-system (rest-api)
introduced_in: 95ad8db7..39071e26
fixed_in:
---

# Multi-state maps + the Eisendrache prologue: what changed in code you also work in

Written for sarunphat and the Claude session that runs the pull. One action is needed (restart Foundry, below);
the rest lists the shared files this work touched, so a merge or a later change doesn't undo it by accident.

## 0. Do this after pulling

- **Restart Foundry, don't just reload.** `module.json` has two new scripts (`scripts/place-state/place-state.js`,
  `scripts/event-system/event-rows-story.js`); the server only reads the manifest at start.
- **Your own save slots are not patched.** A save load deletes and recreates every tile and resets tokens on the
  scenes it snapshotted. Loading a slot that snapshotted *Eisendrache Kingdom* or the *Castle Garden* from before
  this push removes the new event tiles, the Royal Messenger and the event data there. Either don't load those
  slots, or ask for the same patch (it is scripted: add the new tiles / token, copy the event and Story Gate
  flags, set the story switches).

## 1. What players see now

- **Ruhig Village / Ruhig Village Ruin are one place.** With the switch `Ruhig Destroyed` ON, every door, the
  Travel dialog, Camp Set Out and the Inn land on the Ruin (same spot); the old village is never listed. The Ruin
  is named "Ruhig Village" in Travel.
- **Eisendrache stays one scene** and changes with `Eisendrache Destroyed`: map art (Map001 / Map_018), BGM
  (Eisendrache_City / Heaven Distress, town and its 8 interiors), festival stalls and festival-only NPCs.
- **The prologue is automated** with Event System events: Clumsy Kid at the bridge, the Opening Ceremony, festival
  and survivor talk for every townsfolk, 4 game stalls (Hilde joins at archery), Bruce → party name → Eisenfaust
  Tournament → attack → siege → Fafnir (story loss) → inn, the Royal Messenger, the castle gate (replaces the
  old Monk's push-back script on the same tile) and the audience with King Seigfried.

## 2. Shared code that changed

| Where | What | Why |
|---|---|---|
| `place-state/place-state.js` (new) | Scene flags `place` (id / activeWhen / stage), `storyBgm`, `storyBg`; primary GM reconciles playlist and background from switches; Scene Config "Story State / Story BGM / Story Background" fields (registered at `ready`, after the Fabula tab) | multi-state maps |
| `story-gate/story-gate.js` | Tokens: `storyGate.shownWhen` / `hiddenWhen`, reconciled like tiles and walls; Token Config fields | NPCs per story state |
| `teleporter-system/tp-api.js` | `resolveDestination` and `executeCrossSceneTeleport` redirect a scene in a Place to its current state | doors, Camp, Inn |
| `dungeon-pathing-system/dp-scene-travel.js` | Travel lists only the current state; visited = any state visited | Travel dialog |
| `event-system/event-flow.js` | `Flow.travel(id)` / `Flow.arrive(id)`: an event can survive its GM's canvas teardown on purpose and is re-announced on the new scene | Start Battle, Change Scene |
| `event-system/event-executeCore.js` | `Core.reannounce`, runtime contexts kept per event so the party token is refreshed after a scene change | same |
| `event-system/event-rows-story.js` (new) | Start Battle, Change Scene, Move Token, Name Input, Recover All, Loop, Break Loop | prologue |
| `event-system/event-gameState.js`, `event-logic.js` + 4 callers | Text variables (`getVariableText` / `setVariableText`); `{var:X}` prints text as written | party name |
| `event-system/event-rows-choices.js` | Max answers 4 → 6 (test updated) | King's question menu |
| `event-system/event-showText-execute.js`, `dialog-system/dialog-core.js`, `dialog-ui.js` | A speaker with no token on the scene gets a parchment bubble at the bottom of the screen (`FU.Dialog.show({screen:true})`); before, it fell back to a Foundry popup that event presses never closed, so the event hung | theatre scenes |
| `camp-system/rest-api.js` | `CampSystem.RestAPI.recoverParty()`: full HP/MP + ailments cured, no curtain / jingle | story losses |

Start Battle waits on the Director's `fu.battleEnd` (meta `source: "event-start-battle"`), the same hook the dungeon
fixed battles use.

## 3. World data in this push

`scenes` + `actors` stores and the authored export (WAL replayed, manifests verified, shipped stores opened from
`git archive`). Bruce's prototype token now uses his kung-fu sprite (`Bruce V_Standard.png`) for the tournament
fight; the placed gate token keeps the armor. The EXFURSION party's switches are set past the prologue.
Preflight: the 156 blessed scenes were re-blessed (Valley drift from the 11-07 session was already on origin).

## 4. Not verified yet

Real session; player clients (screen bubble, Name Input typed by the main controller, lock across scene changes);
stall checks with real rolls; battles were ended with the GM end-battle tool in the sandbox, not played out.
