// ============================================================================
// Camp Activity — Gathering
// Target: A character with the Gourmet Class
// Effect: Roll 1d6.
//   1 → Entire group caught in an easy conflict (level = group level)
//   2 → Target receives 2 ingredients (random tastes)
//   3-5 → Target receives 3 ingredients (random tastes)
//   6 → Target receives 3 ingredients (player's choice of taste)
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("gathering", {
      async execute(actor, _scene) {
        // TODO: Verify actor has Gourmet Class, roll 1d6, apply outcome.
        // May trigger a random battle on result 1.
        ui.notifications?.info(`${actor?.name ?? "?"}: Gathering — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
