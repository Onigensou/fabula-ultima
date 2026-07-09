// ============================================================================
// Clock System — Schema, validation, and the pure advance/resolve math.
//
// Everything here is a pure function over plain JSON-serializable objects. No
// Foundry globals, no `game`, no DOM, no async. That is deliberate: it makes
// the advancement rules unit-testable from a bare console, and it is what lets
// `previewCheck` exist at all (see clock-check.js) — a preview is just the same
// math run without writing the result anywhere.
//
// Callers never mutate a clock in place. `applyDelta` returns a NEW clock plus
// a description of what happened; clock-store.js is the only thing that
// persists that result.
// ============================================================================

import {
  SIDE, POLE, OUTCOME, CLOCK_STATE, LIFECYCLE, GROUP_MODE, GROUP_ROLE,
  VISIBILITY, CLOCK_HISTORY_MAX, CLOCK_SECTIONS_DEFAULT,
  CLOCK_SECTIONS_MIN, CLOCK_SECTIONS_MAX,
} from "./clock-const.js";

// ── Small helpers ───────────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function int(v, fallback = 0) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

function oneOf(v, allowed, fallback) {
  return Object.values(allowed).includes(v) ? v : fallback;
}

/** Throw with a consistent prefix so bad specs are obvious at the call site. */
function bad(msg) {
  throw new Error(`[FU][Clock] invalid clock spec: ${msg}`);
}

// ── Poles ───────────────────────────────────────────────────────────────────

/**
 * Normalize one pole. `null` (or a falsy spec) means the pole is UNCLAIMED:
 * the value clamps there and nothing resolves. That is what makes a plain
 * progress clock a progress clock — its low pole is simply not a thing that
 * can happen.
 */
function normalizePole(spec, poleName) {
  if (!spec) return null;
  const side = oneOf(spec.side, SIDE, null);
  if (!side) bad(`poles.${poleName}.side must be one of ${Object.values(SIDE).join(" | ")}`);
  const outcome = oneOf(spec.outcome, OUTCOME, OUTCOME.SUCCESS);
  return {
    side,
    outcome,
    label: String(spec.label ?? "").trim() || null,
  };
}

function normalizeGroup(spec) {
  if (!spec) return null;
  const id = String(spec.id ?? "").trim();
  if (!id) bad("group.id is required when group is set");
  const mode = oneOf(spec.mode, GROUP_MODE, GROUP_MODE.INDEPENDENT);
  // `role` only carries meaning in a paired group, but we normalize it always
  // so a group can be switched to `paired` later without a migration.
  const role = oneOf(spec.role, GROUP_ROLE, GROUP_ROLE.PRIMARY);
  return { id, mode, role };
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Build a validated clock from a loose spec.
 *
 * `id` is OPTIONAL here and is assigned by the store on create — this module
 * never touches foundry.utils.randomID, it stays pure. That means a preset can
 * be built and inspected before it is ever persisted:
 *
 *     await api.create(api.preset.threat({ name: "Ambushed!" }));
 *
 * `reviveClock` does require an id, because a record read back out of the
 * registry without one is corrupt.
 *
 * @param {object} spec
 * @param {string} [spec.id]      assigned by the store when absent
 * @param {string} spec.name
 * @param {number} [spec.sections=6]
 * @param {number} [spec.value]           defaults to 0, or `sections` when only
 *                                        the low pole is claimed (teardown)
 * @param {object} [spec.poles]           { high, low } — each { side, outcome, label }
 * @param {object} [spec.group]           { id, mode, role }
 * @param {string} [spec.lifecycle="manual"]
 * @param {string} [spec.visibility="all"]
 * @param {string[]} [spec.tags]
 * @param {object[]} [spec.automation]    trigger rows; matched in phase 7
 */
export function makeClock(spec = {}) {
  const id = String(spec.id ?? "").trim() || null;

  const name = String(spec.name ?? "").trim();
  if (!name) bad("name is required");

  const sections = clamp(
    int(spec.sections, CLOCK_SECTIONS_DEFAULT),
    CLOCK_SECTIONS_MIN,
    CLOCK_SECTIONS_MAX,
  );

  const poles = {
    high: normalizePole(spec.poles?.high, POLE.HIGH),
    low:  normalizePole(spec.poles?.low, POLE.LOW),
  };

  if (!poles.high && !poles.low) {
    bad("at least one pole must be claimed, otherwise the clock can never resolve");
  }
  if (poles.high && poles.low && poles.high.side === poles.low.side) {
    bad("poles.high and poles.low cannot be owned by the same side");
  }

  // A clock with only a LOW pole is a teardown clock — it starts full, because
  // the interesting act is emptying it. Everything else starts at 0. An
  // explicit `value` always wins.
  const defaultValue = (!poles.high && poles.low) ? sections : 0;
  const value = clamp(int(spec.value ?? defaultValue, defaultValue), 0, sections);

  return {
    id,
    name,
    description: String(spec.description ?? ""),
    icon: spec.icon ? String(spec.icon) : null,
    tags: Array.isArray(spec.tags) ? spec.tags.map(String) : [],

    sections,
    value,
    poles,

    state: CLOCK_STATE.ACTIVE,
    resolution: null,

    group: normalizeGroup(spec.group),
    lifecycle: oneOf(spec.lifecycle, LIFECYCLE, LIFECYCLE.MANUAL),
    visibility: oneOf(spec.visibility, VISIBILITY, VISIBILITY.ALL),

    // Owning scene, for the `scene` lifecycle only. Without it a scene sweep
    // couldn't tell "clock from the room we just left" from "clock created for
    // the room we just entered", and would discard both.
    sceneId: spec.sceneId ? String(spec.sceneId) : null,

    automation: Array.isArray(spec.automation) ? spec.automation.map((r) => ({ ...r })) : [],
    history: [],

    createdAt: int(spec.createdAt, Date.now()),
  };
}

/**
 * Re-validate a clock read back from persistence. Tolerant: a registry written
 * by an older build should load rather than throw and take the panel with it.
 * Returns null when the record is unsalvageable.
 */
export function reviveClock(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id) return null;   // a persisted record without an id is corrupt
  try {
    const base = makeClock(raw);
    return {
      ...base,
      state: oneOf(raw.state, CLOCK_STATE, CLOCK_STATE.ACTIVE),
      resolution: raw.resolution ?? null,
      history: Array.isArray(raw.history) ? raw.history.slice(-CLOCK_HISTORY_MAX) : [],
      value: clamp(int(raw.value, base.value), 0, base.sections),
    };
  } catch {
    return null;
  }
}

// ── Direction ───────────────────────────────────────────────────────────────

/**
 * Which way does `side` push? +1 toward the high pole, -1 toward the low pole.
 *
 * A side pushes toward the pole IT OWNS. That single rule is what collapses
 * "fill", "erase", and "struggle" into one operation: the GM filling a threat
 * clock and the players emptying a teardown clock are the same call with
 * different pole ownership.
 *
 * `direction` ("high" | "low") overrides, for GM manual nudges and for pushing
 * a clock in a direction nobody owns. Returns 0 when the side owns no pole and
 * no override was given — the caller should treat that as a no-op, not an error.
 */
export function signFor(clock, side, direction = null) {
  if (direction === POLE.HIGH) return +1;
  if (direction === POLE.LOW) return -1;
  if (clock.poles.high?.side === side) return +1;
  if (clock.poles.low?.side === side) return -1;
  return 0;
}

/** The pole `side` owns, or null. */
export function poleFor(clock, side) {
  if (clock.poles.high?.side === side) return POLE.HIGH;
  if (clock.poles.low?.side === side) return POLE.LOW;
  return null;
}

/**
 * Who owns section `i` when the clock reads `value`? The rendering rule, kept
 * here rather than in the renderer because it is a statement about the MODEL:
 * the axis below the value belongs to the high pole, the axis above it to the
 * low pole, and an unclaimed pole is nobody's.
 *
 * Every clock shape falls out of it — a progress bar fills with the players'
 * colour, a threat bar with the GM's, a teardown bar is a neutral obstacle
 * eaten from the right, and a struggle bar is a two-colour tug-of-war meeting
 * at `value`.
 *
 * @returns {"players"|"gm"|"neutral"|"empty"}
 */
export function notchOwnerAt(clock, i, value = clock.value) {
  const pole = i < value ? clock.poles.high : clock.poles.low;
  if (pole) return pole.side;
  return i < value ? "neutral" : "empty";
}

/**
 * What KIND of clock is this, for the UI's glow? Derived from the poles, so it
 * cannot disagree with how the clock actually behaves:
 *
 *   both poles claimed        → "contest"   a tug-of-war (blue↔red gradient)
 *   one pole, outcome=failure → "threat"    (red)
 *   one pole, outcome=success → "progress"  (blue)
 *
 * A teardown clock is `progress`: its single claimed pole is a player success,
 * and emptying it is the win — the fact that it counts DOWN is a rendering
 * detail, not a different kind of clock.
 *
 * @returns {"contest"|"threat"|"progress"}
 */
export function clockTone(clock) {
  if (clock.poles.high && clock.poles.low) return "contest";
  const pole = clock.poles.high ?? clock.poles.low;
  return pole?.outcome === OUTCOME.FAILURE ? "threat" : "progress";
}

/**
 * The bar's fill, as a whole percentage, ROUNDED UP — a clock with any progress
 * at all must never read 0%, and only a truly full clock reads 100%.
 */
export function clockPercent(clock, value = clock.value) {
  if (value <= 0) return 0;
  if (value >= clock.sections) return 100;
  return Math.ceil((value / clock.sections) * 100);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Does `value` sit on a CLAIMED pole? Unclaimed poles clamp silently — a
 * progress clock sitting at 0 has not "failed", it just hasn't started.
 */
export function resolutionFor(clock, value) {
  if (value >= clock.sections && clock.poles.high) {
    return { pole: POLE.HIGH, side: clock.poles.high.side, outcome: clock.poles.high.outcome };
  }
  if (value <= 0 && clock.poles.low) {
    return { pole: POLE.LOW, side: clock.poles.low.side, outcome: clock.poles.low.outcome };
  }
  return null;
}

// ── Advancement ─────────────────────────────────────────────────────────────

/**
 * Advance a clock. Returns a NEW clock; never mutates the input.
 *
 * `sections` is signed relative to the side's own pole: positive pushes toward
 * it, negative pulls away (RAW "Turning Back a Clock"). So `{ side: "gm",
 * sections: -1 }` on a threat clock erases a section of threat.
 *
 * The final axis movement is `sign × sections`, so passing a `direction`
 * override TOGETHER with negative `sections` double-negates and pushes the
 * other way. Turning a clock back needs only the negative `sections` — reach
 * for `direction` solely when the acting side owns no pole.
 *
 * @returns {{clock: object, delta: number, previous: number, resolution: object|null, noop: boolean}}
 *   `delta` is the ACTUAL change after clamping, signed on the axis (not on the
 *   side's pole) — a UI animating notches wants the axis delta.
 */
export function applyDelta(clock, {
  side = null,
  sections = 1,
  direction = null,
  cause = null,
  actorUuid = null,
  at = Date.now(),
} = {}) {
  const previous = clock.value;
  const noResult = { clock, delta: 0, previous, resolution: null, noop: true };

  if (clock.state !== CLOCK_STATE.ACTIVE) return noResult;

  const sign = signFor(clock, side, direction);
  if (sign === 0) return noResult;

  const magnitude = int(sections, 0);
  if (magnitude === 0) return noResult;

  const next = clamp(previous + sign * magnitude, 0, clock.sections);
  if (next === previous) return noResult;

  const resolution = resolutionFor(clock, next);
  const delta = next - previous;

  const entry = {
    at,
    side,
    delta,
    from: previous,
    to: next,
    cause: cause ?? null,
    actorUuid: actorUuid ?? null,
  };

  return {
    clock: {
      ...clock,
      value: next,
      state: resolution ? CLOCK_STATE.RESOLVED : clock.state,
      resolution: resolution ? { ...resolution, at, cause: cause ?? null } : null,
      history: [...clock.history, entry].slice(-CLOCK_HISTORY_MAX),
    },
    delta,
    previous,
    resolution,
    noop: false,
  };
}

/**
 * GM override — jump straight to a value. Still runs the resolution check, so
 * setting a clock to its full section count resolves it exactly as filling it
 * one section at a time would.
 */
export function applySet(clock, value, { cause = null, at = Date.now() } = {}) {
  const previous = clock.value;
  if (clock.state !== CLOCK_STATE.ACTIVE) {
    return { clock, delta: 0, previous, resolution: null, noop: true };
  }
  const next = clamp(int(value, previous), 0, clock.sections);
  if (next === previous) return { clock, delta: 0, previous, resolution: null, noop: true };

  const resolution = resolutionFor(clock, next);
  const entry = { at, side: null, delta: next - previous, from: previous, to: next, cause: cause ?? "set", actorUuid: null };

  return {
    clock: {
      ...clock,
      value: next,
      state: resolution ? CLOCK_STATE.RESOLVED : clock.state,
      resolution: resolution ? { ...resolution, at, cause: cause ?? null } : null,
      history: [...clock.history, entry].slice(-CLOCK_HISTORY_MAX),
    },
    delta: next - previous,
    previous,
    resolution,
    noop: false,
  };
}

/** Force a resolution at a pole regardless of value (GM "just end it"). */
export function applyResolve(clock, pole, { cause = null, at = Date.now() } = {}) {
  const p = clock.poles[pole];
  if (!p) bad(`cannot resolve at unclaimed pole "${pole}"`);
  const value = pole === POLE.HIGH ? clock.sections : 0;
  return {
    ...clock,
    value,
    state: CLOCK_STATE.RESOLVED,
    resolution: { pole, side: p.side, outcome: p.outcome, at, cause: cause ?? "forced" },
  };
}

/** Reopen a resolved clock, pulling it one section off the pole it landed on. */
export function applyReopen(clock, { at = Date.now() } = {}) {
  if (clock.state !== CLOCK_STATE.RESOLVED) return clock;
  const pole = clock.resolution?.pole;
  const value = pole === POLE.HIGH ? Math.max(0, clock.sections - 1) : Math.min(clock.sections, 1);
  return {
    ...clock,
    value: clamp(value, 0, clock.sections),
    state: CLOCK_STATE.ACTIVE,
    resolution: null,
    history: [...clock.history, { at, side: null, delta: 0, from: clock.value, to: value, cause: "reopen", actorUuid: null }]
      .slice(-CLOCK_HISTORY_MAX),
  };
}

export function applyDiscard(clock, { cause = null, at = Date.now() } = {}) {
  return {
    ...clock,
    state: CLOCK_STATE.DISCARDED,
    history: [...clock.history, { at, side: null, delta: 0, from: clock.value, to: clock.value, cause: cause ?? "discard", actorUuid: null }]
      .slice(-CLOCK_HISTORY_MAX),
  };
}

// ── Presets ─────────────────────────────────────────────────────────────────
// Sugar over `makeClock` for the four canonical shapes. Nothing the engine
// treats specially — each is just a pole configuration.
//
// Label a pole either way, whichever reads better at the call site:
//
//     preset.teardown({ name: "Ceiling", successLabel: "It collapses!" })
//     preset.teardown({ name: "Ceiling", poles: { low: { side: "players",
//                       outcome: "success", label: "It collapses!" } } })
//
// An explicit `poles` WINS. It used to be silently discarded — the presets
// spread `...spec` before their own `poles` key, so a caller who passed poles
// got the default back with no error and a generic banner. Caught in the first
// live demo.

export const preset = Object.freeze({
  /** Players work toward something. Fills from empty; full = they win. */
  progress: (spec) => makeClock({
    sections: CLOCK_SECTIONS_DEFAULT, ...spec,
    poles: spec?.poles ?? { high: { side: SIDE.PLAYERS, outcome: OUTCOME.SUCCESS, label: spec?.successLabel }, low: null },
  }),

  /** A danger closing in. Fills as the players fail; full = they lose. */
  threat: (spec) => makeClock({
    sections: 4, ...spec,
    poles: spec?.poles ?? { high: { side: SIDE.GM, outcome: OUTCOME.FAILURE, label: spec?.failureLabel }, low: null },
  }),

  /** Players tear something down. Starts full; empty = they win. */
  teardown: (spec) => makeClock({
    sections: CLOCK_SECTIONS_DEFAULT, ...spec,
    poles: spec?.poles ?? { high: null, low: { side: SIDE.PLAYERS, outcome: OUTCOME.SUCCESS, label: spec?.successLabel } },
  }),

  /** Both sides push the same axis. Starts centered unless told otherwise. */
  struggle: (spec) => {
    const sections = int(spec?.sections, 8);
    return makeClock({
      ...spec,
      sections,
      // Centered by default — `makeClock` would otherwise start a two-poled
      // clock at 0, which is the GM already having won.
      value: spec?.value ?? Math.floor(sections / 2),
      poles: spec?.poles ?? {
        high: { side: SIDE.PLAYERS, outcome: OUTCOME.SUCCESS, label: spec?.successLabel },
        low:  { side: SIDE.GM,      outcome: OUTCOME.FAILURE, label: spec?.failureLabel },
      },
    });
  },
});
