// ============================================================================
// Camp System — Bond Editor UI
//
// Delegates all actor read/write to BondUpdater (bond-updater-core.js).
// Rules enforced:
//   - Only filled bonds shown; empty slots hidden until "+Add Bond" clicked.
//   - One-update gate: only one bond slot may have emotion changes per session.
//     Switching to a different slot resets the previous slot's emotions.
//     Name and relationship fields are always free to edit.
//   - Creating a new bond panel is free; adding an emotion to it uses the gate.
// ============================================================================
(() => {
  const CAMP     = globalThis.CampSystem ??= {};
  const TAG      = "[CampSystem][BondUI]";
  const OVL_ID   = "oni-camp-overlay";
  const MEM_FLAG = "campBondMemories";

  let _actor                   = null;
  let _originalBonds           = [];   // pristine snapshot from BondUpdater.readBonds()
  let _pendingMems             = [];   // current full memory list (mirrors memories_list)
  let _newlyMovedToMemory      = [];   // bonds moved to memory THIS session (for summary)
  let _newlyRemovedFromMemory  = [];   // memories cleared THIS session (for summary)
  // Tracks the one allowed emotion change: { slotIdx, emClass, origValue } | null
  let _gatedField         = null;

  // ── Public API ──────────────────────────────────────────────────────────────
  CAMP.BondUI = {
    async show() {
      CAMP.Sound.play(CAMP.SFX.BOND_START);

      if (game.user?.isGM) {
        await _buildGMWait();
        return;
      }

      const mine    = await CAMP.Party.getMine().catch(() => null);
      const raw     = mine?.actor ?? game.user?.character ?? null;
      // Always use the persistent world actor — synthetic token actors don't save
      _actor = raw?.isToken ? (game.actors.get(raw.id) ?? raw) : raw;
      // Final fallback: look up by actorId directly
      if (!_actor && mine?.actorId) _actor = game.actors.get(mine.actorId) ?? null;

      if (!_actor) {
        ui.notifications?.warn("No character found for bond editing. Ask your GM to assign your actor.");
        return;
      }

      _originalBonds      = BondUpdater.readBonds(_actor);
      _pendingMems            = _readMemoriesFromActor(_actor);
      _newlyMovedToMemory     = [];
      _newlyRemovedFromMemory = [];
      _gatedField             = null;
      _buildOverlay();
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },

    isConfirmed() {
      return !!CAMP.State.getBondConfirmed()[game.user?.id];
    },

    async confirm() {
      if (!_actor) return;

      if (this.isConfirmed()) {
        CAMP.Socket.emit(CAMP.MSG.UNCONFIRM_BOND, { userId: game.user?.id });
        _setConfirmedState(false);
        return;
      }

      const updated = _readBondsFromDOM();
      const changes = BondUpdater.buildChangelog(_originalBonds, updated);

      for (const change of changes) {
        const slot = updated.find(b => b.idx === change.slot);
        if (!slot) continue;
        await BondUpdater.writeSlot(_actor, slot.idx, slot);
      }

      // Write memories to the actor sheet's memories_list dynamic table and clear old flag
      await _actor.update({ 'system.props.memories_list': _buildMemoriesPayload(_pendingMems) }).catch(() => {});
      await _actor.unsetFlag(CAMP.MODULE_ID, MEM_FLAG).catch(() => {});

      CAMP.Socket.emit(CAMP.MSG.CONFIRM_BOND, {
        userId: game.user?.id,
        summary: { actorId: _actor.id, actorName: _actor.name, changes, memChanges: _newlyMovedToMemory, memRemovals: _newlyRemovedFromMemory },
      });

      CAMP.Sound.play(CAMP.SFX.BOND_CONFIRM);
      _setConfirmedState(true);
    },
  };

  // ── DOM read ─────────────────────────────────────────────────────────────────
  function _readBondsFromDOM() {
    // Build set of slot indices currently visible in the DOM
    const visibleIndices = new Set();
    document.querySelectorAll(".oni-bond-slot[data-slot-index]").forEach(el => {
      const idx = parseInt(el.dataset.slotIndex);
      if (idx) visibleIndices.add(idx);
    });

    // Start from a full copy; slots removed from the DOM (Cleared) are blanked out
    const result = _originalBonds.map(b => {
      if (b.name && !visibleIndices.has(b.idx)) {
        // Slot was visible originally but was cleared by the user — zero it out
        return { ...b, name: "", e1: "", e2: "", e3: "", rel: "" };
      }
      return { ...b };
    });

    document.querySelectorAll(".oni-bond-slot[data-slot-index]").forEach(el => {
      const idx   = parseInt(el.dataset.slotIndex);
      const entry = result.find(b => b.idx === idx);
      if (!idx || !entry) return;
      entry.name = el.querySelector(".bond-name-input")?.value?.trim()  ?? "";
      entry.e1   = el.querySelector(".em-1")?.value                     ?? "";
      entry.e2   = el.querySelector(".em-2")?.value                     ?? "";
      entry.e3   = el.querySelector(".em-3")?.value                     ?? "";
      entry.rel  = el.querySelector(".bond-rel-input")?.value?.trim()   ?? "";
    });
    return result;
  }

  // ── Gate logic (per-field: only one dropdown change allowed per session) ──────
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
    const n  = slotEl.querySelector(".bond-name-input")?.value?.trim() ?? "";
    const r  = slotEl.querySelector(".bond-rel-input")?.value?.trim()  ?? "";
    const e1 = slotEl.querySelector(".em-1")?.value ?? "";
    const e2 = slotEl.querySelector(".em-2")?.value ?? "";
    const e3 = slotEl.querySelector(".em-3")?.value ?? "";
    if (n === orig.name && r === orig.rel && e1 === orig.e1 && e2 === orig.e2 && e3 === orig.e3)
      slotEl.classList.remove("modified");
  }

  function _applyGate(slotIdx, emClass, selEl) {
    const origVal     = _emOrigValue(slotIdx, emClass);
    const isSameField = _gatedField?.slotIdx === slotIdx && _gatedField?.emClass === emClass;

    if (isSameField) {
      // Same field: if user reset it back to original, release gate
      if (selEl.value === origVal) {
        _gatedField = null;
        document.querySelector(`.oni-bond-slot[data-slot-index="${slotIdx}"]`)?.classList.remove("gate-active");
      }
      return;
    }

    // Different field — reset the previously gated one
    if (_gatedField !== null) {
      const { slotIdx: gSlot, emClass: gClass, origValue } = _gatedField;
      const oldEl = document.querySelector(`.oni-bond-slot[data-slot-index="${gSlot}"]`);
      if (oldEl) {
        const oldSel = oldEl.querySelector(`.${gClass}`);
        if (oldSel) oldSel.value = origValue;
        _updateHearts(oldEl);
        oldEl.classList.remove("gate-active");
        _recheckModified(oldEl, gSlot);
      }
    }

    // Gate the new field only if it actually differs from the original
    if (selEl.value !== origVal) {
      _gatedField = { slotIdx, emClass, origValue: origVal };
      document.querySelector(`.oni-bond-slot[data-slot-index="${slotIdx}"]`)?.classList.add("gate-active");
    } else {
      _gatedField = null;
    }
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
          <button class="slot-btn to-mem" data-slot="${bond.idx}">📦 Memory</button>
          <button class="slot-btn clear"  data-slot="${bond.idx}">✕ Clear</button>
        </div>
      </div>
    `;

    // Emotion selects → gate + hearts + sounds
    ["em-1", "em-2", "em-3"].forEach(emClass => {
      const sel = el.querySelector(`.${emClass}`);
      if (!sel) return;
      sel.addEventListener("mouseenter", () => CAMP.Sound.play(CAMP.SFX.BOND_HOVER));
      sel.addEventListener("change", () => {
        CAMP.Sound.play(CAMP.SFX.BOND_DROPDOWN_CHANGE);
        _applyGate(bond.idx, emClass, sel);
        _updateHearts(el);
        el.classList.add("modified");
      });
    });

    // Name / rel → always free
    el.querySelector(".bond-name-input")?.addEventListener("input",  () => el.classList.add("modified"));
    el.querySelector(".bond-rel-input")?.addEventListener("input",   () => el.classList.add("modified"));

    el.querySelector(".slot-btn.to-mem")?.addEventListener("click", () => _moveToMemory(bond.idx));
    el.querySelector(".slot-btn.clear")?.addEventListener("click",  () => _removeSlotEl(el, bond.idx));

    return el;
  }

  // ── Slot add/remove ────────────────────────────────────────────────────────────
  function _addNewSlot() {
    const slotsEl = document.getElementById("oni-bond-slots");
    if (!slotsEl) return;

    const next = _originalBonds.find(b =>
      !b.name && !document.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    if (!next) return;

    const order = slotsEl.querySelectorAll(".oni-bond-slot").length;
    slotsEl.appendChild(_createSlotEl(next, order));
    _refreshAddNewBtn();
  }

  function _removeSlotEl(el, slotIdx) {
    if (_gatedField?.slotIdx === slotIdx) _gatedField = null;
    el.style.animation = "campFadeOut .18s ease both";
    setTimeout(() => {
      el.remove();
      _refreshAddNewBtn();
    }, 180);
  }

  function _refreshAddNewBtn() {
    const btn     = document.getElementById("oni-bond-add-new");
    if (!btn) return;
    const hasSlot = _originalBonds.some(b =>
      !b.name && !document.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    btn.style.display = hasSlot ? "" : "none";
  }

  // ── Memory persistence helpers ────────────────────────────────────────────────

  /** Read memories from actor's memories_list dynamic table.
   *  Falls back to old campBondMemories flag for one-time migration. */
  function _readMemoriesFromActor(actor) {
    const tbl = actor?.system?.props?.memories_list ?? {};
    const rows = Object.values(tbl).filter(r => !r.$deleted && r.memory_x?.trim());
    if (rows.length) {
      return rows.map(r => ({
        name: r.memory_x       ?? "",
        e1:   r.emotion_x      ?? "",
        e2:   r.emotion_y      ?? "",
        e3:   r.emotion_z      ?? "",
        rel:  r.relationship_x ?? "",
      }));
    }
    // Migration fallback: read from old flag
    return actor.getFlag(CAMP.MODULE_ID, MEM_FLAG) ?? [];
  }

  /** Convert _pendingMems array to the object format expected by memories_list. */
  function _buildMemoriesPayload(mems) {
    const result = {};
    mems.forEach((m, i) => {
      result[String(i)] = {
        $deleted:       false,
        memory_x:       m.name ?? "",
        emotion_x:      m.e1   ?? "",
        emotion_y:      m.e2   ?? "",
        emotion_z:      m.e3   ?? "",
        relationship_x: m.rel  ?? "",
      };
    });
    return result;
  }

  // ── Memory operations ─────────────────────────────────────────────────────────
  function _moveToMemory(slotIdx) {
    const el   = document.querySelector(`.oni-bond-slot[data-slot-index="${slotIdx}"]`);
    const name = el?.querySelector(".bond-name-input")?.value?.trim() ?? "";
    if (!name) return;
    const mem = {
      name,
      e1:  el.querySelector(".em-1")?.value              ?? "",
      e2:  el.querySelector(".em-2")?.value              ?? "",
      e3:  el.querySelector(".em-3")?.value              ?? "",
      rel: el.querySelector(".bond-rel-input")?.value?.trim() ?? "",
    };
    _pendingMems.push(mem);
    _newlyMovedToMemory.push({ ...mem });
    _removeSlotEl(el, slotIdx);
    _rebuildMemoryList();
  }

  function _moveFromMemory(memIdx) {
    const mem     = _pendingMems[memIdx];
    if (!mem) return;

    const slotsEl     = document.getElementById("oni-bond-slots");
    const visibleCount = slotsEl?.querySelectorAll(".oni-bond-slot[data-slot-index]").length ?? 0;

    if (visibleCount >= BondUpdater.MAX_BONDS) {
      ui.notifications?.warn("Bond limit reached (max 6). Clear a bond slot first.");
      return;
    }

    // Find any slot not currently visible in the DOM — includes originally-empty
    // slots AND slots that were moved to memory or cleared, freeing their index.
    const next = _originalBonds.find(b =>
      !document.querySelector(`.oni-bond-slot[data-slot-index="${b.idx}"]`)
    );
    if (!next) { ui.notifications?.warn("No available bond slot found."); return; }

    slotsEl?.appendChild(_createSlotEl({ ...next, ...mem }, visibleCount));

    // If this memory was moved here THIS session, un-track it — net effect is no change
    const nmIdx = _newlyMovedToMemory.findIndex(m => m.name === mem.name);
    if (nmIdx >= 0) _newlyMovedToMemory.splice(nmIdx, 1);

    _pendingMems.splice(memIdx, 1);
    _rebuildMemoryList();
    _refreshAddNewBtn();
  }

  function _removeFromMemory(memIdx) {
    const mem = _pendingMems[memIdx];
    if (!mem) return;

    // If moved here THIS session, un-track it (bond changelog already captures the release).
    // If it was a pre-existing memory, track it for the summary "memoryReleased" log.
    const nmIdx = _newlyMovedToMemory.findIndex(m => m.name === mem.name);
    if (nmIdx >= 0) {
      _newlyMovedToMemory.splice(nmIdx, 1);
    } else {
      _newlyRemovedFromMemory.push({ ...mem });
    }

    _pendingMems.splice(memIdx, 1);
    _rebuildMemoryList();
  }

  function _memItemHTML(m, i) {
    const heartsHtml = _heartHTML(m.e1 ?? "", m.e2 ?? "", m.e3 ?? "");
    const emOpts = (val, pairIdx) => BondUpdater.optionsForPair(pairIdx).map(v =>
      `<option value="${v}" ${v === val ? "selected" : ""}>${v ? _capitalize(v) : "—"}</option>`
    ).join("");
    const p = BondUpdater.PAIRS;
    return `
      <div class="oni-memory-item" data-mem-index="${i}">
        <div class="bond-slot-header">
          <span class="bond-slot-label">Memory ${i + 1}</span>
          <span class="bond-hearts">${heartsHtml}</span>
        </div>
        <div class="bond-name-rel-row">
          <input class="bond-name-input" type="text" value="${m.name ?? ""}" disabled />
          <span class="bond-arrow">→</span>
          <input class="bond-rel-input" type="text" value="${m.rel ?? ""}" placeholder="Relationship…" disabled />
        </div>
        <div class="bond-em-row">
          <select title="${p[0].pos} / ${p[0].neg}" disabled>${emOpts(m.e1 ?? "", 0)}</select>
          <select title="${p[1].pos} / ${p[1].neg}" disabled>${emOpts(m.e2 ?? "", 1)}</select>
          <select title="${p[2].pos} / ${p[2].neg}" disabled>${emOpts(m.e3 ?? "", 2)}</select>
          <div class="slot-actions">
            <button class="slot-btn from-mem"  data-mem="${i}">↑ Bond</button>
            <button class="slot-btn clear-mem" data-mem="${i}">✕ Clear</button>
          </div>
        </div>
      </div>`;
  }

  function _rebuildMemoryList(root = document) {
    const list = root.querySelector("#oni-memory-list");
    if (!list) return;
    if (!_pendingMems.length) {
      list.innerHTML = `<div style="opacity:.5;font-size:.82em;font-style:italic;">No memories yet.</div>`;
      return;
    }
    list.innerHTML = _pendingMems.map((m, i) => _memItemHTML(m, i)).join("");
    list.querySelectorAll(".slot-btn.from-mem").forEach(btn =>
      btn.addEventListener("click", () => _moveFromMemory(parseInt(btn.dataset.mem)))
    );
    list.querySelectorAll(".slot-btn.clear-mem").forEach(btn =>
      btn.addEventListener("click", () => _removeFromMemory(parseInt(btn.dataset.mem)))
    );
  }

  // ── Main overlay ──────────────────────────────────────────────────────────────
  function _buildOverlay() {
    document.getElementById(OVL_ID)?.remove();

    const filledBonds = _originalBonds.filter(b => b.name);
    const hasEmpty    = _originalBonds.some(b => !b.name);

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-camp-bond-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-heart"></i> Bond Update — ${_actor.name}</div>
        <div class="bond-subtitle">Modify one bond for tonight's camp, then confirm.</div>
        <div class="panel-body">
          <div class="oni-bond-section-title">Active Bonds</div>
          <div id="oni-bond-slots"></div>
          <button class="bond-add-new-btn" id="oni-bond-add-new" style="${hasEmpty ? "" : "display:none;"}">
            <i class="fas fa-plus"></i> Add Bond
          </button>

          <hr style="margin:14px 0 10px;">
          <div class="oni-bond-section-title">Memories</div>
          <div id="oni-memory-list"></div>
        </div>
        <hr>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
          <button class="oni-camp-btn" id="oni-bond-confirm">
            <i class="fas fa-check"></i> Confirm Bonds
          </button>
        </div>
      </div>
    `;

    const slotsEl = overlay.querySelector("#oni-bond-slots");
    filledBonds.forEach((bond, i) => slotsEl.appendChild(_createSlotEl(bond, i)));

    _rebuildMemoryList(overlay);

    overlay.querySelector("#oni-bond-add-new")?.addEventListener("click", _addNewSlot);
    overlay.querySelector("#oni-bond-confirm")?.addEventListener("click",  () => CAMP.BondUI.confirm());
    overlay.querySelector("#oni-bond-confirm")?.addEventListener("mouseenter", () => CAMP.Sound.play(CAMP.SFX.BOND_HOVER));

    document.body.appendChild(overlay);
  }

  // ── Confirmed state ────────────────────────────────────────────────────────────
  function _setConfirmedState(confirmed) {
    const panel = document.querySelector(".oni-camp-bond-panel");
    if (!panel) return;
    panel.querySelectorAll(".oni-bond-slot input, .oni-bond-slot select, .slot-btn, .bond-add-new-btn")
         .forEach(el => { el.disabled = confirmed; });

    const btn = document.getElementById("oni-bond-confirm");
    if (btn) {
      btn.classList.toggle("confirmed", confirmed);
      btn.innerHTML = confirmed
        ? `<i class="fas fa-check-circle"></i> Confirmed — click to change`
        : `<i class="fas fa-check"></i> Confirm Bonds`;
    }

    let msg = panel.querySelector(".oni-bond-wait-msg");
    if (confirmed && !msg) {
      msg = document.createElement("div");
      msg.className = "oni-bond-wait-msg";
      msg.style.cssText = "text-align:center;margin-top:10px;font-size:.82em;opacity:.7;font-style:italic;";
      msg.textContent = "Waiting for other players…";
      panel.querySelector("hr:last-of-type")?.before(msg);
    } else if (!confirmed) {
      msg?.remove();
    }
  }

  // ── GM wait overlay ────────────────────────────────────────────────────────────
  async function _buildGMWait() {
    document.getElementById(OVL_ID)?.remove();
    // Only count active clients linked to a party member; spectators have no
    // party entry and must not gate the bond-confirm wait.
    const partyIds    = await CAMP.Party.getActiveUserIds().catch(() => []);
    const activeUsers = (game.users?.contents ?? [])
      .filter(u => u.active && !u.isGM && partyIds.includes(u.id));
    const confirmed   = CAMP.State.getBondConfirmed?.() ?? {};
    const dots = activeUsers.map(u => {
      const r = !!confirmed[u.id];
      return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
    }).join("");

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel" style="width:min(480px,88vw);text-align:center;">
        <div class="oni-camp-panel__title"><i class="fas fa-heart"></i> Bond Update</div>
        <div class="oni-camp-inner-panel" style="text-align:center;">
          <div style="font-size:.88em;margin-bottom:12px;">
            Players are updating their bonds.<br>Waiting for everyone to confirm…
          </div>
          <div class="oni-camp-lobby-dots" style="justify-content:center;">
            ${dots || '<span style="font-size:.75em;opacity:.65;">No active players</span>'}
          </div>
        </div>
        <div class="oni-camp-gm-override" style="justify-content:center;">
          <span class="gm-override-label"><i class="fas fa-shield-alt"></i> GM</span>
          <button class="oni-camp-gm-btn" id="oni-camp-bond-force">Force Next Phase →</button>
        </div>
      </div>
    `;
    overlay.querySelector("#oni-camp-bond-force")?.addEventListener("click", async () => {
      await CAMP.State.setPhase(CAMP.PHASE.BOND_SUMMARY);
    });
    document.body.appendChild(overlay);
  }

})();
