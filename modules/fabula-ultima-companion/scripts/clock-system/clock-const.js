// ============================================================================
// Clock System — Constants & enums
//
// A Clock is a bounded integer axis with a pole at each end (see
// docs/clock-system-design.md). One structure covers every Fabula Ultima clock
// shape: progress clocks, threat clocks, erase-to-win clocks, and two-sided
// struggles. Which shape you get depends entirely on which poles are claimed:
//
//   progress   sections 6, value 0,        poles.high = players/success
//   threat     sections 4, value 0,        poles.high = gm/failure
//   teardown   sections 6, value 6,        poles.low  = players/success
//   struggle   sections 8, value 4,        poles.high = players/success
//                                          poles.low  = gm/failure
//
// An unclaimed pole clamps: the value stops there and nothing resolves.
//
// This file holds only constants and enums. No DOM, no socket wiring, no
// Foundry globals — clock-model.js imports it and must stay pure.
// ============================================================================

export const CLOCK_MODULE_ID = "fabula-ultima-companion";
export const CLOCK_TAG = "[FU][Clock]";

// World setting holding the whole registry: { [clockId]: Clock }.
// World-scoped so a player who drops and reconnects re-reads live state on
// `ready` with no special handling — that reconnect safety is precisely why
// clocks live in a setting rather than in memory.
export const CLOCK_SETTING = "clockRegistry";

// Raw-socket channel + envelope topics (player → active GM). Mirrors the
// proven request/response pattern in healing-socket.js. Consumed in phase 4.
export const CLOCK_CHANNEL = `module.${CLOCK_MODULE_ID}`;
export const CLOCK_SOCKET = Object.freeze({
  REQ: "clock.mutate.req",
  RES: "clock.mutate.res",
});

// ── Hook names — the decoupling seam ────────────────────────────────────────
// The default UI is just the first subscriber to these. A downstream system
// that wants its own clock UI ignores our renderer and listens to the same
// events. The API never imports the UI; the UI imports the API.
export const CLOCK_HOOK = Object.freeze({
  CREATED:  "fu-clock-created",
  CHANGED:  "fu-clock-changed",    // { clock, delta, cause, previous }
  RESOLVED: "fu-clock-resolved",   // { clock, resolution }
  DISCARDED:"fu-clock-discarded",
  // Emitted from Battle Director's firePassiveTriggers (phase 7). Named for
  // the director rather than for clocks: any subsystem may observe it.
  DIRECTOR_TRIGGER: "fu-director-trigger",
});

// ── The two sides ───────────────────────────────────────────────────────────
// Deliberately two, not N. In-fiction a scene can have three factions, but
// mechanically everything reduces to what the players want and what the GM
// wants; a third interest gets its own clock.
export const SIDE = Object.freeze({
  PLAYERS: "players",
  GM: "gm",
});

export const POLE = Object.freeze({
  HIGH: "high",   // value === sections
  LOW:  "low",    // value === 0
});

// What reaching a pole means for the PLAYERS. A threat clock's high pole is a
// `failure` owned by the GM; a teardown clock's low pole is a `success` owned
// by the players.
export const OUTCOME = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
});

export const CLOCK_STATE = Object.freeze({
  ACTIVE: "active",
  RESOLVED: "resolved",
  DISCARDED: "discarded",
});

// ── Lifecycle — when a clock is swept ───────────────────────────────────────
// Reconnect survival and session persistence are different axes. The world
// setting gives us the former for free; `lifecycle` prevents the latter from
// becoming a cleanup burden.
export const LIFECYCLE = Object.freeze({
  MANUAL: "manual",   // persists until the GM discards it (world-map trackers)
  COMBAT: "combat",   // auto-discarded when the Battle Director stops
  SCENE:  "scene",    // auto-discarded on scene change
});

// ── Group modes ─────────────────────────────────────────────────────────────
//   independent — grouped for display only.
//   race        — first sibling to resolve wins; the rest are discarded.
//                 (RAW: the Bertrand vs. Duma duel, six sections each.)
//   paired      — one applyCheck fans out across the pair: a passed check
//                 advances the `primary` clock, a failed one advances the
//                 `failure` clock. (RAW p.54, "A Threshold For Failure".)
export const GROUP_MODE = Object.freeze({
  INDEPENDENT: "independent",
  RACE: "race",
  PAIRED: "paired",
});

// Role within a `paired` group. Ignored by the other modes.
export const GROUP_ROLE = Object.freeze({
  PRIMARY: "primary",
  FAILURE: "failure",
});

export const VISIBILITY = Object.freeze({
  ALL: "all",   // RAW: clocks "should be visible to everyone"
  GM:  "gm",
});

// Rolling per-clock ledger cap. The world is close to its payload ceiling, so
// history is bounded; the full registry stays in the tens of KB.
export const CLOCK_HISTORY_MAX = 50;

// RAW defaults. "A Clock normally features four to twelve sections."
export const CLOCK_SECTIONS_DEFAULT = 6;
export const CLOCK_SECTIONS_MIN = 1;
export const CLOCK_SECTIONS_MAX = 24;   // beyond RAW, but the axis doesn't care

// ── Check-advancement thresholds (RAW p.53) ─────────────────────────────────
// "Fill an additional section if the Result surpassed the Difficulty Level by
//  3 or more, or two additional sections if it was by 6 or more."
export const MARGIN_TIER_1 = 3;   // +1 section
export const MARGIN_TIER_2 = 6;   // +2 sections (instead of +1)

// "If the Check was a critical success, the corresponding opportunity may be
//  spent to fill two additional sections." Same for a fumble on a threat clock.
// `may be spent` — the engine never spends it silently; the caller opts in.
export const OPPORTUNITY_SECTIONS = 2;

// "The Game Master ... are free to fill or erase one section, or two sections
//  for a major event." Sugar for the manual/automated non-check path.
export const EVENT_SECTIONS_MINOR = 1;
export const EVENT_SECTIONS_MAJOR = 2;
