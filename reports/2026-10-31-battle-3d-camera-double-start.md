---
id: 2026-10-31-battle-3d-camera-double-start
title: Two quick Battle depth refreshes can start two 3D cameras, and battlers vanish
status: open
severity: minor
reporter: onigensou
assignee: sarunphat
component: battle-director/battle-stage-3d
introduced_in: a14e9390
fixed_in:
---

# Not fixed on our side, yours to decide

**Onigensou's note:** the 3D battle stage is yours, so this is filed instead of fixed.
Nothing in the camera's start or stop path was changed. Decide whether and how to act on it.

## Symptom

During a battle, every token mesh's position and scale grew without limit (position about
±1e125, scale about 1e115 after a few seconds). All battlers disappeared from the stage. Their
rings and name labels kept drawing, and the backdrop kept rendering.

## Likely cause (from reading the code plus one repro; no fix was tested)

`Stage3dCamera.stop()` returns early while `start()` is still awaiting:

    if (!this.running && !this.renderer) return;

So if `refresh()` runs twice in quick succession:

1. The first `startCamera3d` is still inside `await loadThree()` / `loadDepthField()`.
2. The second `refresh()` calls `stopCamera3d()`, which clears `state.camera3d` and calls
   `stop()`. That returns early, because nothing is set yet.
3. The first `start()` carries on, adds its renderer listeners and sets `running = true`, with
   nothing left holding a reference to it.

Two live cameras now both scale and move each token mesh in prerender. Their saved values no
longer unwind correctly, so the transforms compound every frame.

## Repro

In a battle on a backdrop with a `stage3d` model, Battle depth not already on 3D:

    await game.settings.set("fabula-ultima-companion", "battleStage3d", "camera");
    Hooks.callAll("fuClientOptionChanged", { key: "battleStage3d" });

The BD log shows `3D camera on` twice. A single `settings.set`, with no manual hook, did not
reproduce it, and neither did a page load with the setting already on 3D. So normal play
probably needs a second refresh landing during the load, for example a very fast double change
of the setting or an `updateScene` background change during the load. I did not reproduce it
through the menu.

## Suggested fix

Make a stop during start stick. For example, set a `stopped` flag in `stop()` before the early
return, and have `start()` check it after each await and bail out before adding listeners.
`stopCamera3d()` already drops its reference, so nothing else has to change.
