// ============================================================================
// Camp Activity UI — Curse (Straw Doll Hex)
// Minigame: Horizontal timeline; indicator sweeps left→right over 15 s.
//           Player presses the matching key as the indicator crosses each label.
//           Hit VFX accumulate on a straw doll image; progressive damage states.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};

  // ── Constants ─────────────────────────────────────────────────────────────
  // GAME_MS is the single source of truth for duration.
  // MIN_GAP and XFRAC ranges are expressed as fractions of the timeline so they
  // automatically scale when GAME_MS changes — narrower gap → more labels fit
  // into the same sweep, giving a denser/faster feel without shortening the game.
  const OVL_ID       = "oni-curse-overlay";
  const GAME_MS      = 10_000;  // master duration: timer + indicator sweep
  const LABEL_COUNT  = 20;      // dense ritual nodes
  const MAX_SCORE    = LABEL_COUNT * 2;   // 40 pts total (2 per perfect, 1 per good)
  const XFRAC_MIN    = 0.08;
  const XFRAC_MAX    = 0.92;
  const MIN_GAP      = 0.025;  // tight gap → fits 20 labels comfortably
  const WIN_GOOD     = 0.033;   // ±xFrac for a Good hit
  const WIN_PERFECT  = 0.012;   // ±xFrac for a Perfect hit (subset of GOOD)
  const TICK_MS      = 16;      // ~60fps rAF throttle

  const DOLL_IMG     = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Beastiary/Polka.png";
  const HIT_URLS     = [
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Damage1.ogg",
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Damage2.ogg",
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Damage3.ogg",
  ];

  // AudioHelper sounds (low-latency; no pre-decode needed)
  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    MISS:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_exit.wav",
  };

  const VALID_KEYS = new Set([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "z", "Z", "x", "X", "c", "C", "a", "A", "s", "S", "d", "D",
  ]);

  const KEY_LABEL_MAP = {
    ArrowLeft:  "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    z: "Z", Z: "Z", x: "X", X: "X", c: "C", C: "C",
    a: "A", A: "A", s: "S", S: "S", d: "D", D: "D",
  };

  const LABEL_POOL = ["←", "→", "↑", "↓", "Z", "X", "C", "A", "S", "D"];

  const TIER_UI = {
    standard: {
      title: "The Curse Takes Hold",
      color: "#c0854a",
      desc:  "A wisp of dark intent coils around your foe. The next Villain you face will suffer a <strong>Basic Debuff</strong> when the conflict begins.",
    },
    good: {
      title: "Your Hex Bites Deep",
      color: "#9b2c8a",
      desc:  "The pins sink true. Your hatred flows through effigy and hex. The next Villain you face will suffer a <strong>Bad Debuff</strong> when the conflict begins.",
    },
    perfect: {
      title: "The Doll is Ruined!",
      color: "#cc1a1a",
      desc:  "Nothing remains of the doll but memory and malice. The next Villain you face will suffer a <strong>Very Bad Debuff</strong> when the conflict begins.",
    },
  };

  // ── Module-level state ─────────────────────────────────────────────────────
  let _actorId      = null;
  let _actorName    = null;
  let _isOwner      = false;
  let _labels       = [];     // { key, xFrac, state: "pending"|"hit"|"miss"|"expired" }
  let _indicatorFrac = 0;
  let _score        = 0;
  let _hitCount     = 0;
  let _resultShown  = false;
  let _stopping     = false;
  let _rafId        = null;
  let _gameStartMs  = 0;
  let _lastFrameMs  = 0;
  let _audioCtx     = null;
  let _hitBuffers   = [];
  let _captureKeyFn = null;    // stored for removeEventListener

  // ── Ownership helpers ──────────────────────────────────────────────────────
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _checkIsOwner(actorId) {
    const actor = game.actors?.get(actorId);
    if (!actor) return game.user?.isGM ?? false;
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────
  function _seededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s += 0x6d2b79f5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 0xFFFFFFFF;
    };
  }

  function _actorIdToSeed(actorId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < actorId.length; i++) {
      h ^= actorId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // ── Label generation ───────────────────────────────────────────────────────
  function _generateLabels(actorId) {
    const rng = _seededRng(_actorIdToSeed(actorId));
    const labels = [];
    let lastX = XFRAC_MIN - MIN_GAP;   // allow first label anywhere from XFRAC_MIN

    while (labels.length < LABEL_COUNT) {
      // Determine how many labels remain and spread space evenly
      const remaining  = LABEL_COUNT - labels.length;
      const spaceLeft  = XFRAC_MAX - (lastX + MIN_GAP);
      if (spaceLeft < 0) break;

      const minNext = lastX + MIN_GAP;
      const maxNext = Math.min(XFRAC_MAX, minNext + spaceLeft / remaining + 0.02);
      const xFrac   = minNext + rng() * (maxNext - minNext);

      const key = LABEL_POOL[Math.floor(rng() * LABEL_POOL.length)];
      labels.push({ key, xFrac: Math.min(xFrac, XFRAC_MAX), state: "pending" });
      lastX = xFrac;
    }
    return labels;
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  async function _initWebAudio() {
    try {
      _audioCtx  = new (window.AudioContext ?? window.webkitAudioContext)();
      _hitBuffers = await Promise.all(
        HIT_URLS.map(async url => {
          const ab  = await (await fetch(url)).arrayBuffer();
          return _audioCtx.decodeAudioData(ab);
        })
      );
    } catch (e) {
      console.warn("[CurseUI] Web Audio init failed:", e);
      _audioCtx  = null;
      _hitBuffers = [];
    }
  }

  function _playHitSound() {
    if (!_audioCtx || !_hitBuffers.length) return;
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const buf = _hitBuffers[Math.floor(Math.random() * _hitBuffers.length)];
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(_audioCtx.destination);
    src.start(0);
  }

  // ── CSS (injected once) ────────────────────────────────────────────────────
  function _injectCSS() {
    const ID = "oni-curse-style";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
/* ── Overlay ── */
#oni-curse-overlay {
  position: fixed; inset: 0; z-index: 10000;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(8, 2, 2, 0.68);
  font-family: "Signika", serif;
  overflow: hidden;
}

/* ── HUD ── */
.oni-curse-hud {
  position: absolute; top: 16px; left: 0; right: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 28px; pointer-events: none;
}
.oni-curse-timer {
  font-size: 2rem; font-weight: 700; color: #e8c87a;
  text-shadow: 0 0 12px #c8942a;
  min-width: 80px;
}
.oni-curse-title-hud {
  font-size: 1.1rem; letter-spacing: 4px; color: #9c4a4a;
  text-transform: uppercase;
}
.oni-curse-score-display {
  font-size: 1.5rem; font-weight: 700; color: #d4a0d4;
  text-shadow: 0 0 10px #7a1a7a;
  min-width: 80px; text-align: right;
}

/* ── Confirmation panel ── */
.oni-curse-confirm-panel {
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  background: rgba(20,6,6,0.92);
  border: 2px solid #6a1a1a;
  border-radius: 12px;
  padding: 36px 48px;
  box-shadow: 0 0 40px #3a0a0a, inset 0 0 20px #0a0000;
}
.oni-curse-confirm-title {
  font-size: 1.8rem; color: #e8c87a;
  text-shadow: 0 0 16px #c8840a;
  letter-spacing: 3px; margin: 0;
}
.oni-curse-confirm-desc {
  color: #c09070; font-size: 0.95rem; text-align: center; max-width: 340px;
  line-height: 1.5; margin: 0;
}
.oni-curse-begin-btn {
  margin-top: 8px;
  padding: 12px 36px;
  background: linear-gradient(135deg, #5a0000, #8a2020);
  border: 2px solid #c04040;
  border-radius: 8px; color: #ffd0a0; font-size: 1.1rem;
  cursor: pointer; letter-spacing: 2px;
  box-shadow: 0 0 18px #500000;
  transition: background 0.2s, box-shadow 0.2s;
}
.oni-curse-begin-btn:hover {
  background: linear-gradient(135deg, #7a1010, #a03030);
  box-shadow: 0 0 28px #800000;
}
.oni-curse-spectate-msg {
  color: #806060; font-size: 0.9rem; font-style: italic; margin: 0;
}

/* ── Countdown ── */
.oni-curse-countdown {
  font-size: 9rem; font-weight: 900; color: #e8c87a;
  text-shadow: 0 0 40px #c87a20, 0 0 80px #804000;
  animation: curse-cd-pulse 0.7s ease-out;
  user-select: none;
}
@keyframes curse-cd-pulse {
  0%   { transform: scale(1.6); opacity: 0; }
  40%  { opacity: 1; }
  100% { transform: scale(1);   opacity: 1; }
}

/* ── Arena ── */
.oni-curse-arena {
  display: flex; flex-direction: column; align-items: center;
  gap: 20px; width: 100%;
}

/* ── Doll wrap ── */
.oni-curse-doll-wrap {
  position: relative;
  width: 340px; height: 340px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 0 30px #3a0000, 0 0 60px #200000;
}
.oni-curse-doll-img {
  width: 100%; height: 100%;
  object-fit: cover;
  transition: filter 0.5s ease;
  filter: brightness(0.95) saturate(0.9);
}
/* Damage states */
.curse-d1 .oni-curse-doll-img { filter: brightness(0.92) saturate(1.1) hue-rotate(5deg); }
.curse-d2 .oni-curse-doll-img { filter: brightness(0.85) saturate(1.3) hue-rotate(12deg) sepia(0.2); }
.curse-d3 .oni-curse-doll-img { filter: brightness(0.75) saturate(1.5) hue-rotate(18deg) sepia(0.4); }
.curse-d4 .oni-curse-doll-img { filter: brightness(0.62) saturate(1.7) hue-rotate(22deg) sepia(0.6); animation: curse-doll-pulse 1.6s infinite; }
.curse-d5 .oni-curse-doll-img { filter: brightness(0.48) saturate(2.0) hue-rotate(28deg) sepia(0.8) contrast(1.3); animation: curse-doll-pulse 0.9s infinite; }
@keyframes curse-doll-pulse {
  0%,100% { filter: brightness(0.62) saturate(1.7) hue-rotate(22deg) sepia(0.6); }
  50%     { filter: brightness(0.72) saturate(1.9) hue-rotate(26deg) sepia(0.5); }
}

/* ── Hit layer (persistent marks) ── */
.oni-curse-hit-layer {
  position: absolute; inset: 0; pointer-events: none;
}
.oni-curse-pin {
  position: absolute;
  font-size: 1.2rem; color: #cc3030; font-weight: 900;
  text-shadow: 0 0 6px #ff0000, 0 0 12px #800000;
  transform: translate(-50%, -50%);
  animation: curse-pin-appear 0.25s ease-out;
  pointer-events: none;
}
@keyframes curse-pin-appear {
  from { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
  to   { transform: translate(-50%,-50%) scale(1);   opacity: 1; }
}

/* ── Impact splat ── */
.oni-curse-impact {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  pointer-events: none;
  animation: curse-impact-anim 0.32s ease-out forwards;
}
.oni-curse-impact.good    { width: 64px; height: 64px; background: radial-gradient(circle, #ff5500 0%, #cc2200 50%, transparent 70%); }
.oni-curse-impact.perfect { width: 96px; height: 96px; background: radial-gradient(circle, #ffe066 0%, #ffaa00 45%, #cc4400 65%, transparent 80%); }
@keyframes curse-impact-anim {
  0%   { transform: translate(-50%,-50%) scale(0.2); opacity: 1; }
  50%  { transform: translate(-50%,-50%) scale(1.1); opacity: 1; }
  100% { transform: translate(-50%,-50%) scale(1.4); opacity: 0; }
}

/* ── Particles ── */
.oni-curse-particle {
  position: absolute;
  width: 7px; height: 7px;
  border-radius: 50%;
  pointer-events: none;
  animation: curse-particle-fly 0.45s ease-out forwards;
}
@keyframes curse-particle-fly {
  0%   { opacity: 1; transform: translate(0,0) scale(1); }
  100% { opacity: 0; transform: var(--curse-p-end); scale: 0.3; }
}

/* ── Floating score text ── */
.oni-curse-float-text {
  position: absolute;
  font-size: 1.6rem; font-weight: 900;
  pointer-events: none;
  transform: translate(-50%, -50%);
  animation: curse-float-up 0.7s ease-out forwards;
  text-shadow: 0 0 8px currentColor;
}
@keyframes curse-float-up {
  0%   { opacity: 1; transform: translate(-50%,-50%) translateY(0); }
  100% { opacity: 0; transform: translate(-50%,-50%) translateY(-70px); }
}

/* ── Screen shake ── */
@keyframes curse-shake {
  0%,100% { transform: translateX(0); }
  20%     { transform: translateX(-4px); }
  40%     { transform: translateX(4px); }
  60%     { transform: translateX(-3px); }
  80%     { transform: translateX(3px); }
}
#oni-curse-overlay.curse-shake { animation: curse-shake 0.22s ease-out; }

/* ── Timeline ── */
.oni-curse-timeline-wrap {
  width: calc(100% - 60px); max-width: 860px;
  padding: 0 10px;
}
.oni-curse-timeline {
  position: relative;
  height: 72px;
  background: linear-gradient(to bottom, #2a0a0a, #1a0404);
  border: 2px solid #5a1a1a;
  border-radius: 6px;
  overflow: visible;
  box-shadow: 0 0 16px #3a0000, inset 0 2px 6px #000;
}

/* Indicator */
.oni-curse-indicator {
  position: absolute; top: -6px; bottom: -6px;
  width: 4px;
  background: linear-gradient(to bottom, transparent, #ffe066 30%, #fff 50%, #ffe066 70%, transparent);
  box-shadow: 0 0 14px 4px #ffe06688, 0 0 28px 8px #c8840a44;
  transform: translateX(-50%);
  pointer-events: none;
  border-radius: 2px;
  z-index: 10;
}

/* Label nodes */
.oni-curse-label {
  position: absolute; top: 50%;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  pointer-events: none;
  transition: opacity 0.2s;
}
.oni-curse-label.expired { opacity: 0; }
.oni-curse-label.hit     { opacity: 0; }
.oni-curse-label.miss    { opacity: 0.35; }
.oni-curse-label-key {
  font-size: 1.3rem; font-weight: 900; color: #e8c87a;
  text-shadow: 0 0 8px #c89020;
  line-height: 1;
}
.oni-curse-label-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #c07030; border: 2px solid #e8c87a;
  box-shadow: 0 0 8px #c07030;
}
/* Hit window hint (invisible—just conveyed by tightening animation) */
.oni-curse-label-win {
  position: absolute; top: 50%; height: 100%;
  transform: translateY(-50%);
  background: rgba(255,200,80,0.07);
  border-left: 1px solid rgba(255,200,80,0.15);
  border-right: 1px solid rgba(255,200,80,0.15);
  pointer-events: none;
}

/* ── Result panel ── */
.oni-curse-result-panel {
  display: flex; flex-direction: column; align-items: center; gap: 18px;
  background: rgba(12,4,4,0.95);
  border: 2px solid #6a1a1a;
  border-radius: 14px;
  padding: 40px 56px;
  box-shadow: 0 0 60px #3a0000, inset 0 0 30px #0a0000;
  max-width: 540px; text-align: center;
}
.oni-curse-result-title {
  font-size: 2rem; font-weight: 900; margin: 0;
  text-shadow: 0 0 20px currentColor;
}
.oni-curse-result-desc {
  font-size: 1rem; color: #c09070; line-height: 1.6; margin: 0;
}
.oni-curse-result-score {
  font-size: 0.85rem; color: #806060; margin: 0;
}
.oni-curse-proceed-btn {
  margin-top: 10px;
  padding: 12px 38px;
  background: linear-gradient(135deg, #3a0000, #6a2020);
  border: 2px solid #b04040; border-radius: 8px;
  color: #ffd0a0; font-size: 1rem; cursor: pointer;
  letter-spacing: 1px;
  transition: background 0.2s, box-shadow 0.2s;
  box-shadow: 0 0 14px #500000;
}
.oni-curse-proceed-btn:hover {
  background: linear-gradient(135deg, #5a0000, #8a3030);
  box-shadow: 0 0 24px #800000;
}
    `;
    document.head.appendChild(s);
  }

  // ── Overlay builder ────────────────────────────────────────────────────────
  function _buildOverlay() {
    const el = document.createElement("div");
    el.id = OVL_ID;
    el.innerHTML = `
      <!-- HUD -->
      <div class="oni-curse-hud">
        <span class="oni-curse-timer" id="oni-curse-timer">${(GAME_MS / 1000).toFixed(1)}</span>
        <span class="oni-curse-title-hud">☽ Curse Ritual ☾</span>
        <span class="oni-curse-score-display" id="oni-curse-score">0 / ${MAX_SCORE}</span>
      </div>

      <!-- Confirmation panel -->
      <div class="oni-curse-confirm-panel" id="oni-curse-confirm">
        <h2 class="oni-curse-confirm-title">☽ Curse Ritual ☾</h2>
        <p class="oni-curse-confirm-desc">
          Gather your dark intent. Drive pins into the effigy as the indicator sweeps across
          — press the matching key at the exact moment it crosses each mark.
        </p>
        <button class="oni-curse-begin-btn" id="oni-curse-begin" style="display:none;">Begin Ritual</button>
        <p class="oni-curse-spectate-msg" id="oni-curse-spectate-wait" style="display:none;">Watching ritual…</p>
      </div>

      <!-- Countdown -->
      <div class="oni-curse-countdown" id="oni-curse-countdown" style="display:none;"></div>

      <!-- Arena -->
      <div class="oni-curse-arena" id="oni-curse-arena" style="display:none;">
        <div class="oni-curse-doll-wrap" id="oni-curse-doll-wrap">
          <img class="oni-curse-doll-img" id="oni-curse-doll-img" src="${DOLL_IMG}" alt="Straw Doll" />
          <div class="oni-curse-hit-layer" id="oni-curse-hit-layer"></div>
        </div>
        <div class="oni-curse-timeline-wrap">
          <div class="oni-curse-timeline" id="oni-curse-timeline">
            <div class="oni-curse-indicator" id="oni-curse-indicator" style="left:0%;"></div>
          </div>
        </div>
      </div>

      <!-- Result -->
      <div class="oni-curse-result-panel" id="oni-curse-result" style="display:none;">
        <h2 class="oni-curse-result-title" id="oni-curse-result-title"></h2>
        <p class="oni-curse-result-desc" id="oni-curse-result-desc"></p>
        <p class="oni-curse-result-score" id="oni-curse-result-score"></p>
        <button class="oni-curse-proceed-btn" id="oni-curse-proceed" style="display:none;">Click to Proceed</button>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ── State reset ────────────────────────────────────────────────────────────
  function _clearState() {
    _stopping      = true;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_captureKeyFn) {
      document.removeEventListener("keydown", _captureKeyFn, { capture: true });
      _captureKeyFn = null;
    }
    _actorId       = null;
    _actorName     = null;
    _isOwner       = false;
    _labels        = [];
    _indicatorFrac = 0;
    _score         = 0;
    _hitCount      = 0;
    _resultShown   = false;
    _stopping      = false;
    _gameStartMs   = 0;
    _lastFrameMs   = 0;
    // Don't tear down audioCtx — keep decoded buffers across calls
  }

  // ── AudioHelper wrapper (matches other minigame pattern) ──────────────────
  function _playSound(src, volume = 0.7) {
    try { AudioHelper.play({ src, volume, autoplay: true, loop: false }, false); }
    catch(e) { /* silent */ }
  }

  // ── Countdown helper ───────────────────────────────────────────────────────
  function _runCountdown(callback) {
    const el = document.getElementById("oni-curse-countdown");
    if (!el) return callback();
    el.style.display = "block";
    const steps = ["3", "2", "1", "GO!"];
    let i = 0;
    function next() {
      if (i >= steps.length) {
        el.style.display = "none";
        return callback();
      }
      const step = steps[i++];
      el.textContent = step;
      // Re-trigger animation
      el.classList.remove("curse-cd-pulse-active");
      void el.offsetWidth;
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
      // Sound: tick for numbers, GO stinger for "GO!"
      if (step === "GO!") _playSound(SFX.GO, 0.9);
      else                _playSound(SFX.COUNTDOWN, 0.8);
      setTimeout(next, 750);
    }
    next();
  }

  // ── Label rendering ────────────────────────────────────────────────────────
  function _renderLabels() {
    const timeline = document.getElementById("oni-curse-timeline");
    if (!timeline) return;
    // Remove old label nodes (not the indicator)
    timeline.querySelectorAll(".oni-curse-label").forEach(n => n.remove());
    for (let i = 0; i < _labels.length; i++) {
      const lb = _labels[i];
      const wrap = document.createElement("div");
      wrap.className = "oni-curse-label";
      wrap.id        = `oni-curse-lbl-${i}`;
      wrap.style.left = `${lb.xFrac * 100}%`;
      wrap.innerHTML = `
        <span class="oni-curse-label-key">${lb.key}</span>
        <span class="oni-curse-label-dot"></span>
      `;
      timeline.appendChild(wrap);
    }
  }

  // ── Game loop ──────────────────────────────────────────────────────────────
  function _frame(ts) {
    if (_stopping) return;
    if (ts - _lastFrameMs < TICK_MS) {
      _rafId = requestAnimationFrame(_frame);
      return;
    }
    _lastFrameMs = ts;

    const elapsed = ts - _gameStartMs;
    _indicatorFrac = Math.min(elapsed / GAME_MS, 1.0);

    // Move indicator
    const indicator = document.getElementById("oni-curse-indicator");
    if (indicator) indicator.style.left = `${_indicatorFrac * 100}%`;

    // Update timer
    const remaining = Math.max(0, GAME_MS - elapsed) / 1000;
    const timerEl = document.getElementById("oni-curse-timer");
    if (timerEl) timerEl.textContent = remaining.toFixed(1);

    // Expire labels the indicator has passed
    for (let i = 0; i < _labels.length; i++) {
      const lb = _labels[i];
      if (lb.state !== "pending") continue;
      if (_indicatorFrac > lb.xFrac + WIN_GOOD + 0.008) {
        lb.state = "expired";
        const node = document.getElementById(`oni-curse-lbl-${i}`);
        if (node) node.classList.add("expired");
      }
    }

    // End game
    if (_indicatorFrac >= 1.0) {
      _endGame();
      return;
    }

    _rafId = requestAnimationFrame(_frame);
  }

  // ── Hit detection (owner keydown) ──────────────────────────────────────────
  function _startKeyCapture() {
    _captureKeyFn = (e) => {
      if (!VALID_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _handleKey(e.key);
    };
    document.addEventListener("keydown", _captureKeyFn, { capture: true });
  }

  function _handleKey(rawKey) {
    const pressed = KEY_LABEL_MAP[rawKey];
    if (!pressed) return;

    // Find first pending label within GOOD window
    let targetIdx = -1;
    let minDelta  = Infinity;
    for (let i = 0; i < _labels.length; i++) {
      const lb = _labels[i];
      if (lb.state !== "pending") continue;
      const delta = Math.abs(_indicatorFrac - lb.xFrac);
      if (delta <= WIN_GOOD && delta < minDelta) {
        minDelta  = delta;
        targetIdx = i;
      }
    }

    if (targetIdx === -1) return;   // no label in window — swallow key silently

    const lb      = _labels[targetIdx];
    const perfect = minDelta <= WIN_PERFECT;

    if (pressed === lb.key) {
      // ── Correct key ────────────────────────────────────────────────────
      lb.state = "hit";
      _score   += perfect ? 2 : 1;
      _hitCount++;

      const node = document.getElementById(`oni-curse-lbl-${targetIdx}`);
      if (node) node.classList.add("hit");

      _doHitFeedback(perfect);
      _updateDamageState();
      _updateScoreHUD();
      _playHitSound();

      // Sync spectators
      CAMP.Socket.emit(CAMP.MSG.CURSE_HIT, { actorId: _actorId, success: true, perfect });
    } else {
      // ── Wrong key ──────────────────────────────────────────────────────
      lb.state = "miss";
      const node = document.getElementById(`oni-curse-lbl-${targetIdx}`);
      if (node) node.classList.add("miss");

      _doMissFeedback();
      CAMP.Socket.emit(CAMP.MSG.CURSE_HIT, { actorId: _actorId, success: false, perfect: false });
    }
  }

  // ── Hit / Miss VFX ────────────────────────────────────────────────────────
  function _doHitFeedback(perfect) {
    const wrap = document.getElementById("oni-curse-doll-wrap");
    if (!wrap) return;

    const rx = 10 + Math.random() * 80;   // % within doll
    const ry = 10 + Math.random() * 80;

    // Impact splat
    const impact = document.createElement("div");
    impact.className = `oni-curse-impact ${perfect ? "perfect" : "good"}`;
    impact.style.left = `${rx}%`;
    impact.style.top  = `${ry}%`;
    wrap.appendChild(impact);
    impact.addEventListener("animationend", () => impact.remove());

    // Persistent pin mark
    const pin = document.createElement("div");
    pin.className  = "oni-curse-pin";
    pin.textContent = perfect ? "★" : "✕";
    pin.style.left  = `${rx}%`;
    pin.style.top   = `${ry}%`;
    pin.style.color = perfect ? "#ffe066" : "#cc3030";
    document.getElementById("oni-curse-hit-layer")?.appendChild(pin);

    // Floating score text
    const ftxt = document.createElement("div");
    ftxt.className   = "oni-curse-float-text";
    ftxt.textContent = perfect ? "+2" : "+1";
    ftxt.style.color = perfect ? "#ffe066" : "#ffffff";
    ftxt.style.left  = `${rx}%`;
    ftxt.style.top   = `${ry}%`;
    wrap.appendChild(ftxt);
    ftxt.addEventListener("animationend", () => ftxt.remove());

    // Particles
    _spawnParticles(wrap, rx, ry, perfect);

    // Screen shake
    const ovl = document.getElementById(OVL_ID);
    if (ovl) {
      ovl.classList.remove("curse-shake");
      void ovl.offsetWidth;
      ovl.classList.add("curse-shake");
      ovl.addEventListener("animationend", () => ovl.classList.remove("curse-shake"), { once: true });
    }
  }

  function _doMissFeedback() {
    _playSound(SFX.MISS, 0.75);
    // Brief red flash on the timeline
    const tl = document.getElementById("oni-curse-timeline");
    if (!tl) return;
    const old = tl.style.border;
    tl.style.border = "2px solid #ff2020";
    tl.style.boxShadow = "0 0 18px #ff000088";
    setTimeout(() => {
      tl.style.border    = "";
      tl.style.boxShadow = "";
    }, 180);
  }

  function _spawnParticles(parent, rx, ry, perfect) {
    const COUNT  = perfect ? 12 : 8;
    const COLORS = perfect
      ? ["#ffe066", "#ffaa00", "#ff8800", "#cc4400"]
      : ["#ff4422", "#cc2200", "#ff6600", "#881100"];
    for (let i = 0; i < COUNT; i++) {
      const angle  = (i / COUNT) * 360 + Math.random() * 30;
      const dist   = 50 + Math.random() * 50;
      const rad    = (angle * Math.PI) / 180;
      const dx     = Math.cos(rad) * dist;
      const dy     = Math.sin(rad) * dist;
      const p      = document.createElement("div");
      p.className  = "oni-curse-particle";
      p.style.left = `${rx}%`;
      p.style.top  = `${ry}%`;
      p.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
      p.style.setProperty("--curse-p-end", `translate(${dx}px, ${dy}px)`);
      p.style.animationDelay = `${Math.random() * 40}ms`;
      parent.appendChild(p);
      p.addEventListener("animationend", () => p.remove());
    }
  }

  // ── Doll damage state ──────────────────────────────────────────────────────
  function _updateDamageState() {
    const wrap = document.getElementById("oni-curse-doll-wrap");
    if (!wrap) return;
    wrap.classList.remove("curse-d1","curse-d2","curse-d3","curse-d4","curse-d5");
    if      (_hitCount >= 12) wrap.classList.add("curse-d5");
    else if (_hitCount >= 9)  wrap.classList.add("curse-d4");
    else if (_hitCount >= 6)  wrap.classList.add("curse-d3");
    else if (_hitCount >= 3)  wrap.classList.add("curse-d2");
    else if (_hitCount >= 1)  wrap.classList.add("curse-d1");
  }

  // ── HUD update ─────────────────────────────────────────────────────────────
  function _updateScoreHUD() {
    const el = document.getElementById("oni-curse-score");
    if (el) el.textContent = `${_score} / ${MAX_SCORE}`;
  }

  // ── Start game (after countdown) ──────────────────────────────────────────
  function _startGame() {
    const confirm  = document.getElementById("oni-curse-confirm");
    const arena    = document.getElementById("oni-curse-arena");
    if (confirm) confirm.style.display = "none";
    if (arena)   arena.style.display   = "flex";

    _labels = _generateLabels(_actorId);
    _renderLabels();

    if (_isOwner) {
      _startKeyCapture();
    }

    _gameStartMs  = performance.now();
    _lastFrameMs  = 0;
    _stopping     = false;
    _rafId        = requestAnimationFrame(_frame);
  }

  // ── End game ───────────────────────────────────────────────────────────────
  function _endGame() {
    _stopping = true;
    cancelAnimationFrame(_rafId);
    _rafId = null;

    if (_captureKeyFn) {
      document.removeEventListener("keydown", _captureKeyFn, { capture: true });
      _captureKeyFn = null;
    }

    if (_resultShown) return;
    _resultShown = true;

    if (_isOwner) {
      // Owner submits score → GM resolveScore
      CAMP.Socket.emit(CAMP.MSG.CURSE_RESULT, { actorId: _actorId, score: _score });
    }
    // Result reveal happens via applyResult() when GM broadcasts back
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  CAMP.CurseUI = {
    scoreResolvers:  {},
    proceedResolvers: {},

    // ── show() — called on all clients via CURSE_START ─────────────────────
    show(actorId, actorName) {
      _clearState();
      _injectCSS();
      document.getElementById(OVL_ID)?.remove();

      _actorId   = actorId;
      _actorName = actorName ?? "?";
      _isOwner   = _checkIsOwner(actorId);

      _buildOverlay();

      // Init audio fire-and-forget
      _initWebAudio();

      const confirm = document.getElementById("oni-curse-confirm");
      const beginBtn = document.getElementById("oni-curse-begin");
      const spectateMsg = document.getElementById("oni-curse-spectate-wait");

      if (_isOwner) {
        if (beginBtn) {
          beginBtn.style.display = "inline-block";
          beginBtn.addEventListener("click", () => {
            beginBtn.disabled = true;
            // Emit BEGIN so spectators transition
            CAMP.Socket.emit(CAMP.MSG.CURSE_BEGIN, { actorId: _actorId });
            // Owner starts countdown locally
            if (confirm) confirm.style.display = "none";
            _runCountdown(_startGame);
          });
        }
      } else {
        // Spectator
        if (beginBtn)    beginBtn.style.display    = "none";
        if (spectateMsg) spectateMsg.style.display = "block";
      }
    },

    // ── spectateBegin() — called on non-owner clients via CURSE_BEGIN ──────
    spectateBegin(actorId) {
      if (_isOwner) return;                              // owner sees it locally
      if (actorId !== _actorId) return;
      if (!document.getElementById(OVL_ID)) return;
      const confirm = document.getElementById("oni-curse-confirm");
      if (confirm) confirm.style.display = "none";
      _runCountdown(_startGame);
    },

    // ── onHit() — spectators receive per-key-press feedback ───────────────
    onHit(success, perfect) {
      if (_isOwner) return;                              // owner sees it locally
      if (!document.getElementById(OVL_ID)) return;
      if (success) {
        _hitCount++;
        _doHitFeedback(perfect);
        _updateDamageState();
      } else {
        _doMissFeedback();
      }
    },

    // ── resolveScore() — GM only: advances _waitForScore ──────────────────
    resolveScore(actorId, score) {
      const resolver = this.scoreResolvers?.[actorId];
      if (!resolver) return;
      delete this.scoreResolvers[actorId];
      resolver(score ?? 0);
    },

    // ── applyResult() — all clients: show result panel ────────────────────
    applyResult(actorId, score, tier) {
      if (actorId !== _actorId) return;
      if (!document.getElementById(OVL_ID)) return;

      // Hide arena
      const arena = document.getElementById("oni-curse-arena");
      if (arena) arena.style.display = "none";

      const panel = document.getElementById("oni-curse-result");
      const title = document.getElementById("oni-curse-result-title");
      const desc  = document.getElementById("oni-curse-result-desc");
      const scoreEl = document.getElementById("oni-curse-result-score");
      const proceedBtn = document.getElementById("oni-curse-proceed");

      const meta = TIER_UI[tier] ?? TIER_UI.standard;
      if (title)   { title.textContent = meta.title; title.style.color = meta.color; }
      if (desc)    desc.innerHTML = meta.desc;
      if (scoreEl) scoreEl.textContent = `Score: ${score} / ${MAX_SCORE}`;
      if (panel)   panel.style.display = "flex";

      // Only owner gets the proceed button
      if (_isOwner && proceedBtn) {
        proceedBtn.style.display = "inline-block";
        proceedBtn.addEventListener("click", () => {
          proceedBtn.disabled = true;
          if (game.user?.isGM) {
            CAMP.CurseUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.CURSE_PROCEED, { actorId });
          }
        });
      }
    },

    // ── resolveProceed() — GM only: advances _waitForProceed ──────────────
    resolveProceed(actorId) {
      const resolver = this.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete this.proceedResolvers[actorId];
      resolver();
    },

    // ── hide() — all clients via CURSE_DONE ───────────────────────────────
    hide() {
      _clearState();
      document.getElementById(OVL_ID)?.remove();
    },
  };
})();
