// ============================================================================
// Camp Activity — Mending
// Target: One ally
// Requires: Spiritist, Tailor, or Wayfarer
// Effect: Target gains Shield equal to floor(level / 2).
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("mending", {
      async execute(actor, _scene) {
        // TODO: Prompt to choose an ally; apply Shield = floor(ally.system.props.level / 2).
        ui.notifications?.info(`${actor?.name ?? "?"}: Mending — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
