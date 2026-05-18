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

  let _localHovers     = {};
  let _focusedKey      = null;
  let _activeTab       = "available"; // "available" | "unavailable"
  let _unavailableKeys = new Set();   // activity keys the current actor cannot perform

  CAMP.ActivitySelectUI = {
    _party: [],

    async show() {
      this._party = await CAMP.Party.resolve().catch(() => []);
      _localHovers     = {};
      _focusedKey      = null;
      _activeTab       = "available";
      _computeUnavailableKeys(this._party);
      _buildOverlay(this._party);
      this.refresh();
      CAMP.Sound.play(CAMP.SFX.CAMP_START);
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

        const isMine      = !!myActorId && myActorId === lockedBy;
        const lockedOther = !!(lockedBy && !isMine);
        const hovSelf     = !myLocked && hoveredBy === myActorId;

        row.classList.toggle("locked-self",      !!isMine);
        row.classList.toggle("locked-other",     lockedOther);
        row.classList.toggle("hov-self",         !!hovSelf);
        row.classList.toggle("act-focused",      key === _focusedKey);
        row.classList.toggle("confirmed-locked", iAmConfirmed);

        // Color-code other players' selections using their Foundry user color
        let otherUserColor = null;
        if (lockedOther) {
          const owner = this._party.find(e => e.actorId === lockedBy);
          const user  = owner?.userId ? game.users?.get(owner.userId) : null;
          otherUserColor = String(user?.color ?? "#8a6030");
          row.style.borderColor = otherUserColor;
          row.style.background  = _hexToRgba(otherUserColor, 0.13);
        } else {
          row.style.borderColor = "";
          row.style.background  = "";
        }

        const tagEl = row.querySelector(".act-row-tag");
        if (tagEl) {
          if (lockedBy) {
            const owner = this._party.find(e => e.actorId === lockedBy);
            const actorName = game.actors?.get(lockedBy)?.name ?? owner?.userName ?? "?";
            tagEl.textContent  = isMine ? "✓ You" : actorName;
            tagEl.style.color  = otherUserColor ?? "";
            tagEl.style.display = "";
          } else {
            tagEl.style.display = "none";
            tagEl.style.color   = "";
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

  function _hexToRgba(hex, alpha) {
    const h = String(hex).replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function activePlayerCount() {
    return (game.users?.contents ?? []).filter(u => u.active && !u.isGM).length;
  }

  function _getMyActorId() {
    const userId = game.user?.id;
    return CAMP.ActivitySelectUI._party.find(e => e.userId === userId)?.actorId
        ?? game.user?.character?.id
        ?? null;
  }

  function _setDesc(def, available = true) {
    const panel = document.getElementById("oni-camp-act-desc-panel");
    if (!panel) return;
    if (!def) {
      panel.innerHTML = `<p class="act-desc-placeholder">Hover an activity to see its description.</p>`;
      return;
    }
    const req        = def.requiredClass;
    const classes    = Array.isArray(req) ? req : (req ? [req] : []);
    const isAny      = classes.length === 0 || classes.every(c => !c || c === "any");
    const reqClass   = isAny ? "Any" : classes.join(", ");
    const lockIcon   = available ? "fas fa-graduation-cap" : "fas fa-lock";
    const reqCls     = available ? "act-desc-req-class" : "act-desc-req-class is-locked";
    const unavailMsg = available ? "" : `
      <div class="act-desc-unavail-notice">
        <i class="fas fa-ban"></i> This activity is not available to your character.
      </div>`;
    panel.innerHTML = `
      <div class="act-desc-icon"><i class="${def.icon}"></i></div>
      <div class="act-desc-name">${def.name}</div>
      <div class="act-desc-target">${def.target}</div>
      <div class="act-desc-divider"></div>
      <div class="act-desc-body">${def.desc}</div>
      <div class="act-desc-divider"></div>
      <div class="${reqCls}"><i class="${lockIcon}"></i> Required class: <strong>${reqClass}</strong></div>
      ${unavailMsg}
    `;
  }

  // ---------------------------------------------------------------------------
  function _computeUnavailableKeys(party) {
    _unavailableKeys = new Set();
    if (game.user?.isGM) return; // GM bypasses class gate
    const userId    = game.user?.id;
    const myEntry   = party.find(e => e.userId === userId);
    const myActorId = myEntry?.actorId ?? game.user?.character?.id ?? null;
    const myActor   = myActorId ? game.actors?.get(myActorId) : null;
    for (const def of CAMP.ACTIVITY_DEFS) {
      if (!CAMP.actorHasClass(myActor, def.requiredClass)) {
        _unavailableKeys.add(def.key);
      }
    }
  }

  function _buildOverlay(party) {
    document.getElementById(OVL_ID)?.remove();

    const isGM        = game.user?.isGM;
    const isSpectator = !_getMyActorId();
    const showTabs    = !isGM && !isSpectator;
    const availCount   = CAMP.ACTIVITY_DEFS.length - _unavailableKeys.size;
    const unavailCount = _unavailableKeys.size;

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
    if (isSpectator) overlay.classList.add("oni-camp-spectator");
    overlay.innerHTML = `
      <div class="oni-camp-panel oni-camp-activity-panel">
        <div class="oni-camp-panel__title"><i class="fas fa-campfire"></i> Camp Activities</div>
        <div class="oni-camp-act-body">

          <div class="oni-camp-act-list-col">
            ${showTabs ? `
            <div class="oni-camp-act-tab-bar">
              <button class="oni-camp-act-tab is-active" data-tab="available">Available <span class="act-tab-count">(${availCount})</span></button>
              <button class="oni-camp-act-tab" data-tab="unavailable">Unavailable <span class="act-tab-count">(${unavailCount})</span></button>
            </div>` : ""}
            <div class="oni-camp-act-rows" id="oni-camp-act-rows">
              <div id="oni-camp-rows-available"></div>
              <div id="oni-camp-rows-unavailable" style="display:none;"></div>
            </div>
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

    // Build available activity rows
    const availRowsEl = overlay.querySelector("#oni-camp-rows-available");
    CAMP.ACTIVITY_DEFS.filter(d => !_unavailableKeys.has(d.key)).forEach((def, i) => {
      const row = document.createElement("div");
      row.className = "oni-camp-act-row";
      row.dataset.activityKey = def.key;
      row.style.animation      = `campRowSlideIn 0.24s ease both`;
      row.style.animationDelay = `${i * 48}ms`;
      row.innerHTML = `
        <span class="act-row-icon"><i class="${def.icon}"></i></span>
        <span class="act-row-name">${def.name}</span>
        <span class="act-row-tag" style="display:none;"></span>
      `;
      row.addEventListener("mouseenter", () => {
        _focusedKey = def.key;
        _setDesc(def, true);
        _onHover(def.key);
        CAMP.Sound.play(CAMP.SFX.ACTIVITY_HOVER);
        CAMP.ActivitySelectUI.refresh();
      });
      row.addEventListener("mouseleave", () => _onHover(null));
      row.addEventListener("click", () => {
        CAMP.Sound.play(CAMP.SFX.ACTIVITY_SELECT);
        _onClickActivity(def.key);
      });
      availRowsEl.appendChild(row);
    });

    // Build unavailable activity rows (inspect-only)
    const unavailRowsEl = overlay.querySelector("#oni-camp-rows-unavailable");
    CAMP.ACTIVITY_DEFS.filter(d => _unavailableKeys.has(d.key)).forEach((def, i) => {
      const row = document.createElement("div");
      row.className = "oni-camp-act-row-unavail";
      row.dataset.activityKey = def.key;
      row.style.animation      = `campRowSlideIn 0.24s ease both`;
      row.style.animationDelay = `${i * 48}ms`;
      row.innerHTML = `
        <span class="act-row-icon"><i class="${def.icon}"></i></span>
        <span class="act-row-name">${def.name}</span>
        <span class="act-row-lock"><i class="fas fa-lock"></i></span>
      `;
      row.addEventListener("mouseenter", () => {
        _focusedKey = def.key;
        _setDesc(def, false);
        CAMP.Sound.play(CAMP.SFX.ACTIVITY_HOVER);
      });
      row.addEventListener("mouseleave", () => {
        _setDesc(null);
        _focusedKey = null;
      });
      // Click: show full description (inspect) but do not lock/select
      row.addEventListener("click", () => {
        _setDesc(def, false);
        CAMP.Sound.play(CAMP.SFX.ACTIVITY_HOVER);
      });
      unavailRowsEl.appendChild(row);
    });

    // Tab switching
    if (showTabs) {
      overlay.querySelectorAll(".oni-camp-act-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          const tab = btn.dataset.tab;
          _activeTab = tab;
          overlay.querySelectorAll(".oni-camp-act-tab").forEach(b =>
            b.classList.toggle("is-active", b.dataset.tab === tab)
          );
          overlay.querySelector("#oni-camp-rows-available").style.display   = tab === "available"   ? "" : "none";
          overlay.querySelector("#oni-camp-rows-unavailable").style.display = tab === "unavailable" ? "" : "none";
          _setDesc(null);
          _focusedKey = null;
        });
      });
    }

    // Confirm button (players only)
    overlay.querySelector("#oni-camp-act-confirm")?.addEventListener("click", () => {
      CAMP.Sound.play(CAMP.SFX.ACTIVITY_CONFIRM);
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
    // Unavailable activities are inspect-only — no selection allowed
    if (_unavailableKeys.has(activityKey)) return;

    const userId = game.user?.id;
    // Blocked while confirmed — must un-confirm first via Confirm button
    if (CAMP.State.getReady()[userId]) return;

    const myActorId = _getMyActorId();
    if (!myActorId) return; // spectator — no party actor, silently block

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
