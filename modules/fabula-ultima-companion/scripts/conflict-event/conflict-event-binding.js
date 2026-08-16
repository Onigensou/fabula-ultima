// ============================================================================
// Conflict Event System — scene binding.
//
// Answers one question: "which conflict event, if any, is in play for THIS
// conflict?" Both the scene-configuration dropdown and the director runtime
// read from here, so there is exactly one definition of where the selection
// lives and which source wins.
//
// ── Where the selection lives ───────────────────────────────────────────────
//
//   flags.fabula-ultima-companion.oniFabula.general.conflictEvent
//
// on the CONFLICT scene (scene mode "conflict") — the arena, not the dungeon
// scene the party walked in from. A dungeon may own several conflict scenes
// and each one picks its own event, so the hazard belongs to the arena that
// fights it. That also means the selection is per-scene authoring work: five
// arenas in one dungeon means setting the dropdown five times.
//
// ── Resolution order ────────────────────────────────────────────────────────
//
//   1. payload.context.conflictEventId   (explicit override)
//   2. the conflict scene's flag
//   3. `none`
//
// The override exists because not every conflict is launched by walking into
// an arena. Battle-end follow-ups, the sim harness and test-battle-tool all
// build their own director payload, and during development the arena scene
// may not exist yet at all — the override is what lets an event be exercised
// end-to-end before its scene is built. It is also how a one-off scripted
// encounter runs an event on a shared arena without editing that scene.
//
// An override of `none` is deliberately honoured as an override: it is the
// documented way to run a plain conflict on a scene that normally carries a
// hazard.
//
// This module is PURE — it reads plain objects and never touches a Foundry
// global — so conflict-event-binding.test.mjs runs in bare Node.
// ============================================================================

import { NONE_ID } from "./conflict-event-registry.js";

/** Module flag namespace. */
export const FLAG_NS = "fabula-ultima-companion";

/**
 * Flag path within the namespace. Mirrors the scene-config UI's key
 * constants (FABULA_ROOT_KEY / GENERAL_KEY), which are re-declared locally
 * there because that file is a classic IIFE script and cannot import.
 * Keep the two in step.
 */
export const FLAG_ROOT = "oniFabula";
export const FLAG_GROUP = "general";
export const FLAG_KEY = "conflictEvent";
export const FLAG_PATH = `${FLAG_ROOT}.${FLAG_GROUP}.${FLAG_KEY}`;

/** The scene mode a conflict event is meaningful on. */
export const CONFLICT_SCENE_MODE = "conflict";

const SCENE_MODE_KEY = "sceneMode";

function generalFlags(scene) {
  return scene?.flags?.[FLAG_NS]?.[FLAG_ROOT]?.[FLAG_GROUP] ?? null;
}

/** Is this scene a conflict arena? */
export function isConflictScene(scene) {
  return String(generalFlags(scene)?.[SCENE_MODE_KEY] ?? "").trim() === CONFLICT_SCENE_MODE;
}

/**
 * The event id stored on a scene, or `none`.
 *
 * Deliberately does NOT check the scene mode. A scene that was a conflict
 * arena and got switched to another mode keeps its stored selection so that
 * flipping the mode back does not silently lose it; the runtime is what
 * decides whether a conflict is happening at all.
 */
export function readSceneConflictEventId(scene) {
  const raw = generalFlags(scene)?.[FLAG_KEY];
  const id = String(raw ?? "").trim();
  return id || NONE_ID;
}

/**
 * Resolve the event id for a conflict about to start.
 *
 * `payload` is the director payload; the override is read from both
 * `context` and the payload root, matching how the director itself reads
 * battleSceneUuid from either place.
 */
export function resolveConflictEventId({ scene = null, payload = null } = {}) {
  const override = payload?.context?.conflictEventId ?? payload?.conflictEventId ?? null;
  const overrideId = String(override ?? "").trim();
  if (overrideId) return { id: overrideId, source: "override" };

  const sceneId = readSceneConflictEventId(scene);
  if (sceneId !== NONE_ID) return { id: sceneId, source: "scene" };

  return { id: NONE_ID, source: "default" };
}
