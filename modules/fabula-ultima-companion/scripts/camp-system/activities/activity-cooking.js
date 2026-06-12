// ============================================================================
// Camp Activity — Cooking
// Target: Yourself + up to 3 allies
// Effect: Party hot-pot. Everyone contributes one ingredient; the cooker leads
// an open-lobby group check; the pot resolves into a dish whose buff lasts
// until the next rest. Thin wrapper — all logic lives in
// FUCompanion.api.cooking (scripts/cooking-system/cooking-api.js).
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("cooking", {
      async execute(actor, _scene) {
        const cooking = globalThis.FUCompanion?.api?.cooking;
        if (!cooking) {
          ui.notifications?.error("Cooking API not loaded.");
          return;
        }
        try {
          await cooking.start({ cookerUuid: actor?.uuid });
        } catch (e) {
          console.error("[CampSystem][Cooking] session failed:", e);
          ui.notifications?.error(`Cooking failed: ${e.message}`);
        }
      },
    });
  });
})();
