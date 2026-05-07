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

  console.log(`[ActionReader] Evaluate Conditions registered to module API for "${moduleId}".`);
}
