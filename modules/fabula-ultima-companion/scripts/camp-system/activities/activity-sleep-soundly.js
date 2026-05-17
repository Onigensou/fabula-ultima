// ============================================================================
// Camp Activity — Sleep Soundly
// Target: Yourself
// Effect: Once before the next rest, you may perform an additional action on
//         your turn during a conflict scene (Equipment, Hinder, or Inventory).
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("sleep_soundly", {
      async execute(actor, _scene) {
        // TODO: Apply a "Sleep Soundly" flag/effect on the actor granting one
        // additional Equipment/Hinder/Inventory action during combat (consumed on use).
        ui.notifications?.info(`${actor?.name ?? "?"}: Sleep Soundly — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
