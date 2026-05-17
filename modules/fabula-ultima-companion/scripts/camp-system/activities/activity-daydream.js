// ============================================================================
// Camp Activity — Daydream
// Target: Yourself
// Effect: Once before the next rest, when you lose Hit Points for any reason,
//         you may choose to halve that HP loss.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("daydream", {
      async execute(actor, _scene) {
        // TODO: Apply a "Daydream" flag/effect on the actor that halves the
        // next incoming HP loss (consumed on use, expires on rest).
        ui.notifications?.info(`${actor?.name ?? "?"}: Daydream — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
