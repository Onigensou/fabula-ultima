// ============================================================================
// Opportunity Effect — Scan
//
// Flow (pre/post):
//   pre  — target picker + scan-type dialog; returns { tokenId, tokenUuid, scanType }
//   post — reads actor data from the resolved token and posts the scan chat card
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunityEffect:Scan]";

  const ELEMENT_NAMES  = ["Physical","Air","Bolt","Dark","Earth","Fire","Ice","Light","Poison"];
  const AFFINITY_LABEL = { RS:"🛡 Resistant", VU:"💥 Vulnerable", IM:"🚫 Immune", AB:"♻ Absorbs" };

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  async function postScanCard({ targetName, targetPortrait, scanType, resultHtml }) {
    const accent    = "#2a7a5a";
    const typeLabel = scanType === "vulnerability" ? "Vulnerability" : "Trait";
    const typeIcon  = scanType === "vulnerability" ? "fa-shield-halved" : "fa-scroll";
    const content   = `
      <div style="font-family:'Signika',serif;padding:10px 13px 10px;border-radius:10px;
        background:linear-gradient(160deg,#0d1f1a 0%,#122a22 100%);
        border:2px solid ${esc(accent)};color:#d4edd8;">
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
    await ChatMessage.create({ content }).catch(e => console.error(TAG, "postScanCard failed:", e));
  }

  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  Hooks.once("ready", () => {
    window["oni.OppEffectRegistry"]?.register("scan", {

      // ── Pre phase: target + scan-type selection ────────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        // Step 1: pick target
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Scan — Choose Target", sourceActorUuid: ctx.actorUuid });
        console.debug(TAG, "[pre] token picked:", token ? `${token.name} (id=${token.id})` : "NULL");
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        // Step 2: pick scan type
        console.debug(TAG, "[pre] opening scan type picker...");
        const scanType = await new Promise(resolve => {
          new Dialog({
            title:   `Scan — ${token.actor?.name ?? ""}`,
            content: `<p style="margin:4px 0 8px;">What to reveal about <strong>${esc(token.actor?.name ?? "")}</strong>?</p>`,
            buttons: {
              vulnerability: { label: "💥 Vulnerability", callback: () => resolve("vulnerability") },
              trait:         { label: "📜 Trait",         callback: () => resolve("trait")         },
              cancel:        { label: "Cancel",            callback: () => resolve(null)            },
            },
            default: "vulnerability",
            close:   () => resolve(null),
          }).render(true);
        });
        console.debug(TAG, "[pre] scan type chosen:", scanType);
        if (!scanType) { console.debug(TAG, "[pre] scan type picker cancelled"); return null; }

        return { tokenId: token.id, tokenUuid: token.document?.uuid ?? null, scanType };
      },

      // ── Post phase: read actor data + post chat card ───────────────────────
      async post(ctx, preResult) {
        const { tokenId, tokenUuid, scanType } = preResult ?? {};

        const token = resolveToken({ tokenId, tokenUuid });
        if (!token?.actor) { console.error(TAG, "[post] token not found on canvas", { tokenId, tokenUuid }); return; }

        const targetActor = token.actor;
        const props       = targetActor.system?.props ?? {};
        console.debug(TAG, "[post] target actor:", targetActor.name, "| scanType:", scanType);

        const portrait = String(props.sprite_standard ?? "").trim()
          || String(targetActor.prototypeToken?.texture?.src ?? "").trim()
          || targetActor.img || "icons/svg/mystery-man.svg";

        let resultHtml;
        if (scanType === "vulnerability") {
          const rows = ELEMENT_NAMES.map((el, i) => {
            const val = String(props[`affinity_${i + 1}`] ?? "").trim().toUpperCase();
            if (!val) return null;
            const isVu = val === "VU";
            return `<div style="${isVu ? "font-weight:800;color:#f9a825;" : "opacity:.75;"}">${esc(el)}: ${esc(AFFINITY_LABEL[val] ?? val)}</div>`;
          }).filter(Boolean);
          resultHtml = rows.length ? rows.join("") : `<div style="opacity:.6;">All affinities are neutral.</div>`;
          console.debug(TAG, "[post] vulnerability rows:", rows.length);
        } else {
          const raw = String(props.traits ?? "").trim();
          resultHtml = raw || `<div style="opacity:.6;">No trait information available.</div>`;
          console.debug(TAG, "[post] traits field length:", raw.length);
        }

        console.debug(TAG, "[post] posting scan card...");
        await postScanCard({ targetName: targetActor.name, targetPortrait: portrait, scanType, resultHtml });
        console.debug(TAG, "[done]");
      },
    });
  });
})();
