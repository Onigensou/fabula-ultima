/**
 * [ONI] Event System — Constants
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-constants.js
 *
 * What this does:
 * - Stores all shared constant values for the Event System in one place
 * - Prevents typo mistakes across multiple scripts
 * - Exposes constants to:
 *   window.oni.EventSystem.Constants
 */

(() => {
  const TAG = "[ONI][EventSystem][Constants]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Constants?.installed) {
    console.log(TAG, "Already installed; skipping.");
    return;
  }

  // ------------------------------------------------------------
  // Core constants
  // ------------------------------------------------------------
  const CONSTANTS = {
    installed: true,

    // -------------------------
    // Module / socket
    // -------------------------
    MODULE_ID: "fabula-ultima-companion",
    SOCKET_CHANNELS: [
      "module.fabula-ultima-companion",
      "fabula-ultima-companion"
    ],

    // -------------------------
    // Flag scope
    // -------------------------
    FLAG_SCOPE: "oni-event-system",

    // -------------------------
    // Socket message types
    // -------------------------
    MSG_EVENT_EXECUTE_REQ: "ONI_EVENT_EXECUTE_REQ_V1",
    MSG_EVENT_EXECUTE_DONE: "ONI_EVENT_EXECUTE_DONE_V1",
    MSG_EVENT_EXECUTE_ERROR: "ONI_EVENT_EXECUTE_ERROR_V1",

    // -------------------------
    // Tile config UI
    // -------------------------
    TAB_ID: "oni-event-config",
    TAB_LABEL: "Event Config",
    TAB_ICON_HTML: `<i class="fas fa-bolt"></i> Event Config`,

    STYLE_ID_CONFIG: "oni-event-config-style",
    STYLE_ID_RUNTIME: "oni-event-runtime-style",
    MARKER_ATTR: "data-oni-event-config",

    // -------------------------
    // Runtime UI overlay
    // -------------------------
    UI_LAYER_ID: "oni-event-ui-layer",
    INTERACT_BUTTON_CLASS: "oni-event-btn",
    INTERACT_BUTTON_TEXT: "!",

    // -------------------------
    // Defaults
    // -------------------------
    DEFAULT_PROXIMITY_PX: 0,
    MIN_PROXIMITY_PX: 0,
    PROXIMITY_STEP_PX: 10,

    POS_OVERRIDE_TTL_MS: 800,
    BUTTON_OFFSET_Y: 32,

    // -------------------------
    // Event types
    // -------------------------
    EVENT_TYPES: {
      SHOW_TEXT: "showText"
    },

    EVENT_TYPE_LABELS: {
      showText: "Show Text"
    },

    // -------------------------
    // Row defaults
    // -------------------------
    DEFAULT_ROW_TYPE: "showText",
    DEFAULT_SHOW_TEXT_SPEAKER: "Self",
    DEFAULT_SHOW_TEXT_MESSAGE: "",

    // -------------------------
    // Special syntax
    // -------------------------
    SPECIAL_SPEAKER_SELF: "Self",

    // -------------------------
    // Debug setting keys
    // These will be used later by event-debug.js
    // -------------------------
    SETTINGS: {
      DEBUG_ENABLED: "eventSystemDebugEnabled",
      DEBUG_VERBOSE: "eventSystemDebugVerbose"
    }
  };

  // ------------------------------------------------------------
  // Helper: generate new event row object
  // Used by Config UI when adding a new row
  // ------------------------------------------------------------
  CONSTANTS.makeDefaultEventRow = function () {
    return {
      id: foundry.utils.randomID(),
      type: CONSTANTS.DEFAULT_ROW_TYPE,
      speaker: CONSTANTS.DEFAULT_SHOW_TEXT_SPEAKER,
      text: CONSTANTS.DEFAULT_SHOW_TEXT_MESSAGE
    };
  };

  // ------------------------------------------------------------
  // Helper: normalize event type
  // ------------------------------------------------------------
  CONSTANTS.normalizeEventType = function (rawType) {
    const s = String(rawType || "").trim();
    if (Object.values(CONSTANTS.EVENT_TYPES).includes(s)) return s;
    return CONSTANTS.DEFAULT_ROW_TYPE;
  };

  // ------------------------------------------------------------
  // Helper: get label from event type
  // ------------------------------------------------------------
  CONSTANTS.getEventTypeLabel = function (type) {
    const key = CONSTANTS.normalizeEventType(type);
    return CONSTANTS.EVENT_TYPE_LABELS[key] || key;
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.Constants = CONSTANTS;

  console.log(TAG, "Installed.", {
    FLAG_SCOPE: CONSTANTS.FLAG_SCOPE,
    EVENT_TYPES: CONSTANTS.EVENT_TYPES
  });
})();
