/**
 * emote-runtime.js
 * Fabula Ultima Companion - Emote System Runtime
 * Foundry VTT v12
 *
 * Purpose:
 * - Receive normalized emote play instructions
 * - Render the emote near the target token
 * - Use ONI Pseudo Animation as the primary multi-client transport
 * - Keep UI/render logic separate from backend permission logic
 *
 * Notes:
 * - This script does NOT decide permission.
 * - This script does NOT read hotkey config.
 * - This script expects a normalized instruction from Emote API / Resolver.
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_RUNTIME__
 *
 * API:
 *   FUCompanion.api.EmoteRuntime
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_RUNTIME__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const ACTIVE_SESSION_KEY = "__ONI_EMOTE_RUNTIME_ACTIVE__";

  const CFG = {
    // Easy tuning knobs
    DEFAULT_OFFSET_X: -40,
    DEFAULT_OFFSET_Y: -54,

    // Base scale at the reference grid size
    DEFAULT_SCALE: 1.3,

    // Dynamic scene/grid scaling
    DYNAMIC_GRID_SCALING_ENABLED: true,
    SCALE_REFERENCE_GRID_SIZE: 100,

    DEFAULT_FADE_IN_MS: 120,
    DEFAULT_HOLD_MS: 1200,
    DEFAULT_FADE_OUT_MS: 220,

    DEFAULT_Z_INDEX: 5500,
    DEFAULT_REPLACE_EXISTING: true,

    LOCAL_FALLBACK_ENABLED: true
  };

  globalThis[ACTIVE_SESSION_KEY] ??= new Map();

  function getDebug() {
    const dbg = globalThis.__ONI_EMOTE_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function asNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function deepClone(value) {
    try {
      return foundry.utils.deepClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function randomId(prefix = "emote") {
    const rand =
      foundry?.utils?.randomID?.(8)
      ?? Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now()}-${rand}`;
  }

  function getPseudoApi() {
    return game?.ONI?.pseudo?.play ? game.ONI.pseudo : null;
  }

  function getActiveSessionsMap() {
    return globalThis[ACTIVE_SESSION_KEY];
  }

  function getTokenSessionKey(tokenUuid) {
    return `token:${cleanString(tokenUuid) || "unknown"}`;
  }

  function normalizeInstruction(instruction = {}) {
    const tokenUuid =
      cleanString(instruction.tokenUuid)
      || cleanString(instruction.targetTokenUuid)
      || cleanString(instruction.casterTokenUuid)
      || "";

    const emoteUrl =
      cleanString(instruction.emoteUrl)
      || cleanString(instruction.url)
      || "";

    const useAbsolutePosition = instruction.useAbsolutePosition === true;

    const x =
      useAbsolutePosition && Number.isFinite(Number(instruction.x))
        ? Number(instruction.x)
        : null;

    const y =
      useAbsolutePosition && Number.isFinite(Number(instruction.y))
        ? Number(instruction.y)
        : null;

    const offsetX = asNumber(instruction.offsetX, CFG.DEFAULT_OFFSET_X);
    const offsetY = asNumber(instruction.offsetY, CFG.DEFAULT_OFFSET_Y);

    const scale = asNumber(instruction.scale, CFG.DEFAULT_SCALE);
    const fadeInMs = Math.max(0, asNumber(instruction.fadeInMs, CFG.DEFAULT_FADE_IN_MS));
    const holdMs = Math.max(0, asNumber(instruction.holdMs, CFG.DEFAULT_HOLD_MS));
    const fadeOutMs = Math.max(0, asNumber(instruction.fadeOutMs, CFG.DEFAULT_FADE_OUT_MS));
    const zIndex = asNumber(instruction.zIndex, CFG.DEFAULT_Z_INDEX);

    const replaceExisting =
      instruction.replaceExisting === undefined
        ? CFG.DEFAULT_REPLACE_EXISTING
        : !!instruction.replaceExisting;

    const tokenId = cleanString(instruction.tokenId) || null;
    const tokenName = cleanString(instruction.tokenName) || null;

    const actorId = cleanString(instruction.actorId) || null;
    const actorName = cleanString(instruction.actorName) || null;

    const userId = cleanString(instruction.userId) || game.user?.id || null;
    const userName = cleanString(instruction.userName) || game.user?.name || null;

    const meta = deepClone(instruction.meta ?? {});
    const runtimeId = cleanString(instruction.runtimeId) || randomId("emoteRuntime");

    return {
      runtimeId,
      tokenUuid,
      tokenId,
      tokenName,

      actorId,
      actorName,

      userId,
      userName,

      emoteUrl,
      useAbsolutePosition,
      x,
      y,
      offsetX,
      offsetY,

      scale,
      dynamicGridScalingEnabled:
        instruction.dynamicGridScalingEnabled === undefined
          ? !!CFG.DYNAMIC_GRID_SCALING_ENABLED
          : !!instruction.dynamicGridScalingEnabled,

      referenceGridSize: asNumber(
        instruction.referenceGridSize,
        CFG.SCALE_REFERENCE_GRID_SIZE
      ),

      fadeInMs,
      holdMs,
      fadeOutMs,
      zIndex,
      replaceExisting,

      meta
    };
  }

  function validateInstruction(instruction) {
    if (!instruction || typeof instruction !== "object") {
      return { ok: false, reason: "invalidInstructionObject" };
    }

    if (!hasText(instruction.emoteUrl)) {
      return { ok: false, reason: "missingEmoteUrl" };
    }

    if (!hasText(instruction.tokenUuid)) {
      return { ok: false, reason: "missingTokenUuid" };
    }

    return { ok: true, reason: "valid" };
  }

  function buildPseudoScriptSource() {
  return `
const { casterToken, params } = ctx;
if (!casterToken) throw new Error("Emote runtime needs casterToken");

const ACTIVE_KEY = "__ONI_EMOTE_RUNTIME_ACTIVE__";
globalThis[ACTIVE_KEY] ??= new Map();
const activeSessions = globalThis[ACTIVE_KEY];

const emoteUrl = String(params.emoteUrl ?? "").trim();
if (!emoteUrl) throw new Error("Emote runtime missing emoteUrl");

const tokenUuid = String(params.tokenUuid ?? casterToken.document?.uuid ?? "");
const registryKey = String(
  params.sessionKey ??
  (tokenUuid ? ("token:" + tokenUuid) : "token:unknown")
);

const replaceExisting = !!params.replaceExisting;

const baseOffsetX = Number(params.offsetX ?? -40);
const baseOffsetY = Number(params.offsetY ?? -54);
const useAbsolutePosition = params.useAbsolutePosition === true;

const forcedX =
  useAbsolutePosition && Number.isFinite(Number(params.x))
    ? Number(params.x)
    : null;

const forcedY =
  useAbsolutePosition && Number.isFinite(Number(params.y))
    ? Number(params.y)
    : null;

const baseScale = Number(params.scale ?? 1);

const dynamicGridScalingEnabled = params.dynamicGridScalingEnabled === true;
const referenceGridSize = Math.max(1, Number(params.referenceGridSize ?? 100));

const currentSceneGridSize = Math.max(
  1,
  Number(canvas?.scene?.grid?.size ?? canvas?.dimensions?.size ?? 100)
);

const gridScaleMultiplier = dynamicGridScalingEnabled
  ? (currentSceneGridSize / referenceGridSize)
  : 1;

const scale = baseScale * gridScaleMultiplier;

// Position should scale with the map too, otherwise the emote drifts too far away
// on smaller-grid scenes.
const offsetX = baseOffsetX * gridScaleMultiplier;
const offsetY = baseOffsetY * gridScaleMultiplier;

console.log("[ONI][EmoteRuntime] Dynamic scene adjustment", {
  dynamicGridScalingEnabled,
  referenceGridSize,
  currentSceneGridSize,
  gridScaleMultiplier,

  baseScale,
  finalScale: scale,

  baseOffsetX,
  baseOffsetY,
  finalOffsetX: offsetX,
  finalOffsetY: offsetY
});

const fadeInMs = Math.max(0, Number(params.fadeInMs ?? 120));
const holdMs = Math.max(0, Number(params.holdMs ?? 1200));
const fadeOutMs = Math.max(0, Number(params.fadeOutMs ?? 220));
const zIndex = Number(params.zIndex ?? 5500);

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
}

function getAnchorPoint() {
  const baseX = Number.isFinite(forcedX) ? forcedX : casterToken.center.x;
  const baseY = Number.isFinite(forcedY) ? forcedY : casterToken.center.y;
  return {
    x: baseX + offsetX,
    y: baseY + offsetY
  };
}

function makeEntry(sprite) {
  return {
    sprite,
    destroyed: false,
    tickers: new Set()
  };
}

function addTicker(entry, fn) {
  if (!canvas?.app?.ticker) return () => {};

  const wrapped = () => {
    if (entry.destroyed || !entry.sprite || entry.sprite.destroyed) {
      try { canvas.app.ticker.remove(wrapped); } catch (_) {}
      entry.tickers.delete(wrapped);
      return;
    }

    try {
      fn();
    } catch (_) {
      try { canvas.app.ticker.remove(wrapped); } catch (_) {}
      entry.tickers.delete(wrapped);
    }
  };

  entry.tickers.add(wrapped);
  canvas.app.ticker.add(wrapped);

  return () => {
    try { canvas.app.ticker.remove(wrapped); } catch (_) {}
    entry.tickers.delete(wrapped);
  };
}

function disposeEntry(entry) {
  if (!entry || entry.destroyed) return;
  entry.destroyed = true;

  for (const tickerFn of Array.from(entry.tickers)) {
    try { canvas.app.ticker.remove(tickerFn); } catch (_) {}
  }
  entry.tickers.clear();

  try {
    if (entry.sprite?.parent) {
      entry.sprite.parent.removeChild(entry.sprite);
    }
  } catch (_) {}

  try {
    if (entry.sprite && !entry.sprite.destroyed) {
      entry.sprite.destroy();
    }
  } catch (_) {}

  const current = activeSessions.get(registryKey);
  if (current === entry) {
    activeSessions.delete(registryKey);
  }
}

async function ensureVideoTexturePlayback(texture) {
  try {
    const baseTexture = texture?.baseTexture ?? null;
    const resource =
      baseTexture?.resource
      ?? texture?.resource
      ?? null;

    const source =
      resource?.source
      ?? resource?.sourceElement
      ?? null;

    if (!(source instanceof HTMLVideoElement)) return false;

    source.muted = true;
    source.loop = true;
    source.playsInline = true;

    try {
      source.currentTime = 0;
    } catch (_) {}

    try {
      await source.play();
    } catch (_) {
      // Some browsers can reject silently; keep going.
    }

    return true;
  } catch (_) {
    return false;
  }
}

function clearExistingIfNeeded() {
  if (!replaceExisting) return;
  const existing = activeSessions.get(registryKey);
  if (!existing) return;
  disposeEntry(existing);
}

function createSprite(texture) {
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.alpha = 0;
  sprite.scale.set(0.65 * scale);

  const pt = getAnchorPoint();
  sprite.x = pt.x;
  sprite.y = pt.y;
  sprite.zIndex = zIndex;

  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(sprite);
  canvas.stage.sortChildren();

  return sprite;
}

function tween(entry, {
  fromAlpha,
  toAlpha,
  fromScale,
  toScale,
  durationMs,
  easeFn
}) {
  return new Promise(resolve => {
    if (entry.destroyed || !entry.sprite || entry.sprite.destroyed) {
      resolve();
      return;
    }

    if (!canvas?.app?.ticker || durationMs <= 0) {
      if (!entry.destroyed && entry.sprite && !entry.sprite.destroyed) {
        entry.sprite.alpha = toAlpha;
        entry.sprite.scale.set(toScale);
        const pt = getAnchorPoint();
        entry.sprite.x = pt.x;
        entry.sprite.y = pt.y;
      }
      resolve();
      return;
    }

    const start = performance.now();
    let removeTicker = null;

    const step = () => {
      if (entry.destroyed || !entry.sprite || entry.sprite.destroyed) {
        removeTicker?.();
        resolve();
        return;
      }

      const raw = (performance.now() - start) / Math.max(1, durationMs);
      const t = Math.min(Math.max(raw, 0), 1);
      const e = easeFn(t);

      entry.sprite.alpha = fromAlpha + (toAlpha - fromAlpha) * e;

      const curScale = fromScale + (toScale - fromScale) * e;
      entry.sprite.scale.set(curScale);

      const pt = getAnchorPoint();
      entry.sprite.x = pt.x;
      entry.sprite.y = pt.y;

      if (t >= 1) {
        removeTicker?.();
        resolve();
      }
    };

    removeTicker = addTicker(entry, step);
    step();
  });
}

clearExistingIfNeeded();

const texture = await loadTexture(emoteUrl);
if (!texture) throw new Error("Failed to load emote texture: " + emoteUrl);

// Best-effort: if this is a WEBM/video texture, explicitly start playback
await ensureVideoTexturePlayback(texture);

const sprite = createSprite(texture);
const entry = makeEntry(sprite);
activeSessions.set(registryKey, entry);

// Keep the emote anchored beside the token while it plays.
const removeFollowTicker = addTicker(entry, () => {
  const pt = getAnchorPoint();
  entry.sprite.x = pt.x;
  entry.sprite.y = pt.y;
});

try {
  await tween(entry, {
    fromAlpha: 0,
    toAlpha: 1,
    fromScale: 0.65 * scale,
    toScale: 1.0 * scale,
    durationMs: fadeInMs,
    easeFn: easeOutCubic
  });

  if (holdMs > 0) {
    await waitMs(holdMs);
  }

  await tween(entry, {
    fromAlpha: 1,
    toAlpha: 0,
    fromScale: 1.0 * scale,
    toScale: 1.08 * scale,
    durationMs: fadeOutMs,
    easeFn: easeInCubic
  });
} finally {
  try { removeFollowTicker?.(); } catch (_) {}
  disposeEntry(entry);
}
  `.trim();
}

  function buildPseudoPayload(instruction) {
    const sessionKey = getTokenSessionKey(instruction.tokenUuid);

    return {
      scriptId: "oni.emote.show",
      scriptSource: buildPseudoScriptSource(),
      casterTokenUuid: instruction.tokenUuid,
      targetTokenUuids: [instruction.tokenUuid],
    params: {
        tokenUuid: instruction.tokenUuid,
        emoteUrl: instruction.emoteUrl,
        useAbsolutePosition: instruction.useAbsolutePosition === true,
        x: instruction.x,
        y: instruction.y,
        offsetX: instruction.offsetX,
        offsetY: instruction.offsetY,
        scale: instruction.scale,
        dynamicGridScalingEnabled: instruction.dynamicGridScalingEnabled === true,
        referenceGridSize: instruction.referenceGridSize,
        fadeInMs: instruction.fadeInMs,
        holdMs: instruction.holdMs,
        fadeOutMs: instruction.fadeOutMs,
        zIndex: instruction.zIndex,
        replaceExisting: instruction.replaceExisting,
        sessionKey: getTokenSessionKey(instruction.tokenUuid)
      },
      meta: {
        source: "EmoteSystem",
        runtimeId: instruction.runtimeId,
        tokenId: instruction.tokenId,
        tokenName: instruction.tokenName,
        actorId: instruction.actorId,
        actorName: instruction.actorName,
        userId: instruction.userId,
        userName: instruction.userName,
        ...deepClone(instruction.meta ?? {})
      }
    };
  }

  async function playViaPseudo(instruction) {
    const pseudo = getPseudoApi();
    if (!pseudo?.play) {
      return { ok: false, reason: "pseudoUnavailable" };
    }

    const payload = buildPseudoPayload(instruction);

    try {
      await pseudo.play(payload);

      DBG.groupCollapsed("Runtime", "Played emote via ONI Pseudo Animation", {
        runtimeId: instruction.runtimeId,
        tokenUuid: instruction.tokenUuid,
        tokenName: instruction.tokenName,
        actorName: instruction.actorName,
        emoteUrl: instruction.emoteUrl,
        offsetX: instruction.offsetX,
        offsetY: instruction.offsetY,
        holdMs: instruction.holdMs,
        fadeInMs: instruction.fadeInMs,
        fadeOutMs: instruction.fadeOutMs
      });

      return {
        ok: true,
        reason: "playedViaPseudo",
        transport: "pseudo",
        payload
      };
    } catch (err) {
      DBG.error("Runtime", "Pseudo play failed", {
        runtimeId: instruction.runtimeId,
        tokenUuid: instruction.tokenUuid,
        emoteUrl: instruction.emoteUrl,
        error: err?.message ?? err
      });

      return {
        ok: false,
        reason: "pseudoPlayFailed",
        transport: "pseudo",
        error: err
      };
    }
  }

  async function resolveTokenFromUuid(uuid) {
    if (!hasText(uuid) || typeof fromUuid !== "function") return null;

    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;

      if (doc?.documentName === "Token") return doc.object ?? null;
      if (doc?.documentName === "TokenDocument") return doc.object ?? null;

      if (doc?.token?.object) return doc.token.object;
      if (doc?.actor?.getActiveTokens) return doc.actor.getActiveTokens(true, true)?.[0] ?? null;

      return null;
    } catch {
      return null;
    }
  }

  async function playViaLocalFallback(instruction) {
    if (!CFG.LOCAL_FALLBACK_ENABLED) {
      return { ok: false, reason: "localFallbackDisabled", transport: "local" };
    }

    const token = await resolveTokenFromUuid(instruction.tokenUuid);
    if (!token) {
      DBG.warn("Runtime", "Local fallback failed because token could not be resolved", {
        tokenUuid: instruction.tokenUuid,
        runtimeId: instruction.runtimeId
      });

      return { ok: false, reason: "fallbackTokenNotFound", transport: "local" };
    }

    const pseudoLikeCtx = {
      casterToken: token,
            params: {
        tokenUuid: instruction.tokenUuid,
        emoteUrl: instruction.emoteUrl,
        useAbsolutePosition: instruction.useAbsolutePosition === true,
        x: instruction.x,
        y: instruction.y,
        offsetX: instruction.offsetX,
        offsetY: instruction.offsetY,
        scale: instruction.scale,
        dynamicGridScalingEnabled: instruction.dynamicGridScalingEnabled === true,
        referenceGridSize: instruction.referenceGridSize,
        fadeInMs: instruction.fadeInMs,
        holdMs: instruction.holdMs,
        fadeOutMs: instruction.fadeOutMs,
        zIndex: instruction.zIndex,
        replaceExisting: instruction.replaceExisting,
        sessionKey: getTokenSessionKey(instruction.tokenUuid)
      }
    };

    try {
      const fn = new Function("ctx", `"use strict"; return (async () => { ${buildPseudoScriptSource()} })();`);
      await fn(pseudoLikeCtx);

      DBG.verbose("Runtime", "Played emote via local fallback", {
        runtimeId: instruction.runtimeId,
        tokenUuid: instruction.tokenUuid,
        emoteUrl: instruction.emoteUrl
      });

      return { ok: true, reason: "playedViaLocalFallback", transport: "local" };
    } catch (err) {
      DBG.error("Runtime", "Local fallback play failed", {
        runtimeId: instruction.runtimeId,
        tokenUuid: instruction.tokenUuid,
        emoteUrl: instruction.emoteUrl,
        error: err?.message ?? err
      });

      return { ok: false, reason: "localFallbackFailed", transport: "local", error: err };
    }
  }

  async function playInstruction(rawInstruction = {}) {
    DBG.startTimer("emote-runtime-play", "Runtime", "Playing emote instruction");

    try {
      const instruction = normalizeInstruction(rawInstruction);
      const valid = validateInstruction(instruction);

      if (!valid.ok) {
        DBG.warn("Runtime", "playInstruction aborted because instruction was invalid", {
          runtimeId: instruction.runtimeId,
          reason: valid.reason,
          instruction
        });

        return {
          ok: false,
          reason: valid.reason,
          instruction
        };
      }

      const pseudoResult = await playViaPseudo(instruction);
      if (pseudoResult.ok) {
        return {
          ok: true,
          reason: pseudoResult.reason,
          transport: pseudoResult.transport,
          instruction,
          payload: pseudoResult.payload
        };
      }

      const fallbackResult = await playViaLocalFallback(instruction);
      if (fallbackResult.ok) {
        return {
          ok: true,
          reason: fallbackResult.reason,
          transport: fallbackResult.transport,
          instruction
        };
      }

      return {
        ok: false,
        reason: fallbackResult.reason || pseudoResult.reason || "playFailed",
        transport: fallbackResult.transport || pseudoResult.transport || null,
        instruction,
        pseudoResult,
        fallbackResult
      };
    } finally {
      DBG.endTimer("emote-runtime-play", "Runtime", "Finished emote instruction");
    }
  }

  async function stopTokenEmote(tokenUuid) {
    const cleanUuid = cleanString(tokenUuid);
    if (!cleanUuid) return { ok: false, reason: "missingTokenUuid" };

    const key = getTokenSessionKey(cleanUuid);
    const sessions = getActiveSessionsMap();
    const existing = sessions.get(key);

    if (!existing) {
      return { ok: true, reason: "noActiveSession" };
    }

    try {
      if (existing.ticker && canvas?.app?.ticker) {
        try { canvas.app.ticker.remove(existing.ticker); } catch (_) {}
      }

      if (existing.sprite?.parent) {
        try { existing.sprite.parent.removeChild(existing.sprite); } catch (_) {}
      }

      if (existing.sprite) {
        try { existing.sprite.destroy(); } catch (_) {}
      }

      sessions.delete(key);

      DBG.verbose("Runtime", "Stopped active token emote session", {
        tokenUuid: cleanUuid,
        sessionKey: key
      });

      return { ok: true, reason: "stopped" };
    } catch (err) {
      DBG.warn("Runtime", "stopTokenEmote failed", {
        tokenUuid: cleanUuid,
        error: err?.message ?? err
      });

      return { ok: false, reason: "stopFailed", error: err };
    }
  }

  function getSnapshot() {
    const sessions = getActiveSessionsMap();

    return {
      installed: true,
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      pseudoAvailable: !!getPseudoApi(),
      localFallbackEnabled: !!CFG.LOCAL_FALLBACK_ENABLED,
      activeSessionCount: sessions.size,
      activeSessionKeys: Array.from(sessions.keys()),

    defaults: {
        offsetX: CFG.DEFAULT_OFFSET_X,
        offsetY: CFG.DEFAULT_OFFSET_Y,
        scale: CFG.DEFAULT_SCALE,
        dynamicGridScalingEnabled: CFG.DYNAMIC_GRID_SCALING_ENABLED,
        referenceGridSize: CFG.SCALE_REFERENCE_GRID_SIZE,
        fadeInMs: CFG.DEFAULT_FADE_IN_MS,
        holdMs: CFG.DEFAULT_HOLD_MS,
        fadeOutMs: CFG.DEFAULT_FADE_OUT_MS,
        zIndex: CFG.DEFAULT_Z_INDEX,
        replaceExisting: CFG.DEFAULT_REPLACE_EXISTING
      }
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    CFG,

    normalizeInstruction,
    validateInstruction,
    buildPseudoPayload,

    playInstruction,
    stopTokenEmote,

    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteRuntime = api;
    } catch (err) {
      console.warn("[Emote:Runtime] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Bootstrap", "emote-runtime.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      pseudoAvailable: !!getPseudoApi(),
      localFallbackEnabled: !!CFG.LOCAL_FALLBACK_ENABLED
    });
  });
})();