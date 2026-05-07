/* ========================================================================== *
 * ActionReader Match And Pick Action
 * -------------------------------------------------------------------------- *
 * Module-compatible action matcher and picker for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-matchAndPickAction.js
 *
 * Purpose:
 *   1. Match evaluated pattern rows to real actor actions.
 *   2. Skip passive actions.
 *   3. Apply priority-window weighting.
 *   4. Store the chosen action in context.chosenAction.
 *
 * Usage:
 *   import {
 *     matchAndPickActionReaderAction,
 *     registerActionReaderMatchAndPickAction
 *   } from "./actionReader-matchAndPickAction.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_MATCH_AND_PICK_ACTION_VERSION = "1.0.0";
export const ACTION_READER_MATCH_AND_PICK_ACTION_STAGE = "MatchAndPickAction";

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

function getEvaluatedRows(context) {
  return Array.isArray(context?.evaluatedRows) ? context.evaluatedRows : [];
}

function getActorItems(context) {
  return Array.isArray(context?.actorData?.items) ? context.actorData.items : [];
}

function getActionReferences(context) {
  return Array.isArray(context?.actorData?.actionReferences) ? context.actorData.actionReferences : [];
}

function normalizeIdLike(value) {
  const text = AR.toString(value, "").trim();
  if (!text) return "";
  if (text.includes("${")) return "";
  return text;
}

function isPassiveItemSnapshot(itemSnapshot) {
  const skillType = AR.normalizeText(itemSnapshot?.skillType ?? itemSnapshot?.props?.[AR.keys.skillType]);
  return skillType === "passive";
}

function buildItemIndexes(context) {
  const items = getActorItems(context);

  const byUuid = new Map();
  const byId = new Map();
  const byName = new Map();

  for (const item of items) {
    const uuid = AR.toString(item?.uuid, "").trim();
    const id = AR.toString(item?.id, "").trim();
    const nameA = AR.normalizeText(item?.displayName);
    const nameB = AR.normalizeText(item?.name);

    if (uuid) byUuid.set(uuid, item);
    if (id) byId.set(id, item);

    for (const key of [nameA, nameB]) {
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(item);
    }
  }

  return { byUuid, byId, byName };
}

function buildReferenceIndexes(context) {
  const refs = getActionReferences(context);

  const byUuid = new Map();
  const byId = new Map();
  const byName = new Map();

  for (const ref of refs) {
    const uuid = normalizeIdLike(ref?.uuid);
    const id = normalizeIdLike(ref?.id);
    const name = AR.normalizeText(ref?.name);

    if (uuid) byUuid.set(uuid, ref);
    if (id) byId.set(id, ref);

    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(ref);
    }
  }

  return { byUuid, byId, byName };
}

function getPriorityWeight(priorityGap) {
  switch (priorityGap) {
    case 0: return 3;
    case 1: return 2;
    case 2: return 1;
    default: return 0;
  }
}

function makeMatchResult({
  row,
  itemSnapshot,
  actionReference = null,
  matchSource = "unknown",
  matchReason = ""
}) {
  const item = itemSnapshot?.item ?? null;
  const icon = item ? AR.getActionTypeIcon(item) : "💥";
  const skillTarget = item ? AR.getActionTargetText(item) : AR.toString(itemSnapshot?.skillTarget, "");
  const skillType = AR.toString(itemSnapshot?.skillType, "");
  const priority = AR.toInteger(row?.priority, 5);

  return {
    rowIndex: row?.rowIndex ?? 0,
    rowKey: row?.rowKey ?? "",
    row,
    actionName: row?.actionName ?? "",
    actionNameNormalized: row?.actionNameNormalized ?? "",
    priority,

    item,
    itemSnapshot,
    itemId: itemSnapshot?.id ?? item?.id ?? null,
    itemUuid: itemSnapshot?.uuid ?? item?.uuid ?? null,
    itemName: itemSnapshot?.displayName ?? itemSnapshot?.name ?? item?.name ?? "Unnamed Action",
    skillType,
    skillTarget,
    isOffensiveSpell: Boolean(itemSnapshot?.isOffensiveSpell),
    icon,

    actionReference,
    matchSource,
    matchReason,

    passedCondition: Boolean(row?.passedCondition),
    priorityGap: null,
    selectionWeight: 0,
    withinPriorityWindow: false
  };
}

function tryMatchViaReferenceName(row, itemIndexes, refIndexes) {
  const refs = refIndexes.byName.get(row?.actionNameNormalized) ?? [];
  for (const ref of refs) {
    const refUuid = normalizeIdLike(ref?.uuid);
    const refId = normalizeIdLike(ref?.id);

    let itemSnapshot = null;
    let source = "";

    if (refUuid && itemIndexes.byUuid.has(refUuid)) {
      itemSnapshot = itemIndexes.byUuid.get(refUuid);
      source = "actionReference.uuid";
    } else if (refId && itemIndexes.byId.has(refId)) {
      itemSnapshot = itemIndexes.byId.get(refId);
      source = "actionReference.id";
    } else {
      const fallbackItems = itemIndexes.byName.get(row?.actionNameNormalized) ?? [];
      itemSnapshot = fallbackItems.find(item => !isPassiveItemSnapshot(item)) ?? fallbackItems[0] ?? null;
      source = "actionReference.name";
    }

    if (!itemSnapshot) continue;
    if (isPassiveItemSnapshot(itemSnapshot)) {
      return {
        matched: false,
        blockedByPassive: true,
        actionReference: ref,
        matchSource: source,
        reason: "Matched action reference, but the resolved action is Passive."
      };
    }

    return {
      matched: true,
      candidate: makeMatchResult({
        row,
        itemSnapshot,
        actionReference: ref,
        matchSource: source,
        matchReason: "Matched through actor action-list reference."
      })
    };
  }

  return { matched: false };
}

function tryMatchViaDirectItemName(row, itemIndexes) {
  const items = itemIndexes.byName.get(row?.actionNameNormalized) ?? [];
  if (!items.length) return { matched: false };

  const nonPassive = items.find(item => !isPassiveItemSnapshot(item));
  const selected = nonPassive ?? items[0];

  if (!selected) return { matched: false };

  if (isPassiveItemSnapshot(selected)) {
    return {
      matched: false,
      blockedByPassive: true,
      actionReference: null,
      matchSource: "item.name",
      reason: "Matched actor item by name, but it is Passive."
    };
  }

  return {
    matched: true,
    candidate: makeMatchResult({
      row,
      itemSnapshot: selected,
      actionReference: null,
      matchSource: "item.name",
      matchReason: "Matched directly against actor item name."
    })
  };
}

function matchOneEvaluatedRow(row, context, indexes) {
  if (!row?.passedCondition) {
    return {
      matched: false,
      reason: "Row did not pass condition evaluation."
    };
  }

  if (!row?.actionNameNormalized) {
    return {
      matched: false,
      reason: "Row has no normalized action name."
    };
  }

  const referenceMatch = tryMatchViaReferenceName(row, indexes.itemIndexes, indexes.refIndexes);
  if (referenceMatch.matched) return referenceMatch;
  if (referenceMatch.blockedByPassive) {
    return {
      matched: false,
      blockedByPassive: true,
      reason: referenceMatch.reason,
      matchSource: referenceMatch.matchSource
    };
  }

  const directItemMatch = tryMatchViaDirectItemName(row, indexes.itemIndexes);
  if (directItemMatch.matched) return directItemMatch;
  if (directItemMatch.blockedByPassive) {
    return {
      matched: false,
      blockedByPassive: true,
      reason: directItemMatch.reason,
      matchSource: directItemMatch.matchSource
    };
  }

  return {
    matched: false,
    reason: "No actor action could be matched from row action name."
  };
}

function applyPriorityWindow(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      topPriority: null,
      retained: []
    };
  }

  const topPriority = Math.max(...candidates.map(c => AR.toInteger(c?.priority, 0)));

  const retained = candidates
    .map(candidate => {
      const gap = topPriority - AR.toInteger(candidate?.priority, 0);
      const weight = getPriorityWeight(gap);

      return {
        ...candidate,
        priorityGap: gap,
        selectionWeight: weight,
        withinPriorityWindow: weight > 0
      };
    })
    .filter(candidate => candidate.withinPriorityWindow);

  return {
    topPriority,
    retained
  };
}

function summarizeMatchResults(matchResults, retainedCandidates, chosenCandidate, topPriority) {
  const matched = matchResults.filter(r => r?.matched).length;
  const unmatched = matchResults.filter(r => !r?.matched).length;
  const passiveBlocked = matchResults.filter(r => r?.blockedByPassive).length;

  return {
    totalRowsConsidered: matchResults.length,
    matchedRows: matched,
    unmatchedRows: unmatched,
    passiveBlockedRows: passiveBlocked,
    retainedCandidates: retainedCandidates.length,
    topPriority,
    chosenActionName: chosenCandidate?.itemName ?? null,
    chosenRowIndex: chosenCandidate?.rowIndex ?? null
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function matchAndPickActionReaderAction(context, options = {}) {
  const stage = ACTION_READER_MATCH_AND_PICK_ACTION_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      preferActionReferences: options?.preferActionReferences !== false
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    if (!context?.actorData) {
      ARD.addError(context, stage, "MatchAndPickAction requires actorData from BuildContext first.", {
        hasActorData: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const sourceRows = getEvaluatedRows(context);
    if (!sourceRows.length) {
      context.actionCandidates = [];
      context.chosenAction = null;

      ARD.addError(context, stage, "There are no evaluated rows to match.", {
        actorName: context?.actorData?.identity?.actorName ?? null
      });
      ARD.endStage(context, stage, { ok: false, totalRows: 0 });
      return context;
    }

    const indexes = {
      itemIndexes: buildItemIndexes(context),
      refIndexes: buildReferenceIndexes(context)
    };

    const passedRows = sourceRows.filter(row => row?.passedCondition);
    const matchResults = passedRows.map(row => matchOneEvaluatedRow(row, context, indexes));

    const matchedCandidates = matchResults
      .filter(result => result?.matched)
      .map(result => result.candidate);

    const { topPriority, retained } = applyPriorityWindow(matchedCandidates);
    const chosenCandidate = AR.weightedPick(retained, candidate => candidate.selectionWeight);

    context.actionCandidatesAll = matchedCandidates;
    context.actionCandidates = retained;
    context.chosenAction = chosenCandidate
      ? {
          candidate: chosenCandidate,
          row: chosenCandidate.row,
          item: chosenCandidate.item,
          itemSnapshot: chosenCandidate.itemSnapshot,
          actionReference: chosenCandidate.actionReference,
          name: chosenCandidate.itemName,
          icon: chosenCandidate.icon,
          skillType: chosenCandidate.skillType,
          skillTarget: chosenCandidate.skillTarget,
          isOffensiveSpell: chosenCandidate.isOffensiveSpell,
          matchSource: chosenCandidate.matchSource,
          matchReason: chosenCandidate.matchReason,
          priority: chosenCandidate.priority,
          priorityGap: chosenCandidate.priorityGap,
          selectionWeight: chosenCandidate.selectionWeight
        }
      : null;

    context.actionMatchMeta = summarizeMatchResults(
      matchResults,
      retained,
      chosenCandidate,
      topPriority
    );

    ARD.recordStage(context, stage, context.actionMatchMeta);

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Action match results",
        passedRows.map((row, index) => {
          const result = matchResults[index] ?? {};
          return {
            rowIndex: row.rowIndex,
            actionName: row.actionName,
            priority: row.priority,
            matched: Boolean(result.matched),
            blockedByPassive: Boolean(result.blockedByPassive),
            matchSource: result?.candidate?.matchSource ?? result?.matchSource ?? "",
            itemName: result?.candidate?.itemName ?? "",
            reason: result?.candidate?.matchReason ?? result?.reason ?? ""
          };
        }),
        context
      );

      ARD.table(
        stage,
        "Retained action candidates",
        retained.map(candidate => ({
          rowIndex: candidate.rowIndex,
          actionName: candidate.itemName,
          priority: candidate.priority,
          priorityGap: candidate.priorityGap,
          selectionWeight: candidate.selectionWeight,
          matchSource: candidate.matchSource,
          skillType: candidate.skillType,
          skillTarget: candidate.skillTarget
        })),
        context
      );
    }

    if (!matchedCandidates.length) {
      ARD.addError(context, stage, "No valid actions could be matched from the evaluated pattern rows.", {
        actorName: context?.actorData?.identity?.actorName ?? null,
        passedRows: passedRows.length
      });
      ARD.endStage(context, stage, {
        ok: false,
        matchedCandidates: 0,
        retainedCandidates: 0
      });
      return context;
    }

    if (!retained.length || !chosenCandidate) {
      ARD.addError(context, stage, "No action could be selected after applying the priority window.", {
        actorName: context?.actorData?.identity?.actorName ?? null,
        matchedCandidates: matchedCandidates.length,
        topPriority
      });
      ARD.endStage(context, stage, {
        ok: false,
        matchedCandidates: matchedCandidates.length,
        retainedCandidates: retained.length
      });
      return context;
    }

    ARD.endStage(context, stage, {
      ok: true,
      matchedCandidates: matchedCandidates.length,
      retainedCandidates: retained.length,
      chosenActionName: context?.chosenAction?.name ?? null,
      chosenRowIndex: context?.chosenAction?.row?.rowIndex ?? null
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while matching and picking action.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][MatchAndPickAction] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderMatchAndPickAction(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderMatchAndPickAction called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Match And Pick Action.`);
    return;
  }

  api.MatchAndPickAction = {
    matchAndPickActionReaderAction
  };

  console.log(`[ActionReader] Match And Pick Action registered to module API for "${moduleId}".`);
}
