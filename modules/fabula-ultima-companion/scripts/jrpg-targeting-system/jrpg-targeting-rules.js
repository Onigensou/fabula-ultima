// ============================================
// JRPG Targeting System - Rules
// File: jrpg-targeting-rules.js
// Foundry VTT V12
// ============================================

import {
  ALLOWED_DISPOSITIONS,
  DISPOSITIONS,
  MODES,
  NOTIFICATIONS,
  TARGET_CATEGORIES
} from "./jrpg-targeting-constants.js";

import { createJRPGTargetingDebugger } from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("Rules");

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function fillTemplate(template, replacements = {}) {
  let output = String(template ?? "");
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, String(value));
  }
  return output;
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (typeof value[Symbol.iterator] === "function") return Array.from(value);
  return [value];
}

function getTokenUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function getTokenName(token) {
  return token?.name ?? token?.document?.name ?? token?.actor?.name ?? "(Unknown Token)";
}

function normalizeAllowedTargetUuidSet(allowedTargetTokenUuids = []) {
  return new Set(
    toArray(allowedTargetTokenUuids)
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
  );
}

function isTokenInAllowedUuidSet(token, allowedUuidSet = new Set()) {
  if (!(allowedUuidSet instanceof Set) || allowedUuidSet.size <= 0) return true;
  const tokenUuid = getTokenUuid(token);
  if (!tokenUuid) return false;
  return allowedUuidSet.has(String(tokenUuid));
}

function getCategoryLabel(category) {
  switch (category) {
    case TARGET_CATEGORIES.ALLY:
      return "ally";
    case TARGET_CATEGORIES.ENEMY:
      return "enemy";
    case TARGET_CATEGORIES.CREATURE:
    default:
      return "creature";
  }
}

/* -------------------------------------------- */
/* Disposition helpers                          */
/* -------------------------------------------- */

export function getJRPGTokenDisposition(token) {
  return token?.document?.disposition ?? token?._token?.document?.disposition ?? null;
}

export function getJRPGSourceDisposition({
  sourceToken = null,
  sourceDisposition = null
} = {}) {
  if (Number.isFinite(sourceDisposition)) return sourceDisposition;

  const fromToken = getJRPGTokenDisposition(sourceToken);
  if (Number.isFinite(fromToken)) return fromToken;

  return null;
}

export function getJRPGAllowedDispositionsForCategory(
  category = TARGET_CATEGORIES.CREATURE,
  {
    sourceToken = null,
    sourceDisposition = null
  } = {}
) {
  const resolvedSourceDisposition = getJRPGSourceDisposition({
    sourceToken,
    sourceDisposition
  });

  // Keep creature broad and unchanged.
  if (category === TARGET_CATEGORIES.CREATURE) {
    const allowed = ALLOWED_DISPOSITIONS?.[category];
    return Array.isArray(allowed) ? [...allowed] : [];
  }

  // If source is unknown, preserve old behavior.
  if (!Number.isFinite(resolvedSourceDisposition)) {
    const allowed = ALLOWED_DISPOSITIONS?.[category];
    return Array.isArray(allowed) ? [...allowed] : [];
  }

  // Relative ally / enemy logic:
  // Friendly caster:
  //   Ally  = Friendly side
  //   Enemy = Hostile side
  //
  // Hostile caster:
  //   Ally  = Hostile side
  //   Enemy = Friendly side
  //
  // Neutral and Secret are preserved in both buckets
  // to stay close to your current loose behavior.
  if (category === TARGET_CATEGORIES.ALLY) {
    if (resolvedSourceDisposition === DISPOSITIONS.HOSTILE) {
      return [DISPOSITIONS.HOSTILE, DISPOSITIONS.NEUTRAL, DISPOSITIONS.SECRET];
    }

    if (resolvedSourceDisposition === DISPOSITIONS.FRIENDLY) {
      return [DISPOSITIONS.FRIENDLY, DISPOSITIONS.NEUTRAL, DISPOSITIONS.SECRET];
    }
  }

  if (category === TARGET_CATEGORIES.ENEMY) {
    if (resolvedSourceDisposition === DISPOSITIONS.HOSTILE) {
      return [DISPOSITIONS.FRIENDLY, DISPOSITIONS.NEUTRAL, DISPOSITIONS.SECRET];
    }

    if (resolvedSourceDisposition === DISPOSITIONS.FRIENDLY) {
      return [DISPOSITIONS.HOSTILE, DISPOSITIONS.NEUTRAL, DISPOSITIONS.SECRET];
    }
  }

  // Safe fallback for Neutral / Secret source casters.
  const allowed = ALLOWED_DISPOSITIONS?.[category];
  return Array.isArray(allowed) ? [...allowed] : [];
}

export function isJRPGDispositionAllowedForCategory(
  disposition,
  category = TARGET_CATEGORIES.CREATURE,
  {
    sourceToken = null,
    sourceDisposition = null
  } = {}
) {
  const allowed = getJRPGAllowedDispositionsForCategory(category, {
    sourceToken,
    sourceDisposition
  });

  return allowed.includes(disposition);
}

export function isJRPGTokenEligibleForCategory(
  token,
  category = TARGET_CATEGORIES.CREATURE,
  {
    sourceToken = null,
    sourceDisposition = null
  } = {}
) {
  const disposition = getJRPGTokenDisposition(token);
  if (!Number.isFinite(disposition)) return false;

  return isJRPGDispositionAllowedForCategory(disposition, category, {
    sourceToken,
    sourceDisposition
  });
}

export function filterJRPGTokensByCategory(
  tokens,
  category = TARGET_CATEGORIES.CREATURE,
  {
    sourceToken = null,
    sourceDisposition = null
  } = {}
) {
  return toArray(tokens).filter((token) =>
    isJRPGTokenEligibleForCategory(token, category, {
      sourceToken,
      sourceDisposition
    })
  );
}

/* -------------------------------------------- */
/* Target collection helpers                    */
/* -------------------------------------------- */

export function normalizeJRPGTargetCollection(targets) {
  return toArray(targets).filter(Boolean);
}

export function countJRPGBasicTargets(targets) {
  return normalizeJRPGTargetCollection(targets).length;
}

export function hasJRPGTarget(targets, token) {
  const tokenUuid = getTokenUuid(token);
  if (!tokenUuid) return false;

  return normalizeJRPGTargetCollection(targets).some((entry) => getTokenUuid(entry) === tokenUuid);
}

/* -------------------------------------------- */
/* Count / mode helpers                         */
/* -------------------------------------------- */

export function getJRPGRequiredTargetCount(parsedTargeting) {
  return Number.isFinite(parsedTargeting?.minTargets) ? parsedTargeting.minTargets : 0;
}

export function getJRPGMaxTargetCount(parsedTargeting) {
  return Number.isFinite(parsedTargeting?.maxTargets) ? parsedTargeting.maxTargets : null;
}

export function doesJRPGModeAutoSelectAll(parsedTargeting) {
  return (
    parsedTargeting?.mode === MODES.ALL ||
    parsedTargeting?.mode === MODES.SELF ||
    parsedTargeting?.autoSelectAll === true
  );
}

export function doesJRPGModeAllowManualSelection(parsedTargeting) {
  if (parsedTargeting?.mode === MODES.NONE) return false;
  return !doesJRPGModeAutoSelectAll(parsedTargeting);
}

/* -------------------------------------------- */
/* Scene token helpers                          */
/* -------------------------------------------- */

export function getJRPGEligibleSceneTokens({
  sceneTokens = [],
  parsedTargeting = null,
  sourceToken = null,
  sourceDisposition = null,
  allowedTargetTokenUuids = []
} = {}) {
  const category = parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE;

  const byCategory = filterJRPGTokensByCategory(sceneTokens, category, {
    sourceToken,
    sourceDisposition
  });

  const allowedUuidSet = normalizeAllowedTargetUuidSet(allowedTargetTokenUuids);
  if (allowedUuidSet.size <= 0) return byCategory;

  return byCategory.filter((token) => isTokenInAllowedUuidSet(token, allowedUuidSet));
}

/* -------------------------------------------- */
/* Click validation                             */
/* -------------------------------------------- */

export function validateJRPGTargetAttempt({
  parsedTargeting = null,
  currentTargets = [],
  candidateToken = null,
  sourceToken = null,
  sourceDisposition = null,
  allowedTargetTokenUuids = []
} = {}) {
  const runId = dbg.makeRunId("VALIDATE-TARGET");
  const parsed = parsedTargeting ?? {};
  const category = parsed?.category ?? TARGET_CATEGORIES.CREATURE;
  const current = normalizeJRPGTargetCollection(currentTargets);
  const currentCount = current.length;
  const maxTargets = getJRPGMaxTargetCount(parsed);
  const isAlreadyTargeted = hasJRPGTarget(current, candidateToken);
  const resolvedSourceDisposition = getJRPGSourceDisposition({
    sourceToken,
    sourceDisposition
  });
  const allowedUuidSet = normalizeAllowedTargetUuidSet(allowedTargetTokenUuids);

  dbg.logRun(runId, "START", {
    mode: parsed?.mode,
    category,
    currentCount,
    maxTargets,
    candidate: getTokenName(candidateToken),
    candidateDisposition: getJRPGTokenDisposition(candidateToken),
    source: getTokenName(sourceToken),
    sourceDisposition: resolvedSourceDisposition,
    allowedWhitelistCount: allowedUuidSet.size,
    isAlreadyTargeted
  });

  if (!candidateToken) {
    const result = {
      ok: false,
      code: "NO_TOKEN",
      notification: "No token selected."
    };
    dbg.warnRun(runId, "BLOCK", result);
    return result;
  }

  if (!doesJRPGModeAllowManualSelection(parsed)) {
    const result = {
      ok: false,
      code: "MANUAL_SELECTION_DISABLED",
      notification: "Manual target selection is disabled for this targeting mode."
    };
    dbg.warnRun(runId, "BLOCK", result);
    return result;
  }

    if (!isTokenInAllowedUuidSet(candidateToken, allowedUuidSet)) {
    const result = {
      ok: false,
      code: "NOT_IN_ALLOWED_LIST",
      notification: "That target is not valid for this effect."
    };
    dbg.warnRun(runId, "BLOCK", result);
    return result;
  }

  if (!isJRPGTokenEligibleForCategory(candidateToken, category, {
    sourceToken,
    sourceDisposition: resolvedSourceDisposition
  })) {
    const result = {
      ok: false,
      code: "INVALID_TARGET_TYPE",
      notification: fillTemplate(NOTIFICATIONS.INVALID_TARGET_TYPE, {
        category: getCategoryLabel(category)
      })
    };
    dbg.warnRun(runId, "BLOCK", result);
    return result;
  }

  // Untargeting an already-targeted token is always allowed.
  if (isAlreadyTargeted) {
    const result = {
      ok: true,
      code: "ALLOW_UNTARGET",
      action: "untarget",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  if (Number.isFinite(maxTargets) && currentCount >= maxTargets) {
    const result = {
      ok: false,
      code: "LIMIT_EXCEEDED",
      notification: fillTemplate(NOTIFICATIONS.LIMIT_EXCEEDED, {
        max: maxTargets
      })
    };
    dbg.warnRun(runId, "BLOCK", result);
    return result;
  }

  const result = {
    ok: true,
    code: "ALLOW_TARGET",
    action: "target",
    notification: null
  };

  dbg.logRun(runId, "ALLOW", result);
  return result;
}

/* -------------------------------------------- */
/* Confirm validation                           */
/* -------------------------------------------- */

export function validateJRPGTargetConfirmation({
  parsedTargeting = null,
  selectedTargets = [],
  eligibleSceneTokens = []
} = {}) {
  const runId = dbg.makeRunId("VALIDATE-CONFIRM");
  const parsed = parsedTargeting ?? {};
  const mode = parsed?.mode ?? MODES.FREE;
  const selected = normalizeJRPGTargetCollection(selectedTargets);
  const selectedCount = selected.length;
  const eligible = normalizeJRPGTargetCollection(eligibleSceneTokens);
  const eligibleCount = eligible.length;
  const required = getJRPGRequiredTargetCount(parsed);
  const maxTargets = getJRPGMaxTargetCount(parsed);
  const category = parsed?.category ?? TARGET_CATEGORIES.CREATURE;

  dbg.logRun(runId, "START", {
    mode,
    category,
    selectedCount,
    eligibleCount,
    required,
    maxTargets,
    acceptsZero: parsed?.acceptsZero
  });

    if (mode === MODES.NONE) {
    const result = {
      ok: true,
      code: "CONFIRM_NONE_OK",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  if (mode === MODES.SELF) {
    if (selectedCount !== 1) {
      const result = {
        ok: false,
        code: "SELF_REQUIRED",
        notification: "This action requires the self target to be locked."
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    const result = {
      ok: true,
      code: "CONFIRM_SELF_OK",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  if (mode === MODES.ALL) {
    if (eligibleCount <= 0) {
      const result = {
        ok: false,
        code: "NO_VALID_TARGETS",
        notification: fillTemplate(NOTIFICATIONS.NO_VALID_TARGETS, {
          category: getCategoryLabel(category)
        })
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    if (selectedCount !== eligibleCount) {
      const result = {
        ok: false,
        code: "ALL_TARGETS_REQUIRED",
        notification: `This action requires all valid ${getCategoryLabel(category)} targets to be selected.`
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    const result = {
      ok: true,
      code: "CONFIRM_ALL_OK",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  if (mode === MODES.EXACT) {
    if (selectedCount !== required) {
      const result = {
        ok: false,
        code: "EXACT_REQUIRED",
        notification: fillTemplate(NOTIFICATIONS.EXACT_REQUIRED, {
          required
        })
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    const result = {
      ok: true,
      code: "CONFIRM_EXACT_OK",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  if (mode === MODES.UP_TO) {
    if (Number.isFinite(maxTargets) && selectedCount > maxTargets) {
      const result = {
        ok: false,
        code: "LIMIT_EXCEEDED",
        notification: fillTemplate(NOTIFICATIONS.LIMIT_EXCEEDED, {
          max: maxTargets
        })
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    if (!parsed?.acceptsZero && selectedCount <= 0) {
      const result = {
        ok: false,
        code: "MIN_REQUIRED",
        notification: "At least 1 target is required."
      };
      dbg.warnRun(runId, "BLOCK", result);
      return result;
    }

    const result = {
      ok: true,
      code: "CONFIRM_UP_TO_OK",
      notification: null
    };
    dbg.logRun(runId, "ALLOW", result);
    return result;
  }

  // Free mode
  const result = {
    ok: true,
    code: "CONFIRM_FREE_OK",
    notification: null
  };
  dbg.logRun(runId, "ALLOW", result);
  return result;
}

/* -------------------------------------------- */
/* Auto-select helpers                          */
/* -------------------------------------------- */

export function getJRPGAutoSelectedTargets({
  parsedTargeting = null,
  sceneTokens = [],
  sourceToken = null,
  sourceDisposition = null
} = {}) {
  const runId = dbg.makeRunId("AUTOSELECT");
  const parsed = parsedTargeting ?? {};
  const resolvedSourceDisposition = getJRPGSourceDisposition({
    sourceToken,
    sourceDisposition
  });

  dbg.logRun(runId, "START", {
    mode: parsed?.mode,
    category: parsed?.category,
    sceneTokenCount: normalizeJRPGTargetCollection(sceneTokens).length,
    source: getTokenName(sourceToken),
    sourceDisposition: resolvedSourceDisposition
  });

  if (parsed?.mode === MODES.NONE) {
  dbg.logRun(runId, "SKIP", { reason: "None mode does not target anything." });
  return [];
}

  if (!doesJRPGModeAutoSelectAll(parsed)) {
    dbg.logRun(runId, "SKIP", { reason: "Mode does not auto-select all." });
    return [];
  }

  if (parsed?.mode === MODES.SELF) {
    dbg.logRun(runId, "SKIP", { reason: "Self mode target is resolved by session." });
    return [];
  }

  const result = getJRPGEligibleSceneTokens({
    sceneTokens,
    parsedTargeting: parsed,
    sourceToken,
    sourceDisposition: resolvedSourceDisposition
  });

  dbg.logRun(runId, "RESULT", {
    count: result.length,
    names: result.map((t) => getTokenName(t))
  });

  return result;
}

/* -------------------------------------------- */
/* Summary helpers                              */
/* -------------------------------------------- */

export function buildJRPGTargetRulesSummary(parsedTargeting = null) {
  const parsed = parsedTargeting ?? {};
  const mode = parsed?.mode ?? MODES.FREE;
  const category = parsed?.category ?? TARGET_CATEGORIES.CREATURE;

  return {
    mode,
    category,
    required: getJRPGRequiredTargetCount(parsed),
    max: getJRPGMaxTargetCount(parsed),
    autoSelectAll: doesJRPGModeAutoSelectAll(parsed),
    manualSelectionAllowed: doesJRPGModeAllowManualSelection(parsed),
    acceptsZero: Boolean(parsed?.acceptsZero)
  };
}

export default {
  getJRPGTokenDisposition,
  getJRPGSourceDisposition,
  getJRPGAllowedDispositionsForCategory,
  isJRPGDispositionAllowedForCategory,
  isJRPGTokenEligibleForCategory,
  filterJRPGTokensByCategory,
  normalizeJRPGTargetCollection,
  countJRPGBasicTargets,
  hasJRPGTarget,
  getJRPGRequiredTargetCount,
  getJRPGMaxTargetCount,
  doesJRPGModeAutoSelectAll,
  doesJRPGModeAllowManualSelection,
  getJRPGEligibleSceneTokens,
  validateJRPGTargetAttempt,
  validateJRPGTargetConfirmation,
  getJRPGAutoSelectedTargets,
  buildJRPGTargetRulesSummary
};
