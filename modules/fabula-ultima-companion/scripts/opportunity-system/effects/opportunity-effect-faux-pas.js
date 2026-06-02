// ============================================================================
// Opportunity Effect — Faux Pas
//
// Flow (pre/post):
//   pre  — target picker → statement picker
//            Local if the current user controls the target.
//            Remote via OPP_FAUXPAS_PICK / OPP_FAUXPAS_DONE sockets otherwise.
//          Returns { tokenId, tokenUuid, targetActorId, presetId, presetLabel, customText }
//   post — posts a PUBLIC chat card with the statement category (and custom text if any)
// ============================================================================
(() => {
  const TAG       = "[ONI][OpportunityEffect:FauxPas]";
  const SOCKET_CH = "module.fabula-ultima-companion";
  const MSG_PICK  = "OPP_FAUXPAS_PICK";
  const MSG_DONE  = "OPP_FAUXPAS_DONE";

  const esc = s => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  // ── Preset definitions ─────────────────────────────────────────────────────
  const PRESET_GROUPS = [
    {
      groupLabel: "Verbal",
      subtitle:   "For speaking creatures",
      presets: [
        { id: "reveal_secret",        label: "Reveal a Secret",           icon: "fa-scroll",              description: "They blurt out plans, info, or secrets they were meant to keep hidden." },
        { id: "confess_motive",       label: "Confess an Ulterior Motive", icon: "fa-masks-theater",      description: "They admit the self-serving or hidden reason behind their actions." },
        { id: "express_disloyalty",   label: "Express Disloyalty",        icon: "fa-heart-crack",         description: "They voice doubts, resentment, or wavering faith in their faction or leader." },
        { id: "say_something_hurtful",label: "Say Something Hurtful",     icon: "fa-comment-slash",       description: "They blurt something tactless, offensive, or damaging to relationships on the scene." },
      ],
    },
    {
      groupLabel: "Behavioral",
      subtitle:   "Works for any creature, including monsters",
      presets: [
        { id: "expose_weakness",      label: "Expose a Vulnerability",    icon: "fa-eye-slash",           description: "They visibly react to something — a sound, element, or threat — revealing a weakness they couldn't hide." },
        { id: "break_at_wrong_moment",label: "Break at the Wrong Moment", icon: "fa-person-running",      description: "They freeze, flinch, or pull back, exposing doubt, fear, or the edge of their resolve." },
        { id: "betray_priorities",    label: "Betray Their Priorities",   icon: "fa-location-crosshairs", description: "Through panic or instinct, they reveal what they're actually trying to protect or avoid." },
      ],
    },
  ];

  const CUSTOM_PRESET = { id: "custom", label: "Custom", icon: "fa-pen", description: "Write the exact statement or behavior yourself." };

  function findPreset(id) {
    for (const g of PRESET_GROUPS) {
      const p = g.presets.find(p => p.id === id);
      if (p) return p;
    }
    if (id === "custom") return CUSTOM_PRESET;
    return null;
  }

  // ── CSS injection ──────────────────────────────────────────────────────────
  const STYLE_ID = "oni-faux-pas-picker-css";

  function ensurePickerStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-fp-list {
        list-style: none; margin: 4px 0 0; padding: 0;
        max-height: 300px; overflow-y: auto;
        border: 1px solid rgba(91,63,38,.40);
        border-radius: 5px;
        background: rgba(255,252,245,.75);
      }
      .oni-fp-group-header {
        padding: 4px 10px 2px;
        font-size: 0.72rem; font-weight: 700; letter-spacing: .07em;
        text-transform: uppercase; color: #8a6c2a;
        background: rgba(138,108,42,.10);
        border-bottom: 1px solid rgba(138,108,42,.20);
        user-select: none; pointer-events: none;
      }
      .oni-fp-group-header span {
        font-weight: 400; color: #b0926e; margin-left: 6px;
        text-transform: none; letter-spacing: 0;
      }
      .oni-fp-list li {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 6px 10px; cursor: pointer;
        border-bottom: 1px solid rgba(91,63,38,.12);
        font-size: 0.86rem; color: #3b2a19;
        transition: background 0.1s;
        user-select: none;
      }
      .oni-fp-list li:last-child { border-bottom: none; }
      .oni-fp-list li:hover      { background: rgba(252,212,112,.25); }
      .oni-fp-list li.selected   { background: rgba(138,108,42,.18); font-weight: 700; }
      .oni-fp-list li i {
        width: 18px; text-align: center; flex-shrink: 0;
        margin-top: 3px; color: #8a6c2a; font-size: 0.84rem;
      }
      .oni-fp-label-wrap { display: flex; flex-direction: column; gap: 1px; }
      .oni-fp-desc { font-size: 0.76rem; color: #8a6060; font-weight: 400; line-height: 1.35; }
      .oni-fp-custom-divider {
        border: none;
        border-top: 2px solid rgba(138,108,42,.28);
        margin: 0;
        pointer-events: none;
      }
      .oni-fp-custom-wrap { margin-top: 6px; display: none; }
      .oni-fp-custom-wrap.visible { display: block; }
      .oni-fp-custom-wrap textarea {
        width: 100%; box-sizing: border-box;
        resize: vertical; min-height: 60px;
        border: 1px solid rgba(91,63,38,.40);
        border-radius: 4px; padding: 5px 8px;
        font-size: 0.86rem; color: #3b2a19;
        background: rgba(255,252,245,.90);
        font-family: inherit;
      }
      .oni-fp-custom-wrap textarea:focus {
        outline: none; border-color: #8a6c2a;
        box-shadow: 0 0 0 2px rgba(138,108,42,.20);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Statement picker dialog ────────────────────────────────────────────────
  // Resolves to { selectedId, customText } or null if cancelled.
  function showStatementPicker(actorName, targetName) {
    ensurePickerStyles();

    return new Promise(resolve => {
      let selectedId = null;
      let customText = "";

      const groupRows = PRESET_GROUPS.map(g => {
        const rows = g.presets.map(p => `
          <li data-id="${esc(p.id)}">
            <i class="fas ${esc(p.icon)}"></i>
            <div class="oni-fp-label-wrap">
              <span>${esc(p.label)}</span>
              <span class="oni-fp-desc">${esc(p.description)}</span>
            </div>
          </li>`).join("");
        return `
          <li class="oni-fp-group-header">${esc(g.groupLabel)}<span>${esc(g.subtitle)}</span></li>
          ${rows}`;
      }).join("");

      const customRow = `
        <li class="oni-fp-custom-divider" style="padding:0;height:0;border-bottom:none;"></li>
        <li data-id="custom" style="border-top: 2px solid rgba(138,108,42,.28);">
          <i class="fas ${esc(CUSTOM_PRESET.icon)}"></i>
          <div class="oni-fp-label-wrap">
            <span>${esc(CUSTOM_PRESET.label)}</span>
            <span class="oni-fp-desc">${esc(CUSTOM_PRESET.description)}</span>
          </div>
        </li>`;

      const dialogContent = `
        <p style="margin:4px 0 6px;font-size:.9rem;">
          <strong>${esc(actorName)}</strong> inflicted Faux Pas on
          <strong>${esc(targetName)}</strong>. What compromising statement do they make?
        </p>
        <ul class="oni-fp-list">
          ${groupRows}
          ${customRow}
        </ul>
        <div class="oni-fp-custom-wrap">
          <textarea placeholder="Describe the compromising statement or action..."></textarea>
        </div>`;

      const dlg = new Dialog({
        title:   "Faux Pas — Choose Statement",
        content: dialogContent,
        buttons: {
          apply:  { label: "Confirm", callback: () => resolve({ selectedId, customText: customText.trim() }) },
          cancel: { label: "Cancel",  callback: () => resolve(null) },
        },
        default: "apply",
        close:   () => resolve(null),
        render:  html => {
          const applyBtn   = html.closest(".dialog").find("[data-button='apply']");
          const customWrap = html.find(".oni-fp-custom-wrap");
          const textarea   = html.find(".oni-fp-custom-wrap textarea");

          function refreshApply() {
            const ok = selectedId !== null
              && (selectedId !== "custom" || customText.trim().length > 0);
            applyBtn.prop("disabled", !ok).css("opacity", ok ? "1" : "0.45");
          }

          applyBtn.prop("disabled", true).css("opacity", "0.45");

          html.find(".oni-fp-list li[data-id]").on("click", function () {
            html.find(".oni-fp-list li[data-id]").removeClass("selected");
            $(this).addClass("selected");
            selectedId = String($(this).data("id"));
            if (selectedId === "custom") {
              customWrap.addClass("visible");
            } else {
              customWrap.removeClass("visible");
              customText = "";
            }
            refreshApply();
          });

          textarea.on("input", function () {
            customText = String($(this).val());
            refreshApply();
          });
        },
      }, { width: 400 });

      dlg.render(true);
    });
  }

  // ── Token / actor helpers ──────────────────────────────────────────────────
  function resolveToken({ tokenId, tokenUuid }) {
    return (canvas?.tokens?.placeables ?? []).find(t =>
      (tokenUuid && t.document?.uuid === tokenUuid) || t.id === tokenId
    ) ?? null;
  }

  function getControllerUserId(actor) {
    for (const [userId, level] of Object.entries(actor?.ownership ?? {})) {
      if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
        const user = game.users?.get(userId);
        if (user && !user.isGM) return userId;
      }
    }
    return null;
  }

  function getActiveGmUserId() {
    return (game.users?.contents ?? []).find(u => u.isGM && u.active)?.id ?? null;
  }

  // ── Socket: pending promise tracking ──────────────────────────────────────
  const _pending = new Map(); // nonce → resolve fn

  function sendPickRequest({ actorName, targetName, targetUserId }) {
    const nonce = foundry.utils.randomID();
    return new Promise(resolve => {
      _pending.set(nonce, resolve);
      game.socket.emit(SOCKET_CH, {
        type:    MSG_PICK,
        payload: { nonce, actorName, targetName, targetUserId },
      });
    });
  }

  // ── Ready hook ─────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {

    // ── Socket dispatcher ──────────────────────────────────────────────────
    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type) return;

      // OPP_FAUXPAS_PICK — show statement picker on the target's controller client
      if (msg.type === MSG_PICK) {
        const { nonce, actorName, targetName, targetUserId } = msg.payload ?? {};
        if (game.user.id !== targetUserId) return;

        const result = await showStatementPicker(actorName, targetName);

        const donePayload = result
          ? {
              nonce,
              cancelled:   false,
              presetId:    result.selectedId,
              presetLabel: findPreset(result.selectedId)?.label ?? result.selectedId,
              customText:  result.customText || null,
            }
          : { nonce, cancelled: true, presetId: null, presetLabel: null, customText: null };

        game.socket.emit(SOCKET_CH, { type: MSG_DONE, payload: donePayload });
        return;
      }

      // OPP_FAUXPAS_DONE — resolve the awaiting promise on the triggering client
      if (msg.type === MSG_DONE) {
        const { nonce, cancelled, ...rest } = msg.payload ?? {};
        const resolve = _pending.get(nonce);
        if (!resolve) return;
        _pending.delete(nonce);
        resolve(cancelled ? null : rest);
      }
    });

    // ── Register effect handler ────────────────────────────────────────────
    window["oni.OppEffectRegistry"]?.register("faux_pas", {

      // ── Pre: target picker → statement picker ──────────────────────────
      async pre(ctx) {
        console.debug(TAG, "[entry]", { actorUuid: ctx.actorUuid, actorName: ctx.actorName });

        const { pickToken } = window["oni.OppEffectUtils"] ?? {};
        if (!pickToken) { console.error(TAG, "[pre] OppEffectUtils not loaded"); return null; }

        // Step 1 — target selection
        console.debug(TAG, "[pre] opening target picker...");
        const token = await pickToken({ title: "Faux Pas — Choose Creature", sourceActorUuid: ctx.actorUuid });
        if (!token) { console.debug(TAG, "[pre] target picker cancelled"); return null; }

        const targetActor  = token.actor;
        const targetName   = token.name ?? targetActor?.name ?? "Unknown";
        console.debug(TAG, "[pre] target:", targetName, `(id=${token.id})`);

        // Step 2 — statement selection on the target's controller's client
        const controllerId = getControllerUserId(targetActor);
        const pickerUserId = controllerId ?? getActiveGmUserId();

        let statementResult;

        if (!pickerUserId || pickerUserId === game.user.id) {
          // Current client is the controller (or no controller found) — show locally
          console.debug(TAG, "[pre] showing statement picker locally...");
          const local = await showStatementPicker(ctx.actorName, targetName);
          if (!local) { console.debug(TAG, "[pre] statement picker cancelled locally"); return null; }
          statementResult = {
            presetId:    local.selectedId,
            presetLabel: findPreset(local.selectedId)?.label ?? local.selectedId,
            customText:  local.customText || null,
          };
        } else {
          // Remote — send PICK to target's controller and await DONE
          console.debug(TAG, "[pre] sending OPP_FAUXPAS_PICK to user:", pickerUserId);
          const remote = await sendPickRequest({ actorName: ctx.actorName, targetName, targetUserId: pickerUserId });
          if (!remote) { console.debug(TAG, "[pre] statement picker cancelled remotely"); return null; }
          statementResult = remote;
          console.debug(TAG, "[pre] OPP_FAUXPAS_DONE received:", statementResult);
        }

        return {
          tokenId:       token.id,
          tokenUuid:     token.document?.uuid ?? null,
          targetActorId: targetActor?.id ?? null,
          presetId:      statementResult.presetId,
          presetLabel:   statementResult.presetLabel,
          customText:    statementResult.customText,
        };
      },

      // ── Post: public announcement card ────────────────────────────────
      async post(ctx, preResult) {
        const { tokenId, tokenUuid, targetActorId, presetLabel, customText } = preResult ?? {};

        const token       = resolveToken({ tokenId, tokenUuid });
        const targetActor = token?.actor ?? game.actors?.get(targetActorId);
        if (!targetActor) {
          console.error(TAG, "[post] could not resolve target actor", { tokenId, targetActorId });
          return;
        }

        const targetName = token?.name ?? targetActor.name;
        const accent     = "#8a6c2a";

        const customBlock = customText
          ? `<div style="margin-top:7px;padding:5px 10px;
               border-left:2px solid rgba(138,108,42,.55);
               font-style:italic;font-size:.85rem;opacity:.88;line-height:1.5;">
               "${esc(customText)}"
             </div>`
          : "";

        const content = `
          <div style="font-family:'Signika',serif;padding:10px 13px;border-radius:10px;
            background:linear-gradient(160deg,#1a1507 0%,#261e0a 100%);
            border:2px solid ${esc(accent)};color:#f0d88a;">
            <div style="font-size:.74rem;opacity:.6;text-transform:uppercase;
              letter-spacing:.06em;margin-bottom:4px;">
              <i class="fas fa-comment-slash" style="margin-right:4px;"></i>Faux Pas — ${esc(ctx.actorName)}
            </div>
            <div style="font-size:.88rem;line-height:1.55;">
              <strong>${esc(targetName)}</strong> makes a compromising statement.
            </div>
            <div style="margin-top:6px;display:inline-block;padding:3px 11px;
              border-radius:12px;background:rgba(138,108,42,.28);
              border:1px solid rgba(138,108,42,.55);
              font-size:.82rem;font-weight:700;letter-spacing:.02em;">
              ${esc(presetLabel ?? "Statement")}
            </div>
            ${customBlock}
          </div>`;

        console.debug(TAG, "[post] posting public announcement...");
        await ChatMessage.create({ content })
          .catch(e => console.error(TAG, "[post] ChatMessage.create failed:", e));
        console.debug(TAG, "[done]");
      },
    });
  });
})();
