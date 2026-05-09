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
  // LOGGER: Centralized logging with level + per-tag override support
  //
  // Levels:  silent(0) < error(1) < warn(2) < info(3) < debug(4)
  //   log()/info() emit at info; debug() at debug; warn()/err()/error() as named.
  //
  // Sources of the active level (highest priority first):
  //   1. Per-tag override map (game.settings "logTags" JSON, substring match,
  //      longest matching key wins)
  //   2. Global level (game.settings "logLevel")
  //   3. Pre-init fallback constant DEFAULT_LEVEL
  //
  // Legacy 2-arg form `createLogger(tag, false)` still suppresses everything
  // unconditionally for callers that want a hard kill switch.
  // ─────────────────────────────────────────────────────────────────────────────

  const MODULE_ID = "fabula-ultima-companion";
  const LOG_LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });
  const DEFAULT_LEVEL = "info";

  let _cachedLevel = null;
  let _cachedTagOverrides = null;

  function _readGlobalLevel() {
    if (_cachedLevel !== null) return _cachedLevel;
    if (typeof game === "undefined" || !game?.settings) return DEFAULT_LEVEL;
    try {
      _cachedLevel = game.settings.get(MODULE_ID, "logLevel") || DEFAULT_LEVEL;
    } catch {
      // Settings not registered yet (called inside Hooks.once("init") before our register runs).
      return DEFAULT_LEVEL;
    }
    return _cachedLevel;
  }

  function _readTagOverrides() {
    if (_cachedTagOverrides !== null) return _cachedTagOverrides;
    if (typeof game === "undefined" || !game?.settings) return {};
    try {
      const raw = game.settings.get(MODULE_ID, "logTags");
      _cachedTagOverrides = raw ? (JSON.parse(raw) ?? {}) : {};
    } catch {
      _cachedTagOverrides = {};
    }
    return _cachedTagOverrides;
  }

  function _resolveLevelFor(tag) {
    const overrides = _readTagOverrides();
    let bestKey = null;
    for (const key of Object.keys(overrides)) {
      if (!key) continue;
      if (tag.includes(key) && (bestKey === null || key.length > bestKey.length)) bestKey = key;
    }
    if (bestKey !== null) return overrides[bestKey];
    return _readGlobalLevel();
  }

  function _enabled(tag, levelName) {
    const cur = _resolveLevelFor(tag);
    return (LOG_LEVELS[cur] ?? LOG_LEVELS[DEFAULT_LEVEL]) >= (LOG_LEVELS[levelName] ?? 0);
  }

  /**
   * Create a logger gated by global + per-tag log levels.
   *
   * @param {string} tag - Logger tag (e.g., "[ONI][ActionFetch]")
   * @param {boolean} [legacyDebug=true] - If false, suppresses everything regardless of level.
   * @returns {{ log:Function, info:Function, debug:Function, warn:Function, err:Function, error:Function, tag:string, isEnabled:(level:string)=>boolean }}
   *
   * @example
   * const { log, warn, err } = FUCompanion.createLogger("[ONI][MyMacro]");
   * log("Starting macro", { data });
   * if (error) err("Failed:", error);
   */
  FUCompanion.createLogger = function(tag, legacyDebug = true) {
    const respect = legacyDebug !== false;
    const gate = (lvl) => respect && _enabled(tag, lvl);

    const debug = (...a) => { if (gate("debug")) console.debug(tag, ...a); };
    const info  = (...a) => { if (gate("info"))  console.log(tag, ...a); };
    const log   = info;
    const warn  = (...a) => { if (gate("warn"))  console.warn(tag, ...a); };
    const error = (...a) => { if (gate("error")) console.error(tag, ...a); };
    const err   = error;

    return { log, info, debug, warn, err, error, tag, isEnabled: gate };
  };

  // Allow other code (and the settings onChange) to drop the cache so the
  // next call re-reads from game.settings.
  FUCompanion.invalidateLogCache = () => {
    _cachedLevel = null;
    _cachedTagOverrides = null;
  };

  // Settings registration. Must run in "init" — settings are not yet available
  // at file-load time, and game.settings.register itself errors before "init".
  if (typeof Hooks !== "undefined") {
    Hooks.once("init", () => {
      try {
        game.settings.register(MODULE_ID, "logLevel", {
          name: "FU Companion: console log level",
          hint: "Console verbosity for FabulaUltimaCompanion. silent < error < warn < info < debug.",
          scope: "client",
          config: true,
          type: String,
          choices: {
            silent: "Silent",
            error:  "Error only",
            warn:   "Warn + Error",
            info:   "Info (default)",
            debug:  "Debug (verbose)"
          },
          default: DEFAULT_LEVEL,
          onChange: () => FUCompanion.invalidateLogCache()
        });
        game.settings.register(MODULE_ID, "logTags", {
          name: "FU Companion: per-tag log overrides",
          hint: 'JSON object mapping tag substrings to levels. Example: {"[ActionReader]":"debug","[FU Dialog]":"warn"}. Substring match; longest matching key wins.',
          scope: "client",
          config: true,
          type: String,
          default: "{}",
          onChange: () => FUCompanion.invalidateLogCache()
        });
      } catch (e) {
        // Don't let a settings registration failure break script loading.
        console.error("[FUCompanion] Failed to register log settings:", e);
      }
    });
  }
  
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
  
  // File-load banner: emit at debug level so default startup stays quiet.
  // Bypasses createLogger because the cache resolver is fine here, but we want
  // a stable single line that uses the same gating as the rest of the codebase.
  FUCompanion.createLogger("[FUCompanion]").debug("Shared utilities loaded");
})();
