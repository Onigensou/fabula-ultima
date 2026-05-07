/**
 * scripts/shared-utils.js
 * ════════════════════════════════════════════════════════════════════════════════
 * Shared utilities for Action Pipeline and related systems
 * 
 * Usage:
 *   const { log, warn, err } = FUCompanion.createLogger("[TAG]");
 *   const { AUTO, PAYLOAD } = FUCompanion.getHeadlessContext();
 *   const actors = FUCompanion.Utilities.dedupe(someArray);
 * 
 * Foundry V12 compatible
 * ════════════════════════════════════════════════════════════════════════════════
 */

(() => {
  // Initialize namespace.
  // NOTE: also seed `.api` so other scripts using the `FUCompanion = FUCompanion || { api: {} }`
  // idiom (db-resolver.js, namecard-*.js, battlelog-clear.js) don't end up with a missing
  // `.api` when shared-utils.js creates the namespace first.
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  
  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGER: Centralized logging with consistent formatting
  // ─────────────────────────────────────────────────────────────────────────────
  
  /**
   * Create a logger with consistent formatting
   * 
   * @param {string} tag - Logger tag (e.g., "[ONI][ActionFetch]")
   * @param {boolean} debug - Enable/disable logging (default: true)
   * @returns {Object} { log, warn, err, tag, debug }
   * 
   * @example
   * const { log, warn, err } = FUCompanion.createLogger("[ONI][MyMacro]");
   * log("Starting macro", { data });
   * if (error) err("Failed:", error);
   */
  FUCompanion.createLogger = function(tag, debug = true) {
    const log  = (...a) => debug && console.log(tag, ...a);
    const warn = (...a) => debug && console.warn(tag, ...a);
    const err  = (...a) => debug && console.error(tag, ...a);
    
    return { log, warn, err, tag, debug };
  };
  
  // ─────────────────────────────────────────────────────────────────────────────
  // NO HEADLESS-CONTEXT HELPER ON PURPOSE
  //
  // It is tempting to wrap this:
  //   let AUTO = false, PAYLOAD = {};
  //   if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }
  //
  // ...into something like FUCompanion.getHeadlessContext(). DO NOT.
  //
  // Foundry V12 passes __AUTO/__PAYLOAD as macro-local parameters when calling
  // macro.execute({ __AUTO, __PAYLOAD, ... }). They exist as identifiers ONLY
  // inside the macro body's lexical scope. A helper defined here lives in this
  // module file's closure — its `typeof __AUTO` always resolves to "undefined",
  // so the helper would silently return an empty payload regardless of what
  // the caller passed. The check has to run inline in each macro.
  // ─────────────────────────────────────────────────────────────────────────────
  
  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITIES: Common string, array, and type operations
  // ─────────────────────────────────────────────────────────────────────────────
  
  FUCompanion.Utilities = {
    /**
     * Normalize any value to trimmed string
     * @param {*} v - Value to convert
     * @param {string} d - Default value if empty
     * @returns {string}
     */
    str: (v, d = "") => {
      const s = (v ?? "").toString().trim();
      return s.length ? s : d;
    },

    /**
     * Normalize to lowercase string
     * @param {*} v - Value to convert
     * @returns {string}
     */
    norm: (v) => {
      const s = (v ?? "").toString().trim();
      return s.length ? s.toLowerCase() : "";
    },

    /**
     * Safe clone of array
     * @param {*} a - Array to clone (or anything)
     * @returns {Array}
     */
    cloneArray: (a) => Array.isArray(a) ? [...a] : [],

    /**
     * Remove duplicates from array
     * @param {Array} list - Array of values
     * @returns {Array} Deduplicated array
     */
    dedupe: (list) => {
      return Array.from(new Set(
        (Array.isArray(list) ? list : []).filter(Boolean).map(String)
      ));
    },

    /**
     * Get unique values from array
     * @param {Array} a - Array of values
     * @returns {Array} Unique values
     */
    uniq: (a) => {
      return [...new Set((Array.isArray(a) ? a : []).filter(Boolean).map(String))];
    },

    /**
     * Coerce value to array
     * @param {*} v - Value to coerce
     * @returns {Array}
     */
    toArray: (v) => {
      if (Array.isArray(v)) return v;
      if (v == null) return [];
      return [v];
    },

    /**
     * Safe number parsing
     * @param {*} v - Value to parse
     * @param {number} d - Default if not a finite number
     * @returns {number}
     */
    numberish: (v, d = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    },

    /**
     * Alias for str() - safe string conversion
     * @param {*} v - Value to convert
     * @param {string} d - Default value if empty
     * @returns {string}
     */
    safeString: (v, d = "") => {
      const s = (v ?? "").toString().trim();
      return s.length ? s : d;
    },

    /**
     * Safely access nested object property
     * @param {Object} obj - Object to access
     * @param {string} path - Dot-notation path (e.g., "meta.costRaw")
     * @param {*} d - Default value
     * @returns {*}
     */
    getPath: (obj, path, d = null) => {
      if (!obj || typeof obj !== "object") return d;
      const parts = String(path).split(".");
      let current = obj;
      for (const part of parts) {
        current = current?.[part];
        if (current === null || current === undefined) return d;
      }
      return current ?? d;
    }
  };
  
  // Convenience shorthand
  FUCompanion.U = FUCompanion.Utilities;
  
  // ─────────────────────────────────────────────────────────────────────────────
  // ACTOR RESOLVER: Unified actor resolution logic
  // ─────────────────────────────────────────────────────────────────────────────
  
  FUCompanion.ActorResolver = {
    /**
     * Get actor from first controlled token
     * @returns {Actor|null}
     */
    fromControlledToken: () => {
      return canvas.tokens?.controlled?.[0]?.actor ?? null;
    },

    /**
     * Get actor from first user target
     * @returns {Actor|null}
     */
    fromUserTarget: () => {
      const targets = Array.from(game.user?.targets ?? []);
      return targets[0]?.actor ?? null;
    },

    /**
     * Get actor from UUID (async)
     * @param {string} uuid - Actor or token UUID
     * @returns {Promise<Actor|null>}
     */
    fromUuid: async (uuid) => {
      if (!uuid) return null;
      try {
        const doc = await fromUuid(uuid);
        if (!doc) return null;
        // Direct actor
        if (doc.documentName === "Actor" || doc.constructor?.name === "Actor") return doc;
        // From token
        if (doc.actor) return doc.actor;
        // Via type check
        if (doc.type === "Actor") return doc;
        return null;
      } catch (e) {
        console.error("[ActorResolver] fromUuid failed:", uuid, e);
        return null;
      }
    },

    /**
     * Resolve actor with fallback chain
     * @param {Object} hint - Resolution hint with optional { uuid, actor }
     * @returns {Promise<Actor|null>}
     */
    resolve: async (hint = {}) => {
      // Hint has direct actor
      if (hint?.actor?.isOwner !== undefined) return hint.actor;
      
      // Try UUID first (most reliable)
      if (hint?.uuid) {
        const actor = await FUCompanion.ActorResolver.fromUuid(hint.uuid);
        if (actor) return actor;
      }
      
      // Fall back to UI selection
      const fromControl = FUCompanion.ActorResolver.fromControlledToken();
      if (fromControl) return fromControl;
      
      const fromTarget = FUCompanion.ActorResolver.fromUserTarget();
      if (fromTarget) return fromTarget;
      
      return null;
    }
  };
  
  // ─────────────────────────────────────────────────────────────────────────────
  // ERROR RESPONSE: Standardized error/success responses
  // ─────────────────────────────────────────────────────────────────────────────
  
  FUCompanion.ErrorResponse = {
    /**
     * Create success response
     * @param {*} data - Optional data to return
     * @returns {Object} { ok: true, data }
     */
    ok: (data = null) => ({ ok: true, data }),

    /**
     * Create error response
     * @param {string} reason - Machine-readable reason code
     * @param {*} details - Optional detailed error info
     * @param {string} userMessage - Optional user-facing message
     * @returns {Object} { ok: false, reason, details, userMessage }
     */
    err: (reason, details = null, userMessage = null) => ({
      ok: false,
      reason,
      details,
      userMessage
    }),

    /**
     * Notify user and create error response
     * @param {string} reason - Machine-readable reason code
     * @param {string} userMessage - User-facing notification message
     * @param {*} details - Optional detailed error info
     * @returns {Object} { ok: false, reason, details, userMessage }
     */
    notifyAndErr: (reason, userMessage = "An error occurred", details = null) => {
      ui.notifications?.error?.(userMessage);
      return FUCompanion.ErrorResponse.err(reason, details, userMessage);
    },

    /**
     * Create warning response (not an error, but noteworthy)
     * @param {string} reason - Machine-readable reason code
     * @param {string} userMessage - User-facing message
     * @returns {Object} { ok: true, isWarning: true, reason, userMessage }
     */
    warn: (reason, userMessage = null) => {
      if (userMessage) ui.notifications?.warn?.(userMessage);
      return { ok: true, isWarning: true, reason, userMessage };
    }
  };
  
  // ─────────────────────────────────────────────────────────────────────────────
  // PAYLOAD HELPERS: Canonical payload field accessors
  // ─────────────────────────────────────────────────────────────────────────────
  
  FUCompanion.Payload = {
    /**
     * Get all target UUIDs from payload with fallback chain.
     * Empty arrays fall through to the next source (matches legacy ResourceGate behavior).
     * @param {Object} payload - Action payload
     * @returns {Array<string>}
     */
    getTargets: (payload = {}) => {
      const a = payload.originalTargetUUIDs;
      if (Array.isArray(a) && a.length) return a;
      const b = payload.meta?.originalTargetUUIDs;
      if (Array.isArray(b) && b.length) return b;
      const c = payload.targets;
      if (Array.isArray(c) && c.length) return c;
      return [];
    },

    /**
     * Get attacker UUID with fallback chain
     * @param {Object} payload - Action payload
     * @returns {string|null}
     */
    getAttackerUuid: (payload = {}) => {
      const U = FUCompanion.Utilities;
      return U.str(
        payload.meta?.attackerUuid ?? 
        payload.attackerUuid ?? 
        payload.attackerActorUuid ?? 
        ""
      ) || null;
    },

    /**
     * Get action cost with priority: costRawFinal → costRawOverride → costRaw
     * @param {Object} payload - Action payload
     * @returns {string}
     */
    getCost: (payload = {}) => {
      const meta = payload.meta || {};
      return FUCompanion.Utilities.str(
        meta.costRawFinal ?? 
        meta.costRawOverride ?? 
        meta.costRaw ?? 
        ""
      );
    },

    /**
     * Check if execution is passive (auto passive or reactive)
     * @param {Object} payload - Action payload
     * @returns {boolean}
     */
    isPassiveExecution: (payload = {}) => {
      const meta = payload.meta || {};
      const exec = FUCompanion.Utilities.norm(meta.executionMode);
      return (
        exec === "autopassive" ||
        meta.isPassiveExecution === true ||
        payload.autoPassive === true
      );
    },

    /**
     * Get skill/action name
     * @param {Object} payload - Action payload
     * @returns {string}
     */
    getSkillName: (payload = {}) => {
      const U = FUCompanion.Utilities;
      return U.str(
        payload.core?.skillName ??
        payload.dataCore?.skillName ??
        payload.meta?.skillName ??
        payload.skillName ??
        "Unnamed Action"
      );
    }
  };
  
  console.log("[FUCompanion] Shared utilities loaded successfully");
})();
