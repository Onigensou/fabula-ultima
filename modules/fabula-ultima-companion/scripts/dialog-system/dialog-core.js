// ============================================================================
// FabulaUltimaCompanion - Dialog System (Central Backend API)
// File: scripts/dialog-system/dialog-core.js
// - Provides FU.Dialog.show(...) for other scripts to call
// - No user prompts, no UI building here
// - UI/rendering is delegated to FU.DialogUI
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  console.log("%c[FU Dialog:Core][BOOT] dialog-core.js loaded", "color:#a7f3d0", {
  user: game?.user?.name,
  userId: game?.user?.id
});

  function randomID(n = 12) {
    const s = "abcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    while (r.length < n) r += s[(Math.random() * s.length) | 0];
    return r;
  }

  function getTokenOnCanvas(tokenId) {
    return canvas?.tokens?.get?.(tokenId) ?? canvas?.tokens?.placeables?.find?.(t => t?.document?.id === tokenId);
  }

  function pickSpeakerToken({ tokenId, actorId } = {}) {
    // 1) explicit tokenId
    if (tokenId) return getTokenOnCanvas(tokenId);

    // 2) selected token
    const controlled = canvas?.tokens?.controlled?.[0];
    if (controlled) {
      if (!actorId) return controlled;
      if (controlled?.actor?.id === actorId) return controlled;
    }

    // 3) find any token for actorId
    if (actorId) {
      return canvas?.tokens?.placeables?.find(t => t?.actor?.id === actorId) ?? null;
    }

    return null;
  }

  function derivePortraitSrc(token) {
    return (
      token?.actor?.img ||
      token?.document?.texture?.src ||
      token?.texture?.src ||
      "icons/svg/mystery-man.svg"
    );
  }

  function debug(...args) {
    const d = globalThis?.FU?.Dialog?.DEBUG;
    if (d) console.log("[FU Dialog:Core]", ...args);
  }

  async function emitToSocket(payload) {
    const ui = globalThis?.FU?.DialogUI;
    if (!ui?.SOCKET_CHANNEL) throw new Error("DialogUI not ready (missing SOCKET_CHANNEL).");

    const packet = { type: ui.MSG_TYPE_SHOW, payload };
    debug("emit", ui.SOCKET_CHANNEL, packet);

    game.socket.emit(ui.SOCKET_CHANNEL, packet);
  }

  async function waitForDialogUI(timeoutMs = 2000) {
  const start = Date.now();
  while (true) {
    const ui = globalThis?.FU?.DialogUI;
    if (ui?.renderFromPayload) return ui;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 50));
  }
}

async function renderLocal(payload) {
  const ui = await waitForDialogUI(2000);
  if (!ui) {
    console.warn("[FU Dialog:Core] DialogUI not ready after wait. globalThis.FU =", globalThis.FU);
    throw new Error("DialogUI not ready (missing renderFromPayload).");
  }
  return ui.renderFromPayload(payload, { remote: false });
}

  async function show(opts = {}) {
    const {
      // speaker targeting
      tokenId = null,
      actorId = null,

      // dialog content
      text = "",
      name = null,
      mode = "normal",       // "normal" | "shout" | "think"
      speed = 28,

      // visuals
      portraitSrc = null,

      // behavior
      broadcast = true,

      // optional: override sceneId (rare)
      sceneId = canvas?.scene?.id ?? null,
    } = opts;

    if (!sceneId) throw new Error("No active sceneId (canvas not ready?).");
    if (!text || !String(text).trim()) return;

    const token = pickSpeakerToken({ tokenId, actorId });
    if (!token) {
      ui.notifications?.warn("FU.Dialog.show: No speaker token found (select a token or pass tokenId/actorId).");
      return;
    }

    const payload = {
      bubbleId: `fu-bubble-${randomID(12)}`,
      sceneId,
      tokenId: token.document.id,
      actorId: token.actor?.id ?? null,
      name: name ?? token.document?.name ?? token.name ?? "Speaker",
      text: String(text),
      mode,
      speed: Math.max(1, Number(speed) || 28),
      portraitSrc: portraitSrc ?? derivePortraitSrc(token),
      fromUserId: game.user.id,
      fromUserName: game.user.name,
      createdAt: Date.now(),
    };

    debug("show payload", payload);

    // render immediately locally
    await renderLocal(payload);

    // broadcast if requested
    if (broadcast) {
      try {
        await emitToSocket(payload);
      } catch (e) {
        console.warn("[FU Dialog:Core] broadcast failed:", e);
        ui.notifications?.warn(`Dialog broadcast failed: ${e?.message || e}`);
      }
    }

    return payload;
  }

  // Create your global API
  globalThis.FU = globalThis.FU ?? {};
  globalThis.FU.Dialog = {
    DEBUG: false, // set true to console.log core+ui
    show,
  };

  // Also expose via module API (nice for other scripts)
  Hooks.once("ready", () => {
    try {
      const mod = game.modules.get(MODULE_ID);
      if (mod) {
        mod.api = mod.api ?? {};
        mod.api.dialog = globalThis.FU.Dialog;
      }
    } catch (e) {
      console.warn("[FU Dialog:Core] failed to attach module api:", e);
    }
  });
})();
