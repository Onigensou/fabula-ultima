// ============================================================================
// Camp Activity — Daydream UI
//
// Counting Sheep rhythm minigame overlay.
//
// Stages:
//   1 — Countdown (3 → 2 → 1 → GO!)
//   2 — Minigame  (10 s: sheep jump over fence, owner presses SPACE to score)
//   3 — Reveal    (score + reduction % + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts DAYDREAM_START  → all call show()        (GM direct too)
//   [10 s game runs on all clients; owner collects score]
//   Owner emits DAYDREAM_RESULT { score } → GM
//   GM broadcasts DAYDREAM_RESULT { score, reduction } → all call applyResult()
//   Owner clicks Proceed → emits DAYDREAM_PROCEED → GM
//   GM broadcasts DAYDREAM_DONE → all hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][DaydreamUI]";
  const OVL_ID    = "oni-camp-dd-ovl";
  const STYLE_ID  = "oni-camp-dd-style";

  const SFX = {
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    SUCCESS:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success_4.wav",
    FAIL:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    RESULT:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Up3.ogg",
  };

  // ---------------------------------------------------------------------------
  // Sheep schedule — deterministic, same on all clients
  // t = ms after game start when sheep appears
  //
  // Types:
  //   normal        — standard arc jump (700ms), valid press window
  //   group         — two sheep at once (700ms), one press scores
  //   approach      — walks to fence then jumps (1300ms), valid press window at apex
  //   fake          — starts arc but retreats (950ms), trap — slightly slower than normal
  //   approach_stop — walks slowly toward fence then turns back (1700ms), trap
  //   super_slow    — very slow creep then jumps (1800ms), valid — fights muscle memory
  //
  // Phase 1 (0–5s):  normals only — player learns the baseline rhythm
  // Phase 2 (5–15s): all patterns introduced gradually
  //
  // Score: 6 normal + 2 approach + 1 super_slow + 1 group = MAX_SCORE 10
  // Traps: 1 approach_stop + 2 fake
  // ---------------------------------------------------------------------------
  // Schedule must be sorted ascending by t.
  // approach hit window ends at t+871ms; spacebar active until GAME_DURATION_MS+150=15150ms.
  // → approach must start by t≤14279ms; group/normal must start by t≤14723ms.
  const SCHEDULE = [
    // ── Phase 1: normals only ────────────────────────────────────────────────
    { t:  700, type: "normal",        id:  0 },  // valid #1
    { t: 2000, type: "normal",        id:  1 },  // valid #2
    { t: 3500, type: "normal",        id:  2 },  // valid #3
    { t: 4400, type: "normal",        id:  3 },  // valid #4  — clears 5100ms

    // ── Phase 2: introduce new patterns ─────────────────────────────────────
    { t: 5000, type: "approach_stop", id:  4 },  // trap #1   — slow walker, never jumps (clears 6700ms)
    { t: 7000, type: "approach",      id:  5 },  // valid #5  — walk 600ms then jump; hit 7859–8027ms ✓
    { t: 8500, type: "super_slow",    id:  6 },  // valid #6  — walk 1100ms then jump; hit 9859–10027ms ✓
    { t:10400, type: "fake",          id:  7 },  // trap #2   — slow arc abort (clears 11350ms)
    { t:11500, type: "approach",      id:  8 },  // valid #7  — hit 12359–12527ms ✓ (clears ~12800ms)
    { t:12900, type: "normal",        id:  9 },  // valid #8  — hit 13159–13327ms ✓
    { t:13700, type: "group",         id: 10 },  // valid #9  — hit 13959–14127ms ✓
    { t:14300, type: "normal",        id: 11 },  // valid #10 — hit 14559–14727ms ✓
    { t:14600, type: "fake",          id: 12 },  // trap #3   — slow arc abort (starts as group exits)
  ];

  const MAX_SCORE        = 10;
  const GAME_DURATION_MS = 15_000;
  const JUMP_MS          = 700;        // normal/group jump animation duration
  const FAKE_MS          = 950;        // fake — visibly slower arc than normal
  const APPROACH_MS      = 1300;       // approach-jump: walk → pause → arc over fence
  const APPROACH_STOP_MS = 1700;       // approach-stop: slow walk → bob → retreat
  const SUPER_SLOW_MS    = 1800;       // super-slow: long creep across ground, then jumps

  // Walk phase durations (used in both physics and hit windows)
  const APPROACH_WALK_MS   = 600;
  const SUPER_SLOW_WALK_MS = 1100;
  // Stage geometry (must match CSS)
  const STAGE_W = 560;

  // Hit windows — ms after sheep spawn when SPACE scores.
  // Physics apex is always at WALK_MS + JUMP_MS/2; window is ±84ms around that.
  const _JW = Math.round(JUMP_MS * 0.37);  // jump-window start offset: ~259ms
  const _JE = Math.round(JUMP_MS * 0.61);  // jump-window end   offset: ~427ms
  const HIT_WINDOWS = {
    normal:     { start: _JW,                       end: _JE                       },  // 259–427ms
    group:      { start: _JW,                       end: _JE                       },  // same as normal
    approach:   { start: APPROACH_WALK_MS   + _JW,  end: APPROACH_WALK_MS   + _JE  },  // 859–1027ms
    super_slow: { start: SUPER_SLOW_WALK_MS + _JW,  end: SUPER_SLOW_WALK_MS + _JE  },  // 1359–1527ms
  };

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId       = null;
  let _isOwner       = false;
  let _score         = 0;
  let _gameStartMs   = null;
  let _scheduleIdx   = 0;
  let _activeEvents  = [];   // { id, type, startMs, hit }
  let _physicsObjs   = [];   // JS-driven sheep: { el, el2?, phase, x, y, vx, vy, g, ... }
  let _lastFrameMs   = 0;
  let _rafId         = null;
  let _spaceHandler  = null;
  let _endTimer      = null;
  let _resultShown   = false;

  function _clearState() {
    if (_rafId !== null)   { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null){ clearTimeout(_endTimer); _endTimer = null; }
    if (_spaceHandler) {
      document.removeEventListener("keydown", _spaceHandler, { capture: true });
      _spaceHandler = null;
    }
    for (const o of _physicsObjs) { o.el?.remove(); o.el2?.remove(); }
    _actorId      = null;
    _isOwner      = false;
    _score        = 0;
    _gameStartMs  = null;
    _scheduleIdx  = 0;
    _activeEvents = [];
    _physicsObjs  = [];
    _lastFrameMs  = 0;
    _resultShown  = false;
  }

  // ---------------------------------------------------------------------------
  // Physics helpers (normal / group / approach / super_slow)
  // Gravity is derived so the jump arc reaches the correct apex in JUMP_MS/2 ms.
  // ---------------------------------------------------------------------------
  function _makePhysicsObj(type, now) {
    const xStart = STAGE_W * 0.04;
    const xEnd   = STAGE_W * 0.95;

    function _jumpParams(apexPx, xFrom, xTo) {
      const tApex = JUMP_MS / 2;                  // 350ms to apex
      const g     = 2 * apexPx / (tApex * tApex); // px/ms²
      const vy0   = tApex * g;                     // px/ms upward
      const vx    = (xTo - xFrom) / JUMP_MS;       // constant horizontal
      return { g, vy0, vx };
    }

    switch (type) {
      case "normal":
      case "group": {
        const { g, vy0, vx } = _jumpParams(92, xStart, xEnd);
        return { phase: "jump", x: xStart, y: 3, vx, vy: vy0, g, groundY: 3, spawnMs: now };
      }
      case "approach": {
        const xWalk = STAGE_W * 0.44;
        const { g, vy0, vx: jumpVx } = _jumpParams(88, xWalk, xEnd);
        return {
          phase: "walk", x: xStart, y: 3, vx: (xWalk - xStart) / APPROACH_WALK_MS,
          vy: 0, g, vy0, jumpVx, groundY: 3, walkMs: APPROACH_WALK_MS, spawnMs: now,
        };
      }
      case "super_slow": {
        const xWalk = STAGE_W * 0.32;
        const { g, vy0, vx: jumpVx } = _jumpParams(88, xWalk, xEnd);
        return {
          phase: "walk", x: xStart, y: 3, vx: (xWalk - xStart) / SUPER_SLOW_WALK_MS,
          vy: 0, g, vy0, jumpVx, groundY: 3, walkMs: SUPER_SLOW_WALK_MS, spawnMs: now,
        };
      }
    }
    return null;
  }

  function _stepPhysics(obj, now, dt) {
    if (obj.phase === "walk") {
      obj.x += obj.vx * dt;
      if (now - obj.spawnMs >= obj.walkMs) {
        obj.phase = "jump";
        obj.vy    = obj.vy0;
        obj.vx    = obj.jumpVx;
      }
    } else if (obj.phase === "jump") {
      obj.vy -= obj.g * dt;
      obj.y  += obj.vy * dt;
      obj.x  += obj.vx * dt;
      if (obj.y <= obj.groundY) {
        obj.y     = obj.groundY;
        obj.phase = "done";
        setTimeout(() => { obj.el?.remove(); obj.el2?.remove(); }, 80);
      }
    }
    if (obj.phase !== "done") {
      const left = `${(obj.x / STAGE_W * 100).toFixed(2)}%`;
      obj.el.style.left   = left;
      obj.el.style.bottom = `${obj.y.toFixed(1)}px`;
      if (obj.el2) {
        obj.el2.style.left   = left;
        obj.el2.style.bottom = `${(obj.y + 15).toFixed(1)}px`; // track-B offset
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _playSound(src, volume = 0.7) {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch {
      try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
    }
  }

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

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position:fixed;inset:0;z-index:10000;
        display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.82);
        animation:oni-dd-fadein 0.35s ease forwards;
        font-family:"Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-dd-out { animation:oni-dd-fadeout 0.3s ease forwards; }
      @keyframes oni-dd-fadein  { from{opacity:0}to{opacity:1} }
      @keyframes oni-dd-fadeout { from{opacity:1}to{opacity:0} }
      @keyframes oni-dd-slideup { from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)} }
      @keyframes oni-dd-pop     { from{transform:scale(1.55)}to{transform:scale(1)} }

      /* Panel (shared wrapper) */
      .oni-dd-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;
        padding:24px 32px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:14px;
        min-width:360px;
        animation:oni-dd-slideup 0.3s ease forwards;
      }
      .oni-dd-title {
        font-size:1.35rem;font-weight:800;color:#6b3a1f;
        letter-spacing:.05em;text-transform:uppercase;
      }

      /* Countdown */
      .oni-dd-countdown-num {
        font-size:5rem;font-weight:900;color:#c8a84b;line-height:1;
        text-shadow:0 0 30px rgba(200,168,75,.7);
        animation:oni-dd-pop 0.25s ease;
      }
      .oni-dd-go-text {
        font-size:3.5rem;font-weight:900;color:#3a8a35;
        text-shadow:0 0 28px rgba(58,138,53,.8);
        animation:oni-dd-pop 0.3s ease;
      }

      /* Actor area (token + thought bubble) */
      .oni-dd-actor-area {
        display:flex;flex-direction:column;align-items:center;gap:0;
        position:relative;
      }
      .oni-dd-bubble {
        background:#fff;border:2px solid #bbb;border-radius:50%;
        width:72px;height:56px;
        display:flex;align-items:center;justify-content:center;
        font-size:1.7rem;position:relative;
        box-shadow:3px 3px 0 #ccc;
      }
      .oni-dd-bubble::after {
        content:"";position:absolute;bottom:-16px;left:18px;
        width:12px;height:12px;background:#fff;border-radius:50%;
        border:2px solid #bbb;box-shadow:3px 3px 0 #ccc;
      }
      .oni-dd-bubble::before {
        content:"";position:absolute;bottom:-9px;left:12px;
        width:7px;height:7px;background:#fff;border-radius:50%;
        border:2px solid #bbb;
      }
      .oni-dd-token { margin-top:12px; }
      .oni-dd-token img {
        width:80px;height:80px;border:none;border-radius:0;
        background:transparent;object-fit:contain;
        filter:drop-shadow(0 0 10px rgba(200,168,75,.4));
      }
      .oni-dd-actor-name {
        font-size:.82rem;font-weight:700;color:#f6ebd3;
        text-shadow:0 1px 4px rgba(0,0,0,.8);
        margin-top:4px;
      }

      /* Game layout (owner view) */
      .oni-dd-game {
        display:flex;flex-direction:column;align-items:center;gap:8px;
        width:560px;
      }
      .oni-dd-info-row {
        display:flex;justify-content:space-between;align-items:center;
        width:100%;color:#e8dfc0;font-size:.88rem;font-weight:700;
        text-shadow:0 1px 4px rgba(0,0,0,.8);
      }
      .oni-dd-score-display { color:#f4d488;font-size:1rem; }
      .oni-dd-timer-wrap {
        width:100%;height:8px;background:rgba(255,255,255,.15);
        border-radius:4px;overflow:hidden;
      }
      .oni-dd-timer-bar {
        height:100%;width:100%;background:#c8a84b;
        border-radius:4px;transition:width 0.05s linear;
      }

      /* Stage (fence + sheep) */
      .oni-dd-stage {
        position:relative;width:560px;height:130px;
        overflow:hidden;background:transparent;
      }
      .oni-dd-ground {
        position:absolute;bottom:0;left:0;right:0;height:3px;
        background:#8d5f38;border-radius:2px;
      }
      .oni-dd-fence {
        position:absolute;bottom:0;left:50%;transform:translateX(-50%);
        display:flex;flex-direction:column;align-items:center;
        width:64px;
      }
      .oni-dd-fence-post {
        width:10px;height:48px;background:#8d5f38;border-radius:3px;
      }
      .oni-dd-fence-rail {
        width:64px;height:6px;background:#a87649;border-radius:2px;
        margin-top:-38px;
      }
      .oni-dd-fence-rail2 {
        width:64px;height:6px;background:#a87649;border-radius:2px;
        margin-top:8px;
      }

      /* Sheep */
      .oni-dd-sheep {
        position:absolute;font-size:2rem;bottom:3px;
        will-change:transform,left,bottom;
      }
      @keyframes oni-dd-jump {
        0%   { left:4%;  bottom:3px; }
        30%  { left:38%; bottom:72px; }
        50%  { left:54%; bottom:92px; }
        70%  { left:68%; bottom:52px; }
        100% { left:95%; bottom:3px; }
      }
      @keyframes oni-dd-jump-b {
        0%   { left:4%;  bottom:18px; }
        30%  { left:36%; bottom:88px; }
        50%  { left:52%; bottom:108px; }
        70%  { left:67%; bottom:66px; }
        100% { left:95%; bottom:18px; }
      }
      @keyframes oni-dd-fake {
        0%   { left:4%;  bottom:3px; }
        35%  { left:26%; bottom:54px; }
        55%  { left:20%; bottom:28px; }
        80%  { left:10%; bottom:6px; }
        100% { left:4%;  bottom:3px; }
      }
      /* approach-jump: walks to fence at medium pace, crouches, then arcs high over */
      @keyframes oni-dd-approach-jump {
        0%   { left:4%;  bottom:3px; }
        38%  { left:41%; bottom:4px; }
        46%  { left:44%; bottom:1px; }
        62%  { left:54%; bottom:90px; }
        78%  { left:68%; bottom:50px; }
        100% { left:95%; bottom:3px; }
      }
      /* approach-stop: walks slowly toward fence, bobs once (never high), retreats */
      @keyframes oni-dd-approach-stop {
        0%   { left:4%;  bottom:3px; }
        52%  { left:36%; bottom:4px; }
        60%  { left:34%; bottom:13px; }
        68%  { left:31%; bottom:3px; }
        82%  { left:18%; bottom:3px; }
        100% { left:4%;  bottom:3px; }
      }
      /* super-slow: very long creep across ground then finally launches — apex at 48% */
      @keyframes oni-dd-super-slow {
        0%   { left:4%;  bottom:3px; }
        15%  { left:12%; bottom:3px; }
        38%  { left:32%; bottom:3px; }
        48%  { left:54%; bottom:88px; }
        66%  { left:68%; bottom:44px; }
        100% { left:95%; bottom:3px; }
      }

      /* Spacebar key indicator */
      .oni-dd-key-hint {
        display:flex;align-items:center;gap:8px;
        font-size:.8rem;color:#c8c0a8;font-style:italic;
      }
      .oni-dd-key {
        display:inline-flex;align-items:center;justify-content:center;
        padding:4px 16px;
        background:rgba(255,255,255,.1);
        border:2px solid rgba(255,255,255,.3);
        border-radius:5px;
        color:#f4d488;font-weight:700;font-size:.8rem;
        box-shadow:0 3px 0 rgba(0,0,0,.5);
        letter-spacing:.05em;transition:transform .08s,box-shadow .08s;
      }
      .oni-dd-key.pressed {
        transform:translateY(2px);box-shadow:0 1px 0 rgba(0,0,0,.5);
        border-color:rgba(200,168,75,.9);color:#fff;
      }

      /* Spectator waiting text */
      .oni-dd-waiting {
        font-size:.95rem;color:#c8a84b;font-style:italic;margin-top:4px;
      }

      /* Result */
      .oni-dd-result {
        display:flex;flex-direction:column;align-items:center;gap:10px;
        animation:oni-dd-slideup .4s ease forwards;
      }
      .oni-dd-finished {
        font-size:2.6rem;font-weight:900;color:#f4d488;
        text-shadow:0 0 24px rgba(244,212,136,.8);letter-spacing:.06em;
      }
      .oni-dd-reduction-txt {
        font-size:1.5rem;font-weight:800;color:#fff;
        text-shadow:0 0 16px rgba(255,255,255,.4);
      }
      .oni-dd-score-sub { font-size:.85rem;color:#c8c0a8;font-style:italic; }
      .oni-dd-proceed-btn {
        margin-top:6px;padding:8px 28px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.9rem;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4);transition:filter .15s;
      }
      .oni-dd-proceed-btn:hover { filter:brightness(1.15); }
      .oni-dd-proceed-btn:disabled { opacity:.5;cursor:not-allowed; }

      /* Click to Begin button */
      .oni-dd-begin-btn {
        margin-top:4px;padding:10px 34px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:1rem;cursor:pointer;letter-spacing:.04em;
        box-shadow:0 4px 14px rgba(0,0,0,.4);transition:filter .15s,transform .1s;
      }
      .oni-dd-begin-btn:hover { filter:brightness(1.15);transform:translateY(-1px); }
      .oni-dd-begin-btn:active{ transform:translateY(1px);filter:brightness(.95); }

      /* Hit-window zone indicator (pulsing ring at apex) */
      .oni-dd-hit-zone {
        position:absolute;width:44px;height:44px;
        border:2.5px solid rgba(244,212,136,.85);border-radius:50%;
        pointer-events:none;z-index:5;
        box-shadow:0 0 12px rgba(244,212,136,.55),inset 0 0 8px rgba(244,212,136,.25);
        animation:oni-dd-hit-pulse 0.38s ease-in-out infinite;
      }
      @keyframes oni-dd-hit-pulse {
        0%,100%{ transform:scale(1);   opacity:.85; }
        50%    { transform:scale(1.16);opacity:.45; }
      }

      /* Success burst particles */
      .oni-dd-particle {
        position:absolute;width:7px;height:7px;border-radius:50%;
        pointer-events:none;z-index:20;
        animation:oni-dd-particle-fly 0.42s ease-out forwards;
      }
      @keyframes oni-dd-particle-fly {
        0%  { transform:translate(0,0) scale(1);   opacity:1; }
        100%{ transform:translate(var(--px),var(--py)) scale(0); opacity:0; }
      }
      /* Floating score pop */
      .oni-dd-score-pop {
        position:absolute;font-size:1.1rem;font-weight:900;
        color:#f4d488;text-shadow:0 0 8px rgba(244,212,136,.9);
        pointer-events:none;z-index:20;white-space:nowrap;
        animation:oni-dd-float-up 0.55s ease-out forwards;
      }
      @keyframes oni-dd-float-up {
        0%  { transform:translate(-50%,0);     opacity:1; }
        60% { transform:translate(-50%,-26px); opacity:1; }
        100%{ transform:translate(-50%,-40px); opacity:0; }
      }

      /* Fail flash */
      .oni-dd-fail-flash {
        position:absolute;inset:0;border-radius:6px;
        background:rgba(220,50,50,.28);pointer-events:none;z-index:20;
        animation:oni-dd-fail-fade 0.34s ease forwards;
      }
      @keyframes oni-dd-fail-fade { 0%{opacity:1}100%{opacity:0} }
      /* Floating fail mark */
      .oni-dd-fail-x {
        position:absolute;font-size:1.4rem;font-weight:900;
        color:#ff6464;text-shadow:0 0 8px rgba(255,80,80,.8);
        pointer-events:none;z-index:20;white-space:nowrap;
        animation:oni-dd-float-up 0.48s ease-out forwards;
      }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Sheep spawner
  // Physics types (normal/group/approach/super_slow) — JS-driven projectile arc.
  // Trap types (fake/approach_stop) — CSS animation only.
  // ---------------------------------------------------------------------------
  function _spawnSheep(type, id) {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;

    // ── CSS-only trap types ──────────────────────────────────────────────────
    if (type === "fake" || type === "approach_stop") {
      const dur  = type === "fake" ? FAKE_MS : APPROACH_STOP_MS;
      const anim = type === "fake" ? "oni-dd-fake" : "oni-dd-approach-stop";
      const el   = document.createElement("div");
      el.className       = "oni-dd-sheep";
      el.dataset.sheepId = id;
      el.textContent     = "🐑";
      el.style.cssText   = `animation:${anim} ${dur}ms ease-in-out forwards;`;
      stage.appendChild(el);
      setTimeout(() => el.remove(), dur + 200);
      return;
    }

    // ── Physics-driven types ─────────────────────────────────────────────────
    const now = Date.now();
    const obj = _makePhysicsObj(type, now);
    if (!obj) return;

    const el = document.createElement("div");
    el.className       = "oni-dd-sheep";
    el.dataset.sheepId = id;
    el.textContent     = "🐑";
    el.style.left      = `${(obj.x / STAGE_W * 100).toFixed(2)}%`;
    el.style.bottom    = `${obj.y}px`;
    stage.appendChild(el);
    obj.el = el;

    if (type === "group") {
      const el2 = document.createElement("div");
      el2.className   = "oni-dd-sheep";
      el2.textContent = "🐑";
      el2.style.left   = el.style.left;
      el2.style.bottom = `${obj.y + 15}px`;  // track-B starts 15px above track-A
      stage.appendChild(el2);
      obj.el2 = el2;
    }

    _physicsObjs.push(obj);

    // Hit-zone indicator (owner only, for all scoreable physics types)
    if (_isOwner) {
      const win = HIT_WINDOWS[type === "group" ? "normal" : type];
      if (win) {
        // Zone positioned at apex: apex_bottom - 22px (half 44px zone height)
        // normal/group apex ~92px → zone bottom 70px
        // approach/super_slow apex ~88px → zone bottom 66px
        const zoneBottom = (type === "approach" || type === "super_slow") ? "66px" : "70px";
        // For group, also show zone on track-B apex (~107px → bottom 85px)
        if (type === "group") {
          setTimeout(() => _spawnHitZone("calc(54% - 22px)", "85px", win.end - win.start), win.start);
        }
        setTimeout(() => _spawnHitZone("calc(54% - 22px)", zoneBottom, win.end - win.start), win.start);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hit-zone indicator — pulsing ring at apex position during press window
  // ---------------------------------------------------------------------------
  function _spawnHitZone(left, bottom, duration) {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;
    const z = document.createElement("div");
    z.className    = "oni-dd-hit-zone";
    z.style.left   = left;
    z.style.bottom = bottom;
    stage.appendChild(z);
    setTimeout(() => z.remove(), duration + 60);
  }

  // ---------------------------------------------------------------------------
  // Success visual — burst particles + floating "+1" at apex
  // ---------------------------------------------------------------------------
  function _flashSuccess() {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;
    const sw = stage.offsetWidth;
    const sh = stage.offsetHeight;
    const cx = sw * 0.54;          // apex x (54% of stage width)
    const cy = sh - 92;            // apex distance from top (stage height − bottom:92)

    const COLORS = ["#f4d488", "#ffe566", "#c8a84b", "#ffffff", "#ffcc44"];
    for (let i = 0; i < 10; i++) {
      const p   = document.createElement("div");
      p.className = "oni-dd-particle";
      const ang = (i / 10) * Math.PI * 2;
      const r   = 28 + Math.random() * 22;
      p.style.left       = `${cx - 3}px`;
      p.style.bottom     = `${sh - cy - 3}px`;   // convert top-offset to bottom css
      p.style.background = COLORS[i % COLORS.length];
      p.style.setProperty("--px", `${Math.cos(ang) * r}px`);
      p.style.setProperty("--py", `${-Math.sin(ang) * r}px`); // negative = upward in CSS
      stage.appendChild(p);
      setTimeout(() => p.remove(), 450);
    }

    // Floating "+1" text drifts upward
    const txt = document.createElement("div");
    txt.className   = "oni-dd-score-pop";
    txt.textContent = "+1";
    txt.style.left   = `${cx}px`;
    txt.style.bottom = `${sh - cy + 12}px`;
    stage.appendChild(txt);
    setTimeout(() => txt.remove(), 580);
  }

  // ---------------------------------------------------------------------------
  // Fail visual — red overlay flash + floating "✗"
  // ---------------------------------------------------------------------------
  function _flashFail() {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;
    const sw = stage.offsetWidth;
    const sh = stage.offsetHeight;
    const cx = sw * 0.54;
    const cy = sh - 92;

    const fl = document.createElement("div");
    fl.className = "oni-dd-fail-flash";
    stage.appendChild(fl);
    setTimeout(() => fl.remove(), 360);

    const txt = document.createElement("div");
    txt.className   = "oni-dd-fail-x";
    txt.textContent = "✗";
    txt.style.left   = `${cx}px`;
    txt.style.bottom = `${sh - cy + 12}px`;
    stage.appendChild(txt);
    setTimeout(() => txt.remove(), 500);
  }

  // ---------------------------------------------------------------------------
  // rAF game loop (runs on owner AND spectators)
  // ---------------------------------------------------------------------------
  function _startGameLoop(isOwnerLoop) {
    _scheduleIdx  = 0;
    _activeEvents = [];
    _physicsObjs  = [];
    _lastFrameMs  = Date.now();

    function _frame() {
      if (!document.getElementById(OVL_ID)) return; // overlay removed — stop

      const now     = Date.now();
      const dt      = Math.min(now - _lastFrameMs, 50); // cap at 50ms to survive tab switches
      _lastFrameMs  = now;
      const elapsed = now - _gameStartMs;

      // Step JS physics for all active physics sheep
      for (const obj of _physicsObjs) _stepPhysics(obj, now, dt);
      _physicsObjs = _physicsObjs.filter(o => o.phase !== "done");

      // Fire scheduled sheep events
      while (_scheduleIdx < SCHEDULE.length && SCHEDULE[_scheduleIdx].t <= elapsed) {
        const ev = SCHEDULE[_scheduleIdx];
        _activeEvents.push({ id: ev.id, type: ev.type, startMs: now, hit: false });
        _spawnSheep(ev.type, ev.id);
        _scheduleIdx++;
      }

      // Expire events past the longest possible window + buffer
      const expireMs = Math.max(JUMP_MS, FAKE_MS, APPROACH_MS, APPROACH_STOP_MS, SUPER_SLOW_MS) + 200;
      _activeEvents = _activeEvents.filter(ev => (now - ev.startMs) <= expireMs);

      // Update timer bar (owner view only)
      if (isOwnerLoop) {
        const bar = document.getElementById("oni-dd-timer-bar");
        if (bar) {
          const pct = Math.max(0, 1 - elapsed / GAME_DURATION_MS);
          bar.style.width = `${pct * 100}%`;
        }
      }

      _rafId = requestAnimationFrame(_frame);
    }

    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // Spacebar handler (owner only)
  // ---------------------------------------------------------------------------
  function _setupSpacebar(actorId) {
    _spaceHandler = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();

      const now = Date.now();

      // Flash key visual
      const keyEl = document.getElementById("oni-dd-key");
      if (keyEl) {
        keyEl.classList.add("pressed");
        setTimeout(() => keyEl.classList.remove("pressed"), 120);
      }

      const trapTypes = new Set(["fake", "approach_stop"]);

      let scored  = false;
      let trapped = false;

      for (const ev of _activeEvents) {
        if (ev.hit) continue;
        const age = now - ev.startMs;

        const win = HIT_WINDOWS[ev.type === "group" ? "normal" : ev.type];
        if (win) {
          // Scoreable type — check hit window
          if (age >= win.start && age <= win.end) {
            ev.hit = true;
            _score++;
            _playSound(SFX.SUCCESS, 0.8);
            _flashSuccess();
            scored = true;
            const scoreEl = document.getElementById("oni-dd-score-val");
            if (scoreEl) scoreEl.textContent = _score;
            break;
          }
        } else if (trapTypes.has(ev.type)) {
          // Trap type — any press while event is active counts as a mistake
          const maxDur = ev.type === "fake" ? FAKE_MS : APPROACH_STOP_MS;
          if (age >= 0 && age <= maxDur) {
            trapped = true;
          }
        }
      }

      if (!scored && trapped) {
        _playSound(SFX.FAIL, 0.7);
        _flashFail();
      }

      // Broadcast hit/miss so spectators see the flash too
      if (scored) {
        CAMP.Socket.emit(CAMP.MSG.DAYDREAM_HIT, { actorId: _actorId, success: true });
      } else if (!scored && trapped) {
        CAMP.Socket.emit(CAMP.MSG.DAYDREAM_HIT, { actorId: _actorId, success: false });
      }
    };

    document.addEventListener("keydown", _spaceHandler, { capture: true });
  }

  // ---------------------------------------------------------------------------
  // Game end — submit score and remove spacebar handler
  // ---------------------------------------------------------------------------
  function _endGame(actorId) {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_spaceHandler) {
      document.removeEventListener("keydown", _spaceHandler, { capture: true });
      _spaceHandler = null;
    }

    const actor = game.actors?.get(actorId);
    if (actor && _isActorOwner(actor)) {
      if (game.user?.isGM) {
        CAMP.DaydreamUI.resolveScore(actorId, _score);
      } else {
        CAMP.Socket.emit(CAMP.MSG.DAYDREAM_RESULT, { actorId, score: _score });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Start minigame panel (called after countdown finishes)
  // ---------------------------------------------------------------------------
  function _startMinigame(actorId, actor) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;

    const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
    const displayName = actor?.name ?? "?";
    const ownerName   = (() => {
      if (_isOwner) return null;
      const uid = actor ? _getOwnerUserId(actor) : null;
      return uid ? (game.users?.get(uid)?.name ?? displayName) : displayName;
    })();

    if (_isOwner) {
      ovl.innerHTML = `
        <div class="oni-dd-game">
          <div class="oni-dd-actor-area">
            <div class="oni-dd-bubble">🐑</div>
            <div class="oni-dd-token"><img src="${tokenImg}" alt="${displayName}"></div>
            <div class="oni-dd-actor-name">${displayName}</div>
          </div>
          <div class="oni-dd-info-row">
            <div class="oni-dd-score-display">Score: <span id="oni-dd-score-val">0</span> / ${MAX_SCORE}</div>
            <div>Press SPACE when sheep jump!</div>
          </div>
          <div class="oni-dd-timer-wrap">
            <div class="oni-dd-timer-bar" id="oni-dd-timer-bar"></div>
          </div>
          <div class="oni-dd-stage" id="oni-dd-stage">
            <div class="oni-dd-ground"></div>
            <div class="oni-dd-fence">
              <div class="oni-dd-fence-post"></div>
              <div class="oni-dd-fence-rail"></div>
              <div class="oni-dd-fence-rail2"></div>
            </div>
          </div>
          <div class="oni-dd-key-hint">
            <span id="oni-dd-key" class="oni-dd-key">SPACE</span>
            press at the apex of each jump!
          </div>
        </div>
      `;

      _gameStartMs = Date.now();
      _setupSpacebar(actorId);
      _startGameLoop(true);
      _endTimer = setTimeout(() => _endGame(actorId), GAME_DURATION_MS + 150);
    } else {
      // Spectator view — sheep animation plays but no interaction
      ovl.innerHTML = `
        <div class="oni-dd-game">
          <div class="oni-dd-actor-area">
            <div class="oni-dd-bubble">🐑</div>
            <div class="oni-dd-token"><img src="${tokenImg}" alt="${displayName}"></div>
            <div class="oni-dd-actor-name">${displayName}</div>
          </div>
          <div class="oni-dd-waiting">${ownerName ?? displayName} is counting sheep…</div>
          <div class="oni-dd-stage" id="oni-dd-stage">
            <div class="oni-dd-ground"></div>
            <div class="oni-dd-fence">
              <div class="oni-dd-fence-post"></div>
              <div class="oni-dd-fence-rail"></div>
              <div class="oni-dd-fence-rail2"></div>
            </div>
          </div>
        </div>
      `;

      _gameStartMs = Date.now();
      _startGameLoop(false);
      // Auto-stop spectator loop after game duration
      _endTimer = setTimeout(() => {
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      }, GAME_DURATION_MS + 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Transition from "Click to Begin" panel → countdown panel
  // Called when the owner clicks the begin button
  // ---------------------------------------------------------------------------
  function _showCountdownPanel(actorId, actor, tokenImg, displayName) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;
    ovl.innerHTML = `
      <div class="oni-dd-panel">
        <div class="oni-dd-title">💭 Daydream</div>
        <div class="oni-dd-actor-area">
          <div class="oni-dd-bubble">🐑</div>
          <div class="oni-dd-token"><img src="${tokenImg}" alt="${displayName}"></div>
          <div class="oni-dd-actor-name">${displayName}</div>
        </div>
        <div class="oni-dd-countdown-num" id="oni-dd-count">3</div>
      </div>
    `;
    _runCountdown(actorId, actor, 3, () => _startMinigame(actorId, actor));
  }

  // ---------------------------------------------------------------------------
  // Countdown helper
  // ---------------------------------------------------------------------------
  function _runCountdown(actorId, actor, count, onDone) {
    const el = document.getElementById("oni-dd-count");
    if (el) {
      el.textContent = count;
      el.className = "oni-dd-countdown-num";
      // Re-trigger pop animation
      void el.offsetWidth;
    }
    _playSound(SFX.COUNTDOWN, 0.8);

    if (count > 1) {
      setTimeout(() => _runCountdown(actorId, actor, count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el2 = document.getElementById("oni-dd-count");
        if (el2) { el2.className = "oni-dd-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.DaydreamUI = {
    scoreResolvers:   {},
    proceedResolvers: {},

    // --------------------------------------------------------------------
    // Stage 1 — "Click to Begin" gate → countdown → minigame
    // Owner sees the begin button; spectators see a waiting message.
    // --------------------------------------------------------------------
    show(actorId, actorName) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor = game.actors?.get(actorId);
      _isOwner = actor ? _isActorOwner(actor) : false;

      const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
      const displayName = actor?.name ?? actorName ?? "?";

      const ovl = document.createElement("div");
      ovl.id = OVL_ID;

      const actorArea = `
        <div class="oni-dd-actor-area">
          <div class="oni-dd-bubble">🐑</div>
          <div class="oni-dd-token"><img src="${tokenImg}" alt="${displayName}"></div>
          <div class="oni-dd-actor-name">${displayName}</div>
        </div>
      `;

      if (_isOwner) {
        ovl.innerHTML = `
          <div class="oni-dd-panel">
            <div class="oni-dd-title">💭 Daydream</div>
            ${actorArea}
            <button class="oni-dd-begin-btn" id="oni-dd-begin">Click to Begin</button>
          </div>
        `;
        document.body.appendChild(ovl);
        document.getElementById("oni-dd-begin").addEventListener("click", () => {
          // Notify spectators to start watching the countdown + game
          if (game.user?.isGM) {
            CAMP.Socket.broadcast(CAMP.MSG.DAYDREAM_BEGIN, { actorId });
          } else {
            CAMP.Socket.emit(CAMP.MSG.DAYDREAM_BEGIN, { actorId });
          }
          _showCountdownPanel(actorId, actor, tokenImg, displayName);
        }, { once: true });
      } else {
        const ownerUid  = actor ? _getOwnerUserId(actor) : null;
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? displayName) : displayName;
        ovl.innerHTML = `
          <div class="oni-dd-panel">
            <div class="oni-dd-title">💭 Daydream</div>
            ${actorArea}
            <div class="oni-dd-waiting">Waiting for ${ownerName} to begin…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }
    },

    // --------------------------------------------------------------------
    // Stage 3 — Reveal (all clients)
    // --------------------------------------------------------------------
    applyResult(actorId, score, reduction) {
      if (_resultShown) return;
      _resultShown = true;

      _playSound(SFX.RESULT, 0.8);

      const quality =
        reduction >= 70 ? "Perfect rhythm!" :
        reduction >= 60 ? "Excellent!"       :
        reduction >= 50 ? "Good job!"        :
        reduction >= 40 ? "Pretty good."     :
                          "Sweet dreams…";

      const actor      = game.actors?.get(actorId);
      const isOwnerNow = actor ? _isActorOwner(actor) : false;

      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;

      ovl.innerHTML = `
        <div class="oni-dd-panel">
          <div class="oni-dd-result">
            <div class="oni-dd-finished">Finished!</div>
            <div class="oni-dd-reduction-txt">Damage Reduction: ${reduction}%</div>
            <div class="oni-dd-score-sub">${quality} &nbsp;·&nbsp; Score: ${score} / ${MAX_SCORE}</div>
            ${isOwnerNow ? `<button class="oni-dd-proceed-btn" id="oni-dd-proceed">Click to Proceed</button>` : ""}
          </div>
        </div>
      `;

      if (isOwnerNow) {
        const btn = document.getElementById("oni-dd-proceed");
        btn?.addEventListener("click", () => {
          btn.disabled = true;
          if (game.user?.isGM) {
            CAMP.DaydreamUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.DAYDREAM_PROCEED, { actorId });
          }
        }, { once: true });
      }
    },

    // --------------------------------------------------------------------
    // spectateBegin — transitions a spectator's waiting panel into the
    // countdown → game when the owner clicks "Click to Begin".
    // No-ops on the owner's own client (_isOwner guard) and when the
    // overlay isn't showing.
    // --------------------------------------------------------------------
    spectateBegin(actorId) {
      if (_isOwner) return;
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      const actor       = game.actors?.get(actorId);
      const tokenImg    = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
      const displayName = actor?.name ?? "?";
      _showCountdownPanel(actorId, actor, tokenImg, displayName);
    },

    // --------------------------------------------------------------------
    // onHit — mirrors the owner's success burst / fail flash on spectators.
    // No-ops if _isOwner (they already see it locally) or the game isn't
    // currently showing.
    // --------------------------------------------------------------------
    onHit(success) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      if (success) _flashSuccess();
      else _flashFail();
    },

    // --------------------------------------------------------------------
    // Gate resolvers (called by GM execute() and camp-socket.js)
    // --------------------------------------------------------------------
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

    // --------------------------------------------------------------------
    // Dismiss overlay
    // --------------------------------------------------------------------
    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-dd-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Daydream UI loaded.");
})();
