// ============================================================================
// Camp Activity — Cartography
// Target: Yourself
// Effect: Once before the next rest, after your group makes a travel roll,
//         you may reroll the die and keep the new result.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("cartography", {
      async execute(actor, _scene) {
        // TODO: Apply a "Cartography" active effect or flag on the actor
        // that the travel-roll system can check to offer a reroll.
        ui.notifications?.info(`${actor?.name ?? "?"}: Cartography — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
