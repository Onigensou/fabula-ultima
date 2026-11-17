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
 * How a line is shown (row.showAs):
 *   "bubble"  over the speaker's token, exactly as before: a speaker with no
 *             token here falls back to the party token, and with no token at
 *             all to a bubble at the bottom of the screen. A row saved before
 *             showAs existed (no showAs key) is a bubble, so old events do
 *             not change.
 *   "box"     always the message box (dialog-ui.js): the JRPG square window
 *             at the bottom of the screen, on every client.
 *   "auto"    (new rows) the box when the resolved speaker has no token on
 *             this scene (no party-token fallback then), the bubble otherwise.
 *
 * Message box fields (only used when the line is a box):
 *   portrait  ""      the speaker's picture (actor, then token unless video)
 *             "none"  no portrait column
 *             a path  that picture (a video path falls back to the default)
 *   boxLook   "auto" | "parchment" | "overPicture"; auto = overPicture while
 *             a Show Picture is up (window.oni.EventSystem.Pictures.anyShown)
 *   row.bubbleMode still applies: shout = jagged box, think = italic text.
 *
 * Developer font option (no editor field): row.font = "default" |
 * "pixelify" | a CSS font-family string, passed to FU.Dialog.show({ font }).
 *
 * The pure rules (showAs, portrait, box look) are on Execute.rules and
 * tested in scripts/dialog-system/message-box.test.mjs.
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
    console.debug(INSTALL_TAG, "Already installed; skipping.");
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

  // {var:name} in a line prints that variable of the current party.
  function withVariables(text) {
    const logic = window.oni?.EventSystem?.Logic;
    const state = window.oni?.EventSystem?.GameState;
    if (!logic?.substituteVars || !state?.getVariable) return text;
    return logic.substituteVars(text, (name) => (state.getVariableText ?? state.getVariable)(name));
  }

  // ------------------------------------------------------------
  // Pure rules: how a line is shown, and the message box's portrait
  // ------------------------------------------------------------
  const SHOW_AS = ["auto", "bubble", "box"];
  const BOX_LOOKS = ["auto", "parchment", "overPicture"];
  const isVideoSrc = (src) => /\.(webm|mp4|m4v|ogv)(\?.*)?$/i.test(String(src || ""));

  // A row with no showAs was saved before it existed: it stays a bubble.
  function normalizeShowAs(value) {
    return SHOW_AS.includes(value) ? value : "bubble";
  }

  // showAs + "does the speaker have a token on this scene" -> "bubble" | "box".
  function resolveShowAs(showAs, speakerHasTokenHere) {
    const wanted = normalizeShowAs(showAs);
    if (wanted === "auto") return speakerHasTokenHere ? "bubble" : "box";
    return wanted;
  }

  function normalizeBoxLook(value) {
    return BOX_LOOKS.includes(value) ? value : "auto";
  }

  // The portrait field as stored: "" (default), "none", or a path.
  function normalizePortraitField(value) {
    const raw = stringOrEmpty(value);
    return raw.toLowerCase() === "none" ? "none" : raw;
  }

  // The message box's picture: null = no portrait column.
  function resolveBoxPortrait(field, { actorImg = "", tokenSrc = "" } = {}) {
    const raw = normalizePortraitField(field);
    if (raw === "none") return null;
    if (raw && !isVideoSrc(raw)) return raw;
    const pick = [actorImg, isVideoSrc(tokenSrc) ? "" : tokenSrc].find(s => s && !isVideoSrc(s));
    return stringOrEmpty(pick) || null;
  }

  // The font option as stored on the row (kept only when set).
  function normalizeFont(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // Is this token drawn on the scene the executing client is looking at?
  function tokenIsHere(token) {
    const id = token?.document?.id || token?.id || null;
    return !!(id && canvas?.tokens?.get?.(id));
  }

  function normalizeRow(row = {}) {
    return {
      id: stringOrEmpty(row.id) || foundry.utils.randomID(),
      type: C.normalizeEventType ? C.normalizeEventType(row.type) : String(row.type || C.DEFAULT_ROW_TYPE),
      speaker: stringOrEmpty(row.speaker || C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF),
      text: withVariables(String(row.text ?? C.DEFAULT_SHOW_TEXT_MESSAGE ?? "")),
      bubbleMode: stringOrEmpty(row.bubbleMode || row.mode || "normal") || "normal",
      speed: Number.isFinite(Number(row.speed)) ? Number(row.speed) : 28,
      // "slow": the typewriter's slow pace (dialog-ui.js), in place of speed.
      textSpeed: row.textSpeed === "slow" ? "slow" : "normal",
      // How the line is shown; missing = a bubble (rows from before showAs).
      showAs: normalizeShowAs(row.showAs),
      portrait: normalizePortraitField(row.portrait),
      boxLook: normalizeBoxLook(row.boxLook),
      font: normalizeFont(row.font)
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

  function estimateDialogLifetimeMs(text, speed, pace = null) {
    const cps = Math.max(1, Number(speed) || 28);
    const plain = String(text ?? "").replace(/<\/?b>/gi, "");
    // The typewriter's own timing when it is loaded (a slow line stops at each
    // full stop); the plain characters-per-second count otherwise.
    const paced = globalThis.FU?.DialogUI?.linePace?.(plain, { speed: cps, pace });
    const typingMs = Number.isFinite(paced?.typeMs) ? paced.typeMs : Math.ceil((plain.length / cps) * 1000);
    // The bubble stays up after typing for as long again plus a hold
    // (dialog-ui.js: max(1200, typing + 1600)). Counting only the hold let a
    // long line's follow-up start while that line was still showing.
    const holdMs = Math.max(1200, typingMs + 1600);
    const enterExitMs = 600;
    return Math.max(2500, Math.min(45000, typingMs + holdMs + enterExitMs + 1200));
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

   function buildDialogPayload(row, speakerResult, context, anchor, presentation = "bubble") {
    const token = speakerResult?.token || anchor?.token || null;
    const actor = speakerResult?.actor || anchor?.actor || null;
    const isBox = presentation === "box";

    // In the box, the "Self" placeholder of a party with no token is not a
    // name worth printing: the name line is left out.
    const placeholderSelf = !token && !actor && speakerResult?.speakerName === C.SPECIAL_SPEAKER_SELF;
    const speakerName = isBox && placeholderSelf
      ? ""
      : (speakerResult?.speakerName || C.SPECIAL_SPEAKER_SELF);

    return {
      rowId: row.id,
      eventType: C.EVENT_TYPES?.SHOW_TEXT || "showText",
      tileId: context.tileId || null,
      sceneId: context.sceneId || null,
      userId: context.userId || null,

      speakerInput: row.speaker,
      speakerName,

      text: row.text,
      html: row.text,

      bubbleMode: row.bubbleMode,
      mode: row.bubbleMode,
      speed: row.speed,
      pace: row.textSpeed === "slow" ? "slow" : null,

      token,
      actor,
      tokenUuid: speakerResult?.tokenUuid || null,
      actorUuid: speakerResult?.actorUuid || null,

      tokenId: anchor?.tokenId || null,
      actorId: anchor?.actorId || null,

      // The box: the row's portrait field; the bubble: as it always was.
      portraitSrc: isBox
        ? resolveBoxPortrait(row.portrait, {
            actorImg: actor?.img || token?.actor?.img || "",
            tokenSrc: token?.document?.texture?.src || token?.texture?.src || ""
          })
        : getPreferredPortraitSrc(token, actor),

      presentation,
      boxLook: row.boxLook,
      font: row.font,

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

  // The box's speaker: only who the resolver found. No party-token
  // fallback (a box needs no token to stand on).
  function buildBoxTarget(speakerResult) {
    const token = speakerResult?.token || null;
    const actor = speakerResult?.actor || token?.actor || null;
    return {
      token,
      actor,
      tokenId: token?.document?.id || token?.id || null,
      actorId: actor?.id || null
    };
  }

  function localizeTitle(speakerName) {
    const safe = stringOrEmpty(speakerName);
    return safe || C.SPECIAL_SPEAKER_SELF || "Speaker";
  }

    function getPreferredPortraitSrc(token, actor) {
    // The portrait is an <img>: an animated token (a .webm battle idle) cannot show
    // in it, so a video token falls back to the actor's own picture.
    const isVideo = (src) => /\.(webm|mp4|m4v|ogv)(\?.*)?$/i.test(String(src || ""));
    const tokenSrc = token?.document?.texture?.src || token?.texture?.src || "";
    const pick = [isVideo(tokenSrc) ? "" : tokenSrc, actor?.img, token?.actor?.img].find(s => s && !isVideo(s));
    return stringOrEmpty(pick) || null;
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
    const isBox = payload.presentation === "box";
    // Nobody to stand above (a theatre scene with no tokens, an announcer):
    // the line goes in a bubble at the bottom of the screen instead.
    const screen = !tokenId || !canvas?.tokens?.get?.(tokenId);

    DBG.verboseLog(DEBUG_SCOPE, "Using FU.Dialog.show.", {
      tokenId,
      actorId,
      speakerName: payload.speakerName,
      mode: payload.mode,
      speed: payload.speed,
      presentation: payload.presentation || "bubble"
    });

    // A locked event waits on each line for a press; a free one runs on the
    // bubble's own timer. Either way presses are routed through the flow, so
    // every client moves on together.
    const flow = window.oni?.EventSystem?.Flow;
    const waitForInput = !!flow?.shouldWaitForInput?.(context.tileId);
    const maxWaitMs = Number(flow?.LINE_MAX_WAIT_MS) || 30000;

    const resultPayload = await dialogApi.show({
      tokenId,
      actorId,
      text: payload.text,
      name: payload.speakerName,
      mode: payload.mode || "normal",
      speed: payload.speed || 28,
      pace: payload.pace || null,
      // The box takes the portrait as resolved here ("none" = no column).
      portraitSrc: isBox ? (payload.portraitSrc || "none") : (payload.portraitSrc || null),
      broadcast: true,
      screen,
      ...(isBox ? { box: true, boxLook: payload.boxLook || "auto" } : {}),
      ...(payload.font ? { font: payload.font } : {}),
      sceneId: context.sceneId || canvas?.scene?.id || null,
      waitForInput,
      maxWaitMs,
      controlled: !!flow
    });

    const bubbleId = resultPayload?.bubbleId || null;
    flow?.setActiveBubble?.(context.tileId, bubbleId);

    await waitForBubbleToFinish(bubbleId, {
      timeoutMs: estimateDialogLifetimeMs(payload.text, payload.speed, payload.pace) + (waitForInput ? maxWaitMs : 0)
    });

    flow?.setActiveBubble?.(context.tileId, null);

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

    // The pure rules, for tests and for anything that needs the same answer.
    rules: {
      SHOW_AS,
      BOX_LOOKS,
      normalizeRow,
      normalizeShowAs,
      resolveShowAs,
      normalizeBoxLook,
      normalizePortraitField,
      resolveBoxPortrait,
      normalizeFont
    },

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

        // Bubble or message box. "auto" asks whether the speaker the
        // resolver found has a token on this scene (before any fallback).
        const presentation = resolveShowAs(row.showAs, tokenIsHere(safeSpeakerResult.token));
        const anchor = presentation === "box"
          ? buildBoxTarget(safeSpeakerResult)
          : buildAnchorTarget(safeSpeakerResult, context);
        const payload = buildDialogPayload(row, safeSpeakerResult, context, anchor, presentation);

        DBG.log(DEBUG_SCOPE, "Final Show Text payload:", {
          rowId: payload.rowId,
          speakerName: payload.speakerName,
          mode: payload.mode,
          presentation,
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

  console.debug(INSTALL_TAG, "Installed.");
})();
