// ============================================================================
// Camp Activity — Massage
// Target: One ally
// Effect: Once before the next rest, if the target is about to pay an MP cost,
//         they may halve it. Cannot apply to a Ritual's MP cost.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("massage", {
      async execute(actor, _scene) {
        // TODO: Prompt to choose an ally, then apply a "Massage" flag/effect
        // that halves the next non-Ritual MP cost (consumed on use).
        ui.notifications?.info(`${actor?.name ?? "?"}: Massage — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
