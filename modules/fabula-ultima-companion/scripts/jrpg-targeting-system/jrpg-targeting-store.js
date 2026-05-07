// ============================================
// JRPG Targeting System - Runtime Store
// File: jrpg-targeting-store.js
// Foundry VTT V12
// ============================================

import {
  GLOBALS,
  RESULT_STATUS,
  TARGET_CATEGORIES
} from "./jrpg-targeting-constants.js";

import { createJRPGTargetingDebugger } from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("Store");

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function createEmptyRuntimeStore() {
  return {
    activeSession: null,
    lastResultByUser: {},
    sessionByUser: {}
  };
}

function ensureRuntimeStore() {
  if (!globalThis[GLOBALS.STORE_KEY]) {
    globalThis[GLOBALS.STORE_KEY] = createEmptyRuntimeStore();
    dbg.log("INIT STORE", globalThis[GLOBALS.STORE_KEY]);
  }

  return globalThis[GLOBALS.STORE_KEY];
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

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (typeof value[Symbol.iterator] === "function") return Array.from(value);
  return [value];
}

function compactArray(value) {
  return toArray(value).filter(Boolean);
}

function getTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function getTokenActor(token) {
  return token?.actor ?? token?.document?.actor ?? null;
}

function getTokenUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function getActorUuid(actor) {
  return actor?.uuid ?? null;
}

function getTokenId(token) {
  return token?.id ?? token?.document?.id ?? null;
}

function getActorId(actor) {
  return actor?.id ?? null;
}

function getTokenName(token) {
  return token?.name ?? token?.document?.name ?? token?.actor?.name ?? "(Unknown Token)";
}

function getActorName(actor) {
  return actor?.name ?? "(Unknown Actor)";
}

function buildStoredTokenRecord(token) {
  const doc = getTokenDocument(token);
  const actor = getTokenActor(token);

  return {
    id: getTokenId(doc),
    uuid: getTokenUuid(doc),
    name: getTokenName(doc),
    actorId: getActorId(actor),
    actorUuid: getActorUuid(actor),
    actorName: getActorName(actor),
    sceneId: doc?.parent?.id ?? doc?.scene?.id ?? null,
    disposition: doc?.disposition ?? null
  };
}

function buildStoredActorRecord(actor) {
  return {
    id: getActorId(actor),
    uuid: getActorUuid(actor),
    name: getActorName(actor),
    type: actor?.type ?? null
  };
}

function uniqueByUuid(records = []) {
  const map = new Map();

  for (const record of compactArray(records)) {
    const uuid = record?.uuid ?? null;
    if (!uuid) continue;
    if (!map.has(uuid)) map.set(uuid, record);
  }

  return Array.from(map.values());
}

function extractActorsFromTokens(tokens = []) {
  return compactArray(tokens)
    .map((token) => getTokenActor(token))
    .filter(Boolean);
}

function buildStoredResult(payload = {}) {
  const tokens = compactArray(payload.tokens);
  const actors = compactArray(payload.actors).length
    ? compactArray(payload.actors)
    : extractActorsFromTokens(tokens);

  const storedTokens = uniqueByUuid(tokens.map(buildStoredTokenRecord));
  const storedActors = uniqueByUuid(actors.map(buildStoredActorRecord));

  return {
    sessionId: payload.sessionId ?? null,
    userId: payload.userId ?? null,
    status: payload.status ?? RESULT_STATUS.CONFIRMED,
    confirmed: payload.status === RESULT_STATUS.CONFIRMED,
    cancelled: payload.status === RESULT_STATUS.CANCELLED,

    rawSkillTarget: payload.rawSkillTarget ?? "",
    normalizedSkillTarget: payload.normalizedSkillTarget ?? "",
    mode: payload.mode ?? null,
    category: payload.category ?? TARGET_CATEGORIES.CREATURE,

    promptText: payload.promptText ?? "",
    selectedCount: storedTokens.length,

    actorIds: storedActors.map((a) => a.id).filter(Boolean),
    actorUuids: storedActors.map((a) => a.uuid).filter(Boolean),
    tokenIds: storedTokens.map((t) => t.id).filter(Boolean),
    tokenUuids: storedTokens.map((t) => t.uuid).filter(Boolean),

    actors: storedActors,
    tokens: storedTokens,

    createdAt: Date.now()
  };
}

/* -------------------------------------------- */
/* Base accessors                               */
/* -------------------------------------------- */

export function initializeJRPGTargetingStore() {
  return ensureRuntimeStore();
}

export function getJRPGTargetingStore() {
  return ensureRuntimeStore();
}

export function clearJRPGTargetingStore() {
  const runId = dbg.makeRunId("CLEAR-STORE");
  globalThis[GLOBALS.STORE_KEY] = createEmptyRuntimeStore();
  dbg.logRun(runId, "STORE CLEARED", globalThis[GLOBALS.STORE_KEY]);
  return getJRPGTargetingStore();
}

/* -------------------------------------------- */
/* Active session                               */
/* -------------------------------------------- */

export function setJRPGActiveTargetingSession(sessionData = null) {
  const runId = dbg.makeRunId("SET-ACTIVE");
  const store = ensureRuntimeStore();

  store.activeSession = sessionData ? clonePlain(sessionData) : null;

  dbg.logRun(runId, "ACTIVE SESSION SET", {
    activeSession: store.activeSession
  });

  return store.activeSession;
}

export function getJRPGActiveTargetingSession() {
  return ensureRuntimeStore().activeSession ?? null;
}

export function clearJRPGActiveTargetingSession() {
  const runId = dbg.makeRunId("CLEAR-ACTIVE");
  const store = ensureRuntimeStore();

  store.activeSession = null;

  dbg.logRun(runId, "ACTIVE SESSION CLEARED");
  return null;
}

/* -------------------------------------------- */
/* Per-user session                             */
/* -------------------------------------------- */

export function setJRPGTargetingSessionForUser(userId, sessionData = null) {
  const runId = dbg.makeRunId("SET-USER-SESSION");
  const store = ensureRuntimeStore();
  const key = String(userId ?? "").trim();

  if (!key) {
    dbg.warnRun(runId, "ABORT - Missing userId");
    return null;
  }

  if (sessionData) {
    store.sessionByUser[key] = clonePlain(sessionData);
  } else {
    delete store.sessionByUser[key];
  }

  dbg.logRun(runId, "USER SESSION SET", {
    userId: key,
    session: store.sessionByUser[key] ?? null
  });

  return store.sessionByUser[key] ?? null;
}

export function getJRPGTargetingSessionForUser(userId) {
  const key = String(userId ?? "").trim();
  if (!key) return null;
  return ensureRuntimeStore().sessionByUser[key] ?? null;
}

export function clearJRPGTargetingSessionForUser(userId) {
  return setJRPGTargetingSessionForUser(userId, null);
}

/* -------------------------------------------- */
/* Last result                                  */
/* -------------------------------------------- */

export function setJRPGLastTargetingResult(userId, resultPayload = {}) {
  const runId = dbg.makeRunId("SET-RESULT");
  const store = ensureRuntimeStore();
  const key = String(userId ?? resultPayload?.userId ?? "").trim();

  if (!key) {
    dbg.warnRun(runId, "ABORT - Missing userId", { resultPayload });
    return null;
  }

  const storedResult = buildStoredResult({
    ...resultPayload,
    userId: key
  });

  // Overwrite any previous result for this user, as requested.
  store.lastResultByUser[key] = storedResult;

  dbg.logRun(runId, "LAST RESULT SET", {
    userId: key,
    sessionId: storedResult.sessionId,
    status: storedResult.status,
    selectedCount: storedResult.selectedCount,
    tokenNames: storedResult.tokens.map((t) => t.name)
  });

  return clonePlain(storedResult);
}

export function getJRPGLastTargetingResult(userId) {
  const key = String(userId ?? "").trim();
  if (!key) return null;

  const result = ensureRuntimeStore().lastResultByUser[key] ?? null;
  return result ? clonePlain(result) : null;
}

export function clearJRPGLastTargetingResult(userId) {
  const runId = dbg.makeRunId("CLEAR-RESULT");
  const store = ensureRuntimeStore();
  const key = String(userId ?? "").trim();

  if (!key) {
    dbg.warnRun(runId, "ABORT - Missing userId");
    return null;
  }

  delete store.lastResultByUser[key];

  dbg.logRun(runId, "LAST RESULT CLEARED", { userId: key });
  return null;
}

/* -------------------------------------------- */
/* Convenience result builders                  */
/* -------------------------------------------- */

export function storeJRPGConfirmedTargets({
  userId,
  sessionId = null,
  parsedTargeting = null,
  rawSkillTarget = "",
  normalizedSkillTarget = "",
  promptText = "",
  tokens = [],
  actors = []
} = {}) {
  const runId = dbg.makeRunId("STORE-CONFIRMED");

  const result = setJRPGLastTargetingResult(userId, {
    sessionId,
    userId,
    status: RESULT_STATUS.CONFIRMED,
    rawSkillTarget,
    normalizedSkillTarget,
    mode: parsedTargeting?.mode ?? null,
    category: parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE,
    promptText: promptText || parsedTargeting?.promptText || "",
    tokens,
    actors
  });

  dbg.logRun(runId, "CONFIRMED TARGETS STORED", result);
  return result;
}

export function storeJRPGCancelledTargets({
  userId,
  sessionId = null,
  parsedTargeting = null,
  rawSkillTarget = "",
  normalizedSkillTarget = "",
  promptText = ""
} = {}) {
  const runId = dbg.makeRunId("STORE-CANCELLED");

  const result = setJRPGLastTargetingResult(userId, {
    sessionId,
    userId,
    status: RESULT_STATUS.CANCELLED,
    rawSkillTarget,
    normalizedSkillTarget,
    mode: parsedTargeting?.mode ?? null,
    category: parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE,
    promptText: promptText || parsedTargeting?.promptText || "",
    tokens: [],
    actors: []
  });

  dbg.logRun(runId, "CANCELLED TARGETS STORED", result);
  return result;
}

/* -------------------------------------------- */
/* Resolution helpers                           */
/* -------------------------------------------- */

export async function resolveJRPGStoredActors(resultOrUserId) {
  const runId = dbg.makeRunId("RESOLVE-ACTORS");

  const result = typeof resultOrUserId === "string"
    ? getJRPGLastTargetingResult(resultOrUserId)
    : resultOrUserId;

  const uuids = compactArray(result?.actorUuids);
  const resolved = [];

  for (const uuid of uuids) {
    try {
      const actor = await fromUuid(uuid);
      if (actor) resolved.push(actor);
    } catch (err) {
      dbg.errorRun(runId, "FAILED resolving actor uuid", { uuid, err });
    }
  }

  dbg.logRun(runId, "RESOLVED ACTORS", {
    count: resolved.length,
    names: resolved.map((a) => a.name)
  });

  return resolved;
}

export async function resolveJRPGStoredTokens(resultOrUserId) {
  const runId = dbg.makeRunId("RESOLVE-TOKENS");

  const result = typeof resultOrUserId === "string"
    ? getJRPGLastTargetingResult(resultOrUserId)
    : resultOrUserId;

  const uuids = compactArray(result?.tokenUuids);
  const resolved = [];

  for (const uuid of uuids) {
    try {
      const tokenDoc = await fromUuid(uuid);
      if (tokenDoc?.object) {
        resolved.push(tokenDoc.object);
      } else if (tokenDoc) {
        resolved.push(tokenDoc);
      }
    } catch (err) {
      dbg.errorRun(runId, "FAILED resolving token uuid", { uuid, err });
    }
  }

  dbg.logRun(runId, "RESOLVED TOKENS", {
    count: resolved.length,
    names: resolved.map((t) => getTokenName(t))
  });

  return resolved;
}

/* -------------------------------------------- */
/* Snapshot helpers                             */
/* -------------------------------------------- */

export function getJRPGTargetingStoreSnapshot() {
  return clonePlain(ensureRuntimeStore());
}

export function getJRPGLastTargetingResultsMap() {
  return clonePlain(ensureRuntimeStore().lastResultByUser ?? {});
}

export default {
  initializeJRPGTargetingStore,
  getJRPGTargetingStore,
  clearJRPGTargetingStore,

  setJRPGActiveTargetingSession,
  getJRPGActiveTargetingSession,
  clearJRPGActiveTargetingSession,

  setJRPGTargetingSessionForUser,
  getJRPGTargetingSessionForUser,
  clearJRPGTargetingSessionForUser,

  setJRPGLastTargetingResult,
  getJRPGLastTargetingResult,
  clearJRPGLastTargetingResult,

  storeJRPGConfirmedTargets,
  storeJRPGCancelledTargets,

  resolveJRPGStoredActors,
  resolveJRPGStoredTokens,

  getJRPGTargetingStoreSnapshot,
  getJRPGLastTargetingResultsMap
};
