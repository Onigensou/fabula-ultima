// ============================================================================
// Camp Activity — Combat Lesson
// Target: One ally
// Effect: Once before the next rest, after the target makes an Accuracy Check
//         or Magic Check for an offensive spell, they may add +4 to the Result.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("combat_lesson", {
      async execute(actor, _scene) {
        // TODO: Prompt actor to choose a target ally, then apply a +4 bonus
        // flag/effect on the chosen ally valid until the next rest.
        ui.notifications?.info(`${actor?.name ?? "?"}: Combat Lesson — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
