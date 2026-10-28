// ============================================================================
// Camp Activity — Camp Forge
// Target: Yourself
// Effect: Field Attune — attune any number of sockets on one piece of your own
//         gear, free, one attempt (Orbment v3: scripts/orbment/camp-forge.js).
//         The rulebook's Repair / Craft basic gear / Salvage options show as
//         locked placeholders in the same window until they're built.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][CampForge]";
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("camp_forge", {
      async execute(actor, _scene) {
        const run = globalThis.FUCompanion?.api?.orbment?.campForge;
        if (typeof run !== "function") {
          console.warn(TAG, "Orbment Camp Forge not loaded; skipping for", actor?.name);
          ui.notifications?.warn(`${actor?.name ?? "?"}: Camp Forge isn't available right now.`);
          await new Promise(r => setTimeout(r, 1000));
          return;
        }
        await run(actor);
      },
    });
  });
})();
