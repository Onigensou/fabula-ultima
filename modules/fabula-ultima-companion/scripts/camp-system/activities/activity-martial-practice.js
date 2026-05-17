// ============================================================================
// Camp Activity — Martial Practice
// Target: Yourself
// Effect: Once before the next rest, when you perform an attack, you may grant
//         that attack multi (2) or increase its multi property by one.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("martial_practice", {
      async execute(actor, _scene) {
        // TODO: Apply a "Martial Practice" flag/effect on the actor
        // (consumed on first attack, grants multi (2) or +1 to existing multi).
        ui.notifications?.info(`${actor?.name ?? "?"}: Martial Practice — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
