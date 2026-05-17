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

    // Stagger non-initiator reloads so clients don't all disconnect simultaneously.
    // Simultaneous mass-disconnect crashes the local Foundry V12 Electron app at 3+ clients.
    const activeNonInitiators = game.users.contents
      .filter(u => u.active && u.id !== initiatorId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const myIndex = activeNonInitiators.findIndex(u => u.id === game.userId);
    const staggerMs = myIndex >= 0 ? myIndex * 600 : 0;
    setTimeout(() => location.reload(), Math.max(0, delayMs + staggerMs));
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
