// 
//  Action Data Computation ( ActionDataFetch)
//  Foundry V12  consumes __PAYLOAD from ActionDataFetch
//  Responsibilities:
//     Roll accuracy (if any)
//     Compute base damage/heal + HR bonus
//     Critical / Fumble logic
//     Apply BEFORE_ATTACK Active Effects
//     Take Bonds + Defense snapshots
//     Weapon:    Targeting  CreateActionCard
//     Skill:     Targeting  ResourceGate  CreateActionCard
//     AutoPassive: skip Targeting / skip Action Card / jump to execution core
// 
const CARD_MACRO_NAME      = "CreateActionCard";
const RESOURCE_GATE_NAME   = "ResourceGate";
const TARGETING_MACRO_NAME = "Targeting";
const ADC_DEBUG = true;
const ADC_TAG   = "[ONI][ActionPassive]";
const PASSIVE_ACTION_MACRO_NAME = "PassiveLogic-Action";

return (async () => {
  if (!canvas?.scene) {
    return ui.notifications.error("ActionDataComputation: No active scene.");
  }

  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  const rawSource = String(PAYLOAD.source || "Skill");
  const executionModeSeed = String(
    PAYLOAD?.executionMode ??
    PAYLOAD?.meta?.executionMode ??
    (PAYLOAD?.autoPassive ? "autoPassive" : "manual")
  ).trim() || "manual";

  const isAutoPassiveExecution =
    executionModeSeed === "autoPassive" ||
    !!PAYLOAD?.autoPassive ||
    !!PAYLOAD?.meta?.isPassiveExecution ||
    rawSource === "AutoPassive";

  const isDryRunExecution =
    !!PAYLOAD?.__dryRun ||
    !!PAYLOAD?.meta?.__dryRun;

  const source = (rawSource === "AutoPassive") ? "Skill" : rawSource;

  const { log: adcLog, warn: adcWarn, err: adcErr } =
    FUCompanion.createLogger(ADC_TAG, ADC_DEBUG);

  adcLog("START", {
    rawSource,
    source,
    executionModeSeed,
    isAutoPassiveExecution,
    isDryRunExecution,
    attackerActorUuid: PAYLOAD?.attackerActorUuid ?? null
  });

  // ---------------- Actor resolution ----------------
  const useActor = await FUCompanion.ActorResolver.fromUuid(PAYLOAD.attackerActorUuid);
  if (!useActor) {
    return ui.notifications.warn("ActionDataComputation: Could not resolve attacker actor.");
  }

  const actorProps = useActor.system?.props ?? {};

  function resolveAttackerUuidForMeta(actor) {
    return (
      (actor?.getActiveTokens?.()?.[0]?.document?.uuid) ||
      (actor?.token?.document?.uuid) ||
      (actor?.uuid) || null
    );
  }

  const attackerMetaUuid = resolveAttackerUuidForMeta(useActor);

  const cloneArray = FUCompanion.Utilities.cloneArray;

  function cloneObject(obj, fallback = {}) {
    try {
      if (obj == null) return foundry?.utils?.deepClone ? foundry.utils.deepClone(fallback) : JSON.parse(JSON.stringify(fallback));
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(obj);
      return JSON.parse(JSON.stringify(obj));
    } catch {
      if (obj && typeof obj === "object") {
        if (Array.isArray(obj)) return [...obj];
        return { ...obj };
      }
      return foundry?.utils?.deepClone ? foundry.utils.deepClone(fallback) : fallback;
    }
  }

  function seededReactionTriggerKey(payload = {}) {
    return (
      payload?.reaction_trigger_key ??
      payload?.meta?.reaction_trigger_key ??
      payload?.meta?.passiveTriggerKey ??
      payload?.passiveTriggerKey ??
      null
    );
  }

  function seededReactionTriggerKeys(payload = {}) {
    return cloneArray(
      payload?.reaction_trigger_keys ??
      payload?.meta?.reaction_trigger_keys ??
      []
    );
  }

  function seededReactionPhasePayload(payload = {}) {
    return cloneObject(
      payload?.reaction_phase_payload ??
      payload?.meta?.reaction_phase_payload ??
      {},
      {}
    );
  }

  function seededReactionPhasePayloadByTrigger(payload = {}) {
    return cloneObject(
      payload?.reaction_phase_payload_by_trigger ??
      payload?.meta?.reaction_phase_payload_by_trigger ??
      {},
      {}
    );
  }

  function seededPassiveTriggerKey(payload = {}) {
    return (
      payload?.meta?.passiveTriggerKey ??
      payload?.passiveTriggerKey ??
      payload?.reaction_trigger_key ??
      null
    );
  }

  function seededPassiveSourceEvent(payload = {}) {
    return cloneObject(
      payload?.meta?.passiveSourceEvent ??
      payload?.passiveSourceEvent ??
      {},
      {}
    );
  }

  function seededOriginalTargetUUIDs(payload = {}) {
    return cloneArray(
      payload?.originalTargetUUIDs ??
      payload?.meta?.originalTargetUUIDs ??
      payload?.targets ??
      []
    );
  }

  function seededOriginalTargetActorUUIDs(payload = {}) {
    return cloneArray(
      payload?.originalTargetActorUUIDs ??
      payload?.meta?.originalTargetActorUUIDs ??
      []
    );
  }

  function seededSourceActionId(payload = {}) {
    return (
      payload?.sourceActionId ??
      payload?.meta?.sourceActionId ??
      null
    );
  }

  function seededSourceActionCardId(payload = {}) {
    return (
      payload?.sourceActionCardId ??
      payload?.meta?.sourceActionCardId ??
      null
    );
  }

  function seededSourceActionCardVersion(payload = {}) {
    return (
      payload?.sourceActionCardVersion ??
      payload?.meta?.sourceActionCardVersion ??
      null
    );
  }

  function seededSourceActionCardMessageId(payload = {}) {
    return (
      payload?.sourceActionCardMessageId ??
      payload?.meta?.sourceActionCardMessageId ??
      null
    );
  }

  function seededSourceActionOwnerUserId(payload = {}) {
    return (
      payload?.sourceActionOwnerUserId ??
      payload?.meta?.sourceActionOwnerUserId ??
      null
    );
  }

  function seededSourceActionOwnerUserName(payload = {}) {
    return (
      payload?.sourceActionOwnerUserName ??
      payload?.meta?.sourceActionOwnerUserName ??
      null
    );
  }

  const ownerUserIdSeed =
    PAYLOAD?.meta?.ownerUserId ||
    game.user?.id ||
    null;

  const ownerUserNameSeed =
    (ownerUserIdSeed ? game.users?.get(ownerUserIdSeed)?.name : null) ||
    PAYLOAD?.meta?.ownerUserName ||
    game.user?.name ||
    null;

      // ---------------- Item Use/Create carry-through helpers ----------------
  function seededItemUseMode(payload = {}) {
    return String(
      payload?.itemUseMode ??
      payload?.meta?.itemUseMode ??
      payload?.itemUsage?.mode ??
      payload?.meta?.itemUsage?.mode ??
      (
        payload?.itemCreate?.enabled ||
        payload?.meta?.itemCreate?.enabled
          ? "create"
          : ""
      ) ??
      ""
    ).trim().toLowerCase();
  }

  function seededItemCreate(payload = {}) {
    const raw = payload?.itemCreate ?? payload?.meta?.itemCreate ?? null;
    if (!raw) return null;
    return cloneObject(raw, null);
  }

  function seededItemUsage(payload = {}) {
    const raw = payload?.itemUsage ?? payload?.meta?.itemUsage ?? null;
    if (!raw) return null;
    return cloneObject(raw, null);
  }

  function seededItemCostMeta(payload = {}) {
    const meta = payload?.meta ?? {};
    const out = {};

    if (meta.costRawOriginal !== undefined) out.costRawOriginal = meta.costRawOriginal;
    if (meta.costRaw !== undefined) out.costRaw = meta.costRaw;
    if (meta.costRawOverride !== undefined) out.costRawOverride = meta.costRawOverride;
    if (meta.costRawFinal !== undefined) out.costRawFinal = meta.costRawFinal;

    return out;
  }

  function canonicalTargetUUIDsFromPayload(payload = {}) {
    return cloneArray(
      payload?.originalTargetUUIDs ??
      payload?.meta?.originalTargetUUIDs ??
      payload?.targets ??
      []
    ).filter(Boolean).map(String);
  }

  function canonicalTargetActorUUIDsFromPayload(payload = {}) {
    return cloneArray(
      payload?.originalTargetActorUUIDs ??
      payload?.meta?.originalTargetActorUUIDs ??
      []
    ).filter(Boolean).map(String);
  }

  async function normalizePassiveCostsOrAllow(cardPayload) {
    const meta = cardPayload?.meta || {};
    const attackerUuid = meta?.attackerUuid || null;
    const targetList = canonicalTargetUUIDsFromPayload(cardPayload);
    const TARGETS_COUNT = targetList.length ? targetList.length : 1;

    if (meta.costRawOriginal === undefined) {
      meta.costRawOriginal = String(meta.costRaw ?? "").trim();
    }

    const costRawFinal = String(
      meta.costRawFinal ?? meta.costRawOverride ?? meta.costRaw ?? ""
    ).trim();

    const ZEROish = !costRawFinal
      || costRawFinal === "-"
      || /^\s*\+?\s*0(\s*[%]?\s*(?:x|\*)\s*T)?\s*[a-z]*\s*$/i.test(costRawFinal);

    if (ZEROish) {
      meta.costsNormalized = [];
      adcLog("RESOURCE CHECK (autoPassive zero-ish)", {
        skillName: cardPayload?.core?.skillName ?? null,
        usedCost: costRawFinal
      });
      return { ok: true, affordable: true, costs: [] };
    }

    const actor = await FUCompanion.ActorResolver.fromUuid(attackerUuid);
    if (!actor) {
      ui.notifications?.error("ActionDataComputation: Could not resolve attacker actor for passive resource check.");
      return { ok: false, affordable: false, reason: "attacker_not_found" };
    }

    const props = actor.system?.props ?? actor.system ?? {};

    const RESOURCES = {
      mp: { cur: "current_mp", max: "max_mp", label: "MP" },
      ip: { cur: "current_ip", max: "max_ip", label: "IP" },
    };

    function splitCostList(raw) {
      return String(raw)
        .split(/[,]+|[+\/&]+/g)
        .map(s => s.trim())
        .filter(Boolean);
    }

    function parseOneTokenT(token, T) {
      const str = String(token).trim();
      const rm = str.match(/^(.+?)\s*([a-z]+)$/i);
      if (!rm) return null;

      const amountExpr = rm[1].trim();
      const typeKey = (rm[2] || "").toLowerCase();
      if (!RESOURCES[typeKey]) return null;

      const pm =
        amountExpr.match(/^(\d+)\s*(%?)\s*(?:(?:x|\*)\s*T)?$/i) ||
        amountExpr.match(/^(\d+)\s*(?:(?:x|\*)\s*T)\s*(%?)$/i);
      if (!pm) return null;

      const base = Number(pm[1] || 0);
      const isPct = !!pm[2];
      const usesT = /(?:^|\s)(?:x|\*)\s*T(?:\s|$)/i.test(amountExpr);

      return { type: typeKey, base, isPct, usesT, T };
    }

    function parseCostListT(raw, T) {
      return splitCostList(raw).map(tok => parseOneTokenT(tok, T)).filter(Boolean);
    }

    const parsed = parseCostListT(costRawFinal, TARGETS_COUNT);

    if (!parsed.length) {
      meta.costsNormalized = [];
      adcWarn("RESOURCE CHECK (autoPassive unknown format -> allow)", {
        skillName: cardPayload?.core?.skillName ?? null,
        usedCost: costRawFinal
      });
      return { ok: true, affordable: true, costs: [], skipped: true, reason: "unknown_cost_format" };
    }

    const spendPlan = parsed.map(c => {
      const defs = RESOURCES[c.type];
      const cur  = Number(props?.[defs.cur] ?? 0) || 0;
      const mx   = Number(props?.[defs.max] ?? 0) || 0;
      const baseReq = c.isPct ? Math.ceil((mx * c.base) / 100) : c.base;
      const req = baseReq * (c.usesT ? c.T : 1);

      return {
        type: c.type,
        label: defs.label,
        req,
        cur,
        mx,
        curKey: defs.cur,
        maxKey: defs.max,
      };
    });

    const lacking = spendPlan.filter(x => x.cur < x.req);
    if (lacking.length) {
      const msg = lacking.map(x => `${x.label} ${x.req} needed (you have ${x.cur})`).join(", ");
      ui.notifications?.warn(`Not enough resources: ${msg}`);
      adcWarn("RESOURCE CHECK BLOCK (autoPassive)", {
        skillName: cardPayload?.core?.skillName ?? null,
        usedCost: costRawFinal,
        lacking
      });
      return { ok: false, affordable: false, reason: "not_affordable", lacking, costs: spendPlan };
    }

    meta.costsNormalized = spendPlan;
    adcLog("RESOURCE CHECK ALLOW (autoPassive)", {
      skillName: cardPayload?.core?.skillName ?? null,
      usedCost: costRawFinal,
      spendPlan
    });
    return { ok: true, affordable: true, costs: spendPlan };
  }

  async function executeAutoPassive(cardPayload) {
    const execApi = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;
    if (!execApi) {
      ui.notifications?.error("ActionDataComputation: Action Execution Core API not found.");
      adcErr("EXECUTION CORE missing.");
      return false;
    }

    cardPayload.meta = cardPayload.meta || {};
    cardPayload.meta.executionMode = "autoPassive";
    cardPayload.meta.isPassiveExecution = true;

    cardPayload.targets = canonicalTargetUUIDsFromPayload(cardPayload);
    cardPayload.originalTargetUUIDs = canonicalTargetUUIDsFromPayload(cardPayload);
    cardPayload.originalTargetActorUUIDs = canonicalTargetActorUUIDsFromPayload(cardPayload);
    cardPayload.meta.originalTargetUUIDs = [...cardPayload.originalTargetUUIDs];
    cardPayload.meta.originalTargetActorUUIDs = [...cardPayload.originalTargetActorUUIDs];

    await refreshCanonicalTargetsAndDefense(cardPayload);

    const gateResult = await normalizePassiveCostsOrAllow(cardPayload);
    if (!gateResult?.ok) {
      adcWarn("AUTO PASSIVE stopped before execution.", {
        skillName: cardPayload?.core?.skillName ?? null,
        reason: gateResult?.reason ?? "unknown"
      });
      return false;
    }

    adcLog("EXECUTION CORE CALL", {
      skillName: cardPayload?.core?.skillName ?? null,
      targets: cardPayload?.originalTargetUUIDs ?? [],
      costsNormalized: cardPayload?.meta?.costsNormalized ?? []
    });

const result = await execApi({
  actionContext: cardPayload,
  args: {},
  chatMsgId: null,
  executionMode: "autoPassive",
  confirmingUserId: null,
  skipVisualFeedback: false
});

adcLog("EXECUTION CORE RESULT", result);

if (!result?.ok) {
  const reason = String(result?.reason ?? "unknown");
  adcWarn("AUTO PASSIVE execution failed.", {
    skillName: cardPayload?.core?.skillName ?? null,
    reason,
    result
  });

  return {
    ok: false,
    reason: "auto_passive_execution_failed",
    executionCoreResult: result
  };
}

return {
  ok: true,
  executionMode: "autoPassive",
  executionCoreResult: result
};
  }

  // Snapshot per-target state at dry-run time so the report shows what would
  // *change*. Pairs with execute()'s damagePlan to give before/after diffing.
  async function captureTargetSnapshotsForDryRun(uuidList = []) {
    const out = [];
    for (const uuid of (uuidList ?? [])) {
      try {
        const doc = await fromUuid(uuid);
        const actor = doc?.actor ?? (doc?.type === "Actor" ? doc : null);
        if (!actor) { out.push({ uuid, name: "", err: "no_actor" }); continue; }
        const props = actor.system?.props ?? actor.system ?? {};
        const statuses = Array.from(actor?.statuses ?? []);
        const aeNames = Array.from(actor?.effects ?? [])
          .filter(e => !e.disabled)
          .map(e => e?.name ?? e?.label ?? "(unnamed)");
        out.push({
          uuid,
          name: actor.name ?? "",
          currentHp: Number(props?.current_hp ?? 0) || 0,
          maxHp:     Number(props?.max_hp ?? 0) || 0,
          currentMp: Number(props?.current_mp ?? 0) || 0,
          maxMp:     Number(props?.max_mp ?? 0) || 0,
          statuses,
          activeEffects: aeNames
        });
      } catch (e) {
        out.push({ uuid, name: "", err: String(e?.message ?? e) });
      }
    }
    return out;
  }

  // Inner timeout for author-script execution under dry-run. Scripts that
  // open dialogs we can't trap (e.g. `new Dialog().render()` with external
  // promise) would hang forever; this caps them. The script keeps running in
  // the background but we mark the phase as timedOut and continue with the
  // rest of the dry-run. Tuned for "fast feedback, not perfect simulation."
  const DRY_RUN_AUTHOR_SCRIPT_TIMEOUT_MS = 5000;

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { __timedOut: true })),
          ms
        );
      })
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  // Install a dialog trap so author scripts (CustomLogic-Action /
  // PassiveLogic-Action) running under dry-run never block on UI. Covers:
  //   - Dialog.prompt / .confirm / .wait (static)
  //   - DialogV2.prompt / .confirm / .wait / .input (static)
  //   - Dialog.prototype.render / close — turns `new Dialog().render(true)`
  //     into a no-op (legacy pattern; external promise still won't resolve,
  //     so withTimeout above is the safety net)
  // Each call increments dryRunExtras.dialogsSuppressed[kind].
  function installDryRunDialogTrap(dryRunExtras) {
    dryRunExtras.dialogsSuppressed = dryRunExtras.dialogsSuppressed ?? {
      promptCount: 0,
      confirmCount: 0,
      waitCount: 0,
      inputCount: 0,
      total: 0
    };
    const counters = dryRunExtras.dialogsSuppressed;

    const origDialog = (typeof Dialog !== "undefined") ? Dialog : null;
    const dialogOrig = {};
    const dialogProtoOrig = {};
    if (origDialog) {
      for (const k of ["prompt", "confirm", "wait"]) {
        if (typeof origDialog[k] === "function") {
          dialogOrig[k] = origDialog[k].bind(origDialog);
        }
      }
      origDialog.prompt = async () => {
        counters.promptCount++; counters.total++;
        return null;
      };
      origDialog.confirm = async () => {
        counters.confirmCount++; counters.total++;
        return false;
      };
      origDialog.wait = async () => {
        counters.waitCount++; counters.total++;
        return null;
      };
      // Prototype patch for `new Dialog(...).render(true)` legacy pattern.
      // Real Dialog instances are kept (other code may instanceof-check), but
      // render() no longer opens the UI and close() is a no-op.
      if (origDialog.prototype) {
        if (typeof origDialog.prototype.render === "function") {
          dialogProtoOrig.render = origDialog.prototype.render;
          origDialog.prototype.render = function() {
            counters.waitCount++; counters.total++;
            return this;
          };
        }
        if (typeof origDialog.prototype.close === "function") {
          dialogProtoOrig.close = origDialog.prototype.close;
          origDialog.prototype.close = async function() { return this; };
        }
      }
    }

    const dv2 = foundry?.applications?.api?.DialogV2 ?? null;
    const dv2Orig = {};
    if (dv2) {
      for (const k of ["prompt", "confirm", "wait", "input"]) {
        if (typeof dv2[k] === "function") {
          dv2Orig[k] = dv2[k].bind(dv2);
        }
      }
      dv2.prompt  = async () => { counters.promptCount++;  counters.total++; return null; };
      dv2.confirm = async () => { counters.confirmCount++; counters.total++; return false; };
      dv2.wait    = async () => { counters.waitCount++;    counters.total++; return null; };
      dv2.input   = async () => { counters.inputCount++;   counters.total++; return null; };
    }

    return function dispose() {
      if (origDialog) {
        for (const [k, fn] of Object.entries(dialogOrig)) origDialog[k] = fn;
        if (origDialog.prototype) {
          for (const [k, fn] of Object.entries(dialogProtoOrig)) origDialog.prototype[k] = fn;
        }
      }
      if (dv2) {
        for (const [k, fn] of Object.entries(dv2Orig)) dv2[k] = fn;
      }
    };
  }

  // Apply forced-roll overrides from the test harness, so the dry-run can
  // simulate "what if this crits / fumbles / misses" without re-running.
  // Reads from cardPayload.meta.__dryRunForce; mutates accuracy + advPayload.
  function applyDryRunRollOverrides(cardPayload, force) {
    if (!force || typeof force !== "object") return null;
    const applied = {};
    cardPayload.accuracy  = cardPayload.accuracy  || {};
    cardPayload.advPayload = cardPayload.advPayload || {};
    cardPayload.meta      = cardPayload.meta      || {};

    if (force.forceFumble === true) {
      cardPayload.accuracy.isFumble  = true;
      cardPayload.accuracy.isCrit    = false;
      cardPayload.advPayload.isFumble = true;
      cardPayload.advPayload.isCrit   = false;
      cardPayload.advPayload.forceMiss = true;
      cardPayload.advPayload.autoHit   = false;
      cardPayload.meta.forceMiss      = true;
      applied.forceFumble = true;
    } else if (force.forceCrit === true) {
      cardPayload.accuracy.isCrit    = true;
      cardPayload.accuracy.isFumble  = false;
      cardPayload.advPayload.isCrit   = true;
      cardPayload.advPayload.isFumble = false;
      cardPayload.advPayload.autoHit  = true;
      cardPayload.advPayload.forceMiss = false;
      cardPayload.meta.forceMiss     = false;
      applied.forceCrit = true;
    }

    if (force.forceMiss === true && !applied.forceFumble) {
      cardPayload.meta.forceMiss       = true;
      cardPayload.advPayload.forceMiss = true;
      cardPayload.advPayload.autoHit   = false;
      applied.forceMiss = true;
    }
    if (force.forceHit === true && !applied.forceFumble && !applied.forceMiss) {
      cardPayload.advPayload.autoHit   = true;
      cardPayload.advPayload.forceMiss = false;
      cardPayload.meta.forceMiss       = false;
      applied.forceHit = true;
    }
    if (Number.isFinite(Number(force.forceAccTotal))) {
      const t = Number(force.forceAccTotal);
      cardPayload.accuracy.total = t;
      applied.forceAccTotal = t;
    }
    return applied;
  }

  async function executeDryRun(cardPayload) {
    const execApi = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;
    if (!execApi) {
      ui.notifications?.error("ActionDataComputation: Action Execution Core API not found.");
      adcErr("EXECUTION CORE missing (dry-run).");
      return { ok: false, reason: "execute_api_missing" };
    }

    cardPayload.meta = cardPayload.meta || {};
    cardPayload.meta.__dryRun = true;
    cardPayload.meta.executionMode = "manualCard";
    cardPayload.meta.isPassiveExecution = false;

    cardPayload.targets = canonicalTargetUUIDsFromPayload(cardPayload);
    cardPayload.originalTargetUUIDs = canonicalTargetUUIDsFromPayload(cardPayload);
    cardPayload.originalTargetActorUUIDs = canonicalTargetActorUUIDsFromPayload(cardPayload);
    cardPayload.meta.originalTargetUUIDs = [...cardPayload.originalTargetUUIDs];
    cardPayload.meta.originalTargetActorUUIDs = [...cardPayload.originalTargetActorUUIDs];

    await refreshCanonicalTargetsAndDefense(cardPayload);

    // Extras flow into action-execution-core via meta.__dryRunExtras, which
    // copies the fields into dryRunReport at completion. Keeps the schema in
    // one place (the report) without threading args through execute().
    const dryRunExtras = {
      actionPhaseScripts: {
        customLogicAction:  { ran: false, aborted: false, error: null },
        passiveLogicAction: { ran: false, error: null }
      },
      beforeAttackAeWouldApply: [],
      resourceGate: null,
      targetSnapshotsBefore: [],
      forceApplied: null
    };
    cardPayload.meta.__dryRunExtras = dryRunExtras;

    // Trap dialogs for the duration of author-script execution so a
    // Dialog.prompt / DialogV2.confirm doesn't block the dry-run on user input.
    // Calls auto-resolve with null/false; the count is reported in the report.
    const disposeDialogTrap = installDryRunDialogTrap(dryRunExtras);

    // 1) CustomLogic-Action — mutates cardPayload (damage tweaks, conditional
    //    targets, etc.). Real flow runs this between Targeting and ResourceGate;
    //    dry-run was skipping it, which is the #1 cause of "Claude said X but UI
    //    did Y". Authors that mutate actor docs should gate on meta.__dryRun.
    //    Wrapped in withTimeout so scripts that open unsuppressable dialogs
    //    (e.g. `new Dialog(...).render(true)` awaiting external resolve) don't
    //    hang the dry-run — they get marked timedOut and we move on.
    if (cardPayload?.meta?.hasCustomLogicAction) {
      try {
        const customLogicOk = await withTimeout(
          runActionPhaseCustomLogic(cardPayload, "dry-run / pre-execution"),
          DRY_RUN_AUTHOR_SCRIPT_TIMEOUT_MS,
          "CustomLogic-Action (dry-run)"
        );
        dryRunExtras.actionPhaseScripts.customLogicAction.ran = true;
        if (!customLogicOk) {
          dryRunExtras.actionPhaseScripts.customLogicAction.aborted = true;
          adcWarn("DRY-RUN: CustomLogic-Action aborted pipeline");
          disposeDialogTrap();
          return {
            ok: false,
            reason: "dry_run_custom_logic_aborted",
            dryRunReport: {
              runId: "dry-run-prerun",
              skipped: [],
              ...dryRunExtras
            }
          };
        }
      } catch (e) {
        dryRunExtras.actionPhaseScripts.customLogicAction.error = String(e?.message ?? e);
        if (e?.__timedOut) {
          dryRunExtras.actionPhaseScripts.customLogicAction.timedOut = true;
          adcWarn("DRY-RUN: CustomLogic-Action timed out", { ms: DRY_RUN_AUTHOR_SCRIPT_TIMEOUT_MS });
        } else {
          adcWarn("DRY-RUN: CustomLogic-Action threw", { error: e });
        }
      }
    }

    // 2) BEFORE_ATTACK AE — real flow applies these directly via ApplyActiveEffect.
    //    In dry-run we don't want to mutate actor docs, so just record the
    //    directives that *would* fire. (Skill branch only — weapon BEFORE_ATTACK
    //    uses weaponDoc which isn't reachable from here; less common case.)
    try {
      const skillUuid = cardPayload?.meta?.skillUuid ?? null;
      if (skillUuid) {
        const itemDoc = await fromUuid(skillUuid).catch(() => null);
        if (itemDoc) {
          const allDirectives = fuExtractAEDirectivesFromItem(itemDoc);
          const beforeDirectives = allDirectives.filter(d =>
            String(d?.trigger || "").toLowerCase() === "before_attack"
          );
          dryRunExtras.beforeAttackAeWouldApply = beforeDirectives.map(d => ({
            trigger:    d?.trigger ?? null,
            statusKey:  d?.statusKey ?? d?.status ?? null,
            scope:      d?.scope ?? null,
            duration:   d?.duration ?? null,
            effectKind: d?.effect_kind ?? d?.effectKind ?? null
          }));
        }
      }
    } catch (e) {
      adcWarn("DRY-RUN: BEFORE_ATTACK directive capture failed", {
        error: String(e?.message ?? e)
      });
    }

    // 3) PassiveLogic-Action — passive-skill modifiers mutate cardPayload
    //    (HR bonus, affinity overrides, etc.). Same rationale as CustomLogic.
    try {
      await withTimeout(
        applyPassiveModifiers(cardPayload),
        DRY_RUN_AUTHOR_SCRIPT_TIMEOUT_MS,
        "PassiveLogic-Action (dry-run)"
      );
      dryRunExtras.actionPhaseScripts.passiveLogicAction.ran = true;
    } catch (e) {
      dryRunExtras.actionPhaseScripts.passiveLogicAction.error = String(e?.message ?? e);
      if (e?.__timedOut) {
        dryRunExtras.actionPhaseScripts.passiveLogicAction.timedOut = true;
        adcWarn("DRY-RUN: PassiveLogic-Action timed out", { ms: DRY_RUN_AUTHOR_SCRIPT_TIMEOUT_MS });
      } else {
        adcWarn("DRY-RUN: PassiveLogic-Action threw", { error: e });
      }
    }

    // Author scripts done — restore dialog APIs for the rest of execute().
    disposeDialogTrap();

    await refreshCanonicalTargetsAndDefense(cardPayload);

    // 4) Resource feasibility — record both the plan AND whether the actor can
    //    actually pay. Real ResourceGate would block here; dry-run surfaces it
    //    without aborting so the rest of the report still computes.
    const gateResult = await normalizePassiveCostsOrAllow(cardPayload);
    dryRunExtras.resourceGate = {
      ok:         !!gateResult?.ok,
      affordable: !!gateResult?.affordable,
      reason:     gateResult?.reason ?? null,
      plan:       Array.isArray(gateResult?.costs) ? gateResult.costs : [],
      lacking:    Array.isArray(gateResult?.lacking) ? gateResult.lacking : []
    };

    // 5) Target snapshot BEFORE execution — HP/MP/statuses/AEs.
    try {
      dryRunExtras.targetSnapshotsBefore = await captureTargetSnapshotsForDryRun(
        cardPayload.targets
      );
    } catch (e) {
      adcWarn("DRY-RUN: target snapshot capture failed", {
        error: String(e?.message ?? e)
      });
    }

    // 6) Roll overrides from the test harness — applied AFTER author scripts so
    //    the script can't override them back.
    const force =
      cardPayload?.meta?.__dryRunForce ??
      PAYLOAD?.meta?.__dryRunForce ??
      PAYLOAD?.__dryRunForce ??
      null;
    if (force) {
      dryRunExtras.forceApplied = applyDryRunRollOverrides(cardPayload, force);
    }

    // Snapshot the pre-flight payload (post-author-scripts, post-overrides,
    // pre-execute()) so diffLastAction can compare against a real action card
    // flag without us shipping the whole cardPayload through the report.
    dryRunExtras.payloadAfterPreflight = {
      accuracy:  cloneObject(cardPayload?.accuracy   ?? {}, {}),
      advPayload: cloneObject(cardPayload?.advPayload ?? {}, {}),
      targets:   cloneArray(cardPayload?.targets ?? []),
      originalTargetUUIDs: cloneArray(cardPayload?.originalTargetUUIDs ?? []),
      meta: {
        skillUuid:        cardPayload?.meta?.skillUuid ?? null,
        attackerUuid:     cardPayload?.meta?.attackerUuid ?? null,
        elementType:      cardPayload?.meta?.elementType ?? null,
        isSpellish:       !!cardPayload?.meta?.isSpellish,
        costsNormalized:  cloneArray(cardPayload?.meta?.costsNormalized ?? []),
        activeEffects:    cloneArray(cardPayload?.meta?.activeEffects ?? []),
        forceMiss:        !!cardPayload?.meta?.forceMiss
      }
    };

    adcLog("DRY-RUN EXECUTION CORE CALL", {
      skillName: cardPayload?.core?.skillName ?? null,
      targets: cardPayload?.originalTargetUUIDs ?? [],
      costsNormalized: cardPayload?.meta?.costsNormalized ?? [],
      affordable: dryRunExtras.resourceGate?.affordable,
      forceApplied: dryRunExtras.forceApplied
    });

    const result = await execApi({
      actionContext: cardPayload,
      args: {},
      chatMsgId: null,
      executionMode: "manualCard",
      confirmingUserId: null,
      skipVisualFeedback: true,
      dryRun: true
    });

    adcLog("DRY-RUN EXECUTION CORE RESULT", result);

    if (!result?.ok) {
      const reason = String(result?.reason ?? "unknown");
      adcWarn("DRY-RUN execution failed.", {
        skillName: cardPayload?.core?.skillName ?? null,
        reason,
        result
      });

      return {
        ok: false,
        reason: "dry_run_execution_failed",
        executionCoreResult: result,
        dryRunReport: result?.dryRunReport ?? null
      };
    }

    return {
      ok: true,
      dryRun: true,
      executionMode: "manualCard",
      executionCoreResult: result,
      dryRunReport: result?.dryRunReport ?? null
    };
  }

  // ---------------- Defense helpers ----------------
  function numberish(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function readDefenseLike(props, preferMagic = false) {
    const p = props ?? {};

    const hard = preferMagic
      ? ["magic_defense", "current_mdef", "mdef"]
      : ["defense",       "current_def",  "def"];

    for (const k of hard) {
      const n = numberish(p[k]);
      if (n !== null) return { key: k, val: n };
    }

    const isBanned = (k) => /(^|_)mod($|_)/i.test(k);

    const keys = Object.keys(p);
    const rePhys = /(^|_)(current_)?(def|guard|armor)($|_)/i;
    const reMag  = /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i;
    const rx = preferMagic ? reMag : rePhys;

    for (const k of keys) {
      if (isBanned(k)) continue;
      const n = numberish(p[k]); if (n === null) continue;
      if (rx.test(k)) return { key: k, val: n };
    }

    return { key: null, val: 0 };
  }

  async function collectDefenseSnapshot(uuidList = []) {
    const perTarget = [];
    for (const uuid of (uuidList ?? [])) {
      try {
        const doc = await fromUuid(uuid);
        const actor = doc?.actor ?? (doc?.type === "Actor" ? doc : null);
        if (!actor) { perTarget.push({ uuid, name: "", def: 0, mdef: 0 }); continue; }
        const props = actor.system?.props ?? actor.system ?? {};
        const { val: def }  = readDefenseLike(props, false);
        const { val: mdef } = readDefenseLike(props, true);
        perTarget.push({ uuid, name: actor.name ?? "", def, mdef });
      } catch {
        perTarget.push({ uuid, name: "", def: 0, mdef: 0 });
      }
    }
    const primary = perTarget[0] ?? { uuid: null, name: "", def: 0, mdef: 0 };
    return { primary, perTarget };
  }

  async function refreshCanonicalTargetsAndDefense(cardPayload) {
    const canonicalTokenUUIDs = cloneArray(
      cardPayload?.originalTargetUUIDs ??
      cardPayload?.meta?.originalTargetUUIDs ??
      cardPayload?.targets ??
      []
    );

    const canonicalActorUUIDs = cloneArray(
      cardPayload?.originalTargetActorUUIDs ??
      cardPayload?.meta?.originalTargetActorUUIDs ??
      []
    );

    cardPayload.targets = canonicalTokenUUIDs;
    cardPayload.originalTargetUUIDs = canonicalTokenUUIDs;
    cardPayload.originalTargetActorUUIDs = canonicalActorUUIDs;

    cardPayload.meta = cardPayload.meta || {};
    cardPayload.meta.originalTargetUUIDs = canonicalTokenUUIDs;
    cardPayload.meta.originalTargetActorUUIDs = canonicalActorUUIDs;
    cardPayload.meta.defenseSnapshot = await collectDefenseSnapshot(canonicalTokenUUIDs);

    return cardPayload;
  }

  // ---------------- Bonds snapshot ----------------
  function collectBondsSnapshot(props = {}) {
    const list = [];

    const asFilled = (v) => {
      const s = String(v ?? "").trim().toLowerCase();
      if (!s) return false;
      if (s === "false") return false;
      if (s === "0") return false;
      const n = Number(s);
      if (Number.isFinite(n)) return n !== 0;
      return true;
    };

    for (let i = 1; i <= 6; i++) {
      const name =
        String(props[`bond_${i}`] ?? "").trim() ||
        String(props[`bond${i}`] ?? "").trim();
      if (!name) continue;

      const e1 = asFilled(props[`emotion_${i}_1`] ?? props[`emotion${i}_1`]);
      const e2 = asFilled(props[`emotion_${i}_2`] ?? props[`emotion${i}_2`]);
      const e3 = asFilled(props[`emotion_${i}_3`] ?? props[`emotion${i}_3`]);

      const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
      const bonus  = Math.min(3, Math.max(0, filled));

      list.push({ index: i, name, filled, bonus, emotions: { e1, e2, e3 } });
    }

    const viable = list.filter(b => (b.bonus || 0) > 0);
    return { list, viable, hasAny: list.length > 0, hasViable: viable.length > 0 };
  }

  // ---------------- Active Effect extractor ----------------
  function fuExtractAEDirectivesFromItem(item) {
    if (!item) return [];

    const props = item.system?.props ?? {};
    const cfg   = props.active_effect_config_table ?? {};
    const rows  = Object.values(cfg).filter(r => !r?.$deleted);

    const effectsById = new Map();

    const embedded = Array.from(item.effects?.contents ?? []);
    for (const ef of embedded) {
      try {
        const id = String(ef.id);
        effectsById.set(id, ef.toObject());
      } catch {}
    }

    const skillTbl = props.skill_effect ?? {};
    for (const [k, v] of Object.entries(skillTbl)) {
      if (!v || v.$deleted) continue;
      const id = String(v.id ?? k);
      if (!effectsById.has(id)) effectsById.set(id, v);
    }

    const itemTbl = props.item_activeEffect ?? {};
    for (const [k, v] of Object.entries(itemTbl)) {
      if (!v || v.$deleted) continue;
      const id = String(v.id ?? k);
      if (!effectsById.has(id)) effectsById.set(id, v);
    }

    const directives = rows.map(r => {
      const effId = String(r.active_effect_id || "");
      const effect = effectsById.get(effId) ?? null;

      return {
        effId,
        application : String(r.active_effect_application || "add").toLowerCase(),
        mode        : String(r.active_effect_apply_mode || "").toLowerCase(),
        target      : String(r.active_effect_target || "any").toLowerCase(),
        trigger     : String(r.active_effect_trigger || "on_hit").toLowerCase(),
        percent     : Number(r.active_effect_percent || 0),
        die1        : String(r.active_effect_dice_1 || "").toLowerCase(),
        die2        : String(r.active_effect_dice_2 || "").toLowerCase(),
        dl          : Number(r.active_effect_dl || 0),
        effect
      };
    }).filter(d => d.effId && d.effect);

    return directives;
  }

  // ---------------- Weapon type mapping (FIX) ----------------
  const WTYPE_MAP = {
    arcane:   "arcane_ef",
    bow:      "bow_ef",
    brawling: "brawling_ef",
    dagger:   "dagger_ef",
    firearm:  "firearm_ef",
    flail:    "flail_ef",
    heavy:    "heavy_ef",
    spear:    "spear_ef",
    sword:    "sword_ef",
    thrown:   "thrown_ef"
  };

  const ALIAS = {
    swords: "sword",
    "heavy weapon": "heavy",
    fists: "brawling",
    unarmed: "brawling",
    guns: "firearm",
    rifles: "firearm",
    pistols: "firearm"
  };

  function weaponTypeToEF(rawWeaponType, { spellish = false } = {}) {
    if (spellish) return "arcane_ef";

    const raw = String(rawWeaponType ?? "").trim().toLowerCase();
    if (!raw) return "none_ef";

    if (raw.endsWith("_ef")) return raw;

    const key = ALIAS[raw] || raw;
    const keyNoEf = key.endsWith("_ef") ? key.replace(/_ef$/i, "") : key;

    return WTYPE_MAP[keyNoEf] || "none_ef";
  }

  // ---------------- Weapon-type extra damage bonus (NEW) ----------------
  function normalizeWeaponTypeForBonus(rawWeaponType, { spellish = false } = {}) {
    if (spellish) return "arcane";

    const raw = String(rawWeaponType ?? "").trim().toLowerCase();
    if (!raw) return null;

    const noEf = raw.endsWith("_ef") ? raw.replace(/_ef$/i, "") : raw;

    const key = ALIAS[noEf] || noEf;
    return (key && key !== "none") ? key : null;
  }

  function getWeaponTypeDamageBonus(props, rawWeaponType, { spellish = false } = {}) {
  const w = normalizeWeaponTypeForBonus(rawWeaponType, { spellish });
  if (!w) return 0;

  const KNOWN = new Set(["sword","spear","bow","arcane","thrown","dagger","flail","brawling","heavy","firearm"]);
  if (!KNOWN.has(w)) return 0;

  const key = `extra_damage_mod_${w}`;
  const n = Number(props?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getUniversalDamageBonus(props) {
  const n = Number(props?.extra_damage_mod_all ?? 0);
  return Number.isFinite(n) ? n : 0;
}

  // ---------------- Accuracy / dice helpers ----------------
  function getDieSize(attr) {
    if (!attr) return 6;
    const k = attr.toString().trim().toLowerCase();
    const cur  = actorProps?.[`${k}_current`];
    const base = actorProps?.[`${k}_base`];
    const n = Number(cur ?? base ?? 6);
    return [4, 6, 8, 10, 12, 20].includes(n) ? n : 6;
  }

  async function rollAccuracy(A1, A2, bonus = 0) {
    const dA = getDieSize(A1), dB = getDieSize(A2);
    const rA = await (new Roll(`1d${dA}`)).evaluate();
    const rB = await (new Roll(`1d${dB}`)).evaluate();

    const total = (rA.total + rB.total + Number(bonus || 0));
    const hr    = Math.max(rA.total, rB.total);
    const diff  = Math.abs(rA.total - rB.total);

    const critRange = Number(actorProps?.critical_dice_range ?? 0);
    const minCrit   = Number(actorProps?.minimum_critical_dice ?? 999);
    const fumbleTH  = Number(actorProps?.fumble_threshold ?? -1);

    const rawIsCrit   = (diff <= critRange) && (rA.total >= minCrit || rB.total >= minCrit);
    const rawIsFumble = (fumbleTH >= 0)
      ? (rA.total <= fumbleTH && rB.total <= fumbleTH)
      : (rA.total === 1 && rB.total === 1);

    const isFumble = !!rawIsFumble;
    const isCrit   = !!rawIsCrit && !isFumble;
    const isBunny  = isCrit && (rA.total !== rB.total);

    return {
      dA, dB,
      rA: { total: rA.total, result: rA.result },
      rB: { total: rB.total, result: rB.result },
      total, hr, isCrit, isBunny, isFumble
    };
  }

  const HEAL_REGEX = /^(heal|healing|recovery|restore|restoration)$/i;
  const MP_BURN_REGEX = /\bmp\s*burn\b/i;
  const MP_HEAL_REGEX = /\bmp\b/i;

  function parseDamageSpec(typeDamageTxt) {
    const raw = (typeDamageTxt ?? "").toString().trim();
    const lower = (raw || "physical").toLowerCase();

    if (MP_BURN_REGEX.test(lower)) {
      return { elementType: "mp", valueType: "mp", declaresHealing: false };
    }

    if (MP_HEAL_REGEX.test(lower)) {
      return { elementType: "mp", valueType: "mp", declaresHealing: true };
    }

    return {
      elementType: lower,
      valueType: "hp",
      declaresHealing: HEAL_REGEX.test(lower)
    };
  }

  // Action-intent inference. Returns "harmful" | "aid" | "neutral".
  //
  // Used by reaction triggers that need to gate on "this action threatens the
  // target" vs. "this action helps the target" (Protect, Cover, Counterattack,
  // ...). Per RAW Protect: "threatened by an attack, spell or other danger" —
  // an ally's heal/buff is not a danger and must not surface Protect.
  //
  // Sources (in priority order):
  //   1. Explicit author override via `props.action_intent`
  //      (`"harmful"|"aid"|"neutral"`, blank = auto).
  //   2. Weapon attacks → "harmful" (no choice exists).
  //   3. `skill_type === "Attack"` → "harmful".
  //   4. `isOffensiveSpell` → "harmful".
  //   5. `declaresHealing` (HP or MP recovery) → "aid".
  //   6. `hasDamageSection && !declaresHealing` (covers MP burn) → "harmful".
  //   7. `skill_type === "Spell"` (non-offensive) → "aid".
  //   8. `skill_type === "Active"` without damage → "aid"
  //      (buffs / utility actives).
  //   9. Anything else (Passive, Item, Other) → "neutral".
  //
  // "neutral" deliberately fails harmful/aid filters — reactions opt-in by
  // declaring intent. Authors of edge-case skills can pin the result via the
  // `action_intent` prop override.
  function inferActionIntent({
    sourceType,
    intentOverride,
    skillTypeRaw,
    isOffSpell,
    declaresHealing,
    hasDamageSection,
    valueType
  }) {
    const override = String(intentOverride ?? "").trim().toLowerCase();
    if (override === "harmful" || override === "aid" || override === "neutral") {
      return override;
    }

    const stype = String(skillTypeRaw ?? "").trim().toLowerCase();

    if (sourceType === "Weapon") return "harmful";
    if (stype === "attack") return "harmful";
    if (isOffSpell === true) return "harmful";

    if (declaresHealing === true) return "aid";
    if (hasDamageSection === true) return "harmful";

    if (stype === "spell") return "aid";
    if (stype === "active") return "aid";

    return "neutral";
  }

  // 
  //  Pull-through: Custom Logic scripts (already converted to plain JS in Fetch)
  //  Blank => no custom logic (as per Oni plan)
  // 
  const customLogicActionRaw = String(PAYLOAD?.customLogicActionRaw ?? "");
  const customLogicResolutionRaw = String(PAYLOAD?.customLogicResolutionRaw ?? "");
  const hasCustomLogicAction = customLogicActionRaw.trim().length > 0;
  const hasCustomLogicResolution = customLogicResolutionRaw.trim().length > 0;

  // Passive script runner helper (calls PassiveModifierApply macro)
  async function applyPassiveModifiers(cardPayload) {
    try {
      const pm = game.macros.getName(PASSIVE_ACTION_MACRO_NAME);
      if (!pm) { console.warn("[ActionDataComputation] PassiveModifierApply macro not found."); return true; }
      await pm.execute({ __AUTO: true, __PAYLOAD: cardPayload });
      return true;
    } catch (e) {
      console.warn("[ActionDataComputation] PassiveModifierApply failed:", e);
      return false;
    }
  }  // ---------------- Targeting shim runner ----------------  // ---------------- Targeting shim runner ----------------
  
  async function runTargetingShim(cardPayload) {
    const targetMacro = game.macros.getName(TARGETING_MACRO_NAME);
    if (!targetMacro) {
      return ui.notifications.error(`ActionDataComputation: Macro "${TARGETING_MACRO_NAME}" not found or no permission.`);
    }

    cardPayload.meta = cardPayload.meta || {};
    cardPayload.meta.ownerUserId = cardPayload.meta.ownerUserId || ownerUserIdSeed;
    cardPayload.meta.ownerUserName = cardPayload.meta.ownerUserName || ownerUserNameSeed;
    cardPayload.meta.attackerUuid = cardPayload.meta.attackerUuid || attackerMetaUuid;
    cardPayload.meta.skillTypeRaw = cardPayload.meta.skillTypeRaw || cardPayload?.core?.skillTypeRaw || "";
    cardPayload.meta.skillTargetRaw = cardPayload.meta.skillTargetRaw || cardPayload?.core?.skillTargetRaw || "";

    await targetMacro.execute({
      __AUTO: true,
      __PAYLOAD: cardPayload
    });

if (cardPayload?.meta?.__abortPipeline) {
  const reason = String(cardPayload?.meta?.__abortReason ?? "Action cancelled.");
  const shouldNotify = cardPayload?.meta?.__abortNotify === true;
  console.warn("[ActionDataComputation] ABORT requested by Targeting. Stopping pipeline.", {
    reason,
    notify: shouldNotify
  });

  if (
    shouldNotify &&
    !cardPayload?.meta?.__abortNotified &&
    String(reason).trim()
  ) {
    ui.notifications?.warn?.(reason);
    cardPayload.meta.__abortNotified = true;
  }
  return false;
}

    await refreshCanonicalTargetsAndDefense(cardPayload);
    return true;
  }

  async function applyBeforeAttackEffects(item, cardPayload, dataCore) {
    try {
      if (!item) return;

      const allDirectives = fuExtractAEDirectivesFromItem(item);
      const beforeDirectives = allDirectives.filter(d =>
        String(d?.trigger || "").toLowerCase() === "before_attack"
      );

      if (!beforeDirectives.length) return;

      const isSpellish = !!(dataCore?.isSpell || dataCore?.isOffSpell);
      const weaponType = String(dataCore?.weaponType || "");
      const aeMacro = game.macros.getName("ApplyActiveEffect");

      if (!aeMacro || !attackerMetaUuid) return;

      await aeMacro.execute({
        __AUTO: true,
        __PAYLOAD: {
          directives : beforeDirectives,
          attackerUuid: attackerMetaUuid,
          targetUUIDs: cloneArray(cardPayload?.targets),
          trigger    : "before_attack",
          accTotal   : 0,
          isSpellish,
          weaponType
        }
      });
    } catch (e) {
      console.warn("[ActionDataComputation] BEFORE ATTACK skipped:", e);
    }
  }

  async function runActionPhaseCustomLogic(cardPayload, label = "action-phase") {
  try {
    const cl = game.macros.getName("CustomLogic-Action");
    if (!cl) {
      console.warn("[ActionDataComputation] CustomLogic-Action macro not found. Skipping.");
      return true;
    }

    if (!cardPayload?.meta?.hasCustomLogicAction) {
      console.log("[ActionDataComputation] No CustomLogic-Action script. Skipping.");
      return true;
    }

    console.log(`[ActionDataComputation] Calling CustomLogic-Action (${label})`, {
      hasCustomLogicAction: cardPayload?.meta?.hasCustomLogicAction,
      actionLen: (cardPayload?.customLogicActionRaw ?? "").length,
      targets: cardPayload?.originalTargetUUIDs ?? cardPayload?.targets ?? []
    });

    await cl.execute({
      __AUTO: true,
      __PAYLOAD: cardPayload
    });

    if (cardPayload?.meta?.__abortPipeline) {
      const reason = String(cardPayload?.meta?.__abortReason ?? "Action cancelled.");
      const shouldNotify = cardPayload?.meta?.__abortNotify === true;

      console.warn("[ActionDataComputation] ABORT requested by CustomLogic-Action. Stopping pipeline.", {
        reason,
        notify: shouldNotify,
        label
      });

      if (
        shouldNotify &&
        !cardPayload?.meta?.__abortNotified &&
        String(reason).trim()
      ) {
        ui.notifications?.warn?.(reason);
        cardPayload.meta.__abortNotified = true;
      }
      return false;
    }

    // In case custom logic modified targets or target metadata
    await refreshCanonicalTargetsAndDefense(cardPayload);
    return true;
  } catch (e) {
    console.error("[ActionDataComputation] CustomLogic-Action failed (continuing anyway).", e);

    // Keep payload snapshots tidy even if script errored
    await refreshCanonicalTargetsAndDefense(cardPayload);
    return true;
  }
}

  // 
  //  BRANCH: WEAPON
  // 
  if (source === "Weapon") {
    const dataCore   = PAYLOAD.dataCore   ?? {};
    const overrides  = PAYLOAD.overrides  ?? {};
    const weaponUuid = PAYLOAD.weaponUuid ?? null;
    const targetsSeed = cloneArray(PAYLOAD.targets);
    const ignoreHR   = !!overrides.ignore_hr;

    let weaponDoc = null;
    if (weaponUuid) {
      try { weaponDoc = await fromUuid(weaponUuid); }
      catch (e) { console.error("[ActionDataComputation] Weapon branch: failed to resolve weaponDoc:", e); }
    }

    const hasAccuracy = true;
    const accRoll = await rollAccuracy(
      dataCore.rolledAtr1,
      dataCore.rolledAtr2,
      dataCore.checkBonus || 0
    );

    const { elementType, valueType, declaresHealing } = parseDamageSpec(dataCore.typeDamageTxt);
    const targetAffinity = "neutral";
    const attackRange    = dataCore.skillRange || "";
    const sourceType     = "Weapon";

    const weaponTypeEF = weaponTypeToEF(dataCore.weaponType, { spellish: !!dataCore.isSpell });

    const damageBonusProvided = (dataCore.damageBonusProvided !== undefined)
      ? !!dataCore.damageBonusProvided
      : (dataCore.damageBonusRaw !== undefined ? (String(dataCore.damageBonusRaw).trim() !== "" && Number.isFinite(Number(dataCore.damageBonusRaw))) : true);

    const nonDamageAction = !damageBonusProvided;

    const actionIntent = inferActionIntent({
      sourceType,
      intentOverride: null,
      skillTypeRaw: dataCore.skillTypeRaw,
      isOffSpell: !!dataCore.isOffSpell,
      declaresHealing,
      hasDamageSection: damageBonusProvided,
      valueType
    });

    const baseValueNumber     = nonDamageAction ? 0 : Math.max(0, Number(dataCore.damageBonus ?? 0));
    const hrBonus             = (!nonDamageAction && !declaresHealing && hasAccuracy && accRoll?.hr && !ignoreHR)
      ? Number(accRoll.hr || 0)
      : 0;
    const basePlusHR          = baseValueNumber + hrBonus;

    const baseValueStrForCard = nonDamageAction ? "" : String(declaresHealing ? baseValueNumber : basePlusHR);
    const baseValueStrForAdv  = nonDamageAction ? "0" : (declaresHealing ? `+${baseValueNumber}` : String(basePlusHR));

    const hasDamageSection    = damageBonusProvided;

    const hasAnimationScript = (() => {
      const rawAnim = String(PAYLOAD?.animationScriptRaw ?? "").trim();
      if (!rawAnim) return false;
      if (/insert your sequencer animation here/i.test(rawAnim)) return false;
      return true;
    })();

    const _isCritFinal   = !!(accRoll?.isCrit)   && !accRoll?.isFumble;
    const _isFumbleFinal = !!(accRoll?.isFumble);

    const universalDamageBonus = (!nonDamageAction && !declaresHealing && valueType === "hp")
  ? getUniversalDamageBonus(actorProps)
  : 0;

const weaponTypeDamageBonus = (!nonDamageAction && !declaresHealing && valueType === "hp")
  ? getWeaponTypeDamageBonus(actorProps, dataCore.weaponType, { spellish: !!dataCore.isSpell })
  : 0;

const totalFlatBonus =
  Number(dataCore.flatBonus || 0) +
  Number(universalDamageBonus || 0) +
  Number(weaponTypeDamageBonus || 0);

    const advPayload = {
      baseValue : baseValueStrForAdv,
      reduction : dataCore.reduction || 0,
      bonus     : totalFlatBonus,
      multiplier: dataCore.multiplier || 100,
      valueType,
      weaponType : weaponTypeEF,
      elementType,
      targetAffinity,

      animationScriptRaw: "",

      ignoreDamageReduction: false,
      ignoreShield: false,
      attackerName: useActor.name,
      attackerUuid: attackerMetaUuid,
      attackRange,
      sourceType,

isCrit    : _isCritFinal,
isFumble  : _isFumbleFinal,
forceMiss : _isFumbleFinal === true,
hr        : ignoreHR ? null : (accRoll?.hr ?? null),

// Critical can auto-hit, but never if the same roll is a fumble.
autoHit   : (_isCritFinal === true && _isFumbleFinal !== true)
    };

    const cardPayload = {
      core: {
        attackerName : useActor.name,
        skillName    : dataCore.skillName,
        skillImg     : dataCore.skillImg,
        rawEffectHTML: dataCore.rawEffectHTML,
        typeDamageTxt: dataCore.typeDamageTxt,
        skillTypeRaw : dataCore.skillTypeRaw,
        skillTargetRaw: dataCore.skillTargetRaw,
        weaponType   : dataCore.weaponType
      },
      meta: {
        attackerName : useActor.name,
        listType     : dataCore.listType,
        isSpellish   : false,
        weaponTypeLabel: (dataCore.weaponType || ""),
        elementType, declaresHealing, hasDamageSection, hasAnimationScript,
        actionIntent,
        baseValueStrForCard, hrBonus, ignoreHR, attackRange,

        attackerUuid : attackerMetaUuid,
        ownerUserId  : ownerUserIdSeed,
        ownerUserName: ownerUserNameSeed,
        invoked: { trait:false, bond:false },

        bonds: collectBondsSnapshot(actorProps),
        skillTypeRaw : dataCore.skillTypeRaw,
        skillTargetRaw: dataCore.skillTargetRaw,
        executionMode: executionModeSeed,
        isPassiveExecution: isAutoPassiveExecution,

        originalTargetUUIDs: seededOriginalTargetUUIDs(PAYLOAD),
        originalTargetActorUUIDs: seededOriginalTargetActorUUIDs(PAYLOAD),

        reaction_trigger_key: seededReactionTriggerKey(PAYLOAD),
        reaction_trigger_keys: seededReactionTriggerKeys(PAYLOAD),
        reaction_phase_payload: seededReactionPhasePayload(PAYLOAD),
        reaction_phase_payload_by_trigger: seededReactionPhasePayloadByTrigger(PAYLOAD),
        passiveTriggerKey: seededPassiveTriggerKey(PAYLOAD),
        passiveSourceEvent: seededPassiveSourceEvent(PAYLOAD),

        sourceActionId: seededSourceActionId(PAYLOAD),
        sourceActionCardId: seededSourceActionCardId(PAYLOAD),
        sourceActionCardVersion: seededSourceActionCardVersion(PAYLOAD),
        sourceActionCardMessageId: seededSourceActionCardMessageId(PAYLOAD),
        sourceActionOwnerUserId: seededSourceActionOwnerUserId(PAYLOAD),
        sourceActionOwnerUserName: seededSourceActionOwnerUserName(PAYLOAD),

        // Custom logic carry-through (blank => no custom logic)
        customLogicActionRaw,
        customLogicResolutionRaw,
        hasCustomLogicAction,
        hasCustomLogicResolution,

        // Phase 2a: action-budget reservation set by ADF gate. Must survive
        // the meta rebuild here so it reaches the action-card flag and the
        // AEC consume hook on Confirm. Without this carry-through, the
        // consume hook reads `meta.budgetReservation === undefined` and the
        // turn never ends.
        budgetReservation: PAYLOAD?.meta?.budgetReservation ?? null
      },
accuracy: {
  ...accRoll,
  isCrit    : _isCritFinal,
  isFumble  : _isFumbleFinal,
  forceMiss : _isFumbleFinal === true,
  autoHit   : (_isCritFinal === true && _isFumbleFinal !== true),
  A1: dataCore.rolledAtr1,
  A2: dataCore.rolledAtr2,
  checkBonus: dataCore.checkBonus,
  hrUsed: ignoreHR ? null : accRoll?.hr
},
      advPayload,
      targets: targetsSeed,

      originalTargetUUIDs: seededOriginalTargetUUIDs(PAYLOAD),
      originalTargetActorUUIDs: seededOriginalTargetActorUUIDs(PAYLOAD),

      reaction_trigger_key: seededReactionTriggerKey(PAYLOAD),
      reaction_trigger_keys: seededReactionTriggerKeys(PAYLOAD),
      reaction_phase_payload: seededReactionPhasePayload(PAYLOAD),
      reaction_phase_payload_by_trigger: seededReactionPhasePayloadByTrigger(PAYLOAD),
      passiveTriggerKey: seededPassiveTriggerKey(PAYLOAD),
      passiveSourceEvent: seededPassiveSourceEvent(PAYLOAD),

      // Also store at top-level for convenience
      customLogicActionRaw,
      customLogicResolutionRaw,
      executionMode: executionModeSeed,
      isPassiveExecution: isAutoPassiveExecution
    };

    cardPayload.meta.activeEffects   = fuExtractAEDirectivesFromItem(weaponDoc);
    cardPayload.meta.defenseSnapshot = await collectDefenseSnapshot(cardPayload.targets);

       console.log(actorProps);
    console.log(collectBondsSnapshot(actorProps));

    if (isDryRunExecution) {
      adcLog("DRY-RUN BRANCH (Weapon)", {
        skillName: cardPayload?.core?.skillName ?? null,
        originalTargetUUIDs: cardPayload?.originalTargetUUIDs ?? []
      });
      return await executeDryRun(cardPayload);
    }

        if (isAutoPassiveExecution) {
      adcLog("TARGETING SKIPPED", {
        reason: "autoPassive",
        skillName: cardPayload?.core?.skillName ?? null,
        source: "Weapon",
        originalTargetUUIDs: cardPayload?.originalTargetUUIDs ?? []
      });

      await refreshCanonicalTargetsAndDefense(cardPayload);

      // BEFORE ATTACK AE (Weapon / autoPassive) uses preset passive targets
      await applyBeforeAttackEffects(weaponDoc, cardPayload, dataCore);

      // Refresh again in case AE changed target state / defenses
      await refreshCanonicalTargetsAndDefense(cardPayload);

      // NEW: run item-based passive scripts before auto-passive execution
      await applyPassiveModifiers(cardPayload);

      // Refresh again in case passive scripts changed targets / payload-dependent defense snapshot
      await refreshCanonicalTargetsAndDefense(cardPayload);

      adcLog("CARD SKIPPED (weapon autoPassive)", {
        skillName: cardPayload?.core?.skillName ?? null,
        source: "Weapon"
      });

const executed = await executeAutoPassive(cardPayload);

if (!executed?.ok) {
  return {
    ok: false,
    reason: executed?.reason ?? "weapon_auto_passive_execution_failed",
    result: executed
  };
}

return executed;
    }

    // 
    // Targeting shim  BEFORE CustomLogic / CreateActionCard (Weapon)
    // 
    {
      const targetingOk = await runTargetingShim(cardPayload);
      if (!targetingOk) return;
    }

    // Now that targeting is confirmed, target-aware custom logic can safely run.
    {
      const customLogicOk = await runActionPhaseCustomLogic(
        cardPayload,
        "weapon post-Targeting / pre-CreateActionCard"
      );
      if (!customLogicOk) return;
    }

    // BEFORE ATTACK AE (Weapon) now uses confirmed targeting result
    await applyBeforeAttackEffects(weaponDoc, cardPayload, dataCore);

    // Refresh snapshot after custom logic / targeting / AE in case targets or defense changed
    await refreshCanonicalTargetsAndDefense(cardPayload);

    const cardMacro = game.macros.getName(CARD_MACRO_NAME);
    if (!cardMacro) {
      return ui.notifications.error(`ActionDataComputation: Macro "${CARD_MACRO_NAME}" not found or no permission.`);
    }

await applyPassiveModifiers(cardPayload);

return await cardMacro.execute({
  __AUTO: true,
  __PAYLOAD: cardPayload
});
  }

  // 
  //  BRANCH: SKILL / SPELL
  // 
  if (source === "Skill") {
    const dataCore = PAYLOAD.dataCore ?? {};
    const ignoreHR = !!PAYLOAD.ignoreHR;
    const skillUuid = PAYLOAD.skillUuid ?? null;
    const listType  = PAYLOAD.listType || dataCore.listType || "";
    const animTimingMode   = String(PAYLOAD.animTimingMode   ?? "default").trim().toLowerCase();
    const animTimingOffset = Number(PAYLOAD.animTimingOffset ?? 0) || 0;
    const animationScriptRaw = String(PAYLOAD.animationScriptRaw ?? "").toString();
    const targetsSeed = cloneArray(PAYLOAD.targets);

    let skillItem = null;
    if (skillUuid) {
      try { skillItem = await fromUuid(skillUuid); }
      catch (e) { console.error("[ActionDataComputation] Skill branch: could not resolve skillItem:", e); }
    }
    if (!skillItem) {
      return ui.notifications.error("ActionDataComputation: Could not resolve the skill Item from its UUID.");
    }

    const hasAccuracy = dataCore.isCheck && !!dataCore.rolledAtr1 && !!dataCore.rolledAtr2;
    const accRoll = hasAccuracy
      ? await rollAccuracy(dataCore.rolledAtr1, dataCore.rolledAtr2, dataCore.checkBonus || 0)
      : null;

    const { elementType, valueType, declaresHealing } = parseDamageSpec(dataCore.typeDamageTxt);

    const _skillTypeNorm = String(dataCore.skillTypeRaw || "").trim().toLowerCase();
    if (_skillTypeNorm === "spell") dataCore.isSpell = true;

    dataCore.isOffSpell = !!dataCore.isOffSpell;

    const weaponTypeEF = weaponTypeToEF(dataCore.weaponType, { spellish: !!(dataCore.isSpell || dataCore.isOffSpell) });

    const targetAffinity = "neutral";
    const attackRange    = dataCore.skillRange || "";
    const sourceType     = (
      (listType === "Attack") ||
      (_skillTypeNorm === "attack")
    ) ? "Attack" : "Skill";

    const damageBonusProvided = (dataCore.damageBonusProvided !== undefined)
      ? !!dataCore.damageBonusProvided
      : (dataCore.damageBonusRaw !== undefined ? (String(dataCore.damageBonusRaw).trim() !== "" && Number.isFinite(Number(dataCore.damageBonusRaw))) : true);

    const nonDamageAction = !damageBonusProvided;

    const actionIntent = inferActionIntent({
      sourceType,
      intentOverride: skillItem?.system?.props?.action_intent
                      ?? skillItem?.system?.action_intent
                      ?? null,
      skillTypeRaw: dataCore.skillTypeRaw,
      isOffSpell: !!dataCore.isOffSpell,
      declaresHealing,
      hasDamageSection: damageBonusProvided,
      valueType
    });

    const baseValueNumber     = nonDamageAction ? 0 : Math.max(0, Number(dataCore.damageBonus ?? 0));
    const hrBonus             = (!nonDamageAction && !declaresHealing && hasAccuracy && accRoll?.hr && !ignoreHR)
      ? Number(accRoll.hr || 0)
      : 0;
    const basePlusHR          = baseValueNumber + hrBonus;

    const baseValueStrForCard = nonDamageAction ? "" : String(declaresHealing ? baseValueNumber : basePlusHR);
    const baseValueStrForAdv  = nonDamageAction ? "0" : (declaresHealing ? `+${baseValueNumber}` : String(basePlusHR));

    const hasDamageSection    = damageBonusProvided;

    const hasAnimationScript = (() => {
      const rawAnim = String(PAYLOAD?.animationScriptRaw ?? "").trim();
      if (!rawAnim) return false;
      if (/insert your sequencer animation here/i.test(rawAnim)) return false;
      return true;
    })();

    const _isCritFinal   = !!(accRoll?.isCrit)   && !accRoll?.isFumble;
    const _isFumbleFinal = !!(accRoll?.isFumble);

    const universalDamageBonus = (!nonDamageAction && !declaresHealing && valueType === "hp")
  ? getUniversalDamageBonus(actorProps)
  : 0;

const weaponTypeDamageBonus = (!nonDamageAction && !declaresHealing && valueType === "hp")
  ? getWeaponTypeDamageBonus(actorProps, dataCore.weaponType, { spellish: !!(dataCore.isSpell || dataCore.isOffSpell) })
  : 0;

const totalFlatBonus =
  Number(dataCore.flatBonus || 0) +
  Number(universalDamageBonus || 0) +
  Number(weaponTypeDamageBonus || 0);

    const advPayload = {
      baseValue : baseValueStrForAdv,
      reduction : dataCore.reduction || 0,
      bonus     : totalFlatBonus,
      multiplier: dataCore.multiplier || 100,
      valueType,
      weaponType : weaponTypeEF,
      elementType,
      targetAffinity,

      animationScriptRaw,
      animation_damage_timing_options: animTimingMode,
      animation_damage_timing_offset : animTimingOffset,

      ignoreDamageReduction: false,
      ignoreShield: false,
      attackerName: useActor.name,
      attackerUuid: attackerMetaUuid,
      attackRange,
      sourceType,

      isCrit   : _isCritFinal,
      isFumble : _isFumbleFinal,
      hr       : ignoreHR ? null : (accRoll?.hr ?? null),
      autoHit  : _isCritFinal === true
    };

        const baseSkillCostRaw = String(
      skillItem?.system?.props?.cost ??
      skillItem?.system?.cost ??
      ""
    ).trim();

    const itemUseMode = seededItemUseMode(PAYLOAD);
    const itemCreate = seededItemCreate(PAYLOAD);
    const itemUsage = seededItemUsage(PAYLOAD);
    const itemCostMeta = seededItemCostMeta(PAYLOAD);

    const costRaw = String(
      itemCostMeta.costRaw ??
      baseSkillCostRaw ??
      ""
    ).trim();

    const costRawOverride = itemCostMeta.costRawOverride;

    const costRawFinal = String(
      itemCostMeta.costRawFinal ??
      itemCostMeta.costRawOverride ??
      costRaw ??
      ""
    ).trim();

    adcLog("ITEM / COST CARRY-THROUGH", {
      skillName: dataCore.skillName,
      listType,
      itemUseMode,
      hasItemCreate: !!itemCreate,
      hasItemUsage: !!itemUsage,
      baseSkillCostRaw,
      costRaw,
      costRawOverride,
      costRawFinal
    });

    const cardPayload = {
      core: {
        attackerName : useActor.name,
        skillName    : dataCore.skillName,
        skillImg     : dataCore.skillImg,
        rawEffectHTML: dataCore.rawEffectHTML,
        typeDamageTxt: dataCore.typeDamageTxt,
        skillTypeRaw : dataCore.skillTypeRaw,
        skillTargetRaw: dataCore.skillTargetRaw,
        weaponType   : dataCore.weaponType
      },
      meta: {
        attackerName : useActor.name,
        listType     : listType,
        isSpellish   : !!dataCore.isSpell,
        weaponTypeLabel: dataCore.isSpell ? "arcane" : (dataCore.weaponType || ""),
        elementType, declaresHealing, hasDamageSection, hasAnimationScript,
        actionIntent,
        baseValueStrForCard, hrBonus, attackRange,
        ignoreHR,

        attackerUuid : attackerMetaUuid,
        skillUuid    : skillUuid,
        ownerUserId  : ownerUserIdSeed,
        ownerUserName: ownerUserNameSeed,
        invoked: { trait:false, bond:false },

        bonds: collectBondsSnapshot(actorProps),

        // Resource cost carry-through.
        // Normal Skill/Item use keeps the skill cost.
        // Create Item mode can override this with "1 IP", "2 IP", etc.
        costRaw,
        costRawOriginal: itemCostMeta.costRawOriginal ?? baseSkillCostRaw,

        ...(costRawOverride !== undefined ? { costRawOverride } : {}),
        ...(costRawFinal ? { costRawFinal } : {}),

        // Item mode carry-through.
        // Use mode: consume owned quantity later.
        // Create mode: spend IP later, do not consume quantity.
        itemUseMode,
        itemCreate,
        itemUsage,

        skillTypeRaw : dataCore.skillTypeRaw,
        skillTargetRaw: dataCore.skillTargetRaw,
        executionMode: executionModeSeed,
        isPassiveExecution: isAutoPassiveExecution,

        originalTargetUUIDs: seededOriginalTargetUUIDs(PAYLOAD),
        originalTargetActorUUIDs: seededOriginalTargetActorUUIDs(PAYLOAD),

        reaction_trigger_key: seededReactionTriggerKey(PAYLOAD),
        reaction_trigger_keys: seededReactionTriggerKeys(PAYLOAD),
        reaction_phase_payload: seededReactionPhasePayload(PAYLOAD),
        reaction_phase_payload_by_trigger: seededReactionPhasePayloadByTrigger(PAYLOAD),
        passiveTriggerKey: seededPassiveTriggerKey(PAYLOAD),
        passiveSourceEvent: seededPassiveSourceEvent(PAYLOAD),

        // Custom logic carry-through (blank => no custom logic)
        customLogicActionRaw,
        customLogicResolutionRaw,
        hasCustomLogicAction,
        hasCustomLogicResolution,

        // Phase 2a: action-budget reservation set by ADF gate. Must survive
        // the meta rebuild here so it reaches the action-card flag and the
        // AEC consume hook on Confirm. Without this carry-through, the
        // consume hook reads `meta.budgetReservation === undefined` and the
        // turn never ends.
        budgetReservation: PAYLOAD?.meta?.budgetReservation ?? null
      },
      accuracy: hasAccuracy
        ? {
            ...accRoll,
            isCrit   : _isCritFinal,
            isFumble : _isFumbleFinal,
            A1: dataCore.rolledAtr1,
            A2: dataCore.rolledAtr2,
            checkBonus: dataCore.checkBonus,
            hrUsed: ignoreHR ? null : accRoll?.hr
          }
        : null,
      advPayload,
      targets: targetsSeed,

      originalTargetUUIDs: seededOriginalTargetUUIDs(PAYLOAD),
      originalTargetActorUUIDs: seededOriginalTargetActorUUIDs(PAYLOAD),

      reaction_trigger_key: seededReactionTriggerKey(PAYLOAD),
      reaction_trigger_keys: seededReactionTriggerKeys(PAYLOAD),
      reaction_phase_payload: seededReactionPhasePayload(PAYLOAD),
      reaction_phase_payload_by_trigger: seededReactionPhasePayloadByTrigger(PAYLOAD),
      passiveTriggerKey: seededPassiveTriggerKey(PAYLOAD),
      passiveSourceEvent: seededPassiveSourceEvent(PAYLOAD),

      sourceActionId: seededSourceActionId(PAYLOAD),
      sourceActionCardId: seededSourceActionCardId(PAYLOAD),
      sourceActionCardVersion: seededSourceActionCardVersion(PAYLOAD),
      sourceActionCardMessageId: seededSourceActionCardMessageId(PAYLOAD),
      sourceActionOwnerUserId: seededSourceActionOwnerUserId(PAYLOAD),
      sourceActionOwnerUserName: seededSourceActionOwnerUserName(PAYLOAD),

      // Carry Item Use/Create data forward into the Action Card flag.
      itemUseMode,
      itemCreate,
      itemUsage,

      // also store at top-level for convenience
      customLogicActionRaw,
      customLogicResolutionRaw,
      executionMode: executionModeSeed,
      isPassiveExecution: isAutoPassiveExecution
    };

    cardPayload.meta.activeEffects   = fuExtractAEDirectivesFromItem(skillItem);
    cardPayload.meta.defenseSnapshot = await collectDefenseSnapshot(cardPayload.targets);

    console.log(actorProps);
    console.log(collectBondsSnapshot(actorProps));

    if (isDryRunExecution) {
      adcLog("DRY-RUN BRANCH (Skill)", {
        skillName: cardPayload?.core?.skillName ?? null,
        originalTargetUUIDs: cardPayload?.originalTargetUUIDs ?? []
      });
      return await executeDryRun(cardPayload);
    }

       if (isAutoPassiveExecution) {
      adcLog("TARGETING SKIPPED", {
        reason: "autoPassive",
        skillName: cardPayload?.core?.skillName ?? null,
        source: "Skill",
        originalTargetUUIDs: cardPayload?.originalTargetUUIDs ?? []
      });

      await refreshCanonicalTargetsAndDefense(cardPayload);

      // Auto-passives already have preset targets, so custom logic can run here.
      {
        const customLogicOk = await runActionPhaseCustomLogic(
          cardPayload,
          "skill autoPassive / pre-execution"
        );
        if (!customLogicOk) return;
      }

      // BEFORE ATTACK AE (Weapon / autoPassive) uses preset passive targets
      await applyBeforeAttackEffects(skillItem, cardPayload, dataCore);

      // Refresh again in case custom logic / AE changed target state or defenses
      await refreshCanonicalTargetsAndDefense(cardPayload);

      // Run item-based passive scripts before auto-passive execution
      await applyPassiveModifiers(cardPayload);

      // Refresh again in case passive scripts changed targets / payload-dependent defense snapshot
      await refreshCanonicalTargetsAndDefense(cardPayload);

      adcLog("CARD SKIPPED (skill autoPassive)", {
        skillName: cardPayload?.core?.skillName ?? null,
        source: "Weapon"
      });

const executed = await executeAutoPassive(cardPayload);

if (!executed?.ok) {
  return {
    ok: false,
    reason: executed?.reason ?? "skill_auto_passive_execution_failed",
    result: executed
  };
}

return executed;
    }

// 
// Targeting shim  BEFORE CustomLogic / ResourceGate (Skill)
// 
{
  const targetingOk = await runTargetingShim(cardPayload);
  if (!targetingOk) return;
}

// Now that targeting is confirmed, target-aware custom logic can safely run.
{
  const customLogicOk = await runActionPhaseCustomLogic(
    cardPayload,
    "post-Targeting / pre-ResourceGate"
  );
  if (!customLogicOk) return;
}

// BEFORE ATTACK AE (Skill) now uses confirmed targeting result
await applyBeforeAttackEffects(skillItem, cardPayload, dataCore);

// Refresh snapshot after custom logic / targeting / AE in case targets or defense changed
await refreshCanonicalTargetsAndDefense(cardPayload);

    // 
    // Resource Gate (normal flow)
    // 
    const gate = game.macros.getName(RESOURCE_GATE_NAME);
    if (!gate) {
      return ui.notifications.error(`ActionDataComputation: Macro "${RESOURCE_GATE_NAME}" not found or no permission.`);
    }
await applyPassiveModifiers(cardPayload);

return await gate.execute({
  __AUTO: true,
  __PAYLOAD: cardPayload
});
  }

  ui.notifications.warn(`ActionDataComputation: Unknown source "${source}".`);
})();
