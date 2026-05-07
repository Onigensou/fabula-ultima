// ============================================================================
// [TreasureRoulette] UI Listener • Foundry VTT v12
// ----------------------------------------------------------------------------
// Run this ONCE per client per session (include in your Dev Bootstrap).
// Listens for Core broadcast "ONI_TR_PLAY_UI" and runs the roulette UI locally.
// After UI ends, sends UI_FINISHED ACK via TreasureRoulette Net (preferred).
// Falls back to raw socket emit if Net is not installed.
// ============================================================================

Hooks.once("ready", () => {
  const DEBUG = true;
  const tag = "[TreasureRoulette:UI:Listener]";
  const log = (...args) => DEBUG && console.log(tag, ...args);

  // Socket channel name (must match Core / module convention)
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  // Idempotent install guard
  if (window.__ONI_TREASURE_ROULETTE_UI_LISTENER_INSTALLED__ === true) {
    ui.notifications?.info?.("TreasureRoulette UI Listener: already installed on this client.");
    log("Already installed.");
    return;
  }
  window.__ONI_TREASURE_ROULETTE_UI_LISTENER_INSTALLED__ = true;

  async function runTreasureRouletteUI(packet) {
    const uiApi = window["oni.TreasureRoulette.UI"];
    if (!uiApi || typeof uiApi.play !== "function") {
      log("UI not installed on this client. Run [TreasureRoulette] UI macro first.");
      return { ok: false, reason: "ui-missing" };
    }
    return await uiApi.play(packet);
  }

  function ackUiFinished(packet) {
    // Preferred: Net helper (includes local loopback + socket emit)
    const net = window["oni.TreasureRoulette.Net"];
    if (net && typeof net.sendUiFinished === "function") {
      net.sendUiFinished(packet);
      return;
    }

    // Fallback: raw socket emit (NOTE: sender likely won't receive its own emit)
    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: "ONI_TR_UI_FINISHED",
        payload: {
          requestId: packet.requestId,
          userId: game.user?.id ?? null,
          finishedAt: Date.now()
        }
      });
    } catch (e) {
      console.warn("[TreasureRoulette:UI:Listener] Failed to emit UI_FINISHED ack:", e);
    }
  }

  // Socket listener
  game.socket.on(SOCKET_CHANNEL, async (msg) => {
    try {
      if (!msg || msg.type !== "ONI_TR_PLAY_UI") return;

      log("Received TreasureRoulette UI message ✅", msg);

      const packet = msg.payload;
      if (!packet || !packet.requestId) {
        log("Invalid packet, ignored:", packet);
        return;
      }

      // Let Net register packet early (so it knows expectedAcks, spinMs, etc.)
      try {
        window["oni.TreasureRoulette.Net"]?.registerPacket?.(packet);
      } catch {}

      // Play UI
      await runTreasureRouletteUI(packet);

      // After UI ends, ACK (so awarding can safely happen AFTER animation)
      ackUiFinished(packet);
    } catch (err) {
      console.error(`${tag} Socket handler error:`, err);
    }
  });
  log("Installed. Listening on:", SOCKET_CHANNEL);
})();
