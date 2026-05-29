// ============================================================================
// Opportunity Effect — Information
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Information]";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("information", async (ctx) => {
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { resolveOwnerUserId } = window["oni.OppEffectUtils"] ?? {};

      console.debug(TAG, "[step 1] opening GM text dialog...");
      const detail = await new Promise(resolve => {
        new Dialog({
          title:   "Information — Discovered Detail",
          content: `<div style="padding:4px 0 8px;">
            <p style="margin:0 0 6px;">What does <strong>${esc(ctx.actorName)}</strong> discover?</p>
            <textarea id="oni-opp-info-text" rows="3" placeholder="Describe the clue or detail…"
              style="width:100%;padding:6px;resize:vertical;box-sizing:border-box;"></textarea>
            <div style="margin-top:8px;display:flex;align-items:center;gap:7px;">
              <input type="checkbox" id="oni-opp-info-whisper" checked />
              <label for="oni-opp-info-whisper" style="cursor:pointer;font-size:.88em;">Whisper to discovering player only</label>
            </div>
          </div>`,
          buttons: {
            confirm: {
              label: "Post",
              callback: html => {
                const text    = String(html.find("#oni-opp-info-text").val() ?? "").trim();
                const whisper = html.find("#oni-opp-info-whisper").prop("checked") ?? true;
                resolve(text ? { text, whisper } : null);
              },
            },
            cancel: { label: "Cancel", callback: () => resolve(null) },
          },
          default: "confirm",
          close:   () => resolve(null),
        }).render(true);
      });
      console.debug(TAG, "[step 1] dialog result:", detail ? { textLength: detail.text.length, whisper: detail.whisper } : "NULL");
      if (!detail) { console.debug(TAG, "[exit] dialog cancelled or empty"); return; }

      // Step 2: resolve whisper targets
      let whisperIds = [];
      if (detail.whisper) {
        const ownerId = resolveOwnerUserId?.(ctx.actorUuid) ?? null;
        const gmIds   = (game.users?.contents ?? []).filter(u => u.isGM).map(u => u.id);
        whisperIds    = ownerId ? [ownerId, ...gmIds] : gmIds;
        console.debug(TAG, "[step 2] whisper targets:", whisperIds, "| ownerId:", ownerId);
      } else {
        console.debug(TAG, "[step 2] posting publicly");
      }

      const accent  = "#4c7a8a";
      const content = `
        <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
          background:linear-gradient(160deg,#0d1a20 0%,#102030 100%);
          border:2px solid ${esc(accent)};color:#c8e8f0;">
          <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
            <i class="fas fa-magnifying-glass" style="margin-right:4px;"></i>Information — ${esc(ctx.actorName)}
          </div>
          <div style="font-size:.88rem;line-height:1.55;">${esc(detail.text)}</div>
        </div>`;

      console.debug(TAG, "[step 3] posting chat card...");
      await ChatMessage.create({ content, whisper: whisperIds })
        .catch(e => console.error(TAG, "[step 3] ChatMessage.create failed:", e));
      console.debug(TAG, "[done]");
    });
  });
})();
