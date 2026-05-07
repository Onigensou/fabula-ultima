/**
 * CustomLogic-Resolution.js (Foundry V12)
 * - Timing: Resolution Phase (on Confirm)
 * - Input:  __PAYLOAD = actionCard payload (same object stored on chat message flag)
 *
 * Snippet access:
 *   globalThis.__PAYLOAD   (actionCard payload)
 *   globalThis.__ARGS      (confirm args object; can mutate)
 *   globalThis.__TARGETS   (uuid array; usually originalTargetUUIDs)
 *   globalThis.__CHAT_MSG  (ChatMessage object)
 *
 * Also receives (payload, args, targets, context) as function params.
 *
 * IMPORTANT:
 * - This macro RETURNS a Promise at top-level so the caller can truly await it.
 * - Snippet is wrapped in an async IIFE so snippets can use `await` at top level.
 *
 * NEW (parity with CustomLogic-Action):
 *  - context.cancelPipeline(...) aliases to confirm cancellation
 *  - context.skipPassive(...) available for silent passive-style gating
 *  - context.helpers.getEquippedItems()
 *  - context.helpers.getEquippedWeapons()
 *  - context.helpers.hasEquippedWeaponCategory([...])
 *  - context.helpers.getEquippedWeaponCategories()
 *  - context.helpers.getActionTypeDebug()
 *  - context.helpers.getDetectedActionType()
 *
 * NEW (GM bridge):
 *  - If current client is not GM and GMExecutor.executeSnippet(...) is available,
 *    the snippet is executed through the generic GM executor
 *  - Returned payload/args are merged back into the live PAYLOAD / ARGS objects
 */

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[ONI][CustomLogic-Resolution]";
const DEBUG = true; // set false later to quiet logs

// IMPORTANT: RETURN the Promise so the Confirm pipeline can await properly.
return (async () => {
  const runId = `CL-RES-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const { log, warn, err } = FUCompanion.createLogger(`${TAG} ${runId}`, DEBUG);

  const t0 = performance.now();

  const PAYLOAD = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : null;
  if (!PAYLOAD) {
    warn("No __PAYLOAD received. Aborting.");
    return { ok: false, runId, reason: "no-payload" };
  }

  const ARGS = (typeof __ARGS !== "undefined" && __ARGS) ? __ARGS : {};
  const CHAT_MSG = (typeof __CHAT_MSG !== "undefined" && __CHAT_MSG) ? __CHAT_MSG : null;

  // targets: prefer originalTargetUUIDs (saved at declare time), fallback to payload.targets
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

  // Script text
  const raw = String(PAYLOAD.customLogicResolutionRaw ?? PAYLOAD?.meta?.customLogicResolutionRaw ?? "");
  const scriptText = raw.trim();

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

// Selective local-only opt-out for UI-driven snippets.
// Default behavior remains GMExecutor.
// Opt-in local markers:
//   1) PAYLOAD.meta.__forceLocalUiExecution = true
//   2) script contains: // @local-ui-only
//   3) script contains: // @force-local
const forceLocalExecution = !!(
  PAYLOAD?.meta?.__forceLocalUiExecution === true ||
  /@local-ui-only\b/i.test(scriptText) ||
  /@force-local\b/i.test(scriptText)
);

const shouldUseGMExecutor = canUseGMExecutor && !forceLocalExecution;

  // Snapshot for debug diffs
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

  // If blank script => skip cleanly
  if (!scriptText) {
    PAYLOAD.meta.hasCustomLogicResolution = false;
    log("SKIP (blank customLogicResolutionRaw)", {
      attackerUuid,
      skillName: PAYLOAD?.core?.skillName ?? null,
      targetsCount: targets.length
    });
    return { ok: true, runId, skipped: true };
  }

  PAYLOAD.meta.hasCustomLogicResolution = true;

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

  const mergeInPlace = (target, source, { arrayKeys = [] } = {}) => {
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

      args_weaponType: ARGS?.weaponType ?? null,
      args_isSpellish: ARGS?.isSpellish ?? null,
      args_hasDamageSection: ARGS?.hasDamageSection ?? null,

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
      argsWeaponType: toLower(candidates.args_weaponType),
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
      normalized.argsWeaponType ??
      "";

    const isSpell = !!(
      detectedActionType === "spell" ||
      candidates.args_isSpellish === true ||
      candidates.phase_sourceItem_isOffensiveSpell === true
    );

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
  // Context helpers (Choice + Cancel + Snippet logging)
  // ──────────────────────────────────────────────────────────
  const context = {
    runId,
    phase: "resolution",
    attackerUuid,
    attackerName: PAYLOAD?.meta?.attackerName ?? PAYLOAD?.core?.attackerName ?? null,
    skillName: PAYLOAD?.core?.skillName ?? null,
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
    chatMsgId: CHAT_MSG?.id ?? null,

    // Snippet logging helpers
    log:   (...a) => log("[SNIPPET]", ...a),
    warn:  (...a) => warn("[SNIPPET]", ...a),
    error: (...a) => err("[SNIPPET]", ...a),

    /**
     * Hard cancel contract for Confirm pipeline.
     * (Your confirm handler must check ARGS.__abortConfirm to truly stop applying damage.)
     */
    cancelConfirm: (reason = "Cancelled", { notify = true } = {}) => {
      ARGS.__abortConfirm = true;
      ARGS.__abortReason = String(reason ?? "Cancelled");
      PAYLOAD.meta.__abortResolution = true;
      PAYLOAD.meta.__abortResolutionReason = ARGS.__abortReason;

      if (notify) ui.notifications?.warn?.(ARGS.__abortReason);
      warn("CONFIRM CANCELLED", { reason: ARGS.__abortReason });

      return { cancelled: true, reason: ARGS.__abortReason };
    },

    cancelPipeline: (reason = "Cancelled", { notify = true } = {}) => {
      return context.cancelConfirm(reason, { notify });
    },

    skipPassive: (reason = "Passive conditions not met", { notify = false } = {}) => {
      if (!context.isPassiveExecution) {
        warn("skipPassive() called on non-passive execution; falling back to cancelConfirm.", { reason, notify });
      }
      PAYLOAD.meta.__passiveSkipped = true;
      PAYLOAD.meta.__passiveSkipReason = String(reason ?? "Passive conditions not met");
      return context.cancelConfirm(PAYLOAD.meta.__passiveSkipReason, { notify });
    },

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
              ARGS.__abortConfirm = true;
              ARGS.__abortReason = "Choice dialog closed";
              PAYLOAD.meta.__abortResolution = true;
              PAYLOAD.meta.__abortResolutionReason = ARGS.__abortReason;
              warn("CONFIRM CANCELLED (remote dialog close)", {
                reason: ARGS.__abortReason
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
                ARGS.__abortConfirm = true;
                ARGS.__abortReason = "Choice dialog closed";
                PAYLOAD.meta.__abortResolution = true;
                PAYLOAD.meta.__abortResolutionReason = ARGS.__abortReason;
                warn("CONFIRM CANCELLED (dialog close)", {
                  reason: ARGS.__abortReason
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
    preview: scriptText.slice(0, 160),
    chatMsgId: context.chatMsgId
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
    // Expose globals for snippet convenience
    const prevPAYLOAD = globalThis.__PAYLOAD;
    const prevARGS    = globalThis.__ARGS;
    const prevTARGETS = globalThis.__TARGETS;
    const prevCHAT    = globalThis.__CHAT_MSG;

    globalThis.__PAYLOAD  = PAYLOAD;
    globalThis.__ARGS     = ARGS;
    globalThis.__TARGETS  = targets;
    globalThis.__CHAT_MSG = CHAT_MSG;

    try {
      const wrapped = `return (async () => {\n${scriptText}\n})();`;
      const fn = new Function("payload", "args", "targets", "context", wrapped);

      log("EXECUTE snippet locally (wrapped async)...");
      const result = fn(PAYLOAD, ARGS, targets, context);

      const isPromise = !!(result && typeof result.then === "function");
      log("SNIPPET RETURN", { type: typeof result, isPromise, via: "local" });

      if (isPromise) await result;
      else warn("Snippet did not return a Promise (unexpected with wrapper). Continuing.");

      return { ok: true, via: "local" };
    } finally {
      globalThis.__PAYLOAD  = prevPAYLOAD;
      globalThis.__ARGS     = prevARGS;
      globalThis.__TARGETS  = prevTARGETS;
      globalThis.__CHAT_MSG = prevCHAT;
    }
  };

  const runSnippetViaGM = async () => {
    if (!gmExecutor?.executeSnippet) {
      throw new Error("GMExecutor.executeSnippet is not available");
    }

    log("EXECUTE snippet via generic GMExecutor...", {
      callerUserId: game.user?.id ?? null,
      attackerUuid,
      targetsCount: targets.length,
      chatMsgId: CHAT_MSG?.id ?? null
    });

    const wrappedScript = `
const context = env.makeContext("resolution");
${scriptText}
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
        origin: "CustomLogic-Resolution",
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

    if (!remote?.ok) {
      return {
        ok: false,
        via: "gm-executor-generic",
        error: String(remote?.error ?? "GMExecutor generic resolution failed"),
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
      skillName: context.skillName,
      chatMsgId: context.chatMsgId
    });
  } else if (!game.user?.isGM && !gmExecutor?.executeSnippet) {
    warn("GMExecutor generic API is unavailable on a non-GM client. Falling back to local execution; permission-gated logic may fail.");
  }

  execResult = await runSnippetLocally();
}

    if (!execResult?.ok) {
      throw Object.assign(new Error(execResult?.error ?? "Custom logic resolution failed"), {
        stack: execResult?.stack ?? ""
      });
    }

    PAYLOAD.meta.__customLogicResolution = PAYLOAD.meta.__customLogicResolution || {};
    PAYLOAD.meta.__customLogicResolution.lastRun = {
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
      passiveSkipReason: PAYLOAD.meta.__passiveSkipReason ?? null,
      actionTypeDetected: actionTypeDebug.detectedActionType,
      actionTypeIsSpell: actionTypeDebug.isSpell
    };
  } catch (e) {
    err("ERROR while running custom logic (Resolution Phase).", e);
    PAYLOAD.meta.__customLogicResolution = PAYLOAD.meta.__customLogicResolution || {};
    PAYLOAD.meta.__customLogicResolution.error = {
      runId,
      ranAt: new Date().toISOString(),
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    };
    return { ok: false, runId, error: String(e?.message ?? e) };
  }
})();
