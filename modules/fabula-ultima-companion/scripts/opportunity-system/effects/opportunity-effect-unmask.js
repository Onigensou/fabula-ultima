// ============================================================================
// Opportunity Effect — Unmask
//
// Effect: Learn the goals and motivations of a creature of your choice.
//
// Implementation: GM picks a target token. If the actor has a known
// goals/motivations CSB prop field, its content is posted directly.
// Otherwise the GM types the information manually.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Unmask]";

  // CSB prop field names to probe, in priority order
  const MOTIVATION_FIELDS = [
    "motivation", "motivations", "goals", "goal",
    "npc_goal", "enemy_goal", "enemy_motivation", "npc_motivation",
  ];

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  async function postUnmaskCard({ actorName, actorPortrait, content }) {
    const accent = "#6a2a6a";
    const html   = `
      <div style="
        font-family:'Signika',serif; padding:10px 13px; border-radius:10px;
        background:linear-gradient(160deg,#190d19 0%,#240e24 100%);
        border:2px solid ${esc(accent)}; color:#e8c8e8;
      ">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <img src="${esc(actorPortrait)}"
               style="width:40px;height:40px;object-fit:contain;border:none!important;background:transparent!important;box-shadow:none!important;border-radius:0!important;"
               onerror="this.src='icons/svg/mystery-man.svg'" />
          <div>
            <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;">
              <i class="fas fa-mask" style="margin-right:4px;"></i>Unmask
            </div>
            <div style="font-weight:900;font-size:.95rem;">${esc(actorName)}</div>
          </div>
        </div>
        <div style="font-size:.82rem;line-height:1.55;border-top:1px solid ${esc(accent)}55;padding-top:7px;">
          ${content}
        </div>
      </div>`;

    await ChatMessage.create({ content: html })
      .catch(e => console.error(TAG, "postUnmaskCard failed:", e));
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("unmask", async (ctx) => {
      const { pickToken, gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken || !gmTextPrompt) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      const token = await pickToken({ title: "Unmask — Choose Creature", sourceActorUuid: ctx.actorUuid });
      if (!token) return;

      const targetActor = token.actor;
      const props       = targetActor.system?.props ?? {};

      const portrait = String(props.sprite_standard ?? "").trim()
        || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
        || targetActor.img
        || "icons/svg/mystery-man.svg";

      // Probe known field names for goals/motivations content
      let rawContent = "";
      for (const field of MOTIVATION_FIELDS) {
        const val = String(props[field] ?? "").trim();
        if (val) { rawContent = val; break; }
      }

      if (rawContent) {
        await postUnmaskCard({ actorName: targetActor.name, actorPortrait: portrait, content: rawContent });
        return;
      }

      // No field found — GM enters the information manually
      const text = await gmTextPrompt({
        title:       `Unmask — ${targetActor.name}`,
        label:       `What are <strong>${esc(targetActor.name)}</strong>'s goals and motivations?`,
        placeholder: "Describe their goals and motivations…",
      });
      if (!text) return;

      await postUnmaskCard({ actorName: targetActor.name, actorPortrait: portrait, content: esc(text) });
    });
  });
})();
