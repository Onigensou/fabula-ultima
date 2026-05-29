// ============================================================================
// Opportunity Effect — Lost Item
//
// Flow (pre/post):
//   pre  — target picker + item picker + confirm dialog;
//          returns { tokenId, tokenUuid, itemId }
//   post — resolves actor and item from pre-result, then deletes the item
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:LostItem]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("lost_item", {

      // ── Pre phase: all user decisions ──────────────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken, pickItem } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken || !pickItem) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        // Step 1: pick target actor
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Lost Item — Choose Actor", sourceActorUuid: ctx.actorUuid });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        // Step 2: pick item from that actor
        console.debug(TAG, "[pre] opening item picker...");
        const item = await pickItem(token.actor);
        console.debug(TAG, "[pre] item picked:", item ? `${item.name} (id=${item.id})` : "NULL");
        if (!item) { console.debug(TAG, "[pre] item picker cancelled"); return null; }

        // Step 3: confirm deletion
        console.debug(TAG, "[pre] showing confirm dialog...");
        const confirmed = await Dialog.confirm({
          title:   "Lost Item — Confirm",
          content: `<p>Remove <strong>${esc(item.name)}</strong> from <strong>${esc(token.actor.name)}</strong>?</p>`,
          yes:     () => true,
          no:      () => false,
        }).catch(() => false);
        console.debug(TAG, "[pre] confirmed:", confirmed);
        if (!confirmed) { console.debug(TAG, "[pre] deletion not confirmed"); return null; }

        return { tokenId: token.id, tokenUuid: token.document?.uuid ?? null, itemId: item.id };
      },

      // ── Post phase: delete the item ────────────────────────────────────────
      async post(ctx, preResult) {
        const { tokenId, tokenUuid, itemId } = preResult ?? {};

        const token = resolveToken({ tokenId, tokenUuid });
        if (!token?.actor) { console.error(TAG, "[post] token not found on canvas", { tokenId, tokenUuid }); return; }

        const item = token.actor.items?.get(itemId);
        if (!item) { console.error(TAG, "[post] item not found:", itemId); return; }

        console.debug(TAG, "[post] deleting item:", item.name, `(id=${item.id})`);
        await item.delete()
          .catch(e => console.error(TAG, "[post] item.delete() failed:", e));
        console.debug(TAG, "[done] item deleted");
      },
    });
  });
})();
