/**
 * emote-api.js
 * Fabula Ultima Companion - Emote System API
 * Foundry VTT v12
 *
 * Purpose:
 * - Tie together Emote data + store + resolver + runtime
 * - Provide the main public API for the Emote System
 * - Let hotkeys and future scripts trigger emotes through one stable entrypoint
 *
 * Notes:
 * - This script does not render config UI itself
 * - This script does not install hotkeys
 * - This script normalizes requests, resolves target/emote, and forwards to runtime
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_API__
 *
 * API:
 *   FUCompanion.api.EmoteSystem
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_API__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

  const state = {
    installed: true,
    ready: false,
    lastPlayRequest: null,
    lastPlayResult: null,
    playInFlight: 0
  };

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

  function getData() {
    return globalThis.__ONI_EMOTE_DATA__
      ?? globalThis.FUCompanion?.api?.EmoteData
      ?? null;
  }

  function getStore() {
    return globalThis.__ONI_EMOTE_STORE__
      ?? globalThis.FUCompanion?.api?.EmoteStore
      ?? null;
  }

  function getResolver() {
    return globalThis.__ONI_EMOTE_RESOLVER__
      ?? globalThis.FUCompanion?.api?.EmoteResolver
      ?? null;
  }

  function getRuntime() {
    return globalThis.__ONI_EMOTE_RUNTIME__
      ?? globalThis.FUCompanion?.api?.EmoteRuntime
      ?? null;
  }

  function getConfigApp() {
    return globalThis.__ONI_EMOTE_CONFIG_APP__
      ?? globalThis.FUCompanion?.api?.EmoteConfigApp
      ?? null;
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

  function randomId(prefix = "emoteApi") {
    const rand =
      foundry?.utils?.randomID?.(8)
      ?? Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now()}-${rand}`;
  }

  async function resolveActorFromRef(raw = {}) {
    const actor =
      raw.actor
      ?? raw.targetActor
      ?? null;

    if (actor) return actor;

    const actorId =
      cleanString(raw.actorId)
      || cleanString(raw.targetActorId)
      || "";

    if (actorId && game.actors?.get(actorId)) {
      return game.actors.get(actorId);
    }

    const actorUuid =
      cleanString(raw.actorUuid)
      || cleanString(raw.targetActorUuid)
      || "";

    if (actorUuid && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(actorUuid);
        if (doc?.documentName === "Actor") return doc;
      } catch (_) {}
    }

    return null;
  }

  async function resolveTokenFromRef(raw = {}) {
    const token =
      raw.token
      ?? raw.targetToken
      ?? null;

    if (token?.document?.uuid) return token;

    const tokenId =
      cleanString(raw.tokenId)
      || cleanString(raw.targetTokenId)
      || "";

    if (tokenId && canvas?.tokens?.get(tokenId)) {
      return canvas.tokens.get(tokenId);
    }

    const tokenUuid =
      cleanString(raw.tokenUuid)
      || cleanString(raw.targetTokenUuid)
      || cleanString(raw.casterTokenUuid)
      || "";

    if (tokenUuid && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(tokenUuid);
        if (doc?.documentName === "Token") return doc.object ?? null;
        if (doc?.documentName === "TokenDocument") return doc.object ?? null;
      } catch (_) {}
    }

    const actor = await resolveActorFromRef(raw);
    const resolver = getResolver();

    if (actor && resolver?.findTokenByActorOnCanvas) {
      return resolver.findTokenByActorOnCanvas(actor);
    }

    return null;
  }

  async function resolveEmoteReference(raw = {}) {
    const data = getData();
    const store = getStore();

    const directUrl =
      cleanString(raw.emoteUrl)
      || cleanString(raw.url)
      || "";

    const emoteId =
      cleanString(raw.emoteId)
      || cleanString(raw.id)
      || "";

    const slotRaw =
      raw.slot
      ?? raw.hotkeySlot
      ?? raw.slotKey
      ?? null;

    let slot = null;
    if (data?.normalizeSlotKey && slotRaw != null) {
      slot = data.normalizeSlotKey(slotRaw);
    }

    if (hasText(directUrl)) {
      const found = data?.findEmoteByUrl?.(directUrl) ?? null;
      return {
        ok: true,
        reason: found ? "directKnownUrl" : "directCustomUrl",
        emoteUrl: directUrl,
        emoteId: found?.id ?? null,
        emoteLabel: found?.label ?? null,
        emoteKind: found?.kind ?? null,
        slot
      };
    }

    if (hasText(emoteId)) {
      const found = data?.findEmoteById?.(emoteId) ?? null;
      if (!found?.url) {
        return {
          ok: false,
          reason: "unknownEmoteId",
          emoteUrl: null,
          emoteId,
          emoteLabel: null,
          emoteKind: null,
          slot
        };
      }

      return {
        ok: true,
        reason: "resolvedById",
        emoteUrl: found.url,
        emoteId: found.id ?? null,
        emoteLabel: found.label ?? null,
        emoteKind: found.kind ?? null,
        slot
      };
    }

    if (slot && store?.getSlot) {
      const slotUrl = await store.getSlot(slot);
      const found = data?.findEmoteByUrl?.(slotUrl) ?? null;

      if (!hasText(slotUrl)) {
        return {
          ok: false,
          reason: "emptySlot",
          emoteUrl: null,
          emoteId: null,
          emoteLabel: null,
          emoteKind: null,
          slot
        };
      }

      return {
        ok: true,
        reason: "resolvedBySlot",
        emoteUrl: slotUrl,
        emoteId: found?.id ?? null,
        emoteLabel: found?.label ?? null,
        emoteKind: found?.kind ?? null,
        slot
      };
    }

    return {
      ok: false,
      reason: "noEmoteReference",
      emoteUrl: null,
      emoteId: null,
      emoteLabel: null,
      emoteKind: null,
      slot
    };
  }

  async function resolveDirectTarget(raw = {}) {
    const resolver = getResolver();
    const token = await resolveTokenFromRef(raw);
    const actor =
      token?.actor
      ?? await resolveActorFromRef(raw)
      ?? null;

    if (!token) {
      return {
        ok: false,
        reason: "explicitTargetNotResolved",
        mode: "explicit",
        permission: false,
        token: null,
        actor
      };
    }

    const tokenData = resolver?.getTokenDescriptor
      ? resolver.getTokenDescriptor(token)
      : {
          token,
          tokenId: token.id ?? null,
          tokenName: token.name ?? null,
          tokenUuid: token.document?.uuid ?? null,
          actor: token.actor ?? null,
          actorId: token.actor?.id ?? null,
          actorName: token.actor?.name ?? null,
          actorUuid: token.actor?.uuid ?? null,
          centerX: Number.isFinite(token.center?.x) ? token.center.x : null,
          centerY: Number.isFinite(token.center?.y) ? token.center.y : null
        };

    return {
      ok: true,
      reason: "explicitTargetResolved",
      mode: "explicit",
      permission: true,

      userId: cleanString(raw.userId) || game.user?.id || null,
      userName: cleanString(raw.userName) || game.user?.name || null,
      isGM: !!game.user?.isGM,

      actor: actor ?? tokenData?.actor ?? null,
      actorId: actor?.id ?? tokenData?.actorId ?? null,
      actorName: actor?.name ?? tokenData?.actorName ?? null,
      actorUuid: actor?.uuid ?? tokenData?.actorUuid ?? null,

      token,
      tokenId: tokenData?.tokenId ?? null,
      tokenName: tokenData?.tokenName ?? null,
      tokenUuid: tokenData?.tokenUuid ?? null,

      x: tokenData?.centerX ?? null,
      y: tokenData?.centerY ?? null,
      offsetX: Number.isFinite(Number(raw.offsetX)) ? Number(raw.offsetX) : null,
      offsetY: Number.isFinite(Number(raw.offsetY)) ? Number(raw.offsetY) : null
    };
  }

  function shouldUseExplicitTarget(raw = {}) {
    return !!(
      raw.token
      || raw.targetToken
      || hasText(raw.tokenId)
      || hasText(raw.targetTokenId)
      || hasText(raw.tokenUuid)
      || hasText(raw.targetTokenUuid)
      || hasText(raw.actorId)
      || hasText(raw.targetActorId)
      || hasText(raw.actorUuid)
      || hasText(raw.targetActorUuid)
      || raw.actor
      || raw.targetActor
    );
  }

  async function resolveCallerTarget(options = {}) {
    const resolver = getResolver();
    if (!resolver?.resolvePlayContext) {
      DBG.warn("API", "resolveCallerTarget failed because EmoteResolver is unavailable", {
        options
      });

      return {
        ok: false,
        reason: "resolverUnavailable",
        mode: "unknown",
        permission: false
      };
    }

    return await resolver.resolvePlayContext(options);
  }

  async function normalizePlayRequest(raw = {}) {
    const resolver = getResolver();
    const runtime = getRuntime();

    const requestId = cleanString(raw.requestId) || randomId("emoteReq");
    const emote = await resolveEmoteReference(raw);

    if (!emote.ok) {
      return {
        ok: false,
        reason: emote.reason,
        requestId,
        emote,
        target: null,
        instruction: null
      };
    }

    let target = null;

    if (shouldUseExplicitTarget(raw)) {
      target = await resolveDirectTarget(raw);
    } else {
      target = await resolveCallerTarget({
        offsetX: raw.offsetX,
        offsetY: raw.offsetY,
        overrideX: raw.x,
        overrideY: raw.y
      });
    }

    if (!target?.ok) {
      return {
        ok: false,
        reason: target?.reason || "targetResolutionFailed",
        requestId,
        emote,
        target,
        instruction: null
      };
    }

    if (!hasText(target.tokenUuid)) {
      return {
        ok: false,
        reason: "missingTargetTokenUuid",
        requestId,
        emote,
        target,
        instruction: null
      };
    }

    const instruction = {
      runtimeId: cleanString(raw.runtimeId) || requestId,

      token: target.token ?? null,
      tokenId: target.tokenId ?? null,
      tokenName: target.tokenName ?? null,
      tokenUuid: target.tokenUuid ?? null,

      actor: target.actor ?? null,
      actorId: target.actorId ?? null,
      actorName: target.actorName ?? null,
      actorUuid: target.actorUuid ?? null,

      userId: cleanString(raw.userId) || target.userId || game.user?.id || null,
      userName: cleanString(raw.userName) || target.userName || game.user?.name || null,

      emoteUrl: emote.emoteUrl,
      emoteId: emote.emoteId ?? null,
      emoteLabel: emote.emoteLabel ?? null,
      emoteKind: emote.emoteKind ?? null,

      slot: emote.slot ?? null,

      // Only use absolute world x/y when another script explicitly asks for it.
      useAbsolutePosition: raw.useAbsolutePosition === true,

      x:
        raw.useAbsolutePosition === true && Number.isFinite(Number(raw.x))
          ? Number(raw.x)
          : null,

      y:
        raw.useAbsolutePosition === true && Number.isFinite(Number(raw.y))
          ? Number(raw.y)
          : null,

      offsetX: Number.isFinite(Number(raw.offsetX))
        ? Number(raw.offsetX)
        : (Number.isFinite(Number(target.offsetX)) ? Number(target.offsetX) : runtime?.CFG?.DEFAULT_OFFSET_X ?? 40),

      offsetY: Number.isFinite(Number(raw.offsetY))
        ? Number(raw.offsetY)
        : (Number.isFinite(Number(target.offsetY)) ? Number(target.offsetY) : runtime?.CFG?.DEFAULT_OFFSET_Y ?? -54),

      scale: asNumber(raw.scale, runtime?.CFG?.DEFAULT_SCALE ?? 1),
      fadeInMs: asNumber(raw.fadeInMs, runtime?.CFG?.DEFAULT_FADE_IN_MS ?? 120),
      holdMs: asNumber(raw.holdMs, runtime?.CFG?.DEFAULT_HOLD_MS ?? 1200),
      fadeOutMs: asNumber(raw.fadeOutMs, runtime?.CFG?.DEFAULT_FADE_OUT_MS ?? 220),
      zIndex: asNumber(raw.zIndex, runtime?.CFG?.DEFAULT_Z_INDEX ?? 5500),

      replaceExisting:
        raw.replaceExisting === undefined
          ? (runtime?.CFG?.DEFAULT_REPLACE_EXISTING ?? true)
          : !!raw.replaceExisting,

      meta: {
        requestId,
        requestSource: cleanString(raw.requestSource) || "EmoteSystemApi",
        targetMode: target.mode ?? null,
        targetReason: target.reason ?? null,
        emoteResolutionReason: emote.reason ?? null,
        directTarget: shouldUseExplicitTarget(raw),
        ...deepClone(raw.meta ?? {})
      }
    };

    return {
      ok: true,
      reason: "normalized",
      requestId,
      emote,
      target,
      instruction
    };
  }

  async function playEmote(raw = {}) {
    const runtime = getRuntime();

    if (!runtime?.playInstruction) {
      DBG.warn("API", "playEmote failed because EmoteRuntime is unavailable", {
        raw
      });

      return { ok: false, reason: "runtimeUnavailable" };
    }

    state.playInFlight += 1;
    DBG.startTimer("emote-api-play", "API", "Playing emote through EmoteSystem API");

    try {
      const normalized = await normalizePlayRequest(raw);
      state.lastPlayRequest = deepClone(normalized);

      if (!normalized.ok) {
        DBG.warn("API", "playEmote aborted because request normalization failed", {
          reason: normalized.reason,
          normalized
        });

        state.lastPlayResult = deepClone(normalized);
        return normalized;
      }

      const result = await runtime.playInstruction(normalized.instruction);

      const finalResult = {
        ok: !!result?.ok,
        reason: result?.reason ?? "unknown",
        transport: result?.transport ?? null,
        requestId: normalized.requestId,
        emote: normalized.emote,
        target: normalized.target,
        instruction: normalized.instruction,
        runtimeResult: result
      };

      state.lastPlayResult = deepClone(finalResult);

      DBG.groupCollapsed("API", "Emote play request finished", {
        ok: finalResult.ok,
        reason: finalResult.reason,
        transport: finalResult.transport,
        requestId: finalResult.requestId,
        userId: finalResult.instruction?.userId ?? null,
        userName: finalResult.instruction?.userName ?? null,
        tokenId: finalResult.instruction?.tokenId ?? null,
        tokenName: finalResult.instruction?.tokenName ?? null,
        actorId: finalResult.instruction?.actorId ?? null,
        actorName: finalResult.instruction?.actorName ?? null,
        emoteUrl: finalResult.instruction?.emoteUrl ?? null,
        emoteLabel: finalResult.instruction?.emoteLabel ?? null,
        slot: finalResult.instruction?.slot ?? null
      });

      return finalResult;
    } finally {
      state.playInFlight = Math.max(0, state.playInFlight - 1);
      DBG.endTimer("emote-api-play", "API", "Finished EmoteSystem API play request");
    }
  }

  async function playHotkeySlot(slot, options = {}) {
    const data = getData();
    const normalizedSlot = data?.normalizeSlotKey
      ? data.normalizeSlotKey(slot)
      : cleanString(slot);

    if (!normalizedSlot) {
      DBG.warn("API", "playHotkeySlot aborted because slot was invalid", {
        slot,
        options
      });

      return { ok: false, reason: "invalidSlot", slot: null };
    }

    return await playEmote({
      ...deepClone(options ?? {}),
      slot: normalizedSlot,
      requestSource: cleanString(options?.requestSource) || "hotkey"
    });
  }

  async function canUseEmotes() {
    const resolver = getResolver();
    if (!resolver?.canCurrentUserUseEmotes) {
      return { ok: false, reason: "resolverUnavailable" };
    }
    return await resolver.canCurrentUserUseEmotes();
  }

  async function getHotkeyMap() {
    const store = getStore();
    if (!store?.getHotkeyMap) return null;
    return await store.getHotkeyMap();
  }

  async function setHotkeyMap(map, { reason = "apiSetHotkeyMap" } = {}) {
    const store = getStore();
    if (!store?.setHotkeyMap) {
      return { ok: false, reason: "storeUnavailable", state: null };
    }
    return await store.setHotkeyMap(map, { reason });
  }

  async function resetHotkeyMap({ reason = "apiResetHotkeyMap" } = {}) {
    const store = getStore();
    if (!store?.resetToDefault) {
      return { ok: false, reason: "storeUnavailable", state: null };
    }
    return await store.resetToDefault({ reason });
  }

  async function getSlotRows() {
    const store = getStore();
    if (!store?.getSlotRows) return [];
    return await store.getSlotRows();
  }

  async function openConfig(options = {}) {
    const configApp = getConfigApp();

    if (!configApp) {
      DBG.warn("API", "openConfig requested but EmoteConfigApp is not available yet", {
        options
      });

      ui.notifications?.warn?.("Emote configuration window is not available yet.");
      return { ok: false, reason: "configUnavailable" };
    }

    try {
      if (typeof configApp.open === "function") {
        const result = await configApp.open(options);
        return { ok: true, reason: "opened", result };
      }

      if (typeof configApp.render === "function") {
        configApp.render(true, options);
        return { ok: true, reason: "rendered", result: null };
      }

      if (typeof configApp.show === "function") {
        const result = await configApp.show(options);
        return { ok: true, reason: "shown", result };
      }

      DBG.warn("API", "openConfig failed because config app has no supported entrypoint", {
        options
      });

      return { ok: false, reason: "configEntrypointMissing" };
    } catch (err) {
      DBG.error("API", "openConfig threw an error", {
        error: err?.message ?? err
      });

      return { ok: false, reason: "configOpenFailed", error: err };
    }
  }

  function getLastPlayRequest() {
    return deepClone(state.lastPlayRequest);
  }

  function getLastPlayResult() {
    return deepClone(state.lastPlayResult);
  }

  function getHealthSnapshot() {
    return {
      installed: true,
      ready: state.ready,
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,

      dependencies: {
        debug: !!getDebug()?.installed,
        data: !!getData()?.installed,
        store: !!getStore()?.installed,
        resolver: !!getResolver()?.installed,
        runtime: !!getRuntime()?.installed,
        configApp: !!getConfigApp()?.installed
      },

      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: !!game.user?.isGM,

      sceneId: canvas?.scene?.id ?? null,
      sceneName: canvas?.scene?.name ?? null,
      canvasReady: !!canvas?.ready,

      playInFlight: state.playInFlight,
      hasLastPlayRequest: !!state.lastPlayRequest,
      hasLastPlayResult: !!state.lastPlayResult
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    resolveEmoteReference,
    resolveDirectTarget,
    resolveCallerTarget,
    normalizePlayRequest,

    playEmote,
    playHotkeySlot,
    canUseEmotes,

    getHotkeyMap,
    setHotkeyMap,
    resetHotkeyMap,
    getSlotRows,

    openConfig,

    getLastPlayRequest,
    getLastPlayResult,
    getHealthSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteSystem = api;
    } catch (err) {
      console.warn("[Emote:API] Failed to attach API to FUCompanion.api", err);
    }

    state.ready = true;

    DBG.verbose("Bootstrap", "emote-api.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      health: getHealthSnapshot()
    });
  });
})();