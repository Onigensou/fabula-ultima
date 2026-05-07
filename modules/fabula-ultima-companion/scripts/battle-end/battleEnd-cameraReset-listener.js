// ============================================================================
// [BattleEnd: CameraReset Listener] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Run this ONCE per client per session (include in your Dev Bootstrap).
//
// What it does:
// - Listens for a socket broadcast from [BattleEnd: CameraReset] (GM macro)
// - Resets the *stored* view position for the BATTLE SCENE only
//   so the next time the battle scene is viewed/activated, Foundry will start
//   from the desired camera location.
//
// Why this works:
// - Foundry tracks a per-scene view position in memory (Scene._viewPosition).
// - When you return to a previously viewed scene, Foundry can restore that view.
// - By overwriting Scene._viewPosition for the battle scene, we "preload" the
//   default camera position without forcing anyone to switch scenes.
// ============================================================================

Hooks.once("ready", () => {
  const DEBUG = false;
  const tag = "[BattleEnd:CameraReset:Listener]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TYPE = "ONI_BATTLEEND_CAMERA_RESET";

  // Idempotent install (safe to run multiple times)
  if (window.__ONI_BATTLEEND_CAMERA_RESET_LISTENER_INSTALLED__ === true) {
    ui.notifications?.info?.("BattleEnd CameraReset Listener: already installed on this client.");
    log("Already installed.");
    return;
  }
  window.__ONI_BATTLEEND_CAMERA_RESET_LISTENER_INSTALLED__ = true;

  function safeNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  }

  async function applyReset(sceneId, view, durationMs = 0) {
    const sc = game.scenes?.get?.(sceneId);
    if (!sc) {
      log("Scene not found; cannot apply reset.", { sceneId });
      return;
    }

    const x = safeNumber(view?.x, 0);
    const y = safeNumber(view?.y, 0);
    const scale = safeNumber(view?.scale, 1);

    // 1) Reset the scene's stored view position (in-memory)
    //    NOTE: This is the key piece that fixes "next battle camera is weird".
    try {
      sc._viewPosition = { x, y, scale };
      log("Set scene._viewPosition ✅", { sceneId, x, y, scale });
    } catch (e) {
      console.warn(`${tag} Failed to set scene._viewPosition:`, e);
    }

    // 2) If you're currently viewing the battle scene, also pan immediately
    try {
      if (canvas?.scene?.id === sceneId && canvas?.animatePan) {
        const dur = Math.max(0, safeNumber(durationMs, 0));
        await canvas.animatePan({ x, y, scale, duration: dur });
        log("animatePan applied (current view) ✅", { sceneId, dur });
      }
    } catch (e) {
      console.warn(`${tag} animatePan failed:`, e);
    }
  }

  // Socket listener
  game.socket.on(SOCKET_CHANNEL, async (msg) => {
    try {
      if (!msg || msg.type !== MSG_TYPE) return;

      const sceneId = String(msg?.sceneId ?? msg?.payload?.sceneId ?? "");
      if (!sceneId) return;

      const view = msg?.payload?.view ?? msg?.view ?? null;
      const durationMs = msg?.payload?.durationMs ?? msg?.durationMs ?? 0;

      log("Received CameraReset ✅", msg);
      await applyReset(sceneId, view, durationMs);
    } catch (err) {
      console.error(`${tag} handler error:`, err);
    }
  });

  log("Installed. Listening on:", SOCKET_CHANNEL);
});
