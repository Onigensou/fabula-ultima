/**
 * emote-bootstrap.js
 * Fabula Ultima Companion - Emote System Bootstrap
 * Foundry VTT v12
 *
 * Purpose:
 * - Final bootstrap/orchestrator for the Emote System
 * - Verify all Emote sub-scripts are present
 * - Expose one stable top-level Emote System API
 * - Provide a simple health snapshot for debugging
 *
 * Notes:
 * - Keep this file lightweight
 * - Logic stays in the dedicated sub-scripts
 * - This script coordinates the Emote System parts, it does not replace them
 *
 * Expected sibling scripts:
 * - emote-debug.js
 * - emote-data.js
 * - emote-store.js
 * - emote-resolver.js
 * - emote-runtime.js
 * - emote-api.js
 * - emote-hotkeys.js
 * - emote-config-app.js
 * - emote-chat-button.js
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_BOOTSTRAP__
 *
 * API:
 *   FUCompanion.api.EmoteSystemBootstrap
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_BOOTSTRAP__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const REQUIRED_GLOBALS = Object.freeze({
    debug: "__ONI_EMOTE_DEBUG__",
    data: "__ONI_EMOTE_DATA__",
    store: "__ONI_EMOTE_STORE__",
    resolver: "__ONI_EMOTE_RESOLVER__",
    runtime: "__ONI_EMOTE_RUNTIME__",
    api: "__ONI_EMOTE_API__",
    hotkeys: "__ONI_EMOTE_HOTKEYS__",
    configApp: "__ONI_EMOTE_CONFIG_APP__",
    chatButton: "__ONI_EMOTE_CHAT_BUTTON__"
  });

  const state = {
    installed: true,
    ready: false,
    lastHealthSnapshot: null,
    hookIds: [],
    refreshTimer: null
  };

  function getDebug() {
    const dbg = globalThis.__ONI_EMOTE_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  const DBG = getDebug();

  function getPart(name) {
    const key = REQUIRED_GLOBALS[name];
    return key ? globalThis[key] ?? null : null;
  }

  function getAPI() {
    return getPart("api") ?? globalThis.FUCompanion?.api?.EmoteSystem ?? null;
  }

  function getChatButton() {
    return getPart("chatButton") ?? globalThis.FUCompanion?.api?.EmoteChatButton ?? null;
  }

  function getHotkeys() {
    return getPart("hotkeys") ?? globalThis.FUCompanion?.api?.EmoteHotkeys ?? null;
  }

  function getConfigApp() {
    return getPart("configApp") ?? globalThis.FUCompanion?.api?.EmoteConfigApp ?? null;
  }

  function getDependencyStatus() {
    const rows = [];

    for (const [name, globalKey] of Object.entries(REQUIRED_GLOBALS)) {
      const part = globalThis[globalKey] ?? null;

      rows.push({
        part: name,
        globalKey,
        installed: !!part?.installed,
        found: !!part,
        type: typeof part
      });
    }

    return rows;
  }

  function getMissingDependencies() {
    return getDependencyStatus()
      .filter(row => !row.installed)
      .map(row => row.part);
  }

  function isHealthy() {
    return getMissingDependencies().length === 0;
  }

  function logDependencyTable() {
    try {
      DBG.table("Bootstrap", "Emote System dependency status", getDependencyStatus());
    } catch (_) {}
  }

  async function buildHealthSnapshot() {
    const api = getAPI();
    const hotkeys = getHotkeys();
    const configApp = getConfigApp();
    const chatButton = getChatButton();

    let apiHealth = null;
    let hotkeySnapshot = null;
    let configSnapshot = null;
    let chatButtonSnapshot = null;

    try {
      if (api?.getHealthSnapshot) {
        apiHealth = api.getHealthSnapshot();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect Emote API health snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (hotkeys?.getSnapshot) {
        hotkeySnapshot = hotkeys.getSnapshot();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect Emote hotkeys snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (configApp?.getSnapshot) {
        configSnapshot = configApp.getSnapshot();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect Emote config app snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (chatButton?.getSnapshot) {
        chatButtonSnapshot = chatButton.getSnapshot();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect Emote chat button snapshot", {
        error: err?.message ?? err
      });
    }

    const snapshot = {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      ready: state.ready,
      healthy: isHealthy(),
      missingDependencies: getMissingDependencies(),
      dependencyStatus: getDependencyStatus(),

      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      isGM: !!game.user?.isGM,

      activeSceneId: canvas?.scene?.id ?? null,
      activeSceneName: canvas?.scene?.name ?? null,
      canvasReady: !!canvas?.ready,

      apiHealth,
      hotkeySnapshot,
      configSnapshot,
      chatButtonSnapshot,

      builtAt: Date.now()
    };

    state.lastHealthSnapshot = snapshot;
    return snapshot;
  }

  async function coordinatedRefresh({ reason = "manual" } = {}) {
    const hotkeys = getHotkeys();
    const chatButton = getChatButton();

    DBG.startTimer("emote-bootstrap-refresh", "Bootstrap", "Running coordinated Emote refresh");

    try {
      try {
        if (hotkeys?.installListener && !hotkeys?.isInstalled?.()) {
          hotkeys.installListener();
        }
      } catch (err) {
        DBG.warn("Bootstrap", "Hotkey refresh step failed", {
          reason,
          error: err?.message ?? err
        });
      }

      try {
        if (chatButton?.installOrReattach) {
          chatButton.installOrReattach();
        }
      } catch (err) {
        DBG.warn("Bootstrap", "Chat button refresh step failed", {
          reason,
          error: err?.message ?? err
        });
      }

      const snapshot = await buildHealthSnapshot();

      DBG.groupCollapsed("Bootstrap", "Coordinated Emote refresh complete", {
        reason,
        healthy: snapshot.healthy,
        userId: snapshot.userId,
        userName: snapshot.userName,
        sceneId: snapshot.activeSceneId,
        sceneName: snapshot.activeSceneName,
        canvasReady: snapshot.canvasReady
      });

      return snapshot;
    } finally {
      DBG.endTimer("emote-bootstrap-refresh", "Bootstrap", "Completed coordinated Emote refresh");
    }
  }

  function scheduleRefresh(reason = "scheduled", delay = 0) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);

    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      coordinatedRefresh({ reason });
    }, Math.max(0, Number(delay) || 0));
  }

  function registerHooks() {
    const register = (hook, fn) => {
      const id = Hooks.on(hook, fn);
      state.hookIds.push([hook, id]);
    };

    register("canvasReady", () => {
      scheduleRefresh("canvasReady", 50);
    });

    register("renderSidebarTab", () => {
      scheduleRefresh("renderSidebarTab", 20);
    });

    register("controlToken", () => {
      scheduleRefresh("controlToken", 20);
    });

    register("updateUser", () => {
      scheduleRefresh("updateUser", 30);
    });

    DBG.verbose("Bootstrap", "Registered Emote bootstrap hooks", {
      hookCount: state.hookIds.length
    });
  }

  function unregisterHooks() {
    for (const [hook, id] of state.hookIds) {
      try {
        Hooks.off(hook, id);
      } catch (_) {}
    }
    state.hookIds = [];
  }

  async function initialize() {
    logDependencyTable();

    const missing = getMissingDependencies();
    if (missing.length > 0) {
      DBG.warn("Bootstrap", "Emote bootstrap detected missing dependencies", {
        missing
      });
    }

    registerHooks();

    try {
      await coordinatedRefresh({
        reason: "bootstrapReady"
      });
    } catch (err) {
      DBG.warn("Bootstrap", "Initial coordinated Emote refresh failed", {
        error: err?.message ?? err
      });
    }

    state.ready = true;

    DBG.info("Bootstrap", "Emote bootstrap initialized", {
      healthy: isHealthy(),
      missingDependencies: getMissingDependencies()
    });
  }

  function shutdown() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;

    unregisterHooks();

    DBG.verbose("Bootstrap", "Emote bootstrap shutdown complete");
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    REQUIRED_GLOBALS,

    getDependencyStatus,
    getMissingDependencies,
    isHealthy,

    buildHealthSnapshot,
    getLastHealthSnapshot: () => state.lastHealthSnapshot,

    coordinatedRefresh,
    scheduleRefresh,
    shutdown
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", async () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteSystemBootstrap = api;
    } catch (err) {
      console.warn("[Emote:Bootstrap] Failed to attach API to FUCompanion.api", err);
    }

    await initialize();
  });
})();