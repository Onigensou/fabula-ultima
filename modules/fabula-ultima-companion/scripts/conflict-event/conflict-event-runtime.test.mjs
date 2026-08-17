// ============================================================================
// Conflict Event System — runtime gate regression harness.
//
//     node scripts/conflict-event/conflict-event-runtime.test.mjs
//
// Covers `activeConflictEvent`, which is the gate every BD entry point checks
// first. It is the whole no-op guarantee: if it returns null, the lifecycle
// dispatch, the ledger reactor and the teardown all return before touching
// anything, and the director behaves exactly as it did before this system
// existed. `none` is the default on every scene in the world, so this gate is
// on the hot path of every conflict that will ever be fought.
//
// What this does NOT cover: actual handler invocation, which needs the real
// skill-effects / standalone-reactions modules and therefore a live Foundry.
// That is verified in-game.
//
// Foundry globals are stubbed below — the runtime reads `game` and `canvas`
// the same bare way the rest of the director does.
// ============================================================================

globalThis.game = { user: { isGM: true } };
globalThis.canvas = null;

const { registerConflictEvent, clearConflictEvents } = await import("./conflict-event-registry.js");
const { activeConflictEvent, LIFECYCLE_HANDLERS } = await import("./conflict-event-runtime.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const FLAG_NS = "fabula-ultima-companion";
const sceneWith = (general) => ({ flags: { [FLAG_NS]: { oniFabula: { general } } } });

// A director stand-in: only ctx + dCombat.scene are read by the gate.
const directorWith = ({ scene = null, payload = null, started = true } = {}) => ({
  ctx: { payload },
  dCombat: { scene, started },
});

const noop = () => {};
const quiet = { warn: () => {} };

clearConflictEvents();
registerConflictEvent({ id: "lightning-storm", label: "Lightning Storm", onConflictStart: noop }, quiet);

const arena = sceneWith({ sceneMode: "conflict", conflictEvent: "lightning-storm" });
const plain = sceneWith({ sceneMode: "conflict" });

// ── The no-op path ──────────────────────────────────────────────────────────
// Each of these must return null, because null is what makes every BD entry
// point a no-op.

eq("no director → null", activeConflictEvent(null), null);
eq("no dCombat → null", activeConflictEvent({ ctx: {} }), null);
eq("scene with no selection → null", activeConflictEvent(directorWith({ scene: plain })), null);
eq("bare scene → null", activeConflictEvent(directorWith({ scene: {} })), null);
eq("no scene at all → null", activeConflictEvent(directorWith({})), null);
eq("explicit none flag → null",
  activeConflictEvent(directorWith({ scene: sceneWith({ conflictEvent: "none" }) })), null);

// An unknown id must ALSO no-op rather than throw — a scene may name an event
// whose sub-script failed to load, and that must not abort the battle.
eq("unknown event id → null",
  activeConflictEvent(directorWith({ scene: sceneWith({ conflictEvent: "no-such-event" }) })), null);

// ── The active path ─────────────────────────────────────────────────────────

const fromScene = activeConflictEvent(directorWith({ scene: arena }));
eq("scene selection resolves", fromScene?.id, "lightning-storm");
eq("source is reported", fromScene?.source, "scene");
eq("the registered event comes back", fromScene?.event?.label, "Lightning Storm");

const fromOverride = activeConflictEvent(directorWith({
  scene: plain, payload: { context: { conflictEventId: "lightning-storm" } },
}));
eq("payload override resolves with no scene selection", fromOverride?.id, "lightning-storm");
eq("override source is reported", fromOverride?.source, "override");

eq("override of none suppresses the scene selection",
  activeConflictEvent(directorWith({ scene: arena, payload: { context: { conflictEventId: "none" } } })), null);

// ── The missing-event warning fires once, not per damage event ──────────────
// The ledger reactor runs on EVERY hp loss; an unguarded warn would flood the
// console during a Skizzik chain.

let warnCount = 0;
const realWarn = console.warn;
console.warn = () => { warnCount++; };
const missingDirector = directorWith({ scene: sceneWith({ conflictEvent: "gone-missing" }) });
for (let i = 0; i < 25; i++) activeConflictEvent(missingDirector);
console.warn = realWarn;
eq("missing event warns exactly once per conflict", warnCount, 1);

// A DIFFERENT conflict warns again — the latch is per-director, not global.
warnCount = 0;
console.warn = () => { warnCount++; };
activeConflictEvent(directorWith({ scene: sceneWith({ conflictEvent: "gone-missing" }) }));
console.warn = realWarn;
eq("a new conflict warns again", warnCount, 1);

// ── Lifecycle trigger → handler mapping ─────────────────────────────────────
// The dispatch site hands this every phased standalone trigger; the map is the
// only thing deciding which of them an event can see. `turn_start` is the
// presentation seam (it runs awaited, BEFORE the forced reaction pass), and a
// trigger absent from this map silently never reaches an event — which is
// exactly how a cinematic stops firing with nothing in the log.

eq("conflict_start → onConflictStart", LIFECYCLE_HANDLERS.conflict_start, "onConflictStart");
eq("round_start → onRoundStart", LIFECYCLE_HANDLERS.round_start, "onRoundStart");
eq("turn_start → onTurnStart", LIFECYCLE_HANDLERS.turn_start, "onTurnStart");
eq("turn_end is NOT dispatched", LIFECYCLE_HANDLERS.turn_end, undefined);
eq("the map is frozen", Object.isFrozen(LIFECYCLE_HANDLERS), true);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
