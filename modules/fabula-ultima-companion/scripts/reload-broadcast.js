/* ============================================
 *  ONI - Reload Broadcast Listener (Foundry V12)
 *  File: reload-broadcast.js
 * ============================================
 *  Listens for "FU_RELOAD_CLIENTS" on the module socket
 *  and triggers a client-side page reload (location.reload).
 *
 *  Pairs with the "Reload All Clients" world macro, which
 *  emits the broadcast. The world itself is not affected —
 *  only each client's page reloads, re-fetching scripts.
 *
 *  Debug toggle:
 *    globalThis.ONI_RELOAD_BROADCAST_DEBUG = true/false
 * ============================================ */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const MSG_TYPE = "FU_RELOAD_CLIENTS";
  const TAG = "[ONI][ReloadBroadcast]";

  const DEBUG =
    typeof globalThis.ONI_RELOAD_BROADCAST_DEBUG === "boolean"
      ? globalThis.ONI_RELOAD_BROADCAST_DEBUG
      : false;
  const log = (...a) => DEBUG && console.log(TAG, ...a);

  function onSocketMessage(payload) {
    if (!payload || payload.type !== MSG_TYPE) return;

    const initiatorId = payload.initiatorId ?? null;
    const initiatorName = payload.initiatorName ?? "GM";
    const delayMs = Number.isFinite(payload.delayMs) ? payload.delayMs : 800;

    log("Reload requested by:", initiatorName, "(", initiatorId, ")");

    // The initiator already reloads itself in the macro — skip echo.
    if (initiatorId && initiatorId === game.userId) {
      log("Skip self-echo");
      return;
    }

    try {
      ui.notifications?.warn(
        `${initiatorName} requested a client reload — reloading…`,
        { permanent: false }
      );
    } catch (_) { /* noop */ }

    setTimeout(() => location.reload(), Math.max(0, delayMs));
  }

  Hooks.once("ready", () => {
    if (!game?.socket) {
      console.warn(TAG, "game.socket unavailable; reload listener not installed");
      return;
    }
    game.socket.off(SOCKET_NS, onSocketMessage);
    game.socket.on(SOCKET_NS, onSocketMessage);
    log("Listener installed on", SOCKET_NS);
  });
})();
