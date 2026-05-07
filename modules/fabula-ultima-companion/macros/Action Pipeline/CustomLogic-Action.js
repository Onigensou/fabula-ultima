/**
 * CustomLogic-Action.js (Foundry V12)
 * - Timing: Action Phase (pre-ResourceGate)
 * - Input:  __PAYLOAD (pipeline payload from ActionDataComputation)
 * - Behavior:
 *    - If __PAYLOAD.customLogicActionRaw is blank => skip
 *    - Else run snippet with access to:
 *        globalThis.__PAYLOAD  (same object, can mutate)
 *        globalThis.__TARGETS  (uuid list)
 *        args: (payload, targets, context)
 *
 * NEW (fixes "doesn't wait"):
 *  - This macro RETURNS a Promise (top-level `return (async()=>...)()`),
 *    so ActionDataComputation's `await cl.execute(...)` can truly wait.
 *
 * NEW (choice/cancel helpers):
 *  - context.ui.chooseButtons(...)  => await a button-choice dialog
 *  - context.cancelPipeline(reason) => hard cancel flag the pipeline
 *
 * NEW (passive gating helpers):
 *  - context.skipPassive(reason)    => silent cancel helper for passive execution
 *  - context.isPassiveExecution     => true when executionMode is autoPassive
 *
 * NEW (equipment helpers):
 *  - context.helpers.getEquippedItems()
 *  - context.helpers.getEquippedWeapons()
 *  - context.helpers.hasEquippedWeaponCategory([...])
 *  - context.helpers.getEquippedWeaponCategories()
 *
 * NEW (action-type debug helpers):
 *  - context.helpers.getActionTypeDebug()
 *  - context.helpers.getDetectedActionType()
 *
 * NEW (GM bridge):
 *  - If current client is not GM and GMExecutor.executeSnippet(...) is available,
 *    the snippet is executed through the generic GM executor
 *  - Returned payload is merged back into the live PAYLOAD object
 */

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[ONI][CustomLogic-Action]";
const DEBUG = true; // set false to quiet logs

// IMPORTANT: RETURN the Promise so callers can await the macro correctly.
return (async () => {
  const runId = `CL-ACT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const { log, warn, err } = FUCompanion.createLogger(`${TAG} ${runId}`, DEBUG);

  const t0 = performance.now();

  const PAYLOAD = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : null;
  if (!PAYLOAD) {
    warn("No __PAYLOAD received. Aborting.");
    return { ok: false, runId, reason: "no-payload" };
  }

  // Fetch script text (blank = no custom logic)
  const raw = String(PAYLOAD.customLogicActionRaw ?? PAYLOAD?.meta?.customLogicActionRaw ?? "");
  const scriptText = raw.trim();

  // Targets list (uuid array)
  const targets = Array.isArray(PAYLOAD.targets) ? PAYLOAD.targets : [];
  const attackerUuid =
    PAYLOAD?.meta?.attackerUuid ??
    PAYLOAD?.attackerActorUuid ??
    PAYLOAD?.attackerUuid ??
    null;

  // Ensure meta exists
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

// Local-only opt-out for UI-driven snippets.
// Use this for skills whose custom logic should open dialogs on the client
// that clicked the button, not on the GM client.
const forceLocalExecution = !!(
  PAYLOAD?.meta?.customLogicActionForceLocal === true ||
  /@local-ui-only\b/i.test(scriptText) ||
  /@force-local\b/i.test(scriptText)
);

const shouldUseGMExecutor = canUseGMExecutor && !forceLocalExecution;

  // Lightweight snapshot for debug diffs
  const snap = () => ({
    costRaw: PAYLOAD?.meta?.costRaw ?? null,
    baseValue: PAYLOAD?.advPayload?.baseValue ?? null,
    bonus: PAYLOAD?.advPayload?.bonus ?? null,
    reduction: PAYLOAD?.advPayload?.reduction ?? null,
    multiplier: PAYLOAD?.advPayload?.multiplier ?? null,
    targetsCount: (Array.isArray(PAYLOAD.targets) ? PAYLOAD.targets.length : 0),
    abort: !!PAYLOAD?.meta?.__abortPipeline,
    abortReason: PAYLOAD?.meta?.__abortReason ?? null
  });

  const before = snap();

  // If blank script => skip cleanly
  if (!scriptText) {
    PAYLOAD.meta.hasCustomLogicAction = false;
    log("SKIP (blank customLogicActionRaw)", {
      attackerUuid,
      skill: PAYLOAD?.core?.skillName ?? PAYLOAD?.dataCore?.skillName ?? null,
      targetsCount: targets.length
    });
    return { ok: true, runId, skipped: true };
  }

  PAYLOAD.meta.hasCustomLogicAction = true;

  // ──────────────────────────────────────────────────────────
  // Helper functions
  // ──────────────────────────────────────────────────────────
  const toLower = (v) => String(v ?? "").trim().toLowerCase();
  const uniq = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).filter(v => v != null && String(v).trim() !== "")));

  const normalizeWeaponCategory = (value) => {
    const rawValue = String(value ?? "").trim();
    if (!rawValue) return "";
    const v = rawValue.toLowerCase();
    const aliases = {
      arcana: "arcane",
      arcane: "arcane",
      wand: "arcane",
      staff: "arcane",
      tome: "arcane",
      dagger: "dagger",
      knife: "dagger",
      flail: "flail",
      mace: "flail"
    };
    return aliases[v] ?? v;
  };

  const getItemProps = (item) => item?.system?.props ?? {};

  const isItemEquipped = (item) => {
    const props = getItemProps(item);
    const candidates = [
      props?.isEquipped,
      props?.equipped,
      item?.system?.equipped,
      item?.equipped,
      item?.isEquipped
    ];
    return candidates.some(v => v === true || v === "true" || v === 1 || v === "1");
  };

  const getItemTypeNormalized = (item) => {
    const props = getItemProps(item);
    return toLower(
      props?.item_type ??
      item?.system?.item_type ??
      item?.type ??
      ""
    );
  };

  const getItemCategoryNormalized = (item) => {
    const props = getItemProps(item);
    return normalizeWeaponCategory(
      props?.category ??
      item?.system?.category ??
      item?.category ??
      ""
    );
  };

  const resolveDocument = async (uuid) => {
    if (!uuid) return null;
    if (typeof uuid !== "string") return uuid;
    try {
      return await fromUuid(uuid);
    } catch (e) {
      warn("resolveDocument failed", { uuid, error: String(e?.message ?? e) });
      return null;
    }
  };

  const coerceActorFromDoc = (doc) => {
    if (!doc) return null;
    if (doc?.documentName === "Actor" || doc?.constructor?.name === "Actor") return doc;
    if (doc?.actor) return doc.actor;
    if (doc?.object?.actor) return doc.object.actor;
    if (doc?.token?.actor) return doc.token.actor;
    if (doc?.parent?.actor) return doc.parent.actor;
    if (doc?.document?.actor) return doc.document.actor;
    return null;
  };

  const resolveActor = async (uuidOrDoc) => {
    const doc = await resolveDocument(uuidOrDoc);
    const actor = coerceActorFromDoc(doc);
    if (actor) return actor;

    if (uuidOrDoc) {
      warn("resolveActor could not resolve an Actor", {
        input: typeof uuidOrDoc === "string" ? uuidOrDoc : (uuidOrDoc?.uuid ?? uuidOrDoc?.id ?? null),
        resolvedDocumentName: doc?.documentName ?? doc?.constructor?.name ?? null
      });
    }

    return null;
  };

  const mergeRemotePayloadInPlace = (target, source) => {
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

    // Known arrays that should replace cleanly
    if (Array.isArray(source.targets)) {
      target.targets = foundry.utils.deepClone(source.targets);
    }

    if (Array.isArray(source.originalTargetUUIDs)) {
      target.originalTargetUUIDs = foundry.utils.deepClone(source.originalTargetUUIDs);
    }

    return target;
  };

  const phasePayload =
    PAYLOAD?.meta?.reaction_phase_payload ??
    PAYLOAD?.reaction_phase_payload ??
    null;

  const buildActionTypeDebug = () => {
    const phase = phasePayload ?? {};
    const sourceItem = phase?.actionContext?.sourceItem ?? null;
    const candidates = {
      payload_core_skillTypeRaw: PAYLOAD?.core?.skillTypeRaw ?? null,
      payload_dataCore_skillTypeRaw: PAYLOAD?.dataCore?.skillTypeRaw ?? null,
      payload_meta_skillTypeRaw: PAYLOAD?.meta?.skillTypeRaw ?? null,
      payload_meta_sourceType: PAYLOAD?.meta?.sourceType ?? null,
      payload_source: PAYLOAD?.source ?? null,

      phase_skillTypeRaw: phase?.skillTypeRaw ?? null,
      phase_skill_type: phase?.skill_type ?? null,
      phase_sourceType: phase?.sourceType ?? null,
      phase_actionContext_core_skillTypeRaw: phase?.actionContext?.core?.skillTypeRaw ?? null,
      phase_actionContext_sourceType: phase?.actionContext?.sourceType ?? null,
      phase_sourceItem_skill_type: sourceItem?.system?.props?.skill_type ?? null,
      phase_sourceItem_isOffensiveSpell: sourceItem?.system?.props?.isOffensiveSpell ?? null,
      phase_sourceItem_name: sourceItem?.name ?? null
    };

    const normalized = {
      payloadCoreSkillType: toLower(candidates.payload_core_skillTypeRaw),
      payloadDataCoreSkillType: toLower(candidates.payload_dataCore_skillTypeRaw),
      payloadMetaSkillType: toLower(candidates.payload_meta_skillTypeRaw),
      payloadMetaSourceType: toLower(candidates.payload_meta_sourceType),
      payloadSource: toLower(candidates.payload_source),
      phaseSkillTypeRaw: toLower(candidates.phase_skillTypeRaw),
      phaseSkillType: toLower(candidates.phase_skill_type),
      phaseSourceType: toLower(candidates.phase_sourceType),
      phaseActionCoreSkillType: toLower(candidates.phase_actionContext_core_skillTypeRaw),
      phaseActionSourceType: toLower(candidates.phase_actionContext_sourceType),
      phaseSourceItemSkillType: toLower(candidates.phase_sourceItem_skill_type)
    };

    const spellCandidates = [
      normalized.payloadCoreSkillType,
      normalized.payloadDataCoreSkillType,
      normalized.payloadMetaSkillType,
      normalized.phaseSkillTypeRaw,
      normalized.phaseSkillType,
      normalized.phaseActionCoreSkillType,
      normalized.phaseSourceItemSkillType,
      normalized.payloadMetaSourceType,
      normalized.phaseSourceType,
      normalized.phaseActionSourceType
    ].filter(Boolean);

    const detectedActionType =
      spellCandidates.find(v => ["spell", "skill", "weapon"].includes(v)) ??
      spellCandidates[0] ??
      "";

    const isSpell = detectedActionType === "spell" || candidates.phase_sourceItem_isOffensiveSpell === true;

    return {
      detectedActionType,
      isSpell,
      spellCandidates,
      raw: candidates,
      normalized
    };
  };

  const actionTypeDebug = buildActionTypeDebug();

  // ──────────────────────────────────────────────────────────
  // Context helpers (Choice + Hard Cancel + Snippet logging)
  // ──────────────────────────────────────────────────────────
  const context = {
    runId,
    phase: "action",
    attackerUuid,
    attackerName: PAYLOAD?.meta?.attackerName ?? PAYLOAD?.core?.attackerName ?? null,
    skillName: PAYLOAD?.core?.skillName ?? PAYLOAD?.dataCore?.skillName ?? null,
    listType: PAYLOAD?.meta?.listType ?? null,
    executionMode: PAYLOAD?.meta?.executionMode ?? null,
    isPassiveExecution: (
      PAYLOAD?.meta?.executionMode === "autoPassive" ||
      PAYLOAD?.meta?.isPassiveExecution === true ||
      PAYLOAD?.source === "AutoPassive"
    ),
    passiveTriggerKey: PAYLOAD?.meta?.passiveTriggerKey ?? PAYLOAD?.meta?.triggerKey ?? null,
    passiveOrigin: PAYLOAD?.meta?.passiveOrigin ?? null,
    actionTypeDebug,

    // Snippet logging helpers
    log:  (...a) => log("[SNIPPET]", ...a),
    warn: (...a) => warn("[SNIPPET]", ...a),
    error:(...a) => err("[SNIPPET]", ...a),

    // Hard-cancel contract
    cancelPipeline: (reason = "Cancelled", { notify = true } = {}) => {
      PAYLOAD.meta.__abortPipeline = true;
      PAYLOAD.meta.__abortReason = String(reason ?? "Cancelled");
      PAYLOAD.meta.__abortNotify = !!notify;
      if (notify) ui.notifications?.warn?.(PAYLOAD.meta.__abortReason);
      warn("PIPELINE CANCELLED", { reason: PAYLOAD.meta.__abortReason, notify });
      return { cancelled: true, reason: PAYLOAD.meta.__abortReason };
    },

    // Passive-friendly silent gate helper
    skipPassive: (reason = "Passive conditions not met", { notify = false } = {}) => {
      if (!context.isPassiveExecution) {
        warn("skipPassive() called on non-passive execution; falling back to cancelPipeline.", { reason, notify });
      }
      PAYLOAD.meta.__passiveSkipped = true;
      PAYLOAD.meta.__passiveSkipReason = String(reason ?? "Passive conditions not met");
      return context.cancelPipeline(PAYLOAD.meta.__passiveSkipReason, { notify });
    },

    // UI helpers for choice dialogs
    ui: {
      chooseButtons: async ({
        title = "Choose",
        bodyHtml = "",
        choices = [],
        cancelLabel = "Cancel",
        hardCancel = false,
        userId = null,
        timeoutMs = 120000,
        width = 420
      } = {}) => {
        const choiceRun = `CHOICE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        log("CHOICE OPEN", {
          choiceRun,
          title,
          choicesCount: choices.length,
          hardCancel,
          userId,
          timeoutMs,
          width
        });

        const remoteApi =
          game.modules?.get(MODULE_ID)?.api?.RemoteChoice ??
          null;

        const targetUserId = String(userId ?? "").trim();

        // Remote path
        if (targetUserId && targetUserId !== String(game.user?.id ?? "")) {
          if (!remoteApi?.requestChoice) {
            warn("RemoteChoice API missing; falling back to local dialog.", {
              choiceRun,
              targetUserId
            });
          } else {
            const pick = await remoteApi.requestChoice({
              userId: targetUserId,
              title,
              bodyHtml,
              choices,
              cancelLabel,
              timeoutMs,
              width
            });

            log("CHOICE REMOTE RESULT", {
              choiceRun,
              targetUserId,
              pickedId: pick?.id ?? null,
              pickedValue: pick?.value ?? null
            });

            if (!pick && hardCancel) {
              PAYLOAD.meta.__abortPipeline = true;
              PAYLOAD.meta.__abortReason = "Choice dialog closed";
              PAYLOAD.meta.__abortNotify = true;
              warn("PIPELINE CANCELLED (remote dialog close)", {
                reason: PAYLOAD.meta.__abortReason
              });
            }

            return pick;
          }
        }

        // Local fallback path
        return await new Promise((resolve) => {
          let done = false;
          const safeResolve = (val) => {
            if (done) return;
            done = true;
            resolve(val);
          };

          const buttons = {};
          for (const c of choices) {
            const id = String(c.id ?? "");
            if (!id) continue;
            buttons[id] = {
              label: String(c.label ?? id),
              callback: () => {
                log("CHOICE CLICK", { choiceRun, id, value: c.value });
                safeResolve({ id, label: String(c.label ?? id), value: c.value });
              }
            };
          }

          buttons.__cancel = {
            label: cancelLabel,
            callback: () => {
              log("CHOICE CANCEL CLICK", { choiceRun });
              safeResolve(null);
            }
          };

          new Dialog({
            title,
            content: `
              <div style="display:flex; flex-direction:column; gap:.5rem;">
                ${bodyHtml || ""}
                <p style="margin:0; opacity:.75; font-size:12px;">(Waiting for your choice...)</p>
              </div>
            `,
            buttons,
            default: (choices?.[0]?.id ? String(choices[0].id) : "__cancel"),
            close: () => {
              log("CHOICE CLOSE", { choiceRun });

              if (hardCancel) {
                PAYLOAD.meta.__abortPipeline = true;
                PAYLOAD.meta.__abortReason = "Choice dialog closed";
                PAYLOAD.meta.__abortNotify = true;
                warn("PIPELINE CANCELLED (dialog close)", {
                  reason: PAYLOAD.meta.__abortReason
                });
              }

              safeResolve(null);
            }
          }, {
            width
          }).render(true);
        });
      }
    },

    helpers: {
      normalizeWeaponCategory,
      isItemEquipped,
      getItemTypeNormalized,
      getItemCategoryNormalized,
      getActionTypeDebug: () => foundry.utils.deepClone(actionTypeDebug),
      getDetectedActionType: () => actionTypeDebug.detectedActionType,

      getAttackerActor: async () => await resolveActor(attackerUuid),

      getEquippedItems: async ({ actor = null, itemTypes = null } = {}) => {
        const resolvedActor = actor ? await resolveActor(actor) : await resolveActor(attackerUuid);
        const allItems = Array.from(resolvedActor?.items ?? []);
        let equipped = allItems.filter(isItemEquipped);

        if (Array.isArray(itemTypes) && itemTypes.length) {
          const wanted = itemTypes.map(toLower);
          equipped = equipped.filter(item => wanted.includes(getItemTypeNormalized(item)));
        }

        return equipped;
      },

      getEquippedWeapons: async ({ actor = null } = {}) => {
        return await context.helpers.getEquippedItems({ actor, itemTypes: ["weapon"] });
      },

      getEquippedWeaponCategories: async ({ actor = null } = {}) => {
        const weapons = await context.helpers.getEquippedWeapons({ actor });
        return uniq(weapons.map(getItemCategoryNormalized));
      },

      hasEquippedWeaponCategory: async (wantedCategories = [], { actor = null } = {}) => {
        const wanted = uniq(wantedCategories.map(normalizeWeaponCategory));
        if (!wanted.length) return false;
        const equippedCats = await context.helpers.getEquippedWeaponCategories({ actor });
        return equippedCats.some(cat => wanted.includes(cat));
      },

      debugEquipmentSnapshot: async ({ actor = null } = {}) => {
        const resolvedActor = actor ? await resolveActor(actor) : await resolveActor(attackerUuid);
        const equipped = await context.helpers.getEquippedItems({ actor: resolvedActor });
        return {
          actorName: resolvedActor?.name ?? null,
          actorUuid: resolvedActor?.uuid ?? null,
          equipped: equipped.map(item => ({
            name: item?.name ?? null,
            itemType: getItemTypeNormalized(item),
            category: getItemCategoryNormalized(item)
          }))
        };
      }
    }
  };

  log("START", {
    attackerUuid,
    skillName: context.skillName,
    targetsCount: targets.length,
    scriptLen: scriptText.length,
    isPassiveExecution: context.isPassiveExecution,
    passiveTriggerKey: context.passiveTriggerKey,
    actionTypeDetected: actionTypeDebug.detectedActionType,
    actionTypeIsSpell: actionTypeDebug.isSpell,
    actionTypeCandidates: actionTypeDebug.spellCandidates,
    actionTypeRaw: actionTypeDebug.raw,
    executionPath: shouldUseGMExecutor ? "gm-executor-generic" : "local",
    forceLocalExecution,
    preview: scriptText.slice(0, 160)
  });

  if (!actionTypeDebug.isSpell) {
    log("ACTION TYPE DEBUG (non-spell interpretation)", {
      detectedActionType: actionTypeDebug.detectedActionType,
      candidates: actionTypeDebug.spellCandidates,
      normalized: actionTypeDebug.normalized,
      raw: actionTypeDebug.raw
    });
  }

  const runSnippetLocally = async () => {
    // Expose globals (so snippet can use __PAYLOAD instantly)
    const prevPAYLOAD = globalThis.__PAYLOAD;
    const prevTARGETS = globalThis.__TARGETS;
    globalThis.__PAYLOAD = PAYLOAD;
    globalThis.__TARGETS = targets;

    try {
      const wrapped = `return (async () => {\n${scriptText}\n})();`;
      const fn = new Function("payload", "targets", "context", wrapped);

      log("EXECUTE snippet locally (wrapped async)...");
      const result = fn(PAYLOAD, targets, context);

      const isPromise = !!(result && typeof result.then === "function");
      log("SNIPPET RETURN", { type: typeof result, isPromise, via: "local" });

      if (isPromise) {
        await result;
      } else {
        warn("Snippet did not return a Promise (unexpected with wrapper). Continuing.");
      }

      return { ok: true, via: "local" };
    } finally {
      globalThis.__PAYLOAD = prevPAYLOAD;
      globalThis.__TARGETS = prevTARGETS;
    }
  };

  const runSnippetViaGM = async () => {
    if (!gmExecutor?.executeSnippet) {
      throw new Error("GMExecutor.executeSnippet is not available");
    }

    log("EXECUTE snippet via generic GMExecutor...", {
      callerUserId: game.user?.id ?? null,
      attackerUuid,
      targetsCount: targets.length
    });

    const wrappedScript = `
const context = env.makeContext("action");
${scriptText}
    `.trim();

    const remote = await gmExecutor.executeSnippet({
      mode: "action",
      scriptText: wrappedScript,
      payload: PAYLOAD,
      targets,
      actorUuid: attackerUuid ?? null,
      metadata: {
        origin: "CustomLogic-Action",
        runId
      }
    });

    log("GMExecutor RETURN", {
      ok: !!remote?.ok,
      mode: remote?.mode ?? null,
      hasPayload: !!remote?.payload,
      error: remote?.error ?? null
    });

    if (remote?.payload) {
      mergeRemotePayloadInPlace(PAYLOAD, remote.payload);
    }

    if (!remote?.ok) {
      return {
        ok: false,
        via: "gm-executor-generic",
        error: String(remote?.error ?? "GMExecutor generic action failed"),
        stack: String(remote?.stack ?? "")
      };
    }

    return { ok: true, via: "gm-executor-generic" };
  };

  try {
    let execResult;

    if (shouldUseGMExecutor) {
  execResult = await runSnippetViaGM();
} else {
  if (forceLocalExecution) {
    log("FORCING LOCAL EXECUTION for UI-driven custom logic.", {
      callerUserId: game.user?.id ?? null,
      skillName: context.skillName
    });
  } else if (!game.user?.isGM && !gmExecutor?.executeSnippet) {
    warn("GMExecutor generic API is unavailable on a non-GM client. Falling back to local execution; permission-gated logic may fail.");
  }

  execResult = await runSnippetLocally();
}

    if (!execResult?.ok) {
      throw Object.assign(new Error(execResult?.error ?? "Custom logic execution failed"), {
        stack: execResult?.stack ?? ""
      });
    }

    // Stamp last run info
    PAYLOAD.meta.__customLogicAction = PAYLOAD.meta.__customLogicAction || {};
    PAYLOAD.meta.__customLogicAction.lastRun = {
      runId,
      ranAt: new Date().toISOString(),
      skillName: context.skillName,
      isPassiveExecution: context.isPassiveExecution,
      passiveTriggerKey: context.passiveTriggerKey,
      actionTypeDetected: actionTypeDebug.detectedActionType,
      actionTypeIsSpell: actionTypeDebug.isSpell,
      actionTypeCandidates: actionTypeDebug.spellCandidates,
      executionPath: execResult?.via ?? (shouldUseGMExecutor ? "gm-executor-generic" : "local")
    };

    const after = snap();

    log("DONE", {
      dtMs: Math.round(performance.now() - t0),
      executionPath: execResult?.via ?? (shouldUseGMExecutor ? "gm-executor-generic" : "local"),
      forceLocalExecution,
      changed: {
        costRaw: `${before.costRaw} → ${after.costRaw}`,
        baseValue: `${before.baseValue} → ${after.baseValue}`,
        bonus: `${before.bonus} → ${after.bonus}`,
        reduction: `${before.reduction} → ${after.reduction}`,
        multiplier: `${before.multiplier} → ${after.multiplier}`,
        targetsCount: `${before.targetsCount} → ${after.targetsCount}`,
        abort: `${before.abort} → ${after.abort}`,
        abortReason: `${before.abortReason} → ${after.abortReason}`
      }
    });

    return {
      ok: true,
      runId,
      executionPath: execResult?.via ?? (canUseGMExecutor ? "gm-executor-generic" : "local"),
      cancelled: !!PAYLOAD.meta.__abortPipeline,
      reason: PAYLOAD.meta.__abortReason ?? null,
      passiveSkipped: !!PAYLOAD.meta.__passiveSkipped,
      passiveSkipReason: PAYLOAD.meta.__passiveSkipReason ?? null,
      actionTypeDetected: actionTypeDebug.detectedActionType,
      actionTypeIsSpell: actionTypeDebug.isSpell
    };
  } catch (e) {
    err("ERROR while running custom logic (Action Phase).", e);

    PAYLOAD.meta.__customLogicAction = PAYLOAD.meta.__customLogicAction || {};
    PAYLOAD.meta.__customLogicAction.error = {
      runId,
      ranAt: new Date().toISOString(),
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    };

    // Do NOT break pipeline by default (matches your current behavior)
    return { ok: false, runId, error: String(e?.message ?? e) };
  }
})();
