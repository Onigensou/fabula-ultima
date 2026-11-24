// ============================================================================
// Camp Activity — Gathering UI
//
// Minigame: 4×4 grid ingredient collector (keyboard-driven, 15 s)
//
// Spawn patterns:
//   normal     (55%) — ingredient appears immediately; 1 pt good / -1 pt poison
//   telegraphed(30%) — pulsing ring shows target cell 1.2 s before materialising
//   double     (15%) — glowing ingredient with ×2 badge; 2 pt good / -2 pt poison
//
// Good ingredients glow green; poisonous glow purple.
// Grid has a forest-green outer border.
//
// During active gameplay ALL non-modifier keyboard input is intercepted in
// capture phase, preventing Foundry from panning the canvas or moving tokens.
//
// Grade thresholds (scores are higher now that doubles exist):
//   0-3  standard  → 2 ingredients, random tastes
//   4-7  good      → 3 ingredients, random tastes
//   8+   exceptional→ 3 ingredients, player's choice of taste
//
// Spectators (everyone but the owner) watch the same board: the owner sends
// GATHERING_GAME_STATE on every move, spawn, telegraph and expiry (coalesced
// to one per frame), with `elapsed` (timer re-anchor), `moved` and
// `collected` {id,col,row,type,pts} so spectators replay the move/collect/
// poison sounds, pops and flashes. Ingredients are diffed by owner id so they
// pop in and fade out like on the owner's screen. The Exceptional-haul taste
// picker is mirrored read-only via CAMP.MG.event("GATHERING", …, "taste").
// Late join: CAMP.MG.registerGame("GATHERING").
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const TAG       = "[CampSystem][GatheringUI]";
  const OVL_ID    = "oni-camp-gt-ovl";
  const STYLE_ID  = "oni-camp-gt-style";

  // ── Constants ──────────────────────────────────────────────────────────────
  const GAME_MS            = 15_000;
  const GRID_COLS          = 4;
  const GRID_ROWS          = 4;
  const SPAWN_MIN_MS       = 600;
  const SPAWN_MAX_MS       = 900;
  const LIFE_MIN_MS        = 2_800;
  const LIFE_MAX_MS        = 4_000;
  const TELEGRAPH_MS       = 1_000;   // ingredient blink-warning before expiry
  const TELEGRAPH_SPAWN_MS = 900;     // preview→materialise delay
  const MAX_ACTIVE         = 6;       // max ingredients + pending combined
  const POISON_CHANCE      = 0.25;
  const DOUBLE_CHANCE      = 0.15;
  const TELEGRAPH_CHANCE   = 0.30;
  // P(normal) = 1 - DOUBLE_CHANCE - TELEGRAPH_CHANCE = 0.55

  const GOOD_EMOJIS   = ["🌿","🫐","🌸","🍋","🍒","🌾","🍃","🌼"];
  const POISON_EMOJIS = ["🍄","🕷️","🐍"];
  const TASTES        = ["Bitter","Salty","Sour","Sweet","Umami"];

  // Keys the player uses to move — suppressed from Foundry in capture phase
  const GAME_KEYS = new Set([
    "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
    "w","W","a","A","s","S","d","D",
  ]);

  const SFX = {
    MOVE:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    COLLECT:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    POISON:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    COUNTDOWN:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:          "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
    RESULT_GOOD: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
    RESULT_BAD:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/fumble_1.WAV",
  };

  // ── Runtime state ──────────────────────────────────────────────────────────
  let _actorId      = null;
  let _isOwner      = false;
  let _playerImg    = "icons/svg/mystery-man.svg";
  let _score        = 0;
  let _playerPos    = { col: 1, row: 1 };
  let _ingredients  = new Map();   // id → { id,col,row,emoji,type,double,spawnMs,lifespanMs,el }
  let _pendingSpawns = new Map();  // id → { id,col,row,type,double,materialesAt,previewEl }
  let _nextIngId    = 0;
  let _gameStartMs  = null;
  let _rafId        = null;
  let _spawnTimer   = null;
  let _endTimer     = null;
  let _gameOver     = false;
  let _resultShown  = false;
  let _keyHandler   = null;
  let _lastLabelSec = -1;
  let _stage        = "idle";   // idle | waiting | countdown | playing | over | taste | result
  let _stateDirty   = false;    // owner: board changed since the last GAME_STATE
  let _pendingState = null;     // spectator: state that arrived before our arena existed
  let _tastePicked  = null;     // taste chosen on the Exceptional picker (owner + mirror)

  // ── Web Audio (movement sound) ─────────────────────────────────────────────
  let _audioCtx   = null;
  let _moveBuffer = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const _els = { timerBar: null, timerLabel: null, scoreLabel: null, grid: null, game: null };

  // ===========================================================================
  // State reset
  // ===========================================================================

  function _clearState() {
    if (_rafId      !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer   !== null) { clearTimeout(_endTimer);      _endTimer = null; }
    if (_spawnTimer !== null) { clearTimeout(_spawnTimer);    _spawnTimer = null; }
    if (_keyHandler)          { window.removeEventListener("keydown", _keyHandler, true); _keyHandler = null; }

    _actorId      = null;
    _isOwner      = false;
    _playerImg    = "icons/svg/mystery-man.svg";
    _score        = 0;
    _playerPos    = { col: 1, row: 1 };
    _ingredients.clear();
    _pendingSpawns.clear();
    _nextIngId    = 0;
    _gameStartMs  = null;
    _gameOver     = false;
    _resultShown  = false;
    _lastLabelSec = -1;
    _stage        = "idle";
    _stateDirty   = false;
    _pendingState = null;
    _tastePicked  = null;

    for (const k of Object.keys(_els)) _els[k] = null;
  }

  // ===========================================================================
  // Audio
  // ===========================================================================

  function _playSound(src, volume = 0.7) {
    try {
      const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (AH) { AH.play({ src, volume, autoplay: true, loop: false }, false); return; }
    } catch {}
    try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
  }

  async function _initWebAudio() {
    try {
      _audioCtx   = new (window.AudioContext ?? window.webkitAudioContext)();
      const ab    = await (await fetch(SFX.MOVE)).arrayBuffer();
      _moveBuffer = await _audioCtx.decodeAudioData(ab);
    } catch (err) {
      console.warn(TAG, "Web Audio init failed:", err);
    }
  }

  function _playMove() {
    if (_audioCtx && _moveBuffer) {
      if (_audioCtx.state === "suspended") _audioCtx.resume();
      const src = _audioCtx.createBufferSource();
      src.buffer = _moveBuffer;
      src.connect(_audioCtx.destination);
      src.start(0);
      return;
    }
    _playSound(SFX.MOVE, 0.6);
  }

  // ===========================================================================
  // DOM helpers
  // ===========================================================================

  function _getCellEl(col, row) {
    return document.getElementById(`oni-gt-cell-${col}-${row}`);
  }

  function _cacheEls() {
    _els.timerBar   = document.getElementById("oni-gt-timer-bar");
    _els.timerLabel = document.getElementById("oni-gt-timer-label");
    _els.scoreLabel = document.getElementById("oni-gt-hud-score");
    _els.grid       = document.getElementById("oni-gt-grid");
    _els.game       = document.getElementById("oni-gt-game");
  }

  // ===========================================================================
  // CSS
  // ===========================================================================

  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* ── Overlay ── */
      #${OVL_ID} {
        position:fixed;inset:0;z-index:10000;
        display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.82);
        animation:oni-gt-fadein .35s ease forwards;
        font-family:"Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-gt-out { animation:oni-gt-fadeout .3s ease forwards; }
      @keyframes oni-gt-fadein  { from{opacity:0}to{opacity:1} }
      @keyframes oni-gt-fadeout { from{opacity:1}to{opacity:0} }
      @keyframes oni-gt-slideup { from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)} }
      @keyframes oni-gt-pop     { from{transform:scale(1.55)}to{transform:scale(1)} }

      /* ── Shared panel ── */
      .oni-gt-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;padding:24px 28px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:14px;
        animation:oni-gt-slideup .3s ease forwards;
      }
      .oni-gt-title   { font-size:1.4rem;font-weight:800;color:#6b3a1f;letter-spacing:.05em;text-transform:uppercase; }
      .oni-gt-sub     { font-size:.9rem;color:#8a5c2c;font-style:italic;text-align:center; }
      .oni-gt-waiting { font-size:1rem;color:#c8a84b;font-style:italic; }

      /* ── Begin button ── */
      .oni-gt-begin-btn {
        padding:10px 32px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.95rem;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4);transition:filter .15s;
      }
      .oni-gt-begin-btn:hover { filter:brightness(1.15); }

      /* ── Countdown ── */
      .oni-gt-countdown-num {
        font-size:5rem;font-weight:900;color:#c8a84b;line-height:1;
        text-shadow:0 0 30px rgba(200,168,75,.7);animation:oni-gt-pop .25s ease;
      }
      .oni-gt-go-text {
        font-size:3.5rem;font-weight:900;color:#3a8a35;
        text-shadow:0 0 28px rgba(58,138,53,.8);animation:oni-gt-pop .3s ease;
      }

      /* ── Game container ── */
      .oni-gt-game { display:flex;flex-direction:column;gap:10px;position:relative; }

      /* ── HUD ── */
      .oni-gt-hud-row { display:flex;align-items:center;gap:8px; }
      .oni-gt-timer-wrap {
        flex:1;height:8px;background:rgba(255,255,255,.15);border-radius:4px;overflow:hidden;
        box-shadow:0 0 0 1px rgba(200,168,75,.4);
      }
      .oni-gt-timer-bar  { height:100%;width:100%;background:#c8a84b;border-radius:4px;transition:width .05s linear; }
      .oni-gt-timer-label {
        font-size:.8rem;font-weight:700;color:#e8dfc0;
        text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;min-width:26px;text-align:right;
      }
      .oni-gt-hud-score {
        font-size:.88rem;font-weight:700;color:#f4d488;
        text-shadow:0 0 8px rgba(244,212,136,.5);white-space:nowrap;
      }

      /* ── Grid — forest-green outer border ── */
      .oni-gt-grid {
        display:grid;
        grid-template-columns:repeat(4,70px);
        grid-template-rows:repeat(4,70px);
        gap:4px;
        padding:6px;
        border:2px solid rgba(45,160,80,.55);
        border-radius:10px;
        background:rgba(0,0,0,.18);
        box-shadow:0 0 14px rgba(45,160,80,.18), inset 0 0 6px rgba(0,0,0,.25);
      }

      /* ── Cells ── */
      .oni-gt-cell {
        width:70px;height:70px;
        background:rgba(246,235,211,.07);
        border:1.5px solid rgba(141,95,56,.28);
        border-radius:8px;
        position:relative;
        display:flex;align-items:center;justify-content:center;
        overflow:hidden;
      }

      /* ── Player token ── */
      .oni-gt-player {
        position:absolute;
        width:54px;height:54px;
        object-fit:contain;border:none;border-radius:0;
        z-index:2;
        filter:drop-shadow(0 0 6px rgba(200,168,75,.9));
        pointer-events:none;
      }

      /* ── Ingredients — green for good, purple for poison ── */
      .oni-gt-ingredient {
        position:absolute;
        font-size:1.9rem;line-height:1;
        z-index:1;pointer-events:none;
      }
      .oni-gt-ingredient.good {
        filter:drop-shadow(0 0 6px rgba(60,200,80,.95))
               drop-shadow(0 0 2px rgba(30,120,50,.7));
      }
      .oni-gt-ingredient.poison {
        filter:drop-shadow(0 0 7px rgba(153,40,220,.95))
               drop-shadow(0 0 2px rgba(90,10,130,.8));
      }
      /* Double variant — extra gold/magenta outer glow + ×2 badge */
      .oni-gt-ingredient.good.double {
        filter:drop-shadow(0 0 6px rgba(60,200,80,1))
               drop-shadow(0 0 14px rgba(255,210,0,.75));
      }
      .oni-gt-ingredient.poison.double {
        filter:drop-shadow(0 0 7px rgba(153,40,220,1))
               drop-shadow(0 0 12px rgba(230,0,210,.65));
      }
      .oni-gt-double-badge {
        position:absolute;top:-5px;right:-5px;
        font-size:.56rem;font-weight:900;padding:1px 3px;border-radius:4px;
        line-height:1.2;pointer-events:none;z-index:3;letter-spacing:0;
      }
      .oni-gt-ingredient.good.double   .oni-gt-double-badge { background:#ffd700;color:#000;box-shadow:0 0 4px rgba(255,210,0,.7); }
      .oni-gt-ingredient.poison.double .oni-gt-double-badge { background:#dd00ff;color:#fff;box-shadow:0 0 4px rgba(221,0,255,.7); }

      /* Expiry telegraph — blink when ingredient is about to vanish */
      .oni-gt-expiring { animation:oni-gt-blink .22s ease-in-out infinite; }
      @keyframes oni-gt-blink {
        0%,100% { opacity:1;transform:scale(1); }
        50%     { opacity:.22;transform:scale(.78); }
      }

      /* ── Telegraphed spawn preview ring ── */
      .oni-gt-telegraph {
        position:absolute;
        width:54px;height:54px;
        border-radius:50%;
        border:2.5px dashed;
        pointer-events:none;z-index:1;
        animation:oni-gt-tel-pulse .55s ease-in-out infinite;
      }
      .oni-gt-telegraph.good   { border-color:rgba(60,200,80,.9);  background:rgba(60,200,80,.06); }
      .oni-gt-telegraph.poison { border-color:rgba(153,40,220,.9); background:rgba(153,40,220,.06); }
      @keyframes oni-gt-tel-pulse {
        0%,100% { transform:scale(.75);opacity:.4; }
        50%     { transform:scale(1.06);opacity:1; }
      }

      /* ── Cell flash ── */
      .oni-gt-flash-good { animation:oni-gt-flash-g .28s ease; }
      .oni-gt-flash-bad  { animation:oni-gt-flash-b .28s ease; }
      @keyframes oni-gt-flash-g {
        0%,100% { background:rgba(246,235,211,.07); }
        40%     { background:rgba(60,200,80,.32); }
      }
      @keyframes oni-gt-flash-b {
        0%,100% { background:rgba(246,235,211,.07); }
        40%     { background:rgba(153,40,220,.32); }
      }

      /* ── Controls hint / spectator label ── */
      .oni-gt-controls-hint,.oni-gt-spectator-label {
        font-size:.72rem;font-weight:600;color:rgba(246,235,211,.5);
        text-align:center;letter-spacing:.03em;margin-top:-2px;
      }

      /* ── "Time's Up!" overlay ── */
      .oni-gt-finished-overlay {
        position:absolute;inset:0;
        background:rgba(0,0,0,.55);border-radius:8px;
        display:flex;align-items:center;justify-content:center;
        z-index:20;
        animation:oni-gt-fadein .25s ease forwards;
      }
      .oni-gt-finished-txt {
        font-size:2.6rem;font-weight:900;color:#f4d488;
        text-shadow:0 0 32px rgba(244,212,136,.9);letter-spacing:.08em;
        animation:oni-gt-slideup .4s ease forwards;
      }

      /* ── Taste picker ── */
      .oni-gt-taste-grid { display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:4px; }
      .oni-gt-taste-btn {
        padding:7px 18px;
        background:rgba(246,235,211,.85);
        border:2px solid var(--camp-wood-2,#8d5f38);
        border-radius:8px;cursor:pointer;
        font-weight:700;font-size:.88rem;color:#5a3010;
        transition:background .12s,transform .1s;
      }
      .oni-gt-taste-btn:hover    { background:#e8d2a0;transform:translateY(-2px); }
      .oni-gt-taste-btn:disabled { opacity:.45;cursor:not-allowed;transform:none; }

      /* ── Result panel ── */
      .oni-gt-result-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;padding:28px 36px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:12px;
        animation:oni-gt-slideup .4s ease forwards;min-width:300px;
      }
      .oni-gt-finished   { font-size:2.4rem;font-weight:900;color:#f4d488;text-shadow:0 0 24px rgba(244,212,136,.8);letter-spacing:.06em; }
      .oni-gt-grade-txt  { font-size:1.4rem;font-weight:800; }
      .oni-gt-effect-txt { font-size:.88rem;color:#5a3010;text-align:center;line-height:1.4; }
      .oni-gt-proceed-btn {
        margin-top:4px;padding:8px 28px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.9rem;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4);transition:filter .15s;
      }
      .oni-gt-proceed-btn:hover    { filter:brightness(1.15); }
      .oni-gt-proceed-btn:disabled { opacity:.5;cursor:not-allowed; }

      /* ── Floating score pops ── */
      .oni-gt-score-pop {
        position:fixed;font-size:1.15rem;font-weight:900;
        color:#f4d488;text-shadow:0 0 8px rgba(244,212,136,.9);
        pointer-events:none;z-index:10001;white-space:nowrap;
        animation:oni-gt-float-up .55s ease-out forwards;
      }
      .oni-gt-wrong-pop {
        position:fixed;font-size:1.15rem;font-weight:900;
        color:#cc66ff;text-shadow:0 0 8px rgba(200,80,255,.8);
        pointer-events:none;z-index:10001;white-space:nowrap;
        animation:oni-gt-float-up .5s ease-out forwards;
      }
      @keyframes oni-gt-float-up {
        0%   { transform:translate(-50%,0);opacity:1; }
        60%  { transform:translate(-50%,-26px);opacity:1; }
        100% { transform:translate(-50%,-42px);opacity:0; }
      }
    `;
    document.head.appendChild(s);
  }

  // ===========================================================================
  // Arena HTML
  // ===========================================================================

  function _buildArenaHTML() {
    const cells = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        cells.push(`<div class="oni-gt-cell" id="oni-gt-cell-${c}-${r}" data-col="${c}" data-row="${r}"></div>`);
      }
    }
    const hint = _isOwner
      ? `<div class="oni-gt-controls-hint">Arrow keys / WASD to move</div>`
      : `<div class="oni-gt-spectator-label">Watching…</div>`;
    return `
      <div class="oni-gt-game" id="oni-gt-game">
        <div class="oni-gt-hud-row">
          <div class="oni-gt-timer-wrap"><div class="oni-gt-timer-bar" id="oni-gt-timer-bar"></div></div>
          <div class="oni-gt-timer-label" id="oni-gt-timer-label">15s</div>
          <div class="oni-gt-hud-score" id="oni-gt-hud-score">Score: 0</div>
        </div>
        <div class="oni-gt-grid" id="oni-gt-grid">${cells.join("")}</div>
        ${hint}
      </div>
    `;
  }

  // ===========================================================================
  // Player
  // ===========================================================================

  function _renderPlayer() {
    const cell = _getCellEl(_playerPos.col, _playerPos.row);
    if (!cell) return;
    const img = document.createElement("img");
    img.className = "oni-gt-player";
    img.src = _playerImg;
    img.alt = "★";
    cell.appendChild(img);
  }

  function _movePlayerTo(col, row) {
    _getCellEl(_playerPos.col, _playerPos.row)
      ?.querySelector(".oni-gt-player")?.remove();
    _playerPos = { col, row };
    const cell = _getCellEl(col, row);
    if (cell) {
      const img = document.createElement("img");
      img.className = "oni-gt-player";
      img.src = _playerImg;
      img.alt = "★";
      cell.appendChild(img);
      img.animate(
        [{ transform: "scale(.65)" }, { transform: "scale(1)" }],
        { duration: 90, easing: "ease-out" }
      );
    }
  }

  // ===========================================================================
  // Ingredient rendering
  // ===========================================================================

  function _renderIngredient(ing) {
    const cell = _getCellEl(ing.col, ing.row);
    if (!cell) return null;
    const el = document.createElement("div");
    el.className  = `oni-gt-ingredient ${ing.type}${ing.double ? " double" : ""}`;
    el.id         = `oni-gt-ing-${ing.id}`;
    el.textContent = ing.emoji;
    if (ing.double) {
      const badge = document.createElement("span");
      badge.className   = "oni-gt-double-badge";
      badge.textContent = "×2";
      el.appendChild(badge);
    }
    el.animate(
      [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 200, easing: "ease-out" }
    );
    cell.appendChild(el);
    return el;
  }

  function _renderTelegraph(p) {
    const cell = _getCellEl(p.col, p.row);
    if (!cell) return null;
    const el = document.createElement("div");
    el.className = `oni-gt-telegraph ${p.type}`;
    el.id        = `oni-gt-tel-${p.id}`;
    cell.appendChild(el);
    return el;
  }

  // ===========================================================================
  // Ingredient management
  // ===========================================================================

  function _occupiedSet() {
    const s = new Set([
      ...Array.from(_ingredients.values()),
      ...Array.from(_pendingSpawns.values()),
    ].map(i => `${i.col},${i.row}`));
    s.add(`${_playerPos.col},${_playerPos.row}`);
    return s;
  }

  function _pickEmptyCell() {
    const occupied = _occupiedSet();
    const empty = [];
    for (let c = 0; c < GRID_COLS; c++) {
      for (let r = 0; r < GRID_ROWS; r++) {
        if (!occupied.has(`${c},${r}`)) empty.push({ col: c, row: r });
      }
    }
    if (!empty.length) return null;
    return empty[Math.floor(Math.random() * empty.length)];
  }

  function _spawnImmediate(col, row, type, isDouble) {
    const pool     = type === "poison" ? POISON_EMOJIS : GOOD_EMOJIS;
    const emoji    = pool[Math.floor(Math.random() * pool.length)];
    const id       = _nextIngId++;
    const lifespan = LIFE_MIN_MS + Math.random() * (LIFE_MAX_MS - LIFE_MIN_MS);
    const ing = { id, col, row, emoji, type, double: isDouble, spawnMs: Date.now(), lifespanMs: lifespan, el: null };
    ing.el = _renderIngredient(ing);
    if (ing.el) _ingredients.set(id, ing);
    _stateDirty = true;
  }

  function _spawnTelegraphed(col, row, type, isDouble) {
    const id = _nextIngId++;
    const pending = {
      id, col, row, type, double: isDouble,
      materialesAt: Date.now() + TELEGRAPH_SPAWN_MS,
      previewEl: null,
    };
    pending.previewEl = _renderTelegraph(pending);
    _pendingSpawns.set(id, pending);
    _stateDirty = true;
  }

  function _trySpawnIngredient() {
    if (_ingredients.size + _pendingSpawns.size >= MAX_ACTIVE || _gameOver) return;
    const pos = _pickEmptyCell();
    if (!pos) return;

    const type = Math.random() < POISON_CHANCE ? "poison" : "good";
    const vr   = Math.random();
    if (vr < DOUBLE_CHANCE) {
      _spawnImmediate(pos.col, pos.row, type, true);
    } else if (vr < DOUBLE_CHANCE + TELEGRAPH_CHANCE) {
      _spawnTelegraphed(pos.col, pos.row, type, false);
    } else {
      _spawnImmediate(pos.col, pos.row, type, false);
    }
  }

  function _scheduleNextSpawn() {
    if (_gameOver) return;
    const delay = SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
    _spawnTimer = setTimeout(() => {
      _trySpawnIngredient();
      _scheduleNextSpawn();
    }, delay);
  }

  function _checkPendingSpawns(now) {
    for (const [id, p] of _pendingSpawns) {
      if (now >= p.materialesAt) {
        // Dissolve telegraph ring then materialise
        if (p.previewEl) {
          p.previewEl.animate(
            [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.5)" }],
            { duration: 140, fill: "forwards" }
          ).finished.then(() => p.previewEl?.remove()).catch(() => p.previewEl?.remove());
        }
        _pendingSpawns.delete(id);
        _spawnImmediate(p.col, p.row, p.type, p.double);
      }
    }
  }

  function _checkIngredients(now) {
    _checkPendingSpawns(now);
    for (const [id, ing] of _ingredients) {
      const remaining = ing.lifespanMs - (now - ing.spawnMs);
      if (remaining <= 0) {
        ing.el?.animate(
          [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.5)" }],
          { duration: 150, fill: "forwards" }
        ).finished.then(() => ing.el?.remove()).catch(() => ing.el?.remove());
        _ingredients.delete(id);
        _stateDirty = true;
      } else if (remaining < TELEGRAPH_MS) {
        ing.el?.classList.add("oni-gt-expiring");
      }
    }
  }

  function _collectIngredient(ing) {
    const pts = ing.double ? 2 : 1;
    ing.el?.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.5)" }],
      { duration: 150, fill: "forwards" }
    ).finished.then(() => ing.el?.remove()).catch(() => ing.el?.remove());
    _ingredients.delete(ing.id);

    if (ing.type === "poison") _score = Math.max(0, _score - pts);
    else                       _score += pts;
    _collectFx(ing.type, pts, ing.col, ing.row);

    if (_els.scoreLabel) _els.scoreLabel.textContent = `Score: ${_score}`;
    return { id: ing.id, col: ing.col, row: ing.row, type: ing.type, pts };
  }

  // Sound + pop + cell flash of a pickup — same call on owner and spectators.
  function _collectFx(type, pts, col, row) {
    if (type === "poison") {
      _playSound(SFX.POISON, 0.7);
      _spawnScorePop(`-${pts}`, true,  col, row);
      _flashCell(col, row, "oni-gt-flash-bad");
    } else {
      _playSound(SFX.COLLECT, 0.6);
      _spawnScorePop(`+${pts}`, false, col, row);
      _flashCell(col, row, "oni-gt-flash-good");
    }
  }

  // ===========================================================================
  // Visual feedback
  // ===========================================================================

  function _spawnScorePop(label, isWrong, col, row) {
    const cell = _getCellEl(col, row);
    if (!cell) return;
    const rect      = cell.getBoundingClientRect();
    const txt       = document.createElement("div");
    txt.className   = isWrong ? "oni-gt-wrong-pop" : "oni-gt-score-pop";
    txt.textContent = label;
    txt.style.left  = `${rect.left + rect.width / 2}px`;
    txt.style.top   = `${rect.top}px`;
    document.body.appendChild(txt);
    setTimeout(() => txt.remove(), 580);
  }

  function _flashCell(col, row, cls) {
    const cell = _getCellEl(col, row);
    if (!cell) return;
    cell.classList.add(cls);
    cell.addEventListener("animationend", () => cell.classList.remove(cls), { once: true });
  }

  // ===========================================================================
  // rAF game loop
  // ===========================================================================

  function _startGameLoop() {
    const bar = _els.timerBar;
    const lbl = _els.timerLabel;

    function _frame() {
      if (!_els.game) return;
      const elapsed = Date.now() - _gameStartMs;
      const frac    = Math.max(0, 1 - elapsed / GAME_MS);
      bar.style.width = `${(frac * 100).toFixed(2)}%`;
      const sec = Math.ceil(frac * GAME_MS / 1000);
      if (sec !== _lastLabelSec) { _lastLabelSec = sec; lbl.textContent = `${sec}s`; }
      if (_isOwner) {
        _checkIngredients(Date.now());
        // Spawns / telegraphs / expiries reach spectators even while the player stands still.
        if (_stateDirty && !_gameOver) _emitGameState();
      } else {
        _specBlink(Date.now());
      }
      _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);
  }

  // ===========================================================================
  // Keyboard — capture phase suppresses all non-modifier keys from Foundry
  // ===========================================================================

  function _buildKeyHandler() {
    return function(e) {
      // Let browser/OS modifier combos (Ctrl+Z, Cmd+Tab etc.) through
      if (e.ctrlKey || e.metaKey) return;

      // Block event from reaching Foundry's handlers (canvas pan, token move, hotkeys)
      e.preventDefault();
      e.stopPropagation();

      // Handle movement for the owner during active gameplay
      if (_gameOver || !_isOwner || !GAME_KEYS.has(e.key)) return;
      _processMove(e.key);
    };
  }

  function _processMove(key) {
    let dc = 0, dr = 0;
    switch (key) {
      case "ArrowUp":    case "w": case "W": dr = -1; break;
      case "ArrowDown":  case "s": case "S": dr =  1; break;
      case "ArrowLeft":  case "a": case "A": dc = -1; break;
      case "ArrowRight": case "d": case "D": dc =  1; break;
      default: return;
    }
    const nc = _playerPos.col + dc;
    const nr = _playerPos.row + dr;
    if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) return;

    _playMove();
    _movePlayerTo(nc, nr);

    const hit = Array.from(_ingredients.values()).find(i => i.col === nc && i.row === nr);
    const collected = hit ? _collectIngredient(hit) : null;

    _emitGameState({ moved: true, collected });
  }

  // ===========================================================================
  // State broadcast to spectators
  // ===========================================================================

  function _emitGameState(extra = {}) {
    _stateDirty = false;
    CAMP.Socket.emit(CAMP.MSG.GATHERING_GAME_STATE, { ..._stateSnapshot(), ...extra });
  }

  function _stateSnapshot() {
    const now = Date.now();
    return {
      actorId:   _actorId,
      elapsed:   _gameStartMs ? now - _gameStartMs : 0,
      playerPos: { ..._playerPos },
      ingredients: Array.from(_ingredients.values()).map(ing => ({
        id: ing.id, col: ing.col, row: ing.row,
        emoji: ing.emoji, type: ing.type, double: ing.double,
        remaining: ing.lifespanMs - (now - ing.spawnMs),
      })),
      pending: Array.from(_pendingSpawns.values()).map(p => ({
        id: p.id, col: p.col, row: p.row,
        type: p.type, double: p.double,
        remaining: p.materialesAt - now,
      })),
      score: _score,
    };
  }

  // ===========================================================================
  // Spectator rendering — diff the owner's board by ingredient id so items pop
  // in / fade out exactly like on the owner's screen.
  // ===========================================================================

  function _fadeOut(el, scaleTo = 0.5, ms = 150) {
    if (!el) return;
    el.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${scaleTo})` }],
      { duration: ms, fill: "forwards" }
    ).finished.then(() => el.remove()).catch(() => el.remove());
  }

  function _applyState(st, { quiet = false } = {}) {
    if (!st || !_els.grid) return;
    const now = Date.now();

    // Timer re-anchor (owner's clock started a few ms earlier/later than ours).
    if (st.elapsed != null && !_gameOver) {
      const start = now - st.elapsed;
      if (Math.abs(start - (_gameStartMs ?? start)) > 120) {
        _gameStartMs = start;
        if (_endTimer !== null) clearTimeout(_endTimer);
        _endTimer = setTimeout(() => _onGameEnd(), Math.max(0, GAME_MS - st.elapsed));
      }
    }

    // Pickup first — the collected item is already gone from st.ingredients and
    // must pop (scale 1.5) rather than fade like an expiry.
    const c = st.collected;
    if (c) {
      const ing = _ingredients.get(c.id);
      if (ing) { _fadeOut(ing.el, 1.5); _ingredients.delete(c.id); }
      if (!quiet) _collectFx(c.type, c.pts, c.col, c.row);
    }

    // Player token
    const pp = st.playerPos;
    if (pp) {
      const hasToken = !!_getCellEl(_playerPos.col, _playerPos.row)?.querySelector(".oni-gt-player");
      if (!hasToken || pp.col !== _playerPos.col || pp.row !== _playerPos.row) {
        if (st.moved && !quiet) _playSound(SFX.MOVE, 0.6);
        _els.grid.querySelectorAll(".oni-gt-player").forEach(el => el.remove());
        _movePlayerTo(pp.col, pp.row);
      }
    }

    // Ingredients
    const seen = new Set();
    for (const s of (st.ingredients ?? [])) {
      seen.add(s.id);
      if (_ingredients.has(s.id)) continue;
      const ing = { id: s.id, col: s.col, row: s.row, emoji: s.emoji, type: s.type, double: s.double,
                    spawnMs: now, lifespanMs: s.remaining, el: null };
      ing.el = _renderIngredient(ing);
      if (ing.el) _ingredients.set(s.id, ing);
    }
    for (const [id, ing] of _ingredients) {
      if (seen.has(id)) continue;
      _fadeOut(ing.el);
      _ingredients.delete(id);
    }

    // Telegraph rings
    const seenP = new Set();
    for (const s of (st.pending ?? [])) {
      seenP.add(s.id);
      if (_pendingSpawns.has(s.id)) continue;
      const p = { id: s.id, col: s.col, row: s.row, type: s.type, double: s.double,
                  materialesAt: now + (s.remaining ?? 0), previewEl: null };
      p.previewEl = _renderTelegraph(p);
      _pendingSpawns.set(s.id, p);
    }
    for (const [id, p] of _pendingSpawns) {
      if (seenP.has(id)) continue;
      _fadeOut(p.previewEl, 0.5, 140);
      _pendingSpawns.delete(id);
    }

    _score = st.score ?? _score;
    if (_els.scoreLabel) _els.scoreLabel.textContent = `Score: ${_score}`;
  }

  // Spectator: the expiry blink runs locally from the remaining time we were sent.
  function _specBlink(now) {
    for (const ing of _ingredients.values()) {
      if (ing.lifespanMs - (now - ing.spawnMs) < TELEGRAPH_MS) ing.el?.classList.add("oni-gt-expiring");
    }
  }

  // ===========================================================================
  // Countdown
  // ===========================================================================

  function _runCountdown(count, onDone) {
    // A late-join apply can skip us straight into play — stop counting then.
    if (_stage !== "countdown") return;
    const el = document.getElementById("oni-gt-count");
    if (el) {
      el.textContent = count;
      el.className   = "oni-gt-countdown-num";
      void el.offsetWidth; // restart CSS pop animation (pre-game, acceptable)
    }
    _playSound(SFX.COUNTDOWN, 0.8);
    if (count > 1) {
      setTimeout(() => _runCountdown(count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        if (_stage !== "countdown") return;
        const el2 = document.getElementById("oni-gt-count");
        if (el2) { el2.className = "oni-gt-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(() => { if (_stage === "countdown") onDone(); }, 700);
      }, 1000);
    }
  }

  // ===========================================================================
  // Arena start
  // ===========================================================================

  function _showArena() {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;

    _stage = "playing";
    ovl.innerHTML = _buildArenaHTML();
    _cacheEls();

    // Everyone starts with the token on the start cell (spectators too).
    _renderPlayer();

    _gameStartMs  = Date.now();
    _lastLabelSec = -1;
    _startGameLoop();

    _endTimer = setTimeout(() => _onGameEnd(), GAME_MS);

    if (_isOwner) {
      _initWebAudio();
      _scheduleNextSpawn();
      // Capture phase — fires before Foundry's bubble-phase handlers
      _keyHandler = _buildKeyHandler();
      window.addEventListener("keydown", _keyHandler, true);
      _emitGameState();   // start beat: timer anchor + token position for spectators
    } else if (_pendingState) {
      const st = _pendingState; _pendingState = null;
      _applyState(st, { quiet: true });
    }
  }

  // ===========================================================================
  // Game end
  // ===========================================================================

  function _onGameEnd() {
    if (_gameOver) return;
    _gameOver = true;
    _stage    = "over";
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
    if (_rafId      !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_spawnTimer !== null) { clearTimeout(_spawnTimer);    _spawnTimer = null; }
    if (_keyHandler)          { window.removeEventListener("keydown", _keyHandler, true); _keyHandler = null; }

    if (_els.timerBar)   _els.timerBar.style.width = "0%";
    if (_els.timerLabel) _els.timerLabel.textContent = "0s";

    const gp = _els.game;
    if (gp) {
      const fin     = document.createElement("div");
      fin.className = "oni-gt-finished-overlay";
      fin.innerHTML = `<div class="oni-gt-finished-txt">Time's Up!</div>`;
      gp.appendChild(fin);
    }

    // Only the owner submits a score; spectators wait for the RESULT broadcast
    if (_isOwner) setTimeout(() => _showTastePickerOrSubmit(), 700);
  }

  // ===========================================================================
  // Score submission
  // ===========================================================================

  function _showTastePickerOrSubmit() {
    if (_score >= 8) {
      // Exceptional — player picks a taste
      const ovl = _renderTastePicker();
      if (!ovl) return;
      CAMP.MG?.event?.("GATHERING", _actorId, "taste", { open: true });
      ovl.querySelectorAll(".oni-gt-taste-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          ovl.querySelectorAll(".oni-gt-taste-btn").forEach(b => { b.disabled = true; });
          _tastePicked = btn.dataset.taste;
          CAMP.MG?.event?.("GATHERING", _actorId, "taste", { pick: _tastePicked });
          _submitScore(btn.dataset.taste);
        }, { once: true });
      });
    } else {
      _submitScore(null);
    }
  }

  // Taste picker panel. Spectators get the same panel read-only (no clicks),
  // with the owner's pick highlighted when it arrives.
  function _renderTastePicker() {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return null;
    _stage = "taste";
    let sub = "You gathered so much!<br>Choose a taste for your ingredients:";
    if (!_isOwner) {
      const name = game.actors?.get(_actorId)?.name ?? "The gatherer";
      sub = `${name} gathered so much!<br>Choosing a taste for the ingredients…`;
    }
    ovl.innerHTML = `
      <div class="oni-gt-panel">
        <div class="oni-gt-title">🌿 Exceptional Haul!</div>
        <div class="oni-gt-sub">${sub}</div>
        <div class="oni-gt-taste-grid"${_isOwner ? "" : ` style="pointer-events:none;"`}>
          ${TASTES.map(t => `<button class="oni-gt-taste-btn" data-taste="${t}"${_isOwner ? "" : ` tabindex="-1"`}>${t}</button>`).join("")}
        </div>
      </div>
    `;
    return ovl;
  }

  function _markTastePick(taste) {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl || !taste) return;
    ovl.querySelectorAll(".oni-gt-taste-btn").forEach(b => {
      if (b.dataset.taste === taste) {
        b.style.background = "#e8d2a0";
        b.style.transform  = "translateY(-2px)";
        b.style.boxShadow  = "0 0 0 2px #c8a84b";
      } else {
        b.disabled = true;
      }
    });
  }

  function _submitScore(taste) {
    // send() runs locally too, so a GM owner reaches its own resolver (no
    // `grade` → skips the all-clients branch, lands in the primary-GM switch).
    CAMP.Socket.send(CAMP.MSG.GATHERING_RESULT, { actorId: _actorId, score: _score, taste });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  // Shared owner rule (camp-minigame-sync.js): Spectator decider, else primary GM.
  function _getOwnerUserId(actor) {
    return CAMP.MG?.ownerUserId?.(actor) ?? null;
  }

  function _isActorOwner(actor) {
    return CAMP.MG?.isOwner?.(actor) ?? false;
  }

  function _getTokenImg(actor) {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  CAMP.GatheringUI = {
    scoreResolvers:   {},
    proceedResolvers: {},

    // ── Stage 1 — Begin panel ─────────────────────────────────────────────────
    show(actorId, actorName) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId   = actorId;

      const actor = game.actors?.get(actorId);
      _isOwner    = actor ? _isActorOwner(actor) : false;
      _playerImg  = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";
      const pName = actor?.name ?? actorName ?? "?";

      const ovl = document.createElement("div");
      ovl.id    = OVL_ID;
      _stage    = "waiting";

      if (_isOwner) {
        ovl.innerHTML = `
          <div class="oni-gt-panel">
            <div class="oni-gt-title">🌿 Gathering</div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
              <img src="${_playerImg}" style="width:64px;height:64px;object-fit:contain;border:none;border-radius:0;">
              <span style="font-size:.82rem;color:#5a3010;font-weight:700;">${pName}</span>
            </div>
            <div class="oni-gt-sub">
              Move with <strong>arrow keys</strong> or <strong>WASD</strong>.<br>
              Collect ingredients, avoid poison!
            </div>
            <button class="oni-gt-begin-btn" id="oni-gt-begin-btn">Click to Begin</button>
          </div>
        `;
        document.body.appendChild(ovl);

        document.getElementById("oni-gt-begin-btn")?.addEventListener("click", () => {
          CAMP.GatheringUI.spectateBegin(_actorId);
          // send(): the local echo is a no-op (spectateBegin's stage guard).
          CAMP.Socket.send(CAMP.MSG.GATHERING_BEGIN, { actorId: _actorId });
        }, { once: true });

      } else {
        const ownerUid  = actor ? _getOwnerUserId(actor) : null;
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? "player") : "player";
        ovl.innerHTML = `
          <div class="oni-gt-panel">
            <div class="oni-gt-title">🌿 Gathering</div>
            <div class="oni-gt-waiting">Waiting for ${ownerName} to begin…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }
    },

    // ── Stage 2 — Countdown ───────────────────────────────────────────────────
    spectateBegin(actorId) {
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      // Once per game: the owner calls this directly and also gets its own
      // BEGIN echo; a replayed BEGIN must not restart a running game either.
      if (actorId && _actorId && actorId !== _actorId) return;
      if (_stage !== "waiting") return;
      _stage = "countdown";

      const actor = game.actors?.get(actorId ?? _actorId);
      const pImg  = actor ? _getTokenImg(actor) : _playerImg;
      const pName = actor?.name ?? "?";

      ovl.innerHTML = `
        <div class="oni-gt-panel">
          <div class="oni-gt-title">🌿 Gathering</div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
            <img src="${pImg}" style="width:56px;height:56px;object-fit:contain;border:none;border-radius:0;">
            <span style="font-size:.75rem;color:#5a3010;font-weight:700;">${pName}</span>
          </div>
          <div class="oni-gt-countdown-num" id="oni-gt-count">3</div>
        </div>
      `;

      _runCountdown(3, () => _showArena());
    },

    // ── Spectator live update ──────────────────────────────────────────────────
    onGameState(payload = {}) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      if (payload.actorId && payload.actorId !== _actorId) return;
      if (_gameOver) return;
      // Our countdown can still be running when the owner's first beats arrive.
      if (!_els.grid) { _pendingState = payload; return; }
      _applyState(payload);
    },

    // ── Stage 3 — Result reveal ────────────────────────────────────────────────
    applyResult(actorId, grade, taste) {
      if (_resultShown) return;
      _resultShown = true;
      _stage = "result";
      // A spectator whose timer lags the owner's: stop the board loop first.
      if (_rafId      !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
      if (_endTimer   !== null) { clearTimeout(_endTimer);      _endTimer = null; }
      _gameOver = true;

      _playSound(grade !== "standard" ? SFX.RESULT_GOOD : SFX.RESULT_BAD, 0.8);

      const actor    = game.actors?.get(actorId);
      const aName    = actor?.name ?? "The gatherer";
      const ingCount = grade === "standard" ? 2 : 3;

      const gradeLabel =
        grade === "exceptional" ? "Exceptional Haul!" :
        grade === "good"        ? "Looks Tasty!"       :
                                  "Will These Be Okay?";
      const gradeColor =
        grade === "exceptional" ? "#c8a84b" :
        grade === "good"        ? "#3a7a35" :
                                  "#7a5010";
      const tasteDesc =
        grade === "exceptional" && taste
          ? `with <strong>${taste}</strong> taste`
          : "with random tastes";
      const tasteHint =
        grade !== "exceptional"
          ? `<div style="font-size:.76em;opacity:.7;font-style:italic;margin-top:2px;">Roll 1d6 per ingredient — 1 Bitter · 2 Salty · 3 Sour · 4 Sweet · 5 Umami.</div>`
          : "";

      const ovl = document.getElementById(OVL_ID);
      if (ovl) ovl.innerHTML = "";

      const isOwnerNow = actor ? _isActorOwner(actor) : false;
      const panel      = document.createElement("div");
      panel.className  = "oni-gt-result-panel";
      panel.innerHTML  = `
        <div class="oni-gt-finished">Finished!</div>
        <div class="oni-gt-grade-txt" style="color:${gradeColor};">${gradeLabel}</div>
        <div class="oni-gt-effect-txt">
          ${aName} found <strong>${ingCount}</strong> ingredient${ingCount > 1 ? "s" : ""} ${tasteDesc}.
          ${tasteHint}
        </div>
        ${isOwnerNow ? `<button class="oni-gt-proceed-btn" id="oni-gt-proceed">Click to Proceed</button>` : ""}
      `;

      if (ovl) ovl.appendChild(panel);

      if (isOwnerNow) {
        document.getElementById("oni-gt-proceed")?.addEventListener("click", () => {
          document.getElementById("oni-gt-proceed").disabled = true;
          CAMP.Socket.send(CAMP.MSG.GATHERING_PROCEED, { actorId });
        }, { once: true });
      }
    },

    // ── Gate resolvers ─────────────────────────────────────────────────────────
    resolveScore(actorId, data) {
      const res = this.scoreResolvers?.[actorId];
      if (!res) return;
      delete this.scoreResolvers[actorId];
      res(data);
    },

    resolveProceed(actorId) {
      const res = this.proceedResolvers?.[actorId];
      if (!res) return;
      delete this.proceedResolvers[actorId];
      res();
    },

    // ── Dismiss ────────────────────────────────────────────────────────────────
    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-gt-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  // ===========================================================================
  // Spectator mirror of the taste picker + late join
  // ===========================================================================

  // kind "taste": { open:true } → owner opened the picker; { pick } → owner chose.
  CAMP.MG?.on?.("GATHERING", (kind, data, msg) => {
    if (kind !== "taste" || _isOwner) return;
    if (!document.getElementById(OVL_ID) || msg?.a !== _actorId || _resultShown) return;
    if (_stage !== "taste") {
      if (!_gameOver) _onGameEnd();   // owner's clock ran out first
      _renderTastePicker();
    }
    if (data?.pick) { _tastePicked = data.pick; _markTastePick(data.pick); }
  });

  CAMP.MG?.registerGame?.("GATHERING", {
    isOpen: () => !!document.getElementById(OVL_ID),
    snapshot() {
      if (!_isOwner || !document.getElementById(OVL_ID) || _resultShown) return null;
      if (_stage === "playing" && !_gameOver) return { ..._stateSnapshot(), phase: "playing" };
      if (_stage === "taste") return { actorId: _actorId, phase: "taste", pick: _tastePicked };
      if (_stage === "countdown") return { actorId: _actorId, phase: "countdown" };
      return null;
    },
    apply(snap) {
      if (!snap || _isOwner || snap.actorId !== _actorId) return;
      if (!document.getElementById(OVL_ID) || _resultShown) return;
      if (snap.phase === "countdown") {
        if (_stage === "waiting") CAMP.GatheringUI.spectateBegin(_actorId);
        return;
      }
      if (snap.phase === "taste") {
        if (_stage !== "taste") {
          if (_stage === "playing" && !_gameOver) _onGameEnd();
          _gameOver = true;
          _renderTastePicker();
        }
        if (snap.pick) { _tastePicked = snap.pick; _markTastePick(snap.pick); }
        return;
      }
      if (snap.phase !== "playing") return;
      // Skip any countdown still running here (it stops on the stage change).
      if (_stage === "waiting" || _stage === "countdown") _showArena();
      if (_stage === "playing") _applyState(snap, { quiet: true });
    },
  });

  console.debug(TAG, "Gathering UI loaded.");
})();
