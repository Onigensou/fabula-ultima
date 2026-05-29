// ============================================================================
// Opportunity Effect — Bonding
//
// Effect: Create a Bond towards someone or add an emotion to an existing Bond.
//
// TODO: standalone bond-editor UI using BondUpdater.readBonds / writeSlot,
//       without the camp phase flow (no memory section, no confirm-and-wait).
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Bonding]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("bonding", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
