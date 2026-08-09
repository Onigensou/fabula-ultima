// ============================================================================
// [TreasureRoulette] Recipient UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// Screen 2 of the loot flow: "who gets this?"
//
// Pure presentation. It knows nothing about sockets or awarding — TR.Flow shows
// it on every client, gates which one can answer, and owns the decision.
//
//   show({ payload, interactive }) -> Promise<{kind, actorUuid} | null>
//   hide()
//
// Interactive client: the promise resolves with the chosen recipient.
// Spectators:         the promise never resolves on its own; hide() closes it
//                     with null when the deciding client answers.
//
// Party Inventory is the default selection and is hidden entirely for IP
// rewards, which cannot be stored on the Party Inventory actor.
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][RecipientUI]";
  const OVL_ID = "oni-tr-recipient-overlay";
  const STYLE_ID = "oni-tr-recipient-style";

  const PARTY_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/bag.png";

  const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  let _resolve = null;
  let _keyHandler = null;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 9999998;
        background: rgba(10, 7, 4, 0.74);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 260ms cubic-bezier(.2,.9,.2,1);
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
      }
      #${OVL_ID}.oni-in { opacity: 1; }
      #${OVL_ID}.oni-out { opacity: 0; }
      #${OVL_ID} * { user-select: none; box-sizing: border-box; }

      #${OVL_ID} .tr-rc-panel {
        min-width: 520px; max-width: min(1100px, 92vw);
        padding: 26px 30px 24px;
        border-radius: 14px;
        background:
          radial-gradient(ellipse at 50% 0%, rgba(255,220,150,0.08) 0%, transparent 70%),
          linear-gradient(175deg, #241a10 0%, #1b130c 55%, #140e08 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 18px 44px rgba(0,0,0,0.6);
        transform: translateY(12px) scale(0.98);
        transition: transform 260ms cubic-bezier(.2,.9,.2,1);
      }
      #${OVL_ID}.oni-in .tr-rc-panel { transform: translateY(0) scale(1); }

      #${OVL_ID} .tr-rc-reward {
        display: flex; align-items: center; justify-content: center; gap: 10px;
        margin-bottom: 4px;
      }
      #${OVL_ID} .tr-rc-reward img {
        width: 34px; height: 34px; object-fit: contain;
        background: transparent !important; border: 0 !important;
        outline: 0 !important; box-shadow: none !important;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
      }
      #${OVL_ID} .tr-rc-reward-name {
        font-size: 22px; font-weight: 800; color: #ffeec2;
        text-shadow: 0 0 16px rgba(255,200,110,0.4);
      }

      #${OVL_ID} .tr-rc-title {
        text-align: center; font-size: 13px; letter-spacing: 3px;
        text-transform: uppercase; color: rgba(255,233,190,0.7);
        margin-bottom: 20px;
      }

      #${OVL_ID} .tr-rc-cards {
        display: flex; flex-wrap: wrap; gap: 14px; justify-content: center;
      }

      #${OVL_ID} .tr-rc-card {
        width: 168px; padding: 14px 12px 12px;
        border-radius: 10px; cursor: pointer;
        background: linear-gradient(175deg, #3a2a18 0%, #2a1d11 60%, #1e150c 100%);
        border: 2px solid #6b5210;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        transition: transform 140ms ease, box-shadow 140ms ease,
                    border-color 140ms ease, filter 140ms ease;
      }
      #${OVL_ID} .tr-rc-card:hover { transform: translateY(-3px); filter: brightness(1.12); }
      #${OVL_ID} .tr-rc-card.tr-rc-selected {
        border-color: #f0d060;
        box-shadow: 0 0 0 2px rgba(255,220,130,0.5), 0 10px 22px rgba(0,0,0,0.5);
        transform: translateY(-3px);
      }

      #${OVL_ID} .tr-rc-portrait {
        width: 76px; height: 76px; border-radius: 8px; object-fit: contain;
        background: rgba(0,0,0,0.35) !important;
        border: 0 !important; outline: 0 !important; box-shadow: none !important;
      }
      #${OVL_ID} .tr-rc-name {
        font-size: 15px; font-weight: 700; color: #f0dcb0; text-align: center;
        line-height: 1.2;
      }
      #${OVL_ID} .tr-rc-sub {
        font-size: 11px; color: rgba(240,220,176,0.62); text-align: center;
        font-style: italic; min-height: 14px; line-height: 1.25;
      }

      #${OVL_ID} .tr-rc-footer {
        margin-top: 20px; display: flex; align-items: center;
        justify-content: space-between; gap: 16px;
      }
      #${OVL_ID} .tr-rc-hint {
        font-size: 12px; font-style: italic; color: rgba(240,220,176,0.55);
      }
      #${OVL_ID} .tr-rc-confirm {
        padding: 10px 26px; border-radius: 8px; cursor: pointer;
        font-weight: 800; letter-spacing: 0.04em; font-size: 14px;
        color: #d8f0c0; border: 2px solid #8B6914;
        background: linear-gradient(175deg, #2e5c28 0%, #3a7832 30%, #255022 100%);
        box-shadow: 0 0 0 1px #c9973a, 2px 4px 10px rgba(0,0,0,0.5);
        transition: filter 120ms ease, transform 80ms ease;
      }
      #${OVL_ID} .tr-rc-confirm:hover { filter: brightness(1.14); }
      #${OVL_ID} .tr-rc-confirm:active { transform: translateY(1px); }

      /* Spectator: everything is visible but inert. */
      #${OVL_ID}.tr-rc-spectator .tr-rc-card,
      #${OVL_ID}.tr-rc-spectator .tr-rc-confirm {
        cursor: default; pointer-events: none;
      }
      #${OVL_ID}.tr-rc-spectator .tr-rc-confirm { opacity: 0.45; }
    `;
    document.head.appendChild(s);
  }

  function cardHtml({ id, portrait, name, sub, selected }) {
    return `
      <div class="tr-rc-card${selected ? " tr-rc-selected" : ""}" data-id="${esc(id)}">
        <img class="tr-rc-portrait" src="${esc(portrait)}" alt="${esc(name)}"
             onerror="this.src='icons/svg/mystery-man.svg'">
        <div class="tr-rc-name">${esc(name)}</div>
        <div class="tr-rc-sub">${esc(sub ?? "")}</div>
      </div>`;
  }

  // What to show under each member's portrait: for IP, their headroom; for gear,
  // nothing yet (the equip screen does the comparison).
  function memberSubtitle(member, kind) {
    if (kind === "itempoint") {
      const { cur, max } = member.ip ?? {};
      if (Number(max) > 0) return `IP ${cur}/${max}`;
      return "";
    }
    return "";
  }

  function buildOverlay(payload, interactive) {
    ensureStyles();
    document.getElementById(OVL_ID)?.remove();

    const kind = String(payload?.reward?.kind ?? "").toLowerCase();
    const allowParty = payload?.allowParty !== false && !!payload?.partyInventory;

    const cards = [];

    if (allowParty) {
      cards.push({
        id: payload.partyInventory.actorUuid,
        portrait: PARTY_ICON,
        name: payload.partyInventory.name || "Party Inventory",
        sub: "Shared stash",
        kind: "party",
      });
    }

    for (const m of payload?.members ?? []) {
      cards.push({
        id: m.actorUuid,
        portrait: m.portrait,
        name: m.name,
        sub: memberSubtitle(m, kind),
        kind: "member",
      });
    }

    // Party Inventory is the default when it's on the table; otherwise (IP) the
    // first party member is.
    const defaultId = cards[0]?.id ?? null;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    if (!interactive) overlay.classList.add("tr-rc-spectator");

    overlay.innerHTML = `
      <div class="tr-rc-panel">
        <div class="tr-rc-reward">
          <img src="${esc(payload?.reward?.img ?? "icons/svg/chest.svg")}" alt="">
          <span class="tr-rc-reward-name">${esc(payload?.reward?.name ?? "Reward")}</span>
        </div>
        <div class="tr-rc-title">Who takes it?</div>
        <div class="tr-rc-cards">
          ${cards.map((c) => cardHtml({ ...c, selected: c.id === defaultId })).join("")}
        </div>
        <div class="tr-rc-footer">
          <div class="tr-rc-hint"></div>
          <div class="tr-rc-confirm">Confirm</div>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("oni-in"));

    return { overlay, cards, defaultId };
  }

  function close(result) {
    const fn = _resolve;
    _resolve = null;

    if (_keyHandler) {
      window.removeEventListener("keydown", _keyHandler, true);
      _keyHandler = null;
    }

    const el = document.getElementById(OVL_ID);
    if (el) {
      el.classList.remove("oni-in");
      el.classList.add("oni-out");
      setTimeout(() => el.remove(), 280);
    }

    fn?.(result ?? null);
  }

  const API = {
    /**
     * @param {object}  opts
     * @param {object}  opts.payload      { reward, allowParty, partyInventory, members }
     * @param {boolean} opts.interactive  can this client answer?
     * @returns {Promise<{kind:string, actorUuid:string}|null>}
     */
    show({ payload, interactive = false } = {}) {
      // A second show() replaces the first; never leave a stale overlay behind.
      if (_resolve) close(null);

      const { overlay, cards, defaultId } = buildOverlay(payload, interactive);

      let selectedId = defaultId;

      return new Promise((resolve) => {
        _resolve = resolve;

        const hint = overlay.querySelector(".tr-rc-hint");
        if (!interactive) {
          const who = payload?.controllerName;
          hint.textContent = who ? `Waiting for ${who}…` : "Waiting for the party leader…";
          return;   // spectators watch; hide() closes them out
        }

        hint.textContent = "Default: Party Inventory";

        const select = (id) => {
          selectedId = id;
          overlay.querySelectorAll(".tr-rc-card").forEach((el) => {
            el.classList.toggle("tr-rc-selected", el.dataset.id === id);
          });
        };

        overlay.querySelectorAll(".tr-rc-card").forEach((el) => {
          el.addEventListener("click", () => select(el.dataset.id));
          // Double-click is "pick and go".
          el.addEventListener("dblclick", () => {
            select(el.dataset.id);
            confirm();
          });
        });

        const confirm = () => {
          const card = cards.find((c) => c.id === selectedId) ?? cards[0];
          if (!card) return close(null);
          close({ kind: card.kind, actorUuid: card.id });
        };

        overlay.querySelector(".tr-rc-confirm").addEventListener("click", confirm);

        _keyHandler = (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); confirm(); }
        };
        window.addEventListener("keydown", _keyHandler, true);
      });
    },

    hide() {
      if (!_resolve && !document.getElementById(OVL_ID)) return;
      close(null);
    },
  };

  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.RecipientUI = API;
  window["oni.TreasureRoulette.RecipientUI"] = API;

  console.debug(TAG, "Installed.");
})();
