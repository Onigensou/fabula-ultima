// ============================================================================
// Conflict Event System — registry regression harness.
//
//     node scripts/conflict-event/conflict-event-registry.test.mjs
//
// Runs in bare Node: no Foundry, no browser, no game world. That is only
// possible because conflict-event-registry.js is pure, and keeping this
// runnable is the reason to keep it pure. Exits non-zero on failure.
//
// The load-bearing assertions are the rejection ones. Every rejected case here
// is a bug that would otherwise be SILENT at a live table: a misspelled
// handler that never fires, a duplicate id that shadows a real event, an
// event that overrides `none` and turns every standard conflict into a
// hazard. The registry is the only place these can be caught cheaply.
// ============================================================================

import {
  NONE_ID,
  EVENT_HANDLERS,
  registerConflictEvent,
  getConflictEvent,
  hasConflictEvent,
  listConflictEvents,
  clearConflictEvents,
} from "./conflict-event-registry.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// Registration failures are EXPECTED in most cases below, so swallow the
// console noise and let the assertions speak.
const quiet = { warn: () => {} };
const noop = () => {};

// ── Happy path ──────────────────────────────────────────────────────────────

clearConflictEvents();
eq("registers a well-formed event",
  registerConflictEvent({ id: "storm", label: "Lightning Storm", onConflictStart: noop }, quiet), true);
eq("getConflictEvent returns it", getConflictEvent("storm")?.id, "storm");
eq("hasConflictEvent true", hasConflictEvent("storm"), true);
eq("label is kept", getConflictEvent("storm")?.label, "Lightning Storm");
eq("id is trimmed", (registerConflictEvent({ id: "  spaced  ", onRoundStart: noop }, quiet),
  hasConflictEvent("spaced")), true);
eq("unimplemented handlers normalise to null", getConflictEvent("storm")?.onRoundStart, null);

// A partial event is legal — an event implements only the beats it needs.
clearConflictEvents();
eq("ledger-only event is legal",
  registerConflictEvent({ id: "ledger-only", onLedgerEvent: noop }, quiet), true);

// ── `none` is reserved ──────────────────────────────────────────────────────
// If an event could claim "none", selecting "no additional rules" would
// silently arm a hazard on every standard conflict in the world.

clearConflictEvents();
eq("cannot register the reserved none id",
  registerConflictEvent({ id: NONE_ID, onConflictStart: noop }, quiet), false);
eq("none never resolves to an event", getConflictEvent(NONE_ID), null);
eq("blank never resolves to an event", getConflictEvent(""), null);
eq("undefined never resolves to an event", getConflictEvent(undefined), null);
eq("unknown id resolves to null", getConflictEvent("no-such-event"), null);

// ── Malformed registrations ─────────────────────────────────────────────────

clearConflictEvents();
eq("rejects a missing id", registerConflictEvent({ onConflictStart: noop }, quiet), false);
eq("rejects a blank id", registerConflictEvent({ id: "   ", onConflictStart: noop }, quiet), false);
eq("rejects a non-object", registerConflictEvent(null, quiet), false);
eq("rejects an event with no handlers at all",
  registerConflictEvent({ id: "inert", label: "Inert" }, quiet), false);
eq("rejects a non-function handler",
  registerConflictEvent({ id: "bad-handler", onConflictStart: "yes please" }, quiet), false);
eq("a rejected event is not registered", hasConflictEvent("bad-handler"), false);

// A typo'd handler is the nastiest silent failure: the event registers, the
// developer sees no error, and the rule simply never fires. It must not count
// as a handler — so an event with ONLY a typo'd handler is rejected outright.
clearConflictEvents();
eq("a typo'd handler does not count as a handler",
  registerConflictEvent({ id: "typo", onRoundStarts: noop }, quiet), false);

// ── Duplicates ──────────────────────────────────────────────────────────────
// First registration wins, so a stray second copy can never shadow the real
// event with a stub.

clearConflictEvents();
registerConflictEvent({ id: "dupe", label: "First", onConflictStart: noop }, quiet);
eq("duplicate id is rejected",
  registerConflictEvent({ id: "dupe", label: "Second", onConflictStart: noop }, quiet), false);
eq("the FIRST registration survives", getConflictEvent("dupe")?.label, "First");

// ── Dropdown choices ────────────────────────────────────────────────────────

clearConflictEvents();
registerConflictEvent({ id: "zulu", label: "Zulu", onConflictStart: noop }, quiet);
registerConflictEvent({ id: "alpha", label: "Alpha", onConflictStart: noop }, quiet);
const choices = listConflictEvents();
eq("none is always the first choice", choices[0].id, NONE_ID);
eq("the rest are sorted by label", choices.slice(1).map((c) => c.id), ["alpha", "zulu"]);
eq("an empty registry still offers none", (clearConflictEvents(), listConflictEvents().map((c) => c.id)), [NONE_ID]);

// ── Contract shape ──────────────────────────────────────────────────────────
// The runtime dispatches by iterating EVENT_HANDLERS. If a handler is added
// here without a dispatch site (or vice versa) the two drift silently, so the
// list is pinned.

eq("handler list is pinned", [...EVENT_HANDLERS],
  ["onConflictStart", "onRoundStart", "onLedgerEvent", "onConflictEnd"]);

// A registered event is frozen: a buggy sub-script must not be able to mutate
// another event's handlers at runtime.
clearConflictEvents();
registerConflictEvent({ id: "frozen", onConflictStart: noop }, quiet);
const ev = getConflictEvent("frozen");
try { ev.onConflictStart = () => "hijacked"; } catch { /* strict-mode throw is fine too */ }
eq("registered events are frozen", ev.onConflictStart, noop);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
