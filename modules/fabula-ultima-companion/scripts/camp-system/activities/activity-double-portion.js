// ============================================================================
// Camp Activity — Double Portion
// Target: One ally
// Effect: Once before the next rest, if the target is about to recover HP,
//         they may double the amount recovered.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("double_portion", {
      async execute(actor, _scene) {
        // TODO: Prompt actor to choose an ally, then apply a "Double Portion"
        // flag/effect on that ally (doubles next HP recovery, consumed on use).
        ui.notifications?.info(`${actor?.name ?? "?"}: Double Portion — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
