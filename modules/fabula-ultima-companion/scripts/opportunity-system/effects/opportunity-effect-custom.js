// ============================================================================
// Opportunity Effect — Custom
//
// Effect: A different twist proposed by the player and approved by the GM.
//
// Implementation: GM types the agreed-upon twist and posts it publicly.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Custom]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("custom", async (ctx) => {
      const { gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
      if (!gmTextPrompt) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      const text = await gmTextPrompt({
        title:       "Custom Opportunity",
        label:       `Describe the agreed-upon twist for <strong>${esc(ctx.actorName)}</strong>:`,
        placeholder: "Describe what happens…",
      });
      if (!text) return;

      const accent  = "#5a5a5a";
      const content = `
        <div style="
          font-family:'Signika',serif; padding:10px 13px; border-radius:10px;
          background:linear-gradient(160deg,#141414 0%,#1e1e1e 100%);
          border:2px solid ${esc(accent)}; color:#d8d8d8;
        ">
          <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
            <i class="fas fa-pen-to-square" style="margin-right:4px;"></i>
            Custom Twist — ${esc(ctx.actorName)}
          </div>
          <div style="font-size:.88rem;line-height:1.55;">${esc(text)}</div>
        </div>`;

      await ChatMessage.create({ content })
        .catch(e => console.error(TAG, "Failed to post custom card:", e));
    });
  });
})();
