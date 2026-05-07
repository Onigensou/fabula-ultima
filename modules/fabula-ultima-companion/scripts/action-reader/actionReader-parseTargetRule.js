/* ========================================================================== *
 * ActionReader Parse Target Rule
 * -------------------------------------------------------------------------- *
 * Module-compatible target rule parser for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-parseTargetRule.js
 *
 * Purpose:
 *   Parse the chosen action's target text into a normalized targetRule object.
 *
 * Supported patterns:
 *   - Self
 *   - All Creature / All Enemy / All Ally / All Neutral / All Secret
 *   - X Creature / X Enemy / X Ally / X Neutral / X Secret
 *   - Up to X Creature / Up to X Enemy / Up to X Ally / Up to X Neutral / Up to X Secret
 *   - Number words also supported: One, Two, Three, etc.
 *
 * Fallback:
 *   - Unknown text => single-target random creature fallback
 *
 * Usage:
 *   import {
 *     parseActionReaderTargetRule,
 *     registerActionReaderParseTargetRule
 *   } from "./actionReader-parseTargetRule.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_PARSE_TARGET_RULE_VERSION = "1.0.0";
export const ACTION_READER_PARSE_TARGET_RULE_STAGE = "ParseTargetRule";

const RELATION_ALIASES = Object.freeze({
  creature: "creature",
  creatures: "creature",

  ally: "ally",
  allies: "ally",

  enemy: "enemy",
  enemies: "enemy",

  neutral: "neutral",
  neutrals: "neutral",

  secret: "secret",
  secrets: "secret",

  self: "self"
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

function getChosenAction(context) {
  return context?.chosenAction ?? null;
}

function getTargetTextFromContext(context) {
  const chosenAction = getChosenAction(context);

  return (
    chosenAction?.skillTarget ??
    AR.getActionTargetText(chosenAction?.item) ??
    ""
  );
}

function normalizeRelation(value) {
  const normalized = AR.normalizeText(value);
  return RELATION_ALIASES[normalized] ?? normalized;
}

function relationLabel(relation) {
  switch (relation) {
    case "self": return "Self";
    case "creature": return "Creature";
    case "ally": return "Ally";
    case "enemy": return "Enemy";
    case "neutral": return "Neutral";
    case "secret": return "Secret";
    default: return AR.titleCase(AR.toString(relation, "").replace(/_/g, " "));
  }
}

function createTargetRule({
  rawText = "",
  normalizedText = "",
  parseMode = "fallback",
  relation = "creature",
  count = 1,
  minCount = 1,
  maxCount = 1,
  isAll = false,
  isSelf = false,
  isUpTo = false,
  recognized = false,
  fallbackUsed = false,
  parseReason = ""
} = {}) {
  return {
    rawText,
    normalizedText,

    parseMode,
    relation,
    relationLabel: relationLabel(relation),

    count: AR.toInteger(count, 1),
    minCount: AR.toInteger(minCount, 1),
    maxCount: AR.toInteger(maxCount, 1),

    isAll: Boolean(isAll),
    isSelf: Boolean(isSelf),
    isUpTo: Boolean(isUpTo),

    recognized: Boolean(recognized),
    fallbackUsed: Boolean(fallbackUsed),
    parseReason: AR.toString(parseReason, ""),

    description: buildRuleDescription({
      relation,
      count,
      minCount,
      maxCount,
      isAll,
      isSelf,
      isUpTo
    })
  };
}

function buildRuleDescription({
  relation = "creature",
  count = 1,
  minCount = 1,
  maxCount = 1,
  isAll = false,
  isSelf = false,
  isUpTo = false
} = {}) {
  const label = relationLabel(relation);

  if (isSelf) return "Target Self";
  if (isAll) return `Target All ${label}`;

  if (isUpTo) {
    return `Target Up to ${AR.toInteger(maxCount, 1)} ${label}`;
  }

  return `Target ${AR.toInteger(count, 1)} ${label}`;
}

function buildFallbackRule(rawText, reason) {
  const normalizedText = AR.normalizeText(rawText);

  return createTargetRule({
    rawText,
    normalizedText,
    parseMode: "fallback",
    relation: "creature",
    count: 1,
    minCount: 1,
    maxCount: 1,
    isAll: false,
    isSelf: false,
    isUpTo: false,
    recognized: false,
    fallbackUsed: true,
    parseReason: reason || "No known target pattern matched. Using single random creature fallback."
  });
}

function parseSelfRule(rawText) {
  const normalizedText = AR.normalizeText(rawText);
  if (normalizedText !== "self") return null;

  return createTargetRule({
    rawText,
    normalizedText,
    parseMode: "self",
    relation: "self",
    count: 1,
    minCount: 1,
    maxCount: 1,
    isAll: false,
    isSelf: true,
    isUpTo: false,
    recognized: true,
    fallbackUsed: false,
    parseReason: 'Matched exact "Self" target rule.'
  });
}

function parseAllRule(rawText) {
  const normalizedText = AR.normalizeText(rawText);
  const match = normalizedText.match(/^all\s+([a-z]+)$/i);
  if (!match) return null;

  const relation = normalizeRelation(match[1]);
  if (!["creature", "ally", "enemy", "neutral", "secret"].includes(relation)) {
    return null;
  }

  return createTargetRule({
    rawText,
    normalizedText,
    parseMode: "all",
    relation,
    count: -1,
    minCount: 0,
    maxCount: -1,
    isAll: true,
    isSelf: false,
    isUpTo: false,
    recognized: true,
    fallbackUsed: false,
    parseReason: `Matched "All ${relationLabel(relation)}" target rule.`
  });
}

function parseUpToRule(rawText) {
  const normalizedText = AR.normalizeText(rawText);
  const match = normalizedText.match(/^up to\s+([a-z0-9]+)\s+([a-z]+)$/i);
  if (!match) return null;

  const countToken = match[1];
  const relation = normalizeRelation(match[2]);
  const parsedCount = AR.parseNumberWordOrDigit(countToken);

  if (!Number.isFinite(parsedCount)) return null;
  if (!["creature", "ally", "enemy", "neutral", "secret"].includes(relation)) {
    return null;
  }

  const safeCount = Math.max(1, Math.trunc(parsedCount));

  return createTargetRule({
    rawText,
    normalizedText,
    parseMode: "upTo",
    relation,
    count: safeCount,
    minCount: 1,
    maxCount: safeCount,
    isAll: false,
    isSelf: false,
    isUpTo: true,
    recognized: true,
    fallbackUsed: false,
    parseReason: `Matched "Up to ${safeCount} ${relationLabel(relation)}" target rule.`
  });
}

function parseExactCountRule(rawText) {
  const normalizedText = AR.normalizeText(rawText);
  const match = normalizedText.match(/^([a-z0-9]+)\s+([a-z]+)$/i);
  if (!match) return null;

  const countToken = match[1];
  const relation = normalizeRelation(match[2]);
  const parsedCount = AR.parseNumberWordOrDigit(countToken);

  if (!Number.isFinite(parsedCount)) return null;
  if (!["creature", "ally", "enemy", "neutral", "secret"].includes(relation)) {
    return null;
  }

  const safeCount = Math.max(1, Math.trunc(parsedCount));

  return createTargetRule({
    rawText,
    normalizedText,
    parseMode: "exact",
    relation,
    count: safeCount,
    minCount: safeCount,
    maxCount: safeCount,
    isAll: false,
    isSelf: false,
    isUpTo: false,
    recognized: true,
    fallbackUsed: false,
    parseReason: `Matched exact-count target rule: ${safeCount} ${relationLabel(relation)}.`
  });
}

function parseRuleText(rawText) {
  const cleaned = AR.toString(rawText, "").trim();
  if (!cleaned) {
    return buildFallbackRule(rawText, "Target text is blank. Using single random creature fallback.");
  }

  return (
    parseSelfRule(cleaned) ||
    parseAllRule(cleaned) ||
    parseUpToRule(cleaned) ||
    parseExactCountRule(cleaned) ||
    buildFallbackRule(cleaned, `Could not parse target text "${cleaned}". Using single random creature fallback.`)
  );
}

function summarizeTargetRule(rule) {
  return {
    parseMode: rule?.parseMode ?? null,
    relation: rule?.relation ?? null,
    count: rule?.count ?? null,
    minCount: rule?.minCount ?? null,
    maxCount: rule?.maxCount ?? null,
    isAll: Boolean(rule?.isAll),
    isSelf: Boolean(rule?.isSelf),
    isUpTo: Boolean(rule?.isUpTo),
    recognized: Boolean(rule?.recognized),
    fallbackUsed: Boolean(rule?.fallbackUsed),
    rawText: rule?.rawText ?? "",
    description: rule?.description ?? ""
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function parseActionReaderTargetRule(context, options = {}) {
  const stage = ACTION_READER_PARSE_TARGET_RULE_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      hasOverrideTargetText: !AR.isBlank(options?.targetText)
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const chosenAction = getChosenAction(context);
    if (!chosenAction) {
      ARD.addError(context, stage, "ParseTargetRule requires a chosen action first.", {
        hasChosenAction: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const rawTargetText = !AR.isBlank(options?.targetText)
      ? AR.toString(options.targetText, "")
      : getTargetTextFromContext(context);

    const parsedRule = parseRuleText(rawTargetText);

    context.targetRule = parsedRule;
    context.targetRuleMeta = {
      chosenActionName: chosenAction?.name ?? chosenAction?.item?.name ?? null,
      targetText: rawTargetText,
      recognized: Boolean(parsedRule?.recognized),
      fallbackUsed: Boolean(parsedRule?.fallbackUsed)
    };

    ARD.recordStage(context, stage, summarizeTargetRule(parsedRule));

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Parsed target rule",
        [summarizeTargetRule(parsedRule)],
        context
      );
    }

    if (parsedRule.fallbackUsed) {
      ARD.addWarning(context, stage, "Target rule parser used fallback behavior.", {
        chosenActionName: chosenAction?.name ?? null,
        rawTargetText,
        parseReason: parsedRule.parseReason
      });
    }

    ARD.endStage(context, stage, {
      ok: true,
      parseMode: parsedRule.parseMode,
      relation: parsedRule.relation,
      count: parsedRule.count,
      fallbackUsed: parsedRule.fallbackUsed
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while parsing target rule.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][ParseTargetRule] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderParseTargetRule(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderParseTargetRule called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Parse Target Rule.`);
    return;
  }

  api.ParseTargetRule = {
    parseActionReaderTargetRule
  };

  console.log(`[ActionReader] Parse Target Rule registered to module API for "${moduleId}".`);
}
