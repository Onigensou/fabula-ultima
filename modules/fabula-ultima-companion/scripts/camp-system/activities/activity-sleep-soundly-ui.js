// ============================================================================
// Camp Activity — Sleep Soundly UI  (v2 — refined)
//
// Radial Dream Protector minigame overlay.
//
// Stages:
//   1 — Waiting     ("Click to Begin" gate; spectators see waiting panel)
//   2 — Countdown   (3 → 2 → 1 → GO!)
//   3 — Minigame    (15 s: food dreams & ghost nightmares move toward sleeper)
//   4 — Result      (score + rank + charges + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts SLEEP_SOUNDLY_START  → all call show()        (GM direct too)
//   Owner clicks Begin → emits SLEEP_SOUNDLY_BEGIN { seed }     → all spectateBegin()
//   Owner clicks object → emits SLEEP_SOUNDLY_HIT { objId, hitType }
//   [15 s game; owner tracks score]
//   Owner emits SLEEP_SOUNDLY_RESULT { score }   → GM
//   GM broadcasts SLEEP_SOUNDLY_RESULT { score, charges } → all applyResult()
//   Owner clicks Proceed → emits SLEEP_SOUNDLY_PROCEED → GM
//   GM broadcasts SLEEP_SOUNDLY_DONE → all hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][SleepSoundlyUI]";
  const OVL_ID    = "oni-camp-ss-ovl";
  const STYLE_ID  = "oni-camp-ss-style";

  // ---------------------------------------------------------------------------
  // Sound constants
  // ---------------------------------------------------------------------------
  const SFX = {
    COUNTDOWN:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:          "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    RESULT:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
    GHOST_REACH: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Spook.mp3",
    FOOD_REACH:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    GHOST_CLICK: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    FOOD_CLICK:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
  };

  // ---------------------------------------------------------------------------
  // Game constants
  // ---------------------------------------------------------------------------
  const GAME_MS  = 15_000;
  const ARENA_R  = 220;          // arena radius; arena div is 440×440
  const REACH_R  = 50;           // distance from center counted as "reached"
  const SPAWN_R  = ARENA_R - 8; // objects appear just inside the edge
  const FOOD_SPEED = 90;         // px/s for all food (faster = fewer visible at once)

  // ---------------------------------------------------------------------------
  // Object definitions
  // ---------------------------------------------------------------------------
  const FOOD_POOL = [
    { emoji: "🍰", score: 15 },
    { emoji: "🍮", score: 15 },
    { emoji: "🍩", score: 10 },
    { emoji: "🍪", score: 10 },
    { emoji: "🧁", score: 15 },
    { emoji: "🍫", score: 10 },
    { emoji: "🍓", score: 10 },
    { emoji: "🍡", score: 15 },
    { emoji: "🍦", score: 20 },
    { emoji: "🥞", score: 20 },
  ];

  // Ghost definitions keyed by variant name.
  // pattern: "straight" | "curving" | "zigzag" | "spiraling" | "accelerating"
  const GHOST_DEF = {
    normal:      { baseSpeed:  90, penalty: 12, pattern: "straight"     },
    fast:        { baseSpeed: 160, penalty: 18, pattern: "straight"     },
    slow:        { baseSpeed:  55, penalty: 12, pattern: "straight"     },
    curving:     { baseSpeed:  95, penalty: 22, pattern: "curving"      },  // sinusoidal weave
    zigzag:      { baseSpeed:  85, penalty: 18, pattern: "zigzag"       },  // alternates ±49° every 500 ms
    spiraling:   { baseSpeed:  75, penalty: 25, pattern: "spiraling"    },  // orbits inward over 4.5 s
    accelerating:{ baseSpeed:  40, penalty: 20, pattern: "accelerating" },  // starts slow, reaches very fast
  };

  // Phase spawn schedule — all 20 food + 11 ghosts over 15 s.
  // Phase 3 introduces the harder ghost variants.
  const PHASES = [
    { start:      0, end:  5_000, foodCount: 4, ghosts: ["normal", "slow", "normal"]                                          },
    { start:  5_000, end: 10_000, foodCount: 4, ghosts: ["fast", "zigzag", "curving", "normal"]                               },
    { start: 10_000, end: 15_000, foodCount: 4, ghosts: ["fast", "spiraling", "zigzag", "accelerating", "fast", "curving"] },
  ];

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId        = null;
  let _actorName      = null;
  let _isOwner        = false;
  let _score          = 0;
  let _gameActive     = false;
  let _gameStartMs    = null;
  let _schedule       = [];
  let _schedIdx       = 0;
  let _objects        = [];
  let _nextId         = 0;
  let _rafId          = null;
  let _lastFrameMs    = 0;
  let _endTimer       = null;
  let _resultShown    = false;
  let _currentActorId = null;
  let _seed           = 0;

  // Web Audio
  let _audioCtx = null;
  let _buffers  = {};

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
  // Schedule builder — deterministic from seed, same on all clients.
  //
  // RNG consumption order per phase (must not change):
  //   Food[i]:  jitter → foodIdx → spawnAngle
  //   Ghost[i]: jitter → spawnAngle → (curvePhase | zigzagFlip | spiralDir if applicable)
  // ---------------------------------------------------------------------------
  function _buildSchedule(rng) {
    const entries = [];

    for (const phase of PHASES) {
      const span = phase.end - phase.start;

      // Food
      const foodSlot = span / (phase.foodCount + 1);
      for (let i = 0; i < phase.foodCount; i++) {
        const jitter = (rng() - 0.5) * foodSlot * 0.5;
        const t      = phase.start + foodSlot * (i + 1) + jitter;
        const food   = FOOD_POOL[Math.floor(rng() * FOOD_POOL.length)];
        entries.push({
          tMs:        Math.round(t),
          kind:       "food",
          emoji:      food.emoji,
          score:      food.score,
          baseSpeed:  FOOD_SPEED,
          pattern:    "straight",
          spawnAngle: rng() * Math.PI * 2,
        });
      }

      // Ghosts
      const gSlot = span / (phase.ghosts.length + 1);
      phase.ghosts.forEach((variant, i) => {
        const jitter = (rng() - 0.5) * gSlot * 0.5;
        const t      = phase.start + gSlot * (i + 1) + jitter;
        const def    = GHOST_DEF[variant];
        const entry  = {
          tMs:        Math.round(t),
          kind:       "ghost",
          variant,
          emoji:      "👻",
          baseSpeed:  def.baseSpeed,
          penalty:    def.penalty,
          pattern:    def.pattern,
          spawnAngle: rng() * Math.PI * 2,
        };
        // Pattern-specific seeded params (order matters for determinism)
        if (def.pattern === "curving")    entry.curvePhase = rng() * Math.PI * 2;
        if (def.pattern === "zigzag")     entry.zigzagFlip = rng() > 0.5 ? 1 : -1;
        if (def.pattern === "spiraling")  entry.spiralDir  = rng() > 0.5 ? 1 : -1;
        entries.push(entry);
      });
    }

    entries.sort((a, b) => a.tMs - b.tMs);
    return entries;
  }

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

  function _playBuf(url) {
    if (!_audioCtx || !_buffers[url]) return;
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const gain = _audioCtx.createGain();
    gain.gain.value = 0.22;
    const src = _audioCtx.createBufferSource();
    src.buffer = _buffers[url];
    src.connect(gain);
    gain.connect(_audioCtx.destination);
    src.start(0);
  }

  function _playSfx(url) {
    if (_audioCtx && _buffers[url]) { _playBuf(url); return; }
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
    _schedIdx       = 0;
    _objects        = [];
    _nextId         = 0;
    _lastFrameMs    = 0;
    _resultShown    = false;
    _currentActorId = null;
    _seed           = 0;
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
/* ── Overlay ── */
#${OVL_ID} {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(5, 2, 20, 0.88);
  font-family: "Signika", serif;
  color: #e8dff8;
}
.oni-ss-title {
  font-size: 26px; font-weight: bold; letter-spacing: 2px;
  margin-bottom: 6px; color: #c9b3f5;
  text-shadow: 0 0 12px rgba(147,112,219,0.8);
}
.oni-ss-hud {
  display: flex; gap: 32px; align-items: center;
  margin-bottom: 14px; font-size: 20px;
}
.oni-ss-score-label { color: #ffd700; font-weight: bold; }
.oni-ss-timer-label { color: #9ee8ff; font-weight: bold; }

/* ── Arena wrapper — relative container so sleeper can float above arena ── */
.oni-ss-arena-wrap {
  position: relative;
  width: 440px; height: 440px;
}

/* ── Arena ── */
.oni-ss-arena {
  position: relative;
  width: 440px; height: 440px;
  border-radius: 50%;
  background: radial-gradient(ellipse at center, #1a1040 0%, #080618 100%);
  border: 2px solid rgba(147, 112, 219, 0.45);
  box-shadow: 0 0 32px rgba(80,0,200,0.35), inset 0 0 40px rgba(0,0,0,0.6);
  overflow: hidden;
  cursor: default;
}
.oni-ss-arena.spectate { pointer-events: none; }
.oni-ss-arena.flash-red {
  box-shadow: 0 0 48px rgba(255,40,40,0.95), inset 0 0 48px rgba(200,0,0,0.5);
}

/* ── Sleeper — sibling of arena so it is NOT clipped by arena overflow:hidden ── */
/* z-index 8: above game objects (5) but below begin/countdown panels (30) */
.oni-ss-sleeper {
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center;
  pointer-events: none;
  z-index: 8;
}
.oni-ss-token {
  width: 80px; height: 80px;
  border-radius: 6px;
  border: 2px solid rgba(147,112,219,0.5);
  object-fit: contain;
  box-shadow: 0 0 12px rgba(147,112,219,0.4);
}
.oni-ss-token-fallback {
  width: 80px; height: 80px;
  border-radius: 50%;
  border: 3px solid rgba(147,112,219,0.7);
  display: flex; align-items: center; justify-content: center;
  font-size: 40px;
  background: rgba(30,15,60,0.9);
}
.oni-ss-zzz { display: flex; gap: 3px; margin-bottom: 3px; }
.oni-ss-zzz span {
  font-weight: bold; color: #b8d4ff; opacity: 0;
  animation: oniSsZzz 2.4s ease-in-out infinite;
  text-shadow: 0 0 6px rgba(100,160,255,0.8);
}
.oni-ss-zzz span:nth-child(1) { animation-delay: 0s;   font-size: 13px; }
.oni-ss-zzz span:nth-child(2) { animation-delay: 0.7s; font-size: 16px; }
.oni-ss-zzz span:nth-child(3) { animation-delay: 1.4s; font-size: 20px; }
@keyframes oniSsZzz {
  0%   { opacity: 0; transform: translateY(0)    scale(0.8); }
  25%  { opacity: 1; transform: translateY(-7px) scale(1); }
  75%  { opacity: 0.5; transform: translateY(-16px) scale(1.1); }
  100% { opacity: 0; transform: translateY(-24px) scale(0.9); }
}

/* ── Dream objects ── */
.oni-ss-obj {
  position: absolute;
  font-size: 36px; line-height: 1;
  cursor: pointer; user-select: none;
  transform: translate(-50%, -50%);
  z-index: 5;
  filter: drop-shadow(0 0 4px rgba(200,200,255,0.4));
}
.oni-ss-obj:hover { filter: drop-shadow(0 0 10px rgba(255,255,200,0.9)); }

/* ── Score pop ── */
.oni-ss-pop {
  position: absolute;
  font-size: 20px; font-weight: bold;
  pointer-events: none; z-index: 20;
  transform: translateX(-50%);
  animation: oniSsPop 0.9s ease-out forwards;
}
.oni-ss-pop.positive { color: #ffd700; }
.oni-ss-pop.negative { color: #ff4444; }
@keyframes oniSsPop {
  0%   { opacity: 1; transform: translateX(-50%) translateY(0);     }
  100% { opacity: 0; transform: translateX(-50%) translateY(-44px); }
}

/* ── Poof (ghost clicked) ── */
.oni-ss-poof {
  position: absolute; font-size: 36px;
  pointer-events: none; z-index: 20;
  transform: translate(-50%, -50%);
  animation: oniSsPoof 0.35s ease-out forwards;
}
@keyframes oniSsPoof {
  0%   { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%,-50%) scale(2.4); }
}

/* ── Food sparkle ── */
.oni-ss-sparkle {
  position: absolute; pointer-events: none; z-index: 20;
  transform: translate(-50%, -50%);
  animation: oniSsSparkle 0.55s ease-out forwards;
}
.oni-ss-sparkle::before, .oni-ss-sparkle::after {
  content: "✨"; position: absolute; font-size: 22px;
}
.oni-ss-sparkle::before { left: -14px; top: -12px; }
.oni-ss-sparkle::after  { left:  10px; top:  -8px; }
@keyframes oniSsSparkle {
  0%   { opacity: 1; transform: translate(-50%,-50%) scale(0.8); }
  60%  { opacity: 1; transform: translate(-50%,-62%) scale(1.3); }
  100% { opacity: 0; transform: translate(-50%,-82%) scale(1);   }
}

/* ── Ghost shiver — appended to arena-wrap so it floats above the token ── */
.oni-ss-shiver {
  position: absolute; font-size: 52px;
  pointer-events: none; z-index: 60;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  animation: oniSsShiver 0.42s ease-in-out forwards;
}
@keyframes oniSsShiver {
  0%   { opacity: 1;   transform: translate(-50%,-50%) rotate(-18deg) scale(1.3); }
  25%  { transform: translate(-50%,-50%) rotate(18deg)  scale(1.5); }
  50%  { transform: translate(-50%,-50%) rotate(-12deg) scale(1.3); }
  75%  { transform: translate(-50%,-50%) rotate(12deg)  scale(1.1); }
  100% { opacity: 0;   transform: translate(-50%,-50%) rotate(0deg)  scale(0.8); }
}

/* ── Panels (inside arena) ── */
.oni-ss-begin-panel, .oni-ss-countdown {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border-radius: 50%; z-index: 30;
}
.oni-ss-begin-panel { background: rgba(8, 4, 30, 0.78); }
.oni-ss-countdown   { background: rgba(8, 4, 30, 0.62); pointer-events: none; }

.oni-ss-begin-btn {
  padding: 12px 28px; font-size: 20px; font-weight: bold;
  background: linear-gradient(135deg, #4a1a8a, #7a3ab0);
  color: #fff; border: none; border-radius: 8px; cursor: pointer;
  box-shadow: 0 0 16px rgba(147,112,219,0.6);
  transition: transform 0.1s, box-shadow 0.1s;
}
.oni-ss-begin-btn:hover { transform: scale(1.05); box-shadow: 0 0 26px rgba(200,160,255,0.85); }
.oni-ss-wait-msg { color: #9080b0; font-size: 15px; margin-top: 10px; }
.oni-ss-instructions {
  margin-top: 12px; text-align: center; pointer-events: none;
  display: flex; flex-direction: column; gap: 5px;
}
.oni-ss-instr-row {
  font-size: 13px; color: #c8b8e8; line-height: 1.4;
}
.oni-ss-instr-row .instr-good { color: #ffe066; }
.oni-ss-instr-row .instr-bad  { color: #ff7777; }

.oni-ss-cd-num {
  font-size: 84px; font-weight: bold; color: #e8dff8;
  text-shadow: 0 0 32px rgba(200,180,255,0.9);
  animation: oniSsCdPop 0.55s ease-out;
}
@keyframes oniSsCdPop {
  0%   { transform: scale(1.7); opacity: 0.4; }
  40%  { transform: scale(1.05); opacity: 1;  }
  100% { transform: scale(1);   opacity: 1;  }
}

/* ── Result (below arena-wrap) ── */
.oni-ss-result-below {
  margin-top: 12px; text-align: center;
  animation: oniSsResultIn 0.45s ease-out;
}
@keyframes oniSsResultIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
.oni-ss-rank-text   { font-size: 24px; font-weight: bold; color: #ffd700; margin-bottom: 3px; }
.oni-ss-score-text  { font-size: 17px; color: #c9b3f5; }
.oni-ss-charge-text { font-size: 15px; color: #9ee8ff; margin-top: 3px; }

/* ── Proceed button ── */
.oni-ss-proceed-wrap { margin-top: 12px; min-height: 44px; }
.oni-ss-proceed-btn {
  padding: 10px 26px; font-size: 17px; font-weight: bold;
  background: linear-gradient(135deg, #1a5a3a, #2a8a5a);
  color: #fff; border: none; border-radius: 8px; cursor: pointer;
  box-shadow: 0 0 14px rgba(60,200,120,0.5);
}
.oni-ss-proceed-btn:hover { box-shadow: 0 0 24px rgba(80,255,160,0.75); }
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
      <div class="oni-ss-title">💤 Sleep Soundly</div>
      <div class="oni-ss-hud">
        <span class="oni-ss-score-label">Score: <span id="oni-ss-score">0</span></span>
        <span class="oni-ss-timer-label">⏱ <span id="oni-ss-timer">15</span>s</span>
      </div>

      <!-- arena-wrap: arena + sleeper side-by-side in DOM so sleeper is not clipped -->
      <div class="oni-ss-arena-wrap">
        <div class="oni-ss-arena" id="oni-ss-arena">
          <!-- Click to Begin / Waiting panel -->
          <div class="oni-ss-begin-panel" id="oni-ss-begin-panel">
            <button class="oni-ss-begin-btn" id="oni-ss-begin-btn" style="display:none;">Click to Begin</button>
            <p class="oni-ss-wait-msg" id="oni-ss-wait-msg" style="display:none;">Waiting for player to begin…</p>
            <div class="oni-ss-instructions">
              <div class="oni-ss-instr-row">
                <span class="instr-good">🍰 Food dreams</span> → let them reach you
              </div>
              <div class="oni-ss-instr-row">
                <span class="instr-bad">👻 Ghosts</span> → click them before they arrive
              </div>
              <div class="oni-ss-instr-row" style="color:#a090c0;font-size:12px;">
                Clicking food removes it — no points gained or lost
              </div>
            </div>
          </div>
          <!-- Countdown -->
          <div class="oni-ss-countdown" id="oni-ss-countdown" style="display:none;">
            <span class="oni-ss-cd-num" id="oni-ss-cd-num"></span>
          </div>
          <!-- Objects are appended here at runtime -->
        </div>

        <!-- Sleeper sits outside the arena so arena overflow:hidden cannot clip it -->
        <div class="oni-ss-sleeper">
          <div class="oni-ss-zzz"><span>z</span><span>z</span><span>Z</span></div>
          <span id="oni-ss-token-wrap"></span>
        </div>
      </div>

      <!-- Result appears below arena after game ends -->
      <div class="oni-ss-result-below" id="oni-ss-result-panel" style="display:none;">
        <div class="oni-ss-rank-text"   id="oni-ss-rank"></div>
        <div class="oni-ss-score-text"  id="oni-ss-final-score"></div>
        <div class="oni-ss-charge-text" id="oni-ss-charges"></div>
      </div>

      <!-- Proceed button (owner only) -->
      <div class="oni-ss-proceed-wrap">
        <button class="oni-ss-proceed-btn" id="oni-ss-proceed" style="display:none;">Click to Proceed</button>
      </div>
    `;
    document.body.appendChild(div);
    return div;
  }

  // ---------------------------------------------------------------------------
  // Token image
  // ---------------------------------------------------------------------------
  function _setToken(actorId) {
    const actor = game.actors?.get(actorId);
    const wrap  = document.getElementById("oni-ss-token-wrap");
    if (!wrap) return;
    const src = actor?.prototypeToken?.texture?.src ?? actor?.img ?? null;
    if (src) {
      wrap.innerHTML = `<img class="oni-ss-token" src="${src}" alt="">`;
    } else {
      wrap.innerHTML = `<div class="oni-ss-token-fallback">😴</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Countdown → callback
  // ---------------------------------------------------------------------------
  async function _runCountdown(onDone) {
    const beginPanel = document.getElementById("oni-ss-begin-panel");
    const cdDiv      = document.getElementById("oni-ss-countdown");
    const cdNum      = document.getElementById("oni-ss-cd-num");
    if (beginPanel) beginPanel.style.display = "none";
    if (!cdDiv || !cdNum) { onDone(); return; }
    cdDiv.style.display = "flex";

    for (const label of ["3", "2", "1", "GO!"]) {
      _playSfx(label === "GO!" ? SFX.GO : SFX.COUNTDOWN);
      cdNum.textContent = label;
      cdNum.style.animation = "none";
      cdNum.offsetHeight; // reflow to re-trigger animation
      cdNum.style.animation = "";
      await new Promise(r => setTimeout(r, label === "GO!" ? 700 : 850));
    }
    cdDiv.style.display = "none";
    onDone();
  }

  // ---------------------------------------------------------------------------
  // Spawn an object into the arena
  // ---------------------------------------------------------------------------
  function _spawnObject(entry, elapsed) {
    const arena = document.getElementById("oni-ss-arena");
    if (!arena) return;

    const id  = `ss-obj-${_nextId++}`;
    const ang = entry.spawnAngle;
    const x   = Math.round(ARENA_R + Math.cos(ang) * SPAWN_R);
    const y   = Math.round(ARENA_R + Math.sin(ang) * SPAWN_R);

    const el = document.createElement("div");
    el.className    = "oni-ss-obj";
    el.dataset.id   = id;
    el.dataset.kind = entry.kind;
    el.textContent  = entry.emoji;
    el.style.left   = x + "px";
    el.style.top    = y + "px";
    arena.appendChild(el);

    _objects.push({
      id,
      el,
      kind:         entry.kind,
      emoji:        entry.emoji,
      score:        entry.score     ?? 0,
      penalty:      entry.penalty   ?? 0,
      pattern:      entry.pattern   ?? "straight",
      baseSpeed:    entry.baseSpeed ?? 55,
      speed:        entry.baseSpeed ?? 55,
      curvePhase:   entry.curvePhase ?? 0,
      zigzagFlip:   entry.zigzagFlip ?? 1,
      spiralDir:    entry.spiralDir  ?? 1,
      birthElapsed: elapsed,
      x,
      y,
    });
  }

  // ---------------------------------------------------------------------------
  // rAF physics loop
  // ---------------------------------------------------------------------------
  function _startPhysics() {
    _gameStartMs = performance.now();
    _lastFrameMs = _gameStartMs;

    function frame(now) {
      const dt      = Math.min((now - _lastFrameMs) / 1000, 0.08); // s, capped
      _lastFrameMs  = now;
      const elapsed = now - _gameStartMs;

      // Spawn due objects
      while (_schedIdx < _schedule.length && _schedule[_schedIdx].tMs <= elapsed) {
        _spawnObject(_schedule[_schedIdx], elapsed);
        _schedIdx++;
      }

      // Timer HUD
      const timerEl = document.getElementById("oni-ss-timer");
      if (timerEl) timerEl.textContent = Math.max(0, Math.ceil((GAME_MS - elapsed) / 1000));

      // Move objects
      const cx = ARENA_R;
      const cy = ARENA_R;
      const toRemove = [];

      for (const obj of _objects) {
        const dx   = cx - obj.x;
        const dy   = cy - obj.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < REACH_R) {
          toRemove.push(obj);
          _onObjectReach(obj);
          continue;
        }

        const toCenter = Math.atan2(dy, dx);
        let moveAngle  = toCenter;
        const age      = elapsed - obj.birthElapsed; // ms since this object spawned

        switch (obj.pattern) {
          case "curving": {
            // Sinusoidal weave; amplitude grows as game progresses
            const waveAmt = 0.045 + (elapsed / GAME_MS) * 0.06;
            moveAngle += Math.sin((elapsed / 340) + obj.curvePhase)
              * waveAmt * (ARENA_R / Math.max(dist, 30));
            break;
          }
          case "zigzag": {
            // Alternates ±49° every 500 ms — unpredictable approach
            const phase = Math.floor(age / 500) % 2;
            moveAngle  += (phase === 0 ? 1 : -1) * obj.zigzagFlip * 0.86;
            break;
          }
          case "spiraling": {
            // Starts with a ~60° angular offset that decays to 0 over 4.5 s,
            // making the ghost orbit inward before diving straight at the end
            const t       = Math.min(age / 4500, 1.0);
            const sAmt    = 1.05 * (1 - t);
            moveAngle    += sAmt * obj.spiralDir;
            break;
          }
          case "accelerating": {
            // Speed ramps from baseSpeed to ~175 px/s quadratically as it closes in
            const progress = Math.max(0, 1 - dist / SPAWN_R);
            obj.speed = obj.baseSpeed + progress * progress * 135;
            break;
          }
          // "straight": moveAngle stays as toCenter
        }

        const step = obj.speed * dt;
        obj.x += Math.cos(moveAngle) * step;
        obj.y += Math.sin(moveAngle) * step;
        obj.el.style.left = obj.x + "px";
        obj.el.style.top  = obj.y + "px";
      }

      for (const obj of toRemove) _removeObject(obj);

      if (_gameActive) _rafId = requestAnimationFrame(frame);
    }

    _rafId = requestAnimationFrame(frame);
  }

  function _removeObject(obj) {
    obj.el.remove();
    const idx = _objects.indexOf(obj);
    if (idx >= 0) _objects.splice(idx, 1);
  }

  // ---------------------------------------------------------------------------
  // Object reached center
  // ---------------------------------------------------------------------------
  function _onObjectReach(obj) {
    const arena = document.getElementById("oni-ss-arena");
    if (!arena) return;

    if (obj.kind === "food") {
      if (_isOwner) _score += obj.score;
      _updateScoreHud();
      _playSfx(SFX.FOOD_REACH);
      _showPop(arena, obj.x, obj.y, `+${obj.score}`, "positive");
      _showSparkle(arena, obj.x, obj.y);
    } else {
      if (_isOwner) _score -= obj.penalty;
      _updateScoreHud();
      _playSfx(SFX.GHOST_REACH);
      _showPop(arena, obj.x, obj.y, `-${obj.penalty}`, "negative");
      _flashArenaRed(arena);
      _showShiver();
    }
  }

  // ---------------------------------------------------------------------------
  // Owner click handler
  // ---------------------------------------------------------------------------
  function _handleClick(e) {
    if (!_gameActive || !_isOwner) return;
    const el = e.target.closest(".oni-ss-obj");
    if (!el) return;
    e.stopPropagation();

    const objId   = el.dataset.id;
    const hitType = el.dataset.kind;
    const obj     = _objects.find(o => o.id === objId);
    if (!obj) return;

    _removeObject(obj);

    if (hitType === "ghost") {
      _playSfx(SFX.GHOST_CLICK);
      _showPoof(document.getElementById("oni-ss-arena"), obj.x, obj.y);
    } else {
      _playSfx(SFX.FOOD_CLICK);
      _showFoodFade(el);
    }

    CAMP.Socket.emit(CAMP.MSG.SLEEP_SOUNDLY_HIT, {
      actorId: _actorId,
      objId,
      hitType,
    });
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function _updateScoreHud() {
    const el = document.getElementById("oni-ss-score");
    if (el) el.textContent = _score;
  }

  // ---------------------------------------------------------------------------
  // Visual effects
  // ---------------------------------------------------------------------------
  function _showPop(parent, x, y, text, cls) {
    const el = document.createElement("div");
    el.className = `oni-ss-pop ${cls}`;
    el.textContent = text;
    el.style.left = x + "px";
    el.style.top  = (y - 10) + "px";
    parent.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  function _showPoof(parent, x, y) {
    if (!parent) return;
    const el = document.createElement("div");
    el.className = "oni-ss-poof";
    el.textContent = "💨";
    el.style.left = x + "px";
    el.style.top  = y + "px";
    parent.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  function _showSparkle(parent, x, y) {
    if (!parent) return;
    const el = document.createElement("div");
    el.className = "oni-ss-sparkle";
    el.style.left = x + "px";
    el.style.top  = y + "px";
    parent.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  // Shiver is appended to arena-wrap so it appears above the sleeper token
  function _showShiver() {
    const wrap = document.querySelector(".oni-ss-arena-wrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "oni-ss-shiver";
    el.textContent = "👻";
    wrap.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  function _showFoodFade(el) {
    el.style.transition = "opacity 0.22s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 230);
  }

  function _flashArenaRed(arena) {
    if (!arena) return;
    arena.classList.add("flash-red");
    setTimeout(() => arena.classList.remove("flash-red"), 330);
  }

  // ---------------------------------------------------------------------------
  // End of game — owner submits score to GM
  // ---------------------------------------------------------------------------
  function _endGame() {
    _gameActive = false;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    for (const obj of [..._objects]) obj.el.remove();
    _objects = [];

    if (!_isOwner) return;

    CAMP.Socket.emit(CAMP.MSG.SLEEP_SOUNDLY_RESULT, {
      actorId: _actorId,
      score:   _score,
    });
  }

  // ---------------------------------------------------------------------------
  // Show result (called on all clients via applyResult)
  // ---------------------------------------------------------------------------
  function _showResultPanel(score, charges) {
    const rankMap = {
      3: "✨ Perfect Slumber",
      2: "💫 Sweet Dreams",
    };
    const rank = rankMap[charges]
      ?? (score >= 81  ? "🌙 Cozy Sleep"
        : score >= 1   ? "💤 Light Sleep"
        : "😰 Restless Night");

    const chargesText = charges === 1 ? "1 charge" : charges === 2 ? "2 charges" : "3 charges";

    document.getElementById("oni-ss-rank").textContent        = rank;
    document.getElementById("oni-ss-final-score").textContent = `Score: ${score}`;
    document.getElementById("oni-ss-charges").textContent     = `Sleep Soundly — ${chargesText}`;
    const panel = document.getElementById("oni-ss-result-panel");
    if (panel) panel.style.display = "block";

    _playSfx(SFX.RESULT);
    _updateScoreHud();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.SleepSoundlyUI = {

    scoreResolvers:   {},
    proceedResolvers: {},

    show(actorId, actorName) {
      if (document.getElementById(OVL_ID)) return;
      _clearState();
      _actorId = actorId;
      _actorName = actorName;
      _currentActorId = actorId;

      const actor = game.actors?.get(actorId);
      _isOwner = actor ? _isOwnerOf(actor) : false;

      _injectStyles();
      _buildOverlay();
      _setToken(actorId);
      _initAudio(); // fire-and-forget

      const arena = document.getElementById("oni-ss-arena");
      if (!_isOwner && arena) arena.classList.add("spectate");

      if (_isOwner) {
        const btn = document.getElementById("oni-ss-begin-btn");
        if (btn) {
          btn.style.display = "";
          btn.addEventListener("click", () => this._ownerBegin(), { once: true });
        }
      } else {
        const msg = document.getElementById("oni-ss-wait-msg");
        if (msg) msg.style.display = "";
      }

      if (_isOwner && arena) arena.addEventListener("click", _handleClick);
    },

    _ownerBegin() {
      const seed = Date.now() ^ Math.floor(Math.random() * 0xFFFFFF);
      _seed = seed;
      _schedule = _buildSchedule(_mkRng(seed));
      _schedIdx = 0;

      CAMP.Socket.emit(CAMP.MSG.SLEEP_SOUNDLY_BEGIN, { actorId: _actorId, seed });

      _runCountdown(() => {
        _gameActive = true;
        _score = 0;
        _updateScoreHud();
        _startPhysics();
        _endTimer = setTimeout(() => _endGame(), GAME_MS + 200);
      });
    },

    spectateBegin(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      _seed = payload.seed;
      _schedule = _buildSchedule(_mkRng(_seed));
      _schedIdx = 0;
      _runCountdown(() => {
        _gameActive = true;
        _startPhysics();
        _endTimer = setTimeout(() => {
          _gameActive = false;
          if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
          for (const obj of [..._objects]) obj.el.remove();
          _objects = [];
        }, GAME_MS + 500);
      });
    },

    onHit(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      const obj = _objects.find(o => o.id === payload.objId);
      if (!obj) return;
      _removeObject(obj);
      const arena = document.getElementById("oni-ss-arena");
      if (payload.hitType === "ghost") {
        _playSfx(SFX.GHOST_CLICK);
        _showPoof(arena, obj.x, obj.y);
      } else {
        _playSfx(SFX.FOOD_CLICK);
        _showFoodFade(obj.el);
      }
    },

    applyResult(actorId, score, charges) {
      if (_resultShown) return;
      _resultShown = true;
      _gameActive  = false;
      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      _score = score;
      _showResultPanel(score, charges);

      const actor = game.actors?.get(actorId);
      if (actor && _isOwnerOf(actor)) {
        const btn = document.getElementById("oni-ss-proceed");
        if (btn) {
          btn.style.display = "";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            if (game.user?.isGM) {
              this.resolveProceed(actorId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.SLEEP_SOUNDLY_PROCEED, { actorId });
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
      document.getElementById(OVL_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      _clearState();
    },
  };
})();
