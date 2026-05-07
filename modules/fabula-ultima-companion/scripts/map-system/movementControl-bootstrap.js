/**
 * movementControl-bootstrap.js
 * Fabula Ultima Companion - Movement Control System Bootstrap
 * Foundry VTT v12
 *
 * Purpose:
 * - Final bootstrap/orchestrator for the Movement Control system
 * - Verify all Movement Control sub-scripts are present
 * - Expose one stable top-level Movement Control System API
 * - Coordinate refreshes across API + UI + camera runtime
 * - Provide a simple health snapshot for debugging
 *
 * Notes:
 * - Keep this file lightweight
 * - Logic stays in the dedicated sub-scripts
 * - This script does not replace their internal ready hooks; it coordinates them
 *
 * Expected sibling scripts:
 * - movementControl-debug.js
 * - movementControl-resolver.js
 * - movementControl-store.js
 * - movementControl-socket.js
 * - movementControl-api.js
 * - movementControl-controllerBadge.js
 * - movementControl-passDialog.js
 * - movementControl-cameraRuntime.js
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_BOOTSTRAP__
 *
 * API:
 *   FUCompanion.api.MovementControlSystem
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_BOOTSTRAP__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const REQUIRED_GLOBALS = Object.freeze({
    debug: "__ONI_MOVEMENT_CONTROL_DEBUG__",
    resolver: "__ONI_MOVEMENT_CONTROL_RESOLVER__",
    store: "__ONI_MOVEMENT_CONTROL_STORE__",
    socket: "__ONI_MOVEMENT_CONTROL_SOCKET__",
    api: "__ONI_MOVEMENT_CONTROL_API__",
    controllerBadge: "__ONI_MOVEMENT_CONTROL_CONTROLLER_BADGE__",
    passDialog: "__ONI_MOVEMENT_CONTROL_PASS_DIALOG__",
    cameraRuntime: "__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__"
  });

  const state = {
    installed: true,
    ready: false,
    lastHealthSnapshot: null,
    refreshTimer: null,
    hookIds: []
  };

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
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

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function getPart(name) {
    const key = REQUIRED_GLOBALS[name];
    return key ? globalThis[key] ?? null : null;
  }

  function getAPI() {
    return getPart("api") ?? globalThis.FUCompanion?.api?.MovementControl ?? null;
  }

  function getBadge() {
    return getPart("controllerBadge") ?? globalThis.FUCompanion?.api?.MovementControlControllerBadge ?? null;
  }

  function getPassDialog() {
    return getPart("passDialog") ?? globalThis.FUCompanion?.api?.MovementControlPassDialog ?? null;
  }

  function getCameraRuntime() {
    return getPart("cameraRuntime") ?? globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
  }

  function getSocket() {
    return getPart("socket") ?? globalThis.FUCompanion?.api?.MovementControlSocket ?? null;
  }

  function getStore() {
    return getPart("store") ?? globalThis.FUCompanion?.api?.MovementControlStore ?? null;
  }

  function getResolver() {
    return getPart("resolver") ?? globalThis.FUCompanion?.api?.MovementControlResolver ?? null;
  }

  function isSceneCameraFollowEnabled() {
    try {
      const scene = canvas?.scene;
      if (!scene) return false;

      const raw = scene?.flags?.[MODULE_ID]?.oniFabula?.general?.cameraFollowToken;
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        return ["true", "1", "yes", "y", "on"].includes(s);
      }

      return false;
    } catch {
      return false;
    }
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

  async function buildHealthSnapshot() {
    const api = getAPI();
    const store = getStore();
    const socket = getSocket();
    const resolver = getResolver();
    const cameraRuntime = getCameraRuntime();

    let storedState = null;
    let currentController = null;
    let eligibleControllers = [];
    let snapshotSummary = null;

    try {
      if (store?.getState) {
        storedState = await store.getState();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect stored state during health snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (api?.getCurrentControllerUser) {
        currentController = await api.getCurrentControllerUser();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect current controller during health snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (api?.getEligibleControllers) {
        eligibleControllers = await api.getEligibleControllers({
          onlineOnly: true,
          includeGM: false
        });
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect eligible controllers during health snapshot", {
        error: err?.message ?? err
      });
    }

    try {
      if (api?.getSnapshotSummary) {
        snapshotSummary = api.getSnapshotSummary();
      }
    } catch (err) {
      DBG.warn("Bootstrap", "Failed to collect snapshot summary during health snapshot", {
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
      sceneCameraFollowEnabled: isSceneCameraFollowEnabled(),

      currentControllerUserId: currentController?.userId ?? null,
      currentControllerUserName: currentController?.userName ?? null,
      eligibleControllerCount: Array.isArray(eligibleControllers) ? eligibleControllers.length : 0,

      storedState,
      snapshotSummary,

      socketSnapshot: socket?.getSnapshot?.() ?? null,
      cameraRuntimeState: cameraRuntime?.state ?? null,
      builtAt: Date.now()
    };

    state.lastHealthSnapshot = snapshot;
    return snapshot;
  }

  async function coordinatedRefresh({ reason = "manual", includeApiRefresh = true } = {}) {
    const api = getAPI();
    const badge = getBadge();
    const passDialog = getPassDialog();
    const cameraRuntime = getCameraRuntime();

    DBG.startTimer("movement-control-bootstrap-refresh", "Bootstrap", "Running coordinated Movement Control refresh");

    try {
      if (includeApiRefresh && api?.refresh) {
        await api.refresh({
          source: `bootstrap:${reason}`,
          broadcast: false
        });
      }

      if (badge?.refresh) {
        await badge.refresh({ reason: `bootstrap:${reason}` });
      }

      if (passDialog?.refresh) {
        await passDialog.refresh({ reason: `bootstrap:${reason}` });
      }

      if (cameraRuntime?.refresh) {
        await cameraRuntime.refresh();
      }

      const snapshot = await buildHealthSnapshot();

      DBG.groupCollapsed("Bootstrap", "Coordinated refresh complete", {
        reason,
        healthy: snapshot.healthy,
        currentControllerUserId: snapshot.currentControllerUserId,
        currentControllerUserName: snapshot.currentControllerUserName,
        activeSceneId: snapshot.activeSceneId,
        activeSceneName: snapshot.activeSceneName,
        sceneCameraFollowEnabled: snapshot.sceneCameraFollowEnabled
      });

      return snapshot;
    } finally {
      DBG.endTimer("movement-control-bootstrap-refresh", "Bootstrap", "Completed coordinated Movement Control refresh");
    }
  }

  function scheduleRefresh(reason = "scheduled", delay = 0, { includeApiRefresh = true } = {}) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);

    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      coordinatedRefresh({ reason, includeApiRefresh });
    }, Math.max(0, Number(delay) || 0));
  }

  function logDependencyTable() {
    try {
      DBG.table("Bootstrap", "Movement Control dependency status", getDependencyStatus());
    } catch (_) {}
  }

  function registerHooks() {
    const register = (hook, fn) => {
      const id = Hooks.on(hook, fn);
      state.hookIds.push([hook, id]);
    };

    register("canvasReady", () => {
      scheduleRefresh("canvasReady", 80, { includeApiRefresh: true });
    });

    register("renderPlayerList", () => {
      scheduleRefresh("renderPlayerList", 50, { includeApiRefresh: false });
    });

    register("updateScene", (scene) => {
      if (scene?.id !== canvas?.scene?.id) return;
      scheduleRefresh("updateScene", 50, { includeApiRefresh: true });
    });

    register("updateActor", () => {
      scheduleRefresh("updateActor", 60, { includeApiRefresh: true });
    });

    register("updateUser", () => {
      scheduleRefresh("updateUser", 60, { includeApiRefresh: true });
    });

    register("createToken", () => {
      scheduleRefresh("createToken", 60, { includeApiRefresh: true });
    });

    register("deleteToken", () => {
      scheduleRefresh("deleteToken", 60, { includeApiRefresh: true });
    });

    register("updateToken", () => {
      scheduleRefresh("updateToken", 60, { includeApiRefresh: true });
    });

    DBG.verbose("Bootstrap", "Registered bootstrap hooks", {
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
      DBG.warn("Bootstrap", "Movement Control bootstrap detected missing dependencies", {
        missing
      });
    }

    registerHooks();

    try {
      await coordinatedRefresh({
        reason: "bootstrapReady",
        includeApiRefresh: true
      });
    } catch (err) {
      DBG.warn("Bootstrap", "Initial coordinated refresh failed", {
        error: err?.message ?? err
      });
    }

    state.ready = true;

    DBG.info("Bootstrap", "Movement Control bootstrap initialized", {
      healthy: isHealthy(),
      missingDependencies: getMissingDependencies()
    });
  }

  function shutdown() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;

    unregisterHooks();

    DBG.verbose("Bootstrap", "Movement Control bootstrap shutdown complete");
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
      globalThis.FUCompanion.api.MovementControlSystem = api;
    } catch (err) {
      console.warn("[MovementControl:Bootstrap] Failed to attach API to FUCompanion.api", err);
    }

    await initialize();
  });

  Hooks.once("shutdown", () => {
    shutdown();
  });
})();
