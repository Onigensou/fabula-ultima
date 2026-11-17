// ============================================================================
// FabulaUltimaCompanion - Dialog System (Central Backend API)
// File: scripts/dialog-system/dialog-core.js
// - Provides FU.Dialog.show(...) for other scripts to call
// - No user prompts, no UI building here
// - UI/rendering is delegated to FU.DialogUI
//
// FU.Dialog.show options (besides the speaker / text / timing ones below):
//   font       developer font option: "default" | "pixelify" | a CSS
//              font-family string. That line only; every client draws it
//              (dialog-ui.js resolveTextFont). Not in the event editor.
//   box        true: the message box (dialog-ui.js), the JRPG square window
//              at the bottom of the screen. No token is needed or looked for
//              (no "selected token" guess); tokenId / actorId only supply
//              the default name and portrait.
//   boxLook    with box: "auto" (default) | "parchment" | "overPicture".
//              auto = overPicture while a Show Picture is up on this client.
//   portraitSrc  null = the default (actor picture, then the token's unless
//              it is a video); with box, "none" = no portrait column.
//   screen     true: with no speaker token, the bubble sits at the bottom of
//              the screen (no tail) instead of warning.
// FU.Dialog.showFloating takes font too.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  console.debug("%c[FU Dialog:Core][BOOT] dialog-core.js loaded", "color:#a7f3d0", {
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

  // The portrait is an <img>: a video (an animated token) cannot show in it.
  const isVideoSrc = (src) => /\.(webm|mp4|m4v|ogv)(\?.*)?$/i.test(String(src || ""));

  // The message box's default portrait: the actor's picture, then the
  // token's unless it is a video; none at all is fine (the column goes).
  function boxPortraitSrc(portraitSrc, token, actor) {
    if (portraitSrc === "none" || portraitSrc === false) return null;
    const given = String(portraitSrc ?? "").trim();
    if (given && !isVideoSrc(given)) return given;
    const tokenSrc = token?.document?.texture?.src || token?.texture?.src || "";
    return [actor?.img, isVideoSrc(tokenSrc) ? "" : tokenSrc].find(s => s && !isVideoSrc(s)) || null;
  }

  // The developer font option, kept as given (each client resolves it with
  // FU.DialogUI.resolveTextFont); empty means none.
  const fontOption = (font) => (typeof font === "string" && font.trim() ? font.trim() : null);

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
      // a named typing pace in place of speed (dialog-ui.js PACES): "slow"
      pace = null,

      // visuals
      portraitSrc = null,

      // behavior
      broadcast = true,

      // waitForInput: stay up until pressed (closes itself after maxWaitMs).
      // controlled: the caller handles presses and drives the bubble with
      // FU.DialogUI.control(), so every client stays on the same line.
      waitForInput = false,
      maxWaitMs = null,
      controlled = false,

      // developer font option (see the header)
      font = null,

      // the message box (see the header)
      box = false,
      boxLook = "auto",

      // optional: override sceneId (rare)
      sceneId = canvas?.scene?.id ?? null,
    } = opts;

    if (!sceneId) throw new Error("No active sceneId (canvas not ready?).");
    if (!text || !String(text).trim()) return;

    if (box === true) {
      // Only an explicit speaker: the box must not borrow a selected token.
      const token = tokenId ? (getTokenOnCanvas(tokenId) ?? null) : null;
      const actor = (actorId ? game.actors?.get(actorId) : null) ?? token?.actor ?? null;
      const ui = globalThis.FU?.DialogUI;
      const look = ui?.resolveBoxLook
        ? ui.resolveBoxLook(boxLook, ui.picturesShown?.() ?? false)
        : (boxLook === "overPicture" ? "overPicture" : "parchment");
      const payload = {
        bubbleId: `fu-bubble-${randomID(12)}`,
        sceneId,
        tokenId: token?.document?.id ?? null,
        screenAnchor: true,
        box: { look },
        actorId: actor?.id ?? null,
        name: String(name ?? actor?.name ?? ""),
        text: String(text),
        mode,
        speed: Math.max(1, Number(speed) || 28),
        pace: pace ? String(pace) : null,
        portraitSrc: boxPortraitSrc(portraitSrc, token, actor),
        font: fontOption(font),
        waitForInput: waitForInput === true,
        maxWaitMs: Number(maxWaitMs) > 0 ? Number(maxWaitMs) : null,
        controlled: controlled === true,
        fromUserId: game.user.id,
        fromUserName: game.user.name,
        createdAt: Date.now(),
      };
      debug("show box payload", payload);
      await renderLocal(payload);
      if (broadcast) {
        try { await emitToSocket(payload); }
        catch (e) { console.warn("[FU Dialog:Core] broadcast failed:", e); }
      }
      return payload;
    }

    const token = pickSpeakerToken({ tokenId, actorId });
    if (!token) {
      // No speaker on this map (a theatre scene, an announcer, a voice from
      // off-stage): with screen:true the bubble sits at the bottom of the
      // screen, with the actor's portrait when there is one.
      if (opts.screen !== true) {
        ui.notifications?.warn("FU.Dialog.show: No speaker token found (select a token or pass tokenId/actorId).");
        return;
      }
      const actor = actorId ? game.actors?.get(actorId) : null;
      const payload = {
        bubbleId: `fu-bubble-${randomID(12)}`,
        sceneId,
        tokenId: null,
        screenAnchor: true,
        actorId: actor?.id ?? null,
        name: name ?? actor?.name ?? "",
        text: String(text),
        mode,
        speed: Math.max(1, Number(speed) || 28),
        pace: pace ? String(pace) : null,
        portraitSrc: portraitSrc ?? actor?.img ?? null,
        font: fontOption(font),
        waitForInput: waitForInput === true,
        maxWaitMs: Number(maxWaitMs) > 0 ? Number(maxWaitMs) : null,
        controlled: controlled === true,
        fromUserId: game.user.id,
        fromUserName: game.user.name,
        createdAt: Date.now(),
      };
      await renderLocal(payload);
      if (broadcast) {
        try { await emitToSocket(payload); }
        catch (e) { console.warn("[FU Dialog:Core] broadcast failed:", e); }
      }
      return payload;
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
      pace: pace ? String(pace) : null,
      portraitSrc: portraitSrc ?? derivePortraitSrc(token),
      font: fontOption(font),
      waitForInput: waitForInput === true,
      maxWaitMs: Number(maxWaitMs) > 0 ? Number(maxWaitMs) : null,
      controlled: controlled === true,
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

  // A line with no speaker and no box, drawn straight on the screen
  // (dialog-float.js): a narrator, a voice in the head, a voice from a thing.
  //
  //   text, speed, broadcast, waitForInput, maxWaitMs, controlled, sceneId
  //                 as for show()
  //   holdMs        a line that does not wait closes this long after it is
  //                 complete (for a line that advances by itself)
  //   anchor        "tl" "tc" "tr" "ml" "mc" "mr" "bl" "bc" "br"  (default "tc")
  //   nudge         { x, y } screen pixels from the anchor
  //   target        { kind: "token" | "tile", id } or { kind: "point", x, y }:
  //                 beside that thing on the map, instead of a screen anchor
  //   startFresh    fade whatever is floating before this line
  //   font          developer font option, as for show()
  //
  // Returns { ...payload, finished }: finished resolves when the line has
  // closed HERE. The line stays on screen after that; FU.DialogUI
  // .clearFloating() takes floating text away.
  async function showFloating(opts = {}) {
    const {
      text = "",
      speed = 28,
      broadcast = true,
      waitForInput = false,
      maxWaitMs = null,
      holdMs = null,
      controlled = false,
      anchor = "tc",
      nudge = null,
      target = null,
      startFresh = false,
      font = null,
      sceneId = canvas?.scene?.id ?? null,
    } = opts;

    if (!sceneId) throw new Error("No active sceneId (canvas not ready?).");
    if (!text || !String(text).trim()) return null;

    const payload = {
      bubbleId: `fu-float-${randomID(12)}`,
      sceneId,
      mode: "float",
      text: String(text),
      speed: Math.max(1, Number(speed) || 28),
      waitForInput: waitForInput === true,
      maxWaitMs: Number(maxWaitMs) > 0 ? Number(maxWaitMs) : null,
      holdMs: Number(holdMs) > 0 ? Number(holdMs) : null,
      controlled: controlled === true,
      font: fontOption(font),
      float: {
        anchor: String(anchor || "tc"),
        nudge: nudge ? { x: Number(nudge.x) || 0, y: Number(nudge.y) || 0 } : null,
        target: target ?? null,
        startFresh: startFresh === true,
      },
      fromUserId: game.user.id,
      fromUserName: game.user.name,
      createdAt: Date.now(),
    };

    debug("showFloating payload", payload);

    const rendered = await renderLocal(payload);

    if (broadcast) {
      try {
        await emitToSocket(payload);
      } catch (e) {
        console.warn("[FU Dialog:Core] broadcast failed:", e);
      }
    }

    return { ...payload, finished: rendered?.finished ?? Promise.resolve() };
  }

  // Create your global API
  globalThis.FU = globalThis.FU ?? {};
  globalThis.FU.Dialog = {
    DEBUG: false, // set true to console.log core+ui
    show,
    showFloating,
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
