/**
 * [ONI] Event System — Event Registry
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-eventRegistry.js
 *
 * What this does:
 * - Registers available Event System event types
 * - Provides dropdown-friendly event definitions for Config UI
 * - Resolves which executor should run for a given event row
 * - Keeps event type wiring centralized for easier expansion later
 *
 * Exposes API to:
 *   window.oni.EventSystem.EventRegistry
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-showText-execute.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][EventRegistry]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.EventRegistry?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const ShowTextExecute = window.oni.EventSystem.ShowText?.Execute;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!ShowTextExecute) {
    console.error(INSTALL_TAG, "Missing ShowText Execute. Load event-showText-execute.js first.");
    return;
  }

  const DEBUG_SCOPE = "EventRegistry";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args)
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Internal storage
  // ------------------------------------------------------------
  const _definitions = new Map();

  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function normalizeType(rawType) {
    if (typeof C.normalizeEventType === "function") {
      return C.normalizeEventType(rawType);
    }
    return stringOrEmpty(rawType) || C.DEFAULT_ROW_TYPE;
  }

  function cloneDefinition(def) {
    return {
      type: def.type,
      label: def.label,
      category: def.category ?? "General",
      supportsSequentialWait: def.supportsSequentialWait !== false,
      defaultData: foundry.utils.deepClone(def.defaultData ?? {}),
      execute: def.execute
    };
  }

  function buildUnknownResult(type) {
    return {
      ok: false,
      reason: "unknownEventType",
      type,
      message: `No event executor is registered for type: ${type}`
    };
  }

  // ------------------------------------------------------------
  // Registry API
  // ------------------------------------------------------------
  const EventRegistry = {
    installed: true,

    register(definition = {}) {
      const type = normalizeType(definition.type);
      const label =
        stringOrEmpty(definition.label) ||
        (typeof C.getEventTypeLabel === "function" ? C.getEventTypeLabel(type) : type);

      if (!type) {
        DBG.error(DEBUG_SCOPE, "register() failed: missing type.", definition);
        return false;
      }

      if (typeof definition.execute !== "function") {
        DBG.error(DEBUG_SCOPE, "register() failed: execute must be a function.", {
          type,
          definition
        });
        return false;
      }

      const normalized = {
        type,
        label,
        category: stringOrEmpty(definition.category) || "General",
        supportsSequentialWait: definition.supportsSequentialWait !== false,
        defaultData: foundry.utils.deepClone(definition.defaultData ?? {}),
        execute: definition.execute
      };

      _definitions.set(type, normalized);

      DBG.log(DEBUG_SCOPE, "Registered event type.", {
        type: normalized.type,
        label: normalized.label,
        category: normalized.category
      });

      return true;
    },

    unregister(rawType) {
      const type = normalizeType(rawType);
      const removed = _definitions.delete(type);

      DBG.log(DEBUG_SCOPE, "Unregister event type.", {
        type,
        removed
      });

      return removed;
    },

    has(rawType) {
      const type = normalizeType(rawType);
      return _definitions.has(type);
    },

    get(rawType) {
      const type = normalizeType(rawType);
      const def = _definitions.get(type);
      return def ? cloneDefinition(def) : null;
    },

    getAll() {
      return Array.from(_definitions.values()).map(cloneDefinition);
    },

    getDropdownOptions() {
      return this.getAll().map(def => ({
        value: def.type,
        label: def.label
      }));
    },

    makeDefaultRow(rawType = null) {
      const type = normalizeType(rawType || C.DEFAULT_ROW_TYPE);
      const def = _definitions.get(type);

      const baseRow =
        typeof C.makeDefaultEventRow === "function"
          ? C.makeDefaultEventRow()
          : {
              id: foundry.utils.randomID(),
              type,
              speaker: C.DEFAULT_SHOW_TEXT_SPEAKER,
              text: C.DEFAULT_SHOW_TEXT_MESSAGE
            };

      if (!def) {
        DBG.warn(DEBUG_SCOPE, "makeDefaultRow() requested unknown type. Returning base row.", {
          requestedType: rawType,
          normalizedType: type
        });
        baseRow.type = type;
        return baseRow;
      }

      const merged = foundry.utils.mergeObject(
        baseRow,
        foundry.utils.deepClone(def.defaultData ?? {}),
        { inplace: false, overwrite: true }
      );

      merged.id = baseRow.id;
      merged.type = def.type;

      DBG.verboseLog(DEBUG_SCOPE, "Built default row.", {
        requestedType: rawType,
        normalizedType: type,
        merged
      });

      return merged;
    },

    async executeRow(rawRow = {}, context = {}) {
      const rowType = normalizeType(rawRow?.type);
      const def = _definitions.get(rowType);

      if (!def) {
        const result = buildUnknownResult(rowType);
        DBG.warn(DEBUG_SCOPE, "executeRow() failed: unknown type.", result);
        return result;
      }

      DBG.group?.(DEBUG_SCOPE, `Execute Row [${rowType}]`, true);
      DBG.log(DEBUG_SCOPE, "Executing event row.", {
        rowId: rawRow?.id ?? null,
        type: rowType,
        label: def.label
      });
      DBG.verboseLog(DEBUG_SCOPE, "Row payload:", rawRow);
      DBG.verboseLog(DEBUG_SCOPE, "Execution context:", context);

      try {
        const result = await def.execute(rawRow, context);

        DBG.log(DEBUG_SCOPE, "Event row finished.", {
          rowId: rawRow?.id ?? null,
          type: rowType,
          ok: !!result?.ok
        });

        return result;
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Event row executor threw an error.", {
          rowId: rawRow?.id ?? null,
          type: rowType,
          error: e
        });

        return {
          ok: false,
          reason: "executorError",
          type: rowType,
          rowId: rawRow?.id ?? null,
          error: e
        };
      } finally {
        DBG.groupEnd?.();
      }
    }
  };

  // ------------------------------------------------------------
  // Register built-in event types
  // ------------------------------------------------------------
  EventRegistry.register({
    type: C.EVENT_TYPES?.SHOW_TEXT || "showText",
    label: C.EVENT_TYPE_LABELS?.showText || "Show Text",
    category: "Dialogue",
    supportsSequentialWait: true,
    defaultData: {
      type: C.EVENT_TYPES?.SHOW_TEXT || "showText",
      speaker: C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF || "Self",
      text: C.DEFAULT_SHOW_TEXT_MESSAGE || ""
    },
    execute: async (row, context) => {
      return ShowTextExecute.execute(row, context);
    }
  });

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.EventRegistry = EventRegistry;

  console.log(INSTALL_TAG, "Installed.", {
    registeredTypes: EventRegistry.getDropdownOptions()
  });
})();
