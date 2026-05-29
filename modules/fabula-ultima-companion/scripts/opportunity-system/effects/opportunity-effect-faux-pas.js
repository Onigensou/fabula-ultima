// ============================================================================
// Opportunity Effect — Faux Pas
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:FauxPas]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

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
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] opening target picker...");
      const token = await pickToken({ title: "Faux Pas — Choose Creature", sourceActorUuid: ctx.actorUuid });
      console.debug(TAG, "[step 1] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      const targetActor  = token.actor;
      const controllerId = getControllerUserId(targetActor);
      const gmIds        = (game.users?.contents ?? []).filter(u => u.isGM).map(u => u.id);
      const whisper      = controllerId ? [controllerId, ...gmIds] : gmIds;
      console.debug(TAG, "[step 2] controller:", controllerId, "| whisper targets:", whisper);

      const promptContent = controllerId
        ? `<strong>${esc(game.users?.get(controllerId)?.name ?? "Player")}</strong>, your character <strong>${esc(targetActor.name)}</strong> makes a compromising statement. Choose what they say.`
        : `<strong>${esc(targetActor.name)}</strong> makes a compromising statement. The GM decides what they say.`;

      const accent  = "#8a6c2a";
      const content = `
        <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
          background:linear-gradient(160deg,#1a1507 0%,#261e0a 100%);
          border:2px solid ${esc(accent)};color:#f0d88a;">
          <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
            <i class="fas fa-comment-slash" style="margin-right:4px;"></i>Faux Pas — ${esc(ctx.actorName)}
          </div>
          <div style="font-size:.88rem;line-height:1.55;">${promptContent}</div>
        </div>`;

      console.debug(TAG, "[step 3] posting whisper card...");
      await ChatMessage.create({ content, whisper })
        .catch(e => console.error(TAG, "[step 3] ChatMessage.create failed:", e));
      console.debug(TAG, "[done]");
    });
  });
})();
