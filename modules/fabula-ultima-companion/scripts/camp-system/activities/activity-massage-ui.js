// ============================================================================
// Camp Activity — Massage UI
//
// Hot-and-Cold 3×3 grid minigame overlay.
//
// Stages:
//   1 — Ally picker    (owner selects target; spectators wait)
//   2 — Arena          (Click to Begin → countdown → 15 s game)
//   3 — Reveal         (score + MP reduction % + rank + "Click to Proceed")
//
// Sync flow:
//   GM broadcasts MASSAGE_START  { actorId, allies } → all call show()
//   Owner picks ally → emits MASSAGE_TARGET → GM
//   GM broadcasts MASSAGE_MINIGAME { actorId, targetActorId } → all call showArena()
//   Owner clicks Begin → broadcasts MASSAGE_BEGIN → spectators enter countdown
//   Owner clicks each cell → emits MASSAGE_HIT → all call onHit()
//   15 s expires → owner submits score: isGM calls resolveScore(), else emits MASSAGE_RESULT
//   GM broadcasts MASSAGE_RESULT { score, reduction } → all call applyResult()
//   Owner clicks Proceed → emits MASSAGE_PROCEED → GM calls resolveProceed()
//   GM broadcasts MASSAGE_DONE → all call hide()
//
// Proximity rules (3×3 grid, indices 0-8, col = idx%3, row = idx÷3):
//   manhattan == 0                       → Perfect (Red,    +5 pts, new spot)
//   manhattan == 1                       → Close   (Yellow, +2 pts)
//   chebyshev == 1 && manhattan == 2     → Near    (Green,  +1 pt)
//   chebyshev >= 2                       → Miss    (Blue,   0 pts)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MassageUI]";
  const OVL_ID    = "oni-camp-ms-ovl";
  const STYLE_ID  = "oni-camp-ms-style";

  const MASSAGE_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/MysticAlchemistSkill5.png";

  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    RESULT:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
    PERFECT:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    CLOSE:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav",
    NEAR:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_CATCHA.wav",
    MISS:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_CATCHB.wav",
  };

  const PROXIMITY_CFG = {
    perfect: { color: "#c0392b", bg: "rgba(192,57,43,0.82)",  pts: 5, emoji: "💖", label: "Perfect!" },
    close:   { color: "#e67e22", bg: "rgba(230,126,34,0.82)", pts: 2, emoji: "💚", label: "Close!"   },
    near:    { color: "#27ae60", bg: "rgba(39,174,96,0.82)",  pts: 1, emoji: "😐", label: "Near…"    },
    miss:    { color: "#2980b9", bg: "rgba(41,128,185,0.82)", pts: 0, emoji: "💢", label: "Miss!"    },
  };

  const MAX_SCORE       = 50;
  const GAME_DURATION_MS = 15_000;

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId      = null;
  let _targetId     = null;
  let _isOwner      = false;
  let _score        = 0;
  let _hiddenCell   = -1;   // 0–8; owner-only
  let _gameStartMs  = null;
  let _rafId        = null;
  let _endTimer     = null;
  let _resultShown  = false;
  let _gameActive   = false;

  // Web Audio — pre-decoded buffers for high-frequency click sounds
  let _audioCtx     = null;
  const _sfxBuffers = {};   // keyed by SFX key (PERFECT / CLOSE / NEAR / MISS)

  function _clearState() {
    if (_rafId !== null)    { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
    _actorId     = null;
    _targetId    = null;
    _isOwner     = false;
    _score       = 0;
    _hiddenCell  = -1;
    _gameStartMs = null;
    _resultShown = false;
    _gameActive  = false;
  }

  // ---------------------------------------------------------------------------
  // Web Audio helpers
  // ---------------------------------------------------------------------------
  async function _initWebAudio() {
    if (_audioCtx) return;
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      await Promise.all(
        ["PERFECT", "CLOSE", "NEAR", "MISS"].map(async key => {
          try {
            const res = await fetch(SFX[key]);
            const buf = await res.arrayBuffer();
            _sfxBuffers[key] = await _audioCtx.decodeAudioData(buf);
          } catch (e) {
            console.warn(TAG, `Failed to load SFX ${key}:`, e);
          }
        })
      );
    } catch (e) {
      console.warn(TAG, "Web Audio init failed:", e);
    }
  }

  const _SFX_GAIN = { PERFECT: 0.75, CLOSE: 0.75, NEAR: 0.42, MISS: 0.38 };

  function _playWebAudio(key) {
    const vol = _SFX_GAIN[key] ?? 0.75;
    if (!_audioCtx || !_sfxBuffers[key]) {
      try { AudioHelper.play({ src: SFX[key], volume: vol, autoplay: true, loop: false }, false); } catch {}
      return;
    }
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const src  = _audioCtx.createBufferSource();
    const gain = _audioCtx.createGain();
    gain.gain.value = vol;
    src.buffer = _sfxBuffers[key];
    src.connect(gain);
    gain.connect(_audioCtx.destination);
    src.start(0);
  }

  function _playSound(src, volume = 0.7) {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch {
      try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Proximity computation
  // ---------------------------------------------------------------------------
  function _proximity(clickedCell, hiddenCell) {
    const cx = clickedCell % 3,  cy = Math.floor(clickedCell / 3);
    const hx = hiddenCell  % 3,  hy = Math.floor(hiddenCell  / 3);
    const dx = Math.abs(cx - hx), dy = Math.abs(cy - hy);
    const manhattan  = dx + dy;
    const chebyshev  = Math.max(dx, dy);
    if (manhattan === 0)                    return "perfect";
    if (manhattan === 1)                    return "close";
    if (chebyshev === 1 && manhattan === 2) return "near";
    return "miss";
  }

  function _randomCell(exclude = -1) {
    let c;
    do { c = Math.floor(Math.random() * 9); } while (c === exclude);
    return c;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    const hit = Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    });
    return hit?.[0] ?? null;
  }

  function _isActorOwner(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  function _getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  function _rankLabel(score) {
    if (score >= 41) return "Master";
    if (score >= 26) return "Skilled";
    if (score >= 11) return "Decent";
    return "Clumsy";
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Overlay ────────────────────────────────────────────────── */
      #${OVL_ID} {
        position:fixed;inset:0;z-index:10000;
        display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.82);
        animation:oni-ms-fadein 0.35s ease forwards;
        font-family:"Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-ms-out { animation:oni-ms-fadeout 0.3s ease forwards; }
      @keyframes oni-ms-fadein  { from{opacity:0}to{opacity:1} }
      @keyframes oni-ms-fadeout { from{opacity:1}to{opacity:0} }
      @keyframes oni-ms-slideup { from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)} }
      @keyframes oni-ms-pop     { from{transform:scale(1.5)}to{transform:scale(1)} }
      @keyframes oni-ms-bump    { 0%{transform:scale(1)}40%{transform:scale(1.18)}100%{transform:scale(1)} }
      @keyframes oni-ms-flash   { 0%{opacity:1}100%{opacity:0} }
      @keyframes oni-ms-float   { 0%{opacity:1;transform:translate(-50%,0)}70%{opacity:1;transform:translate(-50%,-24px)}100%{opacity:0;transform:translate(-50%,-36px)} }
      @keyframes oni-ms-shake   { 0%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}100%{transform:translateX(0)} }
      @keyframes oni-ms-pulse   { 0%,100%{box-shadow:0 0 0 3px rgba(244,212,136,.35)}50%{box-shadow:0 0 0 7px rgba(244,212,136,.0)} }

      /* ── Panel (shared wrapper) ─────────────────────────────────── */
      .oni-ms-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;
        padding:24px 32px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:14px;
        min-width:340px;
        animation:oni-ms-slideup 0.3s ease forwards;
      }
      .oni-ms-title {
        font-size:1.3rem;font-weight:800;color:#6b3a1f;
        letter-spacing:.05em;text-transform:uppercase;
      }

      /* ── Countdown ──────────────────────────────────────────────── */
      .oni-ms-countdown-num {
        font-size:5rem;font-weight:900;color:#c8a84b;line-height:1;
        text-shadow:0 0 30px rgba(200,168,75,.7);
        animation:oni-ms-pop 0.25s ease;
      }
      .oni-ms-go-text {
        font-size:3.5rem;font-weight:900;color:#3a8a35;
        text-shadow:0 0 28px rgba(58,138,53,.8);
        animation:oni-ms-pop 0.3s ease;
      }

      /* ── Waiting text ───────────────────────────────────────────── */
      .oni-ms-waiting {
        font-size:.95rem;color:#c8a84b;font-style:italic;margin-top:4px;
      }

      /* ── Ally picker cards ──────────────────────────────────────── */
      .oni-ms-ally-list {
        display:flex;flex-direction:column;gap:8px;width:260px;
      }
      .oni-ms-ally-card {
        display:flex;align-items:center;gap:10px;
        padding:8px 14px;cursor:pointer;
        background:rgba(255,255,255,.25);
        border:2px solid rgba(141,95,56,.5);border-radius:9px;
        transition:background .15s,border-color .15s,transform .1s;
      }
      .oni-ms-ally-card:hover {
        background:rgba(200,168,75,.25);
        border-color:#c8a84b;transform:translateY(-2px);
      }
      .oni-ms-ally-card img {
        width:40px;height:40px;border-radius:4px;border:none;object-fit:contain;
        background:transparent;
      }
      .oni-ms-ally-card-name { font-weight:700;font-size:.95rem;color:#3a2010; }

      /* ── Begin button ───────────────────────────────────────────── */
      .oni-ms-begin-btn {
        margin-top:4px;padding:10px 34px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:1rem;cursor:pointer;letter-spacing:.04em;
        box-shadow:0 4px 14px rgba(0,0,0,.4);transition:filter .15s,transform .1s;
      }
      .oni-ms-begin-btn:hover { filter:brightness(1.15);transform:translateY(-1px); }
      .oni-ms-begin-btn:active{ transform:translateY(1px);filter:brightness(.95); }

      /* ── Arena layout ───────────────────────────────────────────── */
      .oni-ms-arena {
        display:flex;flex-direction:column;align-items:center;gap:10px;
        width:480px;
      }
      .oni-ms-hud {
        display:flex;justify-content:space-between;align-items:center;
        width:100%;color:#e8dfc0;font-size:.88rem;font-weight:700;
        text-shadow:0 1px 4px rgba(0,0,0,.8);
      }
      .oni-ms-score-lbl { color:#f4d488;font-size:1rem; }
      .oni-ms-timer-wrap {
        width:100%;height:8px;background:rgba(255,255,255,.15);
        border-radius:4px;overflow:hidden;
      }
      .oni-ms-timer-bar {
        height:100%;width:100%;
        background:linear-gradient(90deg,#c8a84b,#e8b44b);
        border-radius:4px;transition:width 0.05s linear;
      }

      /* ── Play area: faded token + grid overlay ──────────────────── */
      .oni-ms-play-area {
        position:relative;width:300px;height:300px;
        display:flex;align-items:center;justify-content:center;
      }
      .oni-ms-bg-token {
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      }
      .oni-ms-bg-token img {
        width:260px;height:260px;object-fit:contain;
        opacity:.22;filter:blur(1.5px);
        pointer-events:none;user-select:none;
      }
      .oni-ms-grid {
        position:relative;z-index:2;
        display:grid;grid-template-columns:repeat(3,88px);grid-template-rows:repeat(3,88px);
        gap:6px;
      }
      .oni-ms-cell {
        width:88px;height:88px;border-radius:10px;cursor:pointer;
        background:rgba(255,255,255,.08);
        border:2px solid rgba(255,255,255,.2);
        transition:background .12s,border-color .12s,box-shadow .12s,transform .08s;
        display:flex;align-items:center;justify-content:center;
        font-size:2.8rem;position:relative;
      }
      .oni-ms-cell:hover {
        background:rgba(255,255,255,.18);
        border-color:rgba(255,255,255,.5);
        transform:scale(1.04);
      }
      .oni-ms-cell.disabled {
        pointer-events:none;
      }
      /* Proximity: emoji fills the cell; subtle glow border replaces solid bg */
      .oni-ms-cell[data-proximity="perfect"] { border-color:#e74c3c; box-shadow:0 0 14px rgba(192,57,43,.7); background:rgba(192,57,43,.18); }
      .oni-ms-cell[data-proximity="close"]   { border-color:#e67e22; box-shadow:0 0 14px rgba(230,126,34,.7); background:rgba(230,126,34,.18); }
      .oni-ms-cell[data-proximity="near"]    { border-color:#27ae60; box-shadow:0 0 14px rgba(39,174,96,.7);  background:rgba(39,174,96,.18);  }
      .oni-ms-cell[data-proximity="miss"]    { border-color:#2980b9; box-shadow:0 0 14px rgba(41,128,185,.7); background:rgba(41,128,185,.18); }

      /* ── Score pop-up — floats above play area, not clipped by cell ── */
      .oni-ms-cell-pop {
        position:absolute;font-size:1.25rem;font-weight:900;
        color:#fff;text-shadow:0 0 8px rgba(0,0,0,.95),0 0 20px rgba(244,212,136,.8);
        pointer-events:none;white-space:nowrap;
        transform:translateX(-50%);
        animation:oni-ms-float 0.6s ease-out forwards;
        z-index:10;
      }

      /* ── Bottom sprite row ──────────────────────────────────────── */
      .oni-ms-sprites {
        display:flex;align-items:flex-end;justify-content:center;
        gap:24px;width:100%;margin-top:18px;
      }
      .oni-ms-sprite {
        display:flex;flex-direction:column;align-items:center;gap:4px;
        position:relative;
      }
      .oni-ms-sprite img {
        width:72px;height:72px;object-fit:contain;border:none;background:transparent;
        filter:drop-shadow(0 0 8px rgba(0,0,0,.5));
      }
      .oni-ms-sprite-name {
        font-size:.72rem;font-weight:700;color:#e8dfc0;
        text-shadow:0 1px 4px rgba(0,0,0,.8);
      }

      /* ── Speech bubble (over target sprite) ─────────────────────── */
      .oni-ms-bubble-wrap {
        position:absolute;top:-54px;left:50%;transform:translateX(-50%);
        pointer-events:none;
      }
      .oni-ms-bubble {
        background:#fff;border:2px solid #bbb;border-radius:50%;
        width:46px;height:40px;
        display:flex;align-items:center;justify-content:center;
        font-size:1.5rem;
        box-shadow:2px 2px 0 #ccc;
        position:relative;
        animation:oni-ms-bump 0.3s ease;
      }
      .oni-ms-bubble::after {
        content:"";position:absolute;bottom:-12px;left:14px;
        width:9px;height:9px;background:#fff;border-radius:50%;
        border:2px solid #bbb;box-shadow:2px 2px 0 #ccc;
      }
      .oni-ms-bubble::before {
        content:"";position:absolute;bottom:-6px;left:10px;
        width:5px;height:5px;background:#fff;border-radius:50%;
        border:2px solid #bbb;
      }

      /* ── Result screen ──────────────────────────────────────────── */
      .oni-ms-result {
        display:flex;flex-direction:column;align-items:center;gap:12px;
        animation:oni-ms-slideup .4s ease forwards;
      }
      .oni-ms-finished {
        font-size:2.4rem;font-weight:900;color:#f4d488;
        text-shadow:0 0 24px rgba(244,212,136,.8);letter-spacing:.06em;
      }
      .oni-ms-rank { font-size:1.5rem;font-weight:800;color:#fff; }
      .oni-ms-reduction-txt { font-size:1.2rem;font-weight:700;color:#c8e8ff; }
      .oni-ms-score-sub { font-size:.85rem;color:#c8c0a8;font-style:italic; }
      .oni-ms-proceed-btn {
        margin-top:6px;padding:8px 28px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.9rem;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4);transition:filter .15s;
      }
      .oni-ms-proceed-btn:hover { filter:brightness(1.15); }
      .oni-ms-proceed-btn:disabled { opacity:.5;cursor:not-allowed; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Countdown helper (shared by owner and spectators)
  // ---------------------------------------------------------------------------
  function _runCountdown(count, onDone) {
    const el = document.getElementById("oni-ms-count");
    if (el) {
      el.textContent = count;
      el.className = "oni-ms-countdown-num";
      void el.offsetWidth; // re-trigger animation
    }
    _playSound(SFX.COUNTDOWN, 0.8);

    if (count > 1) {
      setTimeout(() => _runCountdown(count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el2 = document.getElementById("oni-ms-count");
        if (el2) { el2.className = "oni-ms-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // Build the countdown panel HTML (inserted into the overlay)
  // ---------------------------------------------------------------------------
  function _buildCountdownPanel(tokenImg, displayName) {
    return `
      <div class="oni-ms-panel">
        <div class="oni-ms-title">🧖 Massage</div>
        <img src="${tokenImg}" style="width:72px;height:72px;object-fit:contain;border:none;border-radius:6px;background:transparent;">
        <div style="font-size:.9rem;font-weight:700;color:#6b3a1f;">${displayName}</div>
        <div class="oni-ms-countdown-num" id="oni-ms-count">3</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Build the live arena HTML (injected into the overlay)
  // ---------------------------------------------------------------------------
  function _buildArenaHTML(casterImg, casterName, targetImg, targetName, isOwner) {
    const gridCells = Array.from({ length: 9 }, (_, i) =>
      `<div class="oni-ms-cell${isOwner ? "" : " disabled"}" data-cell="${i}"></div>`
    ).join("");

    const spectatorNote = isOwner ? "" :
      `<div class="oni-ms-waiting" style="font-size:.8rem;margin-top:-4px;">(watching)</div>`;

    return `
      <div class="oni-ms-arena">
        <div class="oni-ms-hud">
          <div class="oni-ms-score-lbl">Score: <span id="oni-ms-score">0</span></div>
          ${spectatorNote}
          <div id="oni-ms-timer-lbl" style="color:#f4d488;">15s</div>
        </div>
        <div class="oni-ms-timer-wrap">
          <div class="oni-ms-timer-bar" id="oni-ms-timer-bar"></div>
        </div>
        <div class="oni-ms-play-area">
          <div class="oni-ms-bg-token">
            <img src="${targetImg}" alt="${targetName}">
          </div>
          <div class="oni-ms-grid" id="oni-ms-grid">${gridCells}</div>
        </div>
        <div class="oni-ms-sprites">
          <div class="oni-ms-sprite">
            <img src="${casterImg}" alt="${casterName}">
            <div class="oni-ms-sprite-name">${casterName}</div>
          </div>
          <div class="oni-ms-sprite" id="oni-ms-target-sprite">
            <div class="oni-ms-bubble-wrap">
              <div class="oni-ms-bubble" id="oni-ms-bubble">🤔</div>
            </div>
            <img src="${targetImg}" alt="${targetName}">
            <div class="oni-ms-sprite-name">${targetName}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // rAF timer loop (runs on owner; drives bar + label)
  // ---------------------------------------------------------------------------
  function _startTimerLoop() {
    const bar = document.getElementById("oni-ms-timer-bar");
    const lbl = document.getElementById("oni-ms-timer-lbl");
    let lastSec = -1;

    function _frame() {
      if (!document.getElementById(OVL_ID)) return;
      const elapsed = Date.now() - _gameStartMs;
      const remaining = Math.max(0, GAME_DURATION_MS - elapsed);
      const pct = remaining / GAME_DURATION_MS;
      if (bar) bar.style.width = `${pct * 100}%`;
      // Only update text once per second to avoid layout thrashing
      const sec = Math.ceil(remaining / 1000);
      if (lbl && sec !== lastSec) { lbl.textContent = `${sec}s`; lastSec = sec; }
      if (remaining > 0) _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // Owner: handle cell click
  // ---------------------------------------------------------------------------
  function _handleCellClick(cellIdx) {
    if (!_gameActive || _hiddenCell < 0) return;

    const prox = _proximity(cellIdx, _hiddenCell);
    const cfg  = PROXIMITY_CFG[prox];
    _score += cfg.pts;

    // Update score HUD
    const scoreEl = document.getElementById("oni-ms-score");
    if (scoreEl) scoreEl.textContent = _score;

    // Color the clicked cell
    _applyProximityToCell(cellIdx, prox);

    // Speech bubble update
    _updateBubble(cfg.emoji);

    // Floating score pop on the cell
    _spawnCellPop(cellIdx, cfg.pts);

    // Sound
    _playWebAudio(prox.toUpperCase());

    const newSpot = prox === "perfect";
    if (newSpot) {
      // Reset all cell colors then pick new hidden spot
      setTimeout(() => {
        _clearAllCells();
        _hiddenCell = _randomCell();
      }, 200);
    }

    // Broadcast to spectators
    CAMP.Socket.emit(CAMP.MSG.MASSAGE_HIT, {
      actorId:      _actorId,
      targetActorId: _targetId,
      cell:         cellIdx,
      proximity:    prox,
      score:        _score,
      newSpot,
    });
  }

  // ---------------------------------------------------------------------------
  // Apply proximity color to a cell element
  // ---------------------------------------------------------------------------
  function _applyProximityToCell(cellIdx, prox) {
    const grid = document.getElementById("oni-ms-grid");
    if (!grid) return;
    const cell = grid.querySelector(`[data-cell="${cellIdx}"]`);
    if (!cell) return;
    cell.setAttribute("data-proximity", prox);
    cell.textContent = PROXIMITY_CFG[prox]?.emoji ?? "";
  }

  function _clearAllCells() {
    const grid = document.getElementById("oni-ms-grid");
    if (!grid) return;
    grid.querySelectorAll(".oni-ms-cell").forEach(c => {
      c.removeAttribute("data-proximity");
      c.textContent = "";
    });
  }

  // ---------------------------------------------------------------------------
  // Speech bubble update
  // ---------------------------------------------------------------------------
  function _updateBubble(emoji) {
    const bubble = document.getElementById("oni-ms-bubble");
    if (!bubble) return;
    bubble.textContent = emoji;
    // Re-trigger bump animation
    bubble.style.animation = "none";
    void bubble.offsetWidth;
    bubble.style.animation = "";
  }

  // ---------------------------------------------------------------------------
  // Floating score pop — spawned on the play area so it escapes the cell bounds
  // ---------------------------------------------------------------------------
  function _spawnCellPop(cellIdx, pts) {
    if (pts === 0) return;
    const playArea = document.querySelector(".oni-ms-play-area");
    const grid     = document.getElementById("oni-ms-grid");
    if (!playArea || !grid) return;
    const cell = grid.querySelector(`[data-cell="${cellIdx}"]`);
    if (!cell) return;

    const cellRect = cell.getBoundingClientRect();
    const areaRect = playArea.getBoundingClientRect();
    const cx = cellRect.left - areaRect.left + cellRect.width  / 2;
    const cy = cellRect.top  - areaRect.top;

    const pop = document.createElement("div");
    pop.className   = "oni-ms-cell-pop";
    pop.textContent = `+${pts}`;
    pop.style.left  = `${cx}px`;
    pop.style.top   = `${cy}px`;
    playArea.appendChild(pop);
    setTimeout(() => pop.remove(), 640);
  }

  // ---------------------------------------------------------------------------
  // Start the live game (called after countdown, on owner and spectators)
  // ---------------------------------------------------------------------------
  function _startGame(actorId, targetActorId) {
    const actor       = game.actors?.get(actorId);
    const targetActor = game.actors?.get(targetActorId);
    const casterImg   = actor       ? _getTokenImg(actor)       : "icons/svg/mystery-man.svg";
    const casterName  = actor?.name ?? "?";
    const targetImg   = targetActor ? _getTokenImg(targetActor) : "icons/svg/mystery-man.svg";
    const targetName  = targetActor?.name ?? "?";

    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;

    ovl.innerHTML = _buildArenaHTML(casterImg, casterName, targetImg, targetName, _isOwner);

    _gameStartMs = Date.now();
    _gameActive  = true;

    if (_isOwner) {
      // Pick first hidden spot
      _hiddenCell = _randomCell();

      // Attach click handlers
      const grid = document.getElementById("oni-ms-grid");
      grid?.addEventListener("click", e => {
        const cell = e.target.closest("[data-cell]");
        if (cell) _handleCellClick(parseInt(cell.dataset.cell));
      });

      // Timer bar rAF
      _startTimerLoop();

      // End game after 15 s
      _endTimer = setTimeout(() => _endGame(actorId), GAME_DURATION_MS + 150);
    } else {
      // Spectator: just show timer ticking (no rAF — no interaction)
      _startTimerLoop();
      _endTimer = setTimeout(() => {
        _gameActive = false;
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      }, GAME_DURATION_MS + 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Show countdown panel then launch game (shared path for owner + spectators)
  // ---------------------------------------------------------------------------
  function _showCountdownThenGame(actorId, targetActorId) {
    const targetActor = game.actors?.get(targetActorId);
    const targetImg   = targetActor ? _getTokenImg(targetActor) : "icons/svg/mystery-man.svg";
    const targetName  = targetActor?.name ?? "?";

    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;
    ovl.innerHTML = _buildCountdownPanel(targetImg, targetName);
    _runCountdown(3, () => _startGame(actorId, targetActorId));
  }

  // ---------------------------------------------------------------------------
  // Owner submits score to GM
  // ---------------------------------------------------------------------------
  function _endGame(actorId) {
    _gameActive = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

    const actor = game.actors?.get(actorId);
    if (actor && _isActorOwner(actor)) {
      if (game.user?.isGM) {
        CAMP.MassageUI.resolveScore(actorId, _score);
      } else {
        CAMP.Socket.emit(CAMP.MSG.MASSAGE_RESULT, { actorId, score: _score });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.MassageUI = {
    targetResolvers:  {},
    scoreResolvers:   {},
    proceedResolvers: {},

    // ── Stage 1: Ally picker ─────────────────────────────────────────────────
    show(actorId, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor  = game.actors?.get(actorId);
      _isOwner = actor ? _isActorOwner(actor) : false;

      const displayName = actor?.name ?? "?";
      const ownerUid    = actor ? _getOwnerUserId(actor) : null;
      const ownerName   = ownerUid ? (game.users?.get(ownerUid)?.name ?? displayName) : displayName;

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      if (_isOwner) {
        const allyCards = (allies ?? []).map(a => `
          <div class="oni-ms-ally-card" data-ally-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <div class="oni-ms-ally-card-name">${a.name}</div>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-ms-panel">
            <div class="oni-ms-title">🧖 Massage</div>
            <div style="font-size:.85rem;color:#6b3a1f;font-weight:700;">Choose an ally to massage:</div>
            <div class="oni-ms-ally-list">${allyCards}</div>
          </div>
        `;
        document.body.appendChild(ovl);

        ovl.querySelectorAll(".oni-ms-ally-card").forEach(card => {
          card.addEventListener("click", () => {
            const targetActorId = card.dataset.allyId;
            if (game.user?.isGM) {
              CAMP.MassageUI.resolveTarget(actorId, targetActorId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.MASSAGE_TARGET, { actorId, targetActorId });
            }
          }, { once: true });
        });
      } else {
        ovl.innerHTML = `
          <div class="oni-ms-panel">
            <div class="oni-ms-title">🧖 Massage</div>
            <div class="oni-ms-waiting">Waiting for ${ownerName} to choose an ally…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }
    },

    // ── Stage 2: Arena (ally chosen, show begin gate) ────────────────────────
    showArena(actorId, targetActorId) {
      _targetId = targetActorId;

      const actor       = game.actors?.get(actorId);
      const targetActor = game.actors?.get(targetActorId);

      _isOwner = actor ? _isActorOwner(actor) : false;

      const targetImg   = targetActor ? _getTokenImg(targetActor) : "icons/svg/mystery-man.svg";
      const targetName  = targetActor?.name ?? "?";
      const ownerUid    = actor ? _getOwnerUserId(actor) : null;
      const ownerName   = ownerUid ? (game.users?.get(ownerUid)?.name ?? (actor?.name ?? "?")) : (actor?.name ?? "?");

      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;

      if (_isOwner) {
        // Pre-decode click sounds while user reads the begin screen
        _initWebAudio();

        ovl.innerHTML = `
          <div class="oni-ms-panel">
            <div class="oni-ms-title">🧖 Massage</div>
            <img src="${targetImg}" style="width:80px;height:80px;object-fit:contain;border:none;border-radius:6px;background:transparent;">
            <div style="font-size:.9rem;font-weight:700;color:#6b3a1f;">${targetName}</div>
            <div style="font-size:.8rem;color:#6b3a1f;text-align:center;max-width:260px;line-height:1.45;">
              Click squares on the grid to find the hidden spot.<br>
              <strong style="color:#c0392b;">Red</strong> = Perfect (+5) &nbsp;
              <strong style="color:#e67e22;">Yellow</strong> = Close (+2) &nbsp;
              <strong style="color:#27ae60;">Green</strong> = Near (+1) &nbsp;
              <strong style="color:#2980b9;">Blue</strong> = Miss (0)
            </div>
            <button class="oni-ms-begin-btn" id="oni-ms-begin">Click to Begin</button>
          </div>
        `;

        document.getElementById("oni-ms-begin").addEventListener("click", () => {
          if (game.user?.isGM) {
            CAMP.Socket.broadcast(CAMP.MSG.MASSAGE_BEGIN, { actorId, targetActorId });
          } else {
            CAMP.Socket.emit(CAMP.MSG.MASSAGE_BEGIN, { actorId, targetActorId });
          }
          _showCountdownThenGame(actorId, targetActorId);
        }, { once: true });
      } else {
        ovl.innerHTML = `
          <div class="oni-ms-panel">
            <div class="oni-ms-title">🧖 Massage</div>
            <img src="${targetImg}" style="width:80px;height:80px;object-fit:contain;border:none;border-radius:6px;background:transparent;">
            <div style="font-size:.9rem;font-weight:700;color:#6b3a1f;">${targetName}</div>
            <div class="oni-ms-waiting">Waiting for ${ownerName} to begin…</div>
          </div>
        `;
      }
    },

    // ── Spectator: owner clicked Begin ──────────────────────────────────────
    spectateBegin(actorId) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      _showCountdownThenGame(actorId, _targetId);
    },

    // ── Spectator: owner clicked a cell ─────────────────────────────────────
    onHit(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;

      const { cell, proximity, score, newSpot } = payload ?? {};

      // Update score HUD
      const scoreEl = document.getElementById("oni-ms-score");
      if (scoreEl && score != null) scoreEl.textContent = score;

      // Color the clicked cell
      if (cell != null && proximity) _applyProximityToCell(cell, proximity);

      // Speech bubble
      const cfg = PROXIMITY_CFG[proximity];
      if (cfg) _updateBubble(cfg.emoji);

      // Pop
      if (cell != null && cfg?.pts > 0) _spawnCellPop(cell, cfg.pts);

      // Play sound
      if (proximity) _playSound(SFX[proximity.toUpperCase()], 0.7);

      // New spot: clear cell colors
      if (newSpot) {
        setTimeout(_clearAllCells, 220);
      }
    },

    // ── Stage 3: Result reveal (all clients) ─────────────────────────────────
    applyResult(actorId, score, reduction) {
      if (_resultShown) return;
      _resultShown = true;
      _gameActive  = false;
      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

      _playSound(SFX.RESULT, 0.85);

      const rank  = _rankLabel(score);
      const actor = game.actors?.get(actorId);
      const isOwnerNow = actor ? _isActorOwner(actor) : false;

      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;

      ovl.innerHTML = `
        <div class="oni-ms-panel">
          <div class="oni-ms-result">
            <div class="oni-ms-finished">Finished!</div>
            <div class="oni-ms-rank">✨ ${rank}</div>
            <div class="oni-ms-reduction-txt">MP Reduction: ${reduction}%</div>
            <div class="oni-ms-score-sub">Score: ${score} / ${MAX_SCORE}</div>
            ${isOwnerNow ? `<button class="oni-ms-proceed-btn" id="oni-ms-proceed">Click to Proceed</button>` : ""}
          </div>
        </div>
      `;

      if (isOwnerNow) {
        const btn = document.getElementById("oni-ms-proceed");
        btn?.addEventListener("click", () => {
          btn.disabled = true;
          if (game.user?.isGM) {
            CAMP.MassageUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.MASSAGE_PROCEED, { actorId });
          }
        }, { once: true });
      }
    },

    // ── Gate resolvers (called by GM execute() and camp-socket.js) ───────────
    resolveTarget(actorId, targetActorId) {
      const resolver = this.targetResolvers?.[actorId];
      if (!resolver) return;
      delete this.targetResolvers[actorId];
      resolver(targetActorId);
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

    // ── Dismiss overlay ──────────────────────────────────────────────────────
    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-ms-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Massage UI loaded.");
})();
