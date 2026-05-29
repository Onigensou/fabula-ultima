// ============================================================================
// Opportunity Effect — Custom
//
// Flow (pre/post):
//   pre  — GM text prompt; returns { text }
//   post — posts the styled chat card
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Custom]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("custom", {

      // ── Pre phase: GM describes the twist ─────────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
        if (!gmTextPrompt) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        console.debug(TAG, "[pre] opening GM text prompt...");
        const text = await gmTextPrompt({
          title:       "Custom Opportunity",
          label:       `Describe the agreed-upon twist for <strong>${esc(ctx.actorName)}</strong>:`,
          placeholder: "Describe what happens…",
        });
        console.debug(TAG, "[pre] text result:", text ? `length=${text.length}` : "NULL");
        if (!text) { console.debug(TAG, "[pre] GM text prompt cancelled"); return null; }

        return { text };
      },

      // ── Post phase: post the styled chat card ──────────────────────────────
      async post(ctx, preResult) {
        const { text } = preResult ?? {};

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

        console.debug(TAG, "[post] posting chat card...");
        await ChatMessage.create({ content })
          .catch(e => console.error(TAG, "[post] ChatMessage.create failed:", e));
        console.debug(TAG, "[done]");
      },
    });
  });
})();
