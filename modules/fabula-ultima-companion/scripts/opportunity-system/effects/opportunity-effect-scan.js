// ============================================================================
// Opportunity Effect — Scan
//
// Effect: Reveal one Vulnerability or one Trait of a creature you can see.
//
// Implementation:
//   Vulnerability — reads affinity_1–9 from actor.system.props; posts all
//   non-neutral affinities with VU entries highlighted.
//   Trait — reads system.props.traits (rich-text field used by the encyclopedia)
//   and posts it verbatim.
//
// The GM picks the target and reveal type. The result is posted publicly.
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Scan]";

  // Matches apply-damage-core.js and encyclopedia-core.js
  const ELEMENT_NAMES  = ["Physical","Air","Bolt","Dark","Earth","Fire","Ice","Light","Poison"];
  const AFFINITY_LABEL = { RS:"🛡 Resistant", VU:"💥 Vulnerable", IM:"🚫 Immune", AB:"♻ Absorbs" };

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  async function postScanCard({ targetName, targetPortrait, scanType, resultHtml }) {
    const accent    = "#2a7a5a";
    const typeLabel = scanType === "vulnerability" ? "Vulnerability" : "Trait";
    const typeIcon  = scanType === "vulnerability" ? "fa-shield-halved" : "fa-scroll";

    const content = `
      <div style="
        font-family:'Signika',serif; padding:10px 13px 10px; border-radius:10px;
        background:linear-gradient(160deg,#0d1f1a 0%,#122a22 100%);
        border:2px solid ${esc(accent)}; color:#d4edd8;
      ">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <img src="${esc(targetPortrait)}"
               style="width:40px;height:40px;object-fit:contain;border:none!important;background:transparent!important;box-shadow:none!important;border-radius:0!important;"
               onerror="this.src='icons/svg/mystery-man.svg'" />
          <div>
            <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;letter-spacing:.06em;">
              <i class="fas ${esc(typeIcon)}" style="margin-right:4px;"></i>Scan — ${esc(typeLabel)}
            </div>
            <div style="font-weight:900;font-size:.95rem;">${esc(targetName)}</div>
          </div>
        </div>
        <div style="font-size:.82rem;line-height:1.55;border-top:1px solid ${esc(accent)}55;padding-top:7px;">
          ${resultHtml}
        </div>
      </div>`;

    await ChatMessage.create({ content })
      .catch(e => console.error(TAG, "postScanCard failed:", e));
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("scan", async (ctx) => {
      const { resolveActor, pickToken } = window["oni.OppEffectUtils"] ?? {};
      if (!resolveActor || !pickToken) { console.error(TAG, "OppEffectUtils not loaded."); return; }

      // Exclude the scanning actor from the target list
      const scannerActor = await resolveActor(ctx.actorUuid);

      const token = await pickToken({
        title:          "Scan — Choose Target",
        excludeActorId: scannerActor?.id ?? null,
      });
      if (!token) return;

      const targetActor = token.actor;
      const props       = targetActor.system?.props ?? {};

      const portrait = String(props.sprite_standard ?? "").trim()
        || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
        || targetActor.img
        || "icons/svg/mystery-man.svg";

      // Pick scan type
      const scanType = await new Promise(resolve => {
        new Dialog({
          title:   `Scan — ${targetActor.name}`,
          content: `<p style="margin:4px 0 8px;">
                      What to reveal about <strong>${esc(targetActor.name)}</strong>?
                    </p>`,
          buttons: {
            vulnerability: { label: "💥 Vulnerability", callback: () => resolve("vulnerability") },
            trait:         { label: "📜 Trait",         callback: () => resolve("trait")         },
            cancel:        { label: "Cancel",            callback: () => resolve(null)            },
          },
          default: "vulnerability",
          close:   () => resolve(null),
        }).render(true);
      });
      if (!scanType) return;

      let resultHtml;

      if (scanType === "vulnerability") {
        const rows = ELEMENT_NAMES.map((el, i) => {
          const val = String(props[`affinity_${i + 1}`] ?? "").trim().toUpperCase();
          if (!val) return null;
          const label = AFFINITY_LABEL[val] ?? val;
          const isVu  = val === "VU";
          return `<div style="${isVu ? "font-weight:800;color:#f9a825;" : "opacity:.75;"}">${esc(el)}: ${esc(label)}</div>`;
        }).filter(Boolean);

        resultHtml = rows.length
          ? rows.join("")
          : `<div style="opacity:.6;">All affinities are neutral.</div>`;
      } else {
        const raw = String(props.traits ?? "").trim();
        resultHtml = raw || `<div style="opacity:.6;">No trait information available.</div>`;
      }

      await postScanCard({ targetName: targetActor.name, targetPortrait: portrait, scanType, resultHtml });
    });
  });
})();
