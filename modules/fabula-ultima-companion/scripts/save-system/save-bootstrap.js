// ============================================================================
// Save System — Bootstrap
//
// Wires everything together on the "ready" hook (GM only).
// Exposes FUCompanion.api.saveSystem for macro / console access.
// Adds a 💾 button to the Token layer scene controls so the GM can open
// the save menu without typing in the console.
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const TAG = "[SaveSystem][Bootstrap]";

  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;

    // ── Expose on FUCompanion API ──────────────────────────────────────────
    const fu = globalThis.FUCompanion ??= {};
    fu.api   ??= {};
    fu.api.saveSystem = {
      /** Open the memory-card save/load UI. */
      open:    ()       => SS.UI.open(),
      /** Close the UI programmatically. */
      close:   ()       => SS.UI.close(),
      /** Save current world state to a slot (1–3). Returns { ok, label|error }. */
      save:    (slotId) => SS.Core.save(slotId),
      /** Restore world state from a slot. Returns { ok, label|error }. */
      load:    (slotId) => SS.Core.load(slotId),
      /** Read full slot blob from disk (async; null if empty). */
      getSlot: (slotId) => SS.Storage.getSlotFull(slotId),
    };

    console.log(TAG, "Ready. API exposed at FUCompanion.api.saveSystem");
    console.log(TAG, "  Open UI  → FUCompanion.api.saveSystem.open()");
    console.log(TAG, "  Quick save slot 1 → FUCompanion.api.saveSystem.save(1)");
    console.log(TAG, "  Quick load slot 1 → FUCompanion.api.saveSystem.load(1)");
  });

  // ── Scene controls button (💾 in the Token layer toolbar) ─────────────────
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;
    const tokenLayer = controls.find(c => c.name === "token");
    if (!tokenLayer) return;
    tokenLayer.tools.push({
      name:    "saveSystem",
      title:   "Save / Load Game",
      icon:    "fas fa-floppy-disk",
      button:  true,
      onClick: () => SS.UI.open(),
    });
  });

  console.debug(TAG, "Bootstrap loaded.");
})();
