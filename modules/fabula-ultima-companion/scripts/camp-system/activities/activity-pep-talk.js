// ============================================================================
// Camp Activity — Pep Talk
// Target: One ally
// Effect: Once before the next rest, if the target is about to recover MP,
//         they may double the amount recovered.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("pep_talk", {
      async execute(actor, _scene) {
        // TODO: Prompt to choose an ally, then apply a "Pep Talk" flag/effect
        // that doubles the next MP recovery (consumed on use).
        ui.notifications?.info(`${actor?.name ?? "?"}: Pep Talk — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
