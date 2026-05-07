// ============================================
// JRPG Targeting System - UI Tuner Bridge
// File: jrpg-targeting-ui-tuner-bridge.js
// Foundry VTT V12
// ============================================

import {
  MODULE_ID,
  UI
} from "./jrpg-targeting-constants.js";

import {
  createJRPGTargetingDebugger
} from "./jrpg-targeting-debug.js";

import {
  getActiveJRPGTargetingUI
} from "./jrpg-targeting-ui.js";

const dbg = createJRPGTargetingDebugger("UITunerBridge");

const BRIDGE_GLOBAL_KEY = "__ONI_JRPG_TARGETING_UI_TUNER_BRIDGE__";
const TUNER_GLOBAL_KEY = "__ONI_JRPG_TARGET_UI_TUNER__";
const TUNER_STORAGE_KEY = "oni.jrpgTargetUiTuner.v1";
const BRIDGE_API_NAME = "JRPGTargetingUITunerBridge";

/* -------------------------------------------- */
/* Internal state                               */
/* -------------------------------------------- */

function ensureBridgeState() {
  if (!globalThis[BRIDGE_GLOBAL_KEY]) {
    globalThis[BRIDGE_GLOBAL_KEY] = {
      installed: false,
      patched: false,
      originalRequestTargeting: null,
      originalStartLocalTargeting: null
    };

    dbg.log("BRIDGE STATE CREATED");
  }

  return globalThis[BRIDGE_GLOBAL_KEY];
}

function getBridgeState() {
  return ensureBridgeState();
}

/* -------------------------------------------- */
/* Helpers                                      */
/* -------------------------------------------- */

function clampNumber(value, fallback, min = -99999, max = 99999) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clonePlain(value) {
  try {
    return foundry?.utils?.deepClone
      ? foundry.utils.deepClone(value)
      : JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

function getJRPGTargetingAPI() {
  return game.modules.get(MODULE_ID)?.api?.JRPGTargeting ?? null;
}

function getDefaults() {
  return {
    topX: Math.round((window.innerWidth - 340) / 2),
    topY: 14,
    controlsX: Math.max(20, window.innerWidth - 250),
    controlsY: Math.max(20, window.innerHeight - 82),

    topWidth: 340,
    topScale: 1,
    controlsScale: 1,
    controlsGap: 10,

    previewCount: 3,

    spawnMs: 220,
    despawnMs: 180,
    idlePx: 3,
    idleMs: 1800,
    idleEnabled: true,

    zIndexTop: UI.TUNING.zIndexTop,
    zIndexControls: UI.TUNING.zIndexControls
  };
}

function normalizeSettings(input = {}) {
  const defaults = getDefaults();
  const s = {
    ...defaults,
    ...(input || {})
  };

  return {
    topX: clampNumber(s.topX, defaults.topX),
    topY: clampNumber(s.topY, defaults.topY),

    controlsX: clampNumber(s.controlsX, defaults.controlsX),
    controlsY: clampNumber(s.controlsY, defaults.controlsY),

    topWidth: clampNumber(s.topWidth, defaults.topWidth, 120, 1200),
    topScale: clampNumber(s.topScale, defaults.topScale, 0.2, 4),
    controlsScale: clampNumber(s.controlsScale, defaults.controlsScale, 0.2, 4),
    controlsGap: clampNumber(s.controlsGap, defaults.controlsGap, 0, 100),

    previewCount: clampNumber(s.previewCount, defaults.previewCount, 0, 99),

    spawnMs: clampNumber(s.spawnMs, defaults.spawnMs, 0, 10000),
    despawnMs: clampNumber(s.despawnMs, defaults.despawnMs, 0, 10000),
    idlePx: clampNumber(s.idlePx, defaults.idlePx, 0, 100),
    idleMs: clampNumber(s.idleMs, defaults.idleMs, 100, 20000),
    idleEnabled: Boolean(s.idleEnabled),

    zIndexTop: clampNumber(s.zIndexTop, defaults.zIndexTop, 1, 999999),
    zIndexControls: clampNumber(s.zIndexControls, defaults.zIndexControls, 1, 999999)
  };
}

function normalizeSettingsForRuntime(input = {}) {
  const s = normalizeSettings(input);

  return {
    topX: s.topX,
    topY: s.topY,
    controlsX: s.controlsX,
    controlsY: s.controlsY,

    topWidth: s.topWidth,
    topScale: s.topScale,
    controlsScale: s.controlsScale,
    controlsGap: s.controlsGap,

    spawnMs: s.spawnMs,
    despawnMs: s.despawnMs,
    idlePx: s.idlePx,
    idleMs: s.idleMs,
    idleEnabled: s.idleEnabled,

    zIndexTop: s.zIndexTop,
    zIndexControls: s.zIndexControls
  };
}

function getSettingsSnippet(settings = null) {
  const s = normalizeSettings(settings ?? loadSavedSettings());

  return `const targetUiTuning = ${JSON.stringify({
    topX: s.topX,
    topY: s.topY,
    controlsX: s.controlsX,
    controlsY: s.controlsY,
    topWidth: s.topWidth,
    topScale: s.topScale,
    controlsScale: s.controlsScale,
    controlsGap: s.controlsGap,
    previewCount: s.previewCount,
    spawnMs: s.spawnMs,
    despawnMs: s.despawnMs,
    idlePx: s.idlePx,
    idleMs: s.idleMs,
    idleEnabled: s.idleEnabled
  }, null, 2)};`;
}

/* -------------------------------------------- */
/* Storage                                      */
/* -------------------------------------------- */

export function loadSavedSettings() {
  const runId = dbg.makeRunId("LOAD");

  try {
    const raw = localStorage.getItem(TUNER_STORAGE_KEY);
    if (!raw) {
      const fallback = normalizeSettings(getDefaults());
      dbg.logRun(runId, "NO SAVED SETTINGS - USING DEFAULTS", fallback);
      return fallback;
    }

    const parsed = JSON.parse(raw);
    const normalized = normalizeSettings(parsed);

    dbg.logRun(runId, "SETTINGS LOADED", normalized);
    return normalized;
  } catch (err) {
    const fallback = normalizeSettings(getDefaults());
    dbg.errorRun(runId, "LOAD FAILED - USING DEFAULTS", err);
    return fallback;
  }
}

export function saveSettings(settings = {}) {
  const runId = dbg.makeRunId("SAVE");
  const normalized = normalizeSettings(settings);

  try {
    localStorage.setItem(TUNER_STORAGE_KEY, JSON.stringify(normalized, null, 2));
    dbg.logRun(runId, "SETTINGS SAVED", normalized);
    ui.notifications?.info?.("JRPG targeting UI tuning saved locally in this browser.");
    return normalized;
  } catch (err) {
    dbg.errorRun(runId, "SAVE FAILED", err);
    ui.notifications?.error?.("Failed to save JRPG targeting UI tuning.");
    return null;
  }
}

export function clearSavedSettings() {
  const runId = dbg.makeRunId("CLEAR");

  try {
    localStorage.removeItem(TUNER_STORAGE_KEY);
    dbg.logRun(runId, "SETTINGS CLEARED");
    ui.notifications?.info?.("JRPG targeting UI tuning cleared from this browser.");
    return true;
  } catch (err) {
    dbg.errorRun(runId, "CLEAR FAILED", err);
    ui.notifications?.error?.("Failed to clear JRPG targeting UI tuning.");
    return false;
  }
}

/* -------------------------------------------- */
/* Merge / apply                                */
/* -------------------------------------------- */

export function getSettingsForRequest(extraSettings = {}) {
  const saved = loadSavedSettings();
  const merged = normalizeSettings({
    ...saved,
    ...(extraSettings || {})
  });

  dbg.log("REQUEST SETTINGS BUILT", {
    saved,
    extraSettings,
    merged
  });

  return normalizeSettingsForRuntime(merged);
}

export function applySettingsToActiveUI(settings = {}) {
  const runId = dbg.makeRunId("APPLY-ACTIVE");
  const activeUI = getActiveJRPGTargetingUI();

  if (!activeUI) {
    dbg.warnRun(runId, "NO ACTIVE UI");
    return false;
  }

  const merged = getSettingsForRequest(settings);
  activeUI.applyLayout(merged);

  dbg.logRun(runId, "APPLIED TO ACTIVE UI", merged);
  return true;
}

export function applySavedSettingsToActiveUI() {
  return applySettingsToActiveUI(loadSavedSettings());
}

export function captureActiveUISettings() {
  const runId = dbg.makeRunId("CAPTURE");
  const activeUI = getActiveJRPGTargetingUI();

  if (!activeUI) {
    dbg.warnRun(runId, "NO ACTIVE UI");
    return null;
  }

  const captured = normalizeSettings({
    ...getDefaults(),
    ...(activeUI.settings || {})
  });

  dbg.logRun(runId, "CAPTURED ACTIVE UI SETTINGS", captured);
  return captured;
}

export function saveActiveUISettings() {
  const captured = captureActiveUISettings();
  if (!captured) return null;
  return saveSettings(captured);
}

/* -------------------------------------------- */
/* Tuner integration                            */
/* -------------------------------------------- */

export function getLiveTunerState() {
  return globalThis[TUNER_GLOBAL_KEY] ?? null;
}

export function getLiveTunerSettings() {
  const live = getLiveTunerState();
  if (!live?.settings) return null;
  return normalizeSettings(live.settings);
}

export function adoptLiveTunerSettings() {
  const runId = dbg.makeRunId("ADOPT-LIVE");
  const liveSettings = getLiveTunerSettings();

  if (!liveSettings) {
    dbg.warnRun(runId, "NO LIVE TUNER SETTINGS FOUND");
    return null;
  }

  const saved = saveSettings(liveSettings);
  applySavedSettingsToActiveUI();

  dbg.logRun(runId, "LIVE TUNER SETTINGS ADOPTED", saved);
  return saved;
}

/* -------------------------------------------- */
/* API patching                                 */
/* -------------------------------------------- */

function patchJRPGTargetingAPI() {
  const runId = dbg.makeRunId("PATCH");
  const state = getBridgeState();

  if (state.patched) {
    dbg.logRun(runId, "ALREADY PATCHED");
    return true;
  }

  const api = getJRPGTargetingAPI();
  if (!api?.requestTargeting || !api?.startLocalTargeting) {
    dbg.warnRun(runId, "JRPG TARGETING API NOT READY");
    return false;
  }

  state.originalRequestTargeting = api.requestTargeting.bind(api);
  state.originalStartLocalTargeting = api.startLocalTargeting.bind(api);

  api.requestTargeting = async function patchedRequestTargeting(options = {}) {
    const patchRunId = dbg.makeRunId("PATCH-REQUEST");
    const useSavedUITuning = options?.useSavedUITuning !== false;

    const mergedOptions = {
      ...options,
      uiSettings: useSavedUITuning
        ? getSettingsForRequest(options?.uiSettings || {})
        : (options?.uiSettings || {})
    };

    dbg.logRun(patchRunId, "PATCHED requestTargeting", {
      useSavedUITuning,
      originalOptions: options,
      mergedOptions
    });

    return await state.originalRequestTargeting(mergedOptions);
  };

  api.startLocalTargeting = async function patchedStartLocalTargeting(options = {}) {
    const patchRunId = dbg.makeRunId("PATCH-LOCAL");
    const useSavedUITuning = options?.useSavedUITuning !== false;

    const mergedOptions = {
      ...options,
      uiSettings: useSavedUITuning
        ? getSettingsForRequest(options?.uiSettings || {})
        : (options?.uiSettings || {})
    };

    dbg.logRun(patchRunId, "PATCHED startLocalTargeting", {
      useSavedUITuning,
      originalOptions: options,
      mergedOptions
    });

    return await state.originalStartLocalTargeting(mergedOptions);
  };

  state.patched = true;

  dbg.logRun(runId, "API PATCHED");
  return true;
}

function unpatchJRPGTargetingAPI() {
  const runId = dbg.makeRunId("UNPATCH");
  const state = getBridgeState();
  const api = getJRPGTargetingAPI();

  if (!state.patched || !api) {
    dbg.logRun(runId, "NOT PATCHED / API MISSING");
    return false;
  }

  if (state.originalRequestTargeting) {
    api.requestTargeting = state.originalRequestTargeting;
  }

  if (state.originalStartLocalTargeting) {
    api.startLocalTargeting = state.originalStartLocalTargeting;
  }

  state.originalRequestTargeting = null;
  state.originalStartLocalTargeting = null;
  state.patched = false;

  dbg.logRun(runId, "API UNPATCHED");
  return true;
}

/* -------------------------------------------- */
/* Public bridge API                            */
/* -------------------------------------------- */

function buildBridgeAPI() {
  return {
    storageKey: TUNER_STORAGE_KEY,

    getDefaults,
    normalizeSettings,
    normalizeSettingsForRuntime,

    loadSavedSettings,
    saveSettings,
    clearSavedSettings,

    getSettingsForRequest,
    getSettingsSnippet,

    applySettingsToActiveUI,
    applySavedSettingsToActiveUI,
    captureActiveUISettings,
    saveActiveUISettings,

    getLiveTunerState,
    getLiveTunerSettings,
    adoptLiveTunerSettings,

    patchJRPGTargetingAPI,
    unpatchJRPGTargetingAPI
  };
}

function installBridgeAPI() {
  const runId = dbg.makeRunId("INSTALL");
  const state = getBridgeState();

  if (state.installed) {
    dbg.logRun(runId, "ALREADY INSTALLED");
    return true;
  }

  const bridgeAPI = buildBridgeAPI();
  const module = game.modules.get(MODULE_ID);

  globalThis[BRIDGE_GLOBAL_KEY] = {
    ...getBridgeState(),
    api: bridgeAPI
  };

  if (module) {
    module.api = module.api || {};
    module.api[BRIDGE_API_NAME] = bridgeAPI;

    if (module.api.JRPGTargeting) {
      module.api.JRPGTargeting.uiTunerBridge = bridgeAPI;
    }
  }

  patchJRPGTargetingAPI();

  state.installed = true;

  dbg.logRun(runId, "BRIDGE INSTALLED", {
    moduleId: MODULE_ID,
    apiName: BRIDGE_API_NAME,
    storageKey: TUNER_STORAGE_KEY
  });

  return true;
}

/* -------------------------------------------- */
/* Foundry lifecycle                            */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  installBridgeAPI();
});

export default {
  loadSavedSettings,
  saveSettings,
  clearSavedSettings,
  getSettingsForRequest,
  getSettingsSnippet,
  applySettingsToActiveUI,
  applySavedSettingsToActiveUI,
  captureActiveUISettings,
  saveActiveUISettings,
  getLiveTunerState,
  getLiveTunerSettings,
  adoptLiveTunerSettings,
  patchJRPGTargetingAPI,
  unpatchJRPGTargetingAPI
};
