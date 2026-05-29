// ============================================================================
// Opportunity Effect — Lost Item
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:LostItem]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("lost_item", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken, pickItem } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken || !pickItem) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] opening target picker...");
      const token = await pickToken({ title: "Lost Item — Choose Actor", sourceActorUuid: ctx.actorUuid });
      console.debug(TAG, "[step 1] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      const actor     = token.actor;
      const itemList  = Array.from(actor.items ?? []);
      console.debug(TAG, "[step 2] actor items:", itemList.map(i => `${i.name} (id=${i.id})`));

      console.debug(TAG, "[step 2] opening item picker...");
      const item = await pickItem(actor);
      console.debug(TAG, "[step 2] item picked:", item ? `${item.name} (id=${item.id})` : "NULL");
      if (!item) { console.debug(TAG, "[exit] item picker cancelled"); return; }

      console.debug(TAG, "[step 3] showing confirm dialog...");
      const confirmed = await Dialog.confirm({
        title:   "Lost Item — Confirm",
        content: `<p>Remove <strong>${esc(item.name)}</strong> from <strong>${esc(actor.name)}</strong>?</p>`,
        yes:     () => true,
        no:      () => false,
      }).catch(() => false);
      console.debug(TAG, "[step 3] confirmed:", confirmed);
      if (!confirmed) { console.debug(TAG, "[exit] deletion not confirmed"); return; }

      console.debug(TAG, "[step 4] deleting item...");
      await item.delete()
        .catch(e => console.error(TAG, "[step 4] item.delete() failed:", e));
      console.debug(TAG, "[done] item deleted");
    });
  });
})();
