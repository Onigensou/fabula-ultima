// ============================================================================
// Camp Activity — Martial Practice UI  (Fruit Ninja minigame)
//
// Canvas-based slash game. All physics and rendering happen on a single
// <canvas> element. No DOM fruit elements.
//
// Stages:
//   1 — Waiting     ("Click to Begin" panel + rules; spectators see waiting panel)
//   2 — Countdown   (3 → 2 → 1 → GO!)
//   3 — Minigame    (15 s: fruit arcs up from bottom, player slashes with cursor)
//   4 — Result      (score + rank + multiValue + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts MARTIAL_PRACTICE_START  → all call show()        (GM direct too)
//   Owner clicks Begin → emits MARTIAL_PRACTICE_BEGIN { seed }     → all spectateBegin()
//   Owner slashes objects → emits MARTIAL_PRACTICE_SLASH { actorId, hitIds, isBomb, slashScore }
//   [15 s game; owner tracks score]
//   Owner emits MARTIAL_PRACTICE_RESULT { score }   → GM
//   GM broadcasts MARTIAL_PRACTICE_RESULT { score, multiValue } → all applyResult()
//   Owner clicks Proceed → emits MARTIAL_PRACTICE_PROCEED → GM
//   GM broadcasts MARTIAL_PRACTICE_DONE → all hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MartialPracticeUI]";
  const OVL_ID    = "oni-camp-mp-ovl";
  const STYLE_ID  = "oni-camp-mp-style";

  // ---------------------------------------------------------------------------
  // Sound constants
  // ---------------------------------------------------------------------------
  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    RESULT:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
    SLASH:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_HITKIRIC.wav",
    BOMB:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Explosion1.ogg",
  };

  // ---------------------------------------------------------------------------
  // Game constants
  // ---------------------------------------------------------------------------
  const GAME_MS       = 15_000;
  const CW            = 520;   // canvas width
  const CH            = 420;   // canvas height
  const GRAVITY       = 620;   // px/s²
  const FRUIT_RADIUS  = 28;    // hitbox radius
  const BOMB_RADIUS   = 26;
  const SLASH_SPEED   = 180;   // min pointer px/s to count as a slash
  const TRAIL_LIFE_MS = 200;   // ms slash trail lingers

  // ---------------------------------------------------------------------------
  // Fruit pool
  // ---------------------------------------------------------------------------
  const FRUIT_POOL = [
    { emoji: "🍎", score: 10, color: "#e84040" },
    { emoji: "🍋", score: 15, color: "#f0d040" },
    { emoji: "🍉", score: 20, color: "#40c060" },
    { emoji: "🥭", score: 20, color: "#f08030" },
    { emoji: "🍇", score: 15, color: "#9060c0" },
    { emoji: "🍑", score: 10, color: "#f0a060" },
    { emoji: "🍊", score: 10, color: "#f07020" },
    { emoji: "🍓", score: 15, color: "#e04060" },
  ];

  // Phase spawn schedule
  const PHASES = [
    { start:     0, end:  5_000, fruits: 7,  bombs: 2 },
    { start: 5_000, end: 10_000, fruits: 9,  bombs: 3 },
    { start: 10_000, end: 15_000, fruits: 11, bombs: 4 },
  ];

  // ---------------------------------------------------------------------------
  // Seeded PRNG — mulberry32
  // ---------------------------------------------------------------------------
  function _mkRng(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Spawn schedule builder — deterministic, shared by owner + spectators
  // RNG order per entry: jitter → fruitIdx (fruit only) → launchAngle → launchSpeed
  // ---------------------------------------------------------------------------
  function _buildSchedule(rng) {
    const entries = [];
    for (const phase of PHASES) {
      const span = phase.end - phase.start;

      // Fruits
      const fSlot = span / (phase.fruits + 1);
      for (let i = 0; i < phase.fruits; i++) {
        const jitter = (rng() - 0.5) * fSlot * 0.4;
        const t      = phase.start + fSlot * (i + 1) + jitter;
        const def    = FRUIT_POOL[Math.floor(rng() * FRUIT_POOL.length)];
        const angle  = (rng() * 80 + 50) * (Math.PI / 180); // 50°–130° — wider arc variety
        const speed  = 260 + rng() * 320;                  // 260–580 — slow floaters to fast bullets
        const spawnX = 80 + rng() * (CW - 160);
        entries.push({ tMs: Math.round(t), kind: "fruit", ...def, angle, speed, spawnX });
      }

      // Bombs
      const bSlot = span / (phase.bombs + 1);
      for (let i = 0; i < phase.bombs; i++) {
        const jitter = (rng() - 0.5) * bSlot * 0.4;
        const t      = phase.start + bSlot * (i + 1) + jitter;
        const angle  = (rng() * 80 + 50) * (Math.PI / 180);
        const speed  = 240 + rng() * 280;                  // 240–520
        const spawnX = 80 + rng() * (CW - 160);
        entries.push({ tMs: Math.round(t), kind: "bomb", emoji: "💣", score: -75, color: "#404040", angle, speed, spawnX });
      }
    }
    entries.sort((a, b) => a.tMs - b.tMs);
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Module state (reset on hide)
  // ---------------------------------------------------------------------------
  let _actorId         = null;
  let _actorName       = null;
  let _isOwner         = false;
  let _score           = 0;
  let _gameActive      = false;
  let _gameStartMs     = null;
  let _schedule        = [];
  let _pendingObjects  = [];   // pre-baked, not yet on screen
  let _objects         = [];   // currently visible fruit/bomb objects
  let _rafId           = null;
  let _lastFrameMs     = 0;
  let _endTimer        = null;
  let _resultShown     = false;
  let _seed            = 0;

  // Slash trail
  let _pointerHistory = [];  // [{ x, y, t }] rolling window
  let _activeSlash    = [];  // points of current slash segment being drawn
  let _trailSegments  = [];  // [{ points, birthMs }] fading trails

  // Particle arrays
  let _particles  = [];  // { x, y, vx, vy, life, maxLife, r, color }
  let _popTexts   = [];  // { x, y, vy, text, color, life, maxLife }
  let _halves     = [];  // { x, y, vx, vy, spin, angle, emoji, color, life, maxLife }
  let _flashAlpha = 0;   // red flash for bomb hit

  // Web Audio
  let _audioCtx = null;
  let _buffers  = {};

  // ---------------------------------------------------------------------------
  // Web Audio
  // ---------------------------------------------------------------------------
  async function _initAudio() {
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      await Promise.all(Object.values(SFX).map(_preloadBuffer));
    } catch (e) {
      console.warn(TAG, "Web Audio init failed:", e.message);
    }
  }

  async function _preloadBuffer(url) {
    try {
      const ab      = await (await fetch(url)).arrayBuffer();
      _buffers[url] = await _audioCtx.decodeAudioData(ab);
    } catch (e) {
      console.warn(TAG, "Could not preload", url, e.message);
    }
  }

  function _playBuf(url, volume = 0.3) {
    if (!_audioCtx || !_buffers[url]) return;
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const gain = _audioCtx.createGain();
    gain.gain.value = volume;
    const src = _audioCtx.createBufferSource();
    src.buffer = _buffers[url];
    src.connect(gain);
    gain.connect(_audioCtx.destination);
    src.start(0);
  }

  function _playSfx(url, volume = 0.3) {
    if (_audioCtx && _buffers[url]) { _playBuf(url, volume); return; }
    try { new Audio(url).play(); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Ownership helpers
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _isOwnerOf(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ---------------------------------------------------------------------------
  // Clear state
  // ---------------------------------------------------------------------------
  function _clearState() {
    if (_rafId !== null)    { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
    _actorId        = null;
    _actorName      = null;
    _isOwner        = false;
    _score          = 0;
    _gameActive     = false;
    _gameStartMs    = null;
    _schedule       = [];
    _pendingObjects = [];
    _objects        = [];
    _lastFrameMs    = 0;
    _resultShown    = false;
    _seed           = 0;
    _pointerHistory = [];
    _activeSlash    = [];
    _trailSegments  = [];
    _particles      = [];
    _popTexts       = [];
    _halves         = [];
    _flashAlpha     = 0;
    _audioCtx       = null;
    _buffers        = {};
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${OVL_ID} {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, #0e1a2a 0%, #040810 100%);
  font-family: "Signika", serif;
  color: #e8dff8;
  user-select: none;
}
.oni-mp-title {
  font-size: 26px; font-weight: bold; letter-spacing: 2px;
  margin-bottom: 6px; color: #f0c060;
  text-shadow: 0 0 12px rgba(240,160,40,0.8);
}
.oni-mp-hud {
  display: flex; gap: 32px; align-items: center;
  margin-bottom: 10px; font-size: 20px;
}
.oni-mp-score-label { color: #ffd700; font-weight: bold; }
.oni-mp-timer-label { color: #9ee8ff; font-weight: bold; }

.oni-mp-canvas-wrap {
  position: relative;
  width: ${CW}px; height: ${CH}px;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 0 32px rgba(240,160,40,0.3), 0 0 80px rgba(0,0,0,0.7);
  border: 2px solid rgba(240,160,40,0.3);
}
#oni-mp-canvas {
  display: block;
  width: ${CW}px; height: ${CH}px;
  cursor: crosshair;
  touch-action: none;
}

/* begin / countdown overlay sits above canvas */
.oni-mp-begin-panel {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: rgba(4,8,16,0.82);
  border-radius: 10px;
  z-index: 10;
}
.oni-mp-begin-btn {
  padding: 12px 32px; font-size: 20px; font-weight: bold;
  background: linear-gradient(135deg, #8a4a10, #c07030);
  color: #fff; border: none; border-radius: 8px; cursor: pointer;
  box-shadow: 0 0 18px rgba(240,160,40,0.6);
  transition: transform 0.1s, box-shadow 0.1s;
}
.oni-mp-begin-btn:hover { transform: scale(1.05); box-shadow: 0 0 28px rgba(255,200,80,0.85); }
.oni-mp-wait-msg { color: #907040; font-size: 15px; margin-top: 10px; }
.oni-mp-rules {
  margin-top: 14px; text-align: center;
  display: flex; flex-direction: column; gap: 5px;
}
.oni-mp-rule-row { font-size: 13px; color: #c8b888; line-height: 1.5; }
.oni-mp-rule-row .good { color: #ffe066; }
.oni-mp-rule-row .bad  { color: #ff7777; }

.oni-mp-countdown {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: rgba(4,8,16,0.65);
  border-radius: 10px;
  z-index: 10; pointer-events: none;
}
.oni-mp-cd-num {
  font-size: 96px; font-weight: bold; color: #f0c060;
  text-shadow: 0 0 40px rgba(240,160,40,0.95);
  animation: oniMpCdPop 0.55s ease-out;
}
@keyframes oniMpCdPop {
  0%   { transform: scale(1.8); opacity: 0.3; }
  40%  { transform: scale(1.06); opacity: 1; }
  100% { transform: scale(1);   opacity: 1; }
}

/* result below canvas */
.oni-mp-result-below {
  margin-top: 12px; text-align: center;
  animation: oniMpResultIn 0.45s ease-out;
}
@keyframes oniMpResultIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
.oni-mp-rank-text   { font-size: 24px; font-weight: bold; color: #ffd700; margin-bottom: 3px; }
.oni-mp-score-text  { font-size: 17px; color: #c9b3f5; }
.oni-mp-uses-text   { font-size: 15px; color: #9ee8ff; margin-top: 3px; }

.oni-mp-proceed-wrap { margin-top: 12px; min-height: 44px; }
.oni-mp-proceed-btn {
  padding: 10px 26px; font-size: 17px; font-weight: bold;
  background: linear-gradient(135deg, #1a5a3a, #2a8a5a);
  color: #fff; border: none; border-radius: 8px; cursor: pointer;
  box-shadow: 0 0 14px rgba(60,200,120,0.5);
}
.oni-mp-proceed-btn:hover { box-shadow: 0 0 24px rgba(80,255,160,0.75); }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Build overlay HTML
  // ---------------------------------------------------------------------------
  function _buildOverlay() {
    const div = document.createElement("div");
    div.id = OVL_ID;
    div.innerHTML = `
      <div class="oni-mp-title">⚔️ Martial Practice</div>
      <div class="oni-mp-hud">
        <span class="oni-mp-score-label">Score: <span id="oni-mp-score">0</span></span>
        <span class="oni-mp-timer-label">⏱ <span id="oni-mp-timer">15</span>s</span>
      </div>
      <div class="oni-mp-canvas-wrap">
        <canvas id="oni-mp-canvas" width="${CW}" height="${CH}"></canvas>

        <div class="oni-mp-begin-panel" id="oni-mp-begin-panel">
          <button class="oni-mp-begin-btn" id="oni-mp-begin-btn" style="display:none;">Click to Begin</button>
          <p class="oni-mp-wait-msg" id="oni-mp-wait-msg" style="display:none;">Waiting for player to begin…</p>
          <div class="oni-mp-rules">
            <div class="oni-mp-rule-row"><span class="good">🍎 Fruit</span> — slash by moving your cursor fast across it</div>
            <div class="oni-mp-rule-row"><span class="bad">💣 Bombs</span> — don't slash these, they cost points!</div>
            <div class="oni-mp-rule-row" style="color:#908060;font-size:12px;">Slash multiple fruits in one motion for bonus points</div>
          </div>
        </div>

        <div class="oni-mp-countdown" id="oni-mp-countdown" style="display:none;">
          <span class="oni-mp-cd-num" id="oni-mp-cd-num"></span>
        </div>
      </div>

      <div class="oni-mp-result-below" id="oni-mp-result-panel" style="display:none;">
        <div class="oni-mp-rank-text"  id="oni-mp-rank"></div>
        <div class="oni-mp-score-text" id="oni-mp-final-score"></div>
        <div class="oni-mp-uses-text"  id="oni-mp-uses"></div>
      </div>
      <div class="oni-mp-proceed-wrap">
        <button class="oni-mp-proceed-btn" id="oni-mp-proceed" style="display:none;">Click to Proceed</button>
      </div>
    `;
    document.body.appendChild(div);
    return div;
  }

  // ---------------------------------------------------------------------------
  // Canvas helpers
  // ---------------------------------------------------------------------------
  function _getCanvas() { return /** @type {HTMLCanvasElement} */ (document.getElementById("oni-mp-canvas")); }
  function _getCtx()    { return _getCanvas()?.getContext("2d"); }

  // ---------------------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------------------
  async function _runCountdown(onDone) {
    const beginPanel = document.getElementById("oni-mp-begin-panel");
    const cdDiv      = document.getElementById("oni-mp-countdown");
    const cdNum      = document.getElementById("oni-mp-cd-num");
    if (beginPanel) beginPanel.style.display = "none";
    if (!cdDiv || !cdNum) { onDone(); return; }
    cdDiv.style.display = "flex";

    for (const label of ["3", "2", "1", "GO!"]) {
      _playSfx(label === "GO!" ? SFX.GO : SFX.COUNTDOWN);
      cdNum.textContent = label;
      cdNum.style.animation = "none";
      cdNum.offsetHeight; // force reflow
      cdNum.style.animation = "";
      await new Promise(r => setTimeout(r, label === "GO!" ? 700 : 850));
    }
    cdDiv.style.display = "none";
    onDone();
  }

  // ---------------------------------------------------------------------------
  // Pointer events — slash detection
  // ---------------------------------------------------------------------------
  function _onPointerMove(e) {
    if (!_gameActive || !_isOwner) return;
    const now  = performance.now();
    const x    = e.offsetX;
    const y    = e.offsetY;

    _pointerHistory.push({ x, y, t: now });
    _pointerHistory = _pointerHistory.filter(p => p.t >= now - 150);

    // Always accumulate trail — no click required
    _activeSlash.push({ x, y, t: now });
    _activeSlash = _activeSlash.filter(p => p.t >= now - 250);

    if (_pointerHistory.length >= 2) {
      const oldest = _pointerHistory[0];
      const dx     = x - oldest.x;
      const dy     = y - oldest.y;
      const dt     = (now - oldest.t) / 1000;
      const speed  = Math.sqrt(dx * dx + dy * dy) / Math.max(dt, 0.001);
      if (speed >= SLASH_SPEED) {
        _testSlash(x, y, oldest.x, oldest.y);
      }
    }
  }

  function _onPointerUp(e) {
    if (!_isOwner) return;
    if (_activeSlash.length > 1) {
      _trailSegments.push({ points: [..._activeSlash], birthMs: performance.now() });
    }
    _activeSlash = [];
  }

  // ---------------------------------------------------------------------------
  // Slash geometry — segment vs circle intersection
  // ---------------------------------------------------------------------------
  function _segmentIntersectsCircle(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax;
    const dy = by - ay;
    const fx = ax - cx;
    const fy = ay - cy;
    const a  = dx * dx + dy * dy;
    if (a === 0) return (fx * fx + fy * fy) <= r * r;
    let t = -(fx * dx + fy * dy) / a;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx - cx;
    const py = ay + t * dy - cy;
    return (px * px + py * py) <= r * r;
  }

  // Test all live objects against the current slash segment
  function _testSlash(x1, y1, x2, y2) {
    const hit     = [];
    let   isBomb  = false;
    let   slashScore = 0;

    for (const obj of [..._objects]) {
      const r = obj.kind === "bomb" ? BOMB_RADIUS : FRUIT_RADIUS;
      if (!_segmentIntersectsCircle(x1, y1, x2, y2, obj.x, obj.y, r)) continue;

      hit.push(obj.id);
      _removeObject(obj);

      if (obj.kind === "bomb") {
        isBomb = true;
        slashScore += obj.score; // negative
        _spawnBombParticles(obj.x, obj.y);
        _flashAlpha = 0.45;
        _playSfx(SFX.BOMB, 0.35);
        _spawnPopText(obj.x, obj.y, `${obj.score}`, "#ff4444");
      } else {
        slashScore += obj.score;
        _spawnFruitParticles(obj.x, obj.y, obj.color);
        _spawnFruitHalves(obj.x, obj.y, obj.emoji, obj.color);
        _playSfx(SFX.SLASH, 0.2);
        _spawnPopText(obj.x, obj.y, `+${obj.score}`, "#ffd700");
      }
    }

    if (hit.length === 0) return;

    // Multi-slash bonus: +5 per additional fruit in one stroke
    if (hit.length >= 2 && !isBomb) slashScore += (hit.length - 1) * 5;

    _score += slashScore;
    _updateScoreHud();

    // Multi-slash visual pop
    if (hit.length >= 2 && !isBomb) {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2 - 20;
      _spawnPopText(cx, cy, `✦ ${hit.length}× MULTI!`, "#fff080");
    }

    CAMP.Socket.emit(CAMP.MSG.MARTIAL_PRACTICE_SLASH, {
      actorId: _actorId,
      hitIds:  hit,
      isBomb,
      slashScore,
    });
  }

  // ---------------------------------------------------------------------------
  // Object management
  // ---------------------------------------------------------------------------

  // Called once when the countdown finishes. Pre-bakes every object's full
  // trajectory so the rAF loop never needs to call Math.cos/sin or consult
  // the schedule again — positions are computed analytically from elapsed time.
  function _prepareObjects() {
    _pendingObjects = _schedule.map((entry, i) => ({
      id:      `mp-${i}`,
      kind:    entry.kind,
      emoji:   entry.emoji,
      score:   entry.score,
      color:   entry.color,
      spawnMs: entry.tMs,
      spawnX:  entry.spawnX,
      vx:      Math.cos(Math.PI - entry.angle) * entry.speed,
      vy:      -Math.sin(entry.angle) * entry.speed,
      x:       entry.spawnX,
      y:       CH + 20,
    }));
    // _schedule is already sorted by tMs so _pendingObjects is too
    _objects = [];
  }

  function _removeObject(obj) {
    const idx = _objects.indexOf(obj);
    if (idx >= 0) _objects.splice(idx, 1);
  }

  // ---------------------------------------------------------------------------
  // Particle emitters
  // ---------------------------------------------------------------------------
  function _spawnFruitParticles(x, y, color) {
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 160;
      _particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        r: 4 + Math.random() * 5,
        color,
        life: 1, maxLife: 0.5 + Math.random() * 0.3,
      });
    }
  }

  function _spawnBombParticles(x, y) {
    for (let i = 0; i < 28; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 200;
      const color = Math.random() > 0.5 ? "#ff6020" : "#ff2000";
      _particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        r: 5 + Math.random() * 7,
        color,
        life: 1, maxLife: 0.4 + Math.random() * 0.3,
      });
    }
  }

  function _spawnFruitHalves(x, y, emoji, color) {
    for (const dir of [-1, 1]) {
      _halves.push({
        x, y,
        vx: dir * (80 + Math.random() * 60),
        vy: -(100 + Math.random() * 80),
        spin: dir * (3 + Math.random() * 4),
        angle: 0,
        emoji,
        color,
        life: 1,
        maxLife: 0.55 + Math.random() * 0.2,
      });
    }
  }

  function _spawnPopText(x, y, text, color) {
    _popTexts.push({
      x, y,
      vy: -(60 + Math.random() * 30),
      text, color,
      life: 1, maxLife: 0.9,
    });
  }

  // ---------------------------------------------------------------------------
  // Main rAF render loop
  // ---------------------------------------------------------------------------
  function _startLoop() {
    _gameStartMs = performance.now();
    _lastFrameMs = _gameStartMs;

    function frame(now) {
      const dt      = Math.min((now - _lastFrameMs) / 1000, 0.05);
      _lastFrameMs  = now;
      const elapsed = now - _gameStartMs;

      // Promote pre-baked objects onto screen when their spawn time arrives
      while (_pendingObjects.length && _pendingObjects[0].spawnMs <= elapsed) {
        _objects.push(_pendingObjects.shift());
      }

      // Update timer HUD
      const timerEl = document.getElementById("oni-mp-timer");
      if (timerEl) timerEl.textContent = Math.max(0, Math.ceil((GAME_MS - elapsed) / 1000));

      // Analytical position update — no integration error, no per-frame trig
      const toRemove = [];
      for (const obj of _objects) {
        const ageSec = (elapsed - obj.spawnMs) / 1000;
        obj.x = obj.spawnX + obj.vx * ageSec;
        obj.y = (CH + 20) + obj.vy * ageSec + 0.5 * GRAVITY * ageSec * ageSec;
        if (obj.y > CH + 60) toRemove.push(obj);
      }
      for (const obj of toRemove) _removeObject(obj);

      // Particles
      for (const p of _particles) {
        p.x  += p.vx * dt;
        p.y  += p.vy * dt;
        p.vy += GRAVITY * 0.5 * dt;
        p.life -= dt / p.maxLife;
      }
      _particles = _particles.filter(p => p.life > 0);

      // Halves
      for (const h of _halves) {
        h.x     += h.vx * dt;
        h.y     += h.vy * dt;
        h.vy    += GRAVITY * 0.7 * dt;
        h.angle += h.spin * dt;
        h.life  -= dt / h.maxLife;
      }
      _halves = _halves.filter(h => h.life > 0);

      // Pop texts
      for (const p of _popTexts) {
        p.y    += p.vy * dt;
        p.life -= dt / p.maxLife;
      }
      _popTexts = _popTexts.filter(p => p.life > 0);

      // Flash decay
      if (_flashAlpha > 0) _flashAlpha = Math.max(0, _flashAlpha - dt * 3);

      // Trail cleanup
      const trailCutoff = performance.now() - TRAIL_LIFE_MS;
      _trailSegments = _trailSegments.filter(s => s.birthMs >= trailCutoff);

      // Draw
      _draw(now);

      if (_gameActive) _rafId = requestAnimationFrame(frame);
    }

    _rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------------
  function _draw(now) {
    const canvas = _getCanvas();
    const ctx    = _getCtx();
    if (!canvas || !ctx) return;

    // Background
    ctx.clearRect(0, 0, CW, CH);
    const bg = ctx.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, "#0a1420");
    bg.addColorStop(1, "#040810");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CW, CH);

    // Red flash (bomb hit)
    if (_flashAlpha > 0) {
      ctx.fillStyle = `rgba(255,30,0,${_flashAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, CW, CH);
    }

    // Fruit halves (behind live objects)
    ctx.save();
    ctx.font = "40px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const h of _halves) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, h.life);
      ctx.translate(h.x, h.y);
      ctx.rotate(h.angle);

      // Clip to a half-circle to simulate cut fruit
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, FRUIT_RADIUS + 4, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillText(h.emoji, 0, 0);
      ctx.restore();

      ctx.restore();
    }
    ctx.restore();

    // Particles
    for (const p of _particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.restore();
    }

    // Live objects
    ctx.font = `${FRUIT_RADIUS * 1.7}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const obj of _objects) {
      ctx.save();
      ctx.fillText(obj.emoji, obj.x, obj.y);

      // Subtle glow ring for bombs
      if (obj.kind === "bomb") {
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, BOMB_RADIUS + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,60,0,0.35)";
        ctx.lineWidth   = 2;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Fading trail segments
    for (const seg of _trailSegments) {
      const age   = (now - seg.birthMs) / TRAIL_LIFE_MS;
      const alpha = Math.max(0, 1 - age);
      _drawTrail(ctx, seg.points, alpha);
    }

    // Active (live) slash trail while pointer is held
    if (_activeSlash.length > 1) {
      _drawTrail(ctx, _activeSlash, 0.95);
    }

    // Pop texts
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    for (const p of _popTexts) {
      const alpha = Math.max(0, p.life);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font        = "bold 22px 'Signika', serif";
      ctx.fillStyle   = p.color;
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur  = 6;
      ctx.fillText(p.text, p.x, p.y);
      ctx.restore();
    }
  }

  // Draw a tapered slash trail
  function _drawTrail(ctx, points, alpha) {
    if (points.length < 2) return;
    ctx.save();
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < points.length; i++) {
      const t       = i / points.length;
      const width   = 3 + t * 8;
      const opacity = alpha * t;
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x,     points[i].y);

      // Gradient stroke: white center, cyan edge
      const grad = ctx.createLinearGradient(
        points[i - 1].x, points[i - 1].y,
        points[i].x,     points[i].y
      );
      grad.addColorStop(0, `rgba(255,255,255,${(opacity * 0.6).toFixed(3)})`);
      grad.addColorStop(1, `rgba(120,220,255,${(opacity * 0.9).toFixed(3)})`);

      ctx.strokeStyle = grad;
      ctx.lineWidth   = width;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function _updateScoreHud() {
    const el = document.getElementById("oni-mp-score");
    if (el) el.textContent = _score;
  }

  // ---------------------------------------------------------------------------
  // End of game
  // ---------------------------------------------------------------------------
  function _endGame() {
    _gameActive = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _objects = [];

    if (!_isOwner) return;

    CAMP.Socket.emit(CAMP.MSG.MARTIAL_PRACTICE_RESULT, {
      actorId: _actorId,
      score:   _score,
    });
  }

  // ---------------------------------------------------------------------------
  // Show result panel
  // ---------------------------------------------------------------------------
  function _showResultPanel(score, multiValue) {
    const rank =
      multiValue >= 4 ? "✦ Master Swordsman"  :
      multiValue >= 3 ? "⚔️ Skilled Warrior"  : "🗡️ Diligent Trainee";

    const el = document.getElementById("oni-mp-rank");
    if (el) el.textContent = rank;
    const el2 = document.getElementById("oni-mp-final-score");
    if (el2) el2.textContent = `Score: ${score}`;
    const el3 = document.getElementById("oni-mp-uses");
    if (el3) el3.textContent = `Martial Practice — Multi (${multiValue}) charge earned`;

    const panel = document.getElementById("oni-mp-result-panel");
    if (panel) panel.style.display = "block";

    _playSfx(SFX.RESULT);
    _updateScoreHud();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.MartialPracticeUI = {

    scoreResolvers:   {},
    proceedResolvers: {},

    show(actorId, actorName) {
      if (document.getElementById(OVL_ID)) return;
      _clearState();
      _actorId   = actorId;
      _actorName = actorName;

      const actor = game.actors?.get(actorId);
      _isOwner = actor ? _isOwnerOf(actor) : false;

      _injectStyles();
      _buildOverlay();
      _initAudio();

      if (_isOwner) {
        const btn = document.getElementById("oni-mp-begin-btn");
        if (btn) {
          btn.style.display = "";
          btn.addEventListener("click", () => this._ownerBegin(), { once: true });
        }
        // Pointer events on canvas
        const canvas = _getCanvas();
        if (canvas) {
          canvas.addEventListener("pointermove", _onPointerMove);
          canvas.addEventListener("pointerup",   _onPointerUp);
          canvas.addEventListener("pointerleave",_onPointerUp);
        }
      } else {
        const msg = document.getElementById("oni-mp-wait-msg");
        if (msg) msg.style.display = "";
      }
    },

    _ownerBegin() {
      const seed = Date.now() ^ Math.floor(Math.random() * 0xFFFFFF);
      _seed      = seed;
      _schedule  = _buildSchedule(_mkRng(seed));

      CAMP.Socket.emit(CAMP.MSG.MARTIAL_PRACTICE_BEGIN, { actorId: _actorId, seed });

      _runCountdown(() => {
        _prepareObjects();   // pre-bake trajectories right before game starts
        _gameActive = true;
        _score      = 0;
        _updateScoreHud();
        _startLoop();
        _endTimer = setTimeout(() => _endGame(), GAME_MS + 200);
      });
    },

    spectateBegin(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      _seed     = payload.seed;
      _schedule = _buildSchedule(_mkRng(_seed));
      _runCountdown(() => {
        _prepareObjects();   // pre-bake trajectories right before game starts
        _gameActive = true;
        _startLoop();
        _endTimer = setTimeout(() => {
          _gameActive = false;
          if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
          _objects = [];
        }, GAME_MS + 500);
      });
    },

    // Spectators hear slash events and see objects vanish
    onSlash(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      for (const id of payload.hitIds ?? []) {
        const obj = _objects.find(o => o.id === id);
        if (!obj) continue;
        _removeObject(obj);
        if (payload.isBomb) {
          _spawnBombParticles(obj.x, obj.y);
          _flashAlpha = 0.35;
        } else {
          _spawnFruitParticles(obj.x, obj.y, obj.color);
          _spawnFruitHalves(obj.x, obj.y, obj.emoji, obj.color);
        }
      }
    },

    applyResult(actorId, score, multiValue) {
      if (_resultShown) return;
      _resultShown = true;
      _gameActive  = false;
      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      _score = score;
      _showResultPanel(score, multiValue);

      const actor = game.actors?.get(actorId);
      if (actor && _isOwnerOf(actor)) {
        const btn = document.getElementById("oni-mp-proceed");
        if (btn) {
          btn.style.display = "";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            if (game.user?.isGM) {
              this.resolveProceed(actorId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.MARTIAL_PRACTICE_PROCEED, { actorId });
            }
          }, { once: true });
        }
      }
    },

    resolveScore(actorId, score) {
      const r = this.scoreResolvers?.[actorId];
      if (!r) return;
      delete this.scoreResolvers[actorId];
      r(score);
    },

    resolveProceed(actorId) {
      const r = this.proceedResolvers?.[actorId];
      if (!r) return;
      delete this.proceedResolvers[actorId];
      r();
    },

    hide() {
      const canvas = _getCanvas();
      if (canvas) {
        canvas.removeEventListener("pointermove", _onPointerMove);
        canvas.removeEventListener("pointerup",   _onPointerUp);
        canvas.removeEventListener("pointerleave",_onPointerUp);
      }
      document.getElementById(OVL_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      _clearState();
    },
  };

  console.debug(TAG, "Martial Practice UI loaded.");
})();
