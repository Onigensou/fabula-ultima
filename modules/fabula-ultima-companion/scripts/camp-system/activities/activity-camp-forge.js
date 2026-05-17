// ============================================================================
// Camp Activity — Camp Forge
// Target: Yourself
// Effect: Repair a damaged item; or create a basic weapon/armor/shield without
//         paying its cost; or destroy equipment to obtain a material of equal value.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("camp_forge", {
      async execute(actor, _scene) {
        // TODO: Implement Camp Forge mini-game
        // Possible approach: dialog prompting repair / create / destroy choice,
        // then updating actor inventory accordingly.
        ui.notifications?.info(`${actor?.name ?? "?"}: Camp Forge — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
