/* ========================================================================== *
 * ActionReader Build Context
 * -------------------------------------------------------------------------- *
 * Module-compatible context builder for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-buildContext.js
 *
 * Purpose:
 *   Build a stable data snapshot from the already-resolved performer:
 *   - actor / token references
 *   - actor props snapshot
 *   - combat snapshot
 *   - resources
 *   - active effects
 *   - action pattern raw table
 *   - action list containers from actor props
 *   - actor items normalized for later matching
 *
 * Usage:
 *   import {
 *     buildActionReaderContext,
 *     registerActionReaderBuildContext
 *   } from "./actionReader-buildContext.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_BUILD_CONTEXT_VERSION = "1.0.0";
export const ACTION_READER_BUILD_CONTEXT_STAGE = "BuildContext";

function getModuleApiContainer(moduleId) {
  const module = game.modules.get(moduleId);
  if (!module) return null;

  module.api ??= {};
  module.api.ActionReader ??= {};
  return module.api.ActionReader;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function getPerformerActor(context) {
  return context?.performer?.actor ?? null;
}

function getPerformerToken(context) {
  return context?.performer?.token ?? context?.performer?.tokenDocument?.object ?? null;
}

function getPerformerTokenDocument(context) {
  return context?.performer?.tokenDocument ?? AR.getTokenDocument(getPerformerToken(context)) ?? null;
}

function collectEffectSnapshot(actor) {
  return AR.getActorEffects(actor).map(effect => ({
    id: effect?.id ?? null,
    name: effect?.name ?? "",
    disabled: Boolean(effect?.disabled),
    transfer: Boolean(effect?.transfer),
    origin: effect?.origin ?? null,
    uuid: effect?.uuid ?? null
  }));
}

function isLikelyActionListContainer(key, value) {
  if (!key || typeof key !== "string") return false;
  if (!key.endsWith("_list")) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const rows = Object.values(value);
  if (!rows.length) return true;

  return rows.some(row => {
    if (!row || typeof row !== "object") return false;
    return ("uuid" in row) || ("id" in row) || ("name" in row);
  });
}

function collectActionListContainers(props) {
  const result = [];

  for (const [key, value] of Object.entries(props ?? {})) {
    if (!isLikelyActionListContainer(key, value)) continue;

    const entries = Object.entries(value ?? {}).map(([entryKey, row]) => ({
      entryKey,
      name: AR.toString(row?.name, ""),
      id: AR.toString(row?.id, ""),
      uuid: AR.toString(row?.uuid, ""),
      raw: AR.duplicateSafe(row ?? {})
    }));

    result.push({
      listKey: key,
      entries
    });
  }

  return result.sort((a, b) => a.listKey.localeCompare(b.listKey));
}

function flattenActionListReferences(actionLists) {
  const flat = [];

  for (const list of actionLists ?? []) {
    for (const entry of list.entries ?? []) {
      flat.push({
        listKey: list.listKey,
        entryKey: entry.entryKey,
        name: entry.name,
        id: entry.id,
        uuid: entry.uuid,
        raw: entry.raw
      });
    }
  }

  return flat;
}

function collectActorItemSnapshot(actor) {
  return AR.getActorItems(actor).map(item => {
    const props = AR.getItemProps(item);

    return {
      item,
      id: item?.id ?? null,
      uuid: item?.uuid ?? null,
      name: item?.name ?? "",
      displayName: AR.getItemDisplayName(item),
      type: item?.type ?? "",
      img: item?.img ?? "",
      skillType: AR.toString(props?.[AR.keys.skillType], ""),
      skillTarget: AR.toString(props?.[AR.keys.skillTarget], ""),
      isOffensiveSpell: Boolean(props?.[AR.keys.isOffensiveSpell]),
      props: AR.duplicateSafe(props)
    };
  });
}

function buildCombatSnapshot(context) {
  const combat = context?.combat?.combat ?? AR.getActiveCombat() ?? null;
  const combatant = context?.performer?.combatant ?? combat?.combatant ?? null;

  return {
    combat,
    combatant,
    combatId: combat?.id ?? null,
    combatantId: combatant?.id ?? null,
    round: AR.getCombatRound(combat),
    turnIndex: AR.getCombatTurnIndex(combat),
    started: Boolean(combat?.started)
  };
}

function buildPerformerRelationSnapshot(context) {
  const performer = context?.performer ?? {};
  const disposition = performer.disposition ?? AR.getTokenDisposition(performer.tokenDocument ?? performer.token);

  return {
    disposition,
    side: AR.getDispositionSide(disposition),
    source: performer.source ?? "unknown",
    actorId: performer.actorId ?? performer.actor?.id ?? null,
    actorName: performer.actorName ?? performer.actor?.name ?? "Unknown Actor",
    tokenId: performer.tokenId ?? performer.tokenDocument?.id ?? null,
    tokenName: performer.tokenName ?? performer.token?.name ?? performer.tokenDocument?.name ?? "Unknown Token"
  };
}

function summarizeActorData(actorData) {
  return {
    actorName: actorData?.identity?.actorName ?? null,
    tokenName: actorData?.identity?.tokenName ?? null,
    side: actorData?.identity?.side ?? null,
    resources: {
      hp: actorData?.resources?.hp?.percent ?? null,
      mp: actorData?.resources?.mp?.percent ?? null,
      ip: actorData?.resources?.ip?.percent ?? null,
      zero: actorData?.resources?.zero?.percent ?? null,
      resource1: actorData?.resources?.resource1?.percent ?? null,
      resource2: actorData?.resources?.resource2?.percent ?? null,
      resource3: actorData?.resources?.resource3?.percent ?? null
    },
    enmity: actorData?.enmity ?? null,
    effectCount: Array.isArray(actorData?.effects) ? actorData.effects.length : 0,
    itemCount: Array.isArray(actorData?.items) ? actorData.items.length : 0,
    actionListCount: Array.isArray(actorData?.actionLists) ? actorData.actionLists.length : 0,
    actionReferenceCount: Array.isArray(actorData?.actionReferences) ? actorData.actionReferences.length : 0,
    patternRowCount: Array.isArray(actorData?.actionPatternRowsRaw) ? actorData.actionPatternRowsRaw.length : 0
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function buildActionReaderContext(context, options = {}) {
  const stage = ACTION_READER_BUILD_CONTEXT_STAGE;
  ARD.beginStage(context, stage, { optionsSummary: { hasOverrides: Boolean(options?.overrides) } });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const actor = getPerformerActor(context);
    const token = getPerformerToken(context);
    const tokenDocument = getPerformerTokenDocument(context);

    if (!actor || !tokenDocument) {
      ARD.addError(context, stage, "BuildContext requires a resolved performer first.", {
        actorFound: Boolean(actor),
        tokenDocumentFound: Boolean(tokenDocument)
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const props = AR.getActorProps(actor);
    const resources = AR.getStandardResources(actor);
    const effects = collectEffectSnapshot(actor);
    const effectNames = effects.map(effect => effect.name);

    const rawActionPatternTable = AR.getActionPatternTable(actor);
    const actionPatternRowsRaw = AR.getActionPatternRows(actor).map(row => ({
      rowKey: row.rowKey,
      rowIndex: row.rowIndex,
      data: AR.duplicateSafe(row.data)
    }));

    const actionLists = collectActionListContainers(props);
    const actionReferences = flattenActionListReferences(actionLists);
    const items = collectActorItemSnapshot(actor);
    const combatSnapshot = buildCombatSnapshot(context);
    const performerSnapshot = buildPerformerRelationSnapshot(context);

    const overrides = options?.overrides ?? {};
    const actorData = {
      identity: performerSnapshot,
      actor,
      token,
      tokenDocument,
      props: AR.duplicateSafe(props),
      resources,
      enmity: AR.getActorEnmity(actor, 100),
      effects,
      effectNames,
      combat: combatSnapshot,
      rawActionPatternTable: AR.duplicateSafe(rawActionPatternTable),
      actionPatternRowsRaw,
      actionLists,
      actionReferences,
      items,
      overrides: AR.duplicateSafe(overrides)
    };

    context.actorData = actorData;

    ARD.recordStage(context, stage, summarizeActorData(actorData));

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Action list containers",
        (actorData.actionLists ?? []).map(list => ({
          listKey: list.listKey,
          entryCount: Array.isArray(list.entries) ? list.entries.length : 0
        })),
        context
      );

      ARD.table(
        stage,
        "Actor item snapshot",
        (actorData.items ?? []).map(item => ({
          name: item.displayName,
          id: item.id,
          skillType: item.skillType,
          skillTarget: item.skillTarget,
          isOffensiveSpell: item.isOffensiveSpell
        })),
        context
      );

      ARD.table(
        stage,
        "Raw action pattern rows",
        (actorData.actionPatternRowsRaw ?? []).map(row => ({
          rowIndex: row.rowIndex,
          actionName: row.data?.[AR.keys.actionPatternNameKey] ?? "",
          condition: row.data?.[AR.keys.actionPatternConditionKey] ?? "",
          value1: row.data?.[AR.keys.actionPatternValue1Key] ?? "",
          value2: row.data?.[AR.keys.actionPatternValue2Key] ?? "",
          priority: row.data?.[AR.keys.actionPatternPriorityKey] ?? "",
          string: row.data?.[AR.keys.actionPatternStringKey] ?? "",
          deleted: Boolean(row.data?.[AR.keys.actionPatternDeletedKey])
        })),
        context
      );
    }

    ARD.endStage(context, stage, {
      ok: true,
      actorName: actorData.identity.actorName,
      tokenName: actorData.identity.tokenName,
      itemCount: actorData.items.length,
      actionListCount: actorData.actionLists.length,
      patternRowCount: actorData.actionPatternRowsRaw.length
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while building context.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][BuildContext] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderBuildContext(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderBuildContext called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Build Context.`);
    return;
  }

  api.BuildContext = {
    buildActionReaderContext
  };

  console.log(`[ActionReader] Build Context registered to module API for "${moduleId}".`);
}
