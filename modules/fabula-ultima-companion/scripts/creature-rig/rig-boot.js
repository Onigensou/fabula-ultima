// ============================================================================
// creature-rig/rig-boot.js — boot wiring for the creature rig (docs/creature-rig.md)
//
// init: the host (setting, hooks, built-in defs), then the public API (FUCompanion.api.creatureRig). The API
// is imported dynamically so a broken rig-api.js costs only the trigger API, never the host or the module.
// ============================================================================

import { initCreatureRigs } from "./rig-host.js";

Hooks.once("init", () => {
  try { initCreatureRigs(); } catch (e) { console.warn("[fu creature-rig] host failed to boot", e); return; }
  import("./rig-api.js")
    .then((m) => m.initCreatureRigApi?.())
    .catch((e) => console.warn("[fu creature-rig] rig-api.js did not load (no trigger API)", e));
});
