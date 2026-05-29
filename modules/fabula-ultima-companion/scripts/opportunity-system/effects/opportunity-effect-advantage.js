// ============================================================================
// Opportunity Effect — Advantage
//
// Effect: The next Check performed by the actor or an ally receives a +4 bonus.
//
// Implementation: applies a charged AE (charges=1, chargeKey="opportunityAdvantage")
// to the actor's world record. The CheckRoller pipeline step registered in
// opportunity-action-hook.js consumes the charge before dice are rolled and
// injects +4 into payload.check.modifier.parts.
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Advantage]";
  const MODULE_ID = "fabula-ultima-companion";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("advantage", async (ctx) => {
      const { resolveActor } = window["oni.OppEffectUtils"] ?? {};
      if (!resolveActor) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      const actor = await resolveActor(ctx.actorUuid);
      if (!actor) { console.warn(TAG, "Could not resolve actor", ctx.actorUuid); return; }

      await actor.createEmbeddedDocuments("ActiveEffect", [{
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
      }]).catch(e => console.error(TAG, "AE creation failed:", e));
    });
  });
})();
