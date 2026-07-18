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

import { ActionReaderCore as AR, FU_MODULE_ID } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_MATCH_AND_PICK_ACTION_VERSION = "1.0.0";

const ACTION_MEMORY_FLAG = "actionReaderMemory";
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

/* -------------------------------------------------------------------------- */
/* Feasibility (#1): can the actor actually perform this action right now?    */
/* -------------------------------------------------------------------------- */

function getCandidateProps(candidate) {
  return candidate?.itemSnapshot?.props ?? candidate?.item?.system?.props ?? {};
}

function isCandidateFree(candidate) {
  const cost = AR.parseActionCost(getCandidateProps(candidate)?.[AR.keys.cost]);
  return Boolean(cost.free);
}

/* -------------------------------------------------------------------------- */
/* Action-gating (#5): don't pick an action type barred by a debuff.          */
/* -------------------------------------------------------------------------- */

// Map a matched candidate to the canonical turn-action LABEL used by the
// action-gating debuffs (Frightened bars "Attack", Silence bars "Spell", …).
// MUST stay in lockstep with enemy-autopilot.js `toBundle`: the AI only ever
// composes Attack / Spell / Skill, so those are the only labels a candidate can
// carry — a blocked "Objective"/"Equipment" simply matches nothing here.
function candidateActionLabel(candidate) {
  const raw = candidate?.skillType ?? getCandidateProps(candidate)?.[AR.keys.skillType] ?? "";
  const st = AR.toString(raw, "").trim().toLowerCase();
  if (st === "attack") return "Attack";
  if (st === "spell") return "Spell";
  return "Skill"; // "active" / "skill" / blank → treated as a Skill (mirrors toBundle)
}

// The Set<label> of turn actions the performer may NOT use this turn, sourced by
// BuildContext from snapshot.getBlockedActionLabels (honours Domination). Absent
// on standalone runs that skipped BuildContext → nothing is blocked (fail-open,
// same philosophy as the feasibility filter).
function getBlockedLabels(context) {
  const set = context?.actorData?.blockedActionLabels;
  return set instanceof Set ? set : new Set();
}

function isCandidateActionBlocked(candidate, blockedLabels) {
  if (!blockedLabels?.size) return false;
  return blockedLabels.has(candidateActionLabel(candidate));
}

/* -------------------------------------------------------------------------- */
/* Self-cost HP reserve: don't pick a move that could KO the performer.        */
/* -------------------------------------------------------------------------- */

// The performer's live current HP (resources snapshot from BuildContext, with a
// fallback to the raw actor prop for standalone runs). null when unknowable.
function getPerformerCurrentHp(context) {
  const snap = context?.actorData?.resources?.hp;
  if (snap && Number.isFinite(AR.toNumber(snap.current, NaN))) {
    return AR.toNumber(snap.current, 0);
  }
  const actor = context?.performer?.actor ?? context?.actorData?.actor ?? null;
  const raw = actor?.system?.props?.[AR.keys.hpCurrent];
  const n = AR.toNumber(raw, NaN);
  return Number.isFinite(n) ? n : null;
}

// The performer's live HP as a percentage (0–100), from the same BuildContext
// resources snapshot the `hp` condition reads, with a raw-prop fallback for
// standalone runs. null when unknowable (→ ceiling never blocks, fail-open).
function getPerformerCurrentHpPercent(context) {
  const snap = context?.actorData?.resources?.hp;
  if (snap && Number.isFinite(AR.toNumber(snap.percent, NaN))) {
    return AR.toNumber(snap.percent, 0);
  }
  const actor = context?.performer?.actor ?? context?.actorData?.actor ?? null;
  const cur = AR.toNumber(actor?.system?.props?.[AR.keys.hpCurrent], NaN);
  const max = AR.toNumber(actor?.system?.props?.[AR.keys.hpMax], NaN);
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null;
  return AR.percentCeil(cur, max);
}

// A row's optional `action_pattern_hp_reserve` — the minimum current HP the
// performer must have to pick it (a self-cost safety margin for HP-paying moves
// like Geist's Shadow Strike / Shadowbringers). Blocked when currentHp < reserve.
// Blank/0 reserve, or unknowable HP, never blocks (fail-open, legacy behavior).
function candidateHpReserve(candidate) {
  return AR.toInteger(candidate?.row?.hpReserve, 0);
}

function isCandidateHpReserved(candidate, currentHp) {
  if (currentHp == null) return false;
  const reserve = candidateHpReserve(candidate);
  return reserve > 0 && currentHp < reserve;
}

// A row's optional `action_pattern_hp_ceiling` — the maximum current HP % the
// performer may have to pick it (the mirror of hp_reserve: a "only when hurt"
// gate, e.g. Geist's Shadow Wall that should only open when he is at/below 60%).
// Blocked when currentHpPct > ceiling. Blank/0 ceiling, or unknowable HP%, never
// blocks (fail-open, legacy behavior).
function candidateHpCeiling(candidate) {
  return AR.toInteger(candidate?.row?.hpCeiling, 0);
}

function isCandidateHpCeilinged(candidate, currentHpPct) {
  if (currentHpPct == null) return false;
  const ceiling = candidateHpCeiling(candidate);
  return ceiling > 0 && currentHpPct > ceiling;
}

/*
 * Returns { feasible, reasons[] }. Checks:
 *   - resource cost (MP/IP) vs the performer's current pools
 *   - at least one legal target exists on the scene for the action's relation
 * Unknown/blank data never blocks (degrades to legacy "always feasible").
 */
function assessCandidateFeasibility(candidate, context) {
  const props = getCandidateProps(candidate);
  const reasons = [];

  // Resource cost. For "x T" (per-target) costs, require at least one target's worth.
  const cost = AR.parseActionCost(props?.[AR.keys.cost]);
  if (!cost.free && (cost.resource === "mp" || cost.resource === "ip")) {
    const pool = cost.resource === "mp"
      ? context?.actorData?.resources?.mp
      : context?.actorData?.resources?.ip;
    const current = AR.toNumber(pool?.current, 0);
    if (current < cost.amount) {
      reasons.push(`Needs ${cost.amount} ${cost.resource.toUpperCase()}, has ${current}.`);
    }
  }

  // Target existence (skip self-targeted / relation-less actions).
  const relation = AR.quickTargetRelation(candidate?.skillTarget);
  if (relation && relation !== "self") {
    const performerActor = context?.performer?.actor ?? context?.actorData?.actor ?? null;
    const performerTokenDoc = context?.performer?.tokenDocument ?? null;
    const available = AR.countSceneTargetsForRelation(performerActor, performerTokenDoc, relation);
    if (available < 1) {
      reasons.push(`No legal ${relation} target on the scene.`);
    }
  }

  return { feasible: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Anti-repeat memory (#4): per-combatant last-used / cooldown tracking       */
/* -------------------------------------------------------------------------- */

function getMemoryCombatant(context) {
  return context?.performer?.combatant ?? context?.actorData?.combat?.combatant ?? null;
}

function getCurrentRound(context) {
  return AR.toInteger(context?.combat?.round ?? context?.actorData?.combat?.round, 0);
}

function readActionMemory(context) {
  const combatant = getMemoryCombatant(context);
  if (!combatant) return { lastActionName: "", usedRounds: {} };

  let mem;
  try {
    mem = combatant.getFlag?.(FU_MODULE_ID, ACTION_MEMORY_FLAG);
  } catch (_e) {
    mem = undefined;
  }
  mem = mem ?? combatant?.flags?.[FU_MODULE_ID]?.[ACTION_MEMORY_FLAG];

  return {
    lastActionName: AR.normalizeText(mem?.lastActionName ?? ""),
    usedRounds: (mem && typeof mem.usedRounds === "object") ? mem.usedRounds : {}
  };
}

/*
 * Apply cooldown/anti-repeat to retained candidates.
 *   - explicit action_pattern_cooldown column (turns) => hard-block while on CD
 *   - otherwise the action used last turn is softly de-weighted (x0.3)
 * If everything ends up blocked, fall back to the unadjusted weights so the
 * actor still acts.
 */
function applyAntiRepeat(retained, context) {
  const memory = readActionMemory(context);
  const currentRound = getCurrentRound(context);

  const adjusted = retained.map(candidate => {
    const nameNorm = candidate.actionNameNormalized;
    const cooldown = AR.toInteger(getCandidateProps(candidate)?.[AR.keys.actionPatternCooldownKey], 0);
    const lastUsedRound = AR.toInteger(memory.usedRounds?.[nameNorm], NaN);

    let weight = candidate.selectionWeight;
    let blocked = false;

    if (cooldown > 0 && Number.isFinite(lastUsedRound) && (currentRound - lastUsedRound) < cooldown) {
      weight = 0;
      blocked = true;
    } else if (memory.lastActionName && memory.lastActionName === nameNorm) {
      weight *= 0.3;
    }

    return { ...candidate, cooldownWeight: weight, cooldownBlocked: blocked };
  });

  const live = adjusted.filter(candidate => candidate.cooldownWeight > 0);
  if (live.length) return { pool: live, memory, currentRound, fallback: false };

  // All blocked — ignore cooldown this turn rather than freeze.
  const fallbackPool = retained.map(candidate => ({ ...candidate, cooldownWeight: candidate.selectionWeight }));
  return { pool: fallbackPool, memory, currentRound, fallback: true };
}

async function recordActionMemory(context, chosenCandidate, memory, currentRound) {
  const combatant = getMemoryCombatant(context);
  if (!combatant?.setFlag || !chosenCandidate) return;

  const nameNorm = chosenCandidate.actionNameNormalized;
  const usedRounds = { ...(memory?.usedRounds ?? {}), [nameNorm]: currentRound };

  try {
    await combatant.setFlag(FU_MODULE_ID, ACTION_MEMORY_FLAG, {
      lastActionName: nameNorm,
      usedRounds
    });
  } catch (_e) {
    /* non-fatal */
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

    // --- Action-gating hard filter (#5) --------------------------------- //
    // Remove action types a debuff bars (Frightened→Attack, Silence→Spell,
    // Berserk→everything-but-Attack). This runs BEFORE feasibility so the whole
    // downstream (priority window, weighted pick, anti-repeat, targeting) — and
    // the feasibility graceful-fallback — only ever sees LEGAL actions. That is
    // what makes the AI route to its "next best" legal action instead of the
    // autopilot backstop dumping the turn to the manual menu. If every matched
    // action is blocked, legalCandidates is empty → chosenAction stays null →
    // caller falls to manual (the enemy genuinely has nothing legal to do).
    const blockedLabels = getBlockedLabels(context);
    const legalCandidates = [];
    let blockedCandidateCount = 0;
    for (const candidate of matchedCandidates) {
      if (isCandidateActionBlocked(candidate, blockedLabels)) {
        candidate.actionBlocked = true;
        candidate.actionBlockedLabel = candidateActionLabel(candidate);
        blockedCandidateCount++;
      } else {
        candidate.actionBlocked = false;
        legalCandidates.push(candidate);
      }
    }
    if (blockedCandidateCount) {
      ARD.addWarning(context, stage, "Some matched actions are barred by an action-gating debuff.", {
        blockedCandidates: blockedCandidateCount,
        blockedLabels: Array.from(blockedLabels),
        legalCandidates: legalCandidates.length
      });
    }

    // --- HP hard filters (#6): self-cost reserve + low-HP ceiling ------- //
    // Runs BEFORE feasibility (like #5) so neither an HP-paying move that could
    // KO the performer (reserve: Geist's Shadow Strike / Shadowbringers) nor an
    // "only when hurt" move gated above a threshold (ceiling: Geist's Shadow
    // Wall, opener-slot but only at ≤60% HP) can be picked — and, critically,
    // neither is resurrected by the feasibility graceful-fallback (an HP move
    // with no MP/IP cost reads as "free"). Reserve blocks below its floor;
    // ceiling blocks above its cap. If this empties a slot, the lower-priority
    // `always` fallback rows remain and the actor still acts.
    const currentHp = getPerformerCurrentHp(context);
    const currentHpPct = getPerformerCurrentHpPercent(context);
    const affordableCandidates = [];
    let hpReservedCount = 0;
    let hpCeilingCount = 0;
    for (const candidate of legalCandidates) {
      if (isCandidateHpReserved(candidate, currentHp)) {
        candidate.hpReserved = true;
        candidate.hpReserveValue = candidateHpReserve(candidate);
        hpReservedCount++;
        continue;
      }
      if (isCandidateHpCeilinged(candidate, currentHpPct)) {
        candidate.hpCeilinged = true;
        candidate.hpCeilingValue = candidateHpCeiling(candidate);
        hpCeilingCount++;
        continue;
      }
      candidate.hpReserved = false;
      candidate.hpCeilinged = false;
      affordableCandidates.push(candidate);
    }
    if (hpReservedCount) {
      ARD.addWarning(context, stage, "Some matched actions were withheld — HP too low to pay their self-cost.", {
        currentHp,
        hpReservedCandidates: hpReservedCount,
        affordableCandidates: affordableCandidates.length
      });
    }
    if (hpCeilingCount) {
      ARD.addWarning(context, stage, "Some matched actions were withheld — HP above their low-HP ceiling.", {
        currentHpPct,
        hpCeilingCandidates: hpCeilingCount,
        affordableCandidates: affordableCandidates.length
      });
    }

    // --- Feasibility filter (#1) ---------------------------------------- //
    const feasibility = new Map();
    const feasibleCandidates = affordableCandidates.filter(candidate => {
      const result = assessCandidateFeasibility(candidate, context);
      feasibility.set(candidate, result);
      candidate.feasible = result.feasible;
      candidate.feasibilityReasons = result.reasons;
      return result.feasible;
    });

    let workingCandidates = feasibleCandidates;
    let feasibilityFallbackUsed = false;

    if (!workingCandidates.length && affordableCandidates.length) {
      // Graceful fallback: prefer no-cost actions so the actor still does
      // *something* (e.g. a basic attack) instead of erroring out. NOTE: draws
      // from affordableCandidates ONLY — never resurrect a debuff-blocked (#5)
      // or HP-reserved (#6) action.
      const freeCandidates = affordableCandidates.filter(isCandidateFree);
      workingCandidates = freeCandidates.length ? freeCandidates : affordableCandidates;
      feasibilityFallbackUsed = true;

      ARD.addWarning(context, stage, "No fully-feasible action; using graceful fallback.", {
        affordableCandidates: affordableCandidates.length,
        freeFallbackCount: freeCandidates.length
      });
    }

    const { topPriority, retained } = applyPriorityWindow(workingCandidates);

    // --- Anti-repeat / cooldown (#4) ------------------------------------ //
    const antiRepeat = applyAntiRepeat(retained, context);
    const chosenCandidate = AR.weightedPick(antiRepeat.pool, candidate => candidate.cooldownWeight);

    if (chosenCandidate && options?.recordMemory !== false) {
      await recordActionMemory(context, chosenCandidate, antiRepeat.memory, antiRepeat.currentRound);
    }

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
    context.actionMatchMeta.feasibleCandidates = feasibleCandidates.length;
    context.actionMatchMeta.legalCandidates = legalCandidates.length;
    context.actionMatchMeta.blockedCandidates = blockedCandidateCount;
    context.actionMatchMeta.blockedLabels = Array.from(blockedLabels);
    context.actionMatchMeta.infeasibleCandidates = legalCandidates.length - feasibleCandidates.length;
    context.actionMatchMeta.feasibilityFallbackUsed = feasibilityFallbackUsed;
    context.actionMatchMeta.antiRepeatLastAction = antiRepeat.memory.lastActionName || null;
    context.actionMatchMeta.antiRepeatFallbackUsed = antiRepeat.fallback;

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
            actionBlocked: Boolean(result?.candidate?.actionBlocked),
            actionBlockedLabel: result?.candidate?.actionBlockedLabel ?? "",
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
      const allBlocked = matchedCandidates.length > 0 && legalCandidates.length === 0;
      ARD.addError(context, stage, allBlocked
        ? "Every matched action is barred by an action-gating debuff; no legal action to select."
        : "No action could be selected after applying the priority window.", {
        actorName: context?.actorData?.identity?.actorName ?? null,
        matchedCandidates: matchedCandidates.length,
        legalCandidates: legalCandidates.length,
        blockedCandidates: blockedCandidateCount,
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

  console.debug(`[ActionReader] Match And Pick Action registered to module API for "${moduleId}".`);
}
