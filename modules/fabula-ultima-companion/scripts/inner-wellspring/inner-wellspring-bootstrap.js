// scripts/inner-wellspring/inner-wellspring-bootstrap.js
//
// Wires Inner Wellspring (Invoker heroic) into the running client: the primary
// GM's socket + rest hook, the camp button, the first-pick window, and
// FUCompanion.api.innerWellspring. Loaded by a dynamic import from
// director-boot's ready hook (no module.json esmodules entry needed).

// The mechanics (socket, rest hook, reconciler) load on their own: the window
// and its pixel effects come in through a SEPARATE dynamic import, so a VFX
// failure can never take the rest-time effect down with it.
import { installInnerWellspring, requestIw, iwState, applyAtRest, applyIwEffect, buildIwEffect, reconcileIw, IW_ELEMENTS } from "./inner-wellspring.js";

const TAG = "[InnerWellspring]";

export async function initInnerWellspring() {
  installInnerWellspring();
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  let UI = null;
  api.innerWellspring = {
    open: (holder, opts) => UI?.WellspringWindow.open(holder, opts) ?? null,
    // Emergency exit for a stuck first-pick window (the UI itself refuses).
    close: () => UI?.WellspringWindow._cur?.close(),
    request: requestIw,
    state: iwState,
    elements: IW_ELEMENTS,
    // GM / test surface — what the rest hook, the first pick and a save load run.
    applyAtRest, applyEffect: applyIwEffect, buildEffect: buildIwEffect, reconcile: reconcileIw,
  };
  try {
    UI = await import("./wellspring-window.js");
    UI.initWellspringUI();
  } catch (e) { console.warn(TAG, "picker UI failed to load (the rest-time effect still works)", e); }
  console.debug(TAG, "ready.");
}
