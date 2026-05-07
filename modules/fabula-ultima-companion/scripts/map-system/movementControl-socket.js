/**
 * movementControl-socket.js
 * Fabula Ultima Companion - Movement Control System Socket Layer
 * Foundry VTT v12
 *
 * Purpose:
 * - Provide a shared multi-client socket bus for the Movement Control system
 * - Route Movement Control messages through the fabula-ultima-companion socket
 * - Give future API / bootstrap / UI scripts a clean way to:
 *   - send requests to the active GM
 *   - broadcast refresh/state updates to all clients
 *   - register per-message-type handlers
 *
 * Socket channel used:
 *   game.socket.on("module.fabula-ultima-companion", ...)
 *
 * Notes:
 * - This script does NOT directly write controller state.
 * - It is a transport layer only.
 * - Future scripts will register handlers for the message types they need.
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_SOCKET__
 *
 * API:
 *   FUCompanion.api.MovementControlSocket
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_SOCKET__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";
  const SOCKET_NAME = `module.${MODULE_ID}`;

  const MESSAGE_TYPES = Object.freeze({
    REQUEST_PASS_CONTROLLER: "REQUEST_PASS_CONTROLLER",
    REQUEST_REFRESH: "REQUEST_REFRESH",
    REQUEST_SYNC_STATE: "REQUEST_SYNC_STATE",

    BROADCAST_REFRESH: "BROADCAST_REFRESH",
    BROADCAST_STATE_UPDATED: "BROADCAST_STATE_UPDATED",
    BROADCAST_DEBUG: "BROADCAST_DEBUG",

    ACK: "ACK",
    ERROR: "ERROR"
  });

  const state = {
    installed: true,
    ready: false,
    handlers: new Map(), // Map<type, Set<fn>>
    receiveBound: null
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

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
  }

  function makeRequestId(prefix = "mc") {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now()}-${rand}`;
  }

  function getActiveUsers() {
    return Array.from(game.users ?? []).filter(u => !!u.active);
  }

  function getActiveGMs() {
    return getActiveUsers()
      .filter(u => !!u.isGM)
      .sort((a, b) => cleanString(a.id).localeCompare(cleanString(b.id)));
  }

  function getPrimaryGM() {
    return getActiveGMs()[0] ?? null;
  }

  function isCurrentUserPrimaryGM() {
    const gm = getPrimaryGM();
    return !!gm && gm.id === game.user?.id;
  }

  function isEnvelopeForThisSystem(envelope) {
    return cleanString(envelope?.systemId) === SYSTEM_ID;
  }

  function getEnvelopeTargets(envelope) {
    const targetUserIds = toArray(envelope?.targetUserIds)
      .map(cleanString)
      .filter(Boolean);

    const single = cleanString(envelope?.targetUserId);
    if (single) targetUserIds.push(single);

    return Array.from(new Set(targetUserIds));
  }

  function isAddressedToMe(envelope) {
    const targets = getEnvelopeTargets(envelope);
    if (targets.length === 0) return true;
    return targets.includes(game.user?.id ?? "");
  }

  function buildEnvelope(type, payload = {}, {
    targetUserId = null,
    targetUserIds = null,
    requestId = null,
    replyToRequestId = null
  } = {}) {
    const targets = [
      ...toArray(targetUserIds),
      ...(targetUserId != null ? [targetUserId] : [])
    ]
      .map(cleanString)
      .filter(Boolean);

    return {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      type: cleanString(type),
      requestId: cleanString(requestId) || makeRequestId("mc"),
      replyToRequestId: cleanString(replyToRequestId) || null,

      senderUserId: game.user?.id ?? null,
      senderUserName: game.user?.name ?? null,
      senderIsGM: !!game.user?.isGM,

      targetUserIds: Array.from(new Set(targets)),
      payload: payload ?? {},

      sentAt: Date.now()
    };
  }

  function getHandlers(type) {
    const key = cleanString(type);
    if (!state.handlers.has(key)) {
      state.handlers.set(key, new Set());
    }
    return state.handlers.get(key);
  }

  function on(type, handler) {
    const key = cleanString(type);
    if (!key || typeof handler !== "function") {
      DBG.warn("Socket", "on() ignored because type or handler was invalid", { type, handlerType: typeof handler });
      return () => {};
    }

    const set = getHandlers(key);
    set.add(handler);

    DBG.verbose("Socket", "Registered socket handler", {
      type: key,
      handlerCount: set.size
    });

    return () => off(key, handler);
  }

  function off(type, handler) {
    const key = cleanString(type);
    const set = state.handlers.get(key);
    if (!set) return false;

    const removed = set.delete(handler);
    if (set.size === 0) {
      state.handlers.delete(key);
    }

    DBG.verbose("Socket", "Removed socket handler", {
      type: key,
      removed,
      remaining: set.size
    });

    return removed;
  }

  async function emitRaw(envelope) {
    if (!game.socket) {
      DBG.warn("Socket", "emitRaw failed because game.socket is unavailable", { envelope });
      return false;
    }

    try {
      game.socket.emit(SOCKET_NAME, envelope);

      DBG.groupCollapsed("Socket", "Socket emit", {
        socketName: SOCKET_NAME,
        envelope
      });

      return true;
    } catch (err) {
      DBG.error("Socket", "Socket emit failed", {
        socketName: SOCKET_NAME,
        envelope,
        error: err?.message ?? err
      });
      return false;
    }
  }

  async function emit(type, payload = {}, options = {}) {
    const envelope = buildEnvelope(type, payload, options);
    return await emitRaw(envelope);
  }

  async function broadcast(type, payload = {}, options = {}) {
    return await emit(type, payload, {
      ...options,
      targetUserId: null,
      targetUserIds: null
    });
  }

  async function sendToUser(userId, type, payload = {}, options = {}) {
    const cleanUserId = cleanString(userId);
    if (!cleanUserId) {
      DBG.warn("Socket", "sendToUser ignored because userId was empty", { type, payload });
      return false;
    }

    return await emit(type, payload, {
      ...options,
      targetUserId: cleanUserId
    });
  }

  async function sendToUsers(userIds, type, payload = {}, options = {}) {
    const ids = toArray(userIds).map(cleanString).filter(Boolean);
    if (ids.length === 0) {
      DBG.warn("Socket", "sendToUsers ignored because no valid userIds were provided", { type, payload });
      return false;
    }

    return await emit(type, payload, {
      ...options,
      targetUserIds: ids
    });
  }

  async function sendToGM(type, payload = {}, options = {}) {
    const gm = getPrimaryGM();
    if (!gm) {
      DBG.warn("Socket", "sendToGM failed because no active GM was found", { type, payload });
      return false;
    }

    return await sendToUser(gm.id, type, payload, options);
  }

  async function replyTo(envelope, type, payload = {}, options = {}) {
    if (!envelope?.senderUserId) {
      DBG.warn("Socket", "replyTo ignored because source envelope had no senderUserId", { envelope, type, payload });
      return false;
    }

    return await sendToUser(envelope.senderUserId, type, payload, {
      ...options,
      replyToRequestId: envelope.requestId ?? null
    });
  }

  async function requestPassController(targetUserId, extraPayload = {}) {
    return await sendToGM(MESSAGE_TYPES.REQUEST_PASS_CONTROLLER, {
      targetUserId: cleanString(targetUserId) || null,
      ...extraPayload
    });
  }

  async function requestRefresh(extraPayload = {}) {
    return await sendToGM(MESSAGE_TYPES.REQUEST_REFRESH, extraPayload);
  }

  async function requestSyncState(extraPayload = {}) {
    return await sendToGM(MESSAGE_TYPES.REQUEST_SYNC_STATE, extraPayload);
  }

  async function broadcastRefresh(extraPayload = {}) {
    return await broadcast(MESSAGE_TYPES.BROADCAST_REFRESH, extraPayload);
  }

  async function broadcastStateUpdated(extraPayload = {}) {
    return await broadcast(MESSAGE_TYPES.BROADCAST_STATE_UPDATED, extraPayload);
  }

  async function dispatchToHandlers(envelope) {
    const type = cleanString(envelope?.type);
    if (!type) return;

    const handlers = Array.from(getHandlers(type));
    if (handlers.length === 0) {
      DBG.verbose("Socket", "No handlers registered for incoming socket message", {
        type,
        requestId: envelope?.requestId ?? null
      });
      return;
    }

    DBG.groupCollapsed("Socket", "Dispatching incoming socket message", {
      type,
      handlerCount: handlers.length,
      requestId: envelope?.requestId ?? null,
      senderUserId: envelope?.senderUserId ?? null,
      senderUserName: envelope?.senderUserName ?? null,
      targetUserIds: envelope?.targetUserIds ?? [],
      payload: envelope?.payload ?? {}
    });

    for (const handler of handlers) {
      try {
        const result = handler(envelope);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        DBG.error("Socket", "Socket handler threw an error", {
          type,
          requestId: envelope?.requestId ?? null,
          error: err?.message ?? err
        });
      }
    }
  }

  async function receiveSocketMessage(envelope) {
    try {
      if (!isEnvelopeForThisSystem(envelope)) return;
      if (!isAddressedToMe(envelope)) return;

      DBG.verbose("Socket", "Received Movement Control socket message", {
        type: envelope?.type ?? null,
        requestId: envelope?.requestId ?? null,
        replyToRequestId: envelope?.replyToRequestId ?? null,
        senderUserId: envelope?.senderUserId ?? null,
        senderUserName: envelope?.senderUserName ?? null,
        targetUserIds: envelope?.targetUserIds ?? []
      });

      await dispatchToHandlers(envelope);
    } catch (err) {
      DBG.error("Socket", "receiveSocketMessage failed", {
        envelope,
        error: err?.message ?? err
      });
    }
  }

  function installSocketListener() {
    if (state.receiveBound) return;

    state.receiveBound = receiveSocketMessage;
    game.socket.on(SOCKET_NAME, state.receiveBound);

    DBG.info("Socket", "Installed Movement Control socket listener", {
      socketName: SOCKET_NAME
    });
  }

  function uninstallSocketListener() {
    if (!state.receiveBound || !game.socket) return;

    game.socket.off(SOCKET_NAME, state.receiveBound);
    state.receiveBound = null;

    DBG.info("Socket", "Removed Movement Control socket listener", {
      socketName: SOCKET_NAME
    });
  }

  function getSnapshot() {
    return {
      installed: true,
      ready: state.ready,
      socketName: SOCKET_NAME,
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      currentUserIsGM: !!game.user?.isGM,
      primaryGMUserId: getPrimaryGM()?.id ?? null,
      primaryGMUserName: getPrimaryGM()?.name ?? null,
      handlerTypes: Array.from(state.handlers.keys())
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    SOCKET_NAME,
    MESSAGE_TYPES,

    getActiveUsers,
    getActiveGMs,
    getPrimaryGM,
    isCurrentUserPrimaryGM,

    buildEnvelope,
    isEnvelopeForThisSystem,
    isAddressedToMe,

    on,
    off,

    emitRaw,
    emit,
    broadcast,
    sendToUser,
    sendToUsers,
    sendToGM,
    replyTo,

    requestPassController,
    requestRefresh,
    requestSyncState,
    broadcastRefresh,
    broadcastStateUpdated,

    installSocketListener,
    uninstallSocketListener,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      installSocketListener();
      state.ready = true;
    } catch (err) {
      DBG.error("Socket", "Failed to install Movement Control socket listener during ready", {
        error: err?.message ?? err
      });
    }

    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlSocket = api;
    } catch (err) {
      console.warn("[MovementControl:Socket] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Socket", "movementControl-socket.js ready", getSnapshot());
  });

  Hooks.once("shutdown", () => {
    try {
      uninstallSocketListener();
    } catch (err) {
      DBG.warn("Socket", "Error while removing socket listener during shutdown", {
        error: err?.message ?? err
      });
    }
  });
})();
