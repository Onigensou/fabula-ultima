// Passive Logic Engine (Foundry V12)
// Updated:
// - Action phase field:      .system.props.passive_logic_action
// - Resolution phase field:  .system.props.passive_logic_resolution
// - No legacy fallback
//
// Exposes:
//   FUCompanion.api.passiveModifier.evaluatePassiveModifiers({ actor, actionCtx, finalElement? })
//   FUCompanion.api.passiveModifier.evaluatePassiveResolutionModifiers({ actor, payload, args, targets, chatMsg, finalElement? })

(function () {
  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};

  const TAG = "[ONI][PassiveModifierEngine]";
  const MODULE_ID = "fabula-ultima-companion";
  const DEBUG = true; // <- toggle backend logs here

  function log(...a) {
    if (DEBUG) console.log(TAG, ...a);
  }
  function warn(...a) {
    if (DEBUG) console.warn(TAG, ...a);
  }
  function err(...a) {
    if (DEBUG) console.error(TAG, ...a);
  }

  function toNumber(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  function str(v, d = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : d;
  }

  function lower(v, d = "") {
    return str(v, d).toLowerCase();
  }

  function uniq(arr) {
    return Array.from(new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String)));
  }

  function clone(obj, fallback = {}) {
    try {
      if (obj == null) {
        return foundry?.utils?.deepClone
          ? foundry.utils.deepClone(fallback)
          : JSON.parse(JSON.stringify(fallback));
      }
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(obj)
        : JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return [...obj];
      if (obj && typeof obj === "object") return { ...obj };
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(fallback)
        : fallback;
    }
  }

  function getRichTextApi() {
    try {
      return game.modules?.get(MODULE_ID)?.api?.richText ?? null;
    } catch {
      return null;
    }
  }

  function toScript(raw) {
    const s = String(raw ?? "");
    if (!s.trim()) return "";
    const api = getRichTextApi();
    if (!api?.toScript) return s;
    try {
      return String(api.toScript(s) ?? "");
    } catch (e) {
      err("richText.toScript failed; falling back to raw text.", e);
      return s;
    }
  }

  function getItemProps(item) {
    return item?.system?.props ?? item?.system ?? {};
  }

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

  function normalizeWeaponCategory(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const v = raw.toLowerCase();
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
  }

  function isItemEquipped(item) {
    const props = getItemProps(item);
    const candidates = [
      props?.isEquipped,
      props?.equipped,
      item?.system?.equipped,
      item?.equipped,
      item?.isEquipped
    ];
    return candidates.some(v => v === true || v === "true" || v === 1 || v === "1");
  }

  function getItemTypeNormalized(item) {
    const props = getItemProps(item);
    return lower(
      props?.item_type ??
      item?.system?.item_type ??
      item?.type ??
      ""
    );
  }

  function getItemCategoryNormalized(item) {
    const props = getItemProps(item);
    return normalizeWeaponCategory(
      props?.category ??
      item?.system?.category ??
      item?.category ??
      ""
    );
  }

  function getDispositionFromResolved(doc, actor) {
    const tokenDoc =
      resolveDocumentName(doc) === "Token" || resolveDocumentName(doc) === "TokenDocument"
        ? doc
        : doc?.document ?? doc?.object?.document ?? null;

    const direct =
      tokenDoc?.disposition ??
      tokenDoc?.document?.disposition;

    if (Number.isFinite(Number(direct))) return Number(direct);

    const proto = actor?.prototypeToken?.disposition;
    if (Number.isFinite(Number(proto))) return Number(proto);

    return 0;
  }

  function buildActionTypeDebug(actionCtx = {}) {
    const phase =
      actionCtx?.meta?.reaction_phase_payload ??
      actionCtx?.reaction_phase_payload ??
      {};

    const sourceItem = phase?.actionContext?.sourceItem ?? null;

    const raw = {
      payload_core_skillTypeRaw: actionCtx?.core?.skillTypeRaw ?? null,
      payload_dataCore_skillTypeRaw: actionCtx?.dataCore?.skillTypeRaw ?? null,
      payload_meta_skillTypeRaw: actionCtx?.meta?.skillTypeRaw ?? null,
      payload_meta_sourceType: actionCtx?.meta?.sourceType ?? null,
      payload_source: actionCtx?.source ?? null,
      payload_typeDamage: actionCtx?.core?.typeDamageTxt ?? actionCtx?.dataCore?.typeDamageTxt ?? null,

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
      payloadCoreSkillType: lower(raw.payload_core_skillTypeRaw),
      payloadDataCoreSkillType: lower(raw.payload_dataCore_skillTypeRaw),
      payloadMetaSkillType: lower(raw.payload_meta_skillTypeRaw),
      payloadMetaSourceType: lower(raw.payload_meta_sourceType),
      payloadSource: lower(raw.payload_source),

      phaseSkillTypeRaw: lower(raw.phase_skillTypeRaw),
      phaseSkillType: lower(raw.phase_skill_type),
      phaseSourceType: lower(raw.phase_sourceType),
      phaseActionCoreSkillType: lower(raw.phase_actionContext_core_skillTypeRaw),
      phaseActionSourceType: lower(raw.phase_actionContext_sourceType),
      phaseSourceItemSkillType: lower(raw.phase_sourceItem_skill_type),

      payloadTypeDamage: lower(raw.payload_typeDamage)
    };

    const candidates = [
      normalized.payloadCoreSkillType,
      normalized.payloadDataCoreSkillType,
      normalized.payloadMetaSkillType,
      normalized.phaseSkillTypeRaw,
      normalized.phaseSkillType,
      normalized.phaseActionCoreSkillType,
      normalized.phaseSourceItemSkillType,
      normalized.payloadMetaSourceType,
      normalized.phaseSourceType,
      normalized.phaseActionSourceType,
      normalized.payloadSource
    ].filter(Boolean);

    const detectedActionType =
      candidates.find(v => ["attack", "weapon", "skill", "spell", "passive", "item"].includes(v)) ??
      candidates[0] ??
      "";

    const isSpell =
      detectedActionType === "spell" ||
      raw.phase_sourceItem_isOffensiveSpell === true;

    return {
      detectedActionType,
      isSpell,
      candidates,
      raw,
      normalized
    };
  }

  function snapshotActionPayload(p = {}) {
    return {
      baseValue: String(p?.advPayload?.baseValue ?? "0"),
      bonus: Number(p?.advPayload?.bonus ?? 0) || 0,
      reduction: Number(p?.advPayload?.reduction ?? 0) || 0,
      multiplier: Number(p?.advPayload?.multiplier ?? 100) || 100,
      accuracyBonus: Number(p?.accuracy?.bonus ?? 0) || 0,
      targetsCount: Array.isArray(p?.targets) ? p.targets.length : 0,
      abort: !!p?.meta?.__abortPipeline,
      abortReason: String(p?.meta?.__abortReason ?? "")
    };
  }

  function diffActionSnapshots(before, after) {
    return {
      baseValue: `${before.baseValue} -> ${after.baseValue}`,
      bonus: `${before.bonus} -> ${after.bonus}`,
      reduction: `${before.reduction} -> ${after.reduction}`,
      multiplier: `${before.multiplier} -> ${after.multiplier}`,
      accuracyBonus: `${before.accuracyBonus} -> ${after.accuracyBonus}`,
      targetsCount: `${before.targetsCount} -> ${after.targetsCount}`,
      abort: `${before.abort} -> ${after.abort}`,
      abortReason: `${before.abortReason} -> ${after.abortReason}`
    };
  }

  function snapshotResolutionState(payload = {}, args = {}, targets = []) {
    return {
      elementType:
        args?.elementType ??
        payload?.meta?.elementType ??
        null,

      weaponType:
        args?.weaponType ??
        payload?.core?.weaponType ??
        null,

      isSpellish:
        args?.isSpellish ??
        payload?.meta?.isSpellish ??
        null,

      hasDamageSection:
        args?.hasDamageSection ??
        payload?.meta?.hasDamageSection ??
        null,

      advBaseValue:
        args?.advPayload?.baseValue ??
        payload?.advPayload?.baseValue ??
        null,

      advBonus:
        Number(args?.advPayload?.bonus ?? payload?.advPayload?.bonus ?? 0) || 0,

      advReduction:
        Number(args?.advPayload?.reduction ?? payload?.advPayload?.reduction ?? 0) || 0,

      advMultiplier:
        Number(args?.advPayload?.multiplier ?? payload?.advPayload?.multiplier ?? 100) || 100,

      targetsCount: Array.isArray(targets) ? targets.length : 0,
      abortConfirm: !!args?.__abortConfirm,
      abortReason: String(args?.__abortReason ?? "")
    };
  }

  function diffResolutionSnapshots(before, after) {
    return {
      elementType: `${before.elementType} -> ${after.elementType}`,
      weaponType: `${before.weaponType} -> ${after.weaponType}`,
      isSpellish: `${before.isSpellish} -> ${after.isSpellish}`,
      hasDamageSection: `${before.hasDamageSection} -> ${after.hasDamageSection}`,
      advBaseValue: `${before.advBaseValue} -> ${after.advBaseValue}`,
      advBonus: `${before.advBonus} -> ${after.advBonus}`,
      advReduction: `${before.advReduction} -> ${after.advReduction}`,
      advMultiplier: `${before.advMultiplier} -> ${after.advMultiplier}`,
      targetsCount: `${before.targetsCount} -> ${after.targetsCount}`,
      abortConfirm: `${before.abortConfirm} -> ${after.abortConfirm}`,
      abortReason: `${before.abortReason} -> ${after.abortReason}`
    };
  }

  function syncResolutionAdvPayload(payload, args) {
    payload.advPayload = payload.advPayload || {};
    args.advPayload = args.advPayload || {};

    payload.advPayload.baseValue = args.advPayload.baseValue;
    payload.advPayload.bonus = args.advPayload.bonus;
    payload.advPayload.reduction = args.advPayload.reduction;
    payload.advPayload.multiplier = args.advPayload.multiplier;
  }

  function setResolutionMeta(payload, args, key, value) {
    payload.meta = payload.meta || {};
    args[key] = value;
    payload.meta[key] = value;
    return value;
  }

  function buildCommonHelpers({ actor, passiveItem, actionTypeDebug, targetUuids, getContextTargets }) {
    return {
      normalizeWeaponCategory,
      isItemEquipped,
      getItemTypeNormalized,
      getItemCategoryNormalized,

      getActionTypeDebug: () => clone(actionTypeDebug, {}),
      getDetectedActionType: () => actionTypeDebug.detectedActionType,

      getPassiveOwnerActor: async () => actor,
      getPassiveItem: () => passiveItem,

      getAttackerActor: async (payloadLike = null, argsLike = null) => {
        const attackerUuid =
          payloadLike?.meta?.attackerUuid ??
          payloadLike?.attackerActorUuid ??
          payloadLike?.attackerUuid ??
          argsLike?.attackerUuid ??
          null;
        return await resolveActor(attackerUuid);
      },

      getEquippedItems: async ({ actor: actorOverride = null, itemTypes = null } = {}) => {
        const useActor = actorOverride ? await resolveActor(actorOverride) : actor;
        const allItems = Array.from(useActor?.items ?? []);
        let equipped = allItems.filter(isItemEquipped);

        if (Array.isArray(itemTypes) && itemTypes.length) {
          const wanted = itemTypes.map(lower);
          equipped = equipped.filter(it => wanted.includes(getItemTypeNormalized(it)));
        }

        return equipped;
      },

      getEquippedWeapons: async ({ actor: actorOverride = null } = {}) => {
        return await this.getEquippedItems?.({
          actor: actorOverride,
          itemTypes: ["weapon"]
        });
      },

      getTargetUuids: () => uniq(getContextTargets?.() ?? targetUuids),

      getTargetDocs: async () => {
        const docs = [];
        for (const uuid of uniq(getContextTargets?.() ?? targetUuids)) {
          const doc = await resolveDocument(uuid);
          if (doc) docs.push(doc);
        }
        return docs;
      },

      getTargetActors: async () => {
        const docs = [];
        for (const uuid of uniq(getContextTargets?.() ?? targetUuids)) {
          const doc = await resolveDocument(uuid);
          const a = coerceActorFromDoc(doc);
          if (a) docs.push(a);
        }
        return docs;
      },

      getFirstTargetDoc: async () => {
        const uuid = uniq(getContextTargets?.() ?? targetUuids)[0] ?? null;
        return uuid ? await resolveDocument(uuid) : null;
      },

      getFirstTargetActor: async () => {
        const uuid = uniq(getContextTargets?.() ?? targetUuids)[0] ?? null;
        if (!uuid) return null;
        const doc = await resolveDocument(uuid);
        return coerceActorFromDoc(doc);
      },

      getDisposition: async (uuidOrDoc) => {
        const doc = await resolveDocument(uuidOrDoc);
        const a = coerceActorFromDoc(doc);
        return getDispositionFromResolved(doc, a);
      },

      targetHasEffect: async (uuidOrDoc, effectName) => {
        const targetActor = await resolveActor(uuidOrDoc);
        if (!targetActor) return false;
        return !!targetActor.effects.find(e => String(e?.name ?? "") === String(effectName ?? ""));
      },

      findTargetEffect: async (uuidOrDoc, effectName) => {
        const targetActor = await resolveActor(uuidOrDoc);
        if (!targetActor) return null;
        return targetActor.effects.find(e => String(e?.name ?? "") === String(effectName ?? "")) ?? null;
      },

      getSkillLevelOnOwner: (skillName) => {
        const wanted = String(skillName ?? "").trim();
        if (!wanted) return 0;
        const owned = actor.items.find(i => String(i?.name ?? "") === wanted);
        return Math.max(0, parseInt(owned?.system?.props?.level ?? "0", 10) || 0);
      }
    };
  }

  async function evaluatePassiveModifiers({ actor, actionCtx, finalElement = null } = {}) {
    const runId = `PMA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const out = {
      ok: true,
      runId,

      // kept for compatibility with current passive action caller
      flatByElement: {},
      pctByElement: {},
      critFlat: 0,
      critMult: 1,
      options: { recalcOnConfirm: "never" },

      ranScripts: [],
      skippedScripts: [],
      errors: [],
      breakdown: []
    };

    if (!actor) {
      warn(runId, "No actor provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_actor" });
      return out;
    }

    if (!actionCtx || typeof actionCtx !== "object") {
      warn(runId, "No actionCtx provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_actionCtx" });
      return out;
    }

    actionCtx.meta = actionCtx.meta || {};
    actionCtx.advPayload = actionCtx.advPayload || {};

    const targetUuids = uniq(actionCtx?.targets ?? []);
    const actionTypeDebug = buildActionTypeDebug(actionCtx);

    log(runId, "START ACTION", {
      actor: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      skillName: actionCtx?.core?.skillName ?? actionCtx?.dataCore?.skillName ?? null,
      targetsCount: targetUuids.length,
      finalElement,
      detectedActionType: actionTypeDebug.detectedActionType,
      isSpell: actionTypeDebug.isSpell
    });

    const items = Array.from(actor.items ?? []);
    for (const item of items) {
      const rawPassive = getItemProps(item)?.passive_logic_action ?? "";
      const scriptText = toScript(rawPassive).trim();

      if (!scriptText) continue;

      const itemRunId = `${runId}:${item.id ?? item.name ?? "item"}`;
      const before = snapshotActionPayload(actionCtx);

      let itemSkipped = false;
      let itemSkipReason = "";
      let itemCancelled = false;

      const baseHelpers = buildCommonHelpers({
        actor,
        passiveItem: item,
        actionTypeDebug,
        targetUuids,
        getContextTargets: () => actionCtx?.targets ?? []
      });

      const context = {
        runId: itemRunId,
        phase: "passive_action",
        passivePhase: "action",
        finalElement,

        actorUuid: actor?.uuid ?? null,
        actorName: actor?.name ?? null,
        passiveOwner: actor,
        passiveItem: item,
        passiveFieldKey: "passive_logic_action",

        skillName: actionCtx?.core?.skillName ?? actionCtx?.dataCore?.skillName ?? null,
        listType: actionCtx?.meta?.listType ?? null,
        executionMode: actionCtx?.meta?.executionMode ?? null,
        isPassiveExecution: (
          actionCtx?.meta?.executionMode === "autoPassive" ||
          actionCtx?.meta?.isPassiveExecution === true ||
          actionCtx?.source === "AutoPassive"
        ),

        actionTypeDebug,

        log: (...a) => log(itemRunId, "[SNIPPET]", ...a),
        warn: (...a) => warn(itemRunId, "[SNIPPET]", ...a),
        error: (...a) => err(itemRunId, "[SNIPPET]", ...a),

        skipPassive: (reason = "", { notify = false } = {}) => {
          itemSkipped = true;
          itemSkipReason = String(reason ?? "");
          if (notify && itemSkipReason) ui.notifications?.warn?.(itemSkipReason);
          log(itemRunId, "SKIP PASSIVE", { item: item.name, reason: itemSkipReason, notify });
          return { skipped: true, reason: itemSkipReason };
        },

        cancelPipeline: (reason = "Passive cancelled the action.", { notify = true } = {}) => {
          itemCancelled = true;
          actionCtx.meta.__abortPipeline = true;
          actionCtx.meta.__abortReason = String(reason ?? "Passive cancelled the action.");
          actionCtx.meta.__abortNotify = !!notify;
          if (notify) ui.notifications?.warn?.(actionCtx.meta.__abortReason);
          warn(itemRunId, "PIPELINE CANCELLED", {
            item: item.name,
            reason: actionCtx.meta.__abortReason,
            notify
          });
          return { cancelled: true, reason: actionCtx.meta.__abortReason };
        },

        helpers: {
          ...baseHelpers,

          getPassiveFieldKey: () => "passive_logic_action",

          getPayload: () => actionCtx,

          addFlatBonus: (amount) => {
            const n = toNumber(amount, 0);
            actionCtx.advPayload.bonus = Number(actionCtx.advPayload.bonus ?? 0) + n;
            return actionCtx.advPayload.bonus;
          },

          addPercentMultiplierDec: (amount) => {
            const n = toNumber(amount, 0);
            const curDec = Number(actionCtx.advPayload.multiplier ?? 100) / 100;
            const nextDec = Math.max(0, curDec + n);
            actionCtx.advPayload.multiplier = Math.round(nextDec * 100);
            return nextDec;
          },

          addAccuracyBonus: (amount) => {
            const n = toNumber(amount, 0);
            actionCtx.accuracy = actionCtx.accuracy || {};
            actionCtx.accuracy.bonus = Number(actionCtx.accuracy.bonus ?? 0) + n;
            return actionCtx.accuracy.bonus;
          }
        }
      };

      const prevPAYLOAD = globalThis.__PAYLOAD;
      const prevTARGETS = globalThis.__TARGETS;
      const prevPASSIVEITEM = globalThis.__PASSIVE_ITEM;
      const prevPASSIVEACTOR = globalThis.__PASSIVE_ACTOR;
      const prevARGS = globalThis.__ARGS;
      const prevCHAT = globalThis.__CHAT_MSG;

      globalThis.__PAYLOAD = actionCtx;
      globalThis.__TARGETS = [...targetUuids];
      globalThis.__PASSIVE_ITEM = item;
      globalThis.__PASSIVE_ACTOR = actor;
      globalThis.__ARGS = undefined;
      globalThis.__CHAT_MSG = undefined;

      try {
        log(itemRunId, "RUN ACTION SCRIPT", {
          item: item.name,
          itemId: item.id ?? null,
          fieldKey: "passive_logic_action",
          scriptLen: scriptText.length,
          skillName: context.skillName,
          targetsCount: targetUuids.length,
          preview: scriptText.slice(0, 160)
        });

        const wrapped = `return (async () => {\n${scriptText}\n})();`;
        const fn = new Function("payload", "targets", "context", "item", "actor", "actionCtx", wrapped);

        const result = fn(actionCtx, [...targetUuids], context, item, actor, actionCtx);
        if (result && typeof result.then === "function") {
          await result;
        }

        const after = snapshotActionPayload(actionCtx);
        const diff = diffActionSnapshots(before, after);

        if (itemSkipped) {
          out.skippedScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            fieldKey: "passive_logic_action",
            reason: itemSkipReason,
            diff
          });

          log(itemRunId, "ACTION SCRIPT SKIPPED", {
            item: item.name,
            fieldKey: "passive_logic_action",
            reason: itemSkipReason,
            diff
          });
        } else {
          out.ranScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            fieldKey: "passive_logic_action",
            cancelled: itemCancelled,
            diff
          });

          out.breakdown.push({
            source: item.name ?? item.id ?? "Passive Script",
            type: "script",
            fieldKey: "passive_logic_action",
            diff
          });

          log(itemRunId, "ACTION SCRIPT DONE", {
            item: item.name,
            fieldKey: "passive_logic_action",
            cancelled: itemCancelled,
            diff
          });
        }

        if (actionCtx?.meta?.__abortPipeline) {
          warn(itemRunId, "ABORT FLAG DETECTED. Stopping further action passive scripts.", {
            abortReason: actionCtx?.meta?.__abortReason ?? null
          });
          break;
        }
      } catch (e) {
        const errorInfo = {
          itemId: item.id ?? null,
          itemName: item.name ?? "",
          fieldKey: "passive_logic_action",
          message: String(e?.message ?? e),
          stack: String(e?.stack ?? "")
        };

        out.ok = false;
        out.errors.push(errorInfo);
        err(itemRunId, "ACTION SCRIPT ERROR", errorInfo);
      } finally {
        globalThis.__PAYLOAD = prevPAYLOAD;
        globalThis.__TARGETS = prevTARGETS;
        globalThis.__PASSIVE_ITEM = prevPASSIVEITEM;
        globalThis.__PASSIVE_ACTOR = prevPASSIVEACTOR;
        globalThis.__ARGS = prevARGS;
        globalThis.__CHAT_MSG = prevCHAT;
      }
    }

    log(runId, "END ACTION", {
      actor: actor?.name ?? null,
      ranScripts: out.ranScripts.length,
      skippedScripts: out.skippedScripts.length,
      errors: out.errors.length,
      abort: !!actionCtx?.meta?.__abortPipeline,
      abortReason: actionCtx?.meta?.__abortReason ?? null
    });

    return out;
  }

  async function evaluatePassiveResolutionModifiers({
    actor,
    payload,
    args,
    targets,
    chatMsg = null,
    finalElement = null
  } = {}) {
    const runId = `PMR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const out = {
      ok: true,
      runId,

      ranScripts: [],
      skippedScripts: [],
      errors: [],
      breakdown: []
    };

    if (!actor) {
      warn(runId, "No actor provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_actor" });
      return out;
    }

    if (!payload || typeof payload !== "object") {
      warn(runId, "No payload provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_payload" });
      return out;
    }

    payload.meta = payload.meta || {};
    payload.core = payload.core || {};
    payload.advPayload = payload.advPayload || {};

    args = (args && typeof args === "object") ? args : {};
    args.advPayload = args.advPayload || clone(payload.advPayload ?? {}, {});

    const targetUuids = uniq(
      (Array.isArray(targets) && targets.length)
        ? targets
        : (
            args?.originalTargetUUIDs ??
            payload?.originalTargetUUIDs ??
            payload?.targets ??
            []
          )
    );

    const actionTypeDebug = buildActionTypeDebug(payload);

    log(runId, "START RESOLUTION", {
      actor: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      skillName: payload?.core?.skillName ?? payload?.dataCore?.skillName ?? null,
      targetsCount: targetUuids.length,
      finalElement,
      detectedActionType: actionTypeDebug.detectedActionType,
      isSpell: actionTypeDebug.isSpell
    });

    const items = Array.from(actor.items ?? []);
    for (const item of items) {
      const rawPassive = getItemProps(item)?.passive_logic_resolution ?? "";
      const scriptText = toScript(rawPassive).trim();

      if (!scriptText) continue;

      const itemRunId = `${runId}:${item.id ?? item.name ?? "item"}`;
      const before = snapshotResolutionState(payload, args, targetUuids);

      let itemSkipped = false;
      let itemSkipReason = "";
      let itemCancelled = false;

      const baseHelpers = buildCommonHelpers({
        actor,
        passiveItem: item,
        actionTypeDebug,
        targetUuids,
        getContextTargets: () => targetUuids
      });

      const context = {
        runId: itemRunId,
        phase: "passive_resolution",
        passivePhase: "resolution",
        finalElement,

        actorUuid: actor?.uuid ?? null,
        actorName: actor?.name ?? null,
        passiveOwner: actor,
        passiveItem: item,
        passiveFieldKey: "passive_logic_resolution",

        skillName: payload?.core?.skillName ?? payload?.dataCore?.skillName ?? null,
        listType: payload?.meta?.listType ?? null,
        executionMode: payload?.meta?.executionMode ?? null,
        isPassiveExecution: (
          payload?.meta?.executionMode === "autoPassive" ||
          payload?.meta?.isPassiveExecution === true ||
          payload?.source === "AutoPassive"
        ),

        actionTypeDebug,

        log: (...a) => log(itemRunId, "[SNIPPET]", ...a),
        warn: (...a) => warn(itemRunId, "[SNIPPET]", ...a),
        error: (...a) => err(itemRunId, "[SNIPPET]", ...a),

        skipPassive: (reason = "", { notify = false } = {}) => {
          itemSkipped = true;
          itemSkipReason = String(reason ?? "");
          if (notify && itemSkipReason) ui.notifications?.warn?.(itemSkipReason);
          log(itemRunId, "SKIP PASSIVE", { item: item.name, reason: itemSkipReason, notify });
          return { skipped: true, reason: itemSkipReason };
        },

        cancelPipeline: (reason = "Passive resolution cancelled the confirm.", { notify = true } = {}) => {
          itemCancelled = true;
          args.__abortConfirm = true;
          args.__abortReason = String(reason ?? "Passive resolution cancelled the confirm.");

          payload.meta.__abortResolution = true;
          payload.meta.__abortResolutionReason = args.__abortReason;

          if (notify) ui.notifications?.warn?.(args.__abortReason);

          warn(itemRunId, "CONFIRM CANCELLED", {
            item: item.name,
            reason: args.__abortReason,
            notify
          });

          return { cancelled: true, reason: args.__abortReason };
        },

        helpers: {
          ...baseHelpers,

          getPassiveFieldKey: () => "passive_logic_resolution",

          getPayload: () => payload,
          getArgs: () => args,
          getTargets: () => [...targetUuids],
          getChatMessage: () => chatMsg,

          addFlatBonus: (amount) => {
            const n = toNumber(amount, 0);
            args.advPayload.bonus = Number(args.advPayload.bonus ?? payload.advPayload.bonus ?? 0) + n;
            syncResolutionAdvPayload(payload, args);
            return args.advPayload.bonus;
          },

          addFlatReduction: (amount) => {
            const n = toNumber(amount, 0);
            args.advPayload.reduction = Number(args.advPayload.reduction ?? payload.advPayload.reduction ?? 0) + n;
            syncResolutionAdvPayload(payload, args);
            return args.advPayload.reduction;
          },

          addPercentMultiplierDec: (amount) => {
            const n = toNumber(amount, 0);
            const curDec = Number(args.advPayload.multiplier ?? payload.advPayload.multiplier ?? 100) / 100;
            const nextDec = Math.max(0, curDec + n);
            args.advPayload.multiplier = Math.round(nextDec * 100);
            syncResolutionAdvPayload(payload, args);
            return nextDec;
          },

          setBaseValue: (value) => {
            args.advPayload.baseValue = value;
            syncResolutionAdvPayload(payload, args);
            return args.advPayload.baseValue;
          },

          setElementType: (value) => setResolutionMeta(payload, args, "elementType", String(value ?? "").trim().toLowerCase()),
          setWeaponType: (value) => setResolutionMeta(payload, args, "weaponType", String(value ?? "").trim().toLowerCase()),
          setIsSpellish: (value) => setResolutionMeta(payload, args, "isSpellish", !!value),
          setHasDamageSection: (value) => setResolutionMeta(payload, args, "hasDamageSection", !!value)
        }
      };

      const prevPAYLOAD = globalThis.__PAYLOAD;
      const prevARGS = globalThis.__ARGS;
      const prevTARGETS = globalThis.__TARGETS;
      const prevCHAT = globalThis.__CHAT_MSG;
      const prevPASSIVEITEM = globalThis.__PASSIVE_ITEM;
      const prevPASSIVEACTOR = globalThis.__PASSIVE_ACTOR;

      globalThis.__PAYLOAD = payload;
      globalThis.__ARGS = args;
      globalThis.__TARGETS = [...targetUuids];
      globalThis.__CHAT_MSG = chatMsg;
      globalThis.__PASSIVE_ITEM = item;
      globalThis.__PASSIVE_ACTOR = actor;

      try {
        log(itemRunId, "RUN RESOLUTION SCRIPT", {
          item: item.name,
          itemId: item.id ?? null,
          fieldKey: "passive_logic_resolution",
          scriptLen: scriptText.length,
          skillName: context.skillName,
          targetsCount: targetUuids.length,
          preview: scriptText.slice(0, 160)
        });

        const wrapped = `return (async () => {\n${scriptText}\n})();`;
        const fn = new Function("payload", "args", "targets", "context", "item", "actor", "chatMsg", wrapped);

        const result = fn(payload, args, [...targetUuids], context, item, actor, chatMsg);
        if (result && typeof result.then === "function") {
          await result;
        }

        syncResolutionAdvPayload(payload, args);

        const after = snapshotResolutionState(payload, args, targetUuids);
        const diff = diffResolutionSnapshots(before, after);

        if (itemSkipped) {
          out.skippedScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            fieldKey: "passive_logic_resolution",
            reason: itemSkipReason,
            diff
          });

          log(itemRunId, "RESOLUTION SCRIPT SKIPPED", {
            item: item.name,
            fieldKey: "passive_logic_resolution",
            reason: itemSkipReason,
            diff
          });
        } else {
          out.ranScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            fieldKey: "passive_logic_resolution",
            cancelled: itemCancelled,
            diff
          });

          out.breakdown.push({
            source: item.name ?? item.id ?? "Passive Resolution Script",
            type: "script",
            fieldKey: "passive_logic_resolution",
            diff
          });

          log(itemRunId, "RESOLUTION SCRIPT DONE", {
            item: item.name,
            fieldKey: "passive_logic_resolution",
            cancelled: itemCancelled,
            diff
          });
        }

        if (args?.__abortConfirm) {
          warn(itemRunId, "ABORT CONFIRM FLAG DETECTED. Stopping further resolution passive scripts.", {
            abortReason: args?.__abortReason ?? null
          });
          break;
        }
      } catch (e) {
        const errorInfo = {
          itemId: item.id ?? null,
          itemName: item.name ?? "",
          fieldKey: "passive_logic_resolution",
          message: String(e?.message ?? e),
          stack: String(e?.stack ?? "")
        };

        out.ok = false;
        out.errors.push(errorInfo);
        err(itemRunId, "RESOLUTION SCRIPT ERROR", errorInfo);
      } finally {
        globalThis.__PAYLOAD = prevPAYLOAD;
        globalThis.__ARGS = prevARGS;
        globalThis.__TARGETS = prevTARGETS;
        globalThis.__CHAT_MSG = prevCHAT;
        globalThis.__PASSIVE_ITEM = prevPASSIVEITEM;
        globalThis.__PASSIVE_ACTOR = prevPASSIVEACTOR;
      }
    }

    log(runId, "END RESOLUTION", {
      actor: actor?.name ?? null,
      ranScripts: out.ranScripts.length,
      skippedScripts: out.skippedScripts.length,
      errors: out.errors.length,
      abortConfirm: !!args?.__abortConfirm,
      abortReason: args?.__abortReason ?? null
    });

    return out;
  }

  ROOT.api.passiveModifier = {
    evaluatePassiveModifiers,
    evaluatePassiveResolutionModifiers
  };

  log("Installed/Updated");
})();