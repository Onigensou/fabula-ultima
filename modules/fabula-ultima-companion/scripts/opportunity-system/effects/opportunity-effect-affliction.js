// ============================================================================
// Opportunity Effect — Affliction
//
// Effect: A creature suffers dazed, shaken, slow, or weak (GM's choice on behalf
// of the player).
//
// Implementation: GM picks the status from a 4-button dialog, then picks a
// target token from the scene. Creates an ActiveEffect on the target actor
// using the icon from CONFIG.statusEffects.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Affliction]";

  const STATUSES    = ["dazed", "shaken", "slow", "weak"];
  const STATUS_LABEL = { dazed: "Dazed", shaken: "Shaken", slow: "Slow", weak: "Weak" };

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("affliction", async (ctx) => {
      const { resolveActor, pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!resolveActor || !pickToken) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      const esc = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

      // Step 1: pick status
      const status = await new Promise(resolve => {
        const buttons = {};
        STATUSES.forEach(s => { buttons[s] = { label: STATUS_LABEL[s], callback: () => resolve(s) }; });
        buttons.cancel = { label: "Cancel", callback: () => resolve(null) };
        new Dialog({
          title:   "Affliction — Choose Status",
          content: `<p style="margin:4px 0 8px;">
                      <strong>${esc(ctx.actorName)}</strong> inflicts a status. Which one?
                    </p>`,
          buttons,
          default: "dazed",
          close:   () => resolve(null),
        }).render(true);
      });
      if (!status) return;

      // Step 2: pick target (exclude the afflicting actor)
      const token = await pickToken({
        title:          "Affliction — Choose Target",
        sourceActorUuid: ctx.actorUuid,
      });
      if (!token) return;

      // Step 3: resolve icon from CONFIG.statusEffects; fall back gracefully
      const cfgStatus = CONFIG.statusEffects?.find(s => s.id === status);
      const icon      = cfgStatus?.icon ?? "icons/svg/mystery-man.svg";

      await token.actor.createEmbeddedDocuments("ActiveEffect", [{
        name:     STATUS_LABEL[status],
        label:    STATUS_LABEL[status],
        statuses: [status],
        icon,
      }]).catch(e => console.error(TAG, "AE creation failed:", e));
    });
  });
})();
