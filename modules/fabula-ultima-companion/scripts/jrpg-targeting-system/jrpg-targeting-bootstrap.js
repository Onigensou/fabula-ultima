// ============================================
// JRPG Targeting System - Bootstrap / Public API
// File: jrpg-targeting-bootstrap.js
// Foundry VTT V12
// ============================================

import {
  GLOBALS,
  MODULE_ID,
  SOCKET
} from "./jrpg-targeting-constants.js";

import {
  createJRPGTargetingDebugger,
  makeJRPGTargetingRunId,
  setJRPGTargetingDebugEnabled,
  isJRPGTargetingDebugEnabled
} from "./jrpg-targeting-debug.js";

import {
  getJRPGSkillTargetFromAction,
  parseJRPGTargetingFromAction,
  parseJRPGTargetingText
} from "./jrpg-targeting-parser.js";

import {
  clearJRPGActiveTargetingSession,
  clearJRPGLastTargetingResult,
  getJRPGActiveTargetingSession,
  getJRPGLastTargetingResult,
  getJRPGLastTargetingResultsMap,
  getJRPGTargetingStoreSnapshot,
  initializeJRPGTargetingStore
} from "./jrpg-targeting-store.js";

import {
  destroyActiveJRPGTargetingUI,
  getActiveJRPGTargetingUI,
  getJRPGTargetingUIRegistrySnapshot
} from "./jrpg-targeting-ui.js";

import {
  clearJRPGTargetingHighlight
} from "./jrpg-targeting-highlight.js";

import {
  createJRPGTargetingSession
} from "./jrpg-targeting-session.js";

const dbg = createJRPGTargetingDebugger("Bootstrap");

/* -------------------------------------------- */
/* Internal state                               */
/* -------------------------------------------- */

function ensureBootstrapState() {
  if (!globalThis[GLOBALS.API_KEY]) {
    globalThis[GLOBALS.API_KEY] = {};
  }

  if (!globalThis.__ONI_JRPG_TARGETING_BOOTSTRAP__) {
    globalThis.__ONI_JRPG_TARGETING_BOOTSTRAP__ = {
      socketInstalled: false,
      apiInstalled: false,
      pendingRequests: {},
      activeLocalSessions: {}
    };

    dbg.log("BOOTSTRAP STATE CREATED");
  }

  return globalThis.__ONI_JRPG_TARGETING_BOOTSTRAP__;
}

function getBootstrapState() {
  return ensureBootstrapState();
}

function getCurrentUserId() {
  return game.user?.id ?? null;
}

function clonePlain(value) {
  try {
    return foundry?.utils?.deepClone
      ? foundry.utils.deepClone(value)
      : JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

function toSocketChannel() {
  return SOCKET.CHANNEL || `module.${MODULE_ID}`;
}

function buildSocketEnvelope(event, payload = {}) {
  return {
    ns: SOCKET.NAMESPACE,
    event,
    payload,
    senderUserId: getCurrentUserId(),
    timestamp: Date.now()
  };
}

function emitSocketEvent(event, payload = {}) {
  const channel = toSocketChannel();
  const envelope = buildSocketEnvelope(event, payload);

  dbg.log("SOCKET EMIT", {
    channel,
    event,
    payload
  });

  game.socket.emit(channel, envelope);
}

function registerPendingRequest(requestId, resolver) {
  const state = getBootstrapState();
  state.pendingRequests[requestId] = resolver;

  dbg.log("PENDING REQUEST REGISTERED", {
    requestId,
    pendingCount: Object.keys(state.pendingRequests).length
  });
}

function resolvePendingRequest(requestId, result) {
  const state = getBootstrapState();
  const resolver = state.pendingRequests[requestId];

  if (!resolver) {
    dbg.warn("PENDING REQUEST NOT FOUND", { requestId, result });
    return false;
  }

  delete state.pendingRequests[requestId];
  resolver(result);

  dbg.log("PENDING REQUEST RESOLVED", {
    requestId,
    pendingCount: Object.keys(state.pendingRequests).length,
    status: result?.status
  });

  return true;
}

function unregisterPendingRequest(requestId) {
  const state = getBootstrapState();
  delete state.pendingRequests[requestId];

  dbg.log("PENDING REQUEST UNREGISTERED", {
    requestId,
    pendingCount: Object.keys(state.pendingRequests).length
  });
}

function registerActiveLocalSession(session) {
  const state = getBootstrapState();
  state.activeLocalSessions[session.sessionId] = session;

  dbg.logRun(session.runId, "LOCAL SESSION REGISTERED", {
    sessionId: session.sessionId
  });
}

function unregisterActiveLocalSession(sessionId) {
  const state = getBootstrapState();
  delete state.activeLocalSessions[sessionId];

  dbg.log("LOCAL SESSION UNREGISTERED", { sessionId });
}

function getActiveLocalSession(sessionId) {
  const state = getBootstrapState();
  return state.activeLocalSessions[sessionId] ?? null;
}

/* -------------------------------------------- */
/* Session launch helpers                       */
/* -------------------------------------------- */

async function runLocalTargetingSession(options = {}) {
  const runId = makeJRPGTargetingRunId("BOOT-LOCAL");
  const session = createJRPGTargetingSession(options);

  dbg.logRun(runId, "RUN LOCAL SESSION START", {
    sessionId: session.sessionId,
    userId: options.userId,
    rawSkillTarget: options.skillTarget,
    hasHighlightSettings: Boolean(options.highlightSettings)
  });

  registerActiveLocalSession(session);

  try {
    const result = await session.start();

    dbg.logRun(runId, "RUN LOCAL SESSION END", {
      sessionId: session.sessionId,
      status: result?.status,
      selectedCount: result?.selectedCount
    });

    return result;
  } finally {
    unregisterActiveLocalSession(session.sessionId);
  }
}

async function runRemoteTargetingRequest(options = {}) {
  const requestId = options.requestId || makeJRPGTargetingRunId("REQ");
  const targetUserId = options.userId;

  const payload = {
    requestId,
    requesterUserId: getCurrentUserId(),
    userId: targetUserId,
    sessionId: options.sessionId || makeJRPGTargetingRunId("TGT"),
    skillTarget: options.skillTarget ?? "",
    parsedTargeting: options.parsedTargeting ?? null,
    action: options.action ?? null,
    sourceActorUuid: options.sourceActorUuid ?? null,
    allowedTargetTokenUuids: options.allowedTargetTokenUuids ?? [],
    uiSettings: options.uiSettings ?? {},
    highlightSettings: options.highlightSettings ?? {},
    uiTitleText: options.uiTitleText ?? null
  };

  dbg.log("RUN REMOTE REQUEST START", payload);

  return await new Promise((resolve) => {
    registerPendingRequest(requestId, resolve);
    emitSocketEvent(SOCKET.EVENTS.START_TARGETING, payload);
  });
}

/* -------------------------------------------- */
/* Socket handlers                              */
/* -------------------------------------------- */

async function onSocketStartTargeting(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-START");

  dbg.logRun(runId, "SOCKET START RECEIVED", payload);

  if (!payload?.userId || payload.userId !== getCurrentUserId()) {
    dbg.logRun(runId, "IGNORED - NOT FOR THIS USER", {
      targetUserId: payload?.userId,
      currentUserId: getCurrentUserId()
    });
    return;
  }

  const sessionOptions = {
    sessionId: payload.sessionId,
    userId: payload.userId,
    action: payload.action ?? null,
    skillTarget: payload.skillTarget ?? "",
    parsedTargeting: payload.parsedTargeting ?? null,
    sourceActorUuid: payload.sourceActorUuid ?? null,
    allowedTargetTokenUuids: payload.allowedTargetTokenUuids ?? [],
    uiSettings: payload.uiSettings ?? {},
    highlightSettings: payload.highlightSettings ?? {},
    uiTitleText: payload.uiTitleText ?? null
  };

  let result = null;

  try {
    result = await runLocalTargetingSession(sessionOptions);
  } catch (err) {
    dbg.errorRun(runId, "REMOTE SESSION FAILED", err);

    result = {
      ok: false,
      confirmed: false,
      cancelled: true,
      status: "cancelled",
      error: String(err?.message ?? err),
      sessionId: payload.sessionId ?? null,
      userId: payload.userId ?? null,
      requesterUserId: payload.requesterUserId ?? null,
      requestId: payload.requestId ?? null,
      rawSkillTarget: payload.skillTarget ?? "",
      normalizedSkillTarget: payload.parsedTargeting?.normalized ?? "",
      mode: payload.parsedTargeting?.mode ?? null,
      category: payload.parsedTargeting?.category ?? null,
      promptText: payload.parsedTargeting?.promptText ?? "",
      selectedCount: 0,
      tokens: [],
      actors: [],
      tokenUuids: [],
      actorUuids: []
    };
  }

  const outbound = {
    ...clonePlain(result),
    requestId: payload.requestId ?? null,
    requesterUserId: payload.requesterUserId ?? null,
    userId: payload.userId ?? null,
    sessionId: payload.sessionId ?? result?.sessionId ?? null
  };

  if (outbound.status === "confirmed") {
    emitSocketEvent(SOCKET.EVENTS.CONFIRM_TARGETING, outbound);
  } else {
    emitSocketEvent(SOCKET.EVENTS.CANCEL_TARGETING, outbound);
  }
}

function onSocketConfirmTargeting(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-CONFIRM");

  dbg.logRun(runId, "SOCKET CONFIRM RECEIVED", payload);

  if (!payload?.requestId) {
    dbg.warnRun(runId, "MISSING requestId");
    return;
  }

  if (payload?.requesterUserId && payload.requesterUserId !== getCurrentUserId()) {
    dbg.logRun(runId, "IGNORED - NOT REQUESTER", {
      requesterUserId: payload.requesterUserId,
      currentUserId: getCurrentUserId()
    });
    return;
  }

  resolvePendingRequest(payload.requestId, clonePlain(payload));
}

function onSocketCancelTargeting(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-CANCEL");

  dbg.logRun(runId, "SOCKET CANCEL RECEIVED", payload);

  if (!payload?.requestId) {
    dbg.warnRun(runId, "MISSING requestId");
    return;
  }

  if (payload?.requesterUserId && payload.requesterUserId !== getCurrentUserId()) {
    dbg.logRun(runId, "IGNORED - NOT REQUESTER", {
      requesterUserId: payload.requesterUserId,
      currentUserId: getCurrentUserId()
    });
    return;
  }

  resolvePendingRequest(payload.requestId, clonePlain(payload));
}

async function onSocketForceClose(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-FORCECLOSE");

  dbg.logRun(runId, "SOCKET FORCE CLOSE RECEIVED", payload);

  const session = getActiveLocalSession(payload?.sessionId) ?? globalThis[GLOBALS.ACTIVE_SESSION_KEY] ?? null;

  if (session?.userId === getCurrentUserId()) {
    try {
      await session.cancel("force_close");
    } catch (err) {
      dbg.errorRun(runId, "SESSION FORCE CLOSE FAILED", err);
    }
  } else {
    await destroyActiveJRPGTargetingUI({ animate: false }).catch(() => {});
    await clearJRPGTargetingHighlight({
      reason: "socket_force_close_fallback",
      runId
    }).catch(() => {});
    clearJRPGActiveTargetingSession();
  }
}

async function onSocketUIShow(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-UISHOW");
  dbg.logRun(runId, "UI_SHOW RECEIVED", payload);
  // Reserved hook for later expansion.
}

async function onSocketUIHide(payload = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-UIHIDE");
  dbg.logRun(runId, "UI_HIDE RECEIVED", payload);
  // Reserved hook for later expansion.
}

function routeSocketMessage(message = {}) {
  const runId = makeJRPGTargetingRunId("SOCKET-ROUTE");

  if (!message || message.ns !== SOCKET.NAMESPACE) return;

  dbg.logRun(runId, "SOCKET ROUTE", message);

  switch (message.event) {
    case SOCKET.EVENTS.START_TARGETING:
      void onSocketStartTargeting(message.payload);
      break;

    case SOCKET.EVENTS.CONFIRM_TARGETING:
      onSocketConfirmTargeting(message.payload);
      break;

    case SOCKET.EVENTS.CANCEL_TARGETING:
      onSocketCancelTargeting(message.payload);
      break;

    case SOCKET.EVENTS.FORCE_CLOSE:
      void onSocketForceClose(message.payload);
      break;

    case SOCKET.EVENTS.UI_SHOW:
      void onSocketUIShow(message.payload);
      break;

    case SOCKET.EVENTS.UI_HIDE:
      void onSocketUIHide(message.payload);
      break;

    default:
      dbg.warnRun(runId, "UNKNOWN SOCKET EVENT", {
        event: message.event
      });
      break;
  }
}

function installSocketListener() {
  const state = getBootstrapState();
  if (state.socketInstalled) return;

  const channel = toSocketChannel();
  game.socket.on(channel, routeSocketMessage);

  state.socketInstalled = true;

  dbg.log("SOCKET LISTENER INSTALLED", { channel });
}

/* -------------------------------------------- */
/* Public API                                   */
/* -------------------------------------------- */

function buildPublicAPI() {
  return {
    version: "1.0.0",

    async requestTargeting(options = {}) {
      const runId = makeJRPGTargetingRunId("API-REQUEST");

      const userId = options.userId ?? getCurrentUserId();
      const parsedTargeting = options.parsedTargeting
        ?? (options.action ? parseJRPGTargetingFromAction(options.action) : parseJRPGTargetingText(options.skillTarget ?? ""));
      const skillTarget = typeof options.skillTarget === "string"
        ? options.skillTarget
        : (options.action ? getJRPGSkillTargetFromAction(options.action) : "");

      const requestOptions = {
        requestId: options.requestId || makeJRPGTargetingRunId("REQ"),
        sessionId: options.sessionId || makeJRPGTargetingRunId("TGT"),
        userId,
        action: options.action ?? null,
        sourceActorUuid: options.sourceActorUuid ?? null,
        allowedTargetTokenUuids: options.allowedTargetTokenUuids ?? [],
        skillTarget,
        parsedTargeting,
        uiSettings: options.uiSettings ?? {},
        highlightSettings: options.highlightSettings ?? {},
        uiTitleText: options.uiTitleText ?? parsedTargeting?.promptText ?? null
      };

      dbg.logRun(runId, "API requestTargeting START", requestOptions);

      if (userId === getCurrentUserId()) {
        const result = await runLocalTargetingSession(requestOptions);
        dbg.logRun(runId, "API requestTargeting LOCAL RESULT", result);
        return result;
      }

      const result = await runRemoteTargetingRequest(requestOptions);
      dbg.logRun(runId, "API requestTargeting REMOTE RESULT", result);
      return result;
    },

    async startLocalTargeting(options = {}) {
      const userId = options.userId ?? getCurrentUserId();
      return await this.requestTargeting({
        ...options,
        userId
      });
    },

    forceClose(sessionId = null, userId = null) {
      emitSocketEvent(SOCKET.EVENTS.FORCE_CLOSE, {
        sessionId,
        userId
      });
    },

    parseTargetingText(text = "") {
      return parseJRPGTargetingText(text);
    },

    parseTargetingFromAction(action = null) {
      return parseJRPGTargetingFromAction(action);
    },

    getSkillTargetFromAction(action = null) {
      return getJRPGSkillTargetFromAction(action);
    },

    getLastResult(userId = getCurrentUserId()) {
      return getJRPGLastTargetingResult(userId);
    },

    clearLastResult(userId = getCurrentUserId()) {
      return clearJRPGLastTargetingResult(userId);
    },

    getActiveSession() {
      return getJRPGActiveTargetingSession();
    },

    getActiveUI() {
      return getActiveJRPGTargetingUI();
    },

    getStoreSnapshot() {
      return getJRPGTargetingStoreSnapshot();
    },

    getResultsMap() {
      return getJRPGLastTargetingResultsMap();
    },

    getUISnapshot() {
      return getJRPGTargetingUIRegistrySnapshot();
    },

    setDebug(enabled) {
      return setJRPGTargetingDebugEnabled(enabled);
    },

    isDebugEnabled() {
      return isJRPGTargetingDebugEnabled();
    }
  };
}

function installPublicAPI() {
  const state = getBootstrapState();
  if (state.apiInstalled) return;

  const api = buildPublicAPI();

  globalThis[GLOBALS.API_KEY] = api;

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = module.api || {};
    module.api.JRPGTargeting = api;
  }

  state.apiInstalled = true;

  dbg.log("PUBLIC API INSTALLED", {
    globalKey: GLOBALS.API_KEY,
    moduleId: MODULE_ID
  });
}

/* -------------------------------------------- */
/* Foundry lifecycle                            */
/* -------------------------------------------- */

Hooks.once("init", () => {
  initializeJRPGTargetingStore();
  ensureBootstrapState();
  dbg.log("INIT");
});

Hooks.once("setup", () => {
  installPublicAPI();
  dbg.log("SETUP");
});

Hooks.once("ready", () => {
  installSocketListener();
  dbg.log("READY");
});

export default {
  installPublicAPI,
  installSocketListener
};
