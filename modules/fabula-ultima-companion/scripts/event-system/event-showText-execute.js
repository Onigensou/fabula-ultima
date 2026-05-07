/**
 * [ONI] Event System — Show Text — Execute
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-showText-execute.js
 *
 * What this does:
 * - Executes one "Show Text" event row
 * - Resolves the speaker using event-showText-speakerResolver.js
 * - Uses your existing FU Dialog System first (same in-game bubble UI)
 * - Waits for the spawned dialog bubble to finish on the executing client
 * - Keeps a simple fallback only if FU.Dialog is unavailable
 *
 * Exposes API to:
 *   window.oni.EventSystem.ShowText.Execute
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-showText-speakerResolver.js
 * - scripts/dialog-system/dialog-core.js
 * - scripts/dialog-system/dialog-ui.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ShowText][Execute]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  window.oni.EventSystem.ShowText = window.oni.EventSystem.ShowText || {};

  if (window.oni.EventSystem.ShowText.Execute?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const SpeakerResolver = window.oni.EventSystem.ShowText.SpeakerResolver;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!SpeakerResolver) {
    console.error(INSTALL_TAG, "Missing SpeakerResolver. Load event-showText-speakerResolver.js first.");
    return;
  }

  const DEBUG_SCOPE = "ShowTextExecute";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    group: (...args) => {
      console.groupCollapsed(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args);
      return true;
    },
    groupEnd: () => console.groupEnd()
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeRow(row = {}) {
    return {
      id: stringOrEmpty(row.id) || foundry.utils.randomID(),
      type: C.normalizeEventType ? C.normalizeEventType(row.type) : String(row.type || C.DEFAULT_ROW_TYPE),
      speaker: stringOrEmpty(row.speaker || C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF),
      text: String(row.text ?? C.DEFAULT_SHOW_TEXT_MESSAGE ?? ""),
      bubbleMode: stringOrEmpty(row.bubbleMode || row.mode || "normal") || "normal",
      speed: Number.isFinite(Number(row.speed)) ? Number(row.speed) : 28
    };
  }

  function buildExecutionContext(context = {}) {
    return {
      ...context,
      sceneId: stringOrEmpty(context.sceneId) || canvas?.scene?.id || null,
      userId: stringOrEmpty(context.userId || game?.user?.id) || null,
      tileId: stringOrEmpty(context.tileId),
      tokenId: stringOrEmpty(context.tokenId || context.partyTokenId),
      actorId: stringOrEmpty(context.actorId || context.partyActorId),
      partyToken: context.partyToken || null,
      partyActor: context.partyActor || null
    };
  }

  function estimateDialogLifetimeMs(text, speed) {
    const cps = Math.max(1, Number(speed) || 28);
    const chars = String(text ?? "").length;
    const typingMs = Math.ceil((chars / cps) * 1000);
    const holdMs = 1600;
    const enterExitMs = 600;
    return Math.max(2500, Math.min(30000, typingMs + holdMs + enterExitMs + 1200));
  }

  function getBubbleElById(bubbleId) {
    if (!bubbleId) return null;
    return document.getElementById(String(bubbleId));
  }

  async function waitForBubbleToFinish(bubbleId, { timeoutMs = 10000 } = {}) {
    if (!bubbleId) return;

    const startedAt = Date.now();
    let sawBubble = false;

    while ((Date.now() - startedAt) < timeoutMs) {
      const el = getBubbleElById(bubbleId);

      if (el) {
        sawBubble = true;
      } else if (sawBubble) {
        return;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    DBG.warn(DEBUG_SCOPE, "Timed out while waiting for dialog bubble to finish.", {
      bubbleId,
      timeoutMs
    });
  }

   function buildDialogPayload(row, speakerResult, context, anchor) {
    const token = speakerResult?.token || anchor?.token || null;
    const actor = speakerResult?.actor || anchor?.actor || null;

    return {
      rowId: row.id,
      eventType: C.EVENT_TYPES?.SHOW_TEXT || "showText",
      tileId: context.tileId || null,
      sceneId: context.sceneId || null,
      userId: context.userId || null,

      speakerInput: row.speaker,
      speakerName: speakerResult?.speakerName || C.SPECIAL_SPEAKER_SELF,

      text: row.text,
      html: row.text,

      bubbleMode: row.bubbleMode,
      mode: row.bubbleMode,
      speed: row.speed,

      token,
      actor,
      tokenUuid: speakerResult?.tokenUuid || null,
      actorUuid: speakerResult?.actorUuid || null,

      tokenId: anchor?.tokenId || null,
      actorId: anchor?.actorId || null,

      portraitSrc: getPreferredPortraitSrc(token, actor),

      meta: {
        matchedBy: speakerResult?.matchedBy || null,
        resolutionMode: speakerResult?.mode || null
      }
    };
  }

  function buildAnchorTarget(speakerResult, context) {
    const token =
      speakerResult?.token ||
      context.partyToken ||
      null;

    const actor =
      speakerResult?.actor ||
      token?.actor ||
      context.partyActor ||
      null;

    return {
      token,
      actor,
      tokenId: token?.id || token?.document?.id || context.tokenId || null,
      actorId: actor?.id || context.actorId || null
    };
  }

  function localizeTitle(speakerName) {
    const safe = stringOrEmpty(speakerName);
    return safe || C.SPECIAL_SPEAKER_SELF || "Speaker";
  }

    function getPreferredPortraitSrc(token, actor) {
    return stringOrEmpty(
      token?.document?.texture?.src ||
      token?.texture?.src ||
      actor?.img
    ) || null;
  }

  // ------------------------------------------------------------
  // Adapter 1:
  // Your real FU Dialog System
  // ------------------------------------------------------------
  async function tryFUDialogSystem(payload, context) {
    const dialogApi = globalThis?.FU?.Dialog;
    if (typeof dialogApi?.show !== "function") {
      return { ok: false };
    }

    const tokenId = payload.tokenId || null;
    const actorId = payload.actorId || null;

    if (!tokenId && !actorId) {
      DBG.warn(DEBUG_SCOPE, "FU.Dialog.show could not be used because no anchor token/actor was resolved.", {
        payload
      });
      return { ok: false };
    }

    DBG.verboseLog(DEBUG_SCOPE, "Using FU.Dialog.show.", {
      tokenId,
      actorId,
      speakerName: payload.speakerName,
      mode: payload.mode,
      speed: payload.speed
    });

       const resultPayload = await dialogApi.show({
      tokenId,
      actorId,
      text: payload.text,
      name: payload.speakerName,
      mode: payload.mode || "normal",
      speed: payload.speed || 28,
      portraitSrc: payload.portraitSrc || null,
      broadcast: true,
      sceneId: context.sceneId || canvas?.scene?.id || null
    });

    const bubbleId = resultPayload?.bubbleId || null;

    await waitForBubbleToFinish(bubbleId, {
      timeoutMs: estimateDialogLifetimeMs(payload.text, payload.speed)
    });

    return {
      ok: true,
      adapter: "FU.Dialog.show",
      bubbleId,
      resultPayload
    };
  }

  // ------------------------------------------------------------
  // Adapter 2:
  // Explicit runtime bridge if you want one later
  // ------------------------------------------------------------
  async function tryContextBridge(payload, context) {
    try {
      if (typeof context?.runShowText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.runShowText bridge.");
        await context.runShowText(payload, context);
        return { ok: true, adapter: "context.runShowText" };
      }

      if (typeof context?.showTextRunner === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.showTextRunner bridge.");
        await context.showTextRunner(payload, context);
        return { ok: true, adapter: "context.showTextRunner" };
      }

      if (typeof context?.dialogRunner === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.dialogRunner bridge.");
        await context.dialogRunner(payload, context);
        return { ok: true, adapter: "context.dialogRunner" };
      }
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "Context dialog bridge failed:", e);
      throw e;
    }

    return { ok: false };
  }

  // ------------------------------------------------------------
  // Adapter 3:
  // EventSystem bridge if you want one later
  // ------------------------------------------------------------
  async function tryEventSystemBridge(payload, context) {
    try {
      const bridge = window.oni?.EventSystem?.DialogBridge;

      if (bridge && typeof bridge.showText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using EventSystem DialogBridge.");
        await bridge.showText(payload, context);
        return { ok: true, adapter: "window.oni.EventSystem.DialogBridge.showText" };
      }
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "EventSystem DialogBridge failed:", e);
      throw e;
    }

    return { ok: false };
  }

  // ------------------------------------------------------------
  // Adapter 4:
  // Simple fallback only if dialog system is unavailable
  // ------------------------------------------------------------
  async function showFallbackDialog(payload) {
    const title = localizeTitle(payload.speakerName);
    const content = `
      <div class="oni-event-show-text-fallback" style="line-height:1.5;">
        <div style="font-weight:800; margin-bottom:8px;">${escapeHTML(title)}</div>
        <div>${payload.html || ""}</div>
      </div>
    `;

    return new Promise((resolve) => {
      try {
        new Dialog({
          title,
          content,
          buttons: {
            ok: {
              icon: '<i class="fas fa-check"></i>',
              label: "Continue",
              callback: () => resolve({ ok: true, adapter: "Dialog" })
            }
          },
          default: "ok",
          close: () => resolve({ ok: true, adapter: "Dialog" })
        }).render(true);
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Fallback Dialog render failed:", e);
        ui.notifications?.warn?.("[Event System] Failed to show fallback dialog. See console.");
        resolve({ ok: false, adapter: "Dialog", error: e });
      }
    });
  }

  async function runDialogAdapters(payload, context) {
    // Preferred order:
    // 1. real FU dialog system
    // 2. explicit runtime bridge
    // 3. EventSystem bridge
    // 4. fallback popup (only if nothing else exists)

    let result = await tryFUDialogSystem(payload, context);
    if (result.ok) return result;

    result = await tryContextBridge(payload, context);
    if (result.ok) return result;

    result = await tryEventSystemBridge(payload, context);
    if (result.ok) return result;

    DBG.warn(DEBUG_SCOPE, "FU Dialog System not available. Falling back to simple Foundry Dialog.");
    return showFallbackDialog(payload);
  }

  // ------------------------------------------------------------
  // Main executor
  // ------------------------------------------------------------
  const Execute = {
    installed: true,

    async execute(rawRow = {}, rawContext = {}) {
      const row = normalizeRow(rawRow);
      const context = buildExecutionContext(rawContext);

      const grouped = !!DBG.group?.(DEBUG_SCOPE, `Execute Show Text [${row.id}]`, true);
      DBG.log(DEBUG_SCOPE, "Raw row:", rawRow);
      DBG.verboseLog(DEBUG_SCOPE, "Normalized row:", row);
      DBG.verboseLog(DEBUG_SCOPE, "Execution context:", context);

      try {
        const speakerResult = await SpeakerResolver.resolve(row.speaker, context);
        const safeSpeakerResult = speakerResult?.ok
          ? speakerResult
          : {
              ok: true,
              mode: "fallback",
              input: row.speaker,
              matchedBy: "executeFallback",
              speakerName: C.SPECIAL_SPEAKER_SELF,
              token: null,
              actor: null,
              tokenUuid: null,
              actorUuid: null
            };

        const anchor = buildAnchorTarget(safeSpeakerResult, context);
        const payload = buildDialogPayload(row, safeSpeakerResult, context, anchor);

        DBG.log(DEBUG_SCOPE, "Final Show Text payload:", {
          rowId: payload.rowId,
          speakerName: payload.speakerName,
          mode: payload.mode,
          tokenId: payload.tokenId,
          actorId: payload.actorId,
          matchedBy: payload.meta?.matchedBy
        });

        DBG.verboseLog(DEBUG_SCOPE, "Payload full dump:", payload);

        const dialogResult = await runDialogAdapters(payload, context);

        DBG.log(DEBUG_SCOPE, "Show Text completed.", {
          rowId: row.id,
          adapter: dialogResult?.adapter || null,
          speakerName: payload.speakerName
        });

        return {
          ok: true,
          rowId: row.id,
          type: row.type,
          adapter: dialogResult?.adapter || null,
          payload
        };
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Show Text execution failed:", e);

        return {
          ok: false,
          rowId: row.id,
          type: row.type,
          error: e
        };
      } finally {
        if (grouped) DBG.groupEnd?.();
      }
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ShowText.Execute = Execute;

  console.log(INSTALL_TAG, "Installed.");
})();
