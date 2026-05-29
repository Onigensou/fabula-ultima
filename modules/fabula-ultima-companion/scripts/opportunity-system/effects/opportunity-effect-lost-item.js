// ============================================================================
// Opportunity Effect — Lost Item
//
// Effect: An item is destroyed, lost, stolen, or left behind.
//
// TODO: open an item-picker for the target actor's inventory, then remove or
//       flag the item as lost.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:LostItem]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("lost_item", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
