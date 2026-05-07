/**
 * PassiveLogic-Resolution.js (Foundry V12)
 * - Timing: Resolution Phase (on Confirm)
 * - Input:  __PAYLOAD = actionCard payload (same object stored on chat message flag)
 *
 * Contract:
 *   globalThis.__PAYLOAD   (actionCard payload)
 *   globalThis.__ARGS      (confirm args object; can mutate)
 *   globalThis.__TARGETS   (uuid array; usually originalTargetUUIDs)
 *   globalThis.__CHAT_MSG  (ChatMessage object)
 *
 * Behavior:
 * - Mirrors CustomLogic-Resolution timing, but delegates to the passive
 *   resolution engine that scans owner items for system.props.passive_logic_resolution.
 * - Intended to run AFTER CustomLogic-Resolution and BEFORE final apply.
 *
 * IMPORTANT:
 * - This macro RETURNS a Promise at top-level so the Confirm pipeline can await properly.
 * - This wrapper expects the passive engine to expose:
 *     FUCompanion.api.passiveModifier.evaluatePassiveResolutionModifiers(...)
 *
 * NEW (GM bridge):
 * - If current client is not GM and GMExecutor.executeSnippet(...) is available,
 *   passive resolution evaluation is executed through the generic GM executor
 * - Returned payload/args are merged back into the live PAYLOAD / ARGS objects
 *
 * NEW (passive card behavior):
 * - Show passive card only when the ORIGINAL resolution evaluation actually ran passive scripts
 * - Do NOT show the passive card for the later autoPassive wrapper execution
 * - If no passive script ran, no passive card is shown
 */

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[ONI][PassiveLogic-Resolution]";
const DEBUG = true; // set false later to quiet logs

return (async () => {
  const runId = `PL-RES-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const { log, warn, err } = FUCompanion.createLogger(`${TAG} ${runId}`, DEBUG);

  const t0 = performance.now();

  const PAYLOAD = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : null;
  if (!PAYLOAD) {
    warn("No __PAYLOAD received. Aborting.");
    return { ok: false, runId, reason: "no-payload" };
  }

  const ARGS = (typeof __ARGS !== "undefined" && __ARGS) ? __ARGS : {};
  const CHAT_MSG = (typeof __CHAT_MSG !== "undefined" && __CHAT_MSG) ? __CHAT_MSG : null;

  const targets =
    (Array.isArray(PAYLOAD?.originalTargetUUIDs) && PAYLOAD.originalTargetUUIDs.length)
      ? PAYLOAD.originalTargetUUIDs
      : (Array.isArray(PAYLOAD?.targets) ? PAYLOAD.targets : []);

  const attackerUuid =
    PAYLOAD?.meta?.attackerUuid ??
    PAYLOAD?.attackerActorUuid ??
    PAYLOAD?.attackerUuid ??
    ARGS?.attackerUuid ??
    null;

  PAYLOAD.meta = PAYLOAD.meta || {};

  const gmExecutor =
    game.modules?.get(MODULE_ID)?.api?.GMExecutor ??
    globalThis.FUCompanion?.api?.GMExecutor ??
    null;

const canUseGMExecutor = !!(
  !game.user?.isGM &&
  gmExecutor &&
  typeof gmExecutor.executeSnippet === "function"
);

// Passive wrappers do not inspect individual passive script text here,
// so they only respect the shared payload/meta opt-out flag.
const forceLocalExecution = !!(
  PAYLOAD?.meta?.__forceLocalUiExecution === true ||
  PAYLOAD?.meta?.passiveLogicForceLocal === true
);

const shouldUseGMExecutor = canUseGMExecutor && !forceLocalExecution;

  const passiveApi =
    globalThis.FUCompanion?.api?.passiveModifier ??
    game.modules?.get(MODULE_ID)?.api?.passiveModifier ??
    null;

  const finalElement = String(
    ARGS?.elementType ??
    PAYLOAD?.meta?.elementType ??
    PAYLOAD?.advPayload?.elementType ??
    ""
  ).trim().toLowerCase() || null;

  const snap = () => ({
    elementType: ARGS?.elementType ?? null,
    weaponType: ARGS?.weaponType ?? null,
    isSpellish: ARGS?.isSpellish ?? null,
    hasDamageSection: ARGS?.hasDamageSection ?? null,

    advBaseValue: ARGS?.advPayload?.baseValue ?? PAYLOAD?.advPayload?.baseValue ?? null,
    advBonus: ARGS?.advPayload?.bonus ?? PAYLOAD?.advPayload?.bonus ?? null,
    advReduction: ARGS?.advPayload?.reduction ?? PAYLOAD?.advPayload?.reduction ?? null,
    advMultiplier: ARGS?.advPayload?.multiplier ?? PAYLOAD?.advPayload?.multiplier ?? null,

    targetsCount: targets.length,

    abortConfirm: !!ARGS?.__abortConfirm,
    abortReason: ARGS?.__abortReason ?? null
  });

  const before = snap();

  function resolveDocumentName(doc) {
    return doc?.documentName ?? doc?.constructor?.name ?? null;
  }

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;
    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("resolveDocument failed", { uuidOrDoc, error: String(e?.message ?? e) });
      return null;
    }
  }

  function coerceActorFromDoc(doc) {
    if (!doc) return null;
    if (resolveDocumentName(doc) === "Actor") return doc;
    if (doc?.actor) return doc.actor;
    if (doc?.object?.actor) return doc.object.actor;
    if (doc?.token?.actor) return doc.token.actor;
    if (doc?.parent?.actor) return doc.parent.actor;
    if (doc?.document?.actor) return doc.document.actor;
    return null;
  }

  async function resolveActor(uuidOrDoc) {
    const doc = await resolveDocument(uuidOrDoc);
    return coerceActorFromDoc(doc);
  }

  function mergeInPlace(target, source, { arrayKeys = [] } = {}) {
    if (!source || typeof source !== "object") return target;

    try {
      foundry.utils.mergeObject(target, source, {
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true,
        inplace: true
      });
    } catch (e) {
      warn("mergeObject failed; falling back to shallow assign", e);
      Object.assign(target, source);
    }

    for (const key of arrayKeys) {
      if (Array.isArray(source?.[key])) {
        target[key] = foundry.utils.deepClone(source[key]);
      }
    }

    return target;
  }

  const isAutoPassiveExecution =
    PAYLOAD?.meta?.executionMode === "autoPassive" ||
    PAYLOAD?.meta?.isPassiveExecution === true ||
    PAYLOAD?.source === "AutoPassive";

  async function broadcastAppliedPassiveCards(execResult) {
    const ranScripts = Array.isArray(execResult?.engineResult?.ranScripts)
      ? execResult.engineResult.ranScripts
      : [];

    if (isAutoPassiveExecution) {
      log("PASSIVE CARD broadcast skipped (autoPassive wrapper call)");
      return;
    }

    if (!ranScripts.length) {
      log("PASSIVE CARD broadcast skipped (no ranScripts)");
      return;
    }

    const cardApi =
      globalThis.FUCompanion?.api?.passiveCard?.broadcast ??
      game.modules?.get(MODULE_ID)?.api?.passiveCard?.broadcast ??
      globalThis.FUCompanion?.api?.passiveCardBroadcast ??
      null;

    if (typeof cardApi !== "function") {
      warn("PASSIVE CARD broadcast skipped (API missing)");
      return;
    }

    const cardAttackerUuid =
      PAYLOAD?.meta?.attackerUuid ??
      PAYLOAD?.attackerUuid ??
      PAYLOAD?.attackerActorUuid ??
      ARGS?.attackerUuid ??
      attackerUuid ??
      null;

    for (const row of ranScripts) {
      const title = String(row?.itemName ?? "").trim() || "Passive";

      try {
        await cardApi({
          title,
          attackerUuid: cardAttackerUuid,
          actionContext: PAYLOAD,
          options: {
            executionMode: "passive_resolution"
          }
        });

        log("PASSIVE CARD broadcast done", {
          title,
          attackerUuid: cardAttackerUuid
        });
      } catch (e) {
        warn("PASSIVE CARD broadcast failed", {
          title,
          attackerUuid: cardAttackerUuid,
          error: String(e?.message ?? e)
        });
      }
    }
  }

  const runPassiveLocally = async () => {
    if (typeof passiveApi?.evaluatePassiveResolutionModifiers !== "function") {
      return {
        ok: false,
        via: "local",
        error: "Passive resolution engine API missing"
      };
    }

    if (!attackerUuid) {
      return {
        ok: false,
        via: "local",
        error: "No attacker UUID found on payload/args"
      };
    }

    const actor = await resolveActor(attackerUuid);
    if (!actor) {
      return {
        ok: false,
        via: "local",
        error: `Could not resolve attacker actor: ${attackerUuid}`
      };
    }

    const engineResult = await passiveApi.evaluatePassiveResolutionModifiers({
      actor,
      payload: PAYLOAD,
      args: ARGS,
      targets,
      chatMsg: CHAT_MSG,
      finalElement
    });

    return {
      ok: !!engineResult?.ok,
      via: "local",
      actorName: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      engineResult: engineResult ?? null
    };
  };

  const runPassiveViaGM = async () => {
    if (!gmExecutor?.executeSnippet) {
      throw new Error("GMExecutor.executeSnippet is not available");
    }

    log("EXECUTE passive resolution via generic GMExecutor...", {
      callerUserId: game.user?.id ?? null,
      attackerUuid,
      targetsCount: targets.length,
      chatMsgId: CHAT_MSG?.id ?? null
    });

    const wrappedScript = `
const pmApi =
  globalThis.FUCompanion?.api?.passiveModifier ??
  game.modules?.get("${MODULE_ID}")?.api?.passiveModifier ??
  null;

if (typeof pmApi?.evaluatePassiveResolutionModifiers !== "function") {
  throw new Error("Passive resolution engine API missing");
}

const actor = await env.resolveActor(env.actorUuid);
if (!actor) {
  throw new Error(\`Could not resolve attacker actor: \${env.actorUuid ?? "null"}\`);
}

const engineResult = await pmApi.evaluatePassiveResolutionModifiers({
  actor,
  payload,
  args,
  targets,
  chatMsg: null,
  finalElement: String(
    args?.elementType ??
    payload?.meta?.elementType ??
    payload?.advPayload?.elementType ??
    ""
  ).trim().toLowerCase() || null
});

return {
  actorName: actor?.name ?? null,
  actorUuid: actor?.uuid ?? null,
  engineResult: engineResult ?? null
};
    `.trim();

    const remote = await gmExecutor.executeSnippet({
      mode: "resolution",
      scriptText: wrappedScript,
      payload: PAYLOAD,
      args: ARGS,
      targets,
      chatMsgId: CHAT_MSG?.id ?? null,
      actorUuid: attackerUuid ?? null,
      metadata: {
        origin: "PassiveLogic-Resolution",
        runId
      }
    });

    log("GMExecutor RETURN", {
      ok: !!remote?.ok,
      mode: remote?.mode ?? null,
      hasPayload: !!remote?.payload,
      hasArgs: !!remote?.args,
      error: remote?.error ?? null
    });

    if (remote?.payload) {
      mergeInPlace(PAYLOAD, remote.payload, {
        arrayKeys: ["targets", "originalTargetUUIDs"]
      });
    }

    if (remote?.args) {
      mergeInPlace(ARGS, remote.args);
    }

    const resultValue = remote?.resultValue ?? null;
    const engineResult = resultValue?.engineResult ?? null;
    const finalOk = !!(remote?.ok && (engineResult?.ok ?? true));

    if (!finalOk) {
      return {
        ok: false,
        via: "gm-executor-generic",
        error: String(remote?.error ?? engineResult?.error ?? "GMExecutor generic passive resolution failed"),
        stack: String(remote?.stack ?? "")
      };
    }

    return {
      ok: true,
      via: "gm-executor-generic",
      actorName: resultValue?.actorName ?? null,
      actorUuid: resultValue?.actorUuid ?? null,
      engineResult
    };
  };

  try {
    let execResult;

if (shouldUseGMExecutor) {
  execResult = await runPassiveViaGM();
} else {
  if (forceLocalExecution) {
    log("FORCING LOCAL EXECUTION for UI-driven passive wrapper.", {
      callerUserId: game.user?.id ?? null,
      skillName: PAYLOAD?.core?.skillName ?? null,
      chatMsgId: CHAT_MSG?.id ?? null
    });
  } else if (!game.user?.isGM && !gmExecutor?.executeSnippet) {
    warn("GMExecutor generic API is unavailable on a non-GM client. Falling back to local execution; permission-gated logic may fail.");
  }
  execResult = await runPassiveLocally();
}

    if (!execResult?.ok) {
      throw Object.assign(new Error(execResult?.error ?? "Passive logic resolution failed"), {
        stack: execResult?.stack ?? ""
      });
    }

    await broadcastAppliedPassiveCards(execResult);

    PAYLOAD.meta.__passiveLogicResolution = PAYLOAD.meta.__passiveLogicResolution || {};
    PAYLOAD.meta.__passiveLogicResolution.lastRun = {
      runId,
      ranAt: new Date().toISOString(),
      skillName: PAYLOAD?.core?.skillName ?? null,
      isPassiveExecution: isAutoPassiveExecution,
      passiveTriggerKey: PAYLOAD?.meta?.passiveTriggerKey ?? PAYLOAD?.meta?.triggerKey ?? null,
      executionPath: execResult?.via ?? (shouldUseGMExecutor ? "gm-executor-generic" : "local"),
      forceLocalExecution,
      actorName: execResult?.actorName ?? null,
      actorUuid: execResult?.actorUuid ?? null,
      engineSummary: {
        ranScripts: Array.isArray(execResult?.engineResult?.ranScripts) ? execResult.engineResult.ranScripts.length : 0,
        skippedScripts: Array.isArray(execResult?.engineResult?.skippedScripts) ? execResult.engineResult.skippedScripts.length : 0,
        errors: Array.isArray(execResult?.engineResult?.errors) ? execResult.engineResult.errors.length : 0
      }
    };

    const after = snap();
    log("DONE", {
      dtMs: Math.round(performance.now() - t0),
      executionPath: execResult?.via ?? (shouldUseGMExecutor ? "gm-executor-generic" : "local"),
      forceLocalExecution,
      changed: {
        elementType: `${before.elementType} → ${after.elementType}`,
        weaponType: `${before.weaponType} → ${after.weaponType}`,
        isSpellish: `${before.isSpellish} → ${after.isSpellish}`,
        hasDamageSection: `${before.hasDamageSection} → ${after.hasDamageSection}`,

        advBaseValue: `${before.advBaseValue} → ${after.advBaseValue}`,
        advBonus: `${before.advBonus} → ${after.advBonus}`,
        advReduction: `${before.advReduction} → ${after.advReduction}`,
        advMultiplier: `${before.advMultiplier} → ${after.advMultiplier}`,

        targetsCount: `${before.targetsCount} → ${after.targetsCount}`,

        abortConfirm: `${before.abortConfirm} → ${after.abortConfirm}`,
        abortReason: `${before.abortReason} → ${after.abortReason}`
      }
    });

    return {
      ok: true,
      runId,
      executionPath: execResult?.via ?? (shouldUseGMExecutor ? "gm-executor-generic" : "local"),
      cancelled: !!ARGS.__abortConfirm,
      reason: ARGS.__abortReason ?? null,
      passiveSkipped: !!PAYLOAD.meta.__passiveSkipped,
      passiveSkipReason: PAYLOAD.meta.__passiveSkipReason ?? null
    };
  } catch (e) {
    err("FATAL", e);
    return {
      ok: false,
      runId,
      error: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    };
  }
})();
