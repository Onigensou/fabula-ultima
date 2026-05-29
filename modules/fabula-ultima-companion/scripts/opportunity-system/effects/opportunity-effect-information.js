// ============================================================================
// Opportunity Effect — Information
//
// Effect: Spot a useful clue or detail. GM tells the player what it is, or
//         asks them to introduce the detail themselves.
//
// TODO: open a GM text-input dialog, then post the result as a chat card
//       (whispered to the player, or public — GM's choice).
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Information]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("information", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
