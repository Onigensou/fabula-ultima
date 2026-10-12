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
 * An action registers ONCE, here, and brings everything it needs:
 *   type, label, category   what it is and where it sits in the dropdown
 *   defaultData             the fields of a new row
 *   execute(row, context)   run it on the GM (context.runRows runs a child list)
 *   buildFields(row, kit)   its fields in the Event Config window
 *   collectFields(el, kit)  read those fields back into a row
 *   childLists(row)         [{ label, rows }] for rows that own other rows
 *   prepare(row)            repair the shape of a saved row
 *   summary(row)            one short line for the GM status chip
 *   critical                a failure ends the event (text); otherwise the
 *                           row is passed over and the event carries on
 *
 * Exposes API to:
 *   window.oni.EventSystem.EventRegistry
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-logic.js
 * - event-configKit.js
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
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const Logic = window.oni.EventSystem.Logic;
  const ShowTextExecute = window.oni.EventSystem.ShowText?.Execute;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!Logic) {
    console.error(INSTALL_TAG, "Missing Logic. Load event-logic.js first.");
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
      ...def,
      defaultData: foundry.utils.deepClone(def.defaultData ?? {})
    };
  }

  function optionalFn(value) {
    return typeof value === "function" ? value : null;
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
      const type = stringOrEmpty(definition.type);
      const label = stringOrEmpty(definition.label) || type;

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
        critical: definition.critical === true,
        defaultData: foundry.utils.deepClone(definition.defaultData ?? {}),
        execute: definition.execute,
        buildFields: optionalFn(definition.buildFields),
        collectFields: optionalFn(definition.collectFields),
        childLists: optionalFn(definition.childLists),
        prepare: optionalFn(definition.prepare),
        summary: optionalFn(definition.summary)
      };

      // Make the type known to the constants, so nothing else has to list it.
      C.registerEventType?.(type, label);

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

    // The live definition, not a copy. For callers that only read it.
    peek(rawType) {
      return _definitions.get(normalizeType(rawType)) ?? null;
    },

    getAll() {
      return Array.from(_definitions.values()).map(cloneDefinition);
    },

    getDropdownOptions() {
      return this.getAll().map(def => ({
        value: def.type,
        label: def.label,
        category: def.category
      }));
    },

    // Rows as stored on a tile or token -> rows safe to run or edit. A row
    // whose type is not registered is kept as written.
    normalizeRows(rawRows) {
      return Logic.normalizeRows(rawRows, (type) => _definitions.get(type) ?? null);
    },

    // Visit every row, children included. fn(row, depth).
    walkRows(rows, fn) {
      return Logic.walkRows(rows, (type) => _definitions.get(type) ?? null, fn);
    },

    makeDefaultRow(rawType = null) {
      const type = normalizeType(rawType || C.DEFAULT_ROW_TYPE);
      const def = _definitions.get(type);

      // Only the fields the action declares: a Wait row carries no speaker.
      const baseRow = { id: foundry.utils.randomID(), type };

      if (!def) {
        DBG.warn(DEBUG_SCOPE, "makeDefaultRow() requested unknown type. Returning base row.", {
          requestedType: rawType,
          normalizedType: type
        });
        return baseRow;
      }

      const merged = foundry.utils.mergeObject(
        baseRow,
        foundry.utils.deepClone(def.defaultData ?? {}),
        { inplace: false, overwrite: true }
      );

      merged.id = baseRow.id;
      merged.type = def.type;
      def.prepare?.(merged);

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
  const SHOW_TEXT = C.EVENT_TYPES?.SHOW_TEXT || "showText";
  const DEFAULT_SPEAKER = C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF || "Self";

  EventRegistry.register({
    type: SHOW_TEXT,
    label: C.EVENT_TYPE_LABELS?.showText || "Show Text",
    category: "Dialogue",
    supportsSequentialWait: true,
    critical: true,
    defaultData: {
      type: SHOW_TEXT,
      speaker: DEFAULT_SPEAKER,
      text: C.DEFAULT_SHOW_TEXT_MESSAGE || ""
    },
    execute: async (row, context) => {
      return ShowTextExecute.execute(row, context);
    },
    summary: (row) => String(row?.text ?? "").replace(/<\/?b>/gi, "").slice(0, 40),
    buildFields: (row, kit) => kit.fields(
      kit.field(
        "Speaker",
        `<input type="text" class="oni-event-row-speaker"
           value="${kit.escapeHTML(String(row.speaker ?? DEFAULT_SPEAKER))}"
           placeholder="Self / This / Actor UUID / Token UUID / Name" />`,
        `Leave blank for <b>Self</b> (the party). <b>This</b> = the token carrying this event.
         You can also use Actor UUID, Token UUID, or a name.`
      ),
      kit.field(
        "Message",
        `<textarea class="oni-event-row-text oni-event-textarea"
           placeholder="Write the dialog text here...">${kit.escapeHTML(String(row.text ?? ""))}</textarea>`,
        `Wrap a word in <code>&lt;b&gt;…&lt;/b&gt;</code> to highlight it as a hint (bold + colour).
         <code>{var:name}</code> prints a variable.`
      )
    ),
    collectFields: (rowEl, kit) => ({
      speaker: String(kit.own(rowEl, ".oni-event-row-speaker")?.value ?? "").trim() || DEFAULT_SPEAKER,
      text: String(kit.own(rowEl, ".oni-event-row-text")?.value ?? "")
    })
  });

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.EventRegistry = EventRegistry;

  console.debug(INSTALL_TAG, "Installed.", {
    registeredTypes: EventRegistry.getDropdownOptions()
  });
})();
