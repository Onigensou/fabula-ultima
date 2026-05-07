/**
 * emote-resolver.js
 * Fabula Ultima Companion - Emote System Resolver
 * Foundry VTT v12
 *
 * Purpose:
 * - Resolve whether the current user is allowed to use an emote
 * - Resolve which token / actor should receive the emote
 * - Respect:
 *   1) GM selected-token override
 *   2) camera-follow-token mode => only Main Controller can emote on central token
 *   3) individual mode => user's linked actor token
 *
 * Notes:
 * - This script is read-only
 * - It does not play the emote
 * - It does not save config
 * - It only resolves authority + target context
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_RESOLVER__
 *
 * API:
 *   FUCompanion.api.EmoteResolver
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_RESOLVER__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  const DEFAULT_OFFSETS = Object.freeze({
    // Easy tuning knob:
    // more left  = more negative
    // more right = more positive
    x: -40,
    y: -54
  });

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

  function getMovementApi() {
    return globalThis.__ONI_MOVEMENT_CONTROL_API__
      ?? globalThis.FUCompanion?.api?.MovementControl
      ?? null;
  }

  const DBG = getDebug();

  function safeGet(obj, path, fallback = undefined) {
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

  function deepClone(value) {
    try {
      return foundry.utils.deepClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function getSceneCameraFollowEnabled(scene = null) {
    const activeScene = scene ?? canvas?.scene ?? null;
    const fab = activeScene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
    return normalizeBoolean(raw, false);
  }

  function isCameraFollowModeActive(scene = null) {
    return !!canvas?.ready && !!(scene ?? canvas?.scene) && getSceneCameraFollowEnabled(scene);
  }

  function getControlledTokens() {
    return Array.from(canvas?.tokens?.controlled ?? []);
  }

  function getFirstControlledToken() {
    return getControlledTokens()[0] ?? null;
  }

  function findTokenByActorOnCanvas(actor) {
    if (!canvas?.ready || !actor) return null;

    // Strong match: actor id
    let token = canvas.tokens?.placeables?.find(t => t?.actor?.id === actor.id) ?? null;
    if (token) return token;

    // Fallback: actor name
    token = canvas.tokens?.placeables?.find(t => cleanString(t?.actor?.name) === cleanString(actor.name)) ?? null;
    if (token) return token;

    // Fallback: token name
    token = canvas.tokens?.placeables?.find(t => cleanString(t?.name) === cleanString(actor.name)) ?? null;
    if (token) return token;

    return null;
  }

  function getTokenDescriptor(token) {
    if (!token) return null;

    return {
      token,
      tokenId: token.id ?? null,
      tokenName: token.name ?? null,
      tokenUuid: token.document?.uuid ?? null,
      actor: token.actor ?? null,
      actorId: token.actor?.id ?? null,
      actorName: token.actor?.name ?? null,
      actorUuid: token.actor?.uuid ?? null,
      sceneId: canvas?.scene?.id ?? null,
      centerX: Number.isFinite(token.center?.x) ? token.center.x : null,
      centerY: Number.isFinite(token.center?.y) ? token.center.y : null,
      x: Number.isFinite(token.document?.x) ? token.document.x : null,
      y: Number.isFinite(token.document?.y) ? token.document.y : null,
      width: Number.isFinite(token.w) ? token.w : null,
      height: Number.isFinite(token.h) ? token.h : null
    };
  }

  function makeBaseResult({
    ok = false,
    reason = "unknown",
    mode = "unknown",
    token = null,
    actor = null,
    user = null,
    permission = false
  } = {}) {
    const tokenData = getTokenDescriptor(token);

    return {
      ok: !!ok,
      reason: cleanString(reason) || "unknown",
      mode: cleanString(mode) || "unknown",
      permission: !!permission,

      userId: user?.id ?? game.user?.id ?? null,
      userName: user?.name ?? game.user?.name ?? null,
      isGM: !!(user?.isGM ?? game.user?.isGM),

      actor: actor ?? tokenData?.actor ?? null,
      actorId: actor?.id ?? tokenData?.actorId ?? null,
      actorName: actor?.name ?? tokenData?.actorName ?? null,
      actorUuid: actor?.uuid ?? tokenData?.actorUuid ?? null,

      token: token ?? null,
      tokenId: tokenData?.tokenId ?? null,
      tokenName: tokenData?.tokenName ?? null,
      tokenUuid: tokenData?.tokenUuid ?? null,

      x: tokenData?.centerX ?? null,
      y: tokenData?.centerY ?? null,

      offsetX: DEFAULT_OFFSETS.x,
      offsetY: DEFAULT_OFFSETS.y
    };
  }

  function getGmSelectedToken() {
    if (!game.user?.isGM) return null;
    return getFirstControlledToken();
  }

  function resolveGmSelectedToken() {
    const token = getGmSelectedToken();

    if (!token) {
      const result = makeBaseResult({
        ok: false,
        reason: "gmNoSelectedToken",
        mode: "gmSelectedToken",
        token: null,
        actor: null,
        user: game.user,
        permission: false
      });

      DBG.verbose("Resolver", "GM emote resolution failed because no token is selected", result);
      return result;
    }

    const result = makeBaseResult({
      ok: true,
      reason: "gmSelectedToken",
      mode: "gmSelectedToken",
      token,
      actor: token.actor ?? null,
      user: game.user,
      permission: true
    });

    DBG.groupCollapsed("Resolver", "Resolved GM selected token for emote", {
      tokenId: result.tokenId,
      tokenName: result.tokenName,
      actorId: result.actorId,
      actorName: result.actorName
    });

    return result;
  }

  async function resolveCameraFollowCentralToken() {
    const movementApi = getMovementApi();

    if (!movementApi) {
      const result = makeBaseResult({
        ok: false,
        reason: "movementApiUnavailable",
        mode: "cameraFollow",
        user: game.user,
        permission: false
      });

      DBG.warn("Resolver", "Camera-follow emote resolution failed because Movement Control API is unavailable", result);
      return result;
    }

    try {
      let snapshot =
        typeof movementApi.getLastSnapshot === "function"
          ? movementApi.getLastSnapshot()
          : null;

      if (!snapshot && typeof movementApi.refresh === "function") {
        snapshot = await movementApi.refresh({
          source: "emoteResolver",
          broadcast: false
        });
      }

      if (!snapshot && typeof movementApi.resolveSnapshotUsingStoredPreference === "function") {
        snapshot = await movementApi.resolveSnapshotUsingStoredPreference({
          onlineOnly: true,
          includeGM: false
        });
      }

      const controller =
        typeof movementApi.getCurrentControllerUser === "function"
          ? await movementApi.getCurrentControllerUser()
          : null;

      const isMainController =
        !!controller &&
        cleanString(controller.userId) === cleanString(game.user?.id);

      if (!isMainController) {
        const result = makeBaseResult({
          ok: false,
          reason: "notMainController",
          mode: "cameraFollow",
          user: game.user,
          permission: false
        });

        result.currentControllerUserId = controller?.userId ?? null;
        result.currentControllerUserName = controller?.userName ?? null;

        DBG.verbose("Resolver", "Camera-follow emote denied because current user is not Main Controller", {
          currentUserId: game.user?.id ?? null,
          currentUserName: game.user?.name ?? null,
          controllerUserId: controller?.userId ?? null,
          controllerUserName: controller?.userName ?? null
        });

        return result;
      }

      const token =
        snapshot?.centralPartyToken
        ?? (hasText(snapshot?.centralPartyActorId) || hasText(snapshot?.centralPartyActorName)
          ? canvas.tokens?.placeables?.find(t =>
              (hasText(snapshot?.centralPartyActorId) && cleanString(t?.actor?.id) === cleanString(snapshot.centralPartyActorId))
              || (hasText(snapshot?.centralPartyActorName) && cleanString(t?.actor?.name) === cleanString(snapshot.centralPartyActorName))
              || (hasText(snapshot?.centralPartyActorName) && cleanString(t?.name) === cleanString(snapshot.centralPartyActorName))
            ) ?? null
          : null);

      if (!token) {
        const result = makeBaseResult({
          ok: false,
          reason: "centralPartyTokenNotFound",
          mode: "cameraFollow",
          user: game.user,
          permission: false
        });

        result.currentControllerUserId = controller?.userId ?? null;
        result.currentControllerUserName = controller?.userName ?? null;
        result.centralPartyActorId = snapshot?.centralPartyActorId ?? null;
        result.centralPartyActorName = snapshot?.centralPartyActorName ?? null;

        DBG.warn("Resolver", "Camera-follow emote resolution failed because central party token was not found", {
          controllerUserId: controller?.userId ?? null,
          controllerUserName: controller?.userName ?? null,
          centralPartyActorId: snapshot?.centralPartyActorId ?? null,
          centralPartyActorName: snapshot?.centralPartyActorName ?? null
        });

        return result;
      }

      const result = makeBaseResult({
        ok: true,
        reason: "cameraFollowMainController",
        mode: "cameraFollow",
        token,
        actor: token.actor ?? null,
        user: game.user,
        permission: true
      });

      result.currentControllerUserId = controller?.userId ?? null;
      result.currentControllerUserName = controller?.userName ?? null;
      result.centralPartyActorId = snapshot?.centralPartyActorId ?? null;
      result.centralPartyActorName = snapshot?.centralPartyActorName ?? null;

      DBG.groupCollapsed("Resolver", "Resolved camera-follow emote target", {
        currentUserId: game.user?.id ?? null,
        currentUserName: game.user?.name ?? null,
        controllerUserId: controller?.userId ?? null,
        controllerUserName: controller?.userName ?? null,
        tokenId: result.tokenId,
        tokenName: result.tokenName,
        actorId: result.actorId,
        actorName: result.actorName
      });

      return result;
    } catch (err) {
      DBG.error("Resolver", "Camera-follow emote resolution threw an error", {
        error: err?.message ?? err
      });

      return makeBaseResult({
        ok: false,
        reason: "cameraFollowResolutionError",
        mode: "cameraFollow",
        user: game.user,
        permission: false
      });
    }
  }

  function resolveLinkedActorToken(user = null) {
    const targetUser = user ?? game.user ?? null;
    const actor = targetUser?.character ?? null;

    if (!actor) {
      const result = makeBaseResult({
        ok: false,
        reason: "noLinkedActor",
        mode: "individual",
        user: targetUser,
        permission: false
      });

      DBG.verbose("Resolver", "Individual emote resolution failed because user has no linked actor", {
        userId: targetUser?.id ?? null,
        userName: targetUser?.name ?? null
      });

      return result;
    }

    const token = findTokenByActorOnCanvas(actor);

    if (!token) {
      const result = makeBaseResult({
        ok: false,
        reason: "linkedActorTokenNotOnScene",
        mode: "individual",
        actor,
        user: targetUser,
        permission: false
      });

      DBG.verbose("Resolver", "Individual emote resolution failed because linked actor token is not on current scene", {
        userId: targetUser?.id ?? null,
        userName: targetUser?.name ?? null,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null
      });

      return result;
    }

    const result = makeBaseResult({
      ok: true,
      reason: "linkedActorTokenResolved",
      mode: "individual",
      token,
      actor,
      user: targetUser,
      permission: true
    });

    DBG.groupCollapsed("Resolver", "Resolved individual emote target", {
      userId: targetUser?.id ?? null,
      userName: targetUser?.name ?? null,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      tokenId: result.tokenId,
      tokenName: result.tokenName
    });

    return result;
  }

  async function resolveActiveTarget() {
    DBG.startTimer("emote-resolve-active-target", "Resolver", "Resolving active emote target");

    try {
      if (!canvas?.ready || !canvas?.scene) {
        const result = makeBaseResult({
          ok: false,
          reason: "canvasNotReady",
          mode: "unknown",
          user: game.user,
          permission: false
        });

        DBG.warn("Resolver", "Emote resolution failed because canvas is not ready", result);
        return result;
      }

      // Priority 1: GM override
      if (game.user?.isGM) {
        return resolveGmSelectedToken();
      }

      // Priority 2: camera-follow mode
      if (isCameraFollowModeActive(canvas.scene)) {
        return await resolveCameraFollowCentralToken();
      }

      // Priority 3: normal individual mode
      return resolveLinkedActorToken(game.user);
    } finally {
      DBG.endTimer("emote-resolve-active-target", "Resolver", "Resolved active emote target");
    }
  }

  async function canCurrentUserUseEmotes() {
    const resolved = await resolveActiveTarget();

    return {
      ok: !!resolved.ok,
      reason: resolved.reason,
      mode: resolved.mode,
      permission: !!resolved.permission,
      userId: resolved.userId ?? null,
      userName: resolved.userName ?? null,
      tokenId: resolved.tokenId ?? null,
      tokenName: resolved.tokenName ?? null,
      actorId: resolved.actorId ?? null,
      actorName: resolved.actorName ?? null
    };
  }

  function buildPlayContext(targetResult, {
    offsetX = DEFAULT_OFFSETS.x,
    offsetY = DEFAULT_OFFSETS.y,
    overrideX = null,
    overrideY = null
  } = {}) {
    const base = deepClone(targetResult ?? {});

    const finalX = Number.isFinite(Number(overrideX)) ? Number(overrideX) : base.x;
    const finalY = Number.isFinite(Number(overrideY)) ? Number(overrideY) : base.y;

    return {
      ...base,
      x: finalX,
      y: finalY,
      offsetX: Number.isFinite(Number(offsetX)) ? Number(offsetX) : DEFAULT_OFFSETS.x,
      offsetY: Number.isFinite(Number(offsetY)) ? Number(offsetY) : DEFAULT_OFFSETS.y
    };
  }

  async function resolvePlayContext(options = {}) {
    const target = await resolveActiveTarget();
    return buildPlayContext(target, options);
  }

  function getSnapshot() {
    return {
      installed: true,
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      isGM: !!game.user?.isGM,
      canvasReady: !!canvas?.ready,
      sceneId: canvas?.scene?.id ?? null,
      sceneName: canvas?.scene?.name ?? null,
      cameraFollowMode: isCameraFollowModeActive(canvas?.scene ?? null),
      defaultOffsets: deepClone(DEFAULT_OFFSETS)
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    DEFAULT_OFFSETS,

    getSceneCameraFollowEnabled,
    isCameraFollowModeActive,

    getControlledTokens,
    getFirstControlledToken,
    getGmSelectedToken,

    findTokenByActorOnCanvas,
    getTokenDescriptor,

    resolveGmSelectedToken,
    resolveCameraFollowCentralToken,
    resolveLinkedActorToken,

    resolveActiveTarget,
    canCurrentUserUseEmotes,

    buildPlayContext,
    resolvePlayContext,

    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteResolver = api;
    } catch (err) {
      console.warn("[Emote:Resolver] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Bootstrap", "emote-resolver.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      isGM: !!game.user?.isGM,
      cameraFollowMode: isCameraFollowModeActive(canvas?.scene ?? null)
    });
  });
})();