// ============================================
// JRPG Targeting System - Debug Helpers
// File: jrpg-targeting-debug.js
// Foundry VTT V12
// ============================================

import { DEBUG } from "./jrpg-targeting-constants.js";

let DEBUG_ENABLED = Boolean(DEBUG?.ENABLED);

/**
 * Read current runtime debug state.
 * This is separate from constants so you can toggle it on/off live.
 */
export function isJRPGTargetingDebugEnabled() {
  return DEBUG_ENABLED;
}

/**
 * Set current runtime debug state.
 * Example:
 *   setJRPGTargetingDebugEnabled(false);
 */
export function setJRPGTargetingDebugEnabled(enabled) {
  DEBUG_ENABLED = Boolean(enabled);
  console.info(`${DEBUG.PREFIX}[Debug] Debug ${DEBUG_ENABLED ? "ENABLED" : "DISABLED"}`);
  return DEBUG_ENABLED;
}

/**
 * Build a consistent ONI-style prefix.
 * Example:
 *   [ONI][JRPGTargeting][Parser]
 *   [ONI][JRPGTargeting][Session][TGT-123]
 */
export function makeJRPGTargetingPrefix(scope = "Core", runId = "") {
  const safeScope = String(scope || "Core").trim();
  const safeRunId = String(runId || "").trim();

  return safeRunId
    ? `${DEBUG.PREFIX}[${safeScope}][${safeRunId}]`
    : `${DEBUG.PREFIX}[${safeScope}]`;
}

/**
 * Create a simple timestamp-based run id.
 * Example result:
 *   PARSE-1772894375877-ab12c
 */
export function makeJRPGTargetingRunId(tag = "RUN") {
  const safeTag = String(tag || "RUN").trim().toUpperCase().replace(/\s+/g, "-");
  const rand = Math.random().toString(36).slice(2, 7);
  return `${safeTag}-${Date.now()}-${rand}`;
}

/**
 * Base logger methods.
 * log/warn are gated by debug toggle.
 * error always prints because real errors should stay visible.
 */
export function jrpgTargetingLog(scope = "Core", runId = "", ...args) {
  if (!DEBUG_ENABLED) return;
  console.log(makeJRPGTargetingPrefix(scope, runId), ...args);
}

export function jrpgTargetingWarn(scope = "Core", runId = "", ...args) {
  if (!DEBUG_ENABLED) return;
  console.warn(makeJRPGTargetingPrefix(scope, runId), ...args);
}

export function jrpgTargetingError(scope = "Core", runId = "", ...args) {
  console.error(makeJRPGTargetingPrefix(scope, runId), ...args);
}

/**
 * Optional helper for grouped logs.
 */
export function jrpgTargetingGroup(scope = "Core", runId = "", label = "GROUP") {
  if (!DEBUG_ENABLED) return;
  console.group(`${makeJRPGTargetingPrefix(scope, runId)} ${label}`);
}

export function jrpgTargetingGroupCollapsed(scope = "Core", runId = "", label = "GROUP") {
  if (!DEBUG_ENABLED) return;
  console.groupCollapsed(`${makeJRPGTargetingPrefix(scope, runId)} ${label}`);
}

export function jrpgTargetingGroupEnd() {
  if (!DEBUG_ENABLED) return;
  console.groupEnd();
}

/**
 * Scoped debugger factory.
 * Usage:
 *   const dbg = createJRPGTargetingDebugger("Parser");
 *   const runId = dbg.makeRunId("PARSE");
 *   dbg.log("START", payload);
 */
export function createJRPGTargetingDebugger(scope = "Core") {
  const safeScope = String(scope || "Core").trim();

  return {
    scope: safeScope,

    isEnabled() {
      return isJRPGTargetingDebugEnabled();
    },

    setEnabled(enabled) {
      return setJRPGTargetingDebugEnabled(enabled);
    },

    makePrefix(runId = "") {
      return makeJRPGTargetingPrefix(safeScope, runId);
    },

    makeRunId(tag = safeScope) {
      return makeJRPGTargetingRunId(tag);
    },

    log(...args) {
      jrpgTargetingLog(safeScope, "", ...args);
    },

    warn(...args) {
      jrpgTargetingWarn(safeScope, "", ...args);
    },

    error(...args) {
      jrpgTargetingError(safeScope, "", ...args);
    },

    logRun(runId = "", ...args) {
      jrpgTargetingLog(safeScope, runId, ...args);
    },

    warnRun(runId = "", ...args) {
      jrpgTargetingWarn(safeScope, runId, ...args);
    },

    errorRun(runId = "", ...args) {
      jrpgTargetingError(safeScope, runId, ...args);
    },

    group(runId = "", label = "GROUP") {
      jrpgTargetingGroup(safeScope, runId, label);
    },

    groupCollapsed(runId = "", label = "GROUP") {
      jrpgTargetingGroupCollapsed(safeScope, runId, label);
    },

    groupEnd() {
      jrpgTargetingGroupEnd();
    }
  };
}

export default {
  isJRPGTargetingDebugEnabled,
  setJRPGTargetingDebugEnabled,
  makeJRPGTargetingPrefix,
  makeJRPGTargetingRunId,
  jrpgTargetingLog,
  jrpgTargetingWarn,
  jrpgTargetingError,
  jrpgTargetingGroup,
  jrpgTargetingGroupCollapsed,
  jrpgTargetingGroupEnd,
  createJRPGTargetingDebugger
};
