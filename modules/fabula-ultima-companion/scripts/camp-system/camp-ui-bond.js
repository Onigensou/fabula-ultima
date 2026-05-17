// ============================================================================
// Camp System — Bond Editor UI
//
// Local-only UI. Each player edits their own actor's bonds during the
// BOND_UPDATE phase. On confirm:
//   1. Actor is updated directly (player owns their actor)
//   2. Summary sent to GM via socket for the bond summary phase
// ============================================================================
(() => {
  const CAMP    = globalThis.CampSystem ??= {};
  const TAG     = "[CampSystem][BondUI]";
  const OVL_ID  = "oni-camp-overlay";
  const MEM_FLAG = "campBondMemories"; // flag key on actor

  // Pending changes tracked locally before confirm
  let _pendingBondData = [];   // copy of all bond slots (1-6)
  let _pendingMemories = [];   // copy of memory list
  let _changes = [];           // change log for summary
  let _actor = null;

  CAMP.BondUI = {
    async show() {
      if (game.user?.isGM) {
        _buildGMWaitOverlay();
        return;
      }

      // Resolve actor: party lookup first, then game.user.character
      const mine = await CAMP.Party.getMine().catch(() => null);
      _actor = mine?.actor ?? game.user?.character ?? null;

      if (!_actor) {
        ui.notifications?.warn("No character found for bond editing. Ask your GM to assign your actor.");
        return;
      }

      _pendingBondData = _readBonds(_actor);
      _pendingMemories = _readMemories(_actor);
      _changes = [];
      _buildOverlay(_actor.name, _pendingBondData, _pendingMemories);
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },

    // Returns current confirmed state from world setting
    isConfirmed() {
      return !!CAMP.State.getBondConfirmed()[game.user?.id];
    },

    async confirm() {
      if (!_actor) return;

      // If already confirmed → toggle off (un-confirm so player can edit again)
      if (this.isConfirmed()) {
        CAMP.Socket.emit(CAMP.MSG.UNCONFIRM_BOND, { userId: game.user?.id });
        _setConfirmedState(false);
        return;
      }

      // Read bonds from DOM
      const bondEl   = document.querySelectorAll(".oni-bond-slot");
      const newBonds = [];
      bondEl.forEach(slot => {
        const idx = parseInt(slot.dataset.slotIndex);
        if (!idx) return;
        newBonds.push({
          idx,
          name: slot.querySelector(".bond-name-input")?.value ?? "",
          e1:   slot.querySelector(".em-1")?.value            ?? "",
          e2:   slot.querySelector(".em-2")?.value            ?? "",
          e3:   slot.querySelector(".em-3")?.value            ?? "",
          rel:  slot.querySelector(".bond-rel-input")?.value  ?? "",
        });
      });

      // Build change log
      _changes = [];
      for (const b of newBonds) {
        const orig = _pendingBondData.find(o => o.idx === b.idx);
        if (!orig) continue;
        if (b.name === orig.name && b.e1 === orig.e1 && b.e2 === orig.e2 && b.e3 === orig.e3 && b.rel === orig.rel) continue;
        if (!orig.name && b.name)       _changes.push({ type: "add",    slot: b.idx, after: b });
        else if (orig.name && !b.name)  _changes.push({ type: "remove", slot: b.idx, before: orig });
        else                            _changes.push({ type: "update",  slot: b.idx, before: { ...orig }, after: b });
      }

      // Apply to actor
      const updateData = {};
      for (const b of newBonds) {
        updateData[`system.props.bond_${b.idx}`]          = b.name;
        updateData[`system.props.emotion_${b.idx}_1`]    = b.e1;
        updateData[`system.props.emotion_${b.idx}_2`]    = b.e2;
        updateData[`system.props.emotion_${b.idx}_3`]    = b.e3;
        updateData[`system.props.relationship_${b.idx}`] = b.rel;
      }
      await _actor.update(updateData);
      await _actor.setFlag(CAMP.MODULE_ID, MEM_FLAG, _pendingMemories);

      // Notify GM
      const summary = {
        actorId:    _actor.id,
        actorName:  _actor.name,
        changes:    _changes,
        memChanges: _pendingMemories,
      };
      CAMP.Socket.emit(CAMP.MSG.CONFIRM_BOND, { userId: game.user?.id, summary });

      // Stay on screen — show confirmed state
      _setConfirmedState(true);
    },
  };

  // ---------------------------------------------------------------------------
  // Read helpers
  // ---------------------------------------------------------------------------
  function _readBonds(actor) {
    const p = actor.system?.props ?? {};
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      bonds.push({
        idx: i,
        name: String(p[`bond_${i}`]              ?? ""),
        e1:   String(p[`emotion_${i}_1`]         ?? ""),
        e2:   String(p[`emotion_${i}_2`]         ?? ""),
        e3:   String(p[`emotion_${i}_3`]         ?? ""),
        rel:  String(p[`relationship_${i}`]      ?? ""),
      });
    }
    return bonds;
  }

  function _readMemories(actor) {
    return actor.getFlag(CAMP.MODULE_ID, MEM_FLAG) ?? [];
  }

  // ---------------------------------------------------------------------------
  // DOM builder
  // ---------------------------------------------------------------------------
  function _emOptions(selected) {
    return CAMP.EMOTIONS.map(e => `<option value="${e}" ${e === selected ? "selected" : ""}>${e || "(none)"}</option>`).join("");
  }

  function _buildBondSlot(bond) {
    const isEmpty = !bond.name;
    return `
      <div class="oni-bond-slot ${isEmpty ? "empty" : ""}" data-slot-index="${bond.idx}">
        <div class="slot-label">Bond ${bond.idx}</div>
        <input class="bond-name-input" type="text" placeholder="Name…" value="${bond.name}" style="grid-column:1/3;" />
        <input class="bond-rel-input"  type="text" placeholder="Relationship…" value="${bond.rel}" style="grid-column:3/5;" />
        <div class="bond-em-row" style="grid-column:1/4;">
          <select class="em-1">${_emOptions(bond.e1)}</select>
          <select class="em-2">${_emOptions(bond.e2)}</select>
          <select class="em-3">${_emOptions(bond.e3)}</select>
        </div>
        <div class="slot-actions">
          ${bond.name ? `<button class="slot-btn to-mem" data-slot="${bond.idx}" title="Move to Memory">📦 Memory</button>` : ""}
          ${bond.name ? `<button class="slot-btn clear"  data-slot="${bond.idx}" title="Clear bond">✕ Clear</button>` : ""}
        </div>
      </div>
    `;
  }

  function _buildMemoryItem(mem, idx) {
    const emotions = [mem.e1, mem.e2, mem.e3].filter(Boolean).join(", ") || "no emotions";
    return `
      <div class="oni-memory-item" data-mem-index="${idx}">
        <div class="mem-name">${mem.name}</div>
        <div class="mem-emotions">${emotions}</div>
        <div class="mem-actions">
          <button class="slot-btn from-mem" data-mem="${idx}" title="Move to active bonds">↑ Bond</button>
        </div>
      </div>
    `;
  }

  function _buildOverlay(actorName, bonds, memories) {
    document.getElementById(OVL_ID)?.remove();

    const bondSlots   = bonds.map(_buildBondSlot).join("");
    const memoryItems = memories.length
      ? memories.map((m, i) => _buildMemoryItem(m, i)).join("")
      : `<div style="opacity:.5;font-size:.82em;font-style:italic;">No memories yet.</div>`;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-camp-bond-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-heart"></i> Bond Update — ${actorName}</div>
        <div style="font-size:.8em;opacity:.65;margin-bottom:8px;">
          You may modify one or more bonds for tonight's camp. Confirm when done.
        </div>
        <div class="panel-body">
          <div class="oni-bond-section-title">Active Bonds</div>
          <div id="oni-bond-slots">${bondSlots}</div>

          <hr style="margin:14px 0;">

          <div class="oni-bond-section-title">Memories</div>
          <div id="oni-memory-list">${memoryItems}</div>
        </div>
        <hr>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
          <button class="oni-camp-btn" id="oni-bond-confirm">
            <i class="fas fa-check"></i> Confirm Bonds
          </button>
        </div>
      </div>
    `;

    // Confirm
    overlay.querySelector("#oni-bond-confirm")?.addEventListener("click", () => CAMP.BondUI.confirm());

    // "Move to Memory" buttons
    overlay.querySelectorAll(".slot-btn.to-mem").forEach(btn => {
      btn.addEventListener("click", () => _moveToMemory(parseInt(btn.dataset.slot)));
    });

    // "Clear" buttons
    overlay.querySelectorAll(".slot-btn.clear").forEach(btn => {
      btn.addEventListener("click", () => _clearSlot(parseInt(btn.dataset.slot)));
    });

    // "From Memory" buttons
    overlay.querySelectorAll(".slot-btn.from-mem").forEach(btn => {
      btn.addEventListener("click", () => _moveFromMemory(parseInt(btn.dataset.mem)));
    });

    // Mark slots as modified on input
    overlay.querySelectorAll(".oni-bond-slot input, .oni-bond-slot select").forEach(el => {
      el.addEventListener("input", () => {
        const slot = el.closest(".oni-bond-slot");
        if (slot) slot.classList.add("modified");
      });
    });

    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  // Memory operations (mutate _pendingMemories, rebuild list)
  // ---------------------------------------------------------------------------
  function _moveToMemory(slotIdx) {
    const slot = document.querySelector(`.oni-bond-slot[data-slot-index="${slotIdx}"]`);
    if (!slot) return;
    const name = slot.querySelector(".bond-name-input")?.value?.trim() ?? "";
    if (!name) return;
    const e1 = slot.querySelector(".em-1")?.value ?? "";
    const e2 = slot.querySelector(".em-2")?.value ?? "";
    const e3 = slot.querySelector(".em-3")?.value ?? "";
    const rel = slot.querySelector(".bond-rel-input")?.value ?? "";

    _pendingMemories.push({ name, e1, e2, e3, rel });

    // Clear the slot visually
    _clearSlot(slotIdx);
    _rebuildMemoryList();
  }

  function _moveFromMemory(memIdx) {
    const mem = _pendingMemories[memIdx];
    if (!mem) return;

    // Find first empty bond slot
    const emptySlot = document.querySelector(".oni-bond-slot.empty");
    if (!emptySlot) {
      ui.notifications?.warn("No empty bond slot available.");
      return;
    }
    emptySlot.querySelector(".bond-name-input").value = mem.name;
    emptySlot.querySelector(".em-1").value = mem.e1 ?? "";
    emptySlot.querySelector(".em-2").value = mem.e2 ?? "";
    emptySlot.querySelector(".em-3").value = mem.e3 ?? "";
    emptySlot.querySelector(".bond-rel-input").value = mem.rel ?? "";
    emptySlot.classList.remove("empty");
    emptySlot.classList.add("modified");

    _pendingMemories.splice(memIdx, 1);
    _rebuildMemoryList();
  }

  function _clearSlot(slotIdx) {
    const slot = document.querySelector(`.oni-bond-slot[data-slot-index="${slotIdx}"]`);
    if (!slot) return;
    slot.querySelector(".bond-name-input").value = "";
    slot.querySelector(".bond-rel-input").value  = "";
    slot.querySelector(".em-1").value = "";
    slot.querySelector(".em-2").value = "";
    slot.querySelector(".em-3").value = "";
    slot.classList.add("empty", "modified");
  }

  function _rebuildMemoryList() {
    const list = document.getElementById("oni-memory-list");
    if (!list) return;
    if (!_pendingMemories.length) {
      list.innerHTML = `<div style="opacity:.5;font-size:.82em;font-style:italic;">No memories yet.</div>`;
      return;
    }
    list.innerHTML = _pendingMemories.map((m, i) => _buildMemoryItem(m, i)).join("");
    list.querySelectorAll(".slot-btn.from-mem").forEach(btn => {
      btn.addEventListener("click", () => _moveFromMemory(parseInt(btn.dataset.mem)));
    });
  }

  function _buildGMWaitOverlay() {
    const OVL_ID = "oni-camp-overlay";
    document.getElementById(OVL_ID)?.remove();

    const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
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
          <div class="oni-camp-lobby-dots" id="oni-camp-bond-wait-dots" style="justify-content:center;">
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

  // ---------------------------------------------------------------------------
  // Confirmed-state toggle (player stays on screen, inputs locked/unlocked)
  // ---------------------------------------------------------------------------
  function _setConfirmedState(confirmed) {
    const panel = document.querySelector(".oni-camp-bond-panel");
    if (!panel) return;

    // Lock / unlock all slot inputs
    panel.querySelectorAll(".oni-bond-slot input, .oni-bond-slot select, .slot-btn").forEach(el => {
      el.disabled = confirmed;
    });

    // Confirm button appearance
    const btn = document.getElementById("oni-bond-confirm");
    if (btn) {
      btn.classList.toggle("confirmed", confirmed);
      btn.innerHTML = confirmed
        ? `<i class="fas fa-check-circle"></i> Confirmed — click to change`
        : `<i class="fas fa-check"></i> Confirm Bonds`;
    }

    // Waiting status message
    let msg = panel.querySelector(".oni-bond-wait-msg");
    if (confirmed) {
      if (!msg) {
        msg = document.createElement("div");
        msg.className = "oni-bond-wait-msg";
        msg.style.cssText = "text-align:center;margin-top:10px;font-size:.82em;opacity:.7;font-style:italic;";
        panel.querySelector("hr:last-of-type")?.before(msg);
      }
      msg.textContent = "Waiting for other players…";
    } else {
      msg?.remove();
    }
  }

  console.debug(TAG, "Bond UI loaded.");
})();
