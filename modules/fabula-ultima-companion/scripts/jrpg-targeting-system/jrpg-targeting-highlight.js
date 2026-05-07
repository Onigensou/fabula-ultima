// ============================================
// JRPG Targeting System - Highlight / Dim Helper
// File: jrpg-targeting-highlight.js
// Foundry VTT V12
// ============================================

import { createJRPGTargetingDebugger } from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("Highlight");

/* -------------------------------------------- */
/* Local runtime constants                      */
/* -------------------------------------------- */

const HIGHLIGHT_GLOBAL_KEY = "__ONI_JRPG_TARGETING_HIGHLIGHT__";

const DEFAULTS = Object.freeze({
  enabled: true,

  // Tokens not in the eligible list will be dimmed.
  tokenDimEnabled: true,
  tokenDimBrightness: 0.35,
  tokenDesaturate: true,

  // Optional map dim.
  backgroundDimEnabled: true,
  backgroundBrightness: 0.5,

  // Keep source token fully visible even if it somehow is not
  // in the eligible token list.
  alwaysKeepSourceVisible: true
});

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function cloneFiltersArray(filters) {
  return Array.isArray(filters) ? [...filters] : [];
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (typeof value?.[Symbol.iterator] === "function") return Array.from(value);
  return [value];
}

function compactArray(value) {
  return toArray(value).filter(Boolean);
}

function getTokenUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function getTokenName(token) {
  return token?.name ?? token?.document?.name ?? token?.actor?.name ?? "(Unknown Token)";
}

function getTokenMesh(token) {
  return token?.mesh ?? null;
}

function getBackgroundMesh() {
  return canvas?.primary?.background ?? null;
}

function getVisibleSceneTokens() {
  return compactArray(canvas?.tokens?.placeables).filter((token) => {
    if (!token?.visible) return false;
    if (token?.document?.hidden) return false;
    return true;
  });
}

function mergeConfig(config = {}) {
  return {
    ...DEFAULTS,
    ...(config || {})
  };
}

function buildDimFilter({
  brightness = DEFAULTS.tokenDimBrightness,
  desaturate = DEFAULTS.tokenDesaturate
} = {}) {
  const filter = new PIXI.filters.ColorMatrixFilter();

  if (desaturate) {
    filter.desaturate();
  }

  filter.brightness(brightness, false);

  return filter;
}

function buildBackgroundDimFilter({
  brightness = DEFAULTS.backgroundBrightness
} = {}) {
  const filter = new PIXI.filters.ColorMatrixFilter();
  filter.brightness(brightness, false);
  return filter;
}

function ensureHighlightState() {
  if (!globalThis[HIGHLIGHT_GLOBAL_KEY]) {
    globalThis[HIGHLIGHT_GLOBAL_KEY] = {
      active: false,
      sessionId: null,
      config: mergeConfig(),

      originalTokenFilters: new Map(),
      originalBackgroundFilters: null,

      dimmedTokenUuids: new Set(),
      eligibleTokenUuids: new Set(),
      sourceTokenUuid: null
    };

    dbg.log("STATE CREATED");
  }

  return globalThis[HIGHLIGHT_GLOBAL_KEY];
}

function getHighlightState() {
  return ensureHighlightState();
}

function resetHighlightState() {
  const state = ensureHighlightState();

  state.active = false;
  state.sessionId = null;
  state.config = mergeConfig();

  state.originalTokenFilters = new Map();
  state.originalBackgroundFilters = null;

  state.dimmedTokenUuids = new Set();
  state.eligibleTokenUuids = new Set();
  state.sourceTokenUuid = null;

  return state;
}

function shouldKeepTokenVisible(token, {
  eligibleUuidSet = new Set(),
  sourceTokenUuid = null,
  config = DEFAULTS
} = {}) {
  const tokenUuid = getTokenUuid(token);
  if (!tokenUuid) return false;

  if (eligibleUuidSet.has(tokenUuid)) return true;
  if (config.alwaysKeepSourceVisible && sourceTokenUuid && tokenUuid === sourceTokenUuid) return true;

  return false;
}

/* -------------------------------------------- */
/* Public state helpers                         */
/* -------------------------------------------- */

export function isJRPGTargetingHighlightActive() {
  return Boolean(getHighlightState().active);
}

export function getJRPGTargetingHighlightSnapshot() {
  const state = getHighlightState();

  return {
    active: Boolean(state.active),
    sessionId: state.sessionId ?? null,
    sourceTokenUuid: state.sourceTokenUuid ?? null,
    eligibleTokenUuids: Array.from(state.eligibleTokenUuids ?? []),
    dimmedTokenUuids: Array.from(state.dimmedTokenUuids ?? []),
    config: { ...(state.config || {}) }
  };
}

/* -------------------------------------------- */
/* Core apply / clear                           */
/* -------------------------------------------- */

export async function clearJRPGTargetingHighlight({
  reason = "manual_clear",
  runId = ""
} = {}) {
  const state = getHighlightState();
  const localRunId = runId || dbg.makeRunId("CLEAR");

  dbg.logRun(localRunId, "CLEAR START", {
    reason,
    active: state.active,
    dimmedCount: state.dimmedTokenUuids.size,
    eligibleCount: state.eligibleTokenUuids.size
  });

  // Restore token filters
  for (const [tokenUuid, record] of state.originalTokenFilters.entries()) {
    try {
      const mesh = record?.mesh ?? null;
      const originalFilters = cloneFiltersArray(record?.filters);

      if (mesh) {
        mesh.filters = originalFilters;
      }
    } catch (err) {
      dbg.errorRun(localRunId, "RESTORE TOKEN FILTERS FAILED", {
        tokenUuid,
        record,
        err
      });
    }
  }

  // Restore background filters
  try {
    const background = getBackgroundMesh();
    if (background && state.originalBackgroundFilters !== null) {
      background.filters = cloneFiltersArray(state.originalBackgroundFilters);
    }
  } catch (err) {
    dbg.errorRun(localRunId, "RESTORE BACKGROUND FILTERS FAILED", err);
  }

  resetHighlightState();

  dbg.logRun(localRunId, "CLEAR END");
  return true;
}

export async function applyJRPGTargetingHighlight({
  sessionId = null,
  eligibleTokens = [],
  sourceToken = null,
  config = {},
  runId = ""
} = {}) {
  const localRunId = runId || dbg.makeRunId("APPLY");
  const mergedConfig = mergeConfig(config);

  dbg.logRun(localRunId, "APPLY START", {
    sessionId,
    config: mergedConfig,
    requestedEligibleCount: compactArray(eligibleTokens).length,
    requestedEligibleNames: compactArray(eligibleTokens).map(getTokenName),
    sourceToken: getTokenName(sourceToken)
  });

  if (!mergedConfig.enabled) {
    dbg.logRun(localRunId, "SKIP - FEATURE DISABLED");
    await clearJRPGTargetingHighlight({
      reason: "disabled_config",
      runId: localRunId
    });
    return false;
  }

  // Always clear first so we never stack dim filters.
  await clearJRPGTargetingHighlight({
    reason: "reapply_before_apply",
    runId: localRunId
  });

  const state = getHighlightState();
  const sceneTokens = getVisibleSceneTokens();
  const finalEligibleTokens = compactArray(eligibleTokens);
  const eligibleUuidSet = new Set(finalEligibleTokens.map(getTokenUuid).filter(Boolean));
  const sourceTokenUuid = getTokenUuid(sourceToken);

  state.active = true;
  state.sessionId = sessionId ?? null;
  state.config = mergedConfig;
  state.eligibleTokenUuids = new Set(eligibleUuidSet);
  state.sourceTokenUuid = sourceTokenUuid ?? null;

  dbg.logRun(localRunId, "SCENE SNAPSHOT", {
    sceneTokenCount: sceneTokens.length,
    sceneTokenNames: sceneTokens.map(getTokenName),
    eligibleCount: eligibleUuidSet.size,
    sourceTokenUuid
  });

  if (mergedConfig.tokenDimEnabled) {
    for (const token of sceneTokens) {
      const tokenUuid = getTokenUuid(token);
      const mesh = getTokenMesh(token);

      if (!tokenUuid || !mesh) {
        dbg.warnRun(localRunId, "SKIP TOKEN - Missing uuid or mesh", {
          token: getTokenName(token),
          tokenUuid,
          hasMesh: Boolean(mesh)
        });
        continue;
      }

      if (shouldKeepTokenVisible(token, {
        eligibleUuidSet,
        sourceTokenUuid,
        config: mergedConfig
      })) {
        dbg.logRun(localRunId, "KEEP TOKEN VISIBLE", {
          token: getTokenName(token),
          tokenUuid
        });
        continue;
      }

      try {
        const originalFilters = cloneFiltersArray(mesh.filters);
        const dimFilter = buildDimFilter({
          brightness: mergedConfig.tokenDimBrightness,
          desaturate: mergedConfig.tokenDesaturate
        });

        state.originalTokenFilters.set(tokenUuid, {
          tokenUuid,
          tokenName: getTokenName(token),
          mesh,
          filters: originalFilters
        });

        mesh.filters = [...originalFilters, dimFilter];
        state.dimmedTokenUuids.add(tokenUuid);

        dbg.logRun(localRunId, "DIM TOKEN APPLIED", {
          token: getTokenName(token),
          tokenUuid,
          originalFilterCount: originalFilters.length
        });
      } catch (err) {
        dbg.errorRun(localRunId, "DIM TOKEN FAILED", {
          token: getTokenName(token),
          tokenUuid,
          err
        });
      }
    }
  }

  if (mergedConfig.backgroundDimEnabled) {
    try {
      const background = getBackgroundMesh();

      if (background) {
        const originalFilters = cloneFiltersArray(background.filters);
        const dimFilter = buildBackgroundDimFilter({
          brightness: mergedConfig.backgroundBrightness
        });

        state.originalBackgroundFilters = originalFilters;
        background.filters = [...originalFilters, dimFilter];

        dbg.logRun(localRunId, "BACKGROUND DIM APPLIED", {
          originalFilterCount: originalFilters.length
        });
      } else {
        dbg.warnRun(localRunId, "BACKGROUND DIM SKIPPED - No background mesh");
      }
    } catch (err) {
      dbg.errorRun(localRunId, "BACKGROUND DIM FAILED", err);
    }
  }

  dbg.logRun(localRunId, "APPLY END", getJRPGTargetingHighlightSnapshot());
  return true;
}

/* -------------------------------------------- */
/* Refresh helper                               */
/* -------------------------------------------- */

export async function refreshJRPGTargetingHighlight({
  sessionId = null,
  eligibleTokens = [],
  sourceToken = null,
  config = {},
  runId = ""
} = {}) {
  const localRunId = runId || dbg.makeRunId("REFRESH");

  dbg.logRun(localRunId, "REFRESH START", {
    sessionId,
    eligibleCount: compactArray(eligibleTokens).length,
    eligibleNames: compactArray(eligibleTokens).map(getTokenName)
  });

  return await applyJRPGTargetingHighlight({
    sessionId,
    eligibleTokens,
    sourceToken,
    config,
    runId: localRunId
  });
}

/* -------------------------------------------- */
/* Emergency reset                              */
/* -------------------------------------------- */

export async function forceClearJRPGTargetingHighlight() {
  const runId = dbg.makeRunId("FORCE-CLEAR");

  dbg.warnRun(runId, "FORCE CLEAR REQUESTED");
  return await clearJRPGTargetingHighlight({
    reason: "force_clear",
    runId
  });
}

export default {
  isJRPGTargetingHighlightActive,
  getJRPGTargetingHighlightSnapshot,
  applyJRPGTargetingHighlight,
  refreshJRPGTargetingHighlight,
  clearJRPGTargetingHighlight,
  forceClearJRPGTargetingHighlight
};
