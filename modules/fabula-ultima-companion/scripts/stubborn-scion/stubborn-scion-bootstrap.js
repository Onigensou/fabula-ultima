// scripts/stubborn-scion/stubborn-scion-bootstrap.js
//
// Wires Stubborn Scion's camp question into the running client: the primary
// GM's socket + rest hook, the camp button, and FUCompanion.api.stubbornScion.
// Loaded by a dynamic import from director-boot's ready hook (no module.json
// esmodules entry needed). The button loads separately so a UI failure can't
// take the GM side down with it.

import {
  installStubbornScion, requestScion, executeScionOp, resetAtRest, readFatigue, askBlocker, scionCampOpen,
} from "./stubborn-scion.js";

const TAG = "[StubbornScion]";

export async function initStubbornScion() {
  installStubbornScion();
  const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
  const api = (root.api = root.api ?? {});
  api.stubbornScion = {
    request: requestScion,
    fatigue: readFatigue,
    blocker: askBlocker,
    campOpen: scionCampOpen,
    // GM / test surface — what the button and the rest hook run.
    execute: executeScionOp, resetAtRest,
  };
  try {
    const UI = await import("./scion-camp-button.js");
    UI.initScionCampButton();
  } catch (e) { console.warn(TAG, "camp button failed to load (the GM side still works)", e); }
  console.debug(TAG, "ready.");
}
