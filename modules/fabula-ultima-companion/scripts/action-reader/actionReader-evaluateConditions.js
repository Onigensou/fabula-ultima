/* ========================================================================== *
 * ActionReader Evaluate Conditions
 * -------------------------------------------------------------------------- *
 * Module-compatible condition evaluator for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-evaluateConditions.js
 *
 * Purpose:
 *   Evaluate normalized action pattern rows from context.patternRows and
 *   determine which rows are currently possible / legitimate.
 *
 * Usage:
 *   import {
 *     evaluateActionReaderConditions,
 *     registerActionReaderEvaluateConditions
 *   } from "./actionReader-evaluateConditions.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_EVALUATE_CONDITIONS_VERSION = "1.0.0";
export const ACTION_READER_EVALUATE_CONDITIONS_STAGE = "EvaluateConditions";

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

function getConditionRows(context) {
  return Array.isArray(context?.patternRows) ? context.patternRows : [];
}

function getCombat(context) {
  return context?.combat?.combat ?? context?.actorData?.combat?.combat ?? AR.getActiveCombat() ?? null;
}

function getResources(context) {
  return context?.actorData?.resources ?? {};
}

function getActor(context) {
  return context?.performer?.actor ?? context?.actorData?.actor ?? null;
}

function getActorName(context) {
  return context?.actorData?.identity?.actorName
    ?? context?.performer?.actorName
    ?? context?.performer?.actor?.name
    ?? "Unknown Actor";
}

function normalizeRange(value1, value2) {
  const a = AR.toInteger(value1, 0);
  const b = AR.toInteger(value2, 0);
  return {
    min: Math.min(a, b),
    max: Math.max(a, b)
  };
}

function isValueInInclusiveRange(value, min, max) {
  const current = AR.toInteger(value, 0);
  return current >= min && current <= max;
}

function getContextTurnNumber(context, options = {}) {
  const explicitTurnNumber = options?.turnNumber;
  if (Number.isFinite(explicitTurnNumber)) return Math.trunc(explicitTurnNumber);

  const overrideTurnNumber = context?.actorData?.overrides?.turnNumber;
  if (Number.isFinite(overrideTurnNumber)) return Math.trunc(overrideTurnNumber);

  const contextTurnNumber = context?.combat?.turnNumber;
  if (Number.isFinite(contextTurnNumber)) return Math.trunc(contextTurnNumber);

  const actorDataTurnNumber = context?.actorData?.combat?.turnNumber;
  if (Number.isFinite(actorDataTurnNumber)) return Math.trunc(actorDataTurnNumber);

  const combat = getCombat(context);
  if (!combat) return 0;

  const flagScope = AR.toString(options?.turnNumberFlagScope, "");
  const flagKey = AR.toString(options?.turnNumberFlagKey, "");

  if (flagScope && flagKey) {
    const scopedFlagValue = combat.getFlag?.(flagScope, flagKey);
    if (Number.isFinite(scopedFlagValue)) return Math.trunc(scopedFlagValue);
  }

  const fallbackPaths = [
    "flags.action-reader.turnNumber",
    "flags.ActionReader.turnNumber",
    "flags.actionReader.turnNumber"
  ];

  for (const path of fallbackPaths) {
    const value = AR.getPropertySafe(combat, path, undefined);
    if (Number.isFinite(value)) return Math.trunc(value);
  }

  return 0;
}

function evaluateABXProgression(currentValue, value1, value2) {
  const current = AR.toInteger(currentValue, 0);
  const a = AR.toInteger(value1, 0);
  const b = AR.toInteger(value2, 0);

  if (current < a) {
    return {
      passed: false,
      formula: `${a} + ${b} * X`,
      current,
      a,
      b,
      reason: `Current value ${current} is below starting value ${a}.`
    };
  }

  if (b <= 0) {
    const passed = current === a;
    return {
      passed,
      formula: `${a}`,
      current,
      a,
      b,
      reason: passed
        ? `Current value ${current} matches exact value ${a}.`
        : `Current value ${current} does not match exact value ${a}.`
    };
  }

  const delta = current - a;
  const remainder = delta % b;
  const passed = remainder === 0;

  return {
    passed,
    formula: `${a} + ${b} * X`,
    current,
    a,
    b,
    delta,
    remainder,
    reason: passed
      ? `Current value ${current} matches progression ${a} + ${b}*X.`
      : `Current value ${current} does not match progression ${a} + ${b}*X.`
  };
}

function getResourceSnapshotByConditionKey(context, conditionKey) {
  const resources = getResources(context);

  switch (conditionKey) {
    case "hp": return resources.hp ?? { current: 0, max: 0, percent: 0 };
    case "mp": return resources.mp ?? { current: 0, max: 0, percent: 0 };
    case "ip": return resources.ip ?? { current: 0, max: 0, percent: 0 };
    case "zero_power": return resources.zero ?? { current: 0, max: 0, percent: 0 };
    case "resource1": return resources.resource1 ?? { current: 0, max: 0, percent: 0 };
    case "resource2": return resources.resource2 ?? { current: 0, max: 0, percent: 0 };
    case "resource3": return resources.resource3 ?? { current: 0, max: 0, percent: 0 };
    default: return { current: 0, max: 0, percent: 0 };
  }
}

function evaluatePercentageRangeCondition(context, row, conditionKey, label) {
  const snapshot = getResourceSnapshotByConditionKey(context, conditionKey);
  const range = normalizeRange(row?.value1, row?.value2);
  const currentPercent = AR.toInteger(snapshot?.percent, 0);
  const passed = isValueInInclusiveRange(currentPercent, range.min, range.max);

  return {
    passed,
    conditionKey,
    conditionLabel: label,
    reason: passed
      ? `${label} ${currentPercent}% is within ${range.min}% - ${range.max}%.`
      : `${label} ${currentPercent}% is outside ${range.min}% - ${range.max}%.`,
    details: {
      current: AR.toInteger(snapshot?.current, 0),
      max: AR.toInteger(snapshot?.max, 0),
      percent: currentPercent,
      minPercent: range.min,
      maxPercent: range.max
    }
  };
}

function evaluateActiveEffectCondition(context, row) {
  const actor = getActor(context);
  const effectText = AR.toString(row?.stringRaw, "").trim();
  const normalized = AR.normalizeText(effectText);

  if (!actor) {
    return {
      passed: false,
      conditionKey: "active_effect",
      conditionLabel: "Active Effect",
      reason: "No actor found for Active Effect check.",
      details: {
        effectName: effectText,
        actorFound: false
      }
    };
  }

  if (!normalized) {
    return {
      passed: false,
      conditionKey: "active_effect",
      conditionLabel: "Active Effect",
      reason: "No Active Effect name was entered in the row string field.",
      details: {
        effectName: effectText,
        actorFound: true
      }
    };
  }

  const effectNames = Array.isArray(context?.actorData?.effectNames)
    ? context.actorData.effectNames
    : AR.getEffectNames(actor);

  const passed = AR.actorHasEffectByName(actor, effectText);

  return {
    passed,
    conditionKey: "active_effect",
    conditionLabel: "Active Effect",
    reason: passed
      ? `Actor has Active Effect "${effectText}".`
      : `Actor does not have Active Effect "${effectText}".`,
    details: {
      effectName: effectText,
      availableEffects: effectNames
    }
  };
}

/* Passes if the PERFORMER itself carries the named status. */
function evaluateSelfHasStatus(context, row) {
  const actor = getActor(context);
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Self Has Status";

  if (!actor) {
    return { passed: false, conditionKey: "self_has_status", conditionLabel: label,
      reason: "No actor found for Self Has Status check.", details: { statusName } };
  }
  if (!statusName) {
    return { passed: false, conditionKey: "self_has_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const passed = AR.actorHasEffectByName(actor, statusName);
  return {
    passed,
    conditionKey: "self_has_status",
    conditionLabel: label,
    reason: passed ? `Self has "${statusName}".` : `Self does not have "${statusName}".`,
    details: { statusName }
  };
}

/* Passes if the PERFORMER itself does NOT carry the named status. */
function evaluateSelfLacksStatus(context, row) {
  const actor = getActor(context);
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Self Lacks Status";

  if (!actor) {
    return { passed: false, conditionKey: "self_lacks_status", conditionLabel: label,
      reason: "No actor found for Self Lacks Status check.", details: { statusName } };
  }
  if (!statusName) {
    return { passed: false, conditionKey: "self_lacks_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const passed = !AR.actorHasEffectByName(actor, statusName);
  return {
    passed,
    conditionKey: "self_lacks_status",
    conditionLabel: label,
    reason: passed ? `Self does not have "${statusName}" (pass).` : `Self has "${statusName}" (fail).`,
    details: { statusName }
  };
}

function getPerformerTokenDoc(context) {
  return context?.performer?.tokenDocument ?? context?.actorData?.tokenDocument ?? null;
}

/* `target_count` — "how many creatures can THIS action actually reach", vs an
   inclusive v1–v2 range. Distinct from enemy_count, which answers "how many
   enemies exist": an action's own skill_target side/count and its declared
   filters (target_eligibility, pool focus, the weapon range gate) all narrow the
   reachable set, so a rule written against the head-count fires for actions that
   then find nothing to hit.

   DEFERRED on purpose. Conditions are evaluated before actions are matched, so
   here a row has an action NAME but no resolved Item — and resolving it by name
   would be a SECOND, subtly different resolver: the matcher prefers an
   action-list reference (by uuid, then id, then name) and skips Passive
   duplicates, so a name lookup can land on a different document than the one
   that will actually be used. Two resolvers means the gate can pass for one
   document while another is played. So the row passes here and the real test
   runs in MatchAndPickAction, where the Item is already resolved. */
function deferTargetCount(row) {
  const hasRange = AR.toString(row?.value1Raw, "") !== "" || AR.toString(row?.value2Raw, "") !== "";
  const range = hasRange
    ? normalizeRange(row?.value1, row?.value2)
    : { min: 1, max: Number.MAX_SAFE_INTEGER };
  return {
    passed: true,
    deferred: true,
    conditionKey: "target_count",
    conditionLabel: "Targets Available",
    reason: `Deferred to action match — needs the resolved action (want ${range.min}–${range.max}).`,
    details: { min: range.min, max: range.max, deferred: true }
  };
}

/* Enemy/ally count vs an inclusive v1–v2 range. */
function evaluateCountCondition(context, row, relation, label) {
  const actor = getActor(context);
  const tokenDoc = getPerformerTokenDoc(context);
  const count = AR.countSceneTargetsForRelation(actor, tokenDoc, relation, context);
  const range = normalizeRange(row?.value1, row?.value2);
  const passed = isValueInInclusiveRange(count, range.min, range.max);

  return {
    passed,
    conditionKey: relation === "enemy" ? "enemy_count" : "ally_count",
    conditionLabel: label,
    reason: passed
      ? `${label} ${count} is within ${range.min}–${range.max}.`
      : `${label} ${count} is outside ${range.min}–${range.max}.`,
    details: { count, min: range.min, max: range.max }
  };
}

/* Passes if at least one enemy does NOT carry the named status — "is there still
   somebody left to do this to?". The mirror of enemy_has_status, and NOT its
   negation: `not(any enemy has X)` would go false the moment ONE enemy picked X
   up, which is the wrong gate for a move that works through a group one victim
   at a time. Pair it with target focus `status_avoid:<X>` so the action also
   AIMS at someone who still lacks the status. */
function evaluateEnemyLacksStatus(context, row) {
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Enemy Lacks Status";

  if (!statusName) {
    return { passed: false, conditionKey: "enemy_lacks_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const tokenDoc = getPerformerTokenDoc(context);
  const performerDisposition = AR.getTokenDisposition(tokenDoc);
  const tokens = AR.participantTokens(context);

  let free = null;
  for (const tok of tokens) {
    const actor = AR.getTokenActor(tok);
    if (!actor || AR.isUntargetableActor(actor)) continue;
    const rel = AR.relationToPerformer(AR.getTokenDisposition(AR.getTokenDocument(tok)), performerDisposition);
    if (rel !== "enemy") continue;
    if (!AR.actorHasEffectByName(actor, statusName)) { free = AR.getActorName(actor); break; }
  }

  const passed = Boolean(free);
  return {
    passed,
    conditionKey: "enemy_lacks_status",
    conditionLabel: label,
    reason: passed ? `Enemy "${free}" does not have "${statusName}".` : `Every enemy already has "${statusName}".`,
    details: { statusName, free }
  };
}

/* Passes if any enemy (opposing-side token) carries the named status. */
function evaluateEnemyHasStatus(context, row) {
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Enemy Has Status";

  if (!statusName) {
    return { passed: false, conditionKey: "enemy_has_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const tokenDoc = getPerformerTokenDoc(context);
  const performerDisposition = AR.getTokenDisposition(tokenDoc);
  const tokens = AR.participantTokens(context);

  let holder = null;
  for (const tok of tokens) {
    const actor = AR.getTokenActor(tok);
    if (!actor) continue;
    const rel = AR.relationToPerformer(AR.getTokenDisposition(AR.getTokenDocument(tok)), performerDisposition);
    if (rel !== "enemy") continue;
    if (AR.actorHasEffectByName(actor, statusName)) { holder = AR.getActorName(actor); break; }
  }

  const passed = Boolean(holder);
  return {
    passed,
    conditionKey: "enemy_has_status",
    conditionLabel: label,
    reason: passed ? `Enemy "${holder}" has "${statusName}".` : `No enemy has "${statusName}".`,
    details: { statusName, holder }
  };
}

/* Passes if ANY creature on the scene except the performer carries the status. */
/* Ally-scoped twin of enemy_has_status. `creature_has_status` scans BOTH sides,
   so it could not express "one of my side is in trouble" — an enemy carrying the
   status passed the gate just as well. Guests are excluded (never counted). */
function evaluateAllyHasStatus(context, row) {
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Ally Has Status";

  if (!statusName) {
    return { passed: false, conditionKey: "ally_has_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const tokenDoc = getPerformerTokenDoc(context);
  const performerDisposition = AR.getTokenDisposition(tokenDoc);
  const performerId = tokenDoc?.id ?? null;
  const tokens = AR.participantTokens(context);

  let holder = null;
  for (const tok of tokens) {
    const actor = AR.getTokenActor(tok);
    if (!actor || AR.isUntargetableActor(actor)) continue;
    const td = AR.getTokenDocument(tok);
    if (performerId && td?.id === performerId) continue;   // self is not an ally
    if (AR.relationToPerformer(AR.getTokenDisposition(td), performerDisposition) !== "ally") continue;
    if (AR.actorHasEffectByName(actor, statusName)) { holder = AR.getActorName(actor); break; }
  }

  const passed = Boolean(holder);
  return {
    passed,
    conditionKey: "ally_has_status",
    conditionLabel: label,
    reason: passed ? `Ally "${holder}" has "${statusName}".` : `No ally has "${statusName}".`,
    details: { statusName, holder }
  };
}

/* Crisis, byte-for-byte as the reaction engine defines it (_anyAllyInCrisis in
   reaction-system/formula-evaluator.js). Kept as a mirror on purpose — two
   different answers to "is this ally in Crisis" is worse than either answer:
     • a DISABLED effect is NOT crisis (an earlier cut of this missed that, so a
       disabled Crisis AE short-circuited before the HP fallback and would have
       made a priority-12 healer burn every turn on a full-HP ally),
     • the bdCrisis FLAG counts even when the effect is named something else,
     • otherwise the RAW threshold, so the gate holds before the crisis-reactor
       has stamped anything — which is exactly when a healer must act. */
function isActorInCrisis(actor) {
  const hasAe = (actor?.effects?.contents ?? Array.from(actor?.effects ?? [])).some((e) => {
    if (e?.disabled) return false;
    if (e?.flags?.["fabula-ultima-companion"]?.bdCrisis === true) return true;
    return String(e?.name ?? "").trim().toLowerCase() === "crisis";
  });
  if (hasAe) return true;
  const cur = Number(actor?.system?.props?.current_hp);
  const max = Number(actor?.system?.props?.max_hp);
  return Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur * 2 <= max;
}

/* Is one of my side in CRISIS? A core Fabula Ultima state, so it gets its own
   condition rather than leaning on a status NAME through creature_has_status —
   which scans both sides and would fire on a wounded ENEMY. */
function evaluateAllyInCrisis(context, row) {
  const label = "Ally In Crisis";
  const tokenDoc = getPerformerTokenDoc(context);
  const performerDisposition = AR.getTokenDisposition(tokenDoc);
  const performerId = tokenDoc?.id ?? null;
  const tokens = AR.participantTokens(context);

  let holder = null;
  let count = 0;
  for (const tok of tokens) {
    const actor = AR.getTokenActor(tok);
    if (!actor || AR.isUntargetableActor(actor)) continue;
    const td = AR.getTokenDocument(tok);
    if (performerId && td?.id === performerId) continue;
    if (AR.relationToPerformer(AR.getTokenDisposition(td), performerDisposition) !== "ally") continue;

    if (isActorInCrisis(actor)) { count++; if (!holder) holder = AR.getActorName(actor); }
  }

  // Range semantics match the other count conditions: blank v1/v2 → "at least
  // one" rather than the degenerate 0–0 window an unset range would produce.
  const hasRange = AR.toString(row?.value1Raw, "") !== "" || AR.toString(row?.value2Raw, "") !== "";
  const range = hasRange ? normalizeRange(row?.value1, row?.value2) : { min: 1, max: Number.MAX_SAFE_INTEGER };
  const passed = isValueInInclusiveRange(count, range.min, range.max);

  return {
    passed,
    conditionKey: "ally_in_crisis",
    conditionLabel: label,
    reason: passed
      ? `${count} ally/allies in Crisis${holder ? ` (e.g. ${holder})` : ""} — within ${range.min}–${range.max}.`
      : `${count} ally/allies in Crisis — outside ${range.min}–${range.max}.`,
    details: { count, holder, min: range.min, max: range.max }
  };
}

function evaluateCreatureHasStatus(context, row) {
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Creature Has Status";

  if (!statusName) {
    return { passed: false, conditionKey: "creature_has_status", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const performerId = getPerformerTokenDoc(context)?.id ?? null;
  const tokens = AR.participantTokens(context);

  let holder = null;
  for (const tok of tokens) {
    const tokenDoc = AR.getTokenDocument(tok);
    if (performerId && tokenDoc?.id === performerId) continue; // exclude self
    const actor = AR.getTokenActor(tok);
    if (!actor) continue;
    if (AR.actorHasEffectByName(actor, statusName)) { holder = AR.getActorName(actor); break; }
  }

  const passed = Boolean(holder);
  return {
    passed,
    conditionKey: "creature_has_status",
    conditionLabel: label,
    reason: passed ? `Creature "${holder}" has "${statusName}".` : `No creature has "${statusName}".`,
    details: { statusName, holder }
  };
}

/* Self status stack count. v1 = min (>=1 if blank); v2 = optional max. */
function evaluateEffectStacks(context, row) {
  const actor = getActor(context);
  const statusName = AR.toString(row?.stringRaw, "").trim();
  const label = "Effect Stacks";

  if (!statusName) {
    return { passed: false, conditionKey: "effect_stacks", conditionLabel: label,
      reason: "No status name entered in the row string field.", details: {} };
  }

  const stacks = AR.getEffectStackCount(actor, statusName);
  const min = Math.max(1, AR.toInteger(row?.value1, 1));
  const max = AR.toInteger(row?.value2, 0);
  const passed = max > 0 ? (stacks >= min && stacks <= max) : (stacks >= min);

  return {
    passed,
    conditionKey: "effect_stacks",
    conditionLabel: label,
    reason: passed
      ? `"${statusName}" stacks (${stacks}) satisfy ${max > 0 ? `${min}–${max}` : `>= ${min}`}.`
      : `"${statusName}" stacks (${stacks}) do not satisfy ${max > 0 ? `${min}–${max}` : `>= ${min}`}.`,
    details: { statusName, stacks, min, max: max > 0 ? max : null }
  };
}

/*
 * Performer's activation slot within the current round vs an inclusive v1–v2
 * range. The index (1-based: 1 = first activation this round) is supplied by
 * the Battle Director through the autopilot as an override; outside a BD
 * battle it is unknown (0) and the condition fails closed, letting `always`
 * fallback rows act instead.
 */
function evaluateActivationSlot(context, row) {
  const label = "Activation No.";
  const activationIndex = AR.toInteger(context?.actorData?.overrides?.activationIndex, 0);
  const range = normalizeRange(row?.value1, row?.value2);

  if (activationIndex <= 0) {
    return {
      passed: false,
      conditionKey: "activation",
      conditionLabel: label,
      reason: "No activation index available (not running inside a Battle Director turn).",
      details: { activationIndex, min: range.min, max: range.max }
    };
  }

  const passed = isValueInInclusiveRange(activationIndex, range.min, range.max);
  return {
    passed,
    conditionKey: "activation",
    conditionLabel: label,
    reason: passed
      ? `Activation ${activationIndex} is within ${range.min}–${range.max}.`
      : `Activation ${activationIndex} is outside ${range.min}–${range.max}.`,
    details: { activationIndex, min: range.min, max: range.max }
  };
}

/* Pure random gate: v1 = percent chance (0–100). */
function evaluateRandomChance(context, row) {
  const chance = AR.clamp(AR.toInteger(row?.value1, 0), 0, 100);
  const roll = Math.random() * 100;
  const passed = roll < chance;

  return {
    passed,
    conditionKey: "random",
    conditionLabel: "Random %",
    reason: passed ? `Rolled ${roll.toFixed(1)} < ${chance}% (pass).` : `Rolled ${roll.toFixed(1)} >= ${chance}% (fail).`,
    details: { chance, roll: Number(roll.toFixed(1)) }
  };
}

function evaluateOneCondition(context, row, options = {}) {
  const conditionKey = AR.toString(row?.conditionKey, "always");
  const conditionLabel = AR.toString(row?.conditionLabel, "Always");

  switch (conditionKey) {
    case "always":
      return {
        passed: true,
        conditionKey,
        conditionLabel,
        reason: "Always condition always passes.",
        details: {}
      };

    case "turn": {
      const currentTurnNumber = getContextTurnNumber(context, options);
      const result = evaluateABXProgression(currentTurnNumber, row?.value1, row?.value2);

      return {
        passed: result.passed,
        conditionKey,
        conditionLabel,
        reason: result.reason,
        details: {
          turnNumber: result.current,
          formula: result.formula,
          a: result.a,
          b: result.b,
          delta: result.delta ?? null,
          remainder: result.remainder ?? null
        }
      };
    }

    case "round": {
      const currentRound = AR.toInteger(context?.combat?.round ?? context?.actorData?.combat?.round, 0);
      const result = evaluateABXProgression(currentRound, row?.value1, row?.value2);

      return {
        passed: result.passed,
        conditionKey,
        conditionLabel,
        reason: result.reason,
        details: {
          roundNumber: result.current,
          formula: result.formula,
          a: result.a,
          b: result.b,
          delta: result.delta ?? null,
          remainder: result.remainder ?? null
        }
      };
    }

    case "hp":
      return evaluatePercentageRangeCondition(context, row, "hp", "HP");

    case "mp":
      return evaluatePercentageRangeCondition(context, row, "mp", "MP");

    case "ip":
      return evaluatePercentageRangeCondition(context, row, "ip", "IP");

    case "zero_power":
      return evaluatePercentageRangeCondition(context, row, "zero_power", "Zero Power");

    case "resource1":
      return evaluatePercentageRangeCondition(context, row, "resource1", "Resource 1");

    case "resource2":
      return evaluatePercentageRangeCondition(context, row, "resource2", "Resource 2");

    case "resource3":
      return evaluatePercentageRangeCondition(context, row, "resource3", "Resource 3");

    case "active_effect":
      return evaluateActiveEffectCondition(context, row);

    case "self_has_status":
      return evaluateSelfHasStatus(context, row);

    case "self_lacks_status":
      return evaluateSelfLacksStatus(context, row);

    case "enemy_count":
      return evaluateCountCondition(context, row, "enemy", "Enemy Count");

    case "target_count":
      return deferTargetCount(row);

    case "ally_count":
      return evaluateCountCondition(context, row, "ally", "Ally Count");

    case "enemy_has_status":
      return evaluateEnemyHasStatus(context, row);

    case "enemy_lacks_status":
      return evaluateEnemyLacksStatus(context, row);

    case "ally_has_status":
      return evaluateAllyHasStatus(context, row);

    case "ally_in_crisis":
      return evaluateAllyInCrisis(context, row);

    case "creature_has_status":
      return evaluateCreatureHasStatus(context, row);

    case "effect_stacks":
      return evaluateEffectStacks(context, row);

    case "random":
      return evaluateRandomChance(context, row);

    case "activation":
      return evaluateActivationSlot(context, row);

    default:
      return {
        passed: false,
        conditionKey,
        conditionLabel,
        reason: `Unknown condition key "${conditionKey}".`,
        details: {
          rawCondition: row?.conditionRaw ?? ""
        }
      };
  }
}

function buildEvaluatedRow(context, row, options = {}) {
  const conditionResult = evaluateOneCondition(context, row, options);

  return {
    ...AR.duplicateSafe(row),
    evaluation: {
      passed: Boolean(conditionResult?.passed),
      reason: AR.toString(conditionResult?.reason, ""),
      details: AR.duplicateSafe(conditionResult?.details ?? {}),
      conditionKey: AR.toString(conditionResult?.conditionKey, row?.conditionKey ?? ""),
      conditionLabel: AR.toString(conditionResult?.conditionLabel, row?.conditionLabel ?? "")
    },
    passedCondition: Boolean(conditionResult?.passed),
    failedCondition: !Boolean(conditionResult?.passed)
  };
}

function summarizeEvaluatedRows(rows) {
  const passedRows = rows.filter(row => row?.passedCondition);
  const failedRows = rows.filter(row => row?.failedCondition);

  return {
    totalRows: rows.length,
    passedRows: passedRows.length,
    failedRows: failedRows.length
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function evaluateActionReaderConditions(context, options = {}) {
  const stage = ACTION_READER_EVALUATE_CONDITIONS_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      includeFailedRows: Boolean(options?.includeFailedRows),
      explicitTurnNumber: Number.isFinite(options?.turnNumber) ? Math.trunc(options.turnNumber) : null,
      turnNumberFlagScope: AR.toString(options?.turnNumberFlagScope, ""),
      turnNumberFlagKey: AR.toString(options?.turnNumberFlagKey, "")
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    if (!context?.actorData) {
      ARD.addError(context, stage, "EvaluateConditions requires actorData from BuildContext first.", {
        hasActorData: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const sourceRows = getConditionRows(context);

    if (!sourceRows.length) {
      context.evaluatedRows = [];
      context.conditionMeta = {
        totalRows: 0,
        passedRows: 0,
        failedRows: 0,
        includeFailedRows: Boolean(options?.includeFailedRows),
        turnNumber: getContextTurnNumber(context, options)
      };

      ARD.addWarning(context, stage, "There are no pattern rows to evaluate.", {
        actorName: getActorName(context)
      });

      ARD.recordStage(context, stage, context.conditionMeta);
      ARD.endStage(context, stage, { ok: true, totalRows: 0 });
      return context;
    }

    const evaluatedRows = sourceRows.map(row => buildEvaluatedRow(context, row, options));
    const includeFailedRows = Boolean(options?.includeFailedRows);

    context.evaluatedRows = includeFailedRows
      ? evaluatedRows
      : evaluatedRows.filter(row => row.passedCondition);

    const summary = summarizeEvaluatedRows(evaluatedRows);
    context.conditionMeta = {
      ...summary,
      includeFailedRows,
      turnNumber: getContextTurnNumber(context, options),
      currentRound: AR.toInteger(context?.combat?.round ?? context?.actorData?.combat?.round, 0)
    };

    const hasTurnCondition = evaluatedRows.some(row => row?.conditionKey === "turn");
    if (hasTurnCondition && context.conditionMeta.turnNumber === 0) {
      ARD.addWarning(
        context,
        stage,
        "Turn No. conditions are being evaluated with turnNumber = 0. Pass a custom turn number or a combat flag source if you want JRPG-style total turn counting.",
        {
          actorName: getActorName(context),
          turnNumber: context.conditionMeta.turnNumber
        }
      );
    }

    ARD.recordStage(context, stage, context.conditionMeta);

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Condition evaluation results",
        evaluatedRows.map(row => ({
          rowIndex: row.rowIndex,
          actionName: row.actionName,
          condition: row.conditionKey,
          passed: row.passedCondition,
          priority: row.priority,
          reason: row.evaluation?.reason ?? ""
        })),
        context
      );
    }

    ARD.endStage(context, stage, {
      ok: true,
      totalRows: summary.totalRows,
      passedRows: summary.passedRows,
      failedRows: summary.failedRows,
      retainedRows: Array.isArray(context.evaluatedRows) ? context.evaluatedRows.length : 0
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while evaluating conditions.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][EvaluateConditions] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderEvaluateConditions(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderEvaluateConditions called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Evaluate Conditions.`);
    return;
  }

  api.EvaluateConditions = {
    evaluateActionReaderConditions
  };

  console.debug(`[ActionReader] Evaluate Conditions registered to module API for "${moduleId}".`);
}
