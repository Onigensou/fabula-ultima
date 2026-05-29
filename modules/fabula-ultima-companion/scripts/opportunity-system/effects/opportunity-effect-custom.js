// ============================================================================
// Opportunity Effect — Custom
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Custom]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("custom", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
      if (!gmTextPrompt) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] opening GM text prompt...");
      const text = await gmTextPrompt({
        title:       "Custom Opportunity",
        label:       `Describe the agreed-upon twist for <strong>${esc(ctx.actorName)}</strong>:`,
        placeholder: "Describe what happens…",
      });
      console.debug(TAG, "[step 1] text result:", text ? `length=${text.length}` : "NULL");
      if (!text) { console.debug(TAG, "[exit] GM text prompt cancelled"); return; }

      const accent  = "#5a5a5a";
      const content = `
        <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
          background:linear-gradient(160deg,#141414 0%,#1e1e1e 100%);
          border:2px solid ${esc(accent)};color:#d8d8d8;">
          <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
            <i class="fas fa-pen-to-square" style="margin-right:4px;"></i>Custom Twist — ${esc(ctx.actorName)}
          </div>
          <div style="font-size:.88rem;line-height:1.55;">${esc(text)}</div>
        </div>`;

      console.debug(TAG, "[step 2] posting chat card...");
      await ChatMessage.create({ content })
        .catch(e => console.error(TAG, "[step 2] ChatMessage.create failed:", e));
      console.debug(TAG, "[done]");
    });
  });
})();
