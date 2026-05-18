// ============================================================================
// Camp Activity — Exploration UI
//
// Shows a roulette overlay when the Exploration activity runs.
// Owner client: spinning number + STOP button.
// All other clients (including GM): spectator view synced via socket.
//
// Sync flow:
//   GM broadcasts EXPLORATION_START  → all clients call show() (GM called directly)
//   Owner presses STOP               → _applyResultUI locally + emit EXPLORATION_RESULT
//   All clients receive RESULT        → applyResult() (idempotent, owner's 2nd call is no-op)
//   GM also calls resolveRoll()       → continues execute()
//   GM broadcasts EXPLORATION_DONE   → all clients call hide()
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const TAG    = "[CampSystem][ExplorationUI]";
  const OVL_ID = "oni-camp-exploration-ovl";

  // Outcome labels
  const RESULT_LABELS = {
    1: { heading: "Ouch!",                       sub: "Recovers only half HP & MP during rest.", color: "#c62828" },
    2: { heading: "Not what I was looking for…", sub: "+2 Inventory Points",                     color: "#7a5010" },
    3: { heading: "Hoho, this can be useful!",   sub: "+3 Inventory Points",                     color: "#3a7a35" },
    4: { heading: "Hoho, this can be useful!",   sub: "+3 Inventory Points",                     color: "#3a7a35" },
    5: { heading: "Hoho, this can be useful!",   sub: "+3 Inventory Points",                     color: "#3a7a35" },
    6: { heading: "Jackpot!",                    sub: "+3 IP and Level × 50 Zenit!",              color: "#b8820a" },
  };

  // Sound URLs
  const SFX = {
    START:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_start.wav",
    TICK:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    STOP:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    JACKPOT: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
    OUCH:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ME/Shock2.ogg",
    RESULT:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
  };

  // ── Web Audio — low-latency tick (avoids HTMLAudio main-thread stalls) ────

  let _audioCtx   = null;
  let _tickBuffer = null;

  async function _initWebAudio() {
    if (_audioCtx) return;
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      const resp = await fetch(SFX.TICK);
      const buf  = await resp.arrayBuffer();
      _tickBuffer = await _audioCtx.decodeAudioData(buf);
    } catch (e) {
      console.warn(TAG, "Web Audio init failed — using HTMLAudio fallback:", e);
      _audioCtx = null; _tickBuffer = null;
    }
  }

  let _lastTickMs = 0;
  let _tickAudio  = null;   // HTMLAudio fallback node (reused)

  function _playTick() {
    const now = Date.now();
    if (now - _lastTickMs < 80) return;
    _lastTickMs = now;

    // Web Audio path — no main-thread blocking
    if (_audioCtx && _tickBuffer) {
      try {
        if (_audioCtx.state === "suspended") _audioCtx.resume();
        const src  = _audioCtx.createBufferSource();
        const gain = _audioCtx.createGain();
        src.buffer      = _tickBuffer;
        gain.gain.value = 0.45;
        src.connect(gain);
        gain.connect(_audioCtx.destination);
        src.start(0);
      } catch {}
      return;
    }
    // HTMLAudio fallback
    try {
      if (!_tickAudio) { _tickAudio = new Audio(SFX.TICK); _tickAudio.volume = 0.45; }
      _tickAudio.currentTime = 0;
      _tickAudio.play().catch(() => {});
    } catch {}
  }

  function _playSound(src, volume = 0.7) {
    try {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (AH) { AH.play({ src, volume, autoplay: true, loop: false }, false); return; }
    } catch {}
    try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
  }

  // ── Ownership helpers ─────────────────────────────────────────────────────

  function _getOwnerUserId(actor) {
    const hit = Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    });
    return hit?.[0] ?? null;
  }

  function _isOwner(actor) {
    const ownerUserId = _getOwnerUserId(actor);
    if (ownerUserId) return ownerUserId === game.user?.id;
    return game.user?.isGM ?? false;   // solo: GM gets the button
  }

  // ── Roulette state ────────────────────────────────────────────────────────

  let _rafId       = null;
  let _lastFrameMs = 0;
  const SPIN_MS    = 40;   // faster spin
  let _currentRoll = 1;
  let _stopping    = false;
  let _resultShown = false;   // idempotency — prevents double-apply

  function _clearRoulette() {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _lastFrameMs = 0;
    _stopping    = false;
    _currentRoll = 1;
    _lastTickMs  = 0;
    _resultShown = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  CAMP.ExplorationUI = {
    pendingResolvers: {},

    show(actorId, actorName) {
      document.getElementById(OVL_ID)?.remove();
      _clearRoulette();

      const actor   = game.actors?.get(actorId);
      const isOwner = _isOwner(actor);

      _buildOverlay(actorId, actorName, isOwner);
      _initWebAudio();          // async pre-load tick buffer
      _playSound(SFX.START, 0.7);
      _startRoulette(actorId, isOwner);
    },

    hide() {
      _clearRoulette();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 300);
    },

    resolveRoll(actorId, roll) {
      const resolver = this.pendingResolvers?.[actorId];
      if (!resolver) return;
      delete this.pendingResolvers[actorId];
      resolver(roll);
    },

    // Called on all clients when the owner's result arrives via socket
    applyResult(actorId, roll) {
      _applyResultUI(actorId, roll);
    },
  };

  // ── Build overlay DOM ─────────────────────────────────────────────────────

  function _buildOverlay(actorId, actorName, isOwner) {
    const overlay = document.createElement("div");
    overlay.id    = OVL_ID;

    const ownerName = (() => {
      const actor = game.actors?.get(actorId);
      const uid   = _getOwnerUserId(actor);
      return uid ? (game.users?.get(uid)?.name ?? actorName) : actorName;
    })();

    overlay.innerHTML = `
      <div class="oni-camp-expl-stage">
        <div class="oni-camp-expl-backdrop"><i class="fas fa-map-marked-alt"></i></div>
        <div class="oni-camp-expl-panel">
          <div class="oni-camp-expl-actor-label">${actorName} — Exploration</div>
          <div class="oni-camp-expl-dice-icon">🎲</div>
          <div class="oni-camp-expl-number" id="oni-expl-number">1</div>
          ${isOwner
            ? `<button class="oni-camp-expl-stop-btn" id="oni-expl-stop">STOP</button>`
            : `<div class="oni-camp-expl-waiting" id="oni-expl-waiting">Waiting for ${ownerName}…</div>`
          }
          <div class="oni-camp-expl-result" id="oni-expl-result" style="display:none;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
  }

  // ── Roulette spin (rAF — no forced reflows) ───────────────────────────────

  function _startRoulette(actorId, isOwner) {
    function _frame(timestamp) {
      if (_stopping) return;
      if (timestamp - _lastFrameMs >= SPIN_MS) {
        _lastFrameMs = timestamp;
        _currentRoll = (_currentRoll % 6) + 1;
        const el = document.getElementById("oni-expl-number");
        if (el) el.textContent = _currentRoll;
        _playTick();
      }
      _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);

    if (!isOwner) return;

    const stopBtn = document.getElementById("oni-expl-stop");
    if (!stopBtn) return;

    stopBtn.addEventListener("click", () => {
      if (_stopping) return;
      _stopping = true;
      stopBtn.disabled    = true;
      stopBtn.textContent = "…";
      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

      _playSound(SFX.STOP, 0.7);

      // Hard stop — lock immediately on current number
      const roll = _currentRoll;
      _applyResultUI(null, roll);

      if (game.user?.isGM) {
        CAMP.ExplorationUI.resolveRoll(actorId, roll);
      } else {
        CAMP.Socket.emit(CAMP.MSG.EXPLORATION_RESULT, { actorId, roll });
      }
    });
  }

  // ── Result display (idempotent — safe to call from owner and socket) ──────

  function _applyResultUI(actorId, roll) {
    if (_resultShown) return;   // already shown (e.g. socket echo to owner)
    _resultShown = true;

    // Ensure spin is stopped
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _stopping = true;

    const numEl    = document.getElementById("oni-expl-number");
    const resultEl = document.getElementById("oni-expl-result");
    const waitEl   = document.getElementById("oni-expl-waiting");
    const { heading, sub, color } = RESULT_LABELS[roll] ?? { heading: String(roll), sub: "", color: "#333" };

    if (numEl) {
      numEl.textContent      = roll;
      numEl.style.color      = color;
      numEl.style.textShadow = `0 0 24px ${color}`;
      numEl.classList.add("expl-locked");
    }
    if (waitEl) waitEl.style.display = "none";   // hide "Waiting for…" on spectator
    if (resultEl) {
      resultEl.innerHTML = `
        <div class="expl-result-heading" style="color:${color};">${heading}</div>
        <div class="expl-result-sub">${sub}</div>
      `;
      resultEl.style.display = "";
      resultEl.classList.add("expl-reveal");
    }

    if (roll === 6)      _playSound(SFX.JACKPOT, 0.8);
    else if (roll === 1) _playSound(SFX.OUCH,    0.75);
    else                 _playSound(SFX.RESULT,  0.65);
  }

  console.debug(TAG, "Exploration UI loaded.");
})();
