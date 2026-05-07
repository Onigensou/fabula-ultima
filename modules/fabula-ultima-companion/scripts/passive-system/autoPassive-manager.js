// scripts/passive-system/autoPassive-manager.js
// Foundry VTT v12
// [ONI] Auto Passive Manager
//
// PURPOSE
// - Extend Reaction detection results into an auto-execution branch for passive rows.
// - Split matched reaction rows into:
//     1) manual Reaction rows (still go to Reaction UI)
//     2) passive rows (auto-fire, no user input)
// - Resolve preset passive targets through AutoPassiveTargetResolver.
// - Hand the action into ActionDataFetch in headless mode.
// - Prevent passive self-loop / re-entry behavior with a root-chain gate.
//
// PUBLIC API
//   window["oni.AutoPassiveManager"].processMatches({
//     matches,
//     triggerKey,
//     phasePayload,
//     phasePayloadByTrigger
//   })
//
// RETURN SHAPE
//   {
//     ok: true,
//     manualMatches: [...],
//     passiveResults: [...]
//   }

(() => {
  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};

  const KEY = "oni.AutoPassiveManager";
  const TAG = "[ONI][AutoPassiveManager]";
  const GATE_TAG = "[ONI][PassiveGate]";
  const DEBUG = true; // set false when stable
  const ADF_MACRO_NAME = "ActionDataFetch";

  // Passive gate tuning
  const LEDGER_TTL_MS = 30000;
  const ROOT_TTL_MS = 12000;
  const GRACE_LOCK_MS = 1200;

  const log = (...a) => { if (DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => { if (DEBUG) console.warn(TAG, ...a); };
  const err = (...a) => { if (DEBUG) console.error(TAG, ...a); };
  const gate = (...a) => { if (DEBUG) console.log(GATE_TAG, ...a); };
  const gateWarn = (...a) => { if (DEBUG) console.warn(GATE_TAG, ...a); };

  if (window[KEY]) {
    log("Already installed.");
    return;
  }

  const _recentExecutions = new Map();      // executionKey -> ts
  const _rootChainLedger = new Map();       // rootKey -> { createdAt, touchedAt, fired:Set<string> }
  const _reentryGraceLocks = new Map();     // passiveIdentity -> expiresAt

  function str(v, d = "") {
    const s = (v ?? "").toString().trim();
    return s.length ? s : d;
  }

  function lower(v, d = "") {
    return str(v, d).toLowerCase();
  }

  function toArrayUnique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(v => v !== null && v !== undefined && `${v}` !== ""))];
  }

  function clone(obj) {
    try {
      return foundry.utils.deepClone(obj);
    } catch {
      try {
        return JSON.parse(JSON.stringify(obj));
      } catch {
        return obj;
      }
    }
  }

  function boolish(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    if (typeof value === "number") return value !== 0;
    const s = String(value).trim().toLowerCase();
    return ["true", "1", "yes", "y", "on", "checked"].includes(s);
  }

  function normalizePassiveTargetMode(row = null) {
    return lower(
      row?.reaction_passive_target ??
      row?.passive_target ??
      "self",
      "self"
    );
  }

  function stableRowSignature(row, rowIndex) {
    const explicit = str(
      row?.id ??
      row?._id ??
      row?.rowId ??
      row?.key ??
      row?.uuid ??
      ""
    );
    if (explicit) return explicit;

    const basis = {
      i: Number.isFinite(Number(rowIndex)) ? Number(rowIndex) : -1,
      trigger: str(row?.reaction_trigger ?? ""),
      source: str(row?.reaction_source ?? ""),
      damageType: str(row?.reaction_damage_type ?? ""),
      isPassive: boolish(row?.reaction_isPassive),
      passiveTarget: str(row?.reaction_passive_target ?? "")
    };

    let json = "";
    try {
      json = JSON.stringify(basis);
    } catch {
      json = `${basis.i}|${basis.trigger}|${basis.source}|${basis.damageType}|${basis.isPassive}|${basis.passiveTarget}`;
    }

    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      hash = ((hash << 5) - hash) + json.charCodeAt(i);
      hash |= 0;
    }
    return `row-${basis.i}-${Math.abs(hash)}`;
  }

  function pickEventStamp(triggerKey, phasePayload = {}, phasePayloadByTrigger = {}) {
    const preferred = phasePayloadByTrigger?.[triggerKey] ?? phasePayload ?? {};
    return str(
      preferred?.timestamp ??
      preferred?.eventTimestamp ??
      preferred?.meta?.timestamp ??
      phasePayload?.timestamp ??
      phasePayload?.eventTimestamp ??
      phasePayload?.meta?.timestamp ??
      Date.now()
    );
  }

  function cleanupLedgers() {
    const now = Date.now();

    for (const [key, ts] of _recentExecutions.entries()) {
      if ((now - Number(ts || 0)) > LEDGER_TTL_MS) {
        _recentExecutions.delete(key);
      }
    }

    for (const [rootKey, entry] of _rootChainLedger.entries()) {
      const touchedAt = Number(entry?.touchedAt || entry?.createdAt || 0);
      if ((now - touchedAt) > ROOT_TTL_MS) {
        _rootChainLedger.delete(rootKey);
        gate("CLEAR EXPIRED ROOT KEY", { rootKey, touchedAt, ageMs: now - touchedAt });
      }
    }

    for (const [passiveIdentity, expiresAt] of _reentryGraceLocks.entries()) {
      if (now >= Number(expiresAt || 0)) {
        _reentryGraceLocks.delete(passiveIdentity);
      }
    }
  }

  function buildExecutionKey({ actor, item, triggerKey, phasePayload, phasePayloadByTrigger, row, rowIndex }) {
    const actorUuid = actor?.uuid ?? "(no-actor)";
    const itemUuid  = item?.uuid ?? "(no-item)";
    const eventStamp = pickEventStamp(triggerKey, phasePayload, phasePayloadByTrigger);
    const rowSig = stableRowSignature(row, rowIndex);
    return [eventStamp, triggerKey, actorUuid, itemUuid, rowSig].join("::");
  }

  function buildPassiveIdentity({ actor, item, row, rowIndex }) {
    const actorUuid = actor?.uuid ?? "(no-actor)";
    const itemUuid = item?.uuid ?? "(no-item)";
    const rowSig = stableRowSignature(row, rowIndex);
    return [actorUuid, itemUuid, rowSig].join("::");
  }

  function inferRootKey({ actor, item, row, rowIndex, triggerKey, phasePayload, phasePayloadByTrigger }) {
    const inherited = str(
      phasePayload?.meta?.passiveOrigin?.rootKey ??
      phasePayload?.passiveOrigin?.rootKey ??
      ""
    );
    if (inherited) return inherited;

    const actorUuid = actor?.uuid ?? "(no-actor)";
    const itemUuid  = item?.uuid ?? "(no-item)";
    const rowSig = stableRowSignature(row, rowIndex);
    const eventStamp = pickEventStamp(triggerKey, phasePayload, phasePayloadByTrigger);
    return ["root", eventStamp, triggerKey || "(no-trigger)", actorUuid, itemUuid, rowSig].join("::");
  }

  function getAncestryFromPayload(phasePayload = {}) {
    return toArrayUnique(
      phasePayload?.meta?.passiveOrigin?.ancestry ??
      phasePayload?.passiveOrigin?.ancestry ??
      []
    );
  }

  function getDepthFromPayload(phasePayload = {}) {
    const depth = Number(
      phasePayload?.meta?.passiveOrigin?.depth ??
      phasePayload?.passiveOrigin?.depth ??
      0
    );
    return Number.isFinite(depth) ? depth : 0;
  }

  function touchRootEntry(rootKey) {
    const now = Date.now();
    let entry = _rootChainLedger.get(rootKey);
    if (!entry) {
      entry = { createdAt: now, touchedAt: now, fired: new Set() };
      _rootChainLedger.set(rootKey, entry);
      gate("REGISTER ROOT EVENT", { rootKey, createdAt: now });
    } else {
      entry.touchedAt = now;
    }
    return entry;
  }

  function checkPassiveGate({ passiveIdentity, rootKey, ancestry = [], actor, item, triggerKey, rowIndex }) {
    cleanupLedgers();

    const now = Date.now();
    const graceUntil = Number(_reentryGraceLocks.get(passiveIdentity) || 0);
    if (graceUntil && now < graceUntil) {
      gateWarn("BLOCK REENTRY GRACE LOCK", {
        passiveIdentity,
        rootKey,
        triggerKey,
        actorName: actor?.name,
        itemName: item?.name,
        rowIndex,
        msRemaining: graceUntil - now
      });
      return { ok: false, reason: "grace_lock" };
    }

    if (Array.isArray(ancestry) && ancestry.includes(passiveIdentity)) {
      gateWarn("BLOCK REENTRY ANCESTRY", {
        passiveIdentity,
        rootKey,
        triggerKey,
        actorName: actor?.name,
        itemName: item?.name,
        rowIndex,
        ancestry
      });
      return { ok: false, reason: "ancestry_loop" };
    }

    const rootEntry = touchRootEntry(rootKey);
    if (rootEntry.fired.has(passiveIdentity)) {
      gateWarn("BLOCK REENTRY SAME EVENT", {
        passiveIdentity,
        rootKey,
        triggerKey,
        actorName: actor?.name,
        itemName: item?.name,
        rowIndex
      });
      return { ok: false, reason: "same_root_event" };
    }

    rootEntry.fired.add(passiveIdentity);
    rootEntry.touchedAt = now;
    _reentryGraceLocks.set(passiveIdentity, now + GRACE_LOCK_MS);

    gate("ALLOW FIRST PASSIVE FIRE", {
      passiveIdentity,
      rootKey,
      triggerKey,
      actorName: actor?.name,
      itemName: item?.name,
      rowIndex,
      graceLockMs: GRACE_LOCK_MS
    });

    return { ok: true, reason: "allowed", rootEntry };
  }

  function resolveOwnerUserIdForActor(actor) {
    const fallback = game.userId ?? null;
    if (!actor) return fallback;

    const allUsers = Array.from(game.users ?? []);
    const owners = allUsers.filter(u => {
      try {
        return !!actor.testUserPermission?.(u, "OWNER");
      } catch {
        return false;
      }
    });

    if (!owners.length) return fallback;

    const currentOwner = owners.find(u => u.id === game.userId);
    if (currentOwner) return currentOwner.id;

    const activeNonGM = owners.find(u => u.active && !u.isGM);
    if (activeNonGM) return activeNonGM.id;

    const activeAny = owners.find(u => u.active);
    if (activeAny) return activeAny.id;

    return owners[0]?.id ?? fallback;
  }

  function getResolverApi() {
    return ROOT.api?.autoPassiveTargetResolver ?? window["oni.AutoPassiveTargetResolver"] ?? null;
  }

  function getADFMacro() {
    try {
      return game.macros?.getName?.(ADF_MACRO_NAME) ?? null;
    } catch {
      return null;
    }
  }

  function pickPreferredPayload(triggerKey, phasePayload = {}, phasePayloadByTrigger = {}) {
    return clone(phasePayloadByTrigger?.[triggerKey] ?? phasePayload ?? {});
  }

  function resolveInheritedDamageBatchId({
  preferredPayload = {},
  phasePayload = {},
  phasePayloadByTrigger = {}
} = {}) {
  const sources = [
    preferredPayload,
    phasePayload,
    ...Object.values(phasePayloadByTrigger ?? {})
  ].filter(src => src && typeof src === "object");

  for (const src of sources) {
    const id = str(
      src?.damageBatchId ??
      src?.rootDamageBatchId ??
      src?.meta?.damageBatchId ??
      src?.meta?.rootDamageBatchId ??
      src?.actionContext?.damageBatchId ??
      src?.actionContext?.meta?.damageBatchId ??
      src?.rootActionContext?.damageBatchId ??
      src?.rootActionContext?.meta?.damageBatchId ??
      ""
    );

    if (id) return id;
  }

  return "";
}

function stampDamageBatchIdOnPayload(payload, damageBatchId) {
  const id = str(damageBatchId);
  if (!id || !payload || typeof payload !== "object") return payload;

  payload.damageBatchId = id;
  payload.rootDamageBatchId = payload.rootDamageBatchId || id;

  payload.meta = payload.meta || {};
  payload.meta.damageBatchId = id;
  payload.meta.rootDamageBatchId = payload.meta.rootDamageBatchId || id;

  if (payload.actionContext && typeof payload.actionContext === "object") {
    payload.actionContext.damageBatchId = id;
    payload.actionContext.meta = payload.actionContext.meta || {};
    payload.actionContext.meta.damageBatchId = id;
    payload.actionContext.meta.rootDamageBatchId =
      payload.actionContext.meta.rootDamageBatchId || id;
  }

  return payload;
}

function stampDamageBatchMap(phasePayloadByTrigger = {}, damageBatchId) {
  const out = clone(phasePayloadByTrigger ?? {});

  if (!damageBatchId || !out || typeof out !== "object") return out;

  for (const payload of Object.values(out)) {
    stampDamageBatchIdOnPayload(payload, damageBatchId);
  }

  return out;
}

  function shallowCloneReactionGroup(group, rows) {
    return {
      ...(group ?? {}),
      triggers: toArrayUnique((rows ?? []).map(r => r?.reaction_trigger).filter(Boolean)),
      rows: Array.isArray(rows) ? [...rows] : []
    };
  }

  function splitReactionContext(ctx) {
    const reactions = Array.isArray(ctx?.reactions) ? ctx.reactions : [];
    const passiveGroups = [];
    const manualGroups = [];
    const passiveEntries = [];

    reactions.forEach((group, groupIndex) => {
      const rows = Array.isArray(group?.rows) ? group.rows : [];
      const passiveRows = [];
      const manualRows = [];

      rows.forEach((row, rowIndex) => {
        if (boolish(row?.reaction_isPassive)) {
          passiveRows.push(row);
          passiveEntries.push({
            actor: ctx?.actor ?? null,
            token: ctx?.token ?? null,
            combatant: ctx?.combatant ?? null,
            item: group?.item ?? null,
            row,
            rowIndex,
            groupIndex,
            triggerKey: str(ctx?.triggerKey ?? row?.reaction_trigger ?? ""),
            phasePayload: clone(ctx?.phasePayload ?? {}),
            phasePayloadByTrigger: {}
          });
        } else {
          manualRows.push(row);
        }
      });

      if (passiveRows.length) passiveGroups.push(shallowCloneReactionGroup(group, passiveRows));
      if (manualRows.length) manualGroups.push(shallowCloneReactionGroup(group, manualRows));
    });

    const manualCtx = manualGroups.length
      ? { ...(ctx ?? {}), reactions: manualGroups }
      : null;

    const passiveCtx = passiveGroups.length
      ? { ...(ctx ?? {}), reactions: passiveGroups }
      : null;

    return {
      manualCtx,
      passiveCtx,
      manualGroups,
      passiveGroups,
      passiveEntries
    };
  }

  async function executePassiveEntry(entry, options = {}) {
    cleanupLedgers();

    const actor = entry?.actor ?? null;
    const token = entry?.token ?? null;
    const item  = entry?.item ?? null;
    const row   = entry?.row ?? null;
    const rowIndex = Number.isFinite(Number(entry?.rowIndex)) ? Number(entry.rowIndex) : -1;
    const triggerKey = str(entry?.triggerKey ?? row?.reaction_trigger ?? options?.triggerKey ?? "");
    const phasePayload = clone(entry?.phasePayload ?? options?.phasePayload ?? {});
    const phasePayloadByTrigger = clone(options?.phasePayloadByTrigger ?? entry?.phasePayloadByTrigger ?? {});

    const executionKey = buildExecutionKey({
      actor,
      item,
      triggerKey,
      phasePayload,
      phasePayloadByTrigger,
      row,
      rowIndex
    });

    if (_recentExecutions.has(executionKey)) {
      log("SKIP duplicate passive execution.", {
        executionKey,
        actorName: actor?.name,
        itemName: item?.name,
        triggerKey,
        rowIndex
      });
      return {
        ok: true,
        skipped: true,
        reason: "duplicate_execution",
        executionKey,
        actor,
        token,
        item,
        row,
        rowIndex,
        triggerKey
      };
    }

    const passiveIdentity = buildPassiveIdentity({ actor, item, row, rowIndex });
    const rootKey = inferRootKey({ actor, item, row, rowIndex, triggerKey, phasePayload, phasePayloadByTrigger });
    const inheritedAncestry = getAncestryFromPayload(phasePayload);
    const inheritedDepth = getDepthFromPayload(phasePayload);

    const gateResult = checkPassiveGate({
      passiveIdentity,
      rootKey,
      ancestry: inheritedAncestry,
      actor,
      item,
      triggerKey,
      rowIndex
    });

    if (!gateResult?.ok) {
      return {
        ok: true,
        skipped: true,
        reason: `passive_gate_${gateResult?.reason || "blocked"}`,
        executionKey,
        rootKey,
        passiveIdentity,
        actor,
        token,
        item,
        row,
        rowIndex,
        triggerKey
      };
    }

    _recentExecutions.set(executionKey, Date.now());

    try {
      const resolver = getResolverApi();
      if (!resolver?.resolve) {
        warn("Target resolver API missing; cannot execute passive.", {
          actorName: actor?.name,
          itemName: item?.name,
          triggerKey
        });
        return {
          ok: false,
          reason: "target_resolver_missing",
          executionKey,
          rootKey,
          passiveIdentity,
          actor,
          token,
          item,
          row,
          rowIndex,
          triggerKey
        };
      }

      const passiveTargetMode = normalizePassiveTargetMode(row);
      const targetResolution = await resolver.resolve({
        passiveTargetMode,
        token,
        actor,
        tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
        actorUuid: actor?.uuid ?? null,
        item,
        itemUuid: item?.uuid ?? null,
        row,
        phasePayload,
        meta: {
          tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
          actorUuid: actor?.uuid ?? null,
          ownerTokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
          ownerActorUuid: actor?.uuid ?? null
        }
      });

      if (!targetResolution?.ok || !Array.isArray(targetResolution?.targetUUIDs) || !targetResolution.targetUUIDs.length) {
        warn("Passive target resolution failed.", {
          actorName: actor?.name,
          itemName: item?.name,
          triggerKey,
          rowIndex,
          passiveTargetMode,
          targetResolution
        });
        return {
          ok: false,
          reason: "target_resolution_failed",
          executionKey,
          rootKey,
          passiveIdentity,
          actor,
          token,
          item,
          row,
          rowIndex,
          triggerKey,
          passiveTargetMode,
          targetResolution
        };
      }

const preferredPayload = pickPreferredPayload(triggerKey, phasePayload, phasePayloadByTrigger);

const inheritedDamageBatchId = resolveInheritedDamageBatchId({
  preferredPayload,
  phasePayload,
  phasePayloadByTrigger
});

stampDamageBatchIdOnPayload(preferredPayload, inheritedDamageBatchId);

const phasePayloadByTriggerForPayload = stampDamageBatchMap(
  phasePayloadByTrigger,
  inheritedDamageBatchId
);

const ownerUserId = resolveOwnerUserIdForActor(actor);
const attackerTokenUuid = token?.document?.uuid ?? token?.uuid ?? null;
const attackerActorUuid = actor?.uuid ?? null;
const attackerUuidForADF = attackerTokenUuid ?? attackerActorUuid ?? null;
const runId = `AP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ancestry = toArrayUnique([...inheritedAncestry, passiveIdentity]);

const passiveOrigin = {
  rootKey,
  passiveIdentity,
  rowSignature: stableRowSignature(row, rowIndex),
  ancestry,
  depth: inheritedDepth + 1,
  rootTimestamp: pickEventStamp(triggerKey, phasePayload, phasePayloadByTrigger)
};

const payload = {
source: "AutoPassive",
autoPassive: true,

// Damage Card batch inheritance.
// This lets passive/reaction damage join the same grouped Damage Card
// as the original action that triggered it.
damageBatchId: inheritedDamageBatchId || null,
rootDamageBatchId: inheritedDamageBatchId || null,

attacker_uuid: attackerUuidForADF,
        attackerUuid: attackerUuidForADF,
        targets: [...targetResolution.targetUUIDs],
        originalTargetUUIDs: [...targetResolution.targetUUIDs],
        skill_uuid: item?.uuid ?? null,
        skillUuid: item?.uuid ?? null,
        reaction_trigger_key: triggerKey,
        reaction_trigger_keys: toArrayUnique([triggerKey]),
        reaction_phase_payload: preferredPayload,
        reaction_phase_payload_by_trigger: phasePayloadByTriggerForPayload,
        passiveOrigin,
        meta: {
          executionMode: "autoPassive",
          isPassiveExecution: true,

          // Damage Card batch inheritance.
          damageBatchId: inheritedDamageBatchId || null,
          rootDamageBatchId: inheritedDamageBatchId || null,

          // Useful for grouped Damage Card section labels later.
          damageSourceKind: "autoPassive",
          damageSourceKey: passiveIdentity,
          damageSourceName: item?.name ?? null,
          damageSourceIcon: item?.img ?? null,

          passiveManagerRunId: runId,
          passiveExecutionKey: executionKey,
          passiveTriggerKey: triggerKey,
          passiveRow: clone(row),
          passiveRowIndex: rowIndex,
          passiveTargetMode,
          passiveItemUuid: item?.uuid ?? null,
          passiveItemName: item?.name ?? null,
          attackerUuid: attackerUuidForADF,
          attackerTokenUuid,
          attackerActorUuid,
          ownerUserId,
          originalTargetUUIDs: [...targetResolution.targetUUIDs],
          targetActorUUIDs: [...(targetResolution.targetActorUUIDs ?? [])],
          reaction_phase_payload: preferredPayload,
          reaction_phase_payload_by_trigger: phasePayloadByTriggerForPayload,
          triggerKey,
          systemSource: "AutoPassiveManager",
          passiveOrigin
        }
      };

      log("EXECUTE passive -> ActionDataFetch", {
        runId,
        executionKey,
        rootKey,
        passiveIdentity,
        damageBatchId: inheritedDamageBatchId || null,
        actorName: actor?.name,
        tokenName: token?.name,
        itemName: item?.name,
        itemUuid: item?.uuid,
        triggerKey,
        rowIndex,
        passiveTargetMode,
        targets: payload.targets,
        attacker_uuid: payload.attacker_uuid,
        ancestry,
        depth: payload.meta?.passiveOrigin?.depth
      });

      const ADF = getADFMacro();
      if (!ADF) {
        warn(`Macro \"${ADF_MACRO_NAME}\" not found; passive execution aborted.`, {
          runId,
          executionKey,
          actorName: actor?.name,
          itemName: item?.name
        });
        return {
          ok: false,
          reason: "adf_macro_missing",
          executionKey,
          rootKey,
          passiveIdentity,
          actor,
          token,
          item,
          row,
          rowIndex,
          triggerKey,
          payload
        };
      }

      window.__PAYLOAD = payload;

const adfResult = await ADF.execute({
  __AUTO: true,
  __PAYLOAD: payload
});

return {
  ok: true,
  adfResult,
        executionKey,
        rootKey,
        passiveIdentity,
        actor,
        token,
        item,
        row,
        rowIndex,
        triggerKey,
        passiveTargetMode,
        targetResolution,
        payload
      };
    } catch (e) {
      err("executePassiveEntry failed.", {
        error: e,
        actorName: actor?.name,
        itemName: item?.name,
        triggerKey,
        rowIndex,
        row
      });
      return {
        ok: false,
        reason: "exception",
        error: e,
        executionKey,
        rootKey,
        passiveIdentity,
        actor,
        token,
        item,
        row,
        rowIndex,
        triggerKey
      };
    }
  }

  async function processContext({ ctx, triggerKey = null, phasePayload = {}, phasePayloadByTrigger = {} } = {}) {
    if (!ctx || typeof ctx !== "object") {
      return {
        ok: false,
        reason: "invalid_ctx",
        manualCtx: null,
        passiveResults: []
      };
    }

    const baseTriggerKey = str(triggerKey ?? ctx?.triggerKey ?? "");
    const split = splitReactionContext({
      ...(ctx ?? {}),
      triggerKey: baseTriggerKey || ctx?.triggerKey,
      phasePayload: clone(phasePayload ?? ctx?.phasePayload ?? {})
    });

    log("SPLIT reaction context.", {
      actorName: ctx?.actor?.name,
      tokenName: ctx?.token?.name,
      triggerKey: baseTriggerKey || ctx?.triggerKey,
      passiveGroups: split.passiveGroups.length,
      manualGroups: split.manualGroups.length,
      passiveRows: split.passiveEntries.length
    });

    const passiveResults = [];
    for (const entry of split.passiveEntries) {
      entry.triggerKey = str(entry.triggerKey || baseTriggerKey || ctx?.triggerKey || entry?.row?.reaction_trigger || "");
      entry.phasePayload = clone(phasePayload ?? ctx?.phasePayload ?? {});
      entry.phasePayloadByTrigger = clone(phasePayloadByTrigger ?? {});
      const result = await executePassiveEntry(entry, {
        triggerKey: entry.triggerKey,
        phasePayload: entry.phasePayload,
        phasePayloadByTrigger: entry.phasePayloadByTrigger
      });
      passiveResults.push(result);
    }

    return {
      ok: true,
      manualCtx: split.manualCtx,
      passiveCtx: split.passiveCtx,
      passiveResults,
      split
    };
  }

  async function processMatches({ matches = [], triggerKey = null, phasePayload = {}, phasePayloadByTrigger = {} } = {}) {
    if (!game.user?.isGM) {
      log("processMatches called on non-GM; returning matches unchanged.");
      return {
        ok: true,
        manualMatches: Array.isArray(matches) ? [...matches] : [],
        passiveResults: [],
        reason: "non_gm_noop"
      };
    }

    const input = Array.isArray(matches) ? matches : [];
    const manualMatches = [];
    const passiveResults = [];

    for (const ctx of input) {
      const result = await processContext({
        ctx,
        triggerKey,
        phasePayload,
        phasePayloadByTrigger
      });

      if (result?.manualCtx?.reactions?.length) {
        manualMatches.push(result.manualCtx);
      }

      if (Array.isArray(result?.passiveResults) && result.passiveResults.length) {
        passiveResults.push(...result.passiveResults);
      }
    }

    log("processMatches complete.", {
      triggerKey,
      inputMatches: input.length,
      manualMatches: manualMatches.length,
      passiveExecutions: passiveResults.length,
      passiveSummary: passiveResults.map(r => ({
        ok: !!r?.ok,
        skipped: !!r?.skipped,
        actorName: r?.actor?.name ?? null,
        itemName: r?.item?.name ?? null,
        triggerKey: r?.triggerKey ?? null,
        reason: r?.reason ?? null
      }))
    });

    return {
      ok: true,
      manualMatches,
      passiveResults
    };
  }

  const api = {
    splitReactionContext,
    executePassiveEntry,
    processContext,
    processMatches,
    _debug: {
      cleanupLedgers,
      recentExecutions: _recentExecutions,
      rootChainLedger: _rootChainLedger,
      reentryGraceLocks: _reentryGraceLocks,
      buildExecutionKey,
      buildPassiveIdentity,
      inferRootKey,
      boolish,
      normalizePassiveTargetMode
    }
  };

  ROOT.api.autoPassiveManager = api;
  window[KEY] = api;

  log("Installed.");
})();
