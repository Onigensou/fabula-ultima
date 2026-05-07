// ──────────────────────────────────────────────────────────
//  Targeting.js
//  Action Pipeline Shim for JRPG Targeting System
//  Foundry V12 — headless-safe (__AUTO / __PAYLOAD)
//  IMPORTANT: top-level RETURN is required so callers can truly await this macro.
// ──────────────────────────────────────────────────────────
const TARGETING_DEBUG = true; // <- set to false when you're done debugging
const TARGETING_TAG   = "[ONI][Targeting]";

return (async () => {
  const macroStartedAt = Date.now();

  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  const runId = `TGT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const nowMs = () => Date.now();
  const sinceStart = () => nowMs() - macroStartedAt;

  // Local logger — keeps the per-call elapsed-time prefix that the shared
  // FUCompanion.createLogger doesn't offer.
  const log = (...a) => {
    if (TARGETING_DEBUG) console.log(TARGETING_TAG, runId, `+${sinceStart()}ms`, ...a);
  };
  const warn = (...a) => {
    if (TARGETING_DEBUG) console.warn(TARGETING_TAG, runId, `+${sinceStart()}ms`, ...a);
  };
  const err = (...a) => {
    if (TARGETING_DEBUG) console.error(TARGETING_TAG, runId, `+${sinceStart()}ms`, ...a);
  };

  PAYLOAD.meta = PAYLOAD.meta || {};

  const U = FUCompanion.Utilities;
  const { str, norm, cloneArray, uniq } = U;

  function payloadSnapshot(label = "PAYLOAD SNAPSHOT") {
    log(label, {
      source: str(PAYLOAD?.source, "Unknown"),
      executionMode: str(PAYLOAD?.meta?.executionMode),
      isPassiveExecution: !!PAYLOAD?.meta?.isPassiveExecution,
      skillName:
        str(PAYLOAD?.core?.skillName) ||
        str(PAYLOAD?.dataCore?.skillName) ||
        "Unnamed Action",
      skillTypeRaw:
        str(PAYLOAD?.core?.skillTypeRaw) ||
        str(PAYLOAD?.dataCore?.skillTypeRaw) ||
        str(PAYLOAD?.meta?.skillTypeRaw),
      skillTargetRaw:
        str(PAYLOAD?.core?.skillTargetRaw) ||
        str(PAYLOAD?.dataCore?.skillTargetRaw) ||
        str(PAYLOAD?.meta?.skillTargetRaw),
      ownerUserId: PAYLOAD?.meta?.ownerUserId ?? null,
      attackerUuid:
        PAYLOAD?.meta?.attackerUuid ??
        PAYLOAD?.attackerActorUuid ??
        PAYLOAD?.attackerUuid ??
        null,
      targetsCount: Array.isArray(PAYLOAD?.targets) ? PAYLOAD.targets.length : 0,
      originalTargetUUIDsCount: Array.isArray(PAYLOAD?.originalTargetUUIDs) ? PAYLOAD.originalTargetUUIDs.length : 0,
      originalTargetActorUUIDsCount: Array.isArray(PAYLOAD?.originalTargetActorUUIDs) ? PAYLOAD.originalTargetActorUUIDs.length : 0,
      metaOriginalTargetUUIDsCount: Array.isArray(PAYLOAD?.meta?.originalTargetUUIDs) ? PAYLOAD.meta.originalTargetUUIDs.length : 0,
      metaOriginalTargetActorUUIDsCount: Array.isArray(PAYLOAD?.meta?.originalTargetActorUUIDs) ? PAYLOAD.meta.originalTargetActorUUIDs.length : 0,
      abort: !!PAYLOAD?.meta?.__abortPipeline,
      abortReason: PAYLOAD?.meta?.__abortReason ?? null
    });
  }

  function cancelPipeline(reason = "Targeting cancelled.", {
    notify = false,
    markNotified = true,
    stage = "unknown"
  } = {}) {
    PAYLOAD.meta.__abortPipeline = true;
    PAYLOAD.meta.__abortReason = String(reason ?? "Targeting cancelled.");
    if (markNotified) PAYLOAD.meta.__abortNotified = true;
    if (notify) ui.notifications?.warn?.(PAYLOAD.meta.__abortReason);

    warn("PIPELINE CANCELLED", {
      stage,
      reason: PAYLOAD.meta.__abortReason,
      notify,
      markNotified
    });

    payloadSnapshot("PAYLOAD AFTER CANCEL");

    return {
      ok: false,
      cancelled: true,
      aborted: true,
      reason: PAYLOAD.meta.__abortReason,
      stage
    };
  }

  function getTargetingApi() {
    try {
      return game.modules?.get("fabula-ultima-companion")?.api?.JRPGTargeting ?? null;
    } catch {
      return null;
    }
  }

  function safeTokenUuidsFromResult(result) {
    if (Array.isArray(result?.tokenUuids) && result.tokenUuids.length) {
      return result.tokenUuids.filter(Boolean).map(String);
    }

    if (Array.isArray(result?.tokens) && result.tokens.length) {
      return result.tokens
        .map(t => t?.document?.uuid ?? t?.uuid ?? null)
        .filter(Boolean)
        .map(String);
    }

    return [];
  }

  function safeActorUuidsFromResult(result) {
    if (Array.isArray(result?.actorUuids) && result.actorUuids.length) {
      return result.actorUuids.filter(Boolean).map(String);
    }

    if (Array.isArray(result?.actors) && result.actors.length) {
      return result.actors
        .map(a => a?.uuid ?? null)
        .filter(Boolean)
        .map(String);
    }

    return [];
  }

  const skillName =
    str(PAYLOAD?.core?.skillName) ||
    str(PAYLOAD?.dataCore?.skillName) ||
    "Unnamed Action";

  const skillTypeRaw =
    str(PAYLOAD?.core?.skillTypeRaw) ||
    str(PAYLOAD?.dataCore?.skillTypeRaw) ||
    str(PAYLOAD?.meta?.skillTypeRaw);

  const skillTargetRaw =
    str(PAYLOAD?.core?.skillTargetRaw) ||
    str(PAYLOAD?.dataCore?.skillTargetRaw) ||
    str(PAYLOAD?.meta?.skillTargetRaw);

  const ownerUserId =
    PAYLOAD?.meta?.ownerUserId ||
    game.userId ||
    null;

  const attackerUuid =
    PAYLOAD?.meta?.attackerUuid ??
    PAYLOAD?.attackerActorUuid ??
    PAYLOAD?.attackerUuid ??
    null;

  const source =
    str(PAYLOAD?.source) ||
    "Unknown";

  const executionMode = norm(PAYLOAD?.meta?.executionMode);
  const isPassiveExecution =
    PAYLOAD?.meta?.isPassiveExecution === true ||
    executionMode === "autopassive" ||
    norm(source) === "autopassive";

  const preExistingTargets = uniq(
    cloneArray(PAYLOAD?.originalTargetUUIDs).length
      ? cloneArray(PAYLOAD.originalTargetUUIDs)
      : cloneArray(PAYLOAD?.meta?.originalTargetUUIDs).length
        ? cloneArray(PAYLOAD.meta.originalTargetUUIDs)
        : cloneArray(PAYLOAD?.targets)
  );

  const preExistingActorTargets = uniq(
    cloneArray(PAYLOAD?.originalTargetActorUUIDs).length
      ? cloneArray(PAYLOAD.originalTargetActorUUIDs)
      : cloneArray(PAYLOAD?.meta?.originalTargetActorUUIDs).length
        ? cloneArray(PAYLOAD.meta.originalTargetActorUUIDs)
        : []
  );

  log("START", {
    AUTO,
    source,
    executionMode,
    isPassiveExecution,
    skillName,
    skillTypeRaw,
    skillTargetRaw,
    ownerUserId,
    attackerUuid,
    preExistingTargetsCount: preExistingTargets.length,
    preExistingActorTargetsCount: preExistingActorTargets.length
  });

  payloadSnapshot("INITIAL PAYLOAD");

  // Auto-passive execution skips targeting entirely.
  // Legacy fallback: skillTypeRaw === "passive" also skips for compatibility.
  if (isPassiveExecution || norm(skillTypeRaw) === "passive") {
    const skipReason = isPassiveExecution
      ? "Auto Passive execution"
      : "Passive skill";

    log("SKIP TARGETING", {
      reason: skipReason,
      executionMode,
      isPassiveExecution,
      skillTypeRaw,
      preservedTokenTargets: preExistingTargets,
      preservedActorTargets: preExistingActorTargets
    });

    PAYLOAD.targets = [...preExistingTargets];
    PAYLOAD.originalTargetUUIDs = [...preExistingTargets];
    PAYLOAD.originalTargetActorUUIDs = [...preExistingActorTargets];

    PAYLOAD.meta.originalTargetUUIDs = [...preExistingTargets];
    PAYLOAD.meta.originalTargetActorUUIDs = [...preExistingActorTargets];
    PAYLOAD.meta.isPassiveExecution = isPassiveExecution;
    if (isPassiveExecution && !PAYLOAD.meta.executionMode) {
      PAYLOAD.meta.executionMode = "autoPassive";
    }

    PAYLOAD.meta.targeting = {
      skipped: true,
      reason: skipReason,
      executionMode: PAYLOAD.meta.executionMode ?? null,
      isPassiveExecution,
      skillTypeRaw,
      skillTargetRaw,
      tokenUuids: [...preExistingTargets],
      actorUuids: [...preExistingActorTargets],
      selectedCount: preExistingTargets.length,
      userId: ownerUserId,
      sourceActorUuid: attackerUuid,
      finishedAtMs: sinceStart()
    };

    payloadSnapshot("PAYLOAD AFTER TARGETING SKIP");

    return {
      ok: true,
      skipped: true,
      reason: skipReason,
      tokenUuids: [...preExistingTargets],
      actorUuids: [...preExistingActorTargets],
      selectedCount: preExistingTargets.length,
      finishedAtMs: sinceStart()
    };
  }

  const api = getTargetingApi();
  if (!api?.requestTargeting) {
    ui.notifications?.error?.("JRPG Targeting API is not available.");
    return cancelPipeline("JRPG Targeting API is not available.", {
      notify: false,
      markNotified: true,
      stage: "api_lookup"
    });
  }

  const parsedTargeting = typeof api.parseTargetingText === "function"
    ? api.parseTargetingText(skillTargetRaw)
    : null;

  if (str(parsedTargeting?.mode).toLowerCase() === "none") {
    const skipReason = 'Skill target is "None"';

    log("SKIP TARGETING", {
      reason: skipReason,
      executionMode,
      skillTargetRaw,
      parsedTargeting,
      preservedTokenTargets: preExistingTargets,
      preservedActorTargets: preExistingActorTargets
    });

    PAYLOAD.targets = [...preExistingTargets];
    PAYLOAD.originalTargetUUIDs = [...preExistingTargets];
    PAYLOAD.originalTargetActorUUIDs = [...preExistingActorTargets];

    PAYLOAD.meta.originalTargetUUIDs = [...preExistingTargets];
    PAYLOAD.meta.originalTargetActorUUIDs = [...preExistingActorTargets];

    PAYLOAD.meta.targeting = {
      skipped: true,
      reason: skipReason,
      ok: true,
      confirmed: true,
      cancelled: false,
      status: "confirmed",
      mode: "none",
      category: str(parsedTargeting?.category),
      promptText: str(parsedTargeting?.promptText),
      selectedCount: preExistingTargets.length,
      tokenUuids: [...preExistingTargets],
      actorUuids: [...preExistingActorTargets],
      userId: ownerUserId,
      sourceActorUuid: attackerUuid,
      skillTypeRaw,
      skillTargetRaw,
      executionMode: PAYLOAD?.meta?.executionMode ?? null,
      isPassiveExecution: !!PAYLOAD?.meta?.isPassiveExecution,
      waitedMs: 0,
      finishedAtMs: sinceStart()
    };

    payloadSnapshot("PAYLOAD AFTER NONE TARGETING SKIP");

    return {
      ok: true,
      skipped: true,
      reason: skipReason,
      tokenUuids: [...preExistingTargets],
      actorUuids: [...preExistingActorTargets],
      selectedCount: preExistingTargets.length,
      waitedMs: 0,
      totalMacroMs: sinceStart()
    };
  }

  const actionStub = {
    name: skillName,
    system: {
      props: {
        skill_target: skillTargetRaw
      }
    }
  };

  let result = null;
  const apiCallStartedAt = nowMs();

  try {
    log("REQUEST TARGETING - BEFORE AWAIT", {
      userId: ownerUserId,
      skillTarget: skillTargetRaw,
      attackerUuid,
      actionStub
    });

    result = await api.requestTargeting({
      userId: ownerUserId,
      action: actionStub,
      skillTarget: skillTargetRaw,
      sourceActorUuid: attackerUuid
    });

    log("REQUEST TARGETING - AFTER AWAIT", {
      waitedMs: nowMs() - apiCallStartedAt,
      ok: !!result?.ok,
      confirmed: !!result?.confirmed,
      cancelled: !!result?.cancelled,
      status: result?.status ?? null,
      mode: result?.mode ?? null,
      category: result?.category ?? null,
      selectedCount: Number(result?.selectedCount ?? 0) || 0,
      tokenUuidsCount: Array.isArray(result?.tokenUuids) ? result.tokenUuids.length : 0,
      actorUuidsCount: Array.isArray(result?.actorUuids) ? result.actorUuids.length : 0
    });
  } catch (e) {
    err("REQUEST TARGETING THREW", {
      waitedMs: nowMs() - apiCallStartedAt,
      error: e
    });

    ui.notifications?.error?.("Targeting failed. Action cancelled.");
    return cancelPipeline("Targeting failed.", {
      notify: false,
      markNotified: true,
      stage: "requestTargeting_throw"
    });
  }

  if (!result?.ok) {
    warn("REQUEST TARGETING RETURNED NON-OK", {
      waitedMs: nowMs() - apiCallStartedAt,
      result
    });

    return cancelPipeline(
      result?.cancelled ? "Targeting cancelled." : "Targeting failed.",
      {
        notify: false,
        markNotified: true,
        stage: result?.cancelled ? "requestTargeting_cancelled" : "requestTargeting_non_ok"
      }
    );
  }

  const tokenUuids = uniq(safeTokenUuidsFromResult(result));
  const actorUuids = uniq(safeActorUuidsFromResult(result));

  log("NORMALIZED TARGET RESULT", {
    tokenUuids,
    actorUuids,
    selectedCountReported: Number(result?.selectedCount ?? 0) || 0,
    selectedCountNormalized: tokenUuids.length
  });

  // Canonical target fields for downstream pipeline
  PAYLOAD.targets = [...tokenUuids];
  PAYLOAD.originalTargetUUIDs = [...tokenUuids];
  PAYLOAD.originalTargetActorUUIDs = [...actorUuids];

  PAYLOAD.meta.originalTargetUUIDs = [...tokenUuids];
  PAYLOAD.meta.originalTargetActorUUIDs = [...actorUuids];

  PAYLOAD.meta.targeting = {
    ok: !!result?.ok,
    confirmed: !!result?.confirmed,
    cancelled: !!result?.cancelled,
    status: str(result?.status),
    mode: str(result?.mode),
    category: str(result?.category),
    promptText: str(result?.promptText),
    selectedCount: Number(result?.selectedCount ?? tokenUuids.length) || 0,
    tokenUuids: [...tokenUuids],
    actorUuids: [...actorUuids],
    userId: ownerUserId,
    sourceActorUuid: attackerUuid,
    skillTypeRaw,
    skillTargetRaw,
    executionMode: PAYLOAD?.meta?.executionMode ?? null,
    isPassiveExecution: !!PAYLOAD?.meta?.isPassiveExecution,
    waitedMs: nowMs() - apiCallStartedAt,
    finishedAtMs: sinceStart()
  };

  payloadSnapshot("PAYLOAD AFTER TARGETING SUCCESS");

  log("SUCCESS - RETURNING TO CALLER", {
    tokenUuids,
    actorUuids,
    selectedCount: PAYLOAD.meta.targeting.selectedCount,
    totalMacroMs: sinceStart()
  });

  return {
    ok: true,
    cancelled: false,
    skipped: false,
    tokenUuids: [...tokenUuids],
    actorUuids: [...actorUuids],
    selectedCount: PAYLOAD.meta.targeting.selectedCount,
    waitedMs: nowMs() - apiCallStartedAt,
    totalMacroMs: sinceStart()
  };
})();
