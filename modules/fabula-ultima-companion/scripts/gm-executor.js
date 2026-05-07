/**
 * gm-executor.js
 * Fabula Ultima Companion
 *
 * New model:
 * - Generic GM snippet runner:
 *     GMExecutor.executeSnippet({ ... })
 *
 * Goal:
 * - Parent scripts can forward code + data container here
 * - GMExecutor runs it with GM permission
 * - Returns the mutated container back
 * - No need to add a new hardcoded GM route for every new parent script
 *
 * Kept for compatibility:
 * - runCustomLogicAction(...)
 * - runCustomLogicResolution(...)
 * - runPassiveModifierApply(...)
 *
 * Notes:
 * - Uses socketlib
 * - Parent scripts remain responsible for choosing what code to send
 * - This file exposes a reusable API on:
 *     game.modules.get("fabula-ultima-companion").api.GMExecutor
 *     globalThis.FUCompanion.api.GMExecutor
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[FU][GMExecutor]";
  const DEBUG = true;

  let _socket = null;

  const log  = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => DEBUG && console.warn(TAG, ...args);
  const err  = (...args) => DEBUG && console.error(TAG, ...args);

  function ensureModuleApi() {
    const mod = game.modules.get(MODULE_ID);
    if (!mod) throw new Error(`${TAG} Module not found: ${MODULE_ID}`);
    mod.api = mod.api || {};
    return mod.api;
  }

  function ensureGlobalApi() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    return globalThis.FUCompanion.api;
  }

  function exposeApi(api) {
    try {
      ensureModuleApi().GMExecutor = api;
    } catch (e) {
      err("Failed to expose API on module", e);
    }

    try {
      ensureGlobalApi().GMExecutor = api;
    } catch (e) {
      err("Failed to expose API on global FUCompanion", e);
    }
  }

  function safeClone(value, fallback = null) {
    try {
      return foundry.utils.deepClone(value);
    } catch (_e1) {
      try {
        return structuredClone(value);
      } catch (_e2) {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch (_e3) {
          return fallback;
        }
      }
    }
  }

  function safeSerialize(value) {
    try {
      return safeClone(value, null);
    } catch {
      return null;
    }
  }

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;
    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("resolveDocument failed", {
        uuidOrDoc,
        error: String(e?.message ?? e)
      });
      return null;
    }
  }

  function coerceActorFromDoc(doc) {
    if (!doc) return null;
    if (doc?.documentName === "Actor" || doc?.constructor?.name === "Actor") return doc;
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

  function toLower(v) {
    return String(v ?? "").trim().toLowerCase();
  }

  function uniq(arr) {
    return Array.from(
      new Set((Array.isArray(arr) ? arr : []).filter(v => v != null && String(v).trim() !== ""))
    );
  }

  function normalizeWeaponCategory(value) {
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
  }

  function getItemProps(item) {
    return item?.system?.props ?? {};
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
    return toLower(
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

  function inferActorUuid(payload = null, args = null, explicit = null) {
    return (
      explicit ??
      payload?.meta?.attackerUuid ??
      payload?.attackerActorUuid ??
      payload?.attackerUuid ??
      payload?.meta?.sourceActorUuid ??
      payload?.sourceActorUuid ??
      payload?.meta?.casterActorUuid ??
      payload?.casterActorUuid ??
      payload?.actorUuid ??
      args?.attackerUuid ??
      args?.actorUuid ??
      null
    );
  }

  async function validateCallerMayUseActor(actorUuid, callerUserId) {
    const caller = game.users.get(callerUserId);
    if (!caller) {
      throw new Error(`Caller user not found: ${callerUserId}`);
    }

    if (caller.isGM) return true;

    const actor = await resolveActor(actorUuid);
    if (!actor) {
      throw new Error(`Actor could not be resolved for validation: ${actorUuid}`);
    }

    const canOwner = actor.testUserPermission(caller, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!canOwner) {
      throw new Error(`User "${caller.name}" is not allowed to execute GM logic for actor "${actor.name}"`);
    }

    return true;
  }

  function buildActionTypeDebug(payload, args = null) {
    const PAYLOAD = payload ?? {};
    const ARGS = args ?? {};
    const phasePayload =
      PAYLOAD?.meta?.reaction_phase_payload ??
      PAYLOAD?.reaction_phase_payload ??
      null;

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
  }

  function buildSharedHelpers(actorUuid) {
    const helpers = {};

    helpers.normalizeWeaponCategory = normalizeWeaponCategory;
    helpers.isItemEquipped = isItemEquipped;
    helpers.getItemTypeNormalized = getItemTypeNormalized;
    helpers.getItemCategoryNormalized = getItemCategoryNormalized;

    helpers.getActor = async ({ actor = null } = {}) => {
      return actor ? await resolveActor(actor) : await resolveActor(actorUuid);
    };

    helpers.getEquippedItems = async ({ actor = null, itemTypes = null } = {}) => {
      const resolvedActor = actor ? await resolveActor(actor) : await resolveActor(actorUuid);
      const allItems = Array.from(resolvedActor?.items ?? []);
      let equipped = allItems.filter(isItemEquipped);

      if (Array.isArray(itemTypes) && itemTypes.length) {
        const wanted = itemTypes.map(toLower);
        equipped = equipped.filter(item => wanted.includes(getItemTypeNormalized(item)));
      }

      return equipped;
    };

    helpers.getEquippedWeapons = async ({ actor = null } = {}) => {
      return await helpers.getEquippedItems({ actor, itemTypes: ["weapon"] });
    };

    helpers.getEquippedWeaponCategories = async ({ actor = null } = {}) => {
      const weapons = await helpers.getEquippedWeapons({ actor });
      return uniq(weapons.map(getItemCategoryNormalized));
    };

    helpers.hasEquippedWeaponCategory = async (wantedCategories = [], { actor = null } = {}) => {
      const wanted = uniq(wantedCategories.map(normalizeWeaponCategory));
      if (!wanted.length) return false;
      const equippedCats = await helpers.getEquippedWeaponCategories({ actor });
      return equippedCats.some(cat => wanted.includes(cat));
    };

    helpers.debugEquipmentSnapshot = async ({ actor = null } = {}) => {
      const resolvedActor = actor ? await resolveActor(actor) : await resolveActor(actorUuid);
      const equipped = await helpers.getEquippedItems({ actor: resolvedActor });
      return {
        actorName: resolvedActor?.name ?? null,
        actorUuid: resolvedActor?.uuid ?? null,
        equipped: equipped.map(item => ({
          name: item?.name ?? null,
          itemType: getItemTypeNormalized(item),
          category: getItemCategoryNormalized(item)
        }))
      };
    };

    return helpers;
  }

  function buildSharedUi({ callerUserId, payloadRef, argsRef, phase }) {
    return {
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
        const remoteApi =
          game.modules?.get(MODULE_ID)?.api?.RemoteChoice ??
          globalThis.FUCompanion?.api?.RemoteChoice ??
          null;

        const targetUserId = String(userId ?? callerUserId ?? "").trim();

        if (remoteApi?.requestChoice && targetUserId && targetUserId !== String(game.user?.id ?? "")) {
          const pick = await remoteApi.requestChoice({
            userId: targetUserId,
            title,
            bodyHtml,
            choices,
            cancelLabel,
            timeoutMs,
            width
          });

          if (!pick && hardCancel) {
            if (phase === "resolution") {
              argsRef.__abortConfirm = true;
              argsRef.__abortReason = "Choice dialog closed";
              payloadRef.meta = payloadRef.meta || {};
              payloadRef.meta.__abortResolution = true;
              payloadRef.meta.__abortResolutionReason = argsRef.__abortReason;
            } else {
              payloadRef.meta = payloadRef.meta || {};
              payloadRef.meta.__abortPipeline = true;
              payloadRef.meta.__abortReason = "Choice dialog closed";
              payloadRef.meta.__abortNotify = true;
            }
          }

          return pick;
        }

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
              callback: () => safeResolve({ id, label: String(c.label ?? id), value: c.value })
            };
          }

          buttons.__cancel = {
            label: cancelLabel,
            callback: () => safeResolve(null)
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
              if (hardCancel) {
                if (phase === "resolution") {
                  argsRef.__abortConfirm = true;
                  argsRef.__abortReason = "Choice dialog closed";
                  payloadRef.meta = payloadRef.meta || {};
                  payloadRef.meta.__abortResolution = true;
                  payloadRef.meta.__abortResolutionReason = argsRef.__abortReason;
                } else {
                  payloadRef.meta = payloadRef.meta || {};
                  payloadRef.meta.__abortPipeline = true;
                  payloadRef.meta.__abortReason = "Choice dialog closed";
                  payloadRef.meta.__abortNotify = true;
                }
              }
              safeResolve(null);
            }
          }, { width }).render(true);
        });
      }
    };
  }

  function buildExecutionEnv({
    request,
    payload,
    args,
    targets,
    globals,
    chatMsg,
    actorUuid,
    callerUserId
  }) {
    const mode = String(request?.mode ?? "generic").trim().toLowerCase() || "generic";
    const phase = mode === "resolution" ? "resolution" : (mode === "action" ? "action" : "generic");
    const runId = `GM-SNIP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const actionTypeDebug = buildActionTypeDebug(payload, args);
    const helpers = buildSharedHelpers(actorUuid);
    const ui = buildSharedUi({
      callerUserId,
      payloadRef: payload,
      argsRef: args ?? {},
      phase
    });

    const env = {
      runId,
      moduleId: MODULE_ID,
      mode,
      phase,
      actorUuid,
      callerUserId,
      handledByUserId: game.user?.id ?? null,
      chatMsgId: chatMsg?.id ?? null,
      payload,
      args,
      targets,
      globals,
      chatMsg,
      auto: !!request?.auto,
      metadata: safeClone(request?.metadata ?? {}, {}),

      attackerUuid: actorUuid,
      attackerName: payload?.meta?.attackerName ?? payload?.core?.attackerName ?? null,
      skillName: payload?.core?.skillName ?? payload?.dataCore?.skillName ?? null,
      listType: payload?.meta?.listType ?? null,
      executionMode: payload?.meta?.executionMode ?? null,
      isPassiveExecution: (
        payload?.meta?.executionMode === "autoPassive" ||
        payload?.meta?.isPassiveExecution === true ||
        payload?.source === "AutoPassive"
      ),
      passiveTriggerKey: payload?.meta?.passiveTriggerKey ?? payload?.meta?.triggerKey ?? null,
      passiveOrigin: payload?.meta?.passiveOrigin ?? null,
      actionTypeDebug,

      log: (...a) => log("[SNIPPET]", runId, ...a),
      warn: (...a) => warn("[SNIPPET]", runId, ...a),
      error: (...a) => err("[SNIPPET]", runId, ...a),

      resolveDocument,
      resolveActor,

      ui,
      helpers: {
        ...helpers,
        getActionTypeDebug: () => safeClone(actionTypeDebug, null),
        getDetectedActionType: () => actionTypeDebug.detectedActionType
      }
    };

    env.cancelPipeline = (reason = "Cancelled", { notify = true } = {}) => {
      payload.meta = payload.meta || {};
      payload.meta.__abortPipeline = true;
      payload.meta.__abortReason = String(reason ?? "Cancelled");
      payload.meta.__abortNotify = !!notify;
      if (notify) ui.notifications?.warn?.(payload.meta.__abortReason);
      return { cancelled: true, reason: payload.meta.__abortReason };
    };

    env.cancelConfirm = (reason = "Cancelled", { notify = true } = {}) => {
      if (!args) return env.cancelPipeline(reason, { notify });
      args.__abortConfirm = true;
      args.__abortReason = String(reason ?? "Cancelled");
      payload.meta = payload.meta || {};
      payload.meta.__abortResolution = true;
      payload.meta.__abortResolutionReason = args.__abortReason;
      if (notify) ui.notifications?.warn?.(args.__abortReason);
      return { cancelled: true, reason: args.__abortReason };
    };

    env.skipPassive = (reason = "Passive conditions not met", { notify = false } = {}) => {
      payload.meta = payload.meta || {};
      payload.meta.__passiveSkipped = true;
      payload.meta.__passiveSkipReason = String(reason ?? "Passive conditions not met");
      if (phase === "resolution") {
        return env.cancelConfirm(payload.meta.__passiveSkipReason, { notify });
      }
      return env.cancelPipeline(payload.meta.__passiveSkipReason, { notify });
    };

    env.makeContext = (kind = mode) => {
      const k = String(kind ?? mode).trim().toLowerCase() || mode;
      const phaseName = k === "resolution" ? "resolution" : (k === "action" ? "action" : phase);

      const context = {
        runId: env.runId,
        phase: phaseName,
        attackerUuid: env.attackerUuid,
        attackerName: env.attackerName,
        skillName: env.skillName,
        listType: env.listType,
        executionMode: env.executionMode,
        isPassiveExecution: env.isPassiveExecution,
        passiveTriggerKey: env.passiveTriggerKey,
        passiveOrigin: env.passiveOrigin,
        actionTypeDebug: env.actionTypeDebug,
        chatMsgId: env.chatMsgId,

        log: (...a) => env.log("[CTX]", ...a),
        warn: (...a) => env.warn("[CTX]", ...a),
        error: (...a) => env.error("[CTX]", ...a),

        ui: env.ui,
        helpers: env.helpers
      };

      context.cancelPipeline = (reason = "Cancelled", opts = {}) => {
        if (phaseName === "resolution") return env.cancelConfirm(reason, opts);
        return env.cancelPipeline(reason, opts);
      };

      context.cancelConfirm = (reason = "Cancelled", opts = {}) => {
        return env.cancelConfirm(reason, opts);
      };

      context.skipPassive = (reason = "Passive conditions not met", opts = {}) => {
        return env.skipPassive(reason, opts);
      };

      return context;
    };

    return env;
  }

  async function _gmExecuteSnippet(request = {}) {
    if (!game.user?.isGM) {
      throw new Error(`${TAG} executeSnippet was called on a non-GM client`);
    }

    const callerUserId = String(request?.callerUserId ?? "").trim();
    if (!callerUserId) {
      throw new Error(`${TAG} Missing callerUserId`);
    }

    const scriptText = String(request?.scriptText ?? "").trim();
    if (!scriptText) {
      return {
        ok: true,
        used: false,
        reason: "blank-script",
        payload: safeClone(request?.payload ?? {}, {}),
        args: Object.prototype.hasOwnProperty.call(request ?? {}, "args")
          ? safeClone(request?.args ?? {}, {})
          : null,
        targets: Array.isArray(request?.targets) ? safeClone(request.targets, []) : [],
        globals: safeClone(request?.globals ?? {}, {})
      };
    }

    const actorUuid = inferActorUuid(
      request?.payload ?? null,
      request?.args ?? null,
      request?.actorUuid ?? null
    );

    if (actorUuid) {
      await validateCallerMayUseActor(actorUuid, callerUserId);
    }

    const hasArgs = Object.prototype.hasOwnProperty.call(request ?? {}, "args");
    const payload = safeClone(request?.payload ?? {}, {});
    const args = (hasArgs || String(request?.mode ?? "").toLowerCase() === "resolution")
      ? safeClone(request?.args ?? {}, {})
      : null;
    const targets = Array.isArray(request?.targets) ? safeClone(request.targets, []) : [];
    const globals = safeClone(request?.globals ?? {}, {});
    const chatMsg = request?.chatMsgId ? game.messages?.get(request.chatMsgId) ?? null : null;
    const auto = !!request?.auto;

    payload.meta = payload.meta || {};

    const env = buildExecutionEnv({
      request,
      payload,
      args,
      targets,
      globals,
      chatMsg,
      actorUuid,
      callerUserId
    });

    const prev = {
      __PAYLOAD: globalThis.__PAYLOAD,
      __ARGS: globalThis.__ARGS,
      __TARGETS: globalThis.__TARGETS,
      __CHAT_MSG: globalThis.__CHAT_MSG,
      __AUTO: globalThis.__AUTO,
      __GLOBALS: globalThis.__GLOBALS,
      __ENV: globalThis.__ENV
    };

    const customGlobalBackups = [];

    try {
      globalThis.__PAYLOAD = payload;
      globalThis.__ARGS = args;
      globalThis.__TARGETS = targets;
      globalThis.__CHAT_MSG = chatMsg;
      globalThis.__AUTO = auto;
      globalThis.__GLOBALS = globals;
      globalThis.__ENV = env;

      // Optional additional globals, but only "__NAME" style
      for (const [key, value] of Object.entries(globals)) {
        if (!/^__[A-Z0-9_]+$/i.test(key)) continue;
        if (["__PAYLOAD", "__ARGS", "__TARGETS", "__CHAT_MSG", "__AUTO", "__GLOBALS", "__ENV"].includes(key)) continue;

        customGlobalBackups.push({
          key,
          had: Object.prototype.hasOwnProperty.call(globalThis, key),
          value: globalThis[key]
        });

        globalThis[key] = value;
      }

      const wrapped = `return (async () => {\n${scriptText}\n})();`;
      const fn = new Function("payload", "args", "targets", "env", "globals", wrapped);

      let resultValue = fn(payload, args, targets, env, globals);
      if (resultValue && typeof resultValue.then === "function") {
        resultValue = await resultValue;
      }

      return {
        ok: true,
        mode: String(request?.mode ?? "generic"),
        actorUuid,
        payload: safeClone(payload, {}),
        args: args ? safeClone(args, {}) : null,
        targets: safeClone(targets, []),
        globals: safeClone(globals, {}),
        resultValue: safeSerialize(resultValue),
        used: true
      };
    } catch (e) {
      err("executeSnippet failed", e);
      return {
        ok: false,
        mode: String(request?.mode ?? "generic"),
        actorUuid,
        payload: safeClone(payload, {}),
        args: args ? safeClone(args, {}) : null,
        targets: safeClone(targets, []),
        globals: safeClone(globals, {}),
        resultValue: null,
        used: false,
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "")
      };
    } finally {
      globalThis.__PAYLOAD = prev.__PAYLOAD;
      globalThis.__ARGS = prev.__ARGS;
      globalThis.__TARGETS = prev.__TARGETS;
      globalThis.__CHAT_MSG = prev.__CHAT_MSG;
      globalThis.__AUTO = prev.__AUTO;
      globalThis.__GLOBALS = prev.__GLOBALS;
      globalThis.__ENV = prev.__ENV;

      for (const entry of customGlobalBackups) {
        if (entry.had) globalThis[entry.key] = entry.value;
        else delete globalThis[entry.key];
      }
    }
  }

  const PASSIVE_MODIFIER_SCRIPT = `
const pmApi =
  globalThis.FUCompanion?.api?.passiveModifier ??
  game.modules?.get("${MODULE_ID}")?.api?.passiveModifier ??
  null;

if (typeof pmApi?.evaluatePassiveModifiers !== "function") {
  throw new Error("Passive engine API missing");
}

const actor = await env.resolveActor(env.actorUuid);
if (!actor) {
  throw new Error(\`Could not resolve attacker actor: \${env.actorUuid ?? "null"}\`);
}

const result = await pmApi.evaluatePassiveModifiers({
  actor,
  actionCtx: payload,
  finalElement: String(
    payload?.meta?.elementType ??
    payload?.advPayload?.elementType ??
    ""
  ).trim().toLowerCase() || null
});

return {
  engineResult: result ?? null,
  actorName: actor?.name ?? null,
  actorUuid: actor?.uuid ?? null
};
`;

  const API = {
    get socket() {
      return _socket;
    },

    isReady() {
      return !!_socket;
    },

    inferActorUuid(payload = null, args = null, explicit = null) {
      return inferActorUuid(payload, args, explicit);
    },

    async executeSnippet({
      scriptText = "",
      payload = {},
      args,
      targets = [],
      chatMsgId = null,
      auto = false,
      globals = {},
      mode = "generic",
      actorUuid = null,
      metadata = {}
    } = {}) {
      const request = {
        scriptText: String(scriptText ?? ""),
        payload: safeClone(payload, {}),
        targets: safeClone(Array.isArray(targets) ? targets : [], []),
        chatMsgId: chatMsgId ?? null,
        auto: !!auto,
        globals: safeClone(globals, {}),
        mode: String(mode ?? "generic"),
        actorUuid: actorUuid ?? inferActorUuid(payload, args, null),
        metadata: safeClone(metadata, {})
      };

      if (Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, "args")) {
        request.args = safeClone(args ?? {}, {});
      }

      request.callerUserId = game.user?.id ?? null;

      if (game.user?.isGM) {
        return await _gmExecuteSnippet(request);
      }

      if (!_socket) {
        throw new Error(`${TAG} socket is not ready`);
      }

      return await _socket.executeAsGM("executeSnippet", request);
    },

    // -----------------------------------------------------------------------
    // Compatibility wrappers for currently patched parents
    // -----------------------------------------------------------------------
    async runCustomLogicAction({ scriptText = "", payload = {}, targets = [] } = {}) {
      const wrappedScript = `
const context = env.makeContext("action");
${String(scriptText ?? "")}
      `.trim();

      const res = await this.executeSnippet({
        mode: "action",
        scriptText: wrappedScript,
        payload,
        targets,
        actorUuid: inferActorUuid(payload, null, null)
      });

      return {
        ok: !!res?.ok,
        phase: "action",
        payload: res?.payload ?? null,
        args: null,
        resultValue: res?.resultValue ?? null,
        used: !!res?.used,
        error: res?.error ?? null,
        stack: res?.stack ?? ""
      };
    },

    async runCustomLogicResolution({
      scriptText = "",
      payload = {},
      args = {},
      targets = [],
      chatMsgId = null
    } = {}) {
      const wrappedScript = `
const context = env.makeContext("resolution");
${String(scriptText ?? "")}
      `.trim();

      const res = await this.executeSnippet({
        mode: "resolution",
        scriptText: wrappedScript,
        payload,
        args,
        targets,
        chatMsgId,
        actorUuid: inferActorUuid(payload, args, null)
      });

      return {
        ok: !!res?.ok,
        phase: "resolution",
        payload: res?.payload ?? null,
        args: res?.args ?? null,
        resultValue: res?.resultValue ?? null,
        used: !!res?.used,
        error: res?.error ?? null,
        stack: res?.stack ?? ""
      };
    },

    async runPassiveModifierApply({ payload = {} } = {}) {
      const res = await this.executeSnippet({
        mode: "generic",
        scriptText: PASSIVE_MODIFIER_SCRIPT,
        payload,
        actorUuid: inferActorUuid(payload, null, null)
      });

      return {
        ok: !!(res?.resultValue?.engineResult?.ok ?? res?.ok),
        payload: res?.payload ?? null,
        engineResult: res?.resultValue?.engineResult ?? null,
        actorName: res?.resultValue?.actorName ?? null,
        actorUuid: res?.resultValue?.actorUuid ?? null,
        used: !!res?.used,
        error: res?.error ?? null,
        stack: res?.stack ?? ""
      };
    }
  };

  Hooks.once("socketlib.ready", () => {
    if (!globalThis.socketlib) {
      err("socketlib is not available");
      return;
    }

    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register("executeSnippet", _gmExecuteSnippet);

    exposeApi(API);

    log("Ready", {
      moduleId: MODULE_ID,
      generic: true,
      compatibility: [
        "runCustomLogicAction",
        "runCustomLogicResolution",
        "runPassiveModifierApply"
      ]
    });
  });

  Hooks.once("ready", () => {
    exposeApi(API);
    log("API exposed");
  });
})();