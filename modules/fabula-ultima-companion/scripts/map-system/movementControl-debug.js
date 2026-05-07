/**
 * movementControl-debug.js
 * Fabula Ultima Companion - Movement Control System Debug Utility
 * Foundry VTT v12
 *
 * Purpose:
 * - Centralize all debug logging for the Movement Control system
 * - Give all future scripts one shared logger
 * - Make it easy to toggle debug on/off from Foundry settings or console
 *
 * Console examples:
 *   const DBG = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
 *   DBG.enable();
 *   DBG.log("Bootstrap", "Movement Control initialized");
 *   DBG.group("Resolver", "Resolved party members", { members: [...] });
 *   DBG.verbose("Camera", "Right click intercepted", { userId: game.user.id });
 *   DBG.disable();
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_DEBUG__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const SETTINGS = {
    ENABLED: "movementControlDebugEnabled",
    VERBOSE: "movementControlDebugVerbose"
  };

  const timers = new Map();

  function nowStamp() {
    try {
      return new Date().toISOString();
    } catch {
      return "";
    }
  }

  function safeGetSetting(key, fallback = false) {
    try {
      if (!game?.settings) return fallback;
      return game.settings.get(MODULE_ID, key);
    } catch {
      return fallback;
    }
  }

  function buildTag(scope = "Core") {
    const clean = String(scope || "Core").trim();
    return `[MovementControl:${clean}]`;
  }

  function shouldLog({ verbose = false } = {}) {
    const enabled = safeGetSetting(SETTINGS.ENABLED, false);
    if (!enabled) return false;
    if (!verbose) return true;
    return safeGetSetting(SETTINGS.VERBOSE, false);
  }

  function normalizePayload(payload) {
    if (payload === undefined) return undefined;
    return payload;
  }

  function output(method, scope, message, payload, { force = false, verbose = false } = {}) {
    if (!force && !shouldLog({ verbose })) return;

    const tag = buildTag(scope);
    const stamp = nowStamp();
    const text = stamp ? `${tag} ${stamp} ${message}` : `${tag} ${message}`;
    const cleanPayload = normalizePayload(payload);

    if (cleanPayload === undefined) {
      console[method](text);
    } else {
      console[method](text, cleanPayload);
    }
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    SETTINGS,

    isEnabled() {
      return safeGetSetting(SETTINGS.ENABLED, false);
    },

    isVerbose() {
      return safeGetSetting(SETTINGS.VERBOSE, false);
    },

    async enable() {
      if (!game?.settings) return false;
      await game.settings.set(MODULE_ID, SETTINGS.ENABLED, true);
      console.info("[MovementControl:Debug] Debug logging enabled");
      return true;
    },

    async disable() {
      if (!game?.settings) return false;
      await game.settings.set(MODULE_ID, SETTINGS.ENABLED, false);
      console.info("[MovementControl:Debug] Debug logging disabled");
      return true;
    },

    async setVerbose(enabled) {
      if (!game?.settings) return false;
      await game.settings.set(MODULE_ID, SETTINGS.VERBOSE, !!enabled);
      console.info(`[MovementControl:Debug] Verbose logging ${enabled ? "enabled" : "disabled"}`);
      return true;
    },

    log(scope, message, payload) {
      output("log", scope, message, payload);
    },

    info(scope, message, payload) {
      output("info", scope, message, payload);
    },

    verbose(scope, message, payload) {
      output("log", scope, message, payload, { verbose: true });
    },

    warn(scope, message, payload) {
      output("warn", scope, message, payload, { force: true });
    },

    error(scope, message, payload) {
      output("error", scope, message, payload, { force: true });
    },

    group(scope, message, payload) {
      if (!shouldLog()) return;
      const tag = buildTag(scope);
      const stamp = nowStamp();
      console.group(`${tag} ${stamp} ${message}`);
      if (payload !== undefined) console.log(payload);
      console.groupEnd();
    },

    groupCollapsed(scope, message, payload, { verbose = false } = {}) {
      if (!shouldLog({ verbose })) return;
      const tag = buildTag(scope);
      const stamp = nowStamp();
      console.groupCollapsed(`${tag} ${stamp} ${message}`);
      if (payload !== undefined) console.log(payload);
      console.groupEnd();
    },

    table(scope, message, rows) {
      if (!shouldLog()) return;
      const tag = buildTag(scope);
      const stamp = nowStamp();
      console.groupCollapsed(`${tag} ${stamp} ${message}`);
      try {
        console.table(Array.isArray(rows) ? rows : [rows]);
      } catch {
        console.log(rows);
      }
      console.groupEnd();
    },

    divider(scope = "Core", label = "") {
      if (!shouldLog()) return;
      const tag = buildTag(scope);
      console.log(`${tag} ───────────────────────── ${label}`);
    },

    startTimer(key, scope = "Core", message = "Timer started") {
      const timerKey = String(key);
      timers.set(timerKey, performance.now());
      this.verbose(scope, message, { timerKey });
    },

    endTimer(key, scope = "Core", message = "Timer ended") {
      const timerKey = String(key);
      const start = timers.get(timerKey);
      if (start == null) {
        this.warn(scope, "Timer end requested, but timer was not found", { timerKey });
        return null;
      }

      const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
      timers.delete(timerKey);

      if (shouldLog()) {
        const tag = buildTag(scope);
        const stamp = nowStamp();
        console.log(`${tag} ${stamp} ${message}`, { timerKey, elapsedMs });
      }

      return elapsedMs;
    },

    snapshot() {
      return {
        enabled: this.isEnabled(),
        verbose: this.isVerbose(),
        timers: Array.from(timers.keys())
      };
    }
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTINGS.ENABLED, {
      name: "Movement Control Debug Logging",
      hint: "Enable debug logs for the Movement Control system.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, SETTINGS.VERBOSE, {
      name: "Movement Control Verbose Logging",
      hint: "Show extra detailed logs for Movement Control.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    });
  });

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlDebug = api;
    } catch (err) {
      console.warn("[MovementControl:Debug] Failed to attach API to FUCompanion.api", err);
    }

    api.verbose("Bootstrap", "movementControl-debug.js ready", {
      moduleId: MODULE_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });
})();
