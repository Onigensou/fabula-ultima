// ============================================================================
// Camp Activity — Curse
// Target: One Villain
// Requires: Hexer or Necromancer
// Effect: At the start of the next conflict scene containing a Villain,
//         that Villain is inflicted with a random debuff. Consumed on trigger
//         or clears at next rest.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("curse", {
      async execute(actor, _scene) {
        // TODO: Set a world flag marking the caster; hook into combat start to
        // detect a Villain token and apply a random status effect, then clear flag.
        ui.notifications?.info(`${actor?.name ?? "?"}: Curse — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
