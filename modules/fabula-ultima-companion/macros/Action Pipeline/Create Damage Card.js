/*********************************************************
 * Create Damage Card (shim → module) · Foundry V12
 * Forwards __PAYLOAD to FabulaUltimaCompanion API.
 * Keeps your existing flow intact while using the module
 * so speakerless rendering works for ALL clients.
 *********************************************************/
return (async () => {
  const RUN_TAG = "[FU CreateDamageCard Shim]";
  const DBG_TAG = "[FU CreateDamageCard Shim][DBG]";
  const TRACE_ID = `CDC-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const dbg = (label, data) => {
    try {
      console.log(`${DBG_TAG} ${label}`, data);
    } catch (_) {}
  };

  const nonBlankString = (...values) => {
    for (const value of values) {
      const s = value == null ? "" : String(value).trim();
      if (s) return s;
    }
    return "";
  };

    const resolveDamageBatchIdFromPayload = (p = {}) => {
    return nonBlankString(
      p?.damageBatchId,
      p?.meta?.damageBatchId,
      p?.actionContext?.damageBatchId,
      p?.actionContext?.meta?.damageBatchId,
      p?.rootActionContext?.damageBatchId,
      p?.rootActionContext?.meta?.damageBatchId
    );
  };

  const buildReactionActionContext = (ctx, inherited = {}) => {
    if (!ctx || typeof ctx !== "object") {
      return inherited?.damageBatchId
        ? {
            meta: {
              damageBatchId: inherited.damageBatchId,
              rootDamageBatchId: inherited.damageBatchId
            }
          }
        : null;
    }

    const inheritedDamageBatchId = nonBlankString(
      inherited?.damageBatchId,
      ctx?.damageBatchId,
      ctx?.meta?.damageBatchId
    );

    return {
      core: {
        skillTypeRaw: ctx?.core?.skillTypeRaw ?? null,
        skillName: ctx?.core?.skillName ?? null
      },
      dataCore: {
        skillTypeRaw: ctx?.dataCore?.skillTypeRaw ?? null,
        skillName: ctx?.dataCore?.skillName ?? null,
        isSpell: !!ctx?.dataCore?.isSpell
      },
      meta: {
        skillTypeRaw: ctx?.meta?.skillTypeRaw ?? null,
        isSpellish: !!ctx?.meta?.isSpellish,

        // Batch inheritance for passive/reaction chains.
        damageBatchId: inheritedDamageBatchId || null,
        rootDamageBatchId: inheritedDamageBatchId || null,

        // Useful identity carry-through for future grouping/debug.
        actionId: ctx?.meta?.actionId ?? ctx?.actionId ?? null,
        actionCardId: ctx?.meta?.actionCardId ?? ctx?.actionCardId ?? null,
        actionCardMessageId: ctx?.meta?.actionCardMessageId ?? ctx?.actionCardMessageId ?? null,
        executionMode: ctx?.meta?.executionMode ?? null
      },
      sourceItem: {
        name: ctx?.sourceItem?.name ?? null,
        img: ctx?.sourceItem?.img ?? null,
        system: {
          props: {
            skill_type: ctx?.sourceItem?.system?.props?.skill_type ?? null
          }
        }
      }
    };
  };

  async function wait(ms) {
    return await new Promise(resolve => setTimeout(resolve, ms));
  }

  async function resolveUuidDoc(uuid) {
    try {
      if (!uuid || typeof uuid !== "string") return null;
      return await fromUuid(uuid);
    } catch (err) {
      dbg("resolveUuidDoc:failed", { TRACE_ID, uuid, error: err?.message ?? String(err) });
      return null;
    }
  }

  function isTokenUuid(v) {
    return typeof v === "string" && /\.Token\./.test(v);
  }

  function isActorUuid(v) {
    return typeof v === "string" && /^Actor\./.test(v);
  }

  async function resolveTokenDocFromAny(ref, actorRef = null) {
    const directDoc = await resolveUuidDoc(ref);

    if (directDoc?.documentName === "Token" || directDoc?.documentName === "TokenDocument") {
      return directDoc;
    }

    if (directDoc?.documentName === "Actor") {
      try {
        const activeToken =
          directDoc.getActiveTokens?.(true, true)?.[0] ??
          directDoc.getActiveTokens?.()?.[0] ??
          null;
        if (activeToken?.document) return activeToken.document;
      } catch (_) {}

      try {
        const protoDoc = directDoc.token?.document ?? directDoc.prototypeToken ?? null;
        if (protoDoc?.documentName === "Token" || protoDoc?.documentName === "TokenDocument") return protoDoc;
      } catch (_) {}

      return null;
    }

    if (directDoc?.token?.document) return directDoc.token.document;
    if (directDoc?.token?.documentName === "Token" || directDoc?.token?.documentName === "TokenDocument") return directDoc.token;
    if (directDoc?.document?.documentName === "Token" || directDoc?.documentName === "Token") return directDoc.document ?? directDoc;

    const actorDoc = actorRef ? await resolveUuidDoc(actorRef) : null;
    const actor =
      actorDoc?.documentName === "Actor"
        ? actorDoc
        : actorDoc?.actor ?? null;

    if (actor) {
      try {
        const activeToken =
          actor.getActiveTokens?.(true, true)?.[0] ??
          actor.getActiveTokens?.()?.[0] ??
          null;
        if (activeToken?.document) return activeToken.document;
      } catch (_) {}

      try {
        const protoDoc = actor.token?.document ?? actor.prototypeToken ?? null;
        if (protoDoc?.documentName === "Token" || protoDoc?.documentName === "TokenDocument") return protoDoc;
      } catch (_) {}
    }

    return null;
  }

  async function emitReactionPhaseLocalOnGM(payload, traceId = TRACE_ID) {
    dbg("emitReactionPhaseLocalOnGM:begin", {
      traceId,
      isGM: !!game.user?.isGM,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      oniPresent: !!globalThis.ONI,
      hasEmitFn: typeof globalThis.ONI?.emit === "function",
      trigger: payload?.trigger ?? null,
      kind: payload?.kind ?? null
    });

    try {
      if (!game.user?.isGM) {
        dbg("emitReactionPhaseLocalOnGM:abort:not-gm", { traceId, payload });
        return false;
      }

      const emit = globalThis.ONI?.emit;
      if (typeof emit !== "function") {
        console.warn(`${RUN_TAG} ONI.emit unavailable; reaction signal skipped`, { traceId, payload });
        return false;
      }

      let observedSync = false;
      let observedAsync = false;
      const hookId = Hooks.on("oni:reactionPhase", observedPayload => {
        if (observedPayload?.__debugTraceId !== traceId) return;
        observedAsync = true;
        dbg("emitReactionPhaseLocalOnGM:hook-observed", {
          traceId,
          observedPayload
        });
      });

      try {
        emit("oni:reactionPhase", payload, { local: true, world: false });
        observedSync = true;
        console.log(`${RUN_TAG} oni:reactionPhase emitted`, payload);
        dbg("emitReactionPhaseLocalOnGM:after-emit", {
          traceId,
          observedSync,
          observedAsync
        });
        await wait(50);
        dbg("emitReactionPhaseLocalOnGM:post-wait", {
          traceId,
          waitMs: 50,
          observedSync,
          observedAsync
        });
        return true;
      } finally {
        try {
          Hooks.off("oni:reactionPhase", hookId);
        } catch (err) {
          dbg("emitReactionPhaseLocalOnGM:hook-off-failed", {
            traceId,
            error: err?.message ?? String(err)
          });
        }
      }
    } catch (err) {
      console.error(`${RUN_TAG} Failed to emit oni:reactionPhase`, err, { traceId, payload });
      return false;
    }
  }

  // 1) Require module + API
  const mod = game.modules.get("fabula-ultima-companion");
  const api = mod?.api;
  if (!mod || !mod.active || !api?.createDamageCard) {
    console.error(`${RUN_TAG} Module not ready.`, { mod, api, TRACE_ID });
    return ui.notifications.error(
      "FabulaUltimaCompanion is missing or outdated. Enable/update the module."
    );
  }

    // 2) Gather payload from your established convention
  const payload = (typeof __PAYLOAD === "object" && __PAYLOAD) ? __PAYLOAD : {};

  // Damage Card batch identity.
  // This must exist before reaction/passive beacons are emitted so auto-passives
  // can inherit the same root batch.
  const DAMAGE_BATCH_ID = resolveDamageBatchIdFromPayload(payload);

  if (DAMAGE_BATCH_ID) {
    payload.meta = payload.meta || {};
    payload.damageBatchId = DAMAGE_BATCH_ID;
    payload.meta.damageBatchId = DAMAGE_BATCH_ID;

    if (payload.actionContext && typeof payload.actionContext === "object") {
      payload.actionContext.meta = payload.actionContext.meta || {};
      payload.actionContext.damageBatchId = DAMAGE_BATCH_ID;
      payload.actionContext.meta.damageBatchId = DAMAGE_BATCH_ID;
    }
  }

  dbg("start", {
    TRACE_ID,
    isGM: !!game.user?.isGM,
    userId: game.user?.id ?? null,
    userName: game.user?.name ?? null,
    payloadKeys: Object.keys(payload ?? {}),
    payloadPreview: {
      mode: payload?.mode ?? null,
      attackerUuid: payload?.attackerUuid ?? null,
      targetUuid: payload?.targetUuid ?? null,
      affected: payload?.affected ?? null,
      noEffectReason: payload?.noEffectReason ?? null,
      attackerName: payload?.attackerName ?? null,
      targetName: payload?.targetName ?? null,
      skillName: payload?.skillName ?? null,
      skillTypeRaw: payload?.skillTypeRaw ?? payload?.skill_type ?? null,
      hasActionContext: !!payload?.actionContext,
      elementType: payload?.elementType ?? null,
      finalValue: payload?.finalValue ?? null,
      displayedAmount: payload?.displayedAmount ?? null,
      damageBatchId: DAMAGE_BATCH_ID || null
    }
  });

  // 2b) ONI Reaction Phase beacons: per-target damage resolution / miss resolution
  try {
    if (game.user?.isGM && globalThis.ONI?.emit) {
      const {
        mode,

        // include attackerUuid so ReactionTriggerCore can resolve "SELF"
        attackerUuid,

        // Optional fallbacks (harmless if undefined)
        attackerActorUuid,
        sourceUuid,
        sourceActorUuid,
        actorUuid,

        attackerName,
        attackRange,
        sourceType,
        targetName,
        targetUuid,
        valueType,
        changeKey,
        elementType,
        weaponType,
        weaponEfficiencyUsed,
        affinityCode,
        effectivenessLabel,
        baseValue,
        finalValue,
        displayedAmount,
        shieldBreak,
        affected,
        noEffectReason,
        gmChanges,
        accuracyTotal,
        defenseUsed,
        skillName,
        skillTypeRaw,
        skill_type,
        isSpellish,
        isSpell,
        actionContext
      } = payload;

      const reactionActionContext = buildReactionActionContext(actionContext, {
        damageBatchId: DAMAGE_BATCH_ID || null
      });

      const resolvedSkillTypeRaw = nonBlankString(
        skillTypeRaw,
        skill_type,
        actionContext?.core?.skillTypeRaw,
        actionContext?.dataCore?.skillTypeRaw,
        actionContext?.meta?.skillTypeRaw,
        actionContext?.sourceItem?.system?.props?.skill_type
      );
      const resolvedSkillTypeNorm = resolvedSkillTypeRaw.toLowerCase();
      const resolvedIsSpellish = !!(
        isSpellish ||
        isSpell ||
        resolvedSkillTypeNorm === "spell" ||
        actionContext?.dataCore?.isSpell ||
        actionContext?.meta?.isSpellish
      );

      const normalizedMode = String(mode ?? "").trim().toLowerCase();
      const normalizedNoEffectReason = String(noEffectReason ?? "").trim().toLowerCase();
      const isMissCard =
        normalizedMode === "miss" ||
        normalizedNoEffectReason === "miss" ||
        (affected === false && normalizedNoEffectReason === "miss");

      dbg("reaction-branch:decision", {
        TRACE_ID,
        normalizedMode,
        normalizedNoEffectReason,
        affected,
        isMissCard,
        hasTargetUuid: !!targetUuid,
        hasAttackerUuid: !!(attackerUuid ?? sourceUuid),
        hasONIEmit: typeof globalThis.ONI?.emit === "function"
      });

      dbg("reaction-branch:skill-type-resolved", {
        TRACE_ID,
        topLevelSkillTypeRaw: skillTypeRaw ?? null,
        topLevelSkillTypeAlt: skill_type ?? null,
        resolvedSkillTypeRaw: resolvedSkillTypeRaw || null,
        resolvedIsSpellish,
        hasActionContext: !!actionContext,
        reactionActionContext
      });

      const attackerDoc = await resolveUuidDoc(attackerUuid ?? sourceUuid ?? null);
      const attackerActor =
        attackerDoc?.actor ??
        (attackerDoc?.documentName === "Actor" ? attackerDoc : null) ??
        null;

      const attackerTokenDoc = await resolveTokenDocFromAny(
        attackerUuid ?? sourceUuid ?? null,
        attackerActorUuid ?? sourceActorUuid ?? actorUuid ?? attackerActor?.uuid ?? null
      );

      const targetDoc = await resolveUuidDoc(targetUuid ?? null);
      const targetActor =
        targetDoc?.actor ??
        (targetDoc?.documentName === "Actor" ? targetDoc : null) ??
        null;

      const targetTokenDoc = await resolveTokenDocFromAny(
        targetUuid ?? null,
        targetActor?.uuid ?? null
      );

      const subjectTokenUuid =
        attackerTokenDoc?.uuid ??
        attackerTokenDoc?.document?.uuid ??
        (isTokenUuid(attackerUuid) ? attackerUuid : null) ??
        (isTokenUuid(sourceUuid) ? sourceUuid : null) ??
        null;

      const subjectActorUuid =
        attackerActorUuid ??
        sourceActorUuid ??
        actorUuid ??
        (isActorUuid(attackerUuid) ? attackerUuid : null) ??
        (isActorUuid(sourceUuid) ? sourceUuid : null) ??
        attackerActor?.uuid ??
        null;

      const sourceTokenUuid = subjectTokenUuid;

      const targetTokenUuid =
        targetTokenDoc?.uuid ??
        targetTokenDoc?.document?.uuid ??
        (isTokenUuid(targetUuid) ? targetUuid : null) ??
        null;

      const targetActorUuid =
        targetActor?.uuid ??
        (targetDoc?.documentName === "Actor" ? targetDoc.uuid : null) ??
        null;

      dbg("reaction-branch:resolved-context", {
        TRACE_ID,
        attackerDoc: attackerDoc ? {
          documentName: attackerDoc.documentName ?? null,
          uuid: attackerDoc.uuid ?? null,
          name: attackerDoc.name ?? null,
          actorName: attackerDoc.actor?.name ?? null
        } : null,
        attackerActor: attackerActor ? {
          uuid: attackerActor.uuid ?? null,
          name: attackerActor.name ?? null
        } : null,
        attackerTokenDoc: attackerTokenDoc ? {
          documentName: attackerTokenDoc.documentName ?? null,
          uuid: attackerTokenDoc.uuid ?? null,
          name: attackerTokenDoc.name ?? null
        } : null,
        targetDoc: targetDoc ? {
          documentName: targetDoc.documentName ?? null,
          uuid: targetDoc.uuid ?? null,
          name: targetDoc.name ?? null,
          actorName: targetDoc.actor?.name ?? null
        } : null,
        targetActor: targetActor ? {
          uuid: targetActor.uuid ?? null,
          name: targetActor.name ?? null
        } : null,
        targetTokenDoc: targetTokenDoc ? {
          documentName: targetTokenDoc.documentName ?? null,
          uuid: targetTokenDoc.uuid ?? null,
          name: targetTokenDoc.name ?? null
        } : null,
        subjectTokenUuid,
        subjectActorUuid,
        sourceTokenUuid,
        targetTokenUuid,
        targetActorUuid
      });

        const commonPayload = {
        timestamp: Date.now(),
        __debugTraceId: TRACE_ID,
        __debugSource: "CreateDamageCardShim",

        // Damage Card batch identity.
        // Auto-passives/reactions triggered from this result should inherit this,
        // so their Damage Cards can be captured into the same grouped ChatMessage.
        damageBatchId: DAMAGE_BATCH_ID || null,
        rootDamageBatchId: DAMAGE_BATCH_ID || null,
        meta: {
          damageBatchId: DAMAGE_BATCH_ID || null,
          rootDamageBatchId: DAMAGE_BATCH_ID || null,
          sourceDamageCardTraceId: TRACE_ID,

          actionId: actionContext?.meta?.actionId ?? actionContext?.actionId ?? null,
          actionCardId: actionContext?.meta?.actionCardId ?? actionContext?.actionCardId ?? null,
          actionCardMessageId: actionContext?.meta?.actionCardMessageId ?? actionContext?.actionCardMessageId ?? payload?.actionCardMsgId ?? null,
          executionMode: actionContext?.meta?.executionMode ?? null
        },

        // Subject / source creature
        attackerUuid: subjectTokenUuid,
        attackerActorUuid: attackerActorUuid ?? attackerActor?.uuid ?? null,

        sourceUuid: sourceTokenUuid ?? subjectTokenUuid,
        sourceTokenUuid: sourceTokenUuid ?? subjectTokenUuid,
        sourceActorUuid: sourceActorUuid ?? attackerActor?.uuid ?? null,

        tokenUuid: subjectTokenUuid,
        actorUuid: subjectActorUuid,

        // Explicit subject aliases
        subjectTokenUuid: subjectTokenUuid ?? null,
        subjectActorUuid: subjectActorUuid ?? null,

        // Target context
        targetUuid: targetTokenUuid,
        targetTokenUuid: targetTokenUuid,
        targetActorUuid,
        targets: targetTokenUuid ? [targetTokenUuid] : [],
        targetTokenUuids: targetTokenUuid ? [targetTokenUuid] : [],
        targetActorUuids: targetActorUuid ? [targetActorUuid] : [],

        // Helpful labels / metadata
        attackerName: attackerName ?? attackerActor?.name ?? null,
        targetName: targetName ?? targetDoc?.name ?? targetActor?.name ?? null,
        sourceType: sourceType ?? null,
        attackRange: attackRange ?? null,
        elementType: elementType ?? null,
        weaponType: weaponType ?? null,
        weaponEfficiencyUsed: weaponEfficiencyUsed ?? null,
        affinityCode: affinityCode ?? null,
        effectivenessLabel: effectivenessLabel ?? null,
        valueType: valueType ?? null,
        changeKey: changeKey ?? null,
        skillName: skillName ?? null,
        skillTypeRaw: resolvedSkillTypeRaw || null,
        skill_type: resolvedSkillTypeRaw || null,
        isSpellish: resolvedIsSpellish,
        // Harmful/aid classification carried through from the action card
        // (ADC populates `meta.actionIntent`). Lets reaction rows that hit
        // on resolution-phase triggers filter on intent the same way the
        // action_phase rows can.
        actionIntent: actionContext?.meta?.actionIntent ?? null,
        actionContext: reactionActionContext,

        // Numbers / flags
        baseValue: baseValue ?? null,
        finalValue: finalValue ?? null,
        displayedAmount: displayedAmount ?? null,
        shieldBreak: !!shieldBreak,
        affected: affected ?? null,
        noEffectReason: noEffectReason ?? null,
        gmChanges: gmChanges ?? null,
        accuracyTotal: Number.isFinite(Number(accuracyTotal)) ? Number(accuracyTotal) : null,
        defenseUsed: Number.isFinite(Number(defenseUsed)) ? Number(defenseUsed) : null
      };

      dbg("reaction-branch:common-payload", {
        TRACE_ID,
        commonPayload
      });

      if (isMissCard) {
        const missPayload = {
          ...commonPayload,
          kind: "miss_resolution",
          trigger: "creature_miss_action",
          result: "miss",

          // Extra explicit miss semantics
          missSourceTokenUuid: commonPayload.sourceTokenUuid ?? null,
          missSourceActorUuid: commonPayload.sourceActorUuid ?? null,
          missTargetTokenUuid: commonPayload.targetTokenUuid ?? null,
          missTargetActorUuid: commonPayload.targetActorUuid ?? null
        };

        dbg("reaction-branch:emit-miss:payload", {
          TRACE_ID,
          missPayload
        });

        const emitted = await emitReactionPhaseLocalOnGM(missPayload, `${TRACE_ID}-miss`);
        dbg("reaction-branch:emit-miss:result", {
          TRACE_ID,
          emitted
        });
            } else {
        // Successful hit branch:
        // this card only exists for a resolved non-miss target result,
        // so emit the generic "got hit by an action" trigger once here.
        if (targetTokenUuid) {
          const hitPayload = {
            ...commonPayload,
            kind: "hit_resolution",
            trigger: "creature_hit_by_action",
            result: "hit"
          };

          dbg("reaction-branch:emit-hit:payload", {
            TRACE_ID,
            hitPayload
          });

          const hitEmitted = await emitReactionPhaseLocalOnGM(
            hitPayload,
            `${TRACE_ID}-hit`
          );

          dbg("reaction-branch:emit-hit:result", {
            TRACE_ID,
            hitEmitted
          });
        } else {
          dbg("reaction-branch:emit-hit:skip:no-target", {
            TRACE_ID
          });
        }

        const normalizedChangeKey = String(changeKey ?? "").trim();
        const normalizedValueType = String(valueType ?? "").trim().toLowerCase();

        let resourceType = null;
        let changeKind = null;
        let primaryTrigger = null;
        let emitDealsDamage = false;

        switch (normalizedChangeKey) {
          case "hpReduction":
            resourceType = "hp";
            changeKind = "loss";
            primaryTrigger = "creature_takes_damage";
            emitDealsDamage = true;
            break;
          case "hpRecovery":
            resourceType = "hp";
            changeKind = "gain";
            primaryTrigger = "creature_recovers_hp";
            break;
          case "mpReduction":
            resourceType = "mp";
            changeKind = "loss";
            primaryTrigger = "creature_lose_mp";
            break;
          case "mpRecovery":
            resourceType = "mp";
            changeKind = "gain";
            primaryTrigger = "creature_recovers_mp";
            break;
          default:
            if (normalizedValueType === "hp") {
              resourceType = "hp";
              changeKind = Number(finalValue ?? displayedAmount ?? 0) >= 0 ? "loss" : "gain";
              primaryTrigger = changeKind === "loss" ? "creature_takes_damage" : "creature_recovers_hp";
              emitDealsDamage = changeKind === "loss";
            } else if (normalizedValueType === "mp") {
              resourceType = "mp";
              changeKind = Number(finalValue ?? displayedAmount ?? 0) >= 0 ? "loss" : "gain";
              primaryTrigger = changeKind === "loss" ? "creature_lose_mp" : "creature_recovers_mp";
            }
            break;
        }

        const baseReactionPayload = {
          ...commonPayload,
          kind: resourceType ? "resource_resolution" : "damage_resolution",
          trigger: null,
          resourceType,
          changeKind,
          changeKeyNormalized: normalizedChangeKey || null
        };

        dbg("reaction-branch:emit-resource:payload-base", {
          TRACE_ID,
          normalizedChangeKey,
          normalizedValueType,
          resourceType,
          changeKind,
          primaryTrigger,
          emitDealsDamage,
          baseReactionPayload
        });

        if (emitDealsDamage) {
          const dealsEmitted = await emitReactionPhaseLocalOnGM(
            {
              ...baseReactionPayload,
              trigger: "creature_deals_damage"
            },
            `${TRACE_ID}-deals`
          );

          dbg("reaction-branch:emit-resource:deals-result", {
            TRACE_ID,
            dealsEmitted
          });
        } else {
          dbg("reaction-branch:emit-resource:skip-deals", {
            TRACE_ID,
            normalizedChangeKey,
            normalizedValueType,
            resourceType,
            changeKind
          });
        }

        if (primaryTrigger && targetTokenUuid) {
          const targetEmitted = await emitReactionPhaseLocalOnGM(
            {
              ...baseReactionPayload,
              trigger: primaryTrigger
            },
            `${TRACE_ID}-${primaryTrigger}`
          );

          dbg("reaction-branch:emit-resource:target-result", {
            TRACE_ID,
            primaryTrigger,
            targetEmitted
          });

          // Affinity-derived triggers: piggyback on the resource resolution event
          // so reactions like "When you Absorb fire damage" can fire alongside
          // creature_takes_damage / creature_recovers_hp.
          //
          // Affinity codes (system convention):
          //   vu = Vulnerable, wp = Weak, rs = Resists, ab = Absorbs, im = Immune
          const AFFINITY_TO_TRIGGER = {
            vu: "creature_takes_vulnerable_damage",
            wp: "creature_takes_weak_damage",
            rs: "creature_resists_damage",
            ab: "creature_absorbs_damage",
            im: "creature_immune_damage"
          };
          const affinityTrigger = AFFINITY_TO_TRIGGER[String(commonPayload.effectivenessLabel ?? "").toLowerCase()];
          if (affinityTrigger) {
            await emitReactionPhaseLocalOnGM(
              {
                ...baseReactionPayload,
                trigger: affinityTrigger
              },
              `${TRACE_ID}-${affinityTrigger}`
            );
          }

          // Shield break: fires whenever the damage card flagged a broken shield,
          // regardless of affinity outcome.
          if (commonPayload.shieldBreak) {
            await emitReactionPhaseLocalOnGM(
              {
                ...baseReactionPayload,
                trigger: "creature_shield_break"
              },
              `${TRACE_ID}-shield-break`
            );
          }
        } else if (!primaryTrigger) {
          dbg("reaction-branch:emit-resource:skip-target:no-trigger", {
            TRACE_ID,
            normalizedChangeKey,
            normalizedValueType,
            valueType,
            changeKey
          });
        } else {
          dbg("reaction-branch:emit-resource:skip-target:no-target", {
            TRACE_ID,
            primaryTrigger
          });
        }
      }
    } else {
      dbg("reaction-branch:skipped", {
        TRACE_ID,
        isGM: !!game.user?.isGM,
        oniPresent: !!globalThis.ONI,
        hasEmitFn: typeof globalThis.ONI?.emit === "function"
      });
    }
  } catch (err) {
    console.warn(`${RUN_TAG} ReactionPhase emit failed (safe to ignore for now):`, err, payload, { TRACE_ID });
  }

 // 3) Create or batch-capture the Damage Card
//
// Important:
// - Reaction/passive beacons already emitted above.
// - This section only controls whether the visual ChatMessage is posted now
//   or captured into the active Damage Card batch.
try {
  const batchApi =
    globalThis.FUCompanion?.api?.damageCardBatch ??
    game.modules?.get("fabula-ultima-companion")?.api?.damageCardBatch ??
    null;

  const damageBatchId = DAMAGE_BATCH_ID || resolveDamageBatchIdFromPayload(payload);

  dbg("damage-card-output:begin", {
    TRACE_ID,
    hasBatchApi: !!batchApi,
    damageBatchId: damageBatchId || null,
    activeBatchId: batchApi?.getActiveBatchId?.() ?? null,
    payloadSummary: {
      mode: payload?.mode ?? null,
      targetUuid: payload?.targetUuid ?? null,
      targetName: payload?.targetName ?? null,
      noEffectReason: payload?.noEffectReason ?? null,
      affected: payload?.affected ?? null,
      finalValue: payload?.finalValue ?? null,
      displayedAmount: payload?.displayedAmount ?? null
    }
  });

  // If a batch is open, capture this payload instead of creating a separate
  // Foundry ChatMessage. This is NOT timing-based; it uses the active batch ID.
  if (batchApi && typeof batchApi.captureIfOpen === "function") {
    const captureResult = batchApi.captureIfOpen(payload, {
      source: "Create Damage Card.js shim"
    });

    if (captureResult?.captured) {
      dbg("damage-card-output:captured", {
        TRACE_ID,
        batchId: captureResult.batchId,
        entryIndex: captureResult.entryIndex,
        entries: captureResult.entries
      });

      return {
        ok: true,
        captured: true,
        batchId: captureResult.batchId,
        entryIndex: captureResult.entryIndex,
        traceId: TRACE_ID
      };
    }

dbg("damage-card-output:not-captured", {
  TRACE_ID,
  reason: captureResult?.reason ?? "unknown",
  batchId: (captureResult?.batchId ?? damageBatchId) || null
});
  }

  // Fallback / normal behavior:
  // If no batch is open, keep the old one-card-per-call behavior.
  dbg("api.createDamageCard:begin", {
    TRACE_ID,
    reason: "no_open_batch"
  });

  await api.createDamageCard(payload);

  dbg("api.createDamageCard:done", {
    TRACE_ID
  });

  return {
    ok: true,
    captured: false,
    posted: true,
    traceId: TRACE_ID
  };
} catch (err) {
  console.error(`${RUN_TAG} Failed to create/capture card:`, err, payload, { TRACE_ID });
  ui.notifications.error("Failed to create Damage Card (see console).");

  return {
    ok: false,
    reason: "create_or_capture_failed",
    error: String(err?.message ?? err),
    traceId: TRACE_ID
  };
}
})();
