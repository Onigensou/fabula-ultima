// ============================================================================
// Camp Activity — Sing
// Target: One ally
// Requires: Chanter or Dancer
// Effect: Choose one attribute (DEX, INS, MIG, WLP). The target's chosen
//         attribute increases by one stage until the end of their next rest.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("sing", {
      async execute(actor, _scene) {
        // TODO: Prompt caster to choose target ally and attribute; apply a
        // one-stage attribute bonus AE that clears at next rest.
        ui.notifications?.info(`${actor?.name ?? "?"}: Sing — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
