// ============================================================================
// Opportunity Effect — Bond Editor UI
//
// Standalone bond editor panel for the Bonding opportunity option.
// Appearance and structure clone the camp Bond Update UI (camp-ui-bond.js)
// with these differences:
//   - Actor is passed in directly (no party/camp context needed)
//   - Memory section removed (camp-only feature)
//   - Confirmation writes directly via BondUpdater.writeBonds() — no camp
//     socket flow, no "waiting for other players" state
//   - Uses its own overlay ID (oni-opp-bond-overlay) so it never conflicts
//     with a concurrently-open camp overlay
//
// Rules enforced:
//   - Existing bonds: name and relationship are read-only; filled emotion
//     slots are disabled; no Clear button (bonds cannot be deleted).
//   - ONE emotion gate: only one existing-bond emotion slot may be changed
//     per session. Switching to a different slot resets the previous one.
//     (Same mechanic as camp-ui-bond.js — mirrors the "Add one emotion" rule.)
//   - New bonds (added via "Add Bond"): fully editable with a Clear button;
//     require a name and at least one emotion to confirm.
//   - Soft mutual exclusion: the Add Bond button is hidden while a gate is
//     active, and hidden once a new slot is being added.
//
// Public API:
//   window["oni.OppBondUI"].show(actor, onConfirmed?) → Promise<void>
//   Resolves when the player confirms or dismisses (never rejects).
//   onConfirmed(changelog) is called with the diff array before close.
// ============================================================================
(() => {
  const TAG    = "[ONI][OpportunityEffect:BondUI]";
  const OVL_ID = "oni-opp-bond-overlay";

  // ── Module-level state (only one editor open at a time) ──────────────────
  let _actor          = null;
  let _originalBonds  = [];
  let _resolve        = null;
  let _onConfirmed    = null;   // optional callback(changelog) after confirm
  let _newSlotIndices = new Set();
  // One-emotion gate: { slotIdx, emClass, origValue } | null
  // Identical pattern to camp-ui-bond.js _gatedField.
  let _gatedField     = null;

  // ── CSS (injected once; reuses camp-styles keyframes) ────────────────────
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
      #${OVL_ID} .oni-bond-slot.gate-active {
        border-left: 3px solid rgba(202,164,77,.75);
        padding-left: 6px;
        transition: border-left .15s;
      }
      #${OVL_ID} .oni-bond-slot input[readonly] {
        opacity: .45; cursor: not-allowed;
        background: rgba(0,0,0,.08);
      }
      #${OVL_ID} .oni-bond-slot select:disabled {
        opacity: .35; cursor: not-allowed;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Heart helpers ─────────────────────────────────────────────────────────
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

  // ── Gate logic (mirrors camp-ui-bond.js) ──────────────────────────────────
  function _emOrigValue(slotIdx, emClass) {
    const orig = _originalBonds.find(b => b.idx === slotIdx);
    if (!orig) return "";
    if (emClass === "em-1") return orig.e1;
    if (emClass === "em-2") return orig.e2;
    if (emClass === "em-3") return orig.e3;
    return "";
  }

  function _recheckModified(slotEl, slotIdx) {
    const orig = _originalBonds.find(b => b.idx === slotIdx);
    if (!orig) return;
    const e1 = slotEl.querySelector(".em-1")?.value ?? "";
    const e2 = slotEl.querySelector(".em-2")?.value ?? "";
    const e3 = slotEl.querySelector(".em-3")?.value ?? "";
    if (e1 === orig.e1 && e2 === orig.e2 && e3 === orig.e3)
      slotEl.classList.remove("modified");
  }

  function _applyGate(slotIdx, emClass, selEl) {
    const origVal     = _emOrigValue(slotIdx, emClass);
    const isSameField = _gatedField?.slotIdx === slotIdx && _gatedField?.emClass === emClass;

    if (isSameField) {
      // Same field: if user reset it back to original, release the gate
      if (selEl.value === origVal) {
        _gatedField = null;
        document.querySelector(`#${OVL_ID} .oni-bond-slot[data-slot-index="${slotIdx}"]`)
          ?.classList.remove("gate-active");
        _refreshAddNewBtn();
      }
      return;
    }

    // Different field — reset the previously gated one
    if (_gatedField !== null) {
      const { slotIdx: gSlot, emClass: gClass, origValue } = _gatedField;
      const oldEl = document.querySelector(`#${OVL_ID} .oni-bond-slot[data-slot-index="${gSlot}"]`);
      if (oldEl) {
        const oldSel = oldEl.querySelector(`.${gClass}`);
        if (oldSel) oldSel.value = origValue;
        _updateHearts(oldEl);
        oldEl.classList.remove("gate-active");
        _recheckModified(oldEl, gSlot);
      }
    }

    // Gate the new field if it actually differs from original
    if (selEl.value !== origVal) {
      _gatedField = { slotIdx, emClass, origValue: origVal };
      document.querySelector(`#${OVL_ID} .oni-bond-slot[data-slot-index="${slotIdx}"]`)
        ?.classList.add("gate-active");
    } else {
      _gatedField = null;
    }
    _refreshAddNewBtn();
  }

  // ── Slot element factory ──────────────────────────────────────────────────
  function _capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function _emSelect(pairIdx, selected, cls, disabled) {
    const opts = BondUpdater.optionsForPair(pairIdx).map(v =>
      `<option value="${v}" ${v === selected ? "selected" : ""}>${v ? _capitalize(v) : "—"}</option>`
    ).join("");
    const pair  = BondUpdater.PAIRS[pairIdx];
    const title = `${pair.pos} / ${pair.neg}`;
    const dis   = disabled ? "disabled" : "";
    return `<select class="${cls}" title="${title}" ${dis}>${opts}</select>`;
  }

  /**
   * Build a bond slot DOM element.
   * @param {object}  bond       Bond data object from BondUpdater.readBonds()
   * @param {number}  animOrder  Stagger index for entry animation
   * @param {boolean} isNew      True for newly-added slots (not in original data)
   */
  function _createSlotEl(bond, animOrder, isNew) {
    const el = document.createElement("div");
    el.className = "oni-bond-slot";
    el.dataset.slotIndex    = bond.idx;
    el.style.animationDelay = `${animOrder * 65}ms`;
    if (isNew) el.dataset.isNew = "1";

    // Existing bonds: name/rel locked; filled emotion slots disabled
    const nameRO = isNew ? "" : "readonly";
    const relRO  = isNew ? "" : "readonly";
    const em1Dis = !isNew && !!bond.e1;
    const em2Dis = !isNew && !!bond.e2;
    const em3Dis = !isNew && !!bond.e3;

    const clearBtn = isNew
      ? `<button class="slot-btn clear" data-slot="${bond.idx}">✕ Clear</button>`
      : "";

    el.innerHTML = `
      <div class="bond-slot-header">
        <span class="bond-slot-label">Bond ${bond.idx}</span>
        <span class="bond-hearts">${_heartHTML(bond.e1, bond.e2, bond.e3)}</span>
      </div>
      <div class="bond-name-rel-row">
        <input class="bond-name-input" type="text" placeholder="Name…"
          value="${bond.name}" ${nameRO} />
        <span class="bond-arrow">→</span>
        <input class="bond-rel-input" type="text" placeholder="Relationship…"
          value="${bond.rel}" ${relRO} />
      </div>
      <div class="bond-em-row">
        ${_emSelect(0, bond.e1, "em-1", em1Dis)}
        ${_emSelect(1, bond.e2, "em-2", em2Dis)}
        ${_emSelect(2, bond.e3, "em-3", em3Dis)}
        <div class="slot-actions">${clearBtn}</div>
      </div>`;

    if (isNew) {
      // New bond: full editing, no gate restriction on emotions
      ["em-1", "em-2", "em-3"].forEach(cls => {
        el.querySelector(`.${cls}`)?.addEventListener("change", () => {
          _updateHearts(el);
          el.classList.add("modified");
        });
      });
      el.querySelector(".bond-name-input")?.addEventListener("input",
        () => el.classList.add("modified"));
      el.querySelector(".bond-rel-input")?.addEventListener("input",
        () => el.classList.add("modified"));
      el.querySelector(".slot-btn.clear")?.addEventListener("click",
        () => _removeSlotEl(el));
    } else {
      // Existing bond: only empty emotion slots are interactive, subject to gate
      [["em-1", bond.e1], ["em-2", bond.e2], ["em-3", bond.e3]].forEach(([cls, origVal]) => {
        if (origVal) return; // this slot was already filled — disabled in HTML
        const sel = el.querySelector(`.${cls}`);
        if (!sel) return;
        sel.addEventListener("change", () => {
          _applyGate(bond.idx, cls, sel);
          _updateHearts(el);
          el.classList.add("modified");
        });
      });
    }

    return el;
  }

  // ── Slot add / remove ─────────────────────────────────────────────────────
  function _removeSlotEl(el) {
    const idx = parseInt(el.dataset.slotIndex);
    el.style.animation = "campFadeOut .18s ease both";
    setTimeout(() => {
      el.remove();
      _newSlotIndices.delete(idx);
      _refreshAddNewBtn();
    }, 180);
  }

  function _addNewSlot() {
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    if (!slotsEl) return;
    const next = _originalBonds.find(b =>
      !b.name && !slotsEl.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    if (!next) return;
    const order = slotsEl.querySelectorAll(".oni-bond-slot").length;
    slotsEl.appendChild(_createSlotEl(next, order, true));
    _newSlotIndices.add(next.idx);
    _refreshAddNewBtn();
  }

  function _refreshAddNewBtn() {
    const btn     = document.querySelector(`#${OVL_ID} #oni-opp-bond-add-new`);
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    if (!btn || !slotsEl) return;
    // Hide if: no empty slots left, OR already adding a new bond, OR gate is active
    const hasEmptySlot = _originalBonds.some(b =>
      !b.name && !slotsEl.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    btn.style.display = (!hasEmptySlot || _newSlotIndices.size > 0 || _gatedField !== null)
      ? "none" : "";
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function _validateNewBonds() {
    const slotsEl = document.querySelector(`#${OVL_ID} #oni-opp-bond-slots`);
    if (!slotsEl) return null;
    for (const idx of _newSlotIndices) {
      const el   = slotsEl.querySelector(`.oni-bond-slot[data-slot-index="${idx}"]`);
      if (!el) continue;
      const name = el.querySelector(".bond-name-input")?.value?.trim() ?? "";
      const e1   = el.querySelector(".em-1")?.value ?? "";
      const e2   = el.querySelector(".em-2")?.value ?? "";
      const e3   = el.querySelector(".em-3")?.value ?? "";
      if (!name)         return "Please enter a name for the new bond.";
      if (!e1 && !e2 && !e3) return "Please select at least one emotion for the new bond.";
    }
    return null;
  }

  // ── DOM read ──────────────────────────────────────────────────────────────
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

  // ── Confirm ───────────────────────────────────────────────────────────────
  async function _confirm() {
    if (!_actor) return;

    const validationError = _validateNewBonds();
    if (validationError) {
      ui.notifications?.warn(validationError);
      return;
    }

    const updated   = _readBondsFromDOM();
    const changelog = BondUpdater.buildChangelog(_originalBonds, updated);

    if (changelog.length) {
      await BondUpdater.writeBonds(_actor, updated)
        .catch(e => console.error(TAG, "writeBonds failed:", e));
      _onConfirmed?.(changelog);
    }

    _close();
  }

  // ── Close ─────────────────────────────────────────────────────────────────
  function _close() {
    const el = document.getElementById(OVL_ID);
    if (el) {
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    }
    const res    = _resolve;
    _resolve         = null;
    _actor           = null;
    _originalBonds   = [];
    _onConfirmed     = null;
    _newSlotIndices  = new Set();
    _gatedField      = null;
    res?.();
  }

  // ── Overlay build ─────────────────────────────────────────────────────────
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
          Add a new bond, or add one emotion to an existing bond, then confirm.
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
    filledBonds.forEach((bond, i) => slotsEl.appendChild(_createSlotEl(bond, i, false)));

    overlay.querySelector("#oni-opp-bond-add-new")?.addEventListener("click", _addNewSlot);
    overlay.querySelector("#oni-opp-bond-confirm")?.addEventListener("click", _confirm);
    overlay.querySelector("#oni-opp-bond-cancel")?.addEventListener("click",  _close);

    document.body.appendChild(overlay);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window["oni.OppBondUI"] = Object.freeze({
    /**
     * Show the bond editor for the given actor.
     * @param {Actor}     actor
     * @param {Function}  [onConfirmed]  Called with changelog after a successful confirm.
     * @returns {Promise<void>}
     */
    show(actor, onConfirmed) {
      if (!actor) return Promise.resolve();
      if (!globalThis.BondUpdater) {
        console.error(TAG, "BondUpdater not loaded.");
        return Promise.resolve();
      }

      return new Promise(resolve => {
        _actor          = actor;
        _originalBonds  = BondUpdater.readBonds(actor);
        _resolve        = resolve;
        _onConfirmed    = onConfirmed ?? null;
        _newSlotIndices = new Set();
        _gatedField     = null;
        _buildOverlay();
      });
    },
  });

  console.debug(TAG, "Bond UI ready.");
})();
