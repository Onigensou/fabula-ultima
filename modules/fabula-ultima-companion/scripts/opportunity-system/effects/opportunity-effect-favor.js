// ============================================================================
// Opportunity Effect — Favor
//
// Effect: Your actions earn you someone's support or admiration.
//
// Narrative only — no mechanical automation. The opportunity chat card already
// announces the result to all players.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Favor]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("favor", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
