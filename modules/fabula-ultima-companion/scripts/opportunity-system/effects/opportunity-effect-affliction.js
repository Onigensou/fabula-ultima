// ============================================================================
// Opportunity Effect — Affliction
//
// Flow (pre/post):
//   pre  — status picker + target picker; returns { status, tokenId, tokenUuid }
//   post — resolves token from pre-result and applies the status AE
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Affliction]";

  const STATUSES     = ["dazed", "shaken", "slow", "weak"];
  const STATUS_LABEL = { dazed: "Dazed", shaken: "Shaken", slow: "Slow", weak: "Weak" };

  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("affliction", {

      // ── Pre phase: all user decisions ──────────────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

        // Step 1: pick status
        console.debug(TAG, "[pre] opening status picker dialog...");
        const status = await new Promise(resolve => {
          const buttons = {};
          STATUSES.forEach(s => { buttons[s] = { label: STATUS_LABEL[s], callback: () => resolve(s) }; });
          buttons.cancel = { label: "Cancel", callback: () => resolve(null) };
          new Dialog({
            title:   "Affliction — Choose Status",
            content: `<p style="margin:4px 0 8px;"><strong>${esc(ctx.actorName)}</strong> inflicts a status. Which one?</p>`,
            buttons,
            default: "dazed",
            close:   () => resolve(null),
          }).render(true);
        });
        console.debug(TAG, "[pre] status chosen:", status);
        if (!status) { console.debug(TAG, "[pre] status picker cancelled"); return null; }

        // Step 2: pick target
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Affliction — Choose Target", sourceActorUuid: ctx.actorUuid });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        return { status, tokenId: token.id, tokenUuid: token.document?.uuid ?? null };
      },

      // ── Post phase: AE application ─────────────────────────────────────────
      async post(ctx, preResult) {
        const { status, tokenId, tokenUuid } = preResult ?? {};

        const token = resolveToken({ tokenId, tokenUuid });
        if (!token?.actor) { console.error(TAG, "[post] token not found on canvas", { tokenId, tokenUuid }); return; }

        const cfgStatus = CONFIG.statusEffects?.find(s => s.id === status);
        const icon      = cfgStatus?.icon ?? "icons/svg/mystery-man.svg";
        console.debug(TAG, "[post] applying AE to", token.actor.name, "| status:", status, "| icon:", icon);

        const created = await token.actor.createEmbeddedDocuments("ActiveEffect", [{
          name:     STATUS_LABEL[status],
          label:    STATUS_LABEL[status],
          statuses: [status],
          icon,
        }]).catch(e => { console.error(TAG, "[post] AE creation failed:", e); return null; });

        console.debug(TAG, "[done] AE applied:", created ? created.map(e => e.id) : "FAILED");
      },
    });
  });
})();
