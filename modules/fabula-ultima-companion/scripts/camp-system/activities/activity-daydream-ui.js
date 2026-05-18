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
  // valid opportunities: 5 normal + 2 group = MAX_SCORE 7
  // ---------------------------------------------------------------------------
  const SCHEDULE = [
    { t: 600,  type: "normal",  id: 0 },
    { t: 1600, type: "normal",  id: 1 },
    { t: 2500, type: "offbeat", id: 2 },  // trap
    { t: 3300, type: "normal",  id: 3 },
    { t: 4000, type: "fake",    id: 4 },  // trap
    { t: 4800, type: "group",   id: 5 },
    { t: 5700, type: "normal",  id: 6 },
    { t: 6500, type: "offbeat", id: 7 },  // trap
    { t: 7300, type: "normal",  id: 8 },
    { t: 8100, type: "fake",    id: 9 },  // trap
    { t: 8900, type: "normal",  id: 10 },
    { t: 9500, type: "group",   id: 11 },
  ];

  const MAX_SCORE        = 7;
  const GAME_DURATION_MS = 10_000;
  const JUMP_MS          = 700;       // normal/group jump animation duration
  const FAKE_MS          = 800;       // fake jump animation duration
  const HIT_WIN_START    = JUMP_MS * 0.30;  // 210 ms
  const HIT_WIN_END      = JUMP_MS * 0.70;  // 490 ms

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId       = null;
  let _isOwner       = false;
  let _score         = 0;
  let _gameStartMs   = null;
  let _scheduleIdx   = 0;
  let _activeEvents  = [];   // { id, type, startMs, hit }
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
    _actorId      = null;
    _isOwner      = false;
    _score        = 0;
    _gameStartMs  = null;
    _scheduleIdx  = 0;
    _activeEvents = [];
    _resultShown  = false;
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
  // ---------------------------------------------------------------------------
  function _spawnSheep(type, id) {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;

    const isGroup = type === "group";
    const isFake  = type === "fake";
    const dur     = isFake ? FAKE_MS : JUMP_MS;
    const anim    = isFake ? "oni-dd-fake" : "oni-dd-jump";

    const el = document.createElement("div");
    el.className     = "oni-dd-sheep";
    el.dataset.sheepId = id;
    el.textContent   = "🐑";
    el.style.cssText = `animation:${anim} ${dur}ms ease-in-out forwards;`;
    stage.appendChild(el);
    setTimeout(() => el.remove(), dur + 150);

    // Hit-zone indicator: only for scoreable sheep, only visible to owner
    if (_isOwner && !isFake && type !== "offbeat") {
      setTimeout(() => _spawnHitZone(false), HIT_WIN_START);
    }

    if (isGroup) {
      // Second sheep on an upper track
      const el2 = document.createElement("div");
      el2.className   = "oni-dd-sheep";
      el2.textContent = "🐑";
      el2.style.cssText = `animation:oni-dd-jump-b ${JUMP_MS}ms ease-in-out forwards;`;
      stage.appendChild(el2);
      setTimeout(() => el2.remove(), JUMP_MS + 150);

      if (_isOwner) setTimeout(() => _spawnHitZone(true), HIT_WIN_START);
    }
  }

  // ---------------------------------------------------------------------------
  // Hit-zone indicator — pulsing ring at the sheep's apex during press window
  // trackB = true → use the group's upper-track apex position
  // ---------------------------------------------------------------------------
  function _spawnHitZone(trackB) {
    const stage = document.getElementById("oni-dd-stage");
    if (!stage) return;
    const z = document.createElement("div");
    z.className = "oni-dd-hit-zone";
    // Apex of track-A: left≈54%, bottom≈92px → center zone (44px) at 54%−22px, bottom 70px
    // Apex of track-B: left≈52%, bottom≈108px → bottom 86px
    z.style.left   = trackB ? "calc(52% - 22px)" : "calc(54% - 22px)";
    z.style.bottom = trackB ? "86px" : "70px";
    stage.appendChild(z);
    setTimeout(() => z.remove(), (HIT_WIN_END - HIT_WIN_START) + 60);
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

    function _frame() {
      if (!document.getElementById(OVL_ID)) return; // overlay removed — stop

      const now     = Date.now();
      const elapsed = now - _gameStartMs;

      // Fire scheduled sheep events
      while (_scheduleIdx < SCHEDULE.length && SCHEDULE[_scheduleIdx].t <= elapsed) {
        const ev = SCHEDULE[_scheduleIdx];
        _activeEvents.push({ id: ev.id, type: ev.type, startMs: now, hit: false });
        _spawnSheep(ev.type, ev.id);
        _scheduleIdx++;
      }

      // Expire events past jump window + buffer
      const expireMs = Math.max(JUMP_MS, FAKE_MS) + 200;
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

      const validTypes = new Set(["normal", "group"]);
      const trapTypes  = new Set(["offbeat", "fake"]);

      let scored  = false;
      let trapped = false;

      for (const ev of _activeEvents) {
        if (ev.hit) continue;
        const age = now - ev.startMs;
        const inWindow = age >= HIT_WIN_START && age <= HIT_WIN_END;
        if (!inWindow) continue;

        if (validTypes.has(ev.type)) {
          ev.hit = true;
          _score++;
          _playSound(SFX.SUCCESS, 0.8);
          _flashSuccess();
          scored = true;
          const scoreEl = document.getElementById("oni-dd-score-val");
          if (scoreEl) scoreEl.textContent = _score;
          break;
        } else if (trapTypes.has(ev.type)) {
          trapped = true;
        }
      }

      if (!scored && trapped) {
        _playSound(SFX.FAIL, 0.7);
        _flashFail();
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
  // Countdown helper (used inside show())
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
    // Stage 1 — Countdown → then transitions to minigame
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
      document.body.appendChild(ovl);

      _runCountdown(actorId, actor, 3, () => _startMinigame(actorId, actor));
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
