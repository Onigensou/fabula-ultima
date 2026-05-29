// ============================================================================
// Opportunity Effect — Progress
//
// Effect: Fill or erase up to two sections on a Clock.
//
// TODO: blocked until a Clock system exists. Placeholder until Clock
//       infrastructure is built; upgrade to a clock-picker + section updater
//       at that point.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Progress]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("progress", async (ctx) => {
      console.debug(TAG, "placeholder — needs clock system", ctx);
    });
  });
})();
