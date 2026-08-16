// ============================================================================
// Conflict Event System — registry.
//
// A "conflict event" is an additional rule that rides on top of the normal
// Battle Director conflict — a dungeon hazard, a boss arena gimmick, a story
// modifier. Standard conflicts run BD unchanged; a conflict event automates
// ONE extra rule inside BD's existing lifecycle.
//
// Exactly ONE event may be selected per conflict scene (scene mode
// "conflict"), chosen by the developer in the scene configuration. Events do
// not stack: a complex event is hard enough to reason about on its own, and
// two interacting hazards would multiply combinatorially for no payoff.
// Default is `none`, which is a true no-op — with `none` selected the
// director's behaviour is byte-identical to before this system existed.
//
// ── The boundary that keeps this honest ─────────────────────────────────────
//
// Battle Director owns the game state. An event NEVER reaches around it: it
// does not write HP, does not roll its own damage, does not keep a private
// model of the battle. It observes BD's own lifecycle and asks BD to do
// things through BD's own effect executor, so damage runs through
// apply-damage-core and picks up affinities, absorb, the resource ledger and
// the downstream trigger cascade for free.
//
// The scope split, which is what keeps event scripts small:
//
//   ACTOR-scoped behaviour  → an Active Effect carrying its own
//                             reactionConfig (works on PCs and NPCs alike,
//                             with no per-actor authoring)
//   BATTLEFIELD-scoped      → this system (no owner, no host token, nothing
//                             in the initiative order)
//
// Lightning Storm is the reference implementation: the per-turn strike lives
// on the `Lightning Rod` AE, and only the ownerless half — seed the Rod, move
// it when someone takes damage, sweep it at the end — lives in the event.
//
// ── The state rule (NOT optional) ───────────────────────────────────────────
//
// An event MUST NOT hold state. BD persists and rewinds through snapshot.js /
// persistence.js and supports F5 mid-battle resume; anything an event parks in
// a module-level Map or a closure desyncs on reload and is silently wrong
// after a rewind.
//
// Where state is genuinely needed:
//   • prefer making it an AE — Foundry persists it, F5 restores it, rewind
//     restores it, and the players can see it as a status chip for free
//     (Lightning Storm needs no other state at all: "who holds the Rod" IS
//     the AE)
//   • otherwise put a counter on `director.ctx` (geist-blackest-night.js's
//     `ctx._undyingTriggers` is the precedent) or on a scene flag
//
// This module is deliberately PURE — no Foundry globals, no imports from the
// director. That is what lets conflict-event-registry.test.mjs run in bare
// Node, and it is worth preserving.
// ============================================================================

/** The always-present "no additional rule" selection. */
export const NONE_ID = "none";

/**
 * Lifecycle handlers an event may implement. Every one is optional; an event
 * implements only the beats it cares about.
 *
 *   onConflictStart(evtCtx)        — the conflict has begun (round 0). Seed here.
 *   onRoundStart(evtCtx)           — a new round has begun. Re-seed / upkeep here.
 *   onLedgerEvent(evtCtx, cfg)     — a resource/status ledger event is settling.
 *                                    Runs INSIDE settleInstance, awaited, with
 *                                    the shared `firedKeys` dedupe set. This is
 *                                    the damage-driven beat.
 *   onConflictEnd(evtCtx)          — the conflict is over. Sweep here.
 *
 * The handler names are validated on registration: a typo'd handler would
 * otherwise register cleanly and then simply never fire, which is a miserable
 * class of bug to chase at a live table.
 */
export const EVENT_HANDLERS = Object.freeze([
  "onConflictStart",
  "onRoundStart",
  "onLedgerEvent",
  "onConflictEnd",
]);

/** Descriptive (non-handler) keys an event may carry. */
const EVENT_META = Object.freeze(["id", "label", "description"]);

const _events = new Map();

/**
 * Register a conflict event. Called once at boot by each event sub-script.
 *
 * Returns true when the event was registered. Registration is deliberately
 * forgiving at runtime (a broken event must never take the module down with
 * it) but loud in the console, because every failure mode here is silent at
 * the table.
 */
export function registerConflictEvent(event, { warn = console.warn } = {}) {
  if (!event || typeof event !== "object") {
    warn("[FU][ConflictEvent] registerConflictEvent: expected an event object");
    return false;
  }

  const id = String(event.id ?? "").trim();
  if (!id) {
    warn("[FU][ConflictEvent] registerConflictEvent: event needs an id");
    return false;
  }
  if (id === NONE_ID) {
    warn(`[FU][ConflictEvent] "${NONE_ID}" is reserved — it is the no-op selection`);
    return false;
  }
  if (_events.has(id)) {
    warn(`[FU][ConflictEvent] duplicate event id "${id}" — the later registration is ignored`);
    return false;
  }

  // Typo guard. An unknown key is almost always a misspelled handler
  // ("onRoundStarts", "onConflictStarted"), which would register happily and
  // then never fire.
  for (const key of Object.keys(event)) {
    if (EVENT_HANDLERS.includes(key) || EVENT_META.includes(key)) continue;
    warn(`[FU][ConflictEvent] "${id}": unknown key "${key}" — ignored. Handlers are: ${EVENT_HANDLERS.join(", ")}`);
  }

  for (const key of EVENT_HANDLERS) {
    if (event[key] != null && typeof event[key] !== "function") {
      warn(`[FU][ConflictEvent] "${id}": ${key} must be a function — event not registered`);
      return false;
    }
  }

  if (!EVENT_HANDLERS.some((key) => typeof event[key] === "function")) {
    warn(`[FU][ConflictEvent] "${id}": implements no handlers — it would never do anything`);
    return false;
  }

  _events.set(id, Object.freeze({
    id,
    label: String(event.label ?? id),
    description: String(event.description ?? ""),
    onConflictStart: event.onConflictStart ?? null,
    onRoundStart: event.onRoundStart ?? null,
    onLedgerEvent: event.onLedgerEvent ?? null,
    onConflictEnd: event.onConflictEnd ?? null,
  }));
  return true;
}

/** The registered event, or null for `none` / unknown / blank. */
export function getConflictEvent(id) {
  const key = String(id ?? "").trim();
  if (!key || key === NONE_ID) return null;
  return _events.get(key) ?? null;
}

export function hasConflictEvent(id) {
  return getConflictEvent(id) != null;
}

/**
 * Choices for the scene-configuration dropdown, `none` first and the rest
 * sorted by label so the list is stable as events are added.
 */
export function listConflictEvents() {
  const rest = Array.from(_events.values())
    .map(({ id, label, description }) => ({ id, label, description }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ id: NONE_ID, label: "None", description: "No additional rules — a standard conflict." }, ...rest];
}

/** Test / hot-reload support. */
export function clearConflictEvents() {
  _events.clear();
}
