// ============================================================================
// Conflict Event System — public API + event registration.
//
//     FUCompanion.api.conflictEvents.list()          → dropdown choices
//     FUCompanion.api.conflictEvents.get(id)         → the registered event
//     FUCompanion.api.conflictEvents.readScene(sc)   → a scene's selection
//     FUCompanion.api.conflictEvents.resolve({...})  → override → scene → none
//
// The list is published on the global because the scene-configuration UI
// (custom-ui/dungeon-configuration-ui.js) is a classic IIFE script and cannot
// import an ES module — the same reason director-triggers.js publishes its
// trigger sets. Everything inside the module system should import the registry
// directly rather than going through the global.
//
// ── Where events get registered ─────────────────────────────────────────────
//
// Each event is its own sub-script under events/ and self-registers when
// imported. They are imported HERE, explicitly, rather than being discovered:
// one file lists every event that exists, and the import order is stable.
// ============================================================================

import {
  NONE_ID,
  registerConflictEvent,
  getConflictEvent,
  hasConflictEvent,
  listConflictEvents,
} from "./conflict-event-registry.js";
import {
  isConflictScene,
  readSceneConflictEventId,
  resolveConflictEventId,
  FLAG_NS,
  FLAG_PATH,
  CONFLICT_SCENE_MODE,
} from "./conflict-event-binding.js";

// ── Event sub-scripts ───────────────────────────────────────────────────────
// Importing registers. Add new events here.
import "./events/lightning-storm.js";

const TAG = "[FU][ConflictEvent]";

const api = {
  NONE: NONE_ID,
  FLAG_NS,
  FLAG_PATH,
  CONFLICT_SCENE_MODE,

  list: listConflictEvents,
  get: getConflictEvent,
  has: hasConflictEvent,
  register: registerConflictEvent,

  isConflictScene,
  readScene: readSceneConflictEventId,
  resolve: resolveConflictEventId,
};

function ensureModuleApi() {
  const mod = game.modules?.get(FLAG_NS);
  if (!mod) return null;
  mod.api = mod.api || {};
  return mod.api;
}

function ensureGlobalApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  return globalThis.FUCompanion.api;
}

// `init` rather than `ready`: the scene-configuration UI renders whenever a GM
// opens Scene Config, which can happen before `ready` completes on a slow
// world. Publishing early means the dropdown is never empty for want of an API.
Hooks.once("init", () => {
  try {
    const m = ensureModuleApi(); if (m) m.conflictEvents = api;
    ensureGlobalApi().conflictEvents = api;
    const ids = listConflictEvents().map((c) => c.id).filter((id) => id !== NONE_ID);
    console.debug(TAG, `ready — FUCompanion.api.conflictEvents (${ids.length} event(s): ${ids.join(", ") || "—"})`);
  } catch (e) {
    console.warn(TAG, "bootstrap failed", e);
  }
});

export { api as ConflictEventApi };
