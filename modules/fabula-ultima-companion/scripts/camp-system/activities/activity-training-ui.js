// ============================================================================
// Camp Activity — Training UI
//
// Timing Gauge minigame overlay.
//
// Stages:
//   1 — Waiting   (owner sees "Click to Begin" button)
//   2 — Countdown (3 → 2 → 1 → GO!)
//   3 — Minigame  (15 s: pointer oscillates; owner presses SPACE to score)
//   4 — Reveal    (score % + charges + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts TRAINING_START  → all call show()      (GM direct too)
//   Owner clicks Begin → emits TRAINING_BEGIN → all call spectateBegin()
//   [15 s game runs on owner; spectators see live HIT syncs]
//   Owner emits TRAINING_RESULT { score } → GM
//   GM broadcasts TRAINING_RESULT { score, charges } → all call applyResult()
//   Owner clicks Proceed → emits TRAINING_PROCEED → GM
//   GM broadcasts TRAINING_DONE → all hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][TrainingUI]";
  const OVL_ID    = "oni-camp-tr-ovl";
  const STYLE_ID  = "oni-camp-tr-style";

  // ---------------------------------------------------------------------------
  // Sound URLs
  // ---------------------------------------------------------------------------
  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    RESULT:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
    HIT:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Damage1.ogg",
    PERFECT:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_HITKIRIB.wav",
    MISS:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Miss.ogg",
  };

  const DUMMY_IMG = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Training_Dummy.png";

  // ---------------------------------------------------------------------------
  // Gauge constants
  // ---------------------------------------------------------------------------
  const GAUGE_W         = 600;  // px — must match CSS
  const SWEET_HALF      = 30;   // ±30px sweet spot radius
  const PERFECT_HALF    = 4;    // ±4px perfect zone
  const BASE_SPEED      = 600;  // px/s
  const SPEED_PER_COMBO = 40;   // px/s added per combo
  const SPEED_CAP       = 1400; // px/s max
  const GAME_DURATION_MS = 15_000;
  const HIT_PTS         = 8;
  const PERFECT_PTS     = 15;
  // Theoretical max: every press perfect at base speed ≈ one press per 2s → 7–8 rounds
  // Realistically 10–12 at base; normalised against 15 rounds × 15pts = 225
  const MAX_PTS         = 225;

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId      = null;
  let _isOwnerFlag  = false;
  let _score        = 0;       // raw points
  let _combo        = 0;
  let _speed        = BASE_SPEED;
  let _pointerPx    = 0;
  let _direction    = 1;       // +1 right, -1 left
  let _sweetSpotPx  = Math.round(GAUGE_W / 2);
  let _gameActive   = false;
  let _lastFrameMs  = 0;
  let _rafId        = null;
  let _endTimer     = null;
  let _spaceHandler = null;
  let _resultShown  = false;

  // Cached DOM refs
  const _els = {
    pointer:    null,
    sweetZone:  null,
    dummy:      null,
    timerBar:   null,
    scoreVal:   null,
    comboVal:   null,
    floatLayer: null,
  };

  function _clearState() {
    if (_rafId !== null)    { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
    if (_spaceHandler) {
      document.removeEventListener("keydown", _spaceHandler, { capture: true });
      _spaceHandler = null;
    }
    _score       = 0;
    _combo       = 0;
    _speed       = BASE_SPEED;
    _pointerPx   = 0;
    _direction   = 1;
    _sweetSpotPx = Math.round(GAUGE_W / 2);
    _gameActive  = false;
    _resultShown = false;
    Object.keys(_els).forEach(k => _els[k] = null);
  }

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _checkIsOwner(actorId) {
    const actor = game.actors?.get(actorId);
    if (!actor) return game.user?.isGM ?? false;
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  function _playSound(src, volume = 0.7) {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch {
      try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // CSS injection
  // ---------------------------------------------------------------------------
  function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Overlay ─────────────────────────────────── */
      #${OVL_ID} {
        position:fixed; inset:0; z-index:10000;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.82);
        animation:oni-tr-fadein .35s ease forwards;
      }
      #${OVL_ID}.oni-tr-out { animation:oni-tr-fadeout .3s ease forwards; }

      @keyframes oni-tr-fadein  { from{opacity:0} to{opacity:1} }
      @keyframes oni-tr-fadeout { from{opacity:1} to{opacity:0} }
      @keyframes oni-tr-pop     { from{transform:scale(1.5)} to{transform:scale(1)} }
      @keyframes oni-tr-floatup {
        0%   { opacity:1; transform:translateY(0); }
        100% { opacity:0; transform:translateY(-55px); }
      }
      @keyframes oni-tr-pulse {
        0%,100% { box-shadow:0 0 6px 2px rgba(200,168,75,.5); }
        50%     { box-shadow:0 0 18px 6px rgba(200,168,75,.9); }
      }

      /* ── Card ────────────────────────────────────── */
      .oni-tr-card {
        background:linear-gradient(160deg,#1a1210,#2a1e18);
        border:2px solid #5c3a1e; border-radius:14px;
        padding:28px 34px 24px; width:680px; max-width:96vw;
        box-shadow:0 8px 40px rgba(0,0,0,.8);
        color:#d4b896; font-family:'Palatino Linotype',serif;
        position:relative; user-select:none;
      }

      /* ── Header ──────────────────────────────────── */
      .oni-tr-header {
        display:flex; justify-content:space-between; align-items:center;
        margin-bottom:14px;
      }
      .oni-tr-title { font-size:1.3em; font-weight:700; color:#c8a84b; letter-spacing:.04em; }
      .oni-tr-actor { font-size:.9em; opacity:.7; }
      .oni-tr-timer-label {
        font-size:1.1em; font-weight:700; color:#e8c87a;
        min-width:44px; text-align:right;
      }

      /* ── HUD row ─────────────────────────────────── */
      .oni-tr-hud {
        display:flex; gap:24px; margin-bottom:14px;
        font-size:.95em;
      }
      .oni-tr-hud-item { display:flex; gap:6px; align-items:center; }
      .oni-tr-hud-label { opacity:.6; }
      .oni-tr-hud-val { font-weight:700; color:#e8c87a; min-width:32px; }
      .oni-tr-combo-val { color:#e87a7a; }

      /* ── Gauge wrapper ───────────────────────────── */
      .oni-tr-gauge-wrap {
        position:relative; margin-bottom:0;
        height:110px;   /* dummy image (64px) + gap + track (18px) + clearance */
      }

      /* Training dummy sits above the sweet spot */
      .oni-tr-dummy {
        position:absolute; bottom:26px;
        width:64px; height:64px; object-fit:contain;
        transform:translateX(-50%);
        image-rendering:auto;
        pointer-events:none;
      }

      /* Track */
      .oni-tr-track {
        position:absolute; bottom:0; left:0;
        width:${GAUGE_W}px; height:18px;
        background:#2a1e18; border:1px solid #5c3a1e;
        border-radius:9px; overflow:hidden;
      }

      /* Sweet spot highlight */
      .oni-tr-sweet {
        position:absolute; top:0; bottom:0;
        width:${SWEET_HALF * 2}px;
        background:rgba(200,168,75,.22);
        border:1px solid rgba(200,168,75,.55);
        border-radius:8px;
        transform:translateX(-50%);
      }
      .oni-tr-sweet.oni-tr-perfect-flash {
        background:rgba(200,168,75,.7);
        animation:oni-tr-pulse .35s ease 2;
      }
      .oni-tr-sweet.oni-tr-hit-flash {
        background:rgba(58,122,53,.6);
      }
      .oni-tr-sweet.oni-tr-miss-flash {
        background:rgba(180,60,60,.4);
      }

      /* Pointer */
      .oni-tr-pointer {
        position:absolute; top:0; bottom:0;
        width:4px; background:#e8c87a;
        border-radius:2px;
        transform:translateX(-50%);
        box-shadow:0 0 6px 2px rgba(232,200,122,.6);
        will-change:left;
        transition:none; /* rAF moves it — no CSS transition */
      }

      /* Floating feedback text */
      .oni-tr-float-layer {
        position:absolute; top:0; left:0; width:${GAUGE_W}px; height:110px;
        pointer-events:none; overflow:hidden;
      }
      .oni-tr-float {
        position:absolute;
        font-size:1em; font-weight:700;
        animation:oni-tr-floatup .8s ease forwards;
        white-space:nowrap;
        pointer-events:none;
        transform:translateX(-50%);
      }
      .oni-tr-float.oni-tr-perfect { color:#c8a84b; font-size:1.15em; }
      .oni-tr-float.oni-tr-hit     { color:#5aaa52; }
      .oni-tr-float.oni-tr-miss    { color:#cc4444; }

      /* ── Timer bar ────────────────────────────────── */
      .oni-tr-timer-wrap {
        height:6px; background:#2a1e18; border-radius:3px;
        overflow:hidden; margin-top:14px;
      }
      .oni-tr-timer-bar {
        height:100%; background:linear-gradient(90deg,#c8a84b,#e8c87a);
        border-radius:3px; transition:none; will-change:width;
      }

      /* ── Key hint ─────────────────────────────────── */
      .oni-tr-hint {
        text-align:center; margin-top:12px; font-size:.82em; opacity:.55;
        letter-spacing:.04em;
      }
      .oni-tr-key {
        display:inline-block; padding:2px 10px;
        background:#2a1e18; border:1px solid #5c3a1e;
        border-radius:4px; font-family:monospace;
        font-size:1em; letter-spacing:.06em;
      }

      /* ── Click-to-Begin ──────────────────────────── */
      .oni-tr-begin-area {
        display:flex; flex-direction:column;
        align-items:center; gap:18px; padding:20px 0 8px;
      }
      .oni-tr-begin-label {
        font-size:1em; opacity:.7; font-style:italic;
      }
      .oni-tr-begin-btn {
        padding:10px 32px; background:#c8a84b; color:#1a1210;
        border:none; border-radius:8px; font-size:1.05em;
        font-weight:700; cursor:pointer; font-family:inherit;
        transition:background .15s;
      }
      .oni-tr-begin-btn:hover { background:#e8c87a; }

      /* ── Countdown ───────────────────────────────── */
      .oni-tr-countdown {
        display:flex; align-items:center; justify-content:center;
        height:160px;
      }
      .oni-tr-countdown-num {
        font-size:5em; font-weight:900; color:#c8a84b;
        animation:oni-tr-pop .35s ease forwards;
      }
      .oni-tr-go-text {
        font-size:4em; font-weight:900; color:#5aaa52;
        animation:oni-tr-pop .35s ease forwards;
      }

      /* ── Result ──────────────────────────────────── */
      .oni-tr-result {
        text-align:center; padding:12px 0 4px;
      }
      .oni-tr-result-score {
        font-size:1.1em; margin-bottom:6px;
      }
      .oni-tr-result-charges {
        font-size:1.6em; font-weight:900; margin:8px 0 4px;
      }
      .oni-tr-result-label {
        font-size:.88em; opacity:.65; font-style:italic; margin-bottom:12px;
      }
      .oni-tr-proceed-btn {
        padding:9px 28px; background:#5c3a1e; color:#e8c87a;
        border:1px solid #c8a84b; border-radius:8px;
        font-size:.95em; font-weight:700; cursor:pointer; font-family:inherit;
        transition:background .15s;
      }
      .oni-tr-proceed-btn:hover { background:#7a4e28; }

      /* ── Spectator waiting ───────────────────────── */
      .oni-tr-spectate-wait {
        text-align:center; padding:30px 0; font-size:.95em; opacity:.6; font-style:italic;
      }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Overlay builder
  // ---------------------------------------------------------------------------
  function _buildOverlay(actorName, isOwner) {
    const existing = document.getElementById(OVL_ID);
    if (existing) existing.remove();

    _injectStyles();

    const ovl = document.createElement("div");
    ovl.id = OVL_ID;

    ovl.innerHTML = `
      <div class="oni-tr-card">
        <div class="oni-tr-header">
          <div>
            <div class="oni-tr-title">Training</div>
            <div class="oni-tr-actor">${actorName}</div>
          </div>
          <div class="oni-tr-timer-label" id="oni-tr-timer-label">15s</div>
        </div>

        <div class="oni-tr-hud">
          <div class="oni-tr-hud-item">
            <span class="oni-tr-hud-label">Score</span>
            <span class="oni-tr-hud-val" id="oni-tr-score-val">0</span>
          </div>
          <div class="oni-tr-hud-item">
            <span class="oni-tr-hud-label">Combo</span>
            <span class="oni-tr-hud-val oni-tr-combo-val" id="oni-tr-combo-val">×0</span>
          </div>
        </div>

        <div id="oni-tr-stage">
          ${isOwner ? _buildBeginArea() : _buildSpectateWait()}
        </div>

        <button class="oni-tr-proceed-btn" id="oni-tr-proceed" style="display:none;margin-top:14px;">
          Click to Proceed
        </button>
      </div>
    `;

    document.body.appendChild(ovl);
    return ovl;
  }

  function _buildBeginArea() {
    return `
      <div class="oni-tr-begin-area" id="oni-tr-begin-area">
        <div class="oni-tr-begin-label">Press SPACE to stop the pointer inside the sweet spot!</div>
        <button class="oni-tr-begin-btn" id="oni-tr-begin-btn">Click to Begin</button>
      </div>
    `;
  }

  function _buildSpectateWait() {
    return `<div class="oni-tr-spectate-wait">Watching ${_actorName ?? "player"} train…</div>`;
  }

  function _buildGameArea(interactive) {
    const sweetLeft = _sweetSpotPx;
    return `
      <div class="oni-tr-gauge-wrap" id="oni-tr-gauge-wrap"
           style="${interactive ? "" : "pointer-events:none;"}">
        <img class="oni-tr-dummy" id="oni-tr-dummy"
             src="${DUMMY_IMG}" style="left:${sweetLeft}px;" alt="">
        <div class="oni-tr-track" id="oni-tr-track">
          <div class="oni-tr-sweet" id="oni-tr-sweet"
               style="left:${sweetLeft}px; width:${SWEET_HALF * 2}px;"></div>
          <div class="oni-tr-pointer" id="oni-tr-pointer"
               style="left:${_pointerPx}px;"></div>
        </div>
        <div class="oni-tr-float-layer" id="oni-tr-float-layer"></div>
      </div>
      ${interactive ? `
      <div class="oni-tr-timer-wrap" style="margin-top:14px;">
        <div class="oni-tr-timer-bar" id="oni-tr-timer-bar" style="width:100%;"></div>
      </div>
      <div class="oni-tr-hint">
        <span class="oni-tr-key">SPACE</span> — stop the pointer
      </div>
      ` : `<div class="oni-tr-hint">Spectating…</div>`}
    `;
  }

  let _actorName = null;

  function _cacheEls() {
    _els.pointer    = document.getElementById("oni-tr-pointer");
    _els.sweetZone  = document.getElementById("oni-tr-sweet");
    _els.dummy      = document.getElementById("oni-tr-dummy");
    _els.timerBar   = document.getElementById("oni-tr-timer-bar");
    _els.scoreVal   = document.getElementById("oni-tr-score-val");
    _els.comboVal   = document.getElementById("oni-tr-combo-val");
    _els.floatLayer = document.getElementById("oni-tr-float-layer");
  }

  // ---------------------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------------------
  function _runCountdown(count, onDone) {
    const stage = document.getElementById("oni-tr-stage");
    if (!stage) return;

    stage.innerHTML = `<div class="oni-tr-countdown"><span id="oni-tr-count" class="oni-tr-countdown-num">${count}</span></div>`;
    _playSound(SFX.COUNTDOWN, 0.8);

    if (count > 1) {
      setTimeout(() => _runCountdown(count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el = document.getElementById("oni-tr-count");
        if (el) { el.className = "oni-tr-go-text"; el.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // rAF game loop
  // ---------------------------------------------------------------------------
  function _startGameLoop() {
    _gameActive  = true;
    _lastFrameMs = performance.now();
    const startMs = performance.now();

    function _frame(ts) {
      if (!_gameActive) return;
      if (!document.getElementById(OVL_ID)) { _gameActive = false; return; }

      const dt = Math.min(ts - _lastFrameMs, 50) / 1000; // seconds, capped
      _lastFrameMs = ts;

      _pointerPx += _direction * _speed * dt;
      if (_pointerPx >= GAUGE_W) { _pointerPx = GAUGE_W; _direction = -1; }
      if (_pointerPx <= 0)       { _pointerPx = 0;       _direction =  1; }

      if (_els.pointer) _els.pointer.style.left = `${_pointerPx.toFixed(1)}px`;

      // Update timer bar (owner only — spectators don't have it)
      if (_els.timerBar) {
        const elapsed = ts - startMs;
        const pct = Math.max(0, 1 - elapsed / GAME_DURATION_MS);
        _els.timerBar.style.width = `${(pct * 100).toFixed(2)}%`;

        // Update timer label (only when second changes)
        const label = document.getElementById("oni-tr-timer-label");
        if (label) {
          const sec = Math.ceil(pct * GAME_DURATION_MS / 1000);
          label.textContent = `${sec}s`;
        }
      }

      _rafId = requestAnimationFrame(_frame);
    }

    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // SPACE handler (owner only)
  // ---------------------------------------------------------------------------
  function _setupSpacebar(actorId) {
    _spaceHandler = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!_gameActive) return;

      const diff = Math.abs(_pointerPx - _sweetSpotPx);

      if (diff <= PERFECT_HALF) {
        // Perfect hit
        _score += PERFECT_PTS;
        _combo++;
        _speed = Math.min(BASE_SPEED + _combo * SPEED_PER_COMBO, SPEED_CAP);
        _showFloat("Perfect!", "oni-tr-perfect", _pointerPx);
        _flashZone("oni-tr-perfect-flash");
        _spawnParticles(_pointerPx, true);
        _playSound(SFX.PERFECT, 0.45);
        _advanceRound(actorId, "perfect");
      } else if (diff <= SWEET_HALF) {
        // Normal hit
        _score += HIT_PTS;
        _combo++;
        _speed = Math.min(BASE_SPEED + _combo * SPEED_PER_COMBO, SPEED_CAP);
        _showFloat("Hit!", "oni-tr-hit", _pointerPx);
        _flashZone("oni-tr-hit-flash");
        _spawnParticles(_pointerPx, false);
        _playSound(SFX.HIT, 0.7);
        _advanceRound(actorId, "hit");
      } else {
        // Miss
        _combo = 0;
        _speed = BASE_SPEED;
        _pointerPx = 0;
        _direction = 1;
        _showFloat("Miss", "oni-tr-miss", _sweetSpotPx);
        _flashZone("oni-tr-miss-flash");
        _playSound(SFX.MISS, 0.7);
        _broadcastHit(actorId, { miss: true, pointerPx: 0, sweetSpotPx: _sweetSpotPx, combo: 0, score: _score });
      }

      _updateHUD();
    };

    document.addEventListener("keydown", _spaceHandler, { capture: true });
  }

  function _advanceRound(actorId, kind) {
    const oldPx = _sweetSpotPx;
    // New sweet spot: different quadrant than current to prevent trivial repeat
    const margin = SWEET_HALF + 10;
    let newPx;
    do {
      newPx = margin + Math.floor(Math.random() * (GAUGE_W - margin * 2));
    } while (Math.abs(newPx - oldPx) < SWEET_HALF * 2);
    _sweetSpotPx = newPx;

    if (_els.sweetZone) _els.sweetZone.style.left = `${_sweetSpotPx}px`;
    if (_els.dummy)     _els.dummy.style.left     = `${_sweetSpotPx}px`;

    _broadcastHit(actorId, {
      [kind]: true,
      pointerPx:   _pointerPx,
      sweetSpotPx: _sweetSpotPx,
      combo:       _combo,
      score:       _score,
    });
  }

  function _broadcastHit(actorId, data) {
    CAMP.Socket.emit(CAMP.MSG.TRAINING_HIT, { actorId, ...data });
  }

  function _setComboDisplay(el, combo) {
    if (!el) return;
    el.textContent = `×${combo}`;
    // Font grows with combo: 1em at ×0, up to ~3.2em at ×20+
    const fs = Math.min(1.0 + combo * 0.115, 3.2);
    el.style.fontSize = `${fs.toFixed(3)}em`;
    // Brief scale-pop via Web Animations API (compositor thread — no reflow)
    if (combo > 0) {
      el.animate(
        [{ transform: "scale(1.55)" }, { transform: "scale(1)" }],
        { duration: 160, easing: "ease-out" }
      );
    }
  }

  function _updateHUD() {
    const rawPct = Math.round(Math.min(_score / MAX_PTS, 1) * 100);
    if (_els.scoreVal) _els.scoreVal.textContent = `${rawPct}%`;
    _setComboDisplay(_els.comboVal, _combo);
  }

  // ---------------------------------------------------------------------------
  // Float text & zone flash
  // ---------------------------------------------------------------------------
  function _showFloat(text, cls, xPx) {
    if (!_els.floatLayer) return;
    const el = document.createElement("div");
    el.className = `oni-tr-float ${cls}`;
    el.textContent = text;
    el.style.left   = `${xPx}px`;
    el.style.bottom = "20px";
    _els.floatLayer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  function _flashZone(cls) {
    if (!_els.sweetZone) return;
    _els.sweetZone.classList.add(cls);
    setTimeout(() => _els.sweetZone?.classList.remove(cls), 400);
  }

  // ---------------------------------------------------------------------------
  // Particle burst
  // ---------------------------------------------------------------------------
  function _spawnParticles(xPx, isPerfect) {
    if (!_els.floatLayer) return;

    const count    = isPerfect ? 18 : 9;
    const originY  = 88;   // px from top of float-layer — sits on the gauge track

    for (let i = 0; i < count; i++) {
      const angle  = (Math.PI * 2 * i / count) + (Math.random() * 0.5 - 0.25);
      const dist   = isPerfect ? 40 + Math.random() * 50 : 18 + Math.random() * 28;
      const dx     = Math.cos(angle) * dist;
      const dy     = Math.sin(angle) * dist;
      const dur    = 480 + Math.random() * 280;

      // Alternate between circle dots and thin spike shapes for visual variety
      const isSpike = isPerfect && i % 3 === 0;
      const size    = isPerfect
        ? (isSpike ? 3 : 5 + Math.random() * 5)
        : (3 + Math.random() * 3);

      const gold   = Math.random() < 0.5;
      const color  = isPerfect
        ? (gold ? "#e8d870" : "#c8a84b")
        : (Math.random() < 0.55 ? "#6fd468" : "#a8e890");

      const p = document.createElement("div");
      p.style.cssText = [
        "position:absolute",
        `left:${xPx}px`,
        `top:${originY}px`,
        `width:${isSpike ? 2 : size.toFixed(1)}px`,
        `height:${size.toFixed(1)}px`,
        `border-radius:${isSpike ? "1px" : "50%"}`,
        `background:${color}`,
        "pointer-events:none",
        "transform:translate(-50%,-50%)",
        isPerfect ? `box-shadow:0 0 ${(size * 1.4).toFixed(1)}px ${color}` : "",
      ].join(";");

      _els.floatLayer.appendChild(p);

      const rotation = isSpike ? `rotate(${(angle * 180 / Math.PI + 90).toFixed(1)}deg)` : "";

      p.animate(
        [
          { transform: `translate(-50%,-50%) ${rotation} scale(1)`, opacity: 1 },
          { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) ${rotation} scale(0)`, opacity: 0 },
        ],
        { duration: dur, easing: "cubic-bezier(.15,.8,.35,1)", fill: "forwards" }
      ).finished.then(() => p.remove());
    }

    // For perfect: add a second ring of slower-drifting sparkles
    if (isPerfect) {
      for (let i = 0; i < 8; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = 55 + Math.random() * 40;
        const dx    = Math.cos(angle) * dist;
        const dy    = Math.sin(angle) * dist;
        const size  = 2 + Math.random() * 3;

        const p = document.createElement("div");
        p.style.cssText = [
          "position:absolute",
          `left:${xPx}px`,
          `top:${originY}px`,
          `width:${size.toFixed(1)}px`,
          `height:${size.toFixed(1)}px`,
          "border-radius:50%",
          "background:#fffac0",
          "pointer-events:none",
          "transform:translate(-50%,-50%)",
          `box-shadow:0 0 ${(size + 2).toFixed(1)}px #e8d870`,
        ].join(";");

        _els.floatLayer.appendChild(p);

        p.animate(
          [
            { transform: `translate(-50%,-50%) scale(1.4)`, opacity: 0.9 },
            { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0)`, opacity: 0 },
          ],
          { duration: 700 + Math.random() * 300, easing: "ease-out", fill: "forwards" }
        ).finished.then(() => p.remove());
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Game end (owner)
  // ---------------------------------------------------------------------------
  function _endGame(actorId) {
    _gameActive = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_spaceHandler) {
      document.removeEventListener("keydown", _spaceHandler, { capture: true });
      _spaceHandler = null;
    }

    const scorePercent = Math.round(Math.min(_score / MAX_PTS, 1) * 100);
    console.debug(TAG, `Game over. Raw pts: ${_score}, Score: ${scorePercent}%`);

    // Submit score to GM
    CAMP.Socket.emit(CAMP.MSG.TRAINING_RESULT, { actorId, score: scorePercent });
  }

  // ---------------------------------------------------------------------------
  // Apply result (called on all clients when GM broadcasts)
  // ---------------------------------------------------------------------------
  function _applyResultUI(actorId, scorePercent, charges) {
    if (_resultShown) return;
    _resultShown = true;

    _gameActive = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

    _playSound(SFX.RESULT, 0.8);

    const stage = document.getElementById("oni-tr-stage");
    if (!stage) return;

    const chargeColor = charges >= 3 ? "#c8a84b" : charges >= 2 ? "#5aaa52" : "#c87a3a";
    const chargesLabel =
      charges >= 3 ? "3 Charges — Perfect!" :
      charges >= 2 ? "2 Charges — Well done!" :
                     "1 Charge — Keep training!";
    const flavorText =
      charges >= 3 ? "Your body moved with perfect precision." :
      charges >= 2 ? "Solid form. Your training will show." :
                     "You went through the motions. It counts.";

    stage.innerHTML = `
      <div class="oni-tr-result">
        <div class="oni-tr-result-score">Score: <strong>${scorePercent}%</strong></div>
        <div class="oni-tr-result-charges" style="color:${chargeColor};">${chargesLabel}</div>
        <div class="oni-tr-result-label">${flavorText}</div>
      </div>
    `;

    // Show proceed button for owner only
    if (_isOwnerFlag) {
      const btn = document.getElementById("oni-tr-proceed");
      if (btn) {
        btn.style.display = "block";
        btn.onclick = () => {
          if (game.user?.isGM) {
            CAMP.TrainingUI?.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.TRAINING_PROCEED, { actorId });
          }
          btn.disabled = true;
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // Extend the existing TrainingUI object rather than replacing it so that
  // resolveChoice (set by activity-training.js at evaluation time) is preserved.
  // ---------------------------------------------------------------------------
  CAMP.TrainingUI ??= {};
  CAMP.TrainingUI.scoreResolvers   ??= {};
  CAMP.TrainingUI.proceedResolvers ??= {};

  Object.assign(CAMP.TrainingUI, {

    show(actorId, actorName) {
      _clearState();
      _actorId     = actorId;
      _actorName   = actorName;
      _isOwnerFlag = _checkIsOwner(actorId);

      const ovl = _buildOverlay(actorName, _isOwnerFlag);

      if (_isOwnerFlag) {
        const beginBtn = document.getElementById("oni-tr-begin-btn");
        if (beginBtn) {
          beginBtn.onclick = () => {
            beginBtn.disabled = true;
            CAMP.Socket.emit(CAMP.MSG.TRAINING_BEGIN, { actorId });
            _startOwnerCountdown(actorId);
          };
        }
      }
    },

    spectateBegin(actorId) {
      if (_isOwnerFlag) return; // owner already started locally
      const stage = document.getElementById("oni-tr-stage");
      if (!stage) return;
      _runCountdown(3, () => {
        stage.innerHTML = _buildGameArea(false);
        _cacheEls();
        // Spectator sees pointer position updates via onHit
      });
    },

    onHit(payload) {
      if (_isOwnerFlag) return; // owner already applied locally
      if (!document.getElementById(OVL_ID)) return;

      const { miss, perfect, hit, pointerPx, sweetSpotPx, combo, score } = payload ?? {};

      // Update sweet spot & dummy position
      if (sweetSpotPx != null) {
        _sweetSpotPx = sweetSpotPx;
        if (_els.sweetZone) _els.sweetZone.style.left = `${sweetSpotPx}px`;
        if (_els.dummy)     _els.dummy.style.left     = `${sweetSpotPx}px`;
      }

      // Snap pointer
      if (pointerPx != null) {
        _pointerPx = pointerPx;
        if (_els.pointer) _els.pointer.style.left = `${pointerPx}px`;
      }

      // HUD
      if (score != null && _els.scoreVal) _els.scoreVal.textContent = `${Math.round(Math.min(score / MAX_PTS, 1) * 100)}%`;
      if (combo != null) _setComboDisplay(_els.comboVal, combo);

      // Feedback + particles
      const hitX = pointerPx ?? _pointerPx;
      if (perfect) {
        _showFloat("Perfect!", "oni-tr-perfect", hitX);
        _flashZone("oni-tr-perfect-flash");
        _spawnParticles(hitX, true);
      } else if (hit) {
        _showFloat("Hit!", "oni-tr-hit", hitX);
        _flashZone("oni-tr-hit-flash");
        _spawnParticles(hitX, false);
      } else if (miss) {
        _showFloat("Miss", "oni-tr-miss", sweetSpotPx ?? _sweetSpotPx);
        _flashZone("oni-tr-miss-flash");
      }
    },

    applyResult(actorId, scorePercent, charges) {
      _applyResultUI(actorId, scorePercent, charges);
    },

    resolveScore(actorId, score) {
      const resolver = this.scoreResolvers?.[actorId];
      if (!resolver) return;
      delete this.scoreResolvers[actorId];
      resolver(score);
    },

    resolveProceed(actorId) {
      const resolver = this.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete this.proceedResolvers[actorId];
      resolver();
    },

    onChoiceRequest(payload) {
      const { requestId, actorId, actorName, effectName, statusList, charges, targetUserId } = payload ?? {};
      // Only the intended owner responds
      if (game.user?.id !== targetUserId) return;

      new Dialog({
        title: "Training — Status Prevention",
        content: `
          <div style="padding:6px 0;">
            <p><strong>${actorName}</strong> is about to suffer
               <strong>${effectName}</strong> (${statusList}).</p>
            <p>Use a Training charge to prevent all status effects from this source?</p>
            <p style="font-size:.85em;opacity:.7;">Charges remaining: ${charges}</p>
          </div>
        `,
        buttons: {
          yes: {
            icon:  '<i class="fas fa-shield-alt"></i>',
            label: "Prevent",
            callback: () => CAMP.Socket.emit(CAMP.MSG.TRAINING_CHOICE_RESPONSE, { requestId, prevent: true }),
          },
          no: {
            icon:  '<i class="fas fa-times"></i>',
            label: "Allow",
            callback: () => CAMP.Socket.emit(CAMP.MSG.TRAINING_CHOICE_RESPONSE, { requestId, prevent: false }),
          },
        },
        default: "yes",
        close: () => CAMP.Socket.emit(CAMP.MSG.TRAINING_CHOICE_RESPONSE, { requestId, prevent: false }),
      }, { width: 380 }).render(true);
    },

    hide() {
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      ovl.classList.add("oni-tr-out");
      setTimeout(() => { ovl.remove(); _clearState(); }, 350);
    },
  });

  // ---------------------------------------------------------------------------
  // Owner countdown → game start
  // ---------------------------------------------------------------------------
  function _startOwnerCountdown(actorId) {
    _runCountdown(3, () => {
      const stage = document.getElementById("oni-tr-stage");
      if (!stage) return;

      _sweetSpotPx = Math.round(GAUGE_W * 0.3 + Math.random() * GAUGE_W * 0.4);
      stage.innerHTML = _buildGameArea(true);
      _cacheEls();
      _startGameLoop();
      _setupSpacebar(actorId);

      _endTimer = setTimeout(() => _endGame(actorId), GAME_DURATION_MS);
    });
  }

  console.debug("[CampSystem][TrainingUI]", "Training UI loaded.");
})();
