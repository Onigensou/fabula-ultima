// ============================================================================
// Opportunity Effect — Unmask
//
// Flow (pre/post):
//   pre  — target picker; probes motivation fields on the actor; if none found,
//          opens a GM text prompt. Returns { targetName, portrait, content }.
//   post — posts the styled unmask chat card using the pre-result data
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
    window["oni.OppEffectRegistry"]?.register("unmask", {

      // ── Pre phase: target selection + content resolution ───────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken, gmTextPrompt } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken || !gmTextPrompt) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        // Step 1: pick target
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Unmask — Choose Creature", sourceActorUuid: ctx.actorUuid });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        const targetActor = token.actor;
        const props       = targetActor.system?.props ?? {};
        const portrait    = String(props.sprite_standard ?? "").trim()
          || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
          || targetActor.img || "icons/svg/mystery-man.svg";

        // Step 2: probe motivation fields; fall back to GM text input if empty
        console.debug(TAG, "[pre] probing motivation fields:", MOTIVATION_FIELDS);
        let content = "";
        for (const field of MOTIVATION_FIELDS) {
          const val = String(props[field] ?? "").trim();
          if (val) { content = val; console.debug(TAG, "[pre] found field:", field, "| length:", val.length); break; }
        }

        if (!content) {
          console.debug(TAG, "[pre] no motivation field found — opening GM text prompt...");
          const text = await gmTextPrompt({
            title:       `Unmask — ${targetActor.name}`,
            label:       `What are <strong>${esc(targetActor.name)}</strong>'s goals and motivations?`,
            placeholder: "Describe their goals and motivations…",
          });
          console.debug(TAG, "[pre] GM text result:", text ? `length=${text.length}` : "NULL");
          if (!text) { console.debug(TAG, "[pre] GM text prompt cancelled"); return null; }
          content = esc(text);
        }

        return { targetName: targetActor.name, portrait, content };
      },

      // ── Post phase: post the unmask card ──────────────────────────────────
      async post(ctx, preResult) {
        const { targetName, portrait, content } = preResult ?? {};
        console.debug(TAG, "[post] posting unmask card for:", targetName);
        await postUnmaskCard({ actorName: targetName, actorPortrait: portrait, content });
        console.debug(TAG, "[done]");
      },
    });
  });
})();
