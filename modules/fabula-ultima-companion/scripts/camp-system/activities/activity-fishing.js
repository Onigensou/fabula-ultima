// ============================================================================
// Camp Activity — Fishing
// Target: Yourself
// Effect: Roll 1d6 to determine the catch.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("fishing", {
      async execute(actor, _scene) {
        // TODO: Prompt description of fishing spot/method, roll 1d6, apply outcome.
        ui.notifications?.info(`${actor?.name ?? "?"}: Fishing — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
