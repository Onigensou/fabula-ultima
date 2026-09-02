// ============================================================================
// Stealth Mode — constants, flag keys and enums.
//
// Every number in the ruleset is a tunable. The brief was explicit that no
// value is settled, so nothing below is written into logic anywhere else:
// read TUNE.<key> and the table can move without touching a behaviour file.
//
// Three layers of override, most specific winning:
//
//   TUNE defaults  →  world setting "stealthTuning" (JSON)  →  scene flag
//
// The scene layer is what lets one map be authored tighter than another
// without a second code path.
//
// See docs/stealth-mode-design.md.
// ============================================================================

export const MODULE_ID = "fabula-ultima-companion";
export const TAG = "[Stealth]";

/** Scene-mode value that arms this system. Mirrors dungeon-configuration-ui. */
export const SCENE_MODE = "stealth";

/** flags.<MODULE_ID>.oniFabula.general.sceneMode */
export const FABULA_ROOT_KEY = "oniFabula";
export const GENERAL_KEY     = "general";
export const SCENE_MODE_KEY  = "sceneMode";

/** Where the whole runtime lives. One scene flag, so F5 mid-turn survives. */
export const STATE_FLAG = "stealthState";

/** Per-scene authoring: patrol routes, spawn points, cover props, tuning. */
export const CONFIG_FLAG = "stealthConfig";

/** World setting holding a JSON tuning override. */
export const TUNING_SETTING = "stealthTuning";

// ── Alert tiers ─────────────────────────────────────────────────────────────
// Ordered. Index IS the tier number, so raise/lower is index arithmetic.
export const ALERT = Object.freeze({
  STEALTH: "stealth",
  NEUTRAL: "neutral",
  ALERT:   "alert",
});

export const ALERT_ORDER = Object.freeze([ALERT.STEALTH, ALERT.NEUTRAL, ALERT.ALERT]);

/**
 * How a conflict opens, per tier. These map straight onto
 * `battlePlan.engagement`, which the Battle Director already implements
 * (director-combat.js): "advantage" forces the party first on round 1,
 * "ambush" forces the enemies first, "normal" rolls initiative as usual.
 */
export const ALERT_ENGAGEMENT = Object.freeze({
  [ALERT.STEALTH]: "advantage",
  [ALERT.NEUTRAL]: "normal",
  [ALERT.ALERT]:   "ambush",
});

export const ALERT_LABEL = Object.freeze({
  [ALERT.STEALTH]: "Stealth",
  [ALERT.NEUTRAL]: "Neutral",
  [ALERT.ALERT]:   "Alert",
});

export const ALERT_COLOR = Object.freeze({
  [ALERT.STEALTH]: "#4fd1a5",
  [ALERT.NEUTRAL]: "#e8c05a",
  [ALERT.ALERT]:   "#f26b5b",
});

// ── Enemy AI states ─────────────────────────────────────────────────────────
export const AI = Object.freeze({
  PATROL:     "patrol",      // walking a route, or holding a post and sweeping
  SUSPICIOUS: "suspicious",  // turned to face the stimulus, does NOT approach
  SEARCH:     "search",      // pathing to the LAST KNOWN cell, not the real one
  CHASE:      "chase",       // pathing to the true position; Alert tier only
});

export const AI_LABEL = Object.freeze({
  [AI.PATROL]:     "Patrolling",
  [AI.SUSPICIOUS]: "Suspicious",
  [AI.SEARCH]:     "Searching",
  [AI.CHASE]:      "Hunting",
});

// ── Relative position ───────────────────────────────────────────────────────
export const ARC = Object.freeze({ FRONT: "front", FLANK: "flank", REAR: "rear" });

// ── Objective ids ───────────────────────────────────────────────────────────
// Each is a world Item flagged coreAction: "objective:<id>", authored by the
// stealth objective migration. Ids are stable; labels are not.
export const OBJECTIVE = Object.freeze({
  SCAN:        "scan",
  HIDE:        "hide",
  DASH:        "dash",
  TAKEDOWN:    "takedown",
  MOVE_OBJECT: "move_object",
  DIVERSION:   "diversion",
  BREAK_COVER: "break_cover",
  CUSTOM:      "custom",      // already shipping — the roleplay space
});

// ── Tunables ────────────────────────────────────────────────────────────────

export const TUNE_DEFAULTS = Object.freeze({
  // Movement
  partyMove:        5,     // cells per Player Phase
  enemyMove:        5,     // parity with the party, per the brief
  dashBonus:        5,     // extra cells; costs the Objective slot
  enemiesMayDash:   false, // the party's only escape lever at Alert

  // Enemy activation
  activationsPerRound: 3,  // each enemy at most once

  // Perception
  suspicionRadius:  5,     // proximity awareness, cone-independent
  detectionRange:   3,     // automatic spot inside the cone
  visionRange:      8,     // outer limit of the cone
  coneHalfAngle:    45,    // degrees either side of facing → a 90° cone
  flankRangeMult:   0.6,   // sight range multiplier in the flank arc
  coverAwareness:   -2,    // awareness delta when the party stands in cover
  darkAwareness:    -1,    // awareness delta in an unlit cell

  // Awareness thresholds (per enemy)
  suspiciousAt:     2,
  searchAt:         4,
  awarenessMax:     6,
  awarenessDecay:   1,     // per round with no stimulus
  searchPersistence: 3,    // rounds before SEARCH falls back to PATROL
  chaseGiveUp:      2,     // rounds without sight before CHASE drops to SEARCH

  // Alert
  alertRaiseOnSpot:      1,   // tiers gained when the party is spotted outright
  alertDecayRounds:      0,   // 0 = no passive cooling; tension is the point
  hideBaseDl:            10,
  hideDlPerAwareEnemy:   2,
  hideDlPerHelper:       2,   // more bodies means more help AND more to hide
  hideHelperDl:          10,  // RAW: supporting characters roll the standard DL
  hideHelperBonus:       1,   // RAW: +1 to the leader per helper success
  hideAwarenessRelief:   2,   // awareness each guard sheds on a successful hide
  hideCoverBonus:        2,
  noiseAlertChance:      0.35, // chance a Dash/noise event raises a tier

  // Takedown
  takedownBaseDl:     7,
  takedownDlMin:      6,
  takedownDlMax:      16,
  takedownLevelCoef:  0.5,   // DL per level of gap
  takedownRankDl:     { soldier: 0, elite: 3, champion: 6 },
  takedownRearBonus:  2,     // DL reduction from the rear arc
  takedownStealthBonus: 1,   // the brief's flat +1 during Stealth
  takedownExpMult:    0.7,   // ~1.4x slower levelling than fighting
  takedownExpFloor:   0.5,

  // Reinforcements
  reinforcePerRound:  1,
  reinforceMax:       4,

  // Conflict
  conflictJoinRadius: 4,     // cells; which enemies join a triggered fight

  // Presentation
  stepMs:             160,   // per-cell walk tween
  coneAlpha:          0.13,
});

/** Merge order: defaults → world setting → scene flag. */
export function readTuning(scene = null) {
  let out = { ...TUNE_DEFAULTS };

  try {
    const raw = game.settings?.get?.(MODULE_ID, TUNING_SETTING);
    if (raw && typeof raw === "string" && raw.trim()) {
      Object.assign(out, JSON.parse(raw));
    } else if (raw && typeof raw === "object") {
      Object.assign(out, raw);
    }
  } catch (e) {
    console.warn(TAG, "world tuning override is not valid JSON — ignoring:", e);
  }

  try {
    const cfg = scene?.flags?.[MODULE_ID]?.[CONFIG_FLAG];
    if (cfg?.tuning && typeof cfg.tuning === "object") Object.assign(out, cfg.tuning);
  } catch (_) { /* scene override is optional */ }

  return out;
}

// ── Hooks other systems can listen on ───────────────────────────────────────
export const HOOKS = Object.freeze({
  STARTED:       "stealth.started",
  STOPPED:       "stealth.stopped",
  STATE_CHANGED: "stealth.stateChanged",
  ROUND_START:   "stealth.roundStart",
  PHASE_CHANGED: "stealth.phaseChanged",
  ALERT_CHANGED: "stealth.alertChanged",
  PARTY_MOVED:   "stealth.partyMoved",
  ENEMY_SPOTTED: "stealth.enemySpotted",
  TAKEDOWN:      "stealth.takedown",
  CONTACT:       "stealth.contact",
});

/** Socket message types. Namespaced so they cannot collide with DP_/CR_. */
export const MSG = Object.freeze({
  REQUEST:   "SM_REQUEST",    // player → GM: an intent
  STATE:     "SM_STATE",      // GM → all: authoritative state broadcast
  OVERLAY:   "SM_OVERLAY",    // GM → all: transient visual
  NARRATE:   "SM_NARRATE",    // GM → all: narration beat
  BANNER:    "SM_BANNER",     // GM → all: phase announcer flash
  MOTION:    "SM_MOTION",     // GM → all: replay a token glide
});
