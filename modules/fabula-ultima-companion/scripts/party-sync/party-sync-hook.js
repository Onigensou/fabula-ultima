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
  // CSB wraps each field in a container carrying a data-key attribute.
  // member_sprite_1..4 are the portrait image fields.
  function normalizePortraits(el) {
    // Primary: CSB data-key attribute on the field wrapper
    let imgs = el.querySelectorAll('[data-key^="member_sprite_"] img');

    // Fallback A: some CSB versions use data-field instead
    if (!imgs.length) imgs = el.querySelectorAll('[data-field^="member_sprite_"] img');

    // Fallback B: match by URL — portrait images live under /Portrait/ or end in _Portrait
    if (!imgs.length) {
      imgs = [...el.querySelectorAll("img")].filter(
        img => /\/Portrait\//i.test(img.src) || /_Portrait/i.test(img.src)
      );
    }

    for (const img of imgs) {
      Object.assign(img.style, {
        objectFit: "contain",
        width:     "100%",
        height:    "100%",
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
