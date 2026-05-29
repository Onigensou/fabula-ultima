// ============================================================================
// Opportunity Effect — Custom
//
// Effect: Propose a different twist that fits the current scene.
//         Requires GM approval (gmApproveNeeded = true in config).
//
// TODO: open a GM text-input dialog, then post the custom twist as a chat card.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Custom]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("custom", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
