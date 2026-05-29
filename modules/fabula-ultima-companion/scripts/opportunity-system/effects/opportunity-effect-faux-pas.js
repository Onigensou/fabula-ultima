// ============================================================================
// Opportunity Effect — Faux Pas
//
// Effect: A creature makes a compromising statement (chosen by its controller).
//
// Narrative only — no mechanical automation.
// TODO: send a notification card to the target creature's controlling player,
//       prompting them to roleplay the compromising statement.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:FauxPas]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("faux_pas", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
