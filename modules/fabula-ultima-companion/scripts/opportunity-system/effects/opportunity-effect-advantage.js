// ============================================================================
// Opportunity Effect — Advantage
//
// Effect: The next Check performed by the chosen ally (or yourself) receives
//         a +4 bonus.
//
// Implementation: GM picks an ally via the JRPG Targeting UI. A charged AE
// (charges=1, chargeKey="opportunityAdvantage") is placed on the target.
// The CheckRoller "opportunity-advantage" pipeline step (registered in
// opportunity-action-hook.js) consumes the charge before compute and injects
// +4 into payload.check.modifier.parts.
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:Advantage]";
  const MODULE_ID = "fabula-ultima-companion";

  const AE_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Elesis/DAS.png";
  const AE_DESC = "The next Check made by this creature receives a +4 bonus. Consumed automatically when a Check is rolled.";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("advantage", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      // Step 1: pick target ally
      console.debug(TAG, "[step 1] opening ally target picker...");
      const token = await pickToken({
        title:           "Advantage — Choose Target",
        skillTarget:     "One Ally",
        sourceActorUuid: ctx.actorUuid,
      });
      console.debug(TAG, "[step 1] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      // Step 2: apply charged AE to the target
      const targetActor = token.actor;
      console.debug(TAG, "[step 2] applying Advantage AE to:", targetActor.name, "(id=", targetActor.id, ")");

      const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
        name:        "Advantage",
        label:       "Advantage",
        description: AE_DESC,
        icon:        AE_ICON,
        flags: {
          [MODULE_ID]: {
            charges:    1,
            chargesMax: 1,
            chargeKey:  "opportunityAdvantage",
          },
        },
      }]).catch(e => { console.error(TAG, "[step 2] AE creation failed:", e); return null; });

      console.debug(TAG, "[done] AE created on", targetActor.name, ":", created ? created.map(e => e.id) : "FAILED");
    });
  });
})();
