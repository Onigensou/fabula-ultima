// ============================================================================
// Opportunity Effect — Faux Pas
//
// Flow (pre/post):
//   pre  — target picker; returns { tokenId, tokenUuid, targetActorId }
//   post — resolves target actor, derives whisper list, posts styled chat card
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

  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("faux_pas", {

      // ── Pre phase: target selection ────────────────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Faux Pas — Choose Creature", sourceActorUuid: ctx.actorUuid });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        return {
          tokenId:       token.id,
          tokenUuid:     token.document?.uuid ?? null,
          targetActorId: token.actor?.id ?? null,
        };
      },

      // ── Post phase: post whisper card ──────────────────────────────────────
      async post(ctx, preResult) {
        const { tokenId, tokenUuid, targetActorId } = preResult ?? {};

        const token       = resolveToken({ tokenId, tokenUuid });
        const targetActor = token?.actor ?? game.actors?.get(targetActorId);
        if (!targetActor) { console.error(TAG, "[post] could not resolve target actor", { tokenId, targetActorId }); return; }

        const controllerId = getControllerUserId(targetActor);
        const gmIds        = (game.users?.contents ?? []).filter(u => u.isGM).map(u => u.id);
        const whisper      = controllerId ? [controllerId, ...gmIds] : gmIds;
        console.debug(TAG, "[post] controller:", controllerId, "| whisper targets:", whisper);

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

        console.debug(TAG, "[post] posting whisper card...");
        await ChatMessage.create({ content, whisper })
          .catch(e => console.error(TAG, "[post] ChatMessage.create failed:", e));
        console.debug(TAG, "[done]");
      },
    });
  });
})();
