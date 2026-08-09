// ============================================================================
// [TreasureRoulette] Equip UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// Screen 3 of the loot flow: "equip it now?" — No / Yes beside a side-by-side
// stat comparison of what's worn versus what just dropped.
//
// Pure presentation, same contract as RecipientUI:
//   show({ payload, interactive }) -> Promise<{equip:boolean, slotKey:string} | null>
//   hide()
//
// Default answer is NO. An empty target slot still renders the comparison, with
// "(Empty)" for the name and "-" in every stat field.
//
// Payload (built by TR.Flow from BD's own equipment-swap builders, so the fields
// match the Equipment card exactly):
//   { actorName, portrait, incoming: <candidate>, preferredSlotKey,
//     slots: [ { key, label, current: <candidate>|null, occupied } ] }
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][EquipUI]";
  const OVL_ID = "oni-tr-equip-overlay";
  const STYLE_ID = "oni-tr-equip-style";

  const EMPTY = "—";

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

      #${OVL_ID} .tr-eq-panel {
        max-width: min(1000px, 94vw);
        padding: 24px 28px 22px;
        border-radius: 14px;
        background:
          radial-gradient(ellipse at 50% 0%, rgba(255,220,150,0.08) 0%, transparent 70%),
          linear-gradient(175deg, #241a10 0%, #1b130c 55%, #140e08 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 18px 44px rgba(0,0,0,0.6);
        transform: translateY(12px) scale(0.98);
        transition: transform 260ms cubic-bezier(.2,.9,.2,1);
      }
      #${OVL_ID}.oni-in .tr-eq-panel { transform: translateY(0) scale(1); }

      #${OVL_ID} .tr-eq-head {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 4px; justify-content: center;
      }
      #${OVL_ID} .tr-eq-head img {
        width: 30px; height: 30px; border-radius: 6px; object-fit: contain;
        background: rgba(0,0,0,0.3) !important;
        border: 0 !important; outline: 0 !important; box-shadow: none !important;
      }
      #${OVL_ID} .tr-eq-head-name { font-size: 19px; font-weight: 800; color: #ffeec2; }

      #${OVL_ID} .tr-eq-title {
        text-align: center; font-size: 13px; letter-spacing: 3px;
        text-transform: uppercase; color: rgba(255,233,190,0.7); margin-bottom: 16px;
      }

      #${OVL_ID} .tr-eq-slots {
        display: flex; gap: 8px; justify-content: center; margin-bottom: 14px;
      }
      #${OVL_ID} .tr-eq-slot {
        padding: 6px 14px; border-radius: 999px; cursor: pointer;
        font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
        color: rgba(240,220,176,0.72);
        border: 1px solid #6b5210; background: rgba(0,0,0,0.25);
        transition: all 130ms ease;
      }
      #${OVL_ID} .tr-eq-slot.tr-eq-slot-active {
        color: #1e150c; border-color: #f0d060;
        background: linear-gradient(175deg, #f0d060 0%, #c8960c 100%);
      }

      #${OVL_ID} .tr-eq-body { display: flex; gap: 22px; align-items: stretch; }

      #${OVL_ID} .tr-eq-choices {
        display: flex; flex-direction: column; gap: 10px;
        justify-content: center; min-width: 150px;
      }
      #${OVL_ID} .tr-eq-btn {
        padding: 14px 20px; border-radius: 8px; cursor: pointer;
        font-weight: 800; letter-spacing: 0.05em; font-size: 15px; text-align: center;
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 2px 4px 10px rgba(0,0,0,0.5);
        transition: filter 120ms ease, transform 80ms ease, box-shadow 120ms ease;
      }
      #${OVL_ID} .tr-eq-btn:hover { filter: brightness(1.14); }
      #${OVL_ID} .tr-eq-btn:active { transform: translateY(1px); }
      #${OVL_ID} .tr-eq-btn-yes {
        color: #d8f0c0;
        background: linear-gradient(175deg, #2e5c28 0%, #3a7832 30%, #255022 100%);
      }
      #${OVL_ID} .tr-eq-btn-no {
        color: #e8c890;
        background: linear-gradient(175deg, #4a2c18 0%, #5c3820 30%, #3c2210 100%);
      }
      #${OVL_ID} .tr-eq-btn.tr-eq-default {
        box-shadow: 0 0 0 2px rgba(255,220,130,0.55), 2px 4px 10px rgba(0,0,0,0.5);
      }

      #${OVL_ID} .tr-eq-compare {
        flex: 1; border-radius: 10px; overflow: hidden;
        border: 1px solid #6b5210; background: rgba(0,0,0,0.26);
      }
      #${OVL_ID} table { width: 100%; border-collapse: collapse; }
      #${OVL_ID} th, #${OVL_ID} td {
        padding: 7px 12px; font-size: 13px; text-align: left;
        border-bottom: 1px solid rgba(107,82,16,0.35);
      }
      #${OVL_ID} thead th {
        font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
        color: rgba(240,220,176,0.6); background: rgba(0,0,0,0.3);
      }
      #${OVL_ID} tbody th {
        width: 96px; font-weight: 600; color: rgba(240,220,176,0.55);
        font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
      }
      #${OVL_ID} td { color: #f0dcb0; }
      #${OVL_ID} td.tr-eq-col-new { color: #ffeec2; font-weight: 600; }
      #${OVL_ID} tr:last-child th, #${OVL_ID} tr:last-child td { border-bottom: 0; }
      #${OVL_ID} .tr-eq-empty { color: rgba(240,220,176,0.4); font-style: italic; }
      #${OVL_ID} .tr-eq-up   { color: #9be08a; }
      #${OVL_ID} .tr-eq-down { color: #e08a8a; }
      #${OVL_ID} .tr-eq-delta { font-size: 11px; opacity: 0.9; margin-left: 4px; }

      #${OVL_ID} .tr-eq-foot {
        margin-top: 14px; text-align: center; font-size: 12px;
        font-style: italic; color: rgba(240,220,176,0.55);
      }

      #${OVL_ID}.tr-eq-spectator .tr-eq-btn,
      #${OVL_ID}.tr-eq-spectator .tr-eq-slot {
        cursor: default; pointer-events: none;
      }
      #${OVL_ID}.tr-eq-spectator .tr-eq-btn { opacity: 0.45; }
    `;
    document.head.appendChild(s);
  }

  // ── Row model ─────────────────────────────────────────────────────────────
  // Only rows meaningful for the item's category are rendered, so a shield
  // comparison doesn't show four blank weapon rows.
  function rowsFor(candidate) {
    const cat = String(candidate?.category ?? "weapon").toLowerCase();
    if (cat === "shield") {
      return [
        ["Name",    (c) => c?.name],
        ["Type",    (c) => c?.handSlots ? `Shield · ${c.handSlots}` : "Shield"],
        ["Defense", (c) => c?.defenseLine],
        ["Rarity",  (c) => c?.rarity],
      ];
    }
    if (cat === "accessory") {
      return [
        ["Name",   (c) => c?.name],
        ["Type",   () => "Accessory"],
        ["Rarity", (c) => c?.rarity],
      ];
    }
    if (cat === "armor") {
      return [
        ["Name",    (c) => c?.name],
        ["Type",    () => "Armor"],
        ["Defense", (c) => c?.defenseLine],
        ["Rarity",  (c) => c?.rarity],
      ];
    }
    return [
      ["Name",     (c) => c?.name],
      ["Type",     (c) => [c?.weaponType, c?.handSlots].filter(Boolean).join(" · ")],
      ["Element",  (c) => c?.element],
      ["Attack",   (c) => c?.attackStat],
      ["Accuracy", (c) => c?.checkBonus,  true],
      ["Damage",   (c) => c?.damageBonus, true],
      ["Rarity",   (c) => c?.rarity],
    ];
  }

  const signed = (n) => `${Number(n) >= 0 ? "+" : ""}${Number(n) || 0}`;

  function cellHtml(value, { numeric = false, compareTo = null, isNew = false } = {}) {
    if (value === null || value === undefined || value === "") {
      return `<span class="tr-eq-empty">${EMPTY}</span>`;
    }

    if (!numeric) return esc(value);

    const n = Number(value) || 0;
    let out = esc(signed(n));

    // Delta only on the NEW column, and only when there's something to beat.
    if (isNew && compareTo !== null && compareTo !== undefined) {
      const d = n - (Number(compareTo) || 0);
      if (d !== 0) {
        out += `<span class="tr-eq-delta ${d > 0 ? "tr-eq-up" : "tr-eq-down"}">(${signed(d)})</span>`;
      }
    }
    return out;
  }

  function compareTableHtml(current, incoming) {
    const rows = rowsFor(incoming ?? current);

    const body = rows.map(([label, get, numeric]) => {
      const curRaw = current ? get(current) : null;
      const newRaw = incoming ? get(incoming) : null;

      const curCell = current
        ? cellHtml(curRaw, { numeric })
        : (label === "Name"
            ? `<span class="tr-eq-empty">(Empty)</span>`
            : `<span class="tr-eq-empty">${EMPTY}</span>`);

      const newCell = cellHtml(newRaw, {
        numeric,
        compareTo: current ? curRaw : null,
        isNew: true,
      });

      return `<tr><th>${esc(label)}</th><td>${curCell}</td><td class="tr-eq-col-new">${newCell}</td></tr>`;
    }).join("");

    return `
      <div class="tr-eq-compare">
        <table>
          <thead><tr><th></th><th>Equipped</th><th>New</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function slotTabsHtml(slots, activeKey) {
    if (!slots || slots.length < 2) return "";
    return `
      <div class="tr-eq-slots">
        ${slots.map((s) => `
          <div class="tr-eq-slot${s.key === activeKey ? " tr-eq-slot-active" : ""}" data-slot="${esc(s.key)}">
            ${esc(s.label)}${s.occupied ? "" : " · free"}
          </div>`).join("")}
      </div>`;
  }

  function buildOverlay(payload, interactive) {
    ensureStyles();
    document.getElementById(OVL_ID)?.remove();

    const slots = payload?.slots ?? [];
    const activeKey = payload?.preferredSlotKey ?? slots[0]?.key ?? null;
    const active = slots.find((s) => s.key === activeKey) ?? slots[0] ?? null;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    if (!interactive) overlay.classList.add("tr-eq-spectator");

    overlay.innerHTML = `
      <div class="tr-eq-panel">
        <div class="tr-eq-head">
          <img src="${esc(payload?.portrait ?? "icons/svg/mystery-man.svg")}" alt=""
               onerror="this.src='icons/svg/mystery-man.svg'">
          <span class="tr-eq-head-name">${esc(payload?.actorName ?? "")}</span>
        </div>
        <div class="tr-eq-title">Equip it now?</div>
        ${slotTabsHtml(slots, activeKey)}
        <div class="tr-eq-body">
          <div class="tr-eq-choices">
            <div class="tr-eq-btn tr-eq-btn-no tr-eq-default">No</div>
            <div class="tr-eq-btn tr-eq-btn-yes">Yes</div>
          </div>
          <div class="tr-eq-compare-wrap">
            ${compareTableHtml(active?.current ?? null, payload?.incoming ?? null)}
          </div>
        </div>
        <div class="tr-eq-foot"></div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("oni-in"));

    return { overlay, slots, activeKey };
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
     * @returns {Promise<{equip:boolean, slotKey:string}|null>}
     */
    show({ payload, interactive = false } = {}) {
      if (_resolve) close(null);

      const { overlay, slots } = buildOverlay(payload, interactive);
      let activeKey = payload?.preferredSlotKey ?? slots[0]?.key ?? null;

      return new Promise((resolve) => {
        _resolve = resolve;

        const foot = overlay.querySelector(".tr-eq-foot");
        if (!interactive) {
          const who = payload?.controllerName;
          foot.textContent = who ? `Waiting for ${who}…` : "Waiting for the party leader…";
          return;
        }

        foot.textContent = "Default: No";

        const wrap = overlay.querySelector(".tr-eq-compare-wrap");

        overlay.querySelectorAll(".tr-eq-slot").forEach((el) => {
          el.addEventListener("click", () => {
            activeKey = el.dataset.slot;
            overlay.querySelectorAll(".tr-eq-slot").forEach((t) => {
              t.classList.toggle("tr-eq-slot-active", t.dataset.slot === activeKey);
            });
            const slot = slots.find((s) => s.key === activeKey);
            wrap.innerHTML = compareTableHtml(slot?.current ?? null, payload?.incoming ?? null);
          });
        });

        const answer = (equip) => close({ equip, slotKey: activeKey });

        overlay.querySelector(".tr-eq-btn-yes").addEventListener("click", () => answer(true));
        overlay.querySelector(".tr-eq-btn-no").addEventListener("click", () => answer(false));

        _keyHandler = (ev) => {
          if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); answer(false); }
          if (ev.key === "Enter")  { ev.preventDefault(); ev.stopPropagation(); answer(false); }
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
  globalThis.ONI.TreasureRoulette.EquipUI = API;
  window["oni.TreasureRoulette.EquipUI"] = API;

  console.debug(TAG, "Installed.");
})();
