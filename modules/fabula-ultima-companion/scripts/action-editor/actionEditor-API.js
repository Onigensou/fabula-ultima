// ============================================================================
// actionEditor-API.js
// Foundry V12
// -----------------------------------------------------------------------------
// Purpose:
//   Central public API for editing pending Action Cards.
//
// Depends on:
//   1. actionEditor-CardFinder.js
//   2. actionEditor-PatchEngine.js
//
// Optional later dependency:
//   3. actionCard-Rebuilder.js
//
// What this script does:
//   - Other scripts call this API with:
//       userId
//       actionCardId
//       editorActorUuid
//       edits
//   - It finds the correct Action Card message.
//   - It patches the saved payload.
//   - It writes the updated payload back into the ChatMessage flag.
//   - It records edit history.
//   - It optionally calls ActionCardRebuilder if it exists.
//
// What this script DOES NOT do:
//   - It does not manually resolve the action.
//   - It does not apply damage.
//   - It does not spend resources.
//   - It does not create animation.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  // =========================================================
  // DEBUG TOGGLE
  // =========================================================
  const ACTION_EDITOR_API_DEBUG = true;

  const TAG = "[ONI][ActionEditor][API]";
  const API_VERSION = "0.1.0";

  const log = (...a) => {
    if (ACTION_EDITOR_API_DEBUG) console.log(TAG, ...a);
  };

  const warn = (...a) => {
    if (ACTION_EDITOR_API_DEBUG) console.warn(TAG, ...a);
  };

  const err = (...a) => {
    if (ACTION_EDITOR_API_DEBUG) console.error(TAG, ...a);
  };

  // =========================================================
  // SMALL HELPERS
  // =========================================================

  function str(v, fallback = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : fallback;
  }

  function lower(v) {
    return str(v).toLowerCase();
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function bool(v, fallback = false) {
    if (v === true || v === "true" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === 0 || v === "0") return false;
    return fallback;
  }

  function clone(obj, fallback = null) {
    try {
      if (obj === undefined || obj === null) return fallback;
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(obj);
      return JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return [...obj];
      if (obj && typeof obj === "object") return { ...obj };
      return fallback;
    }
  }

  function uniq(list) {
    return Array.from(
      new Set(
        (Array.isArray(list) ? list : [])
          .filter(v => v !== null && v !== undefined)
          .map(v => String(v).trim())
          .filter(Boolean)
      )
    );
  }

  function nowMs() {
    return Date.now();
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function makeId(prefix = "EDIT") {
    const rnd =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now().toString(36)}-${rnd}`;
  }

  function getUserName(userId) {
    return game.users?.get?.(userId)?.name ?? null;
  }

  function compactPayloadPreview(payload = {}) {
    return {
      actionId: payload?.meta?.actionId ?? payload?.actionId ?? null,
      actionCardId: payload?.meta?.actionCardId ?? payload?.actionCardId ?? null,
      actionCardVersion: payload?.meta?.actionCardVersion ?? payload?.actionCardVersion ?? null,
      actionCardMessageId: payload?.meta?.actionCardMessageId ?? payload?.actionCardMessageId ?? null,
      state: payload?.meta?.actionCardState ?? payload?.actionCardState ?? "pending",
      skillName: payload?.core?.skillName ?? payload?.dataCore?.skillName ?? null,
      attackerUuid: payload?.meta?.attackerUuid ?? payload?.attackerUuid ?? payload?.attackerActorUuid ?? null,
      elementType: payload?.meta?.elementType ?? payload?.advPayload?.elementType ?? null,
      bonus: payload?.advPayload?.bonus ?? payload?.meta?.bonus ?? null,
      reduction: payload?.advPayload?.reduction ?? payload?.meta?.reduction ?? null,
      multiplier: payload?.advPayload?.multiplier ?? payload?.meta?.multiplier ?? null,
      targetsCount: Array.isArray(payload?.originalTargetUUIDs)
        ? payload.originalTargetUUIDs.length
        : Array.isArray(payload?.targets)
          ? payload.targets.length
          : 0
    };
  }

  // =========================================================
  // API RESOLVERS
  // =========================================================

  function getModuleApi() {
    return game.modules?.get?.(MODULE_ID)?.api ?? globalThis.FUCompanion?.api ?? null;
  }

  function getCardFinderApi() {
    return (
      globalThis.FUCompanion?.api?.actionEditorCardFinder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditorCardFinder ??
      globalThis.FUCompanion?.api?.actionEditor?.cardFinder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditor?.cardFinder ??
      null
    );
  }

  function getPatchEngineApi() {
    return (
      globalThis.FUCompanion?.api?.actionEditorPatchEngine ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditorPatchEngine ??
      globalThis.FUCompanion?.api?.actionEditor?.patchEngine ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditor?.patchEngine ??
      null
    );
  }

  function getRebuilderApi() {
    return (
      globalThis.FUCompanion?.api?.actionCardRebuilder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionCardRebuilder ??
      globalThis.FUCompanion?.api?.actionEditor?.rebuilder ??
      game.modules?.get?.(MODULE_ID)?.api?.actionEditor?.rebuilder ??
      null
    );
  }

  function getGMExecutorApi() {
    return (
      game.modules?.get?.(MODULE_ID)?.api?.GMExecutor ??
      globalThis.FUCompanion?.api?.GMExecutor ??
      null
    );
  }

  // =========================================================
  // STATE / LOCK HELPERS
  // =========================================================

  const LOCKED_STATES = new Set([
    "confirmed",
    "confirming",
    "resolved",
    "cancelled",
    "locked"
  ]);

  function normalizeState(value) {
    return lower(value || "pending") || "pending";
  }

  function isLockedState(value) {
    return LOCKED_STATES.has(normalizeState(value));
  }

  function ensurePayloadIdentityFromFound(payload, found) {
    payload.meta = payload.meta || {};

    const actionId = str(
      payload?.meta?.actionId ??
      payload?.actionId ??
      found?.actionId
    );

    const actionCardId = str(
      payload?.meta?.actionCardId ??
      payload?.actionCardId ??
      found?.actionCardId
    );

    const actionCardMessageId = str(
      payload?.meta?.actionCardMessageId ??
      payload?.actionCardMessageId ??
      found?.actionCardMessageId ??
      found?.messageId
    );

    const actionCardVersion =
      num(
        payload?.meta?.actionCardVersion ??
        payload?.actionCardVersion ??
        found?.actionCardVersion ??
        0,
        0
      );

    payload.actionId = actionId;
    payload.actionCardId = actionCardId;
    payload.actionCardMessageId = actionCardMessageId;
    payload.actionCardVersion = actionCardVersion;

    payload.meta.actionId = actionId;
    payload.meta.actionCardId = actionCardId;
    payload.meta.actionCardMessageId = actionCardMessageId;
    payload.meta.actionCardVersion = actionCardVersion;

    if (!payload.meta.actionCardState) {
      payload.meta.actionCardState = "pending";
    }

    return payload;
  }

  function bumpActionCardVersion(payload) {
    payload.meta = payload.meta || {};

    const current = num(
      payload?.meta?.actionCardVersion ??
      payload?.actionCardVersion ??
      0,
      0
    );

    const next = current + 1;

    payload.actionCardVersion = next;
    payload.meta.actionCardVersion = next;
    payload.meta.actionCardEditedAtMs = nowMs();
    payload.meta.actionCardEditedAtIso = isoNow();

    return next;
  }

  // =========================================================
  // FLAG BUILD / SAVE
  // =========================================================

  function buildActionCardFlagData(payload, messageId = null, existingFlag = null) {
    payload.meta = payload.meta || {};

    const resolvedMessageId = str(
      messageId ??
      payload?.meta?.actionCardMessageId ??
      payload?.actionCardMessageId
    );

    if (resolvedMessageId) {
      payload.actionCardMessageId = resolvedMessageId;
      payload.meta.actionCardMessageId = resolvedMessageId;
    }

    const actionId = str(payload?.meta?.actionId ?? payload?.actionId);
    const actionCardId = str(payload?.meta?.actionCardId ?? payload?.actionCardId);
    const actionCardVersion = num(payload?.meta?.actionCardVersion ?? payload?.actionCardVersion, 0);

    const replacedActionCardIds = uniq([
      ...(Array.isArray(existingFlag?.replacedActionCardIds) ? existingFlag.replacedActionCardIds : []),
      ...(Array.isArray(payload?.meta?.replacedActionCardIds) ? payload.meta.replacedActionCardIds : []),
      ...(Array.isArray(payload?.replacedActionCardIds) ? payload.replacedActionCardIds : [])
    ]);

    payload.meta.replacedActionCardIds = [...replacedActionCardIds];

    return {
      ...(existingFlag && typeof existingFlag === "object" ? clone(existingFlag, {}) : {}),

      payload,

      actionId,
      actionCardId,
      actionCardVersion,
      actionCardMessageId: resolvedMessageId || null,
      replacedActionCardIds,

      actionCardState: normalizeState(payload?.meta?.actionCardState),

      lastEditedAtMs: payload?.meta?.actionCardEditedAtMs ?? nowMs(),
      lastEditedAtIso: payload?.meta?.actionCardEditedAtIso ?? isoNow(),
      lastEditedByUserId: payload?.meta?.actionEditor?.lastPatchedByUserId ?? null,

      skillName:
        payload?.core?.skillName ??
        payload?.dataCore?.skillName ??
        null,

      attackerUuid:
        payload?.meta?.attackerUuid ??
        payload?.attackerUuid ??
        payload?.attackerActorUuid ??
        null
    };
  }

  async function saveActionCardFlag({
    message,
    payload,
    existingFlag = null
  } = {}) {
    if (!message) {
      return {
        ok: false,
        reason: "missing_message"
      };
    }

    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        reason: "missing_payload"
      };
    }

    const flagData = buildActionCardFlagData(payload, message.id, existingFlag);

    try {
      if (typeof message.setFlag === "function") {
        await message.setFlag(MODULE_ID, "actionCard", flagData);
      } else {
        await message.update({
          [`flags.${MODULE_ID}.actionCard`]: flagData
        });
      }

      log("SAVE FLAG OK", {
        messageId: message.id,
        actionId: flagData.actionId,
        actionCardId: flagData.actionCardId,
        actionCardVersion: flagData.actionCardVersion
      });

      return {
        ok: true,
        messageId: message.id,
        flagData
      };
    } catch (e) {
      err("SAVE FLAG FAILED", {
        messageId: message?.id ?? null,
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      });

      return {
        ok: false,
        reason: "save_flag_failed",
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      };
    }
  }

  // =========================================================
  // HISTORY
  // =========================================================

  function appendEditHistory({
    payload,
    editId,
    userId,
    editorActorUuid,
    reason,
    edits,
    patchResult
  } = {}) {
    payload.meta = payload.meta || {};

    const history = Array.isArray(payload.meta.actionEditorHistory)
      ? payload.meta.actionEditorHistory
      : [];

    const record = {
      editId,
      atMs: nowMs(),
      atIso: isoNow(),

      userId: userId ?? game.userId ?? null,
      userName: getUserName(userId ?? game.userId) ?? null,
      editorActorUuid: editorActorUuid ?? null,

      reason: str(reason),
      edits: clone(edits, {}),

      before: clone(patchResult?.beforeSnapshot, {}),
      after: clone(patchResult?.afterSnapshot, {}),
      diff: clone(patchResult?.diff, {}),

      changedPaths: uniq(patchResult?.changedPaths ?? []),
      patchRunId: patchResult?.runId ?? null,
      patchResults: clone(patchResult?.results ?? [], [])
    };

    history.push(record);

    payload.meta.actionEditorHistory = history;

    payload.meta.actionEditor = payload.meta.actionEditor || {};
    payload.meta.actionEditor.lastEditId = editId;
    payload.meta.actionEditor.lastEditedAtMs = record.atMs;
    payload.meta.actionEditor.lastEditedAtIso = record.atIso;
    payload.meta.actionEditor.lastEditedByUserId = record.userId;
    payload.meta.actionEditor.lastEditedByUserName = record.userName;
    payload.meta.actionEditor.lastEditorActorUuid = record.editorActorUuid;
    payload.meta.actionEditor.lastReason = record.reason;

    return record;
  }

  // =========================================================
  // REMOTE GM EXECUTION
  // =========================================================

  async function runEditViaGMExecutor(request = {}) {
    const gmExecutor = getGMExecutorApi();

    if (!gmExecutor || typeof gmExecutor.executeSnippet !== "function") {
      return {
        ok: false,
        reason: "gm_executor_missing",
        error: "GMExecutor.executeSnippet is not available."
      };
    }

    const runId = `AE-GM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const wrappedScript = `
const actionEditor =
  globalThis.FUCompanion?.api?.actionEditor ??
  game.modules?.get("${MODULE_ID}")?.api?.actionEditor ??
  null;

if (!actionEditor || typeof actionEditor.editActionCard !== "function") {
  throw new Error("ActionEditor API is not available on GM client.");
}

const sourceUserId =
  env?.callerUserId ??
  env?.metadata?.sourceUserId ??
  payload?.userId ??
  null;

const result = await actionEditor.editActionCard({
  ...payload,
  userId: sourceUserId ?? payload?.userId ?? null,
  _skipRemote: true,
  _remoteSourceUserId: sourceUserId
});

// Return a compact serializable result.
// Do not return full ChatMessage documents through GMExecutor.
return {
  ok: !!result?.ok,
  runId: result?.runId ?? null,
  editId: result?.editId ?? null,
  executionPath: "gm-executor-generic",

  actionId: result?.actionId ?? null,
  actionCardId: result?.actionCardId ?? null,
  actionCardVersion: result?.actionCardVersion ?? null,
  actionCardMessageId: result?.actionCardMessageId ?? null,
  messageId: result?.messageId ?? null,

  userId: result?.userId ?? sourceUserId ?? null,
  editorActorUuid: result?.editorActorUuid ?? payload?.editorActorUuid ?? null,
  reason: result?.reason ?? payload?.reason ?? "",

  rebuildMode: result?.rebuildResult?.mode ?? null,
  oldMessageId: result?.rebuildResult?.oldMessageId ?? null,
  newMessageId:
    result?.rebuildResult?.newMessageId ??
    result?.rebuildResult?.messageId ??
    result?.messageId ??
    null,

  error: result?.error ?? null,
  failReason: result?.reason ?? null
};
    `.trim();

    log("REMOTE GM EXECUTE START", {
      runId,
      sourceUserId: game.userId,
      actionCardId: request?.actionCardId ?? null,
      actionCardMessageId: request?.actionCardMessageId ?? request?.messageId ?? null
    });

    try {
      const remote = await gmExecutor.executeSnippet({
        mode: "generic",
        scriptText: wrappedScript,
        payload: clone(request, {}),
        actorUuid: request?.editorActorUuid ?? null,
        metadata: {
          origin: "ActionEditor-API",
          runId,
          sourceUserId: game.userId
        }
      });

      log("REMOTE GM EXECUTE RETURN", {
        runId,
        ok: !!remote?.ok,
        hasResultValue: !!remote?.resultValue,
        error: remote?.error ?? null
      });

      if (!remote?.ok) {
        return {
          ok: false,
          reason: "gm_executor_failed",
          error: String(remote?.error ?? "Unknown GMExecutor error"),
          stack: String(remote?.stack ?? "")
        };
      }

      return remote?.resultValue ?? {
        ok: false,
        reason: "gm_executor_no_result"
      };
    } catch (e) {
      err("REMOTE GM EXECUTE FATAL", {
        runId,
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      });

      return {
        ok: false,
        reason: "gm_executor_exception",
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      };
    }
  }

  // =========================================================
  // MAIN EDIT FUNCTION
  // =========================================================

  async function editActionCard(request = {}) {
    const runId = `AE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const userId = str(
      request.userId ??
      request.operatingUserId ??
      request._remoteSourceUserId ??
      game.userId
    );

    const actionCardId = str(
      request.actionCardId ??
      request.cardId ??
      request.id
    );

    const actionId = str(request.actionId);

    const actionCardMessageId = str(
      request.actionCardMessageId ??
      request.messageId ??
      request.chatMsgId ??
      request.chatMessageId
    );

    const editorActorUuid = str(
      request.editorActorUuid ??
      request.editingActorUuid ??
      request.actorUuid
    );

    const reason = str(request.reason);

    const edits = request.edits ?? {
      operations: request.operations ?? request.ops ?? [],
      patches: request.patches ?? request.rawPatches ?? []
    };

    const force = bool(request.force, false);
    const allowPartial = bool(request.allowPartial, false);
    const rebuild = bool(request.rebuild, false);
    const notify = bool(request.notify, false);

    const skipRemote = bool(request._skipRemote, false);

    log("EDIT START", {
      runId,
      userId,
      currentUserId: game.userId,
      isGM: !!game.user?.isGM,
      actionCardId,
      actionId,
      actionCardMessageId,
      editorActorUuid,
      reason,
      force,
      allowPartial,
      rebuild,
      skipRemote
    });

    // -------------------------------------------------------
    // Non-GM bridge
    // -------------------------------------------------------
    // ChatMessage flag updates often require GM permission.
    // So if this is called by a player and GMExecutor exists,
    // forward the edit to the GM client.
    // -------------------------------------------------------
    if (!game.user?.isGM && !skipRemote) {
      const gmResult = await runEditViaGMExecutor({
        ...request,
        userId
      });

      return {
        ...gmResult,
        executionPath: "gm-executor-generic"
      };
    }

    const finder = getCardFinderApi();
    const patcher = getPatchEngineApi();

    if (!finder || typeof finder.findActionCard !== "function") {
      return {
        ok: false,
        runId,
        reason: "card_finder_missing",
        error: "ActionEditor CardFinder API is missing."
      };
    }

    if (!patcher || typeof patcher.applyEdits !== "function") {
      return {
        ok: false,
        runId,
        reason: "patch_engine_missing",
        error: "ActionEditor PatchEngine API is missing."
      };
    }

    // -------------------------------------------------------
    // 1) Find card
    // -------------------------------------------------------
    const found = await finder.findActionCard({
      actionCardId,
      actionId,
      actionCardMessageId
    }, {
      includeReplaced: true,
      maxMessages: request.maxMessages ?? 250
    });

    if (!found?.ok) {
      warn("EDIT FAILED: card not found", {
        runId,
        found
      });

      return {
        ok: false,
        runId,
        reason: found?.reason ?? "card_not_found",
        lookup: {
          actionCardId,
          actionId,
          actionCardMessageId
        },
        found
      };
    }

    if (!found.message) {
      return {
        ok: false,
        runId,
        reason: "found_card_missing_message",
        found
      };
    }

    if (!found.payload || typeof found.payload !== "object") {
      return {
        ok: false,
        runId,
        reason: "found_card_missing_payload",
        found: {
          messageId: found.messageId,
          actionId: found.actionId,
          actionCardId: found.actionCardId
        }
      };
    }

    // -------------------------------------------------------
    // 2) Clone payload and check lock state
    // -------------------------------------------------------
    const payload = clone(found.payload, {});
    ensurePayloadIdentityFromFound(payload, found);

    const state = normalizeState(
      payload?.meta?.actionCardState ??
      found?.state ??
      "pending"
    );

    if (isLockedState(state) && !force) {
      warn("EDIT BLOCKED: card is locked", {
        runId,
        state,
        actionId: payload?.meta?.actionId,
        actionCardId: payload?.meta?.actionCardId,
        messageId: found.messageId
      });

      return {
        ok: false,
        runId,
        reason: "card_locked",
        state,
        message: `Action Card is already ${state}.`,
        actionId: payload?.meta?.actionId ?? null,
        actionCardId: payload?.meta?.actionCardId ?? null,
        actionCardMessageId: payload?.meta?.actionCardMessageId ?? found.messageId ?? null
      };
    }

    const beforePreview = compactPayloadPreview(payload);

    // -------------------------------------------------------
    // 3) Apply patch
    // -------------------------------------------------------
    const patchResult = patcher.applyEdits({
      payload,
      edits,
      userId,
      editorActorUuid,
      reason,
      allowPartial
    });

    if (!patchResult?.ok) {
      warn("EDIT FAILED: patch failed", {
        runId,
        reason: patchResult?.reason,
        patchResult
      });

      return {
        ok: false,
        runId,
        reason: patchResult?.reason ?? "patch_failed",
        actionId: payload?.meta?.actionId ?? null,
        actionCardId: payload?.meta?.actionCardId ?? null,
        actionCardMessageId: payload?.meta?.actionCardMessageId ?? found.messageId ?? null,
        patchResult
      };
    }

    // -------------------------------------------------------
    // 4) History + version bump
    // -------------------------------------------------------
    const editId = makeId("EDIT");

    const editRecord = appendEditHistory({
      payload,
      editId,
      userId,
      editorActorUuid,
      reason,
      edits,
      patchResult
    });

    const newVersion = bumpActionCardVersion(payload);

    payload.meta.actionCardState = state || "pending";
    payload.actionCardState = payload.meta.actionCardState;

    const afterPreview = compactPayloadPreview(payload);

    log("EDIT PATCHED", {
      runId,
      editId,
      actionId: payload?.meta?.actionId,
      actionCardId: payload?.meta?.actionCardId,
      oldVersion: beforePreview.actionCardVersion,
      newVersion,
      changedPaths: patchResult.changedPaths,
      beforePreview,
      afterPreview
    });

    // -------------------------------------------------------
    // 5) Save flag
    // -------------------------------------------------------
    const saveResult = await saveActionCardFlag({
      message: found.message,
      payload,
      existingFlag: found.flag
    });

    if (!saveResult?.ok) {
      return {
        ok: false,
        runId,
        reason: saveResult?.reason ?? "save_failed",
        error: saveResult?.error ?? null,
        stack: saveResult?.stack ?? "",
        actionId: payload?.meta?.actionId ?? null,
        actionCardId: payload?.meta?.actionCardId ?? null,
        actionCardVersion: payload?.meta?.actionCardVersion ?? null,
        actionCardMessageId: found.messageId ?? null,
        patchResult,
        editRecord,
        saveResult
      };
    }

    // -------------------------------------------------------
    // 6) Optional rebuild
    // -------------------------------------------------------
    let rebuildResult = {
      ok: true,
      skipped: true,
      reason: "rebuild_not_requested"
    };

    if (rebuild) {
      const rebuilder = getRebuilderApi();

      if (rebuilder && typeof rebuilder.rebuildActionCard === "function") {
        try {
          rebuildResult = await rebuilder.rebuildActionCard({
            message: found.message,
            messageId: found.messageId,
            payload,
            actionId: payload?.meta?.actionId ?? null,
            actionCardId: payload?.meta?.actionCardId ?? null,
            actionCardVersion: payload?.meta?.actionCardVersion ?? null,
            editRecord,
            reason
          });
        } catch (e) {
          rebuildResult = {
            ok: false,
            reason: "rebuilder_exception",
            error: String(e?.message ?? e),
            stack: String(e?.stack ?? "")
          };
        }
      } else {
        rebuildResult = {
          ok: false,
          skipped: true,
          reason: "rebuilder_missing"
        };
      }
    }

    if (notify) {
      const skillName =
        payload?.core?.skillName ??
        payload?.dataCore?.skillName ??
        "Action";

      ui.notifications?.info?.(`${skillName} card updated.`);
    }

const finalPayload = rebuildResult?.payload ?? payload;

const result = {
  ok: true,
  runId,
  editId,
  executionPath: game.user?.isGM ? "local-gm" : "local-non-gm",

  actionId:
    rebuildResult?.actionId ??
    finalPayload?.meta?.actionId ??
    finalPayload?.actionId ??
    null,

  actionCardId:
    rebuildResult?.actionCardId ??
    finalPayload?.meta?.actionCardId ??
    finalPayload?.actionCardId ??
    null,

  actionCardVersion:
    rebuildResult?.actionCardVersion ??
    finalPayload?.meta?.actionCardVersion ??
    finalPayload?.actionCardVersion ??
    null,

  actionCardMessageId:
    rebuildResult?.actionCardMessageId ??
    rebuildResult?.messageId ??
    finalPayload?.meta?.actionCardMessageId ??
    found.messageId ??
    null,

  messageId:
    rebuildResult?.messageId ??
    found.messageId ??
    null,

      userId,
      userName: getUserName(userId),
      editorActorUuid: editorActorUuid || null,
      reason,

      payload: finalPayload,
      flagData: saveResult.flagData,

      editRecord,
      patchResult,
      saveResult,
      rebuildResult,

      beforePreview,
      afterPreview
    };

    log("EDIT DONE", {
      runId,
      editId,
      actionId: result.actionId,
      actionCardId: result.actionCardId,
      actionCardVersion: result.actionCardVersion,
      messageId: result.messageId,
      rebuildResult
    });

    return result;
  }

  // =========================================================
  // CONVENIENCE WRAPPERS
  // =========================================================

  async function changeDamageElement({
    actionCardId,
    actionCardMessageId = null,
    actionId = null,
    elementType,
    userId = game.userId,
    editorActorUuid = null,
    reason = "",
    rebuild = true,
    notify = false,
    force = false
  } = {}) {
    return await editActionCard({
      userId,
      actionCardId,
      actionCardMessageId,
      actionId,
      editorActorUuid,
      reason: reason || `Changed damage element to ${elementType}.`,
      edits: {
        operations: [
          {
            type: "changeDamageElement",
            value: elementType
          }
        ]
      },
      rebuild,
      notify,
      force
    });
  }

  async function addDamageBonus({
    actionCardId,
    actionCardMessageId = null,
    actionId = null,
    amount = 0,
    userId = game.userId,
    editorActorUuid = null,
    reason = "",
    rebuild = true,
    notify = false,
    force = false
  } = {}) {
    return await editActionCard({
      userId,
      actionCardId,
      actionCardMessageId,
      actionId,
      editorActorUuid,
      reason: reason || `Added ${amount} damage bonus.`,
      edits: {
        operations: [
          {
            type: "addDamageBonus",
            value: amount
          }
        ]
      },
      rebuild,
      notify,
      force
    });
  }

  async function replaceTargets({
    actionCardId,
    actionCardMessageId = null,
    actionId = null,
    targetUuids = [],
    targetActorUuids = [],
    userId = game.userId,
    editorActorUuid = null,
    reason = "",
    rebuild = true,
    notify = false,
    force = false
  } = {}) {
    return await editActionCard({
      userId,
      actionCardId,
      actionCardMessageId,
      actionId,
      editorActorUuid,
      reason: reason || "Replaced Action Card targets.",
      edits: {
        operations: [
          {
            type: "replaceTargets",
            targetUuids,
            targetActorUuids
          }
        ]
      },
      rebuild,
      notify,
      force
    });
  }

  // =========================================================
  // DEBUG / INSPECTION HELPERS
  // =========================================================

  async function inspectActionCard(query = {}) {
    const finder = getCardFinderApi();
    if (!finder?.findActionCard) {
      return {
        ok: false,
        reason: "card_finder_missing"
      };
    }

    const found = await finder.findActionCard(query, {
      includeReplaced: true,
      maxMessages: query.maxMessages ?? 250
    });

    if (!found?.ok) return found;

    return {
      ok: true,
      messageId: found.messageId,
      actionId: found.actionId,
      actionCardId: found.actionCardId,
      actionCardVersion: found.actionCardVersion,
      actionCardMessageId: found.actionCardMessageId,
      state: found.state,
      skillName: found.skillName,
      attackerUuid: found.attackerUuid,
      payloadPreview: compactPayloadPreview(found.payload),
      payload: found.payload,
      flag: found.flag
    };
  }

  function getStatus() {
    return {
      ok: true,
      version: API_VERSION,
      debug: ACTION_EDITOR_API_DEBUG,
      hasCardFinder: !!getCardFinderApi()?.findActionCard,
      hasPatchEngine: !!getPatchEngineApi()?.applyEdits,
      hasRebuilder: !!getRebuilderApi()?.rebuildActionCard,
      hasGMExecutor: !!getGMExecutorApi()?.executeSnippet,
      isGM: !!game.user?.isGM,
      userId: game.userId,
      userName: game.user?.name ?? null
    };
  }

  // =========================================================
  // API REGISTRATION
  // =========================================================

  const api = {
    version: API_VERSION,

    editActionCard,

    changeDamageElement,
    addDamageBonus,
    replaceTargets,

    inspectActionCard,
    getStatus,

    saveActionCardFlag,
    buildActionCardFlagData,

    compactPayloadPreview,
    isLockedState,
    normalizeState
  };

  // Global namespace.
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  globalThis.FUCompanion.api.actionEditor = {
    ...(globalThis.FUCompanion.api.actionEditor ?? {}),
    ...api
  };

  globalThis.FUCompanion.api.actionEditorAPI = api;

  // Module API namespace.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};

      mod.api.actionEditor = {
        ...(mod.api.actionEditor ?? {}),
        ...api
      };

      mod.api.actionEditorAPI = api;
    }
  } catch (e) {
    warn("Could not register ActionEditor API on game.modules API.", {
      error: String(e?.message ?? e)
    });
  }

  console.log(`${TAG} Ready`, {
    version: API_VERSION,
    moduleId: MODULE_ID,
    debug: ACTION_EDITOR_API_DEBUG
  });
})();