// ============================================================================
// Opportunity Effect — Advantage
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Advantage]";
  const MODULE_ID = "fabula-ultima-companion";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("advantage", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { resolveActor } = window["oni.OppEffectUtils"] ?? {};
      if (!resolveActor) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] resolving actor from UUID:", ctx.actorUuid);
      const actor = await resolveActor(ctx.actorUuid);
      console.debug(TAG, "[step 1] resolved actor:", actor ? `${actor.name} (id=${actor.id})` : "NULL");
      if (!actor) { console.warn(TAG, "[exit] could not resolve actor"); return; }

      console.debug(TAG, "[step 2] creating Advantage AE (charges=1) on actor...");
      const created = await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:  "Advantage",
        label: "Advantage",
        icon:  "icons/magic/control/debuff-arrows-up-gold.webp",
        flags: {
          [MODULE_ID]: {
            charges:    1,
            chargesMax: 1,
            chargeKey:  "opportunityAdvantage",
          },
        },
      }]).catch(e => { console.error(TAG, "[step 2] AE creation failed:", e); return null; });

      console.debug(TAG, "[done] AE created:", created ? created.map(e => e.id) : "FAILED");
    });
  });
})();
