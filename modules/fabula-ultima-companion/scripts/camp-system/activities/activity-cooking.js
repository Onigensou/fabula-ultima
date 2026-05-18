// ============================================================================
// Camp Activity — Cooking
// Target: Yourself + up to 3 allies
// Effect: Cook a meal with bonded friends; meals grant benefits until next rest.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("cooking", {
      async execute(actor, _scene) {
        // TODO: Prompt cook to describe the meal; apply buff AE to self + chosen allies.
        ui.notifications?.info(`${actor?.name ?? "?"}: Cooking — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
