// ============================================================================
// Camp Activity — Exploration
// Target: Yourself
// Effect: Roll 1d6.
//   1 → Recover half normal HP/MP during this rest (ouch!)
//   2 → Regain 2 Inventory Points
//   3-5 → Regain 3 Inventory Points
//   6 → Regain 3 Inventory Points + zenit equal to character level × 50
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("exploration", {
      async execute(actor, _scene) {
        // TODO: Roll 1d6 in chat and apply the appropriate outcome.
        // Outcomes affect actor's inventory points and/or zenit.
        ui.notifications?.info(`${actor?.name ?? "?"}: Exploration — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
