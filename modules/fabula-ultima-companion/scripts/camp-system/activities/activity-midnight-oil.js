// ============================================================================
// Camp Activity — Midnight Oil
// Target: Yourself
// Effect: Generate 3 points of progress for a single Project of your choice.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("midnight_oil", {
      async execute(actor, _scene) {
        // TODO: Prompt actor to choose an active Project, then add 3 progress
        // points to it. Projects are stored in the actor's props.
        ui.notifications?.info(`${actor?.name ?? "?"}: Midnight Oil — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
