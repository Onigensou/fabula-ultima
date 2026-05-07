// ============================================
// JRPG Targeting System - Constants
// File: jrpg-targeting-constants.js
// Foundry VTT V12
// ============================================

export const JRPG_TARGETING = Object.freeze({
  MODULE_ID: "fabula-ultima-companion",

  // User requested socket name: "fabula-ultima-companion"
  // For Foundry game.socket usage, we also keep the module channel ready.
  SOCKET: Object.freeze({
    NAMESPACE: "fabula-ultima-companion",
    CHANNEL: "module.fabula-ultima-companion",
    EVENTS: Object.freeze({
      START_TARGETING: "JRPG_TARGETING_START",
      CONFIRM_TARGETING: "JRPG_TARGETING_CONFIRM",
      CANCEL_TARGETING: "JRPG_TARGETING_CANCEL",
      FORCE_CLOSE: "JRPG_TARGETING_FORCE_CLOSE",
      UI_SHOW: "JRPG_TARGETING_UI_SHOW",
      UI_HIDE: "JRPG_TARGETING_UI_HIDE"
    })
  }),

  DEBUG: Object.freeze({
    ENABLED: true,
    PREFIX: "[ONI][JRPGTargeting]"
  }),

  GLOBALS: Object.freeze({
    API_KEY: "__ONI_JRPG_TARGETING_API__",
    ACTIVE_SESSION_KEY: "__ONI_JRPG_TARGETING_ACTIVE_SESSION__",
    STORE_KEY: "__ONI_JRPG_TARGETING_STORE__",
    UI_STATE_KEY: "__ONI_JRPG_TARGETING_UI__",
    HIGHLIGHT_STATE_KEY: "__ONI_JRPG_TARGETING_HIGHLIGHT__"
  }),

  FLAGS: Object.freeze({
    LAST_RESULT: "jrpgTargetingLastResult"
  }),

  ACTION_KEYS: Object.freeze({
    SKILL_TARGET: "skill_target"
  }),

  UI: Object.freeze({
    IDS: Object.freeze({
      STYLE: "oni-jrpg-target-style",
      TOP_WRAP: "oni-jrpg-target-top",
      CONTROLS: "oni-jrpg-target-controls",
      COUNT: "oni-jrpg-target-count",
      TITLE: "oni-jrpg-target-title",
      CONFIRM: "oni-jrpg-target-confirm",
      CANCEL: "oni-jrpg-target-cancel"
    }),

    CLASSES: Object.freeze({
      RESET: "oni-jrpg-target-reset",
      FLOATING: "oni-jrpg-target-floating",
      CARD: "oni-jrpg-target-card",
      TOP_INNER: "oni-jrpg-target-top-inner",
      CONTROLS_ROW: "oni-jrpg-target-controls-row",
      BUTTON: "oni-jrpg-target-button",
      CONFIRM: "oni-jrpg-target-button-confirm",
      CANCEL: "oni-jrpg-target-button-cancel",
      COUNT: "oni-jrpg-target-count",
      TITLE: "oni-jrpg-target-title"
    }),

    TEXT: Object.freeze({
      DEFAULT_TITLE: "Please select a target",
      DEFAULT_COUNT_ZERO: "0 targets selected",
      CONFIRM: "Confirm",
      CANCEL: "Cancel"
    }),

    // Seeded from your UI tuner defaults.
    TUNING: Object.freeze({
      topX: null, // null = centered by UI script
      topY: 14,
      controlsX: null, // null = UI script computes right-side default
      controlsY: null, // null = UI script computes bottom-side default

      topWidth: 340,
      topScale: 1,
      controlsScale: 1,
      controlsGap: 10,

      spawnMs: 220,
      despawnMs: 180,
      idlePx: 3,
      idleMs: 1800,
      idleEnabled: true,

      zIndexTop: 100000,
      zIndexControls: 100000
    })
  }),

  // Targeting-mode dim/highlight tuning.
  HIGHLIGHT: Object.freeze({
    enabled: true,

    // Non-eligible tokens
    tokenDimEnabled: true,
    tokenDimBrightness: 0.35,
    tokenDesaturate: true,

    // Scene background
    backgroundDimEnabled: true,
    backgroundBrightness: 0.5,

    // Safety behavior
    alwaysKeepSourceVisible: true
  }),

MODES: Object.freeze({
  NONE: "none",
  FREE: "free",
  EXACT: "exact",
  UP_TO: "up_to",
  ALL: "all",
  SELF: "self"
}),

  TARGET_CATEGORIES: Object.freeze({
    CREATURE: "creature",
    ALLY: "ally",
    ENEMY: "enemy"
  }),

  DISPOSITIONS: Object.freeze({
    FRIENDLY: 1,
    NEUTRAL: 0,
    HOSTILE: -1,
    SECRET: -2
  }),

  // Legality rules requested by you.
  ALLOWED_DISPOSITIONS: Object.freeze({
    creature: Object.freeze([1, 0, -1, -2]),
    ally: Object.freeze([1, 0, -2]),
    enemy: Object.freeze([-1, 0, -2])
  }),

  WORDS: Object.freeze({
    NONE: Object.freeze(["-", "none", "nothing"]),
    ALL: Object.freeze(["all"]),
    SELF: Object.freeze(["self"]),
    UP_TO: Object.freeze(["up to", "upto"]),
    CREATURE: Object.freeze(["creature", "creatures"]),
    ALLY: Object.freeze(["ally", "allies"]),
    ENEMY: Object.freeze(["enemy", "enemies"])
  }),

  NUMBER_WORDS: Object.freeze({
    "0": 0,
    zero: 0,

    "1": 1,
    one: 1,

    "2": 2,
    two: 2,

    "3": 3,
    three: 3,

    "4": 4,
    four: 4,

    "5": 5,
    five: 5,

    "6": 6,
    six: 6,

    "7": 7,
    seven: 7,

    "8": 8,
    eight: 8,

    "9": 9,
    nine: 9,

    "10": 10,
    ten: 10,

    "11": 11,
    eleven: 11,

    "12": 12,
    twelve: 12
  }),

  PARSER: Object.freeze({
    NORMALIZE_REGEX: Object.freeze({
      MULTISPACE: /\s+/g,
      NON_ALNUM_KEEP_SPACE: /[^a-z0-9\s-]/gi
    }),

    // Examples this should support later:
    // "Self"
    // "One Creature"
    // "2 Creatures"
    // "Up to three ally"
    // "All Enemy"
    REGEX: Object.freeze({
      SELF: /^self$/i,
      UP_TO: /^up\s*to\s+([a-z0-9-]+)\s+(creature|creatures|ally|allies|enemy|enemies)$/i,
      EXACT: /^([a-z0-9-]+)\s+(creature|creatures|ally|allies|enemy|enemies)$/i,
      ALL: /^all\s+(creature|creatures|ally|allies|enemy|enemies)$/i
    })
  }),

  NOTIFICATIONS: Object.freeze({
    LIMIT_EXCEEDED: "Target limit exceeded. Expected {max} targets.",
    EXACT_REQUIRED: "This action requires exactly {required} targets.",
    INVALID_TARGET_TYPE: "Invalid target. This action can only target {category}.",
    NO_VALID_TARGETS: "No valid {category} targets found.",
    TARGETING_CANCELLED: "Targeting cancelled.",
    TARGETING_CONFIRMED: "Targeting confirmed.",
    TARGETING_ENDED: "Targeting mode ended.",
    ACTIVE_SESSION_EXISTS: "A targeting session is already active.",
    USER_MISMATCH: "You are not the active targeting user."
  }),

  RESULT_STATUS: Object.freeze({
    CONFIRMED: "confirmed",
    CANCELLED: "cancelled"
  })
});

export const {
  MODULE_ID,
  SOCKET,
  DEBUG,
  GLOBALS,
  FLAGS,
  ACTION_KEYS,
  UI,
  HIGHLIGHT,
  MODES,
  TARGET_CATEGORIES,
  DISPOSITIONS,
  ALLOWED_DISPOSITIONS,
  WORDS,
  NUMBER_WORDS,
  PARSER,
  NOTIFICATIONS,
  RESULT_STATUS
} = JRPG_TARGETING;

export default JRPG_TARGETING;
