// ============================================================================
// Camp Activity — Planning
// Target: One ally
// Effect: Once before the next rest, after the target performs a Group Check
//         as leader or a Check to examine someone/something, they may add +4.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("planning", {
      async execute(actor, _scene) {
        // TODO: Prompt to choose an ally, then apply a "Planning" flag/effect
        // granting +4 to their next qualifying Group Check or Examine Check.
        ui.notifications?.info(`${actor?.name ?? "?"}: Planning — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
