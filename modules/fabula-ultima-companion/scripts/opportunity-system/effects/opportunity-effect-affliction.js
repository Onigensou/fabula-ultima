// ============================================================================
// Opportunity Effect — Affliction
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Affliction]";

  const STATUSES     = ["dazed", "shaken", "slow", "weak"];
  const STATUS_LABEL = { dazed: "Dazed", shaken: "Shaken", slow: "Slow", weak: "Weak" };

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("affliction", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

      // Step 1: pick status
      console.debug(TAG, "[step 1] opening status picker dialog...");
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
      console.debug(TAG, "[step 1] status chosen:", status);
      if (!status) { console.debug(TAG, "[exit] status picker cancelled"); return; }

      // Step 2: pick target
      console.debug(TAG, "[step 2] opening target picker...");
      const token = await pickToken({ title: "Affliction — Choose Target", sourceActorUuid: ctx.actorUuid });
      console.debug(TAG, "[step 2] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      // Step 3: resolve icon and apply AE
      const cfgStatus = CONFIG.statusEffects?.find(s => s.id === status);
      const icon      = cfgStatus?.icon ?? "icons/svg/mystery-man.svg";
      console.debug(TAG, "[step 3] applying AE to", token.name, "| status:", status, "| icon:", icon);

      const created = await token.actor.createEmbeddedDocuments("ActiveEffect", [{
        name:     STATUS_LABEL[status],
        label:    STATUS_LABEL[status],
        statuses: [status],
        icon,
      }]).catch(e => { console.error(TAG, "[step 3] AE creation failed:", e); return null; });

      console.debug(TAG, "[done] AE applied:", created ? created.map(e => e.id) : "FAILED");
    });
  });
})();
