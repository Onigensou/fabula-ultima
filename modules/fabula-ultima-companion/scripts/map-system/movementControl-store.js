/**
 * movementControl-store.js
 * Fabula Ultima Companion - Movement Control System Store
 * Foundry VTT v12
 *
 * Purpose:
 * - Persist Movement Control state on the Current Game actor
 * - Keep all controller-related cache in one place
 * - Provide clean read/write helpers for future API/runtime/UI scripts
 *
 * Storage location:
 *   Current Game Actor
 *   flags.fabula-ultima-companion.movementControlState
 *
 * Notes:
 * - This script only reads/writes state.
 * - It does not perform socket broadcasting.
 * - It does not resolve authority by itself beyond basic ownership checks.
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_STORE__
 *
 * API:
 *   FUCompanion.api.MovementControlStore
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_STORE__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";
  const FLAG_KEY = "movementControlState";
  const STATE_VERSION = 1;

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

  function getResolver() {
    return globalThis.__ONI_MOVEMENT_CONTROL_RESOLVER__ ?? null;
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

  function toNullableString(value) {
    const s = cleanString(value);
    return s.length ? s : null;
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

  function mergeObjectSafe(original, update) {
    try {
      return foundry.utils.mergeObject(original, update, {
        inplace: false,
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true
      });
    } catch {
      return { ...(original ?? {}), ...(update ?? {}) };
    }
  }

    function stableStringify(value) {
    const seen = new WeakSet();

    const sorter = (_key, val) => {
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);

        if (!Array.isArray(val)) {
          return Object.keys(val)
            .sort()
            .reduce((out, key) => {
              out[key] = val[key];
              return out;
            }, {});
        }
      }

      return val;
    };

    try {
      return JSON.stringify(value, sorter);
    } catch {
      return String(value);
    }
  }

  function getMeaningfulStateForCompare(state = {}) {
    const clone = deepClone(normalizeState(state));

    // These are bookkeeping fields.
    // They should not force an actor flag write by themselves.
    delete clone.lastResolvedAt;
    delete clone.updatedAt;
    delete clone.updatedByUserId;
    delete clone.updateReason;

    return clone;
  }

  function isMeaningfullySameState(a, b) {
    return stableStringify(getMeaningfulStateForCompare(a)) === stableStringify(getMeaningfulStateForCompare(b));
  }

  function getDefaultState() {
    return {
      version: STATE_VERSION,

      currentGameActorId: null,
      currentGameActorUuid: null,

      partyActorId: null,
      partyActorUuid: null,
      partyActorName: null,

      currentControllerUserId: null,
      currentControllerUserName: null,

      lastControllerUserId: null,
      lastControllerUserName: null,

      controllerActorId: null,
      controllerActorUuid: null,
      controllerActorName: null,

      centralPartyTokenId: null,
      centralPartyTokenUuid: null,
      centralPartyTokenName: null,

      lastResolvedAt: null,
      updatedAt: null,
      updatedByUserId: null,
      updateReason: null
    };
  }

  function normalizeState(rawState) {
    const base = getDefaultState();
    const merged = mergeObjectSafe(base, rawState ?? {});

    return {
      version: Number(merged.version) || STATE_VERSION,

      currentGameActorId: toNullableString(merged.currentGameActorId),
      currentGameActorUuid: toNullableString(merged.currentGameActorUuid),

      partyActorId: toNullableString(merged.partyActorId),
      partyActorUuid: toNullableString(merged.partyActorUuid),
      partyActorName: toNullableString(merged.partyActorName),

      currentControllerUserId: toNullableString(merged.currentControllerUserId),
      currentControllerUserName: toNullableString(merged.currentControllerUserName),

      lastControllerUserId: toNullableString(merged.lastControllerUserId),
      lastControllerUserName: toNullableString(merged.lastControllerUserName),

      controllerActorId: toNullableString(merged.controllerActorId),
      controllerActorUuid: toNullableString(merged.controllerActorUuid),
      controllerActorName: toNullableString(merged.controllerActorName),

      centralPartyTokenId: toNullableString(merged.centralPartyTokenId),
      centralPartyTokenUuid: toNullableString(merged.centralPartyTokenUuid),
      centralPartyTokenName: toNullableString(merged.centralPartyTokenName),

      lastResolvedAt: Number.isFinite(Number(merged.lastResolvedAt)) ? Number(merged.lastResolvedAt) : null,
      updatedAt: Number.isFinite(Number(merged.updatedAt)) ? Number(merged.updatedAt) : null,
      updatedByUserId: toNullableString(merged.updatedByUserId),
      updateReason: toNullableString(merged.updateReason)
    };
  }

  async function resolveCurrentGameActor() {
    const resolver = getResolver();
    if (!resolver?.resolveCurrentGameActor) {
      DBG.warn("Store", "Resolver not available while resolving Current Game actor");
      return null;
    }

    return await resolver.resolveCurrentGameActor();
  }

  function canWriteToCurrentGameActor(currentGameActor) {
    return !!currentGameActor?.isOwner;
  }

  async function getRawFlagState(currentGameActor = null) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) return null;

    try {
      return actor.getFlag(MODULE_ID, FLAG_KEY) ?? null;
    } catch (err) {
      DBG.warn("Store", "Failed to read Movement Control flag state", {
        actorId: actor.id,
        actorName: actor.name,
        error: err?.message ?? err
      });
      return null;
    }
  }

  async function getState(currentGameActor = null) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) {
      const fallback = normalizeState({});
      DBG.verbose("Store", "getState returned default state because Current Game actor was not found", fallback);
      return fallback;
    }

    const raw = await getRawFlagState(actor);
    const normalized = normalizeState(raw);

    DBG.groupCollapsed("Store", "Loaded Movement Control state", {
      actorId: actor.id,
      actorName: actor.name,
      state: normalized
    });

    return normalized;
  }

  async function writeState(patch = {}, {
    currentGameActor = null,
    merge = true,
    reason = null,
    allowNonOwner = false
  } = {}) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) {
      DBG.warn("Store", "writeState aborted because Current Game actor could not be resolved", { patch });
      return { ok: false, reason: "noCurrentGameActor", actor: null, state: null };
    }

    if (!allowNonOwner && !canWriteToCurrentGameActor(actor)) {
      DBG.warn("Store", "writeState blocked because current user is not owner of Current Game actor", {
        actorId: actor.id,
        actorName: actor.name,
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null,
        patch
      });
      return { ok: false, reason: "notOwner", actor, state: null };
    }

    const existing = await getState(actor);
    const base = merge ? existing : getDefaultState();

        const meaningfulNext = normalizeState(
      mergeObjectSafe(base, {
        ...(patch ?? {}),
        currentGameActorId: actor.id ?? null,
        currentGameActorUuid: actor.uuid ?? null
      })
    );

    if (isMeaningfullySameState(existing, meaningfulNext)) {
      DBG.verbose("Store", "Movement Control state write skipped because only bookkeeping fields changed", {
        actorId: actor.id,
        actorName: actor.name,
        reason,
        patch,
        existing,
        meaningfulNext
      });

      return {
        ok: true,
        reason: "unchanged",
        skipped: true,
        actor,
        state: existing
      };
    }

    const next = normalizeState(
      mergeObjectSafe(meaningfulNext, {
        lastResolvedAt: patch?.lastResolvedAt ?? meaningfulNext.lastResolvedAt ?? Date.now(),
        updatedAt: Date.now(),
        updatedByUserId: game.user?.id ?? null,
        updateReason: toNullableString(reason) ?? toNullableString(patch?.updateReason) ?? null
      })
    );

    try {
      await actor.update(
        {
          [`flags.${MODULE_ID}.${FLAG_KEY}`]: next
        },
        {
          render: false,
          diff: true,
          recursive: true,
          movementControlWrite: true
        }
      );

      DBG.groupCollapsed("Store", "Movement Control state written", {
        actorId: actor.id,
        actorName: actor.name,
        reason: next.updateReason,
        previousState: existing,
        nextState: next
      });

      return { ok: true, reason: "written", skipped: false, actor, state: next };
    } catch (err) {
      DBG.error("Store", "Failed to write Movement Control state", {
        actorId: actor.id,
        actorName: actor.name,
        patch,
        error: err?.message ?? err
      });
      return { ok: false, reason: "writeFailed", actor, state: null, error: err };
    }
  }

  async function clearState({
    currentGameActor = null,
    allowNonOwner = false
  } = {}) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) {
      DBG.warn("Store", "clearState aborted because Current Game actor could not be resolved");
      return { ok: false, reason: "noCurrentGameActor", actor: null };
    }

    if (!allowNonOwner && !canWriteToCurrentGameActor(actor)) {
      DBG.warn("Store", "clearState blocked because current user is not owner of Current Game actor", {
        actorId: actor.id,
        actorName: actor.name,
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null
      });
      return { ok: false, reason: "notOwner", actor };
    }

    try {
      await actor.unsetFlag(MODULE_ID, FLAG_KEY);

      DBG.info("Store", "Movement Control state cleared", {
        actorId: actor.id,
        actorName: actor.name
      });

      return { ok: true, reason: "cleared", actor };
    } catch (err) {
      DBG.error("Store", "Failed to clear Movement Control state", {
        actorId: actor.id,
        actorName: actor.name,
        error: err?.message ?? err
      });
      return { ok: false, reason: "clearFailed", actor, error: err };
    }
  }

  async function touchSnapshot(snapshot, {
    currentGameActor = null,
    reason = "snapshotRefresh",
    allowNonOwner = false
  } = {}) {
    if (!snapshot) {
      DBG.warn("Store", "touchSnapshot called without a snapshot");
      return { ok: false, reason: "noSnapshot", actor: null, state: null };
    }

    const patch = {
      currentGameActorId: snapshot.currentGameActorId ?? null,
      currentGameActorUuid: snapshot.currentGameActorUuid ?? null,

      partyActorId: snapshot.centralPartyActorId ?? null,
      partyActorUuid: snapshot.centralPartyActorUuid ?? null,
      partyActorName: snapshot.centralPartyActorName ?? null,

      centralPartyTokenId: safeGet(snapshot, "centralPartyTokenData.tokenId", null),
      centralPartyTokenUuid: safeGet(snapshot, "centralPartyTokenData.tokenUuid", null),
      centralPartyTokenName: safeGet(snapshot, "centralPartyTokenData.tokenName", null),

      lastResolvedAt: snapshot.resolvedAt ?? Date.now()
    };

    return await writeState(patch, {
      currentGameActor,
      merge: true,
      reason,
      allowNonOwner
    });
  }

  async function setController(controllerRow, {
    currentGameActor = null,
    reason = "setController",
    keepPreviousAsLast = true,
    allowNonOwner = false
  } = {}) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) {
      DBG.warn("Store", "setController aborted because Current Game actor could not be resolved", { controllerRow });
      return { ok: false, reason: "noCurrentGameActor", actor: null, state: null };
    }

    const existing = await getState(actor);

    const patch = {
      currentControllerUserId: controllerRow?.userId ?? null,
      currentControllerUserName: controllerRow?.userName ?? null,

      controllerActorId: controllerRow?.linkedActorId ?? controllerRow?.partyMemberActorId ?? null,
      controllerActorUuid: controllerRow?.linkedActorUuid ?? controllerRow?.partyMember?.actorUuid ?? null,
      controllerActorName: controllerRow?.linkedActorName ?? controllerRow?.partyMemberActorName ?? null,

      lastResolvedAt: Date.now()
    };

    if (keepPreviousAsLast) {
      patch.lastControllerUserId = existing.currentControllerUserId ?? null;
      patch.lastControllerUserName = existing.currentControllerUserName ?? null;
    }

    return await writeState(patch, {
      currentGameActor: actor,
      merge: true,
      reason,
      allowNonOwner
    });
  }

  async function setControllerByFields({
    currentControllerUserId = null,
    currentControllerUserName = null,
    controllerActorId = null,
    controllerActorUuid = null,
    controllerActorName = null,
    keepPreviousAsLast = true,
    reason = "setControllerByFields",
    currentGameActor = null,
    allowNonOwner = false
  } = {}) {
    const actor = currentGameActor ?? await resolveCurrentGameActor();
    if (!actor) {
      DBG.warn("Store", "setControllerByFields aborted because Current Game actor could not be resolved");
      return { ok: false, reason: "noCurrentGameActor", actor: null, state: null };
    }

    const existing = await getState(actor);

    const patch = {
      currentControllerUserId,
      currentControllerUserName,
      controllerActorId,
      controllerActorUuid,
      controllerActorName,
      lastResolvedAt: Date.now()
    };

    if (keepPreviousAsLast) {
      patch.lastControllerUserId = existing.currentControllerUserId ?? null;
      patch.lastControllerUserName = existing.currentControllerUserName ?? null;
    }

    return await writeState(patch, {
      currentGameActor: actor,
      merge: true,
      reason,
      allowNonOwner
    });
  }

  async function setPartyActor(partyActor, {
    currentGameActor = null,
    reason = "setPartyActor",
    allowNonOwner = false
  } = {}) {
    return await writeState({
      partyActorId: partyActor?.id ?? null,
      partyActorUuid: partyActor?.uuid ?? null,
      partyActorName: partyActor?.name ?? null,
      lastResolvedAt: Date.now()
    }, {
      currentGameActor,
      merge: true,
      reason,
      allowNonOwner
    });
  }

  async function setCentralPartyToken(token, {
    currentGameActor = null,
    reason = "setCentralPartyToken",
    allowNonOwner = false
  } = {}) {
    return await writeState({
      centralPartyTokenId: token?.id ?? null,
      centralPartyTokenUuid: token?.document?.uuid ?? null,
      centralPartyTokenName: token?.name ?? null,
      lastResolvedAt: Date.now()
    }, {
      currentGameActor,
      merge: true,
      reason,
      allowNonOwner
    });
  }

  async function getControllerCache(currentGameActor = null) {
    const state = await getState(currentGameActor);

    return {
      currentControllerUserId: state.currentControllerUserId,
      currentControllerUserName: state.currentControllerUserName,
      lastControllerUserId: state.lastControllerUserId,
      lastControllerUserName: state.lastControllerUserName,
      controllerActorId: state.controllerActorId,
      controllerActorUuid: state.controllerActorUuid,
      controllerActorName: state.controllerActorName
    };
  }

  async function getPartyCache(currentGameActor = null) {
    const state = await getState(currentGameActor);

    return {
      partyActorId: state.partyActorId,
      partyActorUuid: state.partyActorUuid,
      partyActorName: state.partyActorName,
      centralPartyTokenId: state.centralPartyTokenId,
      centralPartyTokenUuid: state.centralPartyTokenUuid,
      centralPartyTokenName: state.centralPartyTokenName
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    FLAG_KEY,
    STATE_VERSION,

    getDefaultState,
    normalizeState,

    resolveCurrentGameActor,
    canWriteToCurrentGameActor,

    getRawFlagState,
    getState,
    writeState,
    clearState,

    touchSnapshot,
    setController,
    setControllerByFields,
    setPartyActor,
    setCentralPartyToken,

    getControllerCache,
    getPartyCache
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlStore = api;
    } catch (err) {
      console.warn("[MovementControl:Store] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Store", "movementControl-store.js ready", {
      moduleId: MODULE_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });
})();
