/* ========================================================================== *
 * ActionReader Read Pattern Table
 * -------------------------------------------------------------------------- *
 * Module-compatible pattern table reader for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-readPatternTable.js
 *
 * Purpose:
 *   Normalize raw action pattern table rows from context.actorData into a
 *   stable context.patternRows array for later pipeline stages.
 *
 * Usage:
 *   import {
 *     readActionReaderPatternTable,
 *     registerActionReaderReadPatternTable
 *   } from "./actionReader-readPatternTable.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_READ_PATTERN_TABLE_VERSION = "1.0.0";
export const ACTION_READER_READ_PATTERN_TABLE_STAGE = "ReadPatternTable";

const DEFAULT_PRIORITY = 5;

const CONDITION_ALIASES = Object.freeze({
  always: "always",

  turn: "turn",
  "turn no.": "turn",
  "turn no": "turn",

  round: "round",
  "round no.": "round",
  "round no": "round",

  hp: "hp",
  mp: "mp",
  ip: "ip",

  zero_power: "zero_power",
  "zero power": "zero_power",
  zeropower: "zero_power",

  resource1: "resource1",
  "resource 1": "resource1",

  resource2: "resource2",
  "resource 2": "resource2",

  resource3: "resource3",
  "resource 3": "resource3",

  active_effect: "active_effect",
  "active effect": "active_effect"
});

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

function normalizeConditionKey(rawValue) {
  const normalized = AR.normalizeText(rawValue).replace(/_/g, " ");
  if (!normalized) return "always";

  const directKey = normalized.replace(/\s+/g, "_");
  return CONDITION_ALIASES[directKey] ?? CONDITION_ALIASES[normalized] ?? directKey;
}

function getConditionLabel(conditionKey) {
  switch (conditionKey) {
    case "always": return "Always";
    case "turn": return "Turn No.";
    case "round": return "Round No.";
    case "hp": return "HP";
    case "mp": return "MP";
    case "ip": return "IP";
    case "zero_power": return "Zero Power";
    case "resource1": return "Resource 1";
    case "resource2": return "Resource 2";
    case "resource3": return "Resource 3";
    case "active_effect": return "Active Effect";
    default: return AR.titleCase(conditionKey.replace(/_/g, " "));
  }
}

function normalizePatternRow(rawRow = {}) {
  const data = rawRow?.data ?? {};
  const rowKey = rawRow?.rowKey ?? "";
  const rowIndex = AR.toInteger(rawRow?.rowIndex, 0);

  const deleted = Boolean(data?.[AR.keys.actionPatternDeletedKey]);

  const actionNameRaw = AR.toString(data?.[AR.keys.actionPatternNameKey], "");
  const actionName = actionNameRaw.trim();
  const actionNameNormalized = AR.normalizeText(actionName);

  const conditionRaw = AR.toString(data?.[AR.keys.actionPatternConditionKey], "always");
  const conditionKey = normalizeConditionKey(conditionRaw);
  const conditionLabel = getConditionLabel(conditionKey);

  const value1Raw = data?.[AR.keys.actionPatternValue1Key] ?? "";
  const value2Raw = data?.[AR.keys.actionPatternValue2Key] ?? "";
  const stringRaw = AR.toString(data?.[AR.keys.actionPatternStringKey], "");
  const priorityRaw = data?.[AR.keys.actionPatternPriorityKey] ?? DEFAULT_PRIORITY;

  const value1 = AR.toInteger(value1Raw, 0);
  const value2 = AR.toInteger(value2Raw, 0);
  const priority = AR.toInteger(priorityRaw, DEFAULT_PRIORITY);

  let isUsable = true;
  let skipReason = "";

  if (deleted) {
    isUsable = false;
    skipReason = "Row is marked deleted.";
  } else if (!actionNameNormalized) {
    isUsable = false;
    skipReason = "Row has no action name.";
  }

  return {
    rowKey,
    rowIndex,

    deleted,
    isUsable,
    skipReason,

    actionNameRaw,
    actionName,
    actionNameNormalized,

    conditionRaw,
    conditionKey,
    conditionLabel,

    value1Raw,
    value2Raw,
    value1,
    value2,

    stringRaw,
    stringNormalized: AR.normalizeText(stringRaw),

    priorityRaw,
    priority,

    raw: AR.duplicateSafe(data)
  };
}

function getRawPatternRows(context) {
  return Array.isArray(context?.actorData?.actionPatternRowsRaw)
    ? context.actorData.actionPatternRowsRaw
    : [];
}

function summarizePatternRows(rows) {
  const usable = rows.filter(row => row.isUsable);
  const skipped = rows.filter(row => !row.isUsable);

  return {
    totalRows: rows.length,
    usableRows: usable.length,
    skippedRows: skipped.length,
    skippedDeleted: skipped.filter(r => r.deleted).length,
    skippedBlankName: skipped.filter(r => !r.deleted && !r.actionNameNormalized).length
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function readActionReaderPatternTable(context, options = {}) {
  const stage = ACTION_READER_READ_PATTERN_TABLE_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      includeSkippedRows: Boolean(options?.includeSkippedRows)
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const rawRows = getRawPatternRows(context);

    if (!context?.actorData) {
      ARD.addError(context, stage, "ReadPatternTable requires actorData from BuildContext first.", {
        hasActorData: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    if (!rawRows.length) {
      context.patternRows = [];
      ARD.addWarning(context, stage, "Actor has no action pattern rows.", {
        actorName: context?.actorData?.identity?.actorName ?? null
      });
      ARD.recordStage(context, stage, {
        totalRows: 0,
        usableRows: 0,
        skippedRows: 0
      });
      ARD.endStage(context, stage, { ok: true, totalRows: 0 });
      return context;
    }

    const normalizedRows = rawRows.map(normalizePatternRow);
    const includeSkippedRows = Boolean(options?.includeSkippedRows);

    context.patternRows = includeSkippedRows
      ? normalizedRows
      : normalizedRows.filter(row => row.isUsable);

    context.patternTableMeta = {
      totalRows: normalizedRows.length,
      usableRows: normalizedRows.filter(row => row.isUsable).length,
      skippedRows: normalizedRows.filter(row => !row.isUsable).length,
      includeSkippedRows
    };

    const summary = summarizePatternRows(normalizedRows);
    ARD.recordStage(context, stage, summary);

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Normalized pattern rows",
        normalizedRows.map(row => ({
          rowIndex: row.rowIndex,
          actionName: row.actionName,
          condition: row.conditionKey,
          value1: row.value1,
          value2: row.value2,
          string: row.stringRaw,
          priority: row.priority,
          deleted: row.deleted,
          isUsable: row.isUsable,
          skipReason: row.skipReason
        })),
        context
      );
    }

    ARD.endStage(context, stage, {
      ok: true,
      totalRows: summary.totalRows,
      usableRows: summary.usableRows,
      skippedRows: summary.skippedRows
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while reading pattern table.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][ReadPatternTable] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderReadPatternTable(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderReadPatternTable called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Read Pattern Table.`);
    return;
  }

  api.ReadPatternTable = {
    readActionReaderPatternTable
  };

  console.log(`[ActionReader] Read Pattern Table registered to module API for "${moduleId}".`);
}
