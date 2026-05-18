// ============================================================================
// Camp Activity — Meditate
// Target: Yourself
// Requires: Monk or Invoker
// Effect: Once before the next rest, when you spend MP, reduce that cost by 30
//         (minimum 0). Consumed on use.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("meditate", {
      async execute(actor, _scene) {
        // TODO: Apply an AE "Meditate" that grants -30 MP on the next MP spend.
        ui.notifications?.info(`${actor?.name ?? "?"}: Meditate — placeholder (to be implemented).`);
        await new Promise(r => setTimeout(r, 1000));
      },
    });
  });
})();
