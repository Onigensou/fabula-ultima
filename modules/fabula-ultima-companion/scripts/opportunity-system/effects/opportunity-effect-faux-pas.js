// ============================================================================
// Opportunity Effect — Faux Pas
//
// Effect: Choose a creature on the scene — they make a compromising statement
//         chosen by the person who controls them.
//
// Implementation: GM picks the target token. A whispered prompt card is sent
// to that token's controlling player (or to all GMs if the creature is
// GM-controlled) asking them to roleplay the compromising statement.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:FauxPas]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  /** Find the first non-GM owner user ID for a given actor. */
  function getControllerUserId(actor) {
    for (const [userId, level] of Object.entries(actor?.ownership ?? {})) {
      if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
        const user = game.users?.get(userId);
        if (user && !user.isGM) return userId;
      }
    }
    return null;
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("faux_pas", async (ctx) => {
      const { pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      const token = await pickToken({ title: "Faux Pas — Choose Creature", sourceActorUuid: ctx.actorUuid });
      if (!token) return;

      const targetActor = token.actor;
      const controllerId = getControllerUserId(targetActor);

      // Whisper to the controller + all GMs; if GM-controlled, GMs only
      const gmIds    = (game.users?.contents ?? []).filter(u => u.isGM).map(u => u.id);
      const whisper  = controllerId ? [controllerId, ...gmIds] : gmIds;

      const promptContent = controllerId
        ? `<strong>${esc(game.users?.get(controllerId)?.name ?? "Player")}</strong>, your character <strong>${esc(targetActor.name)}</strong> makes a compromising statement. Choose what they say.`
        : `<strong>${esc(targetActor.name)}</strong> makes a compromising statement. The GM decides what they say.`;

      const accent  = "#8a6c2a";
      const content = `
        <div style="
          font-family:'Signika',serif; padding:10px 13px; border-radius:10px;
          background:linear-gradient(160deg,#1a1507 0%,#261e0a 100%);
          border:2px solid ${esc(accent)}; color:#f0d88a;
        ">
          <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
            <i class="fas fa-comment-slash" style="margin-right:4px;"></i>
            Faux Pas — ${esc(ctx.actorName)}
          </div>
          <div style="font-size:.88rem;line-height:1.55;">${promptContent}</div>
        </div>`;

      await ChatMessage.create({ content, whisper })
        .catch(e => console.error(TAG, "Failed to post faux pas card:", e));
    });
  });
})();
