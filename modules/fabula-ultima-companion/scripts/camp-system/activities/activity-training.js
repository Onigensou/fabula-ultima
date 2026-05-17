// ============================================================================
// Camp Activity — Training
// Target: Yourself
// Effect: Once before the next rest, if you are about to suffer one or more
//         status effects from the same source, you may choose to suffer none.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("training", {
      async execute(actor, _scene) {
        // TODO: Apply a "Training" flag/effect on the actor (consumed when
        // they next suffer a status effect — negates all effects from that source).
        ui.notifications?.info(`${actor?.name ?? "?"}: Training — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
