// ============================================================================
// Opportunity Effect — Bond Editor UI
//
// Standalone bond editor panel for the Bonding opportunity option.
// Appearance and structure clone the camp Bond Update UI (camp-ui-bond.js)
// with these differences:
//   - Actor is passed in directly (no party/camp context needed)
//   - Memory section removed (camp-only feature)
//   - One-emotion-per-session gate removed (player earned this freely)
//   - Confirmation writes directly via BondUpdater.writeBonds() — no camp
//     socket flow, no "waiting for other players" state
//   - Uses its own overlay ID (oni-opp-bond-overlay) so it never conflicts
//     with a concurrently-open camp overlay
//
// Public API:   window["oni.OppBondUI"].show(actor) → Promise<void>
//   Resolves when the player confirms or dismisses (never rejects).
// ============================================================================
(() => {
  const TAG     = "[ONI][OpportunityEffect:BondUI]";
  const OVL_ID  = "oni-opp-bond-overlay";

  // ── Module-level state (only one editor open at a time) ───────────────────────
  let _actor         = null;
  let _originalBonds = [];
  let _resolve       = null;   // Promise resolver

  // ── CSS (injected once; reuses camp-styles keyframes) ─────────────────────────
  const STYLE_ID = "oni-opp-bond-ui-css";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.72);
        z-index: 1200;
        display: flex; align-items: center; justify-content: center;
        animation: campFadeIn .3s ease both;
      }
      #${OVL_ID}.out { animation: campFadeOut .25s ease both; }
      #${OVL_ID} .oni-opp-bond-panel {
        width: min(540px, 92vw);
        max-height: 88vh;
        overflow-y: auto;
        display: flex; flex-direction: column;
      }
      #${OVL_ID} .panel-body {
        flex: 1; overflow-y: auto;
        padding: 4px 0 2px;
      }
      #${OVL_ID} .oni-bond-section-title {
        font-size: .74rem; font-weight: 700; letter-spacing: .08em;
        text-transform: uppercase; opacity: .55; margin-bottom: 6px;
      }
      #${OVL_ID} .bond-add-new-btn {
        margin-top: 8px; width: 100%;
        background: rgba(202,164,77,.15);
        border: 1.5px dashed rgba(202,164,77,.4);
        color: #caa44d; font-size: .82rem;
        padding: 6px; border-radius: 6px;
        cursor: pointer; transition: background .15s;
      }
      #${OVL_ID} .bond-add-new-btn:hover { background: rgba(202,164,77,.28); }
    `;
    document.head.appendChild(s);
  }

  // ── Heart helpers ─────────────────────────────────────────────────────────────
  function _heartHTML(e1, e2, e3) {
    return [e1, e2, e3].map(e => {
      const pol = BondUpdater.emotionPolarity(e);
      if (pol === "positive") return `<i class="fas fa-heart bond-heart positive" title="${e}"></i>`;
      if (pol === "negative") return `<i class="fas fa-heart bond-heart negative" title="${e}"></i>`;
      return `<i class="far fa-heart bond-heart empty"></i>`;
    }).join("");
  }

  function _updateHearts(slotEl) {
    const h = slotEl.querySelector(".bond-hearts");
    if (!h) return;
    h.innerHTML = _heartHTML(
      slotEl.querySelector(".em-1")?.value ?? "",
      slotEl.querySelector(".em-2")?.value ?? "",
      slotEl.querySelector(".em-3")?.value ?? "",
    );
  }

  // ── Slot element factory ──────────────────────────────────────────────────────
  function _capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function _emSelect(pairIdx, selected, cls) {
    const opts = BondUpdater.optionsForPair(pairIdx).map(v =>
      `<option value="${v}" ${v === selected ? "selected" : ""}>${v ? _capitalize(v) : "—"}</option>`
    ).join("");
    const pair  = BondUpdater.PAIRS[pairIdx];
    const title = `${pair.pos} / ${pair.neg}`;
    return `<select class="${cls}" title="${title}">${opts}</select>`;
  }

  function _createSlotEl(bond, animOrder) {
    const el = document.createElement("div");
    el.className = "oni-bond-slot";
    el.dataset.slotIndex    = bond.idx;
    el.style.animationDelay = `${animOrder * 65}ms`;

    el.innerHTML = `
      <div class="bond-slot-header">
        <span class="bond-slot-label">Bond ${bond.idx}</span>
        <span class="bond-hearts">${_heartHTML(bond.e1, bond.e2, bond.e3)}</span>
      </div>
      <div class="bond-name-rel-row">
        <input class="bond-name-input" type="text" placeholder="Name…" value="${bond.name}" />
        <span class="bond-arrow">→</span>
        <input class="bond-rel-input" type="text" placeholder="Relationship…" value="${bond.rel}" />
      </div>
      <div class="bond-em-row">
        ${_emSelect(0, bond.e1, "em-1")}
        ${_emSelect(1, bond.e2, "em-2")}
        ${_emSelect(2, bond.e3, "em-3")}
        <div class="slot-actions">
          <button class="slot-btn clear" data-slot="${bond.idx}">✕ Clear</button>
        </div>
      </div>`;

    ["em-1", "em-2", "em-3"].forEach(cls => {
      el.querySelector(`.${cls}`)?.addEventListener("change", () => {
        _updateHearts(el);
        el.classList.add("modified");
      });
    });
    el.querySelector(".bond-name-input")?.addEventListener("input", () => el.classList.add("modified"));
    el.querySelector(".bond-rel-input")?.addEventListener("input",  () => el.classList.add("modified"));
    el.querySelector(".slot-btn.clear")?.addEventListener("click",  () => _removeSlotEl(el));

    return el;
  }

  // ── Slot add / remove ─────────────────────────────────────────────────────────
  function _removeSlotEl(el) {
    el.style.animation = "campFadeOut .18s ease both";
    setTimeout(() => { el.remove(); _refreshAddNewBtn(); }, 180);
  }

  function _addNewSlot() {
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    if (!slotsEl) return;
    const next = _originalBonds.find(b =>
      !b.name && !slotsEl.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    if (!next) return;
    const order = slotsEl.querySelectorAll(".oni-bond-slot").length;
    slotsEl.appendChild(_createSlotEl(next, order));
    _refreshAddNewBtn();
  }

  function _refreshAddNewBtn() {
    const btn     = document.querySelector(`#${OVL_ID} #oni-opp-bond-add-new`);
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    if (!btn || !slotsEl) return;
    const hasSlot = _originalBonds.some(b =>
      !b.name && !slotsEl.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    btn.style.display = hasSlot ? "" : "none";
  }

  // ── DOM read ──────────────────────────────────────────────────────────────────
  function _readBondsFromDOM() {
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    const visibleIndices = new Set();
    slotsEl?.querySelectorAll(".oni-bond-slot[data-slot-index]").forEach(el => {
      const idx = parseInt(el.dataset.slotIndex);
      if (idx) visibleIndices.add(idx);
    });

    const result = _originalBonds.map(b => {
      if (b.name && !visibleIndices.has(b.idx)) return { ...b, name: "", e1: "", e2: "", e3: "", rel: "" };
      return { ...b };
    });

    slotsEl?.querySelectorAll(".oni-bond-slot[data-slot-index]").forEach(el => {
      const idx   = parseInt(el.dataset.slotIndex);
      const entry = result.find(b => b.idx === idx);
      if (!idx || !entry) return;
      entry.name = el.querySelector(".bond-name-input")?.value?.trim() ?? "";
      entry.e1   = el.querySelector(".em-1")?.value ?? "";
      entry.e2   = el.querySelector(".em-2")?.value ?? "";
      entry.e3   = el.querySelector(".em-3")?.value ?? "";
      entry.rel  = el.querySelector(".bond-rel-input")?.value?.trim() ?? "";
    });

    return result;
  }

  // ── Confirm ───────────────────────────────────────────────────────────────────
  async function _confirm() {
    if (!_actor) return;
    const updated = _readBondsFromDOM();
    const changes = BondUpdater.buildChangelog(_originalBonds, updated);

    if (changes.length) {
      await BondUpdater.writeBonds(_actor, updated)
        .catch(e => console.error(TAG, "writeBonds failed:", e));
    }

    _close();
  }

  // ── Close ─────────────────────────────────────────────────────────────────────
  function _close() {
    const el = document.getElementById(OVL_ID);
    if (el) {
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    }
    const res = _resolve;
    _resolve       = null;
    _actor         = null;
    _originalBonds = [];
    res?.();
  }

  // ── Overlay build ─────────────────────────────────────────────────────────────
  function _buildOverlay() {
    document.getElementById(OVL_ID)?.remove();
    ensureStyles();

    const filledBonds = _originalBonds.filter(b => b.name);
    const hasEmpty    = _originalBonds.some(b => !b.name);

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-opp-bond-panel">
        <div class="oni-camp-panel__title">
          <i class="fas fa-heart"></i> Bond Update — ${_actor.name}
        </div>
        <div style="font-size:.82rem;opacity:.65;padding:2px 0 8px;">
          Update or add one bond, then confirm.
        </div>
        <div class="panel-body">
          <div class="oni-bond-section-title">Active Bonds</div>
          <div id="oni-opp-bond-slots"></div>
          <button class="bond-add-new-btn" id="oni-opp-bond-add-new"
            style="${hasEmpty ? "" : "display:none;"}">
            <i class="fas fa-plus"></i> Add Bond
          </button>
        </div>
        <hr>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
          <button class="oni-camp-btn danger" id="oni-opp-bond-cancel">
            <i class="fas fa-times"></i> Cancel
          </button>
          <button class="oni-camp-btn" id="oni-opp-bond-confirm">
            <i class="fas fa-check"></i> Confirm
          </button>
        </div>
      </div>`;

    const slotsEl = overlay.querySelector("#oni-opp-bond-slots");
    filledBonds.forEach((bond, i) => slotsEl.appendChild(_createSlotEl(bond, i)));

    overlay.querySelector("#oni-opp-bond-add-new")?.addEventListener("click", _addNewSlot);
    overlay.querySelector("#oni-opp-bond-confirm")?.addEventListener("click", _confirm);
    overlay.querySelector("#oni-opp-bond-cancel")?.addEventListener("click",  _close);

    document.body.appendChild(overlay);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  window["oni.OppBondUI"] = Object.freeze({
    /**
     * Show the bond editor for the given actor.
     * Returns a Promise that resolves when the player confirms or cancels.
     */
    show(actor) {
      if (!actor) return Promise.resolve();
      if (!globalThis.BondUpdater) {
        console.error(TAG, "BondUpdater not loaded.");
        return Promise.resolve();
      }

      return new Promise(resolve => {
        _actor         = actor;
        _originalBonds = BondUpdater.readBonds(actor);
        _resolve       = resolve;
        _buildOverlay();
      });
    },
  });

  console.debug(TAG, "Bond UI ready.");
})();
