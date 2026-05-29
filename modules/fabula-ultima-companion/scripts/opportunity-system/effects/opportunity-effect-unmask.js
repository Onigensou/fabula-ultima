// ============================================================================
// Opportunity Effect — Unmask
//
// Effect: Learn the goals and motivations of a creature of your choice.
//
// TODO: pick a target token; read and post their goals/motivations CSB field
//       (if the actor template has one), otherwise fall back to a GM text-input
//       dialog.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Unmask]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("unmask", async (ctx) => {
      console.debug(TAG, "placeholder", ctx);
    });
  });
})();
