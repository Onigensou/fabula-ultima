// ============================================================================
// Opportunity Effect — Lucky (Bunny Tail)
//
// 【⏳Lucky】 "Roll 5d100. You gain Zenit equal to the result."
//
// Self-only, no targeting → post-only handler (no `pre`). Gated to Bunny Tail
// wearers by `requiresFlag: "opp_lucky"` on the config option
// (opportunity-config.js), so it only appears in the picker for actors whose
// equipped Bunny Tail sets that flag.
//
// The post handler rolls 5d100, adds the total to the actor's Zenit
// (system.props.zenit), and RETURNS `{ resultSummary }` — the manager folds that
// onto the generic "Opportunity Spent" result card (opportunity-chat-card.js), so
// the single final card the player reads shows the dice + Zenit gained (rather
// than posting a separate card that the generic card then buries).
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Lucky]";

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("lucky", {
      async post(ctx) {
        const resolveActor = window["oni.OppEffectUtils"]?.resolveActor;
        const actor = resolveActor ? await resolveActor(ctx.actorUuid) : null;
        if (!actor) { console.error(TAG, "actor not resolved:", ctx.actorUuid); return; }

        const roll = new Roll("5d100");
        await roll.evaluate();
        // Show the 3D dice if Dice So Nice is present (non-fatal if absent).
        try { await game.dice3d?.showForRoll(roll, game.user, true); } catch (_) {}

        const dice  = roll.dice?.[0]?.results?.map(r => r.result) ?? [];
        const total = Number(roll.total) || 0;

        const before = Math.max(0, Number(actor.system?.props?.zenit ?? 0));
        const after  = before + total;
        await actor.update({ "system.props.zenit": after });

        const diceHtml = dice.map(d => `
          <span style="display:inline-flex;align-items:center;justify-content:center;
            min-width:26px;height:22px;padding:0 4px;border-radius:5px;
            background:rgba(63,163,77,.18);border:1px solid rgba(63,163,77,.55);
            font-weight:800;font-size:.78rem;color:#bfeec8;">${d}</span>`).join("");

        console.debug(TAG, `+${total} Zenit (${before} -> ${after})`);

        // Surfaced on the generic result card (the final message the player sees).
        return {
          resultSummary: `
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px;">${diceHtml}</div>
            <div style="font-weight:900;">Rolled 5d100 = ${total}</div>
            <div style="opacity:.9;margin-top:2px;">
              <i class="fas fa-coins" style="color:#f0c040;margin-right:4px;"></i>+${total} Zenit
              &nbsp;·&nbsp; ${before} &rarr; ${after}
            </div>`,
        };
      },
    });
    console.debug(TAG, "Lucky effect registered.");
  });
})();
