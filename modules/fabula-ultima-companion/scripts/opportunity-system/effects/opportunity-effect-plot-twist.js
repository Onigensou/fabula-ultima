// ============================================================================
// Opportunity Effect — Plot Twist!
//
// Effect: Someone or something of your choice suddenly appears on the scene.
//
// Narrative only — no mechanical automation. The opportunity chat card already
// announces the result to all players.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:PlotTwist]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("plot_twist", {
      async post(ctx) {
        console.debug(TAG, "placeholder", ctx);
      },
    });
  });
})();
