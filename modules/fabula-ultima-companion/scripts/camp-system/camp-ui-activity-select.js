// ============================================================================
// Camp System — Activity Selection UI
//
// Left list / right description layout.
// Players click to select an activity, then click Confirm to lock in.
// When all active players confirm → auto-advance to ACTIVITY_RESOLVE.
// GM sees controls only; does not count toward the confirm threshold.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][ActivitySelect]";
  const OVL_ID = "oni-camp-overlay";

  let _localHovers = {};
  let _focusedKey  = null;

  CAMP.ActivitySelectUI = {
    _party: [],

    async show() {
      this._party = await CAMP.Party.resolve().catch(() => []);
      _localHovers = {};
      _focusedKey  = null;
      _buildOverlay(this._party);
      this.refresh();
    },

    hide() {
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 280);
    },

    refresh() {
      const sel       = CAMP.State.getSelections();
      const readyMap  = CAMP.State.getReady();
      const userId    = game.user?.id;
      const myActorId = _getMyActorId();
      const myLocked  = myActorId ? sel[myActorId]?.locked ?? null : null;
      const iAmConfirmed = !game.user?.isGM && !!readyMap[userId];

      // Update activity rows
      document.querySelectorAll(".oni-camp-act-row").forEach(row => {
        const key = row.dataset.activityKey;

        let lockedBy = null, hoveredBy = null;
        for (const [aid, entry] of Object.entries(sel)) {
          if (entry.locked === key) { lockedBy = aid; break; }
        }
        for (const [aid, hk] of Object.entries(_localHovers)) {
          if (hk === key) { hoveredBy = aid; break; }
        }

        const isMine      = myActorId === lockedBy;
        const lockedOther = !!(lockedBy && !isMine);
        const hovSelf     = !myLocked && hoveredBy === myActorId;

        row.classList.toggle("locked-self",      !!isMine);
        row.classList.toggle("locked-other",     lockedOther);
        row.classList.toggle("hov-self",         !!hovSelf);
        row.classList.toggle("act-focused",      key === _focusedKey);
        row.classList.toggle("confirmed-locked", iAmConfirmed);

        const tagEl = row.querySelector(".act-row-tag");
        if (tagEl) {
          if (lockedBy) {
            const owner = this._party.find(e => e.actorId === lockedBy);
            tagEl.textContent = isMine ? "✓ You" : `🔒 ${owner?.userName ?? "Other"}`;
            tagEl.style.display = "";
          } else {
            tagEl.style.display = "none";
          }
        }
      });

      // Confirm button
      const confirmBtn = document.getElementById("oni-camp-act-confirm");
      if (confirmBtn) {
        confirmBtn.disabled   = !myLocked && !iAmConfirmed;
        confirmBtn.classList.toggle("confirmed", iAmConfirmed);
        confirmBtn.textContent = iAmConfirmed ? "✓ Confirmed — click to change" : "Confirm Selection";
      }

      // Lobby dots — show which active players have confirmed
      const dotsEl = document.getElementById("oni-camp-act-lobby-dots");
      if (dotsEl) {
        const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
        if (activeUsers.length > 0) {
          dotsEl.innerHTML = activeUsers.map(u => {
            const r = !!readyMap[u.id];
            return `<div class="oni-camp-lobby-dot ${r ? "ready" : ""}" title="${u.name}"></div>`;
          }).join("");
        } else {
          dotsEl.innerHTML = `<span style="font-size:.75em;opacity:.5;font-style:italic;">Solo GM mode</span>`;
        }
      }

      // Status text
      const status = document.getElementById("oni-camp-act-status");
      if (status) {
        const confirmedCount = Object.keys(readyMap).length;
        const activeUsers = (game.users?.contents ?? []).filter(u => u.active && !u.isGM);
        const total = activeUsers.length || this._party.length || 1;
        status.textContent = `${confirmedCount} / ${total} confirmed`;
      }
    },

    onRemoteHover(actorId, activityKey) {
      if (!actorId) return;
      _localHovers[actorId] = activityKey;
      this.refresh();
    },
  };

  // ---------------------------------------------------------------------------

  function activePlayerCount() {
    return (game.users?.contents ?? []).filter(u => u.active && !u.isGM).length;
  }

  function _getMyActorId() {
    const userId = game.user?.id;
    return CAMP.ActivitySelectUI._party.find(e => e.userId === userId)?.actorId
        ?? game.user?.character?.id
        ?? null;
  }

  function _setDesc(def) {
    const panel = document.getElementById("oni-camp-act-desc-panel");
    if (!panel) return;
    if (!def) {
      panel.innerHTML = `<p class="act-desc-placeholder">Hover an activity to see its description.</p>`;
      return;
    }
    panel.innerHTML = `
      <div class="act-desc-icon"><i class="${def.icon}"></i></div>
      <div class="act-desc-name">${def.name}</div>
      <div class="act-desc-target">${def.target}</div>
      <div class="act-desc-divider"></div>
      <div class="act-desc-body">${def.desc}</div>
    `;
  }

  // ---------------------------------------------------------------------------
  function _buildOverlay(party) {
    document.getElementById(OVL_ID)?.remove();

    const isGM = game.user?.isGM;

    const gmBar = isGM ? `
      <div class="oni-camp-gm-override">
        <span class="gm-override-label"><i class="fas fa-shield-alt"></i> GM</span>
        <button class="oni-camp-gm-btn" id="oni-camp-act-fill">Fill Remaining</button>
        <button class="oni-camp-gm-btn" id="oni-camp-act-force">Force Continue →</button>
      </div>` : "";

    const confirmRow = !isGM ? `
      <div class="oni-camp-act-confirm-row">
        <div class="oni-camp-act-lobby-dots" id="oni-camp-act-lobby-dots"></div>
        <button class="oni-camp-btn" id="oni-camp-act-confirm" disabled>Confirm Selection</button>
      </div>` : `
      <div class="oni-camp-act-confirm-row">
        <div class="oni-camp-act-lobby-dots" id="oni-camp-act-lobby-dots"></div>
        <span id="oni-camp-act-status" class="act-footer-status">0 / 0 confirmed</span>
      </div>`;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-camp-activity-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-campfire"></i> Camp Activities</div>
        <div class="oni-camp-act-body">

          <div class="oni-camp-act-list-col">
            <div class="oni-camp-act-rows" id="oni-camp-act-rows"></div>
          </div>

          <div class="oni-camp-act-desc-col">
            <div id="oni-camp-act-desc-panel">
              <p class="act-desc-placeholder">Hover an activity to see its description.</p>
            </div>
          </div>

        </div>
        <div class="oni-camp-act-footer">
          ${confirmRow}
          ${isGM ? "" : `<span id="oni-camp-act-status" class="act-footer-status" style="margin-top:4px;">0 / 0 confirmed</span>`}
          ${gmBar}
        </div>
      </div>
    `;

    // Build activity rows
    const rows = overlay.querySelector("#oni-camp-act-rows");
    CAMP.ACTIVITY_DEFS.forEach(def => {
      const row = document.createElement("div");
      row.className = "oni-camp-act-row";
      row.dataset.activityKey = def.key;
      row.innerHTML = `
        <span class="act-row-icon"><i class="${def.icon}"></i></span>
        <span class="act-row-name">${def.name}</span>
        <span class="act-row-tag" style="display:none;"></span>
      `;
      row.addEventListener("mouseenter", () => {
        _focusedKey = def.key;
        _setDesc(def);
        _onHover(def.key);
        CAMP.ActivitySelectUI.refresh();
      });
      row.addEventListener("mouseleave", () => _onHover(null));
      row.addEventListener("click",      () => _onClickActivity(def.key));
      rows.appendChild(row);
    });

    // Confirm button (players only)
    overlay.querySelector("#oni-camp-act-confirm")?.addEventListener("click", () => {
      CAMP.Socket.emit(CAMP.MSG.TOGGLE_READY, { userId: game.user?.id });
    });

    // GM controls
    overlay.querySelector("#oni-camp-act-fill")?.addEventListener("click",  () => _gmFillRemaining());
    overlay.querySelector("#oni-camp-act-force")?.addEventListener("click", () => _gmForceAdvance());

    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  function _onHover(activityKey) {
    const myActorId = _getMyActorId();
    if (!myActorId) return;
    _localHovers[myActorId] = activityKey;
    game.socket.emit(CAMP.SOCKET_CH, {
      type:    CAMP.MSG.HOVER_ACTIVITY,
      payload: { actorId: myActorId, activityKey },
    });
  }

  function _onClickActivity(activityKey) {
    const userId = game.user?.id;
    // Blocked while confirmed — must un-confirm first via Confirm button
    if (CAMP.State.getReady()[userId]) return;

    const myActorId = _getMyActorId();
    if (!myActorId) {
      ui.notifications?.warn("No character found. Make sure your actor is assigned.");
      return;
    }

    const sel      = CAMP.State.getSelections();
    const myLocked = sel[myActorId]?.locked ?? null;

    if (myLocked === activityKey) {
      // Deselect same activity
      CAMP.Socket.emit(CAMP.MSG.UNLOCK_ACTIVITY, { actorId: myActorId });
    } else {
      // Check if taken by someone else
      if (CAMP.State.isActivityLocked(activityKey)) {
        ui.notifications?.warn("That activity is already chosen by another party member.");
        return;
      }
      // Switch: unlock current then lock new
      if (myLocked) CAMP.Socket.emit(CAMP.MSG.UNLOCK_ACTIVITY, { actorId: myActorId });
      CAMP.Socket.emit(CAMP.MSG.LOCK_ACTIVITY, { actorId: myActorId, activityKey });
    }
  }

  // ---------------------------------------------------------------------------
  // GM helpers
  async function _gmFillRemaining() {
    if (!game.user?.isGM) return;
    const party = CAMP.ActivitySelectUI._party;
    const sel   = CAMP.State.getSelections();
    const taken = new Set(Object.values(sel).map(e => e.locked).filter(Boolean));
    for (const { actorId } of party) {
      if (sel[actorId]?.locked) continue;
      const avail = CAMP.ACTIVITY_DEFS.find(d => !taken.has(d.key));
      if (!avail) break;
      const res = await CAMP.State.setLocked(actorId, avail.key);
      if (res.ok) taken.add(avail.key);
    }
    CAMP.ActivitySelectUI.refresh();
  }

  async function _gmForceAdvance() {
    if (!game.user?.isGM) return;
    await CAMP.State.clearReady();
    await CAMP.State.setPhase(CAMP.PHASE.ACTIVITY_RESOLVE);
  }

  console.debug(TAG, "ActivitySelect UI loaded.");
})();
