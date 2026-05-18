// ============================================================================
// Camp Activity — Cartography
// Target: Yourself
// Effect: Once before the next rest, after your group makes a travel roll,
//         you may reroll the die and keep the new result.
//
// AE survival: uses campRestCharges: 1 (survives the immediate rest after camp,
//              expires at the following rest if not consumed). Permanent status
//              prevents _clearTemporaryEffects from wiping it on the same pass.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Cartography]";

  const MAP_ICON  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20MainCommand%20(Others)/02_General/dig.png";
  const OVERLAY_ID = "oni-cartography-overlay";
  const STYLE_ID   = "oni-cartography-style";

  // ---------------------------------------------------------------------------
  // CartographyUI — full-screen animation overlay, shown on all clients
  // ---------------------------------------------------------------------------
  CAMP.CartographyUI = {
    show(actorId, actorName) {
      if (document.getElementById(OVERLAY_ID)) return;

      _ensureStyle();

      const overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.innerHTML = `
        <div class="oni-carto-inner">
          <div class="oni-carto-icon"><i class="fas fa-compass"></i></div>
          <div class="oni-carto-name">${actorName ?? "?"}</div>
          <div class="oni-carto-label">Cartography</div>
          <div class="oni-carto-sub">Charting the region…</div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Safety fallback — remove after 5s in case DONE message is lost
      setTimeout(() => CAMP.CartographyUI?.hide(), 5000);
    },

    hide() {
      const overlay = document.getElementById(OVERLAY_ID);
      if (!overlay) return;
      overlay.classList.add("oni-carto-fade-out");
      overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
    },
  };

  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.72);
        animation: oni-carto-fadein 0.4s ease forwards;
      }
      #${OVERLAY_ID}.oni-carto-fade-out {
        animation: oni-carto-fadeout 0.5s ease forwards;
      }
      .oni-carto-inner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        color: #e8dfc0;
        text-shadow: 0 2px 8px rgba(0,0,0,0.8);
      }
      .oni-carto-icon {
        font-size: 3.8rem;
        animation: oni-carto-spin 4s linear infinite;
        color: #c8a84b;
        filter: drop-shadow(0 0 12px rgba(200,168,75,0.6));
      }
      .oni-carto-name {
        font-size: 1.35rem;
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .oni-carto-label {
        font-size: 1.7rem;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #c8a84b;
      }
      .oni-carto-sub {
        font-size: 0.95rem;
        opacity: 0.75;
        font-style: italic;
      }
      @keyframes oni-carto-fadein  { from { opacity: 0 } to { opacity: 1 } }
      @keyframes oni-carto-fadeout { from { opacity: 1 } to { opacity: 0 } }
      @keyframes oni-carto-spin    { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("cartography", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Show animation overlay on all clients (broadcast doesn't loop back to sender)
        CAMP.Socket.broadcast(CAMP.MSG.CARTOGRAPHY_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.CartographyUI.show(actor.id, actor.name);

        await new Promise(r => setTimeout(r, 300));

        // 2 — Clear any existing Cartography AE (actor chose this activity again before using it)
        const existing = actor.effects.find(e => e.flags?.[MODULE_ID]?.cartographyReroll === true);
        if (existing) await existing.delete();

        // 2b — Apply the Cartography Active Effect
        //     statuses: ["permanent"] — survives _clearTemporaryEffects
        //     campRestCharges: 1      — generic tick: survives 1 rest, expires at the 2nd
        //     cartographyReroll: true — marker read by TravelRoll API
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name:        "Cartography",
          img:         MAP_ICON,
          description: "Once before the next rest, when your group makes a Travel Roll, you may reroll the die and keep the new result.",
          origin:      `Actor.${actor.id}`,
          disabled:    false,
          changes:     [],
          statuses:    ["permanent"],
          flags: {
            [MODULE_ID]: {
              campRestCharges:    1,
              cartographyReroll:  true,
              cartographyActorId: actor.id,
            },
          },
        }]);

        // 3 — Chat announcement
        await _postChatResult(actor);

        // 4 — Hold while the overlay runs
        await new Promise(r => setTimeout(r, 2200));

        // 5 — Hide overlay on all clients
        CAMP.Socket.broadcast(CAMP.MSG.CARTOGRAPHY_DONE, { actorId: actor.id });
        CAMP.CartographyUI.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Chat announcement
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor) {
    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${MAP_ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;">
          <div>
            <div style="font-weight:700;font-size:1em;color:#8a6f2e;">
              ${actor.name} — Cartography
            </div>
            <div style="font-size:.88em;margin-top:4px;opacity:.9;">
              Studies the maps of the region.
            </div>
            <div style="font-size:.82em;margin-top:5px;opacity:.75;font-style:italic;">
              Once before the next rest, when your group makes a Travel Roll,
              you may reroll the die and keep the new result.
            </div>
          </div>
        </div>
      `,
    });

    const styleId = `oni-carto-chat-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(style);
    }
  }
})();
