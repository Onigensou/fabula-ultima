// ────────────────────────────────────────────────────────────────────────────
//  Reload All Clients (Admin)
//  Asks every connected user (including GM) to perform location.reload().
//  The world keeps running; only each browser page reloads, re-fetching the
//  module's scripts/styles. Useful after pulling fresh module code without
//  having to restart the world.
//
//  Pairs with scripts/reload-broadcast.js, which installs the receiver.
//  Requires: GM permission.
// ────────────────────────────────────────────────────────────────────────────
(async () => {
  if (!game.user?.isGM) {
    return ui.notifications.error("Reload All Clients: GM permission required.");
  }

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const MSG_TYPE = "FU_RELOAD_CLIENTS";
  const DELAY_MS = 800;
  // ms between each client's reload — ~one world-vend apart, so the host never
  // serializes the world for more than one client at a time. Three concurrent
  // reconnect-vends OOM the local Foundry V12 desktop host. Tune for party size.
  const STAGGER_MS = 12000;

  const userCount = game.users.filter(u => u.active).length;

  const confirmed = await new Promise(resolve => {
    new Dialog({
      title: "Reload All Clients",
      content: `
        <p>Reload <strong>${userCount}</strong> active client${userCount === 1 ? "" : "s"} (including yourself)?</p>
        <p style="opacity:.8;font-size:.9em;">
          The world stays running — only each player's browser page reloads.
          Anyone with unsaved chat input or open dialogs will lose them.
        </p>
      `,
      buttons: {
        ok: {
          icon: '<i class="fas fa-sync"></i>',
          label: "Reload All",
          callback: () => resolve(true)
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => resolve(false)
        }
      },
      default: "cancel",
      close: () => resolve(false)
    }).render(true);
  });

  if (!confirmed) return;

  try {
    game.socket.emit(SOCKET_NS, {
      type: MSG_TYPE,
      initiatorId: game.userId,
      initiatorName: game.user?.name ?? "GM",
      delayMs: DELAY_MS,
      staggerMs: STAGGER_MS
    });
  } catch (e) {
    console.error("[ReloadAllClients] socket emit failed:", e);
    return ui.notifications.error("Reload broadcast failed (see console).");
  }

  // reload-broadcast.js reloads each other client at DELAY_MS + index*STAGGER_MS
  // (ordered by user id), so clients reload one at a time ~a vend apart and the
  // host never serializes the world for more than one client at once. The GM
  // reloads AFTER all of them.
  const activePlayers = game.users.filter(u => u.active && u.id !== game.userId);
  const gmDelay = DELAY_MS + activePlayers.length * STAGGER_MS;
  const totalSecs = Math.ceil(gmDelay / 1000);
  ui.notifications.info(`Reload sent — clients reload one at a time; you reload in ~${totalSecs}s…`);
  setTimeout(() => location.reload(), gmDelay);
})();
