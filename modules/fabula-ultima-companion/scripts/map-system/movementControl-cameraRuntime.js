/**
 * movementControl-cameraRuntime.js
 * Fabula Ultima Companion - Movement Control Camera Runtime
 * Foundry VTT v12
 *
 * Purpose:
 * - Keep the camera-follow-token behavior for player clients
 * - Only operate when scene flag cameraFollowToken is true
 * - Follow the current Central Party Token resolved by Movement Control API
 * - Allow only the current Main Controller to right-click move the party token
 * - Keep other players in observer mode
 *
 * Notes:
 * - GM client is never affected
 * - UI is not handled here
 * - This script depends on movementControl-api.js
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__
 *
 * API:
 *   FUCompanion.api.MovementControlCameraRuntime
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__";
  if (globalThis[GLOBAL_KEY]?.state?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  const WORLD_LOCK_SCOPE = "world";
  const WORLD_LOCK_KEY = "oniMovementControlCameraLocked";

  const SMOOTHING = 0.18;

  const state = {
    installed: true,
    enabled: true,

    activeSceneId: null,
    followEnabledForScene: false,

    mode: "inactive", // inactive | waiting | follow

    followTokenId: null,
    followTokenActorId: null,
    followTokenActorName: null,

    lockedScale: null,
    lockX: null,
    lockY: null,

    curX: null,
    curY: null,

    cachedCurrentControllerUserId: null,
    cachedCurrentControllerUserName: null,
    cachedIsMainController: false,

    pendingDestination: null,
    isMoving: false,

    inputLocked: false,
    movementLockIds: new Set(),

    inputInstalled: false,
    listeners: [],
    hookIds: [],
    tickerFn: null,
    preUpdateInstalled: false,

    isApplying: false,
    applyTimer: null
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

  function getMovementAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_API__
      ?? globalThis.FUCompanion?.api?.MovementControl
      ?? null;
  }

  const DBG = getDebug();

  function safeGet(obj, path, fallback) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function normalizeBoolean(v, fallback = false) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }
    return fallback;
  }

  function getSceneCameraFollowEnabled(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
    return normalizeBoolean(raw, false);
  }

  function smoothingAlpha(deltaFrames) {
    return 1 - Math.pow(1 - SMOOTHING, deltaFrames);
  }

  function addDomListener(el, type, fn, options) {
    el.addEventListener(type, fn, options);
    state.listeners.push(() => el.removeEventListener(type, fn, options));
  }

  function clearPendingMove() {
    state.pendingDestination = null;
  }

  function isMovementLocked() {
    if (state.inputLocked) return true;
    if (state.movementLockIds.size > 0) return true;

    const doc = getFollowTokenDocument();
    if (!doc) return false;

    try {
      return !!doc.getFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY);
    } catch {
      return false;
    }
  }

  function lockMovement(lockId = "default") {
    state.movementLockIds.add(String(lockId));
    state.inputLocked = true;
    clearPendingMove();

    DBG.verbose("CameraRuntime", "Movement locked", {
      lockId: String(lockId),
      activeLocks: Array.from(state.movementLockIds)
    });
  }

  function unlockMovement(lockId = "default") {
    state.movementLockIds.delete(String(lockId));
    if (state.movementLockIds.size === 0) {
      state.inputLocked = false;
    }

    DBG.verbose("CameraRuntime", "Movement unlocked", {
      lockId: String(lockId),
      activeLocks: Array.from(state.movementLockIds)
    });
  }

  async function setWorldMovementLocked(locked) {
    const doc = getFollowTokenDocument();
    if (!doc?.isOwner) return false;

    try {
      if (locked) await doc.setFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY, true);
      else await doc.unsetFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY);

      DBG.verbose("CameraRuntime", "Updated world movement lock flag", {
        tokenId: doc.id,
        locked: !!locked
      });

      return true;
    } catch (err) {
      DBG.warn("CameraRuntime", "Failed to update world movement lock flag", {
        tokenId: doc?.id ?? null,
        locked: !!locked,
        error: err?.message ?? err
      });
      return false;
    }
  }

  function getFollowToken() {
    if (!canvas?.ready || !state.followTokenId) return null;
    return canvas.tokens?.get(state.followTokenId) ?? null;
  }

  function getFollowTokenDocument() {
    return getFollowToken()?.document ?? null;
  }

  function findTokenByActorFallback(actorId, actorName) {
    if (!canvas?.ready) return null;

    if (hasText(actorId)) {
      const byActorId = canvas.tokens?.placeables?.find(t => t?.actor?.id === actorId) ?? null;
      if (byActorId) return byActorId;
    }

    if (hasText(actorName)) {
      const byActorName = canvas.tokens?.placeables?.find(t => cleanString(t?.name) === cleanString(actorName)) ?? null;
      if (byActorName) return byActorName;
    }

    return null;
  }

  function hasXYChange(change) {
    return ("x" in (change ?? {})) || ("y" in (change ?? {}));
  }

  function clampToSceneTopLeft(x, y, token) {
    const rect = canvas.dimensions?.sceneRect;
    if (!rect) return { x, y };

    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.width - token.w;
    const maxY = rect.y + rect.height - token.h;

    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY)
    };
  }

  function snapTopLeftIfGrid(x, y) {
    if (!canvas.grid || canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) return { x, y };
    return canvas.grid.getSnappedPosition(x, y, 1);
  }

  function pointToTopLeftFromCenter(center, token) {
    return {
      x: center.x - (token.w / 2),
      y: center.y - (token.h / 2)
    };
  }

  function removeInputBlockers() {
    for (const remove of state.listeners) {
      try {
        remove();
      } catch (_) {}
    }
    state.listeners = [];
    state.inputInstalled = false;
  }

  function canCurrentUserMovePartyToken() {
    if (game.user?.isGM) return true;
    if (!state.followEnabledForScene) return false;
    if (isMovementLocked()) return false;
    return !!state.cachedIsMainController;
  }

  async function refreshAuthorityFromApi() {
    const api = getMovementAPI();
    if (!api) {
      state.cachedCurrentControllerUserId = null;
      state.cachedCurrentControllerUserName = null;
      state.cachedIsMainController = false;
      return;
    }

    try {
      const controller = await api.getCurrentControllerUser();
      state.cachedCurrentControllerUserId = controller?.userId ?? null;
      state.cachedCurrentControllerUserName = controller?.userName ?? null;
      state.cachedIsMainController = !!controller && controller.userId === game.user?.id;

      DBG.verbose("CameraRuntime", "Authority refreshed from API", {
        currentUserId: game.user?.id ?? null,
        controllerUserId: state.cachedCurrentControllerUserId,
        controllerUserName: state.cachedCurrentControllerUserName,
        isMainController: state.cachedIsMainController
      });
    } catch (err) {
      state.cachedCurrentControllerUserId = null;
      state.cachedCurrentControllerUserName = null;
      state.cachedIsMainController = false;

      DBG.warn("CameraRuntime", "Failed to refresh authority from API", {
        error: err?.message ?? err
      });
    }
  }

  async function resolveFollowSnapshot() {
    const api = getMovementAPI();
    if (!api) return null;

    try {
      const snapshot = await api.refresh({
        source: "cameraRuntime",
        broadcast: false
      });

      return snapshot ?? api.getLastSnapshot?.() ?? null;
    } catch (err) {
      DBG.warn("CameraRuntime", "Failed to resolve follow snapshot", {
        error: err?.message ?? err
      });

      return api.getLastSnapshot?.() ?? null;
    }
  }

  async function applyForActiveScene(reason = "manual") {
    if (state.isApplying) return;
    if (game.user?.isGM) return;
    if (!canvas?.ready || !canvas.scene) return;

    state.isApplying = true;
    DBG.startTimer("movement-control-camera-apply", "CameraRuntime", "Applying camera runtime state");

    try {
      const scene = canvas.scene;
      state.activeSceneId = scene.id;
      state.followEnabledForScene = getSceneCameraFollowEnabled(scene);

      await refreshAuthorityFromApi();

      if (!state.followEnabledForScene) {
        state.mode = "inactive";
        state.followTokenId = null;
        state.followTokenActorId = null;
        state.followTokenActorName = null;
        state.pendingDestination = null;
        state.isMoving = false;

        DBG.verbose("CameraRuntime", "Camera runtime inactive because scene flag is off", {
          reason,
          sceneId: scene.id,
          sceneName: scene.name ?? null
        });
        return;
      }

      state.lockedScale = canvas.stage.scale.x;
      state.lockX = canvas.stage.pivot.x;
      state.lockY = canvas.stage.pivot.y;

      state.mode = "waiting";
      state.followTokenId = null;

      const snapshot = await resolveFollowSnapshot();

      const token =
        snapshot?.centralPartyToken
        ?? (snapshot?.centralPartyActorId || snapshot?.centralPartyActorName
          ? findTokenByActorFallback(snapshot?.centralPartyActorId ?? null, snapshot?.centralPartyActorName ?? null)
          : null);

      state.followTokenActorId = snapshot?.centralPartyActorId ?? null;
      state.followTokenActorName = snapshot?.centralPartyActorName ?? null;

      if (token) {
        state.followTokenId = token.id;
        state.mode = "follow";
        state.curX = canvas.stage.pivot.x;
        state.curY = canvas.stage.pivot.y;

        DBG.groupCollapsed("CameraRuntime", "Following central party token", {
          reason,
          tokenId: token.id,
          tokenName: token.name ?? null,
          actorId: token.actor?.id ?? null,
          actorName: token.actor?.name ?? null,
          controllerUserId: state.cachedCurrentControllerUserId,
          controllerUserName: state.cachedCurrentControllerUserName,
          isMainController: state.cachedIsMainController
        });
      } else {
        DBG.verbose("CameraRuntime", "Camera runtime is waiting for central party token", {
          reason,
          centralPartyActorId: state.followTokenActorId,
          centralPartyActorName: state.followTokenActorName
        });
      }
    } finally {
      state.isApplying = false;
      DBG.endTimer("movement-control-camera-apply", "CameraRuntime", "Applied camera runtime state");
    }
  }

  function scheduleApply(reason = "scheduled", delay = 0) {
    if (state.applyTimer) clearTimeout(state.applyTimer);
    state.applyTimer = setTimeout(() => {
      state.applyTimer = null;
      applyForActiveScene(reason);
    }, Math.max(0, Number(delay) || 0));
  }

  async function attemptMoveTokenToCanvasPoint(destCanvasPoint) {
    const token = getFollowToken();
    if (!token) return;

    if (!canCurrentUserMovePartyToken()) {
      DBG.verbose("CameraRuntime", "Right-click move ignored because current user is not allowed to move", {
        currentUserId: game.user?.id ?? null,
        currentUserName: game.user?.name ?? null,
        controllerUserId: state.cachedCurrentControllerUserId,
        controllerUserName: state.cachedCurrentControllerUserName
      });
      return;
    }

    if (!token.document?.isOwner) {
      DBG.verbose("CameraRuntime", "Right-click move ignored because token is not owner-editable on this client", {
        tokenId: token.id,
        tokenName: token.name ?? null
      });
      return;
    }

    const origin = token.center;
    const destination = { x: destCanvasPoint.x, y: destCanvasPoint.y };

    let collision = null;
    try {
      collision = token.checkCollision(destination, {
        origin,
        mode: "closest",
        type: "move"
      });
    } catch {
      collision = null;
    }

    let finalCenter = destination;

    if (
      collision &&
      typeof collision === "object" &&
      typeof collision.x === "number" &&
      typeof collision.y === "number"
    ) {
      finalCenter = { x: collision.x, y: collision.y };
    }

    let { x, y } = pointToTopLeftFromCenter(finalCenter, token);

    const snapped = snapTopLeftIfGrid(x, y);
    const snappedCenter = {
      x: snapped.x + token.w / 2,
      y: snapped.y + token.h / 2
    };

    let snappedWouldCollide = false;
    try {
      const test = token.checkCollision(snappedCenter, {
        origin: token.center,
        mode: "any",
        type: "move"
      });
      snappedWouldCollide = test === true;
    } catch {
      snappedWouldCollide = false;
    }

    if (!snappedWouldCollide) {
      x = snapped.x;
      y = snapped.y;
    }

    ({ x, y } = clampToSceneTopLeft(x, y, token));

    await token.document.update({ x, y }, { animate: true });

    DBG.verbose("CameraRuntime", "Central party token moved by right-click", {
      tokenId: token.id,
      tokenName: token.name ?? null,
      x,
      y
    });
  }

  async function consumeMoveQueue() {
    if (state.isMoving) return;
    state.isMoving = true;

    try {
      while (state.enabled && state.pendingDestination) {
        if (!canCurrentUserMovePartyToken()) {
          clearPendingMove();
          break;
        }

        const dest = state.pendingDestination;
        state.pendingDestination = null;
        await attemptMoveTokenToCanvasPoint(dest);
      }
    } finally {
      state.isMoving = false;
    }
  }

  function ensureInputBlockersInstalled() {
    const view = canvas?.app?.view;
    if (!view) return;
    if (state.inputInstalled) return;

    state.inputInstalled = true;

    const onWheel = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(view, "wheel", onWheel, { capture: true, passive: false });

    const onContextMenu = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(view, "contextmenu", onContextMenu, { capture: true });

    const onPointerDown = (ev) => {
      if (state.mode === "inactive") return;

      // Right-click
      if (ev.button === 2) {
        ev.preventDefault();
        ev.stopPropagation();

        if (!canCurrentUserMovePartyToken()) {
          DBG.verbose("CameraRuntime", "Blocked right-click move input", {
            currentUserId: game.user?.id ?? null,
            currentUserName: game.user?.name ?? null,
            controllerUserId: state.cachedCurrentControllerUserId,
            controllerUserName: state.cachedCurrentControllerUserName,
            isMainController: state.cachedIsMainController,
            locked: isMovementLocked()
          });
          return;
        }

        const p = canvas.canvasCoordinatesFromClient({
          x: ev.clientX,
          y: ev.clientY
        });

        state.pendingDestination = p;
        consumeMoveQueue();
        return;
      }

      // Middle-click pan
      if (ev.button === 1) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    addDomListener(view, "pointerdown", onPointerDown, { capture: true });

    const onPointerMove = (ev) => {
      if (state.mode === "inactive") return;

      if ((ev.buttons & 2) === 2) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    addDomListener(view, "pointermove", onPointerMove, { capture: true });

    DBG.verbose("CameraRuntime", "Installed input blockers");
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(state.tickerFn);
    }
    state.tickerFn = null;
  }

  function attachTicker() {
    if (!canvas?.ready || !canvas?.app?.ticker) return;
    if (state.tickerFn) return;

    state.tickerFn = (delta) => {
      if (!state.enabled) return;
      if (!canvas?.ready) return;
      if (state.mode === "inactive") return;

      const scale = state.lockedScale ?? canvas.stage.scale.x;

      if (state.mode === "waiting") {
        const x = state.lockX ?? canvas.stage.pivot.x;
        const y = state.lockY ?? canvas.stage.pivot.y;
        canvas.pan({ x, y, scale });
        return;
      }

      if (state.mode === "follow") {
        let token = getFollowToken();

        if (!token && (state.followTokenActorId || state.followTokenActorName)) {
          token = findTokenByActorFallback(state.followTokenActorId, state.followTokenActorName);
          if (token) state.followTokenId = token.id;
        }

        if (!token) {
          state.mode = "waiting";
          state.lockX = canvas.stage.pivot.x;
          state.lockY = canvas.stage.pivot.y;
          canvas.pan({ x: state.lockX, y: state.lockY, scale });
          return;
        }

        const targetCenter = token.center;
        const alpha = smoothingAlpha(delta);

        state.curX = state.curX ?? canvas.stage.pivot.x;
        state.curY = state.curY ?? canvas.stage.pivot.y;

        state.curX = state.curX + (targetCenter.x - state.curX) * alpha;
        state.curY = state.curY + (targetCenter.y - state.curY) * alpha;

        canvas.pan({ x: state.curX, y: state.curY, scale });
      }
    };

    canvas.app.ticker.add(state.tickerFn);

    DBG.verbose("CameraRuntime", "Attached camera follow ticker");
  }

  function installPreUpdateGateOnce() {
    if (state.preUpdateInstalled) return;
    state.preUpdateInstalled = true;

    Hooks.on("preUpdateToken", (doc, change, options) => {
      try {
        if (game.user?.isGM) return;
        if (options?.oniBypassGate) return;
        if (!doc) return;
        if (!hasXYChange(change)) return;
        if (!state.followEnabledForScene) return;
        if (!canvas?.scene || doc.parent?.id !== canvas.scene.id) return;

        const matchesByTokenId =
          !!state.followTokenId &&
          cleanString(doc.id) === cleanString(state.followTokenId);

        const matchesByActor =
          hasText(state.followTokenActorId) &&
          cleanString(doc.actorId) === cleanString(state.followTokenActorId);

        const matchesByName =
          hasText(state.followTokenActorName) &&
          cleanString(doc.name) === cleanString(state.followTokenActorName);

        if (!matchesByTokenId && !matchesByActor && !matchesByName) return;

        if (canCurrentUserMovePartyToken()) return;

        if ("x" in change) delete change.x;
        if ("y" in change) delete change.y;

        DBG.verbose("CameraRuntime", "Blocked unauthorized token movement in preUpdateToken", {
          docId: doc.id,
          docName: doc.name ?? null,
          actorId: doc.actorId ?? null,
          currentUserId: game.user?.id ?? null,
          controllerUserId: state.cachedCurrentControllerUserId,
          isMainController: state.cachedIsMainController,
          locked: isMovementLocked()
        });
      } catch (err) {
        DBG.warn("CameraRuntime", "preUpdateToken gate error", {
          error: err?.message ?? err
        });
      }
    });
  }

  function installHooks() {
    const register = (hook, fn) => {
      const id = Hooks.on(hook, fn);
      state.hookIds.push([hook, id]);
    };

    register("canvasReady", async () => {
      if (game.user?.isGM) return;
      if (!state.enabled) return;

      installPreUpdateGateOnce();
      ensureInputBlockersInstalled();
      attachTicker();
      scheduleApply("canvasReady", 0);
    });

    register("canvasTearDown", () => {
      if (game.user?.isGM) return;
      detachTicker();
      removeInputBlockers();
    });

    register("updateScene", async (scene) => {
      if (game.user?.isGM) return;
      if (!canvas?.scene) return;
      if (scene.id !== canvas.scene.id) return;
      scheduleApply("updateScene", 20);
    });

    register("createToken", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("createToken", 20);
    });

    register("deleteToken", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("deleteToken", 20);
    });

    register("updateToken", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("updateToken", 20);
    });

    register("updateActor", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("updateActor", 40);
    });

    register("updateUser", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("updateUser", 40);
    });

    DBG.verbose("CameraRuntime", "Installed hooks", {
      hookCount: state.hookIds.length
    });
  }

  function uninstallHooks() {
    for (const [hook, id] of state.hookIds) {
      try {
        Hooks.off(hook, id);
      } catch (_) {}
    }
    state.hookIds = [];
  }

  function shutdown() {
    if (state.applyTimer) clearTimeout(state.applyTimer);
    state.applyTimer = null;

    detachTicker();
    removeInputBlockers();
    uninstallHooks();

    state.mode = "inactive";
    state.followTokenId = null;
    state.followTokenActorId = null;
    state.followTokenActorName = null;

    DBG.verbose("CameraRuntime", "Camera runtime shutdown complete");
  }

  const api = {
    state,

    refresh: () => applyForActiveScene("apiRefresh"),
    scheduleRefresh: (reason = "apiScheduled", delay = 0) => scheduleApply(reason, delay),

    lockMovement,
    unlockMovement,
    setWorldMovementLocked,

    getFollowToken,
    getFollowTokenDocument,
    canCurrentUserMovePartyToken,

    shutdown
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", async () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlCameraRuntime = api;
    } catch (err) {
      console.warn("[MovementControl:CameraRuntime] Failed to attach API to FUCompanion.api", err);
    }

    if (game.user?.isGM) {
      DBG.verbose("CameraRuntime", "GM client detected; camera runtime remains inactive");
      return;
    }

    installPreUpdateGateOnce();
    installHooks();

    if (canvas?.ready) {
      ensureInputBlockersInstalled();
      attachTicker();
      await applyForActiveScene("ready");
    }

    DBG.verbose("CameraRuntime", "movementControl-cameraRuntime.js ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });

  Hooks.once("shutdown", () => {
    shutdown();
  });
})();
