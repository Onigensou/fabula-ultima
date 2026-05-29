// ============================================================================
// Opportunity Effect — Lost Item
//
// Effect: An item is destroyed, lost, stolen, or left behind.
//
// Implementation: GM picks a target token (any creature on the scene), then
// picks one of their items from a dropdown. After confirmation the item is
// deleted from the actor's inventory.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:LostItem]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("lost_item", async (ctx) => {
      const { pickToken, pickItem } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken || !pickItem) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      // Step 1: pick whose item is lost (any token on scene)
      const token = await pickToken({ title: "Lost Item — Choose Actor" });
      if (!token) return;

      const actor = token.actor;

      // Step 2: pick which item
      const item = await pickItem(actor);
      if (!item) return;

      // Step 3: confirm before deleting
      const confirmed = await Dialog.confirm({
        title:   "Lost Item — Confirm",
        content: `<p>Remove <strong>${esc(item.name)}</strong> from <strong>${esc(actor.name)}</strong>?</p>`,
        yes:     () => true,
        no:      () => false,
      }).catch(() => false);
      if (!confirmed) return;

      await item.delete()
        .catch(e => console.error(TAG, "Item deletion failed:", e));
    });
  });
})();
