// ============================================================================
// Camp Activity — Midnight Oil UI
//
// Lamp-keeper timing minigame overlay.
//
// Stages:
//   1 — "Click to Begin" gate  (owner) / waiting panel  (spectators)
//   2 — Countdown 3→2→1→GO!
//   3 — 15-second minigame: keep the lamp burning, hold SPACE to relight
//   4 — Reveal: score + bonuses + "Click to Proceed" for owner
//
// Lamp state machine:
//   BRIGHT → (3.8 s) → FLICKERING → (2.2 s without relight) → EXTINGUISHED
//   FLICKERING/EXTINGUISHED + hold SPACE → RELIGHTING → (done) → BRIGHT
//
// Timing windows (relative to flicker start):
//   0 ms        – perfect window start  → yellow ring ("early")
//   800 ms      – perfect window open   → green ring ("PERFECT!")
//   1 400 ms    – perfect window closes → ring hides
//   2 200 ms    – lamp goes out         (if not relit)
//
// Relight durations:
//   perfect   450 ms   → +30 pts bonus
//   normal    750 ms   → no bonus
//   emergency 1 100 ms → no bonus (lamp was already out)
//
// Score:
//   Bright flame    +10 pts/s
//   Flickering      +5 pts/s
//   Final 3 s       ×1.5 multiplier on both rates
//   No-extinguish   +50 pts (end bonus, if lamp never went out)
//   Perfect relight +30 pts each
//
// Spectator sync:
//   MIDNIGHT_OIL_BEGIN → spectateBegin()    (countdown starts)
//   MIDNIGHT_OIL_STATE → onLampState()      (state changes + score)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][MidnightOilUI]";
  const OVL_ID    = "oni-camp-mo-ovl";
  const STYLE_ID  = "oni-camp-mo-style";

  const ACTIVITY_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Noah/StellarCasterTPassive2.png";
  const SFX_TICK_URL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/SFX_TINK.wav";

  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    SUCCESS:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
    FAIL:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    RESULT:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
  };

  // --- timing / scoring constants ---
  const GAME_DURATION_MS     = 15_000;
  const BRIGHT_DURATION_MS   =  3_800;
  const FLICKER_DURATION_MS  =  2_200;
  const PERFECT_START_MS     =    800;  // relative to flicker start
  const PERFECT_END_MS       =  1_400;
  const RELIGHT_PERFECT_MS   =    450;
  const RELIGHT_NORMAL_MS    =    750;
  const RELIGHT_EMERGENCY_MS =  1_100;
  const SCORE_BRIGHT         = 10 / 1000;   // pts per ms
  const SCORE_FLICKER        =  5 / 1000;
  const FINAL_FOCUS_START_MS = 12_000;      // last 3 s
  const FINAL_FOCUS_MULT     = 1.5;
  const BONUS_PERFECT        = 30;
  const BONUS_NO_EXTINGUISH  = 50;
  const GAUGE_CIRCUMFERENCE  = 175.9;       // 2π × r28

  // --- module-level state ---
  let _actorId              = null;
  let _isOwner              = false;
  let _lampState            = "bright";
  let _stateStartMs         = 0;
  let _preRelightState      = null;
  let _preRelightStateStart = 0;
  let _relightHeld          = false;
  let _relightType          = null;   // "perfect" | "normal" | "emergency"
  let _relightDurationMs    = 0;
  let _score                = 0;
  let _perfectRelights      = 0;
  let _lampEverExtinguished = false;
  let _gameStartMs          = null;
  let _lastFrameMs          = 0;
  let _rafId                = null;
  let _endTimer             = null;
  let _resultShown          = false;
  let _keyDownHandler       = null;
  let _keyUpHandler         = null;
  let _ringTimeout1         = null;
  let _ringTimeout2         = null;
  let _audioCtx             = null;
  let _tickBuffer           = null;

  // ---------------------------------------------------------------------------
  // State reset
  // ---------------------------------------------------------------------------
  function _clearState() {
    if (_rafId  !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
    clearTimeout(_ringTimeout1); _ringTimeout1 = null;
    clearTimeout(_ringTimeout2); _ringTimeout2 = null;
    _teardownInput();
    _actorId              = null;
    _isOwner              = false;
    _lampState            = "bright";
    _stateStartMs         = 0;
    _preRelightState      = null;
    _preRelightStateStart = 0;
    _relightHeld          = false;
    _relightType          = null;
    _relightDurationMs    = 0;
    _score                = 0;
    _perfectRelights      = 0;
    _lampEverExtinguished = false;
    _gameStartMs          = null;
    _lastFrameMs          = 0;
    _resultShown          = false;
    if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
    _tickBuffer = null;
  }

  function _teardownInput() {
    if (_keyDownHandler) {
      document.removeEventListener("keydown", _keyDownHandler, { capture: true });
      _keyDownHandler = null;
    }
    if (_keyUpHandler) {
      document.removeEventListener("keyup", _keyUpHandler, { capture: true });
      _keyUpHandler = null;
    }
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

  function _playSound(src, volume = 0.7) {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch {
      try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
    }
  }

  async function _initWebAudio() {
    try {
      _audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
      const buf = await (await fetch(SFX_TICK_URL)).arrayBuffer();
      _tickBuffer = await _audioCtx.decodeAudioData(buf);
    } catch { _audioCtx = null; _tickBuffer = null; }
  }

  function _playTick(volume = 0.55) {
    if (_audioCtx && _tickBuffer) {
      if (_audioCtx.state === "suspended") _audioCtx.resume();
      const src = _audioCtx.createBufferSource();
      src.buffer = _tickBuffer;
      const gain = _audioCtx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(_audioCtx.destination);
      src.start(0);
    } else {
      _playSound(SFX_TICK_URL, volume);
    }
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Overlay ── */
      #${OVL_ID} {
        position:fixed;inset:0;z-index:10000;
        display:flex;align-items:center;justify-content:center;
        background:rgba(4,2,10,0.97);
        animation:oni-mo-fadein 0.4s ease forwards;
        font-family:"Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-mo-out { animation:oni-mo-fadeout 0.35s ease forwards; }
      @keyframes oni-mo-fadein  { from{opacity:0}to{opacity:1} }
      @keyframes oni-mo-fadeout { from{opacity:1}to{opacity:0} }
      @keyframes oni-mo-slideup { from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)} }
      @keyframes oni-mo-pop     { from{transform:scale(1.5)}to{transform:scale(1)} }

      /* ── Panel (begin / countdown / result) ── */
      .oni-mo-panel {
        background:linear-gradient(160deg,#1c1020 0%,#0e0810 100%);
        border:2px solid rgba(200,140,60,.45);
        border-radius:14px;padding:28px 36px;
        box-shadow:0 0 0 1px rgba(200,140,60,.18),
                   0 0 48px rgba(180,100,20,.3),
                   0 20px 60px rgba(0,0,0,.92);
        display:flex;flex-direction:column;align-items:center;gap:16px;
        min-width:320px;
        animation:oni-mo-slideup 0.3s ease forwards;
      }
      .oni-mo-title {
        font-size:1.3rem;font-weight:800;color:#e8c080;
        letter-spacing:.08em;text-transform:uppercase;
        text-shadow:0 0 24px rgba(220,160,60,.65);
      }
      .oni-mo-desc {
        font-size:.83rem;color:#9a8060;text-align:center;
        max-width:260px;line-height:1.55;
      }
      .oni-mo-token-area {
        display:flex;flex-direction:column;align-items:center;gap:5px;
      }
      .oni-mo-token-area img {
        width:80px;height:80px;border:none;border-radius:0;
        object-fit:contain;
        filter:drop-shadow(0 0 14px rgba(220,140,40,.4));
      }
      .oni-mo-actor-name {
        font-size:.8rem;font-weight:700;color:#e8c080;
        text-shadow:0 1px 6px rgba(0,0,0,.9);
      }
      .oni-mo-waiting {
        font-size:.93rem;color:#c8a050;font-style:italic;
      }
      .oni-mo-begin-btn, .oni-mo-proceed-btn {
        margin-top:4px;padding:10px 32px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.95rem;cursor:pointer;letter-spacing:.04em;
        box-shadow:0 4px 14px rgba(0,0,0,.5);
        transition:filter .15s,transform .1s;
      }
      .oni-mo-begin-btn:hover,.oni-mo-proceed-btn:hover {
        filter:brightness(1.15);transform:translateY(-1px);
      }
      .oni-mo-begin-btn:active,.oni-mo-proceed-btn:active {
        transform:translateY(1px);filter:brightness(.95);
      }
      .oni-mo-proceed-btn:disabled { opacity:.5;cursor:not-allowed; }

      /* ── Countdown ── */
      .oni-mo-countdown-num {
        font-size:5rem;font-weight:900;color:#e8c080;line-height:1;
        text-shadow:0 0 40px rgba(220,160,60,.8);
        animation:oni-mo-pop .25s ease;
      }
      .oni-mo-go-text {
        font-size:3.2rem;font-weight:900;color:#80d870;
        text-shadow:0 0 30px rgba(100,220,80,.85);
        animation:oni-mo-pop .3s ease;
      }

      /* ── Game layout ── */
      .oni-mo-game {
        position:relative;width:520px;
        display:flex;flex-direction:column;align-items:center;
        border-radius:18px;overflow:hidden;
        background:rgba(6,3,12,.85);
        box-shadow:0 0 0 1px rgba(200,140,60,.15),
                   0 20px 60px rgba(0,0,0,.8);
      }

      /* Warm vignette radiating from lamp area */
      .oni-mo-vignette {
        position:absolute;inset:0;pointer-events:none;z-index:0;
        border-radius:18px;
        transition:background .5s ease;
      }

      /* HUD */
      .oni-mo-hud {
        position:relative;z-index:2;
        width:100%;display:flex;justify-content:space-between;align-items:center;
        padding:10px 18px 6px;
        color:#e8dfc0;font-size:.88rem;font-weight:700;
      }
      .oni-mo-hud-left  { display:flex;align-items:center;gap:6px;color:#c8a050; }
      .oni-mo-hud-right { color:#f4d488;font-size:1rem; }
      .oni-mo-timer-val { font-size:1.15rem;font-weight:900;color:#e8c080; }
      .oni-mo-timer-bar-wrap {
        position:relative;z-index:2;
        width:100%;height:5px;background:rgba(255,255,255,.08);overflow:hidden;
      }
      .oni-mo-timer-bar {
        height:100%;width:100%;
        background:linear-gradient(90deg,#e8c080,#b06020);
        transition:width .06s linear;
      }

      /* Scene */
      .oni-mo-scene {
        position:relative;z-index:1;
        width:100%;height:310px;
        display:flex;flex-direction:column;align-items:center;
        overflow:hidden;
      }

      /* Desk */
      .oni-mo-desk {
        position:absolute;bottom:0;left:0;right:0;height:58px;
        background:linear-gradient(180deg,#2c1a0a 0%,#180c04 100%);
        border-top:2px solid rgba(150,90,30,.4);
        box-shadow:0 -4px 20px rgba(0,0,0,.6);
      }

      /* Book (left of lamp) */
      .oni-mo-book {
        position:absolute;bottom:58px;
        left:calc(50% - 120px);
        width:70px;height:48px;
        background:linear-gradient(180deg,#4a2a12,#321808);
        border:1.5px solid rgba(150,90,30,.5);
        border-radius:2px 5px 5px 2px;
        box-shadow:2px 4px 12px rgba(0,0,0,.7);
      }
      .oni-mo-book::before {
        content:"";position:absolute;
        top:8px;left:10px;right:10px;height:1.5px;
        background:rgba(200,150,80,.3);
        box-shadow:0 8px 0 rgba(200,150,80,.2),0 16px 0 rgba(200,150,80,.15);
      }
      /* Tea cup (right of character) */
      .oni-mo-tea {
        position:absolute;bottom:58px;
        right:calc(50% - 130px);
        width:22px;height:18px;
        background:radial-gradient(circle at 40% 30%,#5a4030,#2a1808);
        border:1.5px solid rgba(100,70,30,.7);
        border-radius:3px 3px 6px 6px;
        box-shadow:0 3px 8px rgba(0,0,0,.6);
      }

      /* ── Lamp ── */
      .oni-mo-lamp-wrap {
        position:absolute;
        bottom:58px;
        left:calc(50% - 44px);
        width:48px;
        display:flex;flex-direction:column;align-items:center;
        cursor:pointer;user-select:none;
        z-index:4;
      }
      /* Flame area (glow + flame + smoke stacked) */
      .oni-mo-flame-area {
        position:relative;width:48px;height:56px;
        display:flex;flex-direction:column;align-items:center;
      }
      .oni-mo-glow-halo {
        position:absolute;top:8px;left:50%;
        transform:translateX(-50%);
        width:56px;height:56px;border-radius:50%;
        background:radial-gradient(circle,rgba(255,160,40,.55) 0%,transparent 70%);
        animation:oni-mo-glow-pulse 2s ease-in-out infinite;
        transition:width .4s,height .4s,opacity .5s;
      }
      @keyframes oni-mo-glow-pulse {
        0%,100%{transform:translateX(-50%) scale(1);opacity:.8;}
        50%    {transform:translateX(-50%) scale(1.28);opacity:.38;}
      }
      .oni-mo-flame {
        position:absolute;bottom:10px;left:50%;
        transform:translateX(-50%);
        width:18px;height:30px;
        background:radial-gradient(ellipse at 50% 85%,
          rgba(255,255,200,.9) 0%,#ffb830 30%,#ff5810 65%,transparent 100%);
        border-radius:50% 50% 30% 30%/60% 60% 40% 40%;
        filter:blur(.8px);
        transform-origin:bottom center;
        animation:oni-mo-flame-dance .22s ease-in-out infinite alternate;
        transition:height .35s,opacity .4s,filter .3s;
      }
      @keyframes oni-mo-flame-dance {
        0%  {transform:translateX(-50%) scaleX(1)    scaleY(1)    rotate(-2deg);}
        100%{transform:translateX(-50%) scaleX(.84)  scaleY(1.09) rotate(2deg);}
      }
      .oni-mo-smoke {
        position:absolute;bottom:44px;left:50%;
        transform:translateX(-50%);
        width:4px;height:22px;
        background:linear-gradient(180deg,rgba(160,150,175,.55) 0%,transparent 100%);
        border-radius:2px;opacity:0;pointer-events:none;
        animation:oni-mo-smoke-rise 1.6s ease-out infinite;
        transition:opacity .4s;
      }
      @keyframes oni-mo-smoke-rise {
        0%  {opacity:0;transform:translateX(-50%);}
        20% {opacity:.45;}
        80% {opacity:.18;transform:translateX(calc(-50% + 5px)) scaleX(1.4);}
        100%{opacity:0; transform:translateX(calc(-50% - 2px)) scaleX(.7);}
      }
      /* Lamp body */
      .oni-mo-lamp-body {
        width:26px;height:34px;
        background:linear-gradient(180deg,#8a6030 0%,#5a3810 60%,#3a2008 100%);
        border:1.5px solid rgba(180,120,40,.55);
        border-radius:4px 4px 8px 8px;
        box-shadow:0 4px 12px rgba(0,0,0,.7),
                   inset 0 1px 0 rgba(255,200,80,.18);
        position:relative;
      }
      .oni-mo-lamp-body::before {
        content:"";position:absolute;top:-6px;left:50%;transform:translateX(-50%);
        width:11px;height:7px;
        background:#6a4820;border-radius:3px 3px 0 0;
        border:1.5px solid rgba(180,120,40,.45);border-bottom:none;
      }
      .oni-mo-lamp-base {
        width:36px;height:7px;
        background:linear-gradient(180deg,#6a4820,#3a2008);
        border-radius:4px;
        border-top:1.5px solid rgba(180,120,40,.35);
      }

      /* ── State-dependent lamp visuals (data-lamp on .oni-mo-game) ── */
      .oni-mo-game[data-lamp="bright"] .oni-mo-flame {
        height:30px;opacity:1;filter:blur(.8px);animation-duration:.22s;
      }
      .oni-mo-game[data-lamp="bright"] .oni-mo-glow-halo {
        width:60px;height:60px;opacity:1;
      }
      .oni-mo-game[data-lamp="flickering"] .oni-mo-flame {
        height:16px;opacity:1;filter:blur(1.2px);animation-duration:.07s;
        background:radial-gradient(ellipse at 50% 85%,
          rgba(255,255,180,.8) 0%,#ffcc40 30%,#ff8020 65%,transparent 100%);
      }
      .oni-mo-game[data-lamp="flickering"] .oni-mo-glow-halo {
        width:32px;height:32px;
        animation:oni-mo-flicker-halo .1s ease-in-out infinite;
      }
      @keyframes oni-mo-flicker-halo {
        0%,100%{opacity:.45;}50%{opacity:.12;}
      }
      .oni-mo-game[data-lamp="relighting"] .oni-mo-flame {
        height:6px;opacity:.28;animation-duration:.18s;
      }
      .oni-mo-game[data-lamp="relighting"] .oni-mo-glow-halo {
        width:18px;height:18px;opacity:.1;
      }
      .oni-mo-game[data-lamp="extinguished"] .oni-mo-flame {
        height:4px;opacity:0;
      }
      .oni-mo-game[data-lamp="extinguished"] .oni-mo-glow-halo {
        width:10px;height:10px;opacity:0;
      }
      .oni-mo-game[data-lamp="extinguished"] .oni-mo-smoke {
        opacity:1;
      }

      /* ── Timing ring ── */
      .oni-mo-timing-ring {
        position:absolute;
        width:68px;height:68px;
        top:-12px;left:50%;transform:translateX(-50%);
        border:2.5px solid transparent;border-radius:50%;
        pointer-events:none;z-index:5;
        transition:opacity .18s,border-color .18s;
        opacity:0;
      }
      .oni-mo-timing-ring.early {
        border-color:rgba(244,212,136,.55);
        box-shadow:0 0 10px rgba(244,212,136,.3);
        opacity:1;
      }
      .oni-mo-timing-ring.perfect {
        border-color:rgba(80,255,110,.9);
        box-shadow:0 0 16px rgba(60,255,90,.6),inset 0 0 10px rgba(60,255,90,.18);
        animation:oni-mo-ring-pulse .28s ease-in-out infinite;
        opacity:1;
      }
      @keyframes oni-mo-ring-pulse {
        0%,100%{transform:translateX(-50%) scale(1);}
        50%    {transform:translateX(-50%) scale(1.1);}
      }

      /* ── Relight gauge (SVG circle) ── */
      .oni-mo-gauge-wrap {
        position:absolute;
        top:-10px;left:50%;transform:translateX(-50%);
        width:68px;height:68px;
        opacity:0;pointer-events:none;
        transition:opacity .15s;
      }
      .oni-mo-gauge-wrap.visible { opacity:1; }
      .oni-mo-gauge-bg   { fill:none;stroke:rgba(255,255,255,.1);stroke-width:3; }
      .oni-mo-gauge-fill {
        fill:none;stroke:#f4d488;stroke-width:3;stroke-linecap:round;
        stroke-dasharray:175.9;stroke-dashoffset:175.9;
        transform:rotate(-90deg);transform-origin:34px 34px;
        transition:stroke .2s;
      }
      .oni-mo-gauge-fill.perfect { stroke:#80ff90; }

      /* ── Character portrait ── */
      .oni-mo-char-wrap {
        position:absolute;
        bottom:58px;left:calc(50% + 18px);
        display:flex;flex-direction:column;align-items:center;
        pointer-events:none;z-index:3;
      }
      .oni-mo-char-img {
        width:96px;height:96px;object-fit:contain;
        filter:drop-shadow(0 0 22px rgba(255,140,40,.4));
        transition:filter .5s;
      }
      .oni-mo-game[data-lamp="extinguished"] .oni-mo-char-img {
        filter:drop-shadow(0 0 4px rgba(80,80,100,.2))
               brightness(.44) grayscale(.55);
      }
      .oni-mo-game[data-lamp="flickering"] .oni-mo-char-img {
        animation:oni-mo-char-flicker .14s ease-in-out infinite;
      }
      @keyframes oni-mo-char-flicker {
        0%,100%{filter:drop-shadow(0 0 14px rgba(255,140,40,.4));}
        50%    {filter:drop-shadow(0 0 3px rgba(255,140,40,.1));}
      }
      .oni-mo-char-name {
        font-size:.75rem;font-weight:700;
        color:rgba(230,185,120,.75);margin-top:3px;
        text-shadow:0 1px 6px rgba(0,0,0,.95);
      }

      /* ── Popup / score pop ── */
      .oni-mo-popup {
        position:absolute;top:22%;left:50%;
        transform:translateX(-50%);
        font-size:1.35rem;font-weight:900;
        pointer-events:none;z-index:20;white-space:nowrap;
        animation:oni-mo-popup-fly 1.15s ease-out forwards;
      }
      @keyframes oni-mo-popup-fly {
        0%  {opacity:0;transform:translateX(-50%) translateY(4px) scale(.75);}
        18% {opacity:1;transform:translateX(-50%) translateY(-10px) scale(1.06);}
        60% {opacity:1;transform:translateX(-50%) translateY(-18px) scale(1);}
        100%{opacity:0;transform:translateX(-50%) translateY(-32px) scale(.9);}
      }

      /* ── Key hint ── */
      .oni-mo-key-hint {
        position:relative;z-index:2;
        display:flex;align-items:center;gap:8px;
        padding:8px 0 12px;
        font-size:.78rem;color:#8a7860;font-style:italic;
      }
      .oni-mo-key {
        display:inline-flex;align-items:center;justify-content:center;
        padding:4px 14px;
        background:rgba(255,255,255,.07);
        border:2px solid rgba(255,255,255,.22);
        border-radius:5px;color:#f4d488;
        font-weight:700;font-size:.78rem;
        box-shadow:0 3px 0 rgba(0,0,0,.55);
        letter-spacing:.05em;
        transition:transform .08s,box-shadow .08s;
      }
      .oni-mo-key.pressed {
        transform:translateY(2px);box-shadow:0 1px 0 rgba(0,0,0,.55);
        border-color:rgba(200,168,75,.85);color:#fff;
      }

      /* ── Result ── */
      .oni-mo-result {
        display:flex;flex-direction:column;align-items:center;gap:10px;
        animation:oni-mo-slideup .4s ease forwards;text-align:center;
      }
      .oni-mo-result-title {
        font-size:2rem;font-weight:900;color:#e8c080;
        text-shadow:0 0 28px rgba(220,160,60,.7);letter-spacing:.06em;
      }
      .oni-mo-result-score {
        font-size:1.55rem;font-weight:800;color:#f4d488;
      }
      .oni-mo-result-bonus {
        font-size:.86rem;font-weight:700;color:#80d860;
      }
      .oni-mo-result-label {
        font-size:.85rem;color:#b09870;font-style:italic;max-width:270px;
      }
      .oni-mo-result-note {
        font-size:.8rem;color:#7a6040;
        padding:8px 12px;
        background:rgba(200,168,75,.1);
        border-left:3px solid rgba(200,168,75,.5);
        border-radius:0 4px 4px 0;
        text-align:left;line-height:1.55;max-width:280px;
      }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Vignette CSS update — called on every lamp state change
  // ---------------------------------------------------------------------------
  function _updateVignette(state) {
    const vig = document.getElementById("oni-mo-vignette");
    if (!vig) return;
    const configs = {
      bright:      { color: "rgba(255,140,40,.3)",  size: "300px 260px", y: "48%" },
      flickering:  { color: "rgba(255,160,60,.14)", size: "200px 175px", y: "50%" },
      relighting:  { color: "rgba(220,90,20,.06)",  size: "120px 100px", y: "52%" },
      extinguished:{ color: "rgba(40,30,60,.05)",   size: "80px 60px",   y: "54%" },
    };
    const c = configs[state] ?? configs.bright;
    vig.style.background =
      `radial-gradient(ellipse ${c.size} at 38% ${c.y},${c.color} 0%,rgba(180,80,20,.04) 42%,transparent 68%)`;
  }

  // ---------------------------------------------------------------------------
  // Lamp state transition
  // ---------------------------------------------------------------------------
  function _setLampState(state, startMs = null) {
    _lampState    = state;
    _stateStartMs = startMs ?? Date.now();

    const gameEl = document.getElementById("oni-mo-game");
    if (gameEl) gameEl.dataset.lamp = state;

    _updateVignette(state);

    // Timing rings — only for owner, only when flickering
    clearTimeout(_ringTimeout1); _ringTimeout1 = null;
    clearTimeout(_ringTimeout2); _ringTimeout2 = null;
    const ring = document.getElementById("oni-mo-timing-ring");
    if (ring) ring.className = "oni-mo-timing-ring";

    if (state === "flickering" && _isOwner) {
      if (ring) ring.className = "oni-mo-timing-ring early";

      const msUntilPerfect    = _stateStartMs + PERFECT_START_MS - Date.now();
      const msUntilPerfectEnd = _stateStartMs + PERFECT_END_MS   - Date.now();

      _ringTimeout1 = setTimeout(() => {
        const r = document.getElementById("oni-mo-timing-ring");
        if (r) r.className = "oni-mo-timing-ring perfect";
      }, Math.max(0, msUntilPerfect));

      _ringTimeout2 = setTimeout(() => {
        const r = document.getElementById("oni-mo-timing-ring");
        if (r) r.className = "oni-mo-timing-ring";
      }, Math.max(0, msUntilPerfectEnd));
    }

    if (state !== "relighting") {
      const gaugeWrap = document.getElementById("oni-mo-gauge-wrap");
      if (gaugeWrap) {
        gaugeWrap.classList.remove("visible");
        const fill = document.getElementById("oni-mo-gauge");
        if (fill) fill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Popup text
  // ---------------------------------------------------------------------------
  function _spawnPopup(text, color) {
    const scene = document.getElementById("oni-mo-scene");
    if (!scene) return;
    const el = document.createElement("div");
    el.className = "oni-mo-popup";
    el.style.color       = color;
    el.style.textShadow  = `0 0 18px ${color}`;
    el.textContent = text;
    scene.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  // ---------------------------------------------------------------------------
  // Relight: start (keydown / mousedown)
  // ---------------------------------------------------------------------------
  function _startRelighting() {
    if (_lampState !== "flickering" && _lampState !== "extinguished") return;
    if (_relightHeld) return;

    _preRelightState      = _lampState;
    _preRelightStateStart = _stateStartMs;
    _relightHeld          = true;

    if (_lampState === "extinguished") {
      _relightType       = "emergency";
      _relightDurationMs = RELIGHT_EMERGENCY_MS;
    } else {
      const flickerAge = Date.now() - _stateStartMs;
      if (flickerAge >= PERFECT_START_MS && flickerAge <= PERFECT_END_MS) {
        _relightType       = "perfect";
        _relightDurationMs = RELIGHT_PERFECT_MS;
      } else {
        _relightType       = "normal";
        _relightDurationMs = RELIGHT_NORMAL_MS;
      }
    }

    _setLampState("relighting");

    const gaugeWrap = document.getElementById("oni-mo-gauge-wrap");
    if (gaugeWrap) {
      gaugeWrap.classList.add("visible");
      const fill = document.getElementById("oni-mo-gauge");
      if (fill) fill.classList.toggle("perfect", _relightType === "perfect");
    }

    _playTick(0.5);

    if (_isOwner) {
      CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
        actorId: _actorId, lampState: "relighting",
        relightType: _relightType, score: Math.round(_score),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Relight: cancel (key/mouse released before complete)
  // ---------------------------------------------------------------------------
  function _cancelRelighting() {
    if (!_relightHeld || _lampState !== "relighting") return;
    _relightHeld = false;

    // Restore the previous state with original start time so the timer
    // that was already running continues correctly.
    if (_preRelightState === "flickering") {
      const flickerAge = Date.now() - _preRelightStateStart;
      if (flickerAge >= FLICKER_DURATION_MS) {
        // Flicker expired while they were holding — lamp goes out
        _lampEverExtinguished = true;
        _setLampState("extinguished");
        _spawnPopup("💨 Lamp Out!", "#ff7050");
        _playSound(SFX.FAIL, 0.6);
        if (_isOwner) {
          CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
            actorId: _actorId, lampState: "extinguished", score: Math.round(_score),
          });
        }
      } else {
        _setLampState("flickering", _preRelightStateStart);
        if (_isOwner) {
          CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
            actorId: _actorId, lampState: "flickering", score: Math.round(_score),
          });
        }
      }
    } else {
      _setLampState("extinguished", _preRelightStateStart);
    }

    _relightType = null;
  }

  // ---------------------------------------------------------------------------
  // Relight: complete (progress reached 100% while held)
  // ---------------------------------------------------------------------------
  function _completeRelighting() {
    _relightHeld = false;
    const wasType = _relightType;
    _relightType = null;

    if (wasType === "perfect") {
      _perfectRelights++;
      _score += BONUS_PERFECT;
      _spawnPopup("✨ Perfect Relight!", "#70ff90");
      _playSound(SFX.SUCCESS, 0.8);
    } else if (wasType === "normal") {
      _spawnPopup("Safe Relight", "#f4d488");
      _playTick(0.45);
    } else {
      _spawnPopup("Relit!", "#e8c080");
      _playTick(0.45);
    }

    // Gauge reset handled inside _setLampState
    _setLampState("bright");

    if (_isOwner) {
      CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
        actorId: _actorId, lampState: "bright",
        perfectRelights: _perfectRelights, score: Math.round(_score),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Input: keyboard + mouse on lamp
  // ---------------------------------------------------------------------------
  function _setupInput() {
    _keyDownHandler = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        const k = document.getElementById("oni-mo-key");
        if (k) k.classList.add("pressed");
        _startRelighting();
      }
    };
    _keyUpHandler = (e) => {
      if (e.code !== "Space") return;
      const k = document.getElementById("oni-mo-key");
      if (k) k.classList.remove("pressed");
      _cancelRelighting();
    };
    document.addEventListener("keydown", _keyDownHandler, { capture: true });
    document.addEventListener("keyup",   _keyUpHandler,   { capture: true });

    // Mouse hold on lamp
    const lamp = document.getElementById("oni-mo-lamp");
    if (lamp) {
      const onMouseUp = () => _cancelRelighting();
      lamp.addEventListener("mousedown", (e) => {
        e.preventDefault();
        _startRelighting();
        document.addEventListener("mouseup", onMouseUp, { once: true });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // rAF game loop
  // ---------------------------------------------------------------------------
  function _frame() {
    if (!document.getElementById(OVL_ID)) return;

    const now     = Date.now();
    const elapsed = now - _gameStartMs;
    const dt      = Math.min(now - _lastFrameMs, 50);
    _lastFrameMs  = now;

    if (_isOwner) {
      // ── State transitions ──────────────────────────────────────────────
      if (_lampState === "bright") {
        if (now - _stateStartMs >= BRIGHT_DURATION_MS) {
          _setLampState("flickering");
          CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
            actorId: _actorId, lampState: "flickering", score: Math.round(_score),
          });
        }
      } else if (_lampState === "flickering") {
        if (now - _stateStartMs >= FLICKER_DURATION_MS) {
          _lampEverExtinguished = true;
          _setLampState("extinguished");
          _spawnPopup("💨 Lamp Out!", "#ff7050");
          _playSound(SFX.FAIL, 0.6);
          CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_STATE, {
            actorId: _actorId, lampState: "extinguished", score: Math.round(_score),
          });
        }
      } else if (_lampState === "relighting") {
        const progress = Math.min(1, (now - _stateStartMs) / _relightDurationMs);
        const fill = document.getElementById("oni-mo-gauge");
        if (fill) fill.style.strokeDashoffset = String((1 - progress) * GAUGE_CIRCUMFERENCE);

        if (progress >= 1 && _relightHeld) {
          _completeRelighting();
        }
      }

      // ── Scoring ────────────────────────────────────────────────────────
      const inFinalFocus = elapsed >= FINAL_FOCUS_START_MS;
      const mult = inFinalFocus ? FINAL_FOCUS_MULT : 1.0;
      if (_lampState === "bright") {
        _score += SCORE_BRIGHT * dt * mult;
      } else if (_lampState === "flickering") {
        _score += SCORE_FLICKER * dt * mult;
      }

      // ── HUD ────────────────────────────────────────────────────────────
      const timeEl = document.getElementById("oni-mo-time");
      if (timeEl) timeEl.textContent = Math.max(0, (GAME_DURATION_MS - elapsed) / 1000).toFixed(1);
      const scoreEl = document.getElementById("oni-mo-score");
      if (scoreEl) scoreEl.textContent = Math.floor(_score);
      const barEl = document.getElementById("oni-mo-timer-bar");
      if (barEl) barEl.style.width = `${Math.max(0, (1 - elapsed / GAME_DURATION_MS) * 100)}%`;

    } else {
      // Spectator: just drive the timer display (state comes from sockets)
      const timeEl = document.getElementById("oni-mo-time");
      if (timeEl) timeEl.textContent = Math.max(0, (GAME_DURATION_MS - elapsed) / 1000).toFixed(1);
      const barEl = document.getElementById("oni-mo-timer-bar");
      if (barEl) barEl.style.width = `${Math.max(0, (1 - elapsed / GAME_DURATION_MS) * 100)}%`;
    }

    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // End game — submit score to GM
  // ---------------------------------------------------------------------------
  function _endGame(actorId) {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _teardownInput();
    clearTimeout(_ringTimeout1); _ringTimeout1 = null;
    clearTimeout(_ringTimeout2); _ringTimeout2 = null;

    if (!_lampEverExtinguished) _score += BONUS_NO_EXTINGUISH;

    const finalScore = Math.round(_score);
    console.debug(TAG, `Game over — score ${finalScore}, perfectRelights ${_perfectRelights}, extinguished ${_lampEverExtinguished}`);

    const actor = game.actors?.get(actorId);
    if (actor && _isActorOwner(actor)) {
      const data = {
        score:               finalScore,
        perfectRelights:     _perfectRelights,
        lampEverExtinguished: _lampEverExtinguished,
      };
      if (game.user?.isGM) {
        CAMP.MidnightOilUI.resolveScore(actorId, data);
      } else {
        CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_RESULT, { actorId, ...data });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------------------------
  function _runCountdown(actorId, actor, count, onDone) {
    const el = document.getElementById("oni-mo-count");
    if (el) {
      el.textContent = count;
      el.className   = "oni-mo-countdown-num";
      void el.offsetWidth;
    }
    _playSound(SFX.COUNTDOWN, 0.8);
    if (count > 1) {
      setTimeout(() => _runCountdown(actorId, actor, count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el2 = document.getElementById("oni-mo-count");
        if (el2) { el2.className = "oni-mo-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  function _showCountdownPanel(actorId, actor, tokenImg, displayName) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;
    ovl.innerHTML = `
      <div class="oni-mo-panel">
        <div class="oni-mo-title">🕯️ Midnight Oil</div>
        <div class="oni-mo-token-area">
          <img src="${tokenImg}" alt="${displayName}">
          <div class="oni-mo-actor-name">${displayName}</div>
        </div>
        <div class="oni-mo-countdown-num" id="oni-mo-count">3</div>
      </div>
    `;
    _runCountdown(actorId, actor, 3, () => _startMinigame(actorId, actor));
  }

  // ---------------------------------------------------------------------------
  // Build game HTML
  // ---------------------------------------------------------------------------
  function _buildGameHTML(tokenImg, displayName) {
    const hint = _isOwner
      ? `<div class="oni-mo-key-hint">
           <span class="oni-mo-key" id="oni-mo-key">SPACE</span>
           hold to relight the lamp
         </div>`
      : `<div class="oni-mo-key-hint">${displayName} is studying late at night…</div>`;

    return `
      <div class="oni-mo-game" data-lamp="bright" id="oni-mo-game">
        <div class="oni-mo-vignette" id="oni-mo-vignette"></div>

        <div class="oni-mo-hud">
          <div class="oni-mo-hud-left">
            🕯️&nbsp;Time:&nbsp;<span class="oni-mo-timer-val" id="oni-mo-time">15.0</span>s
          </div>
          <div class="oni-mo-hud-right">Score:&nbsp;<span id="oni-mo-score">0</span></div>
        </div>
        <div class="oni-mo-timer-bar-wrap">
          <div class="oni-mo-timer-bar" id="oni-mo-timer-bar"></div>
        </div>

        <div class="oni-mo-scene" id="oni-mo-scene">
          <div class="oni-mo-desk"></div>
          <div class="oni-mo-book"></div>
          <div class="oni-mo-tea"></div>

          <!-- Lamp (interactive) -->
          <div class="oni-mo-lamp-wrap" id="oni-mo-lamp">
            <div class="oni-mo-flame-area">
              <div class="oni-mo-glow-halo"></div>
              <div class="oni-mo-flame"></div>
              <div class="oni-mo-smoke"></div>
            </div>
            <div class="oni-mo-timing-ring" id="oni-mo-timing-ring"></div>
            <div class="oni-mo-gauge-wrap" id="oni-mo-gauge-wrap">
              <svg viewBox="0 0 68 68" width="68" height="68" style="transform:rotate(-90deg)">
                <circle class="oni-mo-gauge-bg"   cx="34" cy="34" r="28"/>
                <circle class="oni-mo-gauge-fill"  cx="34" cy="34" r="28" id="oni-mo-gauge"/>
              </svg>
            </div>
            <div class="oni-mo-lamp-body"></div>
            <div class="oni-mo-lamp-base"></div>
          </div>

          <!-- Character -->
          <div class="oni-mo-char-wrap">
            <img class="oni-mo-char-img" src="${tokenImg}" alt="${displayName}">
            <div class="oni-mo-char-name">${displayName}</div>
          </div>
        </div>

        ${hint}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Start minigame phase (after countdown)
  // ---------------------------------------------------------------------------
  function _startMinigame(actorId, actor) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;

    const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
    const displayName = actor?.name ?? "?";

    ovl.innerHTML = _buildGameHTML(tokenImg, displayName);

    _gameStartMs  = Date.now();
    _lastFrameMs  = _gameStartMs;
    _setLampState("bright", _gameStartMs);
    _score        = 0;

    _updateVignette("bright");

    if (_isOwner) {
      _setupInput();
      _endTimer = setTimeout(() => _endGame(actorId), GAME_DURATION_MS + 150);
    } else {
      _endTimer = setTimeout(() => {
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      }, GAME_DURATION_MS + 500);
    }

    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.MidnightOilUI = {
    scoreResolvers:   {},
    proceedResolvers: {},

    // Stage 1 — show overlay (begin gate or spectator waiting)
    show(actorId, actorName) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor       = game.actors?.get(actorId);
      _isOwner          = actor ? _isActorOwner(actor) : false;
      const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
      const displayName = actor?.name ?? actorName ?? "?";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      if (_isOwner) {
        ovl.innerHTML = `
          <div class="oni-mo-panel">
            <div class="oni-mo-title">🕯️ Midnight Oil</div>
            <div class="oni-mo-token-area">
              <img src="${tokenImg}" alt="${displayName}">
              <div class="oni-mo-actor-name">${displayName}</div>
            </div>
            <p class="oni-mo-desc">
              Keep the lamp burning while you study.<br>
              Hold <strong>SPACE</strong> to relight it when it flickers.<br>
              Time your relight perfectly for a bonus!
            </p>
            <button class="oni-mo-begin-btn" id="oni-mo-begin">Click to Begin</button>
          </div>
        `;
        document.body.appendChild(ovl);
        document.getElementById("oni-mo-begin").addEventListener("click", () => {
          CAMP.Socket.broadcast(CAMP.MSG.MIDNIGHT_OIL_BEGIN, { actorId });
          _showCountdownPanel(actorId, actor, tokenImg, displayName);
        }, { once: true });
      } else {
        const ownerUid  = actor ? _getOwnerUserId(actor) : null;
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? displayName) : displayName;
        ovl.innerHTML = `
          <div class="oni-mo-panel">
            <div class="oni-mo-title">🕯️ Midnight Oil</div>
            <div class="oni-mo-token-area">
              <img src="${tokenImg}" alt="${displayName}">
              <div class="oni-mo-actor-name">${displayName}</div>
            </div>
            <div class="oni-mo-waiting">Waiting for ${ownerName} to begin…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }

      _initWebAudio();
    },

    // Spectator transitions from waiting → countdown
    spectateBegin(actorId) {
      if (_isOwner) return;
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      const actor       = game.actors?.get(actorId);
      const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
      const displayName = actor?.name ?? "?";
      _showCountdownPanel(actorId, actor, tokenImg, displayName);
    },

    // Spectator lamp-state sync
    onLampState(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      const { lampState, score } = payload ?? {};
      if (lampState && lampState !== _lampState) {
        _setLampState(lampState);
      }
      if (score != null) {
        const el = document.getElementById("oni-mo-score");
        if (el) el.textContent = score;
      }
    },

    // Stage 4 — result reveal (all clients)
    applyResult(actorId, score, perfectRelights, lampEverExtinguished) {
      if (_resultShown) return;
      _resultShown = true;

      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      _teardownInput();

      _playSound(SFX.RESULT, 0.8);

      const bonusLines = [];
      if (perfectRelights > 0)
        bonusLines.push(`✨ Perfect Relight ×${perfectRelights}: +${perfectRelights * BONUS_PERFECT} pts`);
      if (!lampEverExtinguished)
        bonusLines.push(`🔥 Lamp Never Went Out: +${BONUS_NO_EXTINGUISH} pts`);

      const label =
        score >= 250 ? "Brilliant focus. The flame never wavered." :
        score >= 200 ? "A long, productive night of study."        :
        score >= 140 ? "Good focus. The lamp served you well."     :
        score >= 80  ? "Some good progress made tonight."          :
                       "The night was a struggle.";

      const actor      = game.actors?.get(actorId);
      const isOwnerNow = actor ? _isActorOwner(actor) : false;

      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;

      ovl.innerHTML = `
        <div class="oni-mo-panel">
          <div class="oni-mo-result">
            <div class="oni-mo-result-title">Study Complete</div>
            <div class="oni-mo-result-score">${score} pts</div>
            ${bonusLines.map(l => `<div class="oni-mo-result-bonus">${l}</div>`).join("")}
            <div class="oni-mo-result-label">${label}</div>
            <div class="oni-mo-result-note">
              📚 <strong>3 Project Progress Points</strong> earned.<br>
              GM will apply these to a project of your choice.
            </div>
            ${isOwnerNow ? `<button class="oni-mo-proceed-btn" id="oni-mo-proceed">Click to Proceed</button>` : ""}
          </div>
        </div>
      `;

      if (isOwnerNow) {
        document.getElementById("oni-mo-proceed")?.addEventListener("click", () => {
          if (game.user?.isGM) {
            CAMP.MidnightOilUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.MIDNIGHT_OIL_PROCEED, { actorId });
          }
        }, { once: true });
      }
    },

    resolveScore(actorId, data) {
      const resolver = this.scoreResolvers?.[actorId];
      if (!resolver) return;
      delete this.scoreResolvers[actorId];
      resolver(data);
    },

    resolveProceed(actorId) {
      const resolver = this.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete this.proceedResolvers[actorId];
      resolver();
    },

    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-mo-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Midnight Oil UI loaded.");
})();
