// ============================================================================
// [BattleEnd: CameraReset] • Foundry VTT v12 (GM-only broadcaster)
// ----------------------------------------------------------------------------
// Purpose:
// - Reset the *battle scene* camera back to a known default position for ALL
//   clients, so the next battle starts with a clean camera.
//
// How it works:
// - Sends a socket message on module.fabula-ultima-companion
// - Each client must have [BattleEnd: CameraReset Listener] installed
//   (run once per session per client, e.g. via Dev Bootstrap).
//
// Default reset target (from Oni):
//   X = 771
//   Y = 339
//   Zoom = 1.2687237223069694
// ============================================================================

(async () => {
  const DEBUG = false;
  const tag = "[BattleEnd:CameraReset]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TYPE = "ONI_BATTLEEND_CAMERA_RESET";

  // Default camera placement to reset to
  const RESET_VIEW = {
    x: 771,
    y: 339,
    scale: 1.2687237223069694
  };

  // Optional: if client is currently on the battle scene, animate quickly
  const DURATION_MS = 250;

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: CameraReset is GM-only.");
    return;
  }

  // --------------------------------------------------------------------------
  // Determine battle scene id
  // Prefer __PAYLOAD injected by Manager (because Cleanup clears canonical flag)
  // --------------------------------------------------------------------------
  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function pickLatestPayloadAcrossScenes() {
    const STORE_SCOPE = "world";
    const CANONICAL_KEY = "battleInit.latestPayload";
    let best = null;

    for (const s of (game.scenes?.contents ?? [])) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }
    return best; // can be null
  }

  function locateBattleSceneIdBestEffort() {
    // 1) Injected by manager (preferred)
    const p = globalThis.__PAYLOAD;
    const viaInjected =
      p?.step4?.battleScene?.id ??
      p?.context?.battleSceneId ??
      p?.battleSceneId ??
      null;

    if (viaInjected) return { battleSceneId: String(viaInjected), from: "__PAYLOAD" };

    // 2) If we're currently on battle scene, use active scene
    if (canvas?.scene?.id) {
      return { battleSceneId: String(canvas.scene.id), from: "canvas.scene.id" };
    }

    // 3) Fallback: newest canonical payload
    const best = pickLatestPayloadAcrossScenes();
    const fromPayload = best?.payload?.step4?.battleScene?.id ?? null;
    if (fromPayload) return { battleSceneId: String(fromPayload), from: "scene-scan-latest-payload" };

    return { battleSceneId: "", from: "missing" };
  }

  const found = locateBattleSceneIdBestEffort();
  if (!found.battleSceneId) {
    ui.notifications?.error?.("BattleEnd CameraReset: Could not determine battle scene id.");
    log("Missing battleSceneId.", found);
    return;
  }

  // --------------------------------------------------------------------------
  // Broadcast
  // --------------------------------------------------------------------------
  const msg = {
    type: MSG_TYPE,
    sceneId: found.battleSceneId,
    payload: {
      runId: `camreset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sceneId: found.battleSceneId,
      view: RESET_VIEW,
      durationMs: DURATION_MS
    }
  };

  try {
    game.socket.emit(SOCKET_CHANNEL, msg);
    log("Socket emit sent ✅", { channel: SOCKET_CHANNEL, type: MSG_TYPE, battleSceneId: found.battleSceneId, from: found.from });
  } catch (err) {
    ui.notifications?.warn?.("BattleEnd CameraReset: socket emit failed (players may not reset).");
    console.warn(`${tag} socket emit failed:`, err);
  }

  // ALSO apply locally on GM (socket may not echo back to sender)
  try {
    const sc = game.scenes?.get?.(found.battleSceneId);
    if (sc) sc._viewPosition = { ...RESET_VIEW };

    if (canvas?.scene?.id === found.battleSceneId && canvas?.animatePan) {
      await canvas.animatePan({ ...RESET_VIEW, duration: DURATION_MS });
    }

    log("Applied locally on GM ✅");
  } catch (e) {
    console.warn(`${tag} Local apply failed:`, e);
  }
})();
