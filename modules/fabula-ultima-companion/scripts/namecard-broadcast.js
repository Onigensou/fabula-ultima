// scripts/namecard-broadcast.js
// Broadcast a NameCard to all clients (and also show locally).
// Exposes: window.FUCompanion.api.namecardBroadcast({ title, options })

(() => {
  window.FUCompanion = window.FUCompanion || { api: {} };

  async function namecardBroadcast({ title, options = {} }) {
    // show locally first (feels snappy)
    try { await window.FUCompanion.api.showNameCardLocal?.(title, options); } catch (e) { console.warn(e); }
    // broadcast to everyone
    try {
      await game.socket?.emit?.("module.fabula-ultima-companion", {
        type: "namecard",
        title,
        options
      });
    } catch (e) {
      console.warn("[NameCard] broadcast failed:", e);
    }
  }

  window.FUCompanion.api.namecardBroadcast = namecardBroadcast;
})();
