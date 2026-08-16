// ============================================================================
// Conflict Event System — scene binding regression harness.
//
//     node scripts/conflict-event/conflict-event-binding.test.mjs
//
// Bare Node, no Foundry. The binding reads plain objects, which is what makes
// this possible — keep it that way.
//
// The load-bearing assertions are the precedence ones. If the scene flag ever
// won over the payload override, an event could not be exercised before its
// arena scene exists, and a follow-up battle could not opt out of the hazard
// it inherited from the scene it is standing on.
// ============================================================================

import {
  FLAG_NS, FLAG_ROOT, FLAG_GROUP, FLAG_KEY, FLAG_PATH,
  CONFLICT_SCENE_MODE,
  isConflictScene,
  readSceneConflictEventId,
  resolveConflictEventId,
} from "./conflict-event-binding.js";
import { NONE_ID } from "./conflict-event-registry.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// Minimal stand-in for a Foundry Scene — only the flags shape is read.
const sceneWith = (general) => ({ flags: { [FLAG_NS]: { [FLAG_ROOT]: { [FLAG_GROUP]: general } } } });

const arena      = sceneWith({ sceneMode: "conflict", conflictEvent: "lightning-storm" });
const plainArena = sceneWith({ sceneMode: "conflict" });
const dungeon    = sceneWith({ sceneMode: "dungeon" });
const bare       = {};

// ── Flag path ───────────────────────────────────────────────────────────────
// Pinned: the scene-config UI re-declares these literals (classic IIFE script,
// cannot import). If the path moves here and not there, saving writes to one
// place and the runtime reads another — with no error anywhere.

eq("flag path is pinned", FLAG_PATH, "oniFabula.general.conflictEvent");
eq("flag namespace is pinned", FLAG_NS, "fabula-ultima-companion");
eq("flag parts compose the path", `${FLAG_ROOT}.${FLAG_GROUP}.${FLAG_KEY}`, FLAG_PATH);
eq("conflict scene mode is pinned", CONFLICT_SCENE_MODE, "conflict");

// ── Scene mode ──────────────────────────────────────────────────────────────

eq("arena is a conflict scene", isConflictScene(arena), true);
eq("dungeon is not", isConflictScene(dungeon), false);
eq("bare scene is not", isConflictScene(bare), false);
eq("null scene is not", isConflictScene(null), false);

// ── Reading the flag ────────────────────────────────────────────────────────

eq("reads a stored id", readSceneConflictEventId(arena), "lightning-storm");
eq("missing flag reads as none", readSceneConflictEventId(plainArena), NONE_ID);
eq("bare scene reads as none", readSceneConflictEventId(bare), NONE_ID);
eq("null scene reads as none", readSceneConflictEventId(null), NONE_ID);
eq("blank flag reads as none", readSceneConflictEventId(sceneWith({ conflictEvent: "   " })), NONE_ID);

// A stored selection survives a mode switch — flipping a scene to another mode
// and back must not silently drop the developer's choice.
eq("selection is kept on a non-conflict scene",
  readSceneConflictEventId(sceneWith({ sceneMode: "dungeon", conflictEvent: "lightning-storm" })),
  "lightning-storm");

// ── Resolution precedence ───────────────────────────────────────────────────

eq("scene flag resolves",
  resolveConflictEventId({ scene: arena }), { id: "lightning-storm", source: "scene" });
eq("no scene, no payload → none",
  resolveConflictEventId({}), { id: NONE_ID, source: "default" });
eq("plain arena → none",
  resolveConflictEventId({ scene: plainArena }), { id: NONE_ID, source: "default" });

eq("override beats the scene flag",
  resolveConflictEventId({ scene: arena, payload: { context: { conflictEventId: "other-event" } } }),
  { id: "other-event", source: "override" });
eq("override works with no scene at all",
  resolveConflictEventId({ payload: { context: { conflictEventId: "lightning-storm" } } }),
  { id: "lightning-storm", source: "override" });
eq("override is read from the payload root too",
  resolveConflictEventId({ payload: { conflictEventId: "root-level" } }),
  { id: "root-level", source: "override" });
eq("context override wins over the root",
  resolveConflictEventId({ payload: { conflictEventId: "root", context: { conflictEventId: "ctx" } } }),
  { id: "ctx", source: "override" });

// An explicit `none` override is an override: the documented way to run a
// plain conflict on an arena that normally carries a hazard.
eq("explicit none override suppresses the scene flag",
  resolveConflictEventId({ scene: arena, payload: { context: { conflictEventId: NONE_ID } } }),
  { id: NONE_ID, source: "override" });

// A blank/absent override must NOT suppress the scene flag — every payload
// that never heard of conflict events carries undefined here.
eq("absent override falls through to the scene",
  resolveConflictEventId({ scene: arena, payload: { context: {} } }),
  { id: "lightning-storm", source: "scene" });
eq("blank override falls through to the scene",
  resolveConflictEventId({ scene: arena, payload: { context: { conflictEventId: "  " } } }),
  { id: "lightning-storm", source: "scene" });
eq("null override falls through to the scene",
  resolveConflictEventId({ scene: arena, payload: { context: { conflictEventId: null } } }),
  { id: "lightning-storm", source: "scene" });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
