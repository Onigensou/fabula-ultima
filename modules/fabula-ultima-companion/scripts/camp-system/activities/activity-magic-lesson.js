// ============================================================================
// Camp Activity — Magic Lesson
// Target: One ally
// Effect: Choose a spell you know. Once before the next rest, the target may
//         cast that spell (still paying MP cost and performing checks).
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("magic_lesson", {
      async execute(actor, _scene) {
        // TODO: Prompt actor to choose a spell from their list and a target ally.
        // Apply a flag on the ally granting access to that spell for one use.
        ui.notifications?.info(`${actor?.name ?? "?"}: Magic Lesson — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
