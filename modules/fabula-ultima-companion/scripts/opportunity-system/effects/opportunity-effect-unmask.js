// ============================================================================
// Opportunity Effect — Unmask
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Unmask]";

  const MOTIVATION_FIELDS = [
    "motivation","motivations","goals","goal",
    "npc_goal","enemy_goal","enemy_motivation","npc_motivation",
  ];

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  async function postUnmaskCard({ actorName, actorPortrait, content }) {
    const accent = "#6a2a6a";
    const html   = `
      <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
        background:linear-gradient(160deg,#190d19 0%,#240e24 100%);
        border:2px solid ${esc(accent)};color:#e8c8e8;">
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
      console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

      const { pickToken, gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
      if (!pickToken || !gmTextPrompt) { console.error(TAG, "[exit] OppEffectUtils not loaded"); return; }

      console.debug(TAG, "[step 1] opening target picker...");
      const token = await pickToken({ title: "Unmask — Choose Creature", sourceActorUuid: ctx.actorUuid });
      console.debug(TAG, "[step 1] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
      if (!token) { console.debug(TAG, "[exit] target picker cancelled"); return; }

      const targetActor = token.actor;
      const props       = targetActor.system?.props ?? {};
      const portrait    = String(props.sprite_standard ?? "").trim()
        || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
        || targetActor.img || "icons/svg/mystery-man.svg";

      // Step 2: probe motivation fields
      console.debug(TAG, "[step 2] probing motivation fields:", MOTIVATION_FIELDS);
      let rawContent = "";
      for (const field of MOTIVATION_FIELDS) {
        const val = String(props[field] ?? "").trim();
        if (val) { rawContent = val; console.debug(TAG, "[step 2] found field:", field, "| length:", val.length); break; }
      }
      if (!rawContent) console.debug(TAG, "[step 2] no motivation field found — falling back to GM input");

      if (rawContent) {
        console.debug(TAG, "[step 3] posting card from prop field...");
        await postUnmaskCard({ actorName: targetActor.name, actorPortrait: portrait, content: rawContent });
      } else {
        console.debug(TAG, "[step 3] opening GM text prompt...");
        const text = await gmTextPrompt({
          title:       `Unmask — ${targetActor.name}`,
          label:       `What are <strong>${esc(targetActor.name)}</strong>'s goals and motivations?`,
          placeholder: "Describe their goals and motivations…",
        });
        console.debug(TAG, "[step 3] GM text result:", text ? `length=${text.length}` : "NULL");
        if (!text) { console.debug(TAG, "[exit] GM text prompt cancelled"); return; }
        await postUnmaskCard({ actorName: targetActor.name, actorPortrait: portrait, content: esc(text) });
      }

      console.debug(TAG, "[done]");
    });
  });
})();
