// scripts/party-sync/party-sync-hook.js
// Hooks renderActorSheet so the party sheet auto-syncs the moment it opens,
// and normalizes portrait image scaling on every render.
//
// Re-entry flow:
//   open → sync runs → actor.update() → renderActorSheet fires again
//   → _synced guard blocks the second sync → portraits normalized → done.
//   close → ID removed from _synced so next open syncs fresh.

(() => {
  // Tracks app IDs whose first-open sync has already been dispatched.
  const _synced = new Set();

  // ── Portrait normalization ────────────────────────────────────────────────
  // CSB renders each image field inside a div whose CSS class includes the
  // field key (e.g. "member_sprite_1"). The container column is 613px wide
  // with no height constraint, so images must be sized on the <img> itself.
  // CSB already sets width:150px on slot 1 — we apply the same to all slots
  // so every portrait renders at the same width with proportional height.
  function normalizePortraits(el) {
    for (let i = 1; i <= 4; i++) {
      const container = el.querySelector(`.member_sprite_${i}`);
      const img = container?.querySelector("img");
      if (!img) continue;
      Object.assign(img.style, {
        width:     "150px",
        height:    "auto",
        objectFit: "contain",
      });
    }
  }

  // ── Main hook ─────────────────────────────────────────────────────────────
  async function onRenderActorSheet(app, html) {
    if (!game.user.isGM) return;

    // Fast pre-check: only party actors carry isParty_boolean
    if (!app.actor?.system?.props?.isParty_boolean) return;

    // Confirm this is the CURRENT game's party actor (DB resolver is cached — fast)
    const { db: partyActor } = (await window.FUCompanion?.api?.getCurrentGameDb?.()) ?? {};
    if (!partyActor || app.actor.id !== partyActor.id) return;

    // Normalize portraits on every render (first open shows stale data briefly,
    // but at least the scaling is already correct before sync completes)
    normalizePortraits(html[0]);

    // Second render (triggered by our own update) — portrait already normalized, done
    if (_synced.has(app.id)) return;

    _synced.add(app.id);
    await window.FUCompanion.api.syncPartySheet();
    // syncPartySheet's actor.update() will fire renderActorSheet again;
    // that call hits the guard above and only re-normalizes portraits.
  }

  function onCloseActorSheet(app) {
    _synced.delete(app.id);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    Hooks.on("renderActorSheet", onRenderActorSheet);
    Hooks.on("closeActorSheet",  onCloseActorSheet);
    console.debug("[PartySync] renderActorSheet hook registered.");
  });
})();
