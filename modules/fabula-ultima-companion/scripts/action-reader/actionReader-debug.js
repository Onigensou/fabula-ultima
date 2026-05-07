/* ========================================================================== *
 * ActionReader Debug
 * -------------------------------------------------------------------------- *
 * Module-compatible debug helper library for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-debug.js
 *
 * Usage in other module scripts:
 *   import { ActionReaderDebug as ARD } from "./actionReader-debug.js";
 *
 * Optional registration:
 *   import { registerActionReaderDebug } from "./actionReader-debug.js";
 *   Hooks.once("ready", () => registerActionReaderDebug("your-module-id"));
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";

export const ACTION_READER_DEBUG_VERSION = "1.0.0";

const DEFAULT_DEBUG_CONFIG = Object.freeze({
  enabled: true,
  verbose: true,
  showNotifications: false,
  collapseGroups: true,
  includeTimestamps: true,
  includeStageReports: true,
  dryRun: false
});

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function timestampString() {
  try {
    return new Date().toLocaleTimeString();
  } catch (_err) {
    return "";
  }
}

export const ActionReaderDebug = {
  version: ACTION_READER_DEBUG_VERSION,
  defaults: DEFAULT_DEBUG_CONFIG,

  /* ---------------------------------------------------------------------- */
  /* Config helpers                                                         */
  /* ---------------------------------------------------------------------- */

  createConfig(overrides = {}) {
    return foundry.utils.mergeObject(
      foundry.utils.deepClone(DEFAULT_DEBUG_CONFIG),
      overrides ?? {},
      { inplace: false }
    );
  },

  getConfig(context = null, overrides = null) {
    const base = this.createConfig();

    const contextConfig = context?.debug?.config ?? {};
    const merged = foundry.utils.mergeObject(base, contextConfig, { inplace: false });

    if (overrides && typeof overrides === "object") {
      return foundry.utils.mergeObject(merged, overrides, { inplace: false });
    }

    return merged;
  },

  applyConfig(context, overrides = {}) {
    if (!context) return this.createConfig(overrides);

    context.debug ??= {};
    context.debug.config = this.getConfig(context, overrides);
    return context.debug.config;
  },

  isEnabled(context = null, overrides = null) {
    return Boolean(this.getConfig(context, overrides).enabled);
  },

  isVerbose(context = null, overrides = null) {
    const cfg = this.getConfig(context, overrides);
    return Boolean(cfg.enabled && cfg.verbose);
  },

  isDryRun(context = null, overrides = null) {
    return Boolean(this.getConfig(context, overrides).dryRun);
  },

  /* ---------------------------------------------------------------------- */
  /* Formatting helpers                                                     */
  /* ---------------------------------------------------------------------- */

  getStageLabel(stage = "Unknown") {
    return `[ActionReader][${AR.toString(stage, "Unknown")}]`;
  },

  getLevelLabel(level = "log") {
    return AR.toString(level, "log").toUpperCase();
  },

  buildPrefix(stage = "Unknown", level = "log", context = null, overrides = null) {
    const cfg = this.getConfig(context, overrides);
    const parts = [this.getStageLabel(stage), this.getLevelLabel(level)];

    if (cfg.includeTimestamps) {
      const time = timestampString();
      if (time) parts.push(time);
    }

    return parts.join(" ");
  },

  toLogPayload(data) {
    if (data === undefined) return {};
    return data;
  },

  /* ---------------------------------------------------------------------- */
  /* Notification helpers                                                   */
  /* ---------------------------------------------------------------------- */

  notify(message, type = "info", context = null, overrides = null) {
    const cfg = this.getConfig(context, overrides);
    if (!cfg.showNotifications) return;

    const text = AR.toString(message, "");
    if (!text) return;
    if (!ui?.notifications) return;

    if (type === "warn" || type === "warning") {
      ui.notifications.warn(text);
      return;
    }

    if (type === "error") {
      ui.notifications.error(text);
      return;
    }

    ui.notifications.info(text);
  },

  /* ---------------------------------------------------------------------- */
  /* Console helpers                                                        */
  /* ---------------------------------------------------------------------- */

  log(stage, message, data = undefined, context = null, overrides = null) {
    if (!this.isEnabled(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "log", context, overrides);
    const payload = this.toLogPayload(data);

    if (data === undefined) console.log(prefix, message);
    else console.log(prefix, message, payload);
  },

  info(stage, message, data = undefined, context = null, overrides = null) {
    if (!this.isEnabled(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "info", context, overrides);
    const payload = this.toLogPayload(data);

    if (data === undefined) console.info(prefix, message);
    else console.info(prefix, message, payload);
  },

  warn(stage, message, data = undefined, context = null, overrides = null) {
    if (!this.isEnabled(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "warn", context, overrides);
    const payload = this.toLogPayload(data);

    if (data === undefined) console.warn(prefix, message);
    else console.warn(prefix, message, payload);

    this.notify(`${this.getStageLabel(stage)} ${message}`, "warn", context, overrides);
  },

  error(stage, message, data = undefined, context = null, overrides = null) {
    if (!this.isEnabled(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "error", context, overrides);
    const payload = this.toLogPayload(data);

    if (data === undefined) console.error(prefix, message);
    else console.error(prefix, message, payload);

    this.notify(`${this.getStageLabel(stage)} ${message}`, "error", context, overrides);
  },

  table(stage, label, rows, context = null, overrides = null) {
    if (!this.isVerbose(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "table", context, overrides);
    console.log(prefix, label);

    if (Array.isArray(rows) && rows.length) {
      console.table(rows);
    } else {
      console.log(prefix, "No table rows to display.");
    }
  },

  dir(stage, label, data, context = null, overrides = null) {
    if (!this.isVerbose(context, overrides)) return;

    const prefix = this.buildPrefix(stage, "dir", context, overrides);
    console.log(prefix, label);
    console.dir(data);
  },

  groupStart(stage, title = "Stage Start", context = null, overrides = null) {
    if (!this.isEnabled(context, overrides)) return false;

    const cfg = this.getConfig(context, overrides);
    const prefix = this.buildPrefix(stage, "group", context, overrides);
    const finalTitle = `${prefix} ${AR.toString(title, "")}`.trim();

    if (cfg.collapseGroups && console.groupCollapsed) {
      console.groupCollapsed(finalTitle);
      return true;
    }

    if (console.group) {
      console.group(finalTitle);
      return true;
    }

    console.log(finalTitle);
    return false;
  },

  groupEnd(groupWasOpened = false) {
    if (!groupWasOpened) return;
    if (console.groupEnd) console.groupEnd();
  },

  /* ---------------------------------------------------------------------- */
  /* Context helpers                                                        */
  /* ---------------------------------------------------------------------- */

  ensureDebugState(context) {
    if (!context) return null;

    context.debug ??= {};
    context.debug.stageReports ??= [];
    context.debug.runtime ??= {
      stages: {}
    };

    if (!context.debug.config) {
      context.debug.config = this.createConfig();
    }

    return context.debug;
  },

  beginStage(context, stage, details = {}, overrides = null) {
    this.ensureDebugState(context);

    const stageKey = AR.toString(stage, "Unknown");
    const runtime = context?.debug?.runtime?.stages ?? {};
    const start = nowMs();
    const groupOpened = this.groupStart(stageKey, "Begin", context, overrides);

    runtime[stageKey] = {
      startedAtMs: start,
      groupOpened
    };

    if (context?.debug?.runtime) {
      context.debug.runtime.stages = runtime;
    }

    if (this.isEnabled(context, overrides)) {
      this.log(stageKey, "Stage begin.", details, context, overrides);
    }

    return context;
  },

  endStage(context, stage, details = {}, overrides = null) {
    this.ensureDebugState(context);

    const stageKey = AR.toString(stage, "Unknown");
    const runtime = context?.debug?.runtime?.stages?.[stageKey] ?? {};
    const end = nowMs();
    const durationMs = runtime.startedAtMs ? Math.round((end - runtime.startedAtMs) * 100) / 100 : null;

    const payload = {
      ...details,
      durationMs
    };

    if (this.isEnabled(context, overrides)) {
      this.log(stageKey, "Stage end.", payload, context, overrides);
    }

    this.groupEnd(Boolean(runtime.groupOpened));

    if (context?.debug?.runtime?.stages?.[stageKey]) {
      context.debug.runtime.stages[stageKey].endedAtMs = end;
      context.debug.runtime.stages[stageKey].durationMs = durationMs;
    }

    return context;
  },

  recordStage(context, stage, data = {}, overrides = null) {
    if (!context) return context;

    AR.addStageReport(context, stage, data);

    if (this.getConfig(context, overrides).includeStageReports) {
      this.log(stage, "Stage report recorded.", data, context, overrides);
    }

    return context;
  },

  addWarning(context, stage, message, extra = {}, overrides = null) {
    AR.addWarning(context, message, { stage, ...extra });
    this.warn(stage, message, extra, context, overrides);
    return context;
  },

  addError(context, stage, message, extra = {}, overrides = null) {
    AR.addError(context, message, { stage, ...extra });
    this.error(stage, message, extra, context, overrides);
    return context;
  },

  summarizeContext(context) {
    return {
      ok: Boolean(context?.ok),
      errorCount: Array.isArray(context?.errors) ? context.errors.length : 0,
      warningCount: Array.isArray(context?.warnings) ? context.warnings.length : 0,
      performer: {
        actorName: context?.performer?.actor?.name ?? null,
        tokenName: context?.performer?.token?.name ?? null,
        source: context?.performer?.source ?? null
      },
      counts: {
        patternRows: Array.isArray(context?.patternRows) ? context.patternRows.length : 0,
        evaluatedRows: Array.isArray(context?.evaluatedRows) ? context.evaluatedRows.length : 0,
        actionCandidates: Array.isArray(context?.actionCandidates) ? context.actionCandidates.length : 0,
        targetCandidates: Array.isArray(context?.targetCandidates) ? context.targetCandidates.length : 0,
        chosenTargets: Array.isArray(context?.chosenTargets) ? context.chosenTargets.length : 0
      },
      chosenAction: context?.chosenAction?.item?.name ?? context?.chosenAction?.name ?? null,
      finalText: context?.finalText ?? ""
    };
  },

  dumpContext(context, stage = "ContextDump", overrides = null) {
    if (!this.isVerbose(context, overrides)) return;

    const summary = this.summarizeContext(context);
    this.groupStart(stage, "Context Summary", context, overrides);
    this.log(stage, "Summary", summary, context, overrides);
    this.dir(stage, "Full Context", context, context, overrides);
    this.groupEnd(true);
  },

  /* ---------------------------------------------------------------------- */
  /* Convenience helpers                                                    */
  /* ---------------------------------------------------------------------- */

  makeStageTableFromRows(rows, mapper) {
    if (!Array.isArray(rows)) return [];
    if (typeof mapper !== "function") return rows;
    return rows.map((row, index) => mapper(row, index));
  }
};

/* ------------------------------------------------------------------------ */
/* Optional module API registration                                         */
/* ------------------------------------------------------------------------ */

export function registerActionReaderDebug(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderDebug called without a valid moduleId.");
    return;
  }

  const module = game.modules.get(moduleId);
  if (!module) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Debug.`);
    return;
  }

  module.api ??= {};
  module.api.ActionReader ??= {};
  module.api.ActionReader.Debug = ActionReaderDebug;

  console.log(`[ActionReader] Debug registered to module API for "${moduleId}".`);
}
