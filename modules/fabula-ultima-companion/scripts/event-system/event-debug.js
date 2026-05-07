/**
 * [ONI] Event System — Debug
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-debug.js
 *
 * What this does:
 * - Registers Foundry settings for Event System debug toggles
 * - Provides shared log / warn / error helpers
 * - Keeps debug behavior centralized so all Event scripts stay clean
 * - Exposes helpers to:
 *   window.oni.EventSystem.Debug
 *
 * Requires:
 * - event-constants.js loaded first
 */

(() => {
  const TAG = "[ONI][EventSystem][Debug]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Debug?.installed) {
    console.log(TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  if (!C) {
    console.error(TAG, "Missing Constants. Make sure event-constants.js loads before event-debug.js");
    return;
  }

  const MODULE_ID = C.MODULE_ID;
  const SETTING_KEYS = C.SETTINGS || {};

  // ------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------
  function safeGetSetting(key, fallback = false) {
    try {
      if (!game?.settings) return fallback;
      return game.settings.get(MODULE_ID, key);
    } catch (_) {
      return fallback;
    }
  }

  function buildPrefix(scope = "General") {
    return `[ONI][EventSystem][${scope}]`;
  }

  function shouldLog(scope = null) {
    return !!safeGetSetting(SETTING_KEYS.DEBUG_ENABLED, false);
  }

  function shouldVerbose(scope = null) {
    if (!shouldLog(scope)) return false;
    return !!safeGetSetting(SETTING_KEYS.DEBUG_VERBOSE, false);
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------
  const Debug = {
    installed: true,

    get enabled() {
      return shouldLog();
    },

    get verbose() {
      return shouldVerbose();
    },

    isEnabled() {
      return shouldLog();
    },

    isVerbose() {
      return shouldVerbose();
    },

    log(scope, ...args) {
      if (!shouldLog(scope)) return;
      console.log(buildPrefix(scope), ...args);
    },

    verboseLog(scope, ...args) {
      if (!shouldVerbose(scope)) return;
      console.log(buildPrefix(scope), ...args);
    },

    warn(scope, ...args) {
      if (!shouldLog(scope)) return;
      console.warn(buildPrefix(scope), ...args);
    },

    error(scope, ...args) {
      console.error(buildPrefix(scope), ...args);
    },

    group(scope, label, collapsed = true) {
      if (!shouldLog(scope)) return false;
      const prefix = buildPrefix(scope);
      if (collapsed) console.groupCollapsed(prefix, label);
      else console.group(prefix, label);
      return true;
    },

    groupEnd() {
      try {
        console.groupEnd();
      } catch (_) {}
    },

    dumpSettings() {
      const dump = {
        moduleId: MODULE_ID,
        debugEnabled: safeGetSetting(SETTING_KEYS.DEBUG_ENABLED, false),
        debugVerbose: safeGetSetting(SETTING_KEYS.DEBUG_VERBOSE, false)
      };

      console.log(buildPrefix("Debug"), "Current settings:", dump);
      return dump;
    }
  };

  // ------------------------------------------------------------
  // Register settings
  // ------------------------------------------------------------
  Hooks.once("init", () => {
    try {
      game.settings.register(MODULE_ID, SETTING_KEYS.DEBUG_ENABLED, {
        name: "Event System Debug",
        hint: "Enable console logging for the Event System.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
      });

      game.settings.register(MODULE_ID, SETTING_KEYS.DEBUG_VERBOSE, {
        name: "Event System Verbose Debug",
        hint: "Enable extra detailed Event System console logging.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
      });

      console.log(TAG, "Debug settings registered.", {
        moduleId: MODULE_ID,
        debugEnabledKey: SETTING_KEYS.DEBUG_ENABLED,
        debugVerboseKey: SETTING_KEYS.DEBUG_VERBOSE
      });
    } catch (e) {
      console.error(TAG, "Failed to register debug settings:", e);
    }
  });

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.Debug = Debug;

  console.log(TAG, "Installed.");
})();
