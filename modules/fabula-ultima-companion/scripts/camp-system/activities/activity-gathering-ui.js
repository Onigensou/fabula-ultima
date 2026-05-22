// ============================================================================
// Camp Activity — Gathering UI
//
// Minigame: 4×4 grid ingredient collector (keyboard-driven, 15 s)
//
// Owner moves a token with arrow keys / WASD.
// Good ingredients (+1 score) and poisonous ingredients (-1, floor 0) spawn
// on empty cells and expire after a few seconds with a telegraph warning.
//
// Spectator sync: owner emits GATHERING_GAME_STATE on every move; spectators
// re-render player position, ingredient overlays, and score HUD from that.
//
// Flow: show() → spectateBegin() → _showArena() → game → _onGameEnd()
//       → taste picker (exceptional only) → submit score → applyResult()
//       → proceed → hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const TAG       = "[CampSystem][GatheringUI]";
  const OVL_ID    = "oni-camp-gt-ovl";
  const STYLE_ID  = "oni-camp-gt-style";

  // ── Constants ──────────────────────────────────────────────────────────────
  const GAME_MS        = 15_000;
  const GRID_COLS      = 4;
  const GRID_ROWS      = 4;
  const SPAWN_MIN_MS   = 1_500;
  const SPAWN_MAX_MS   = 2_000;
  const LIFE_MIN_MS    = 3_500;
  const LIFE_MAX_MS    = 5_000;
  const TELEGRAPH_MS   = 1_500;   // time before expiry when blinking starts
  const MAX_ACTIVE_ING = 4;
  const POISON_CHANCE  = 0.25;

  const GOOD_EMOJIS   = ["🌿","🫐","🌸","🍋","🍒","🌾","🍃","🌼"];
  const POISON_EMOJIS = ["🍄","🌵","💀","🧪"];
  const TASTES        = ["Bitter","Salty","Sour","Sweet","Umami"];

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
  let _ingredients  = new Map();  // id → { id, col, row, emoji, type, spawnMs, lifespanMs, el }
  let _nextIngId    = 0;
  let _gameStartMs  = null;
  let _rafId        = null;
  let _spawnTimer   = null;
  let _endTimer     = null;
  let _gameOver     = false;
  let _resultShown  = false;
  let _keyHandler   = null;
  let _lastLabelSec = -1;

  // ── Web Audio (movement sound) ─────────────────────────────────────────────
  let _audioCtx   = null;
  let _moveBuffer = null;

  // ── DOM refs (cached after arena render) ───────────────────────────────────
  const _els = { timerBar: null, timerLabel: null, scoreLabel: null, grid: null, game: null };

  // ===========================================================================
  // State reset
  // ===========================================================================

  function _clearState() {
    if (_rafId      !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer   !== null) { clearTimeout(_endTimer);      _endTimer = null; }
    if (_spawnTimer !== null) { clearTimeout(_spawnTimer);    _spawnTimer = null; }
    if (_keyHandler)          { document.removeEventListener("keydown", _keyHandler); _keyHandler = null; }

    _actorId      = null;
    _isOwner      = false;
    _playerImg    = "icons/svg/mystery-man.svg";
    _score        = 0;
    _playerPos    = { col: 1, row: 1 };
    _ingredients.clear();
    _nextIngId    = 0;
    _gameStartMs  = null;
    _gameOver     = false;
    _resultShown  = false;
    _lastLabelSec = -1;

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
      .oni-gt-title {
        font-size:1.4rem;font-weight:800;color:#6b3a1f;
        letter-spacing:.05em;text-transform:uppercase;
      }
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
      .oni-gt-game {
        display:flex;flex-direction:column;gap:10px;
        position:relative;
      }

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

      /* ── Grid ── */
      .oni-gt-grid {
        display:grid;
        grid-template-columns:repeat(4,70px);
        grid-template-rows:repeat(4,70px);
        gap:4px;
      }
      .oni-gt-cell {
        width:70px;height:70px;
        background:rgba(246,235,211,.1);
        border:2px solid rgba(141,95,56,.4);
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

      /* ── Ingredients ── */
      .oni-gt-ingredient {
        position:absolute;
        font-size:1.9rem;
        line-height:1;
        z-index:1;
        pointer-events:none;
        transition:opacity .15s;
      }
      .oni-gt-ingredient.good   { filter:drop-shadow(0 0 4px rgba(80,200,80,.6)); }
      .oni-gt-ingredient.poison { filter:drop-shadow(0 0 7px rgba(220,60,60,.8)); }
      .oni-gt-expiring {
        animation:oni-gt-blink .22s ease-in-out infinite;
      }
      @keyframes oni-gt-blink {
        0%,100% { opacity:1;transform:scale(1); }
        50%     { opacity:.25;transform:scale(.8); }
      }

      /* ── Cell flash on collect / poison ── */
      .oni-gt-flash-good { animation:oni-gt-flash-g .28s ease; }
      .oni-gt-flash-bad  { animation:oni-gt-flash-b .28s ease; }
      @keyframes oni-gt-flash-g {
        0%,100% { background:rgba(246,235,211,.1); }
        40%     { background:rgba(80,220,80,.35); }
      }
      @keyframes oni-gt-flash-b {
        0%,100% { background:rgba(246,235,211,.1); }
        40%     { background:rgba(220,60,60,.35); }
      }

      /* ── Controls hint / spectator label ── */
      .oni-gt-controls-hint,.oni-gt-spectator-label {
        font-size:.72rem;font-weight:600;color:rgba(246,235,211,.55);
        text-align:center;letter-spacing:.03em;margin-top:-2px;
      }

      /* ── Finished overlay on game container ── */
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
      .oni-gt-taste-grid {
        display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:4px;
      }
      .oni-gt-taste-btn {
        padding:7px 18px;
        background:rgba(246,235,211,.85);
        border:2px solid var(--camp-wood-2,#8d5f38);
        border-radius:8px;cursor:pointer;
        font-weight:700;font-size:.88rem;color:#5a3010;
        transition:background .12s,transform .1s;
      }
      .oni-gt-taste-btn:hover { background:#e8d2a0;transform:translateY(-2px); }

      /* ── Result panel ── */
      .oni-gt-result-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;padding:28px 36px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:12px;
        animation:oni-gt-slideup .4s ease forwards;min-width:300px;
      }
      .oni-gt-finished     { font-size:2.4rem;font-weight:900;color:#f4d488;text-shadow:0 0 24px rgba(244,212,136,.8);letter-spacing:.06em; }
      .oni-gt-grade-txt    { font-size:1.4rem;font-weight:800; }
      .oni-gt-effect-txt   { font-size:.88rem;color:#5a3010;text-align:center;line-height:1.4; }
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
        color:#ff6464;text-shadow:0 0 8px rgba(255,80,80,.8);
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
  // Arena HTML (shared between owner and spectator)
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
          <div class="oni-gt-timer-wrap">
            <div class="oni-gt-timer-bar" id="oni-gt-timer-bar"></div>
          </div>
          <div class="oni-gt-timer-label" id="oni-gt-timer-label">15s</div>
          <div class="oni-gt-hud-score" id="oni-gt-hud-score">Score: 0</div>
        </div>
        <div class="oni-gt-grid" id="oni-gt-grid">${cells.join("")}</div>
        ${hint}
      </div>
    `;
  }

  // ===========================================================================
  // Player rendering
  // ===========================================================================

  function _renderPlayer() {
    const cell = _getCellEl(_playerPos.col, _playerPos.row);
    if (!cell) return;
    const img     = document.createElement("img");
    img.className = "oni-gt-player";
    img.src       = _playerImg;
    img.alt       = "★";
    cell.appendChild(img);
  }

  function _movePlayerTo(col, row) {
    // Remove from old cell
    _getCellEl(_playerPos.col, _playerPos.row)
      ?.querySelector(".oni-gt-player")?.remove();

    _playerPos = { col, row };

    // Place in new cell with pop animation
    const cell = _getCellEl(col, row);
    if (cell) {
      const img     = document.createElement("img");
      img.className = "oni-gt-player";
      img.src       = _playerImg;
      img.alt       = "★";
      cell.appendChild(img);
      img.animate(
        [{ transform: "scale(.65)" }, { transform: "scale(1)" }],
        { duration: 90, easing: "ease-out" }
      );
    }
  }

  // ===========================================================================
  // Ingredient management
  // ===========================================================================

  function _renderIngredient(ing) {
    const cell = _getCellEl(ing.col, ing.row);
    if (!cell) return null;
    const el    = document.createElement("div");
    el.className = `oni-gt-ingredient ${ing.type}`;
    el.id        = `oni-gt-ing-${ing.id}`;
    el.textContent = ing.emoji;
    // spawn scale-in animation
    el.animate(
      [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 200, easing: "ease-out" }
    );
    cell.appendChild(el);
    return el;
  }

  function _trySpawnIngredient() {
    if (_ingredients.size >= MAX_ACTIVE_ING || _gameOver) return;

    const occupied = new Set(
      Array.from(_ingredients.values()).map(i => `${i.col},${i.row}`)
    );
    occupied.add(`${_playerPos.col},${_playerPos.row}`);

    const empty = [];
    for (let c = 0; c < GRID_COLS; c++) {
      for (let r = 0; r < GRID_ROWS; r++) {
        if (!occupied.has(`${c},${r}`)) empty.push({ col: c, row: r });
      }
    }
    if (!empty.length) return;

    const pos      = empty[Math.floor(Math.random() * empty.length)];
    const isPoison = Math.random() < POISON_CHANCE;
    const pool     = isPoison ? POISON_EMOJIS : GOOD_EMOJIS;
    const emoji    = pool[Math.floor(Math.random() * pool.length)];
    const id       = _nextIngId++;
    const lifespan = LIFE_MIN_MS + Math.random() * (LIFE_MAX_MS - LIFE_MIN_MS);

    const ing = {
      id, col: pos.col, row: pos.row,
      emoji, type: isPoison ? "poison" : "good",
      spawnMs: Date.now(), lifespanMs: lifespan, el: null,
    };
    ing.el = _renderIngredient(ing);
    if (ing.el) _ingredients.set(id, ing);
  }

  function _scheduleNextSpawn() {
    if (_gameOver) return;
    const delay = SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
    _spawnTimer = setTimeout(() => {
      _trySpawnIngredient();
      _scheduleNextSpawn();
    }, delay);
  }

  function _checkIngredients(now) {
    for (const [id, ing] of _ingredients) {
      const remaining = ing.lifespanMs - (now - ing.spawnMs);
      if (remaining <= 0) {
        ing.el?.animate(
          [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.5)" }],
          { duration: 150, fill: "forwards" }
        ).finished.then(() => ing.el?.remove()).catch(() => ing.el?.remove());
        _ingredients.delete(id);
      } else if (remaining < TELEGRAPH_MS) {
        ing.el?.classList.add("oni-gt-expiring");
      }
    }
  }

  function _collectIngredient(ing) {
    ing.el?.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.5)" }],
      { duration: 150, fill: "forwards" }
    ).finished.then(() => ing.el?.remove()).catch(() => ing.el?.remove());
    _ingredients.delete(ing.id);

    if (ing.type === "poison") {
      _score = Math.max(0, _score - 1);
      _playSound(SFX.POISON, 0.7);
      _spawnScorePop("-1", true, ing.col, ing.row);
      _flashCell(ing.col, ing.row, "oni-gt-flash-bad");
    } else {
      _score++;
      _playSound(SFX.COLLECT, 0.6);
      _spawnScorePop("+1", false, ing.col, ing.row);
      _flashCell(ing.col, ing.row, "oni-gt-flash-good");
    }

    if (_els.scoreLabel) _els.scoreLabel.textContent = `Score: ${_score}`;
  }

  // ===========================================================================
  // Visual feedback
  // ===========================================================================

  function _spawnScorePop(label, isWrong, col, row) {
    const cell = _getCellEl(col, row);
    if (!cell) return;
    const rect       = cell.getBoundingClientRect();
    const txt        = document.createElement("div");
    txt.className    = isWrong ? "oni-gt-wrong-pop" : "oni-gt-score-pop";
    txt.textContent  = label;
    txt.style.left   = `${rect.left + rect.width  / 2}px`;
    txt.style.top    = `${rect.top}px`;
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
  // rAF game loop (timer bar + ingredient expiry check)
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
      if (sec !== _lastLabelSec) {
        _lastLabelSec = sec;
        lbl.textContent = `${sec}s`;
      }
      if (_isOwner) _checkIngredients(Date.now());
      _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);
  }

  // ===========================================================================
  // Keyboard input
  // ===========================================================================

  function _onKey(e) {
    if (_gameOver || !_isOwner) return;
    let dc = 0, dr = 0;
    switch (e.key) {
      case "ArrowUp":    case "w": case "W": dr = -1; break;
      case "ArrowDown":  case "s": case "S": dr =  1; break;
      case "ArrowLeft":  case "a": case "A": dc = -1; break;
      case "ArrowRight": case "d": case "D": dc =  1; break;
      default: return;
    }
    e.preventDefault();

    const nc = _playerPos.col + dc;
    const nr = _playerPos.row + dr;
    if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) return;

    _playMove();
    _movePlayerTo(nc, nr);

    // Collect ingredient on landing cell
    const hit = Array.from(_ingredients.values()).find(i => i.col === nc && i.row === nr);
    if (hit) _collectIngredient(hit);

    _emitGameState();
  }

  // ===========================================================================
  // State broadcast to spectators
  // ===========================================================================

  function _emitGameState() {
    const now = Date.now();
    CAMP.Socket.emit(CAMP.MSG.GATHERING_GAME_STATE, {
      actorId:     _actorId,
      playerPos:   { ..._playerPos },
      ingredients: Array.from(_ingredients.values()).map(ing => ({
        id:        ing.id,
        col:       ing.col,
        row:       ing.row,
        emoji:     ing.emoji,
        type:      ing.type,
        remaining: ing.lifespanMs - (now - ing.spawnMs),
      })),
      score: _score,
    });
  }

  // ===========================================================================
  // Countdown (expects #oni-gt-count to exist in current overlay)
  // ===========================================================================

  function _runCountdown(count, onDone) {
    const el = document.getElementById("oni-gt-count");
    if (el) {
      el.textContent = count;
      el.className   = "oni-gt-countdown-num";
      void el.offsetWidth; // restart CSS pop animation (pre-game, not hot path)
    }
    _playSound(SFX.COUNTDOWN, 0.8);
    if (count > 1) {
      setTimeout(() => _runCountdown(count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el2 = document.getElementById("oni-gt-count");
        if (el2) { el2.className = "oni-gt-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  // ===========================================================================
  // Arena start (called after countdown on all clients)
  // ===========================================================================

  function _showArena() {
    const ovl = document.getElementById(OVL_ID);
    if (!ovl) return;

    ovl.innerHTML = _buildArenaHTML();
    _cacheEls();

    if (_isOwner) _renderPlayer();  // spectators wait for first onGameState

    _gameStartMs  = Date.now();
    _lastLabelSec = -1;
    _startGameLoop();

    _endTimer = setTimeout(() => _onGameEnd(), GAME_MS);

    if (_isOwner) {
      _initWebAudio();  // fire-and-forget; move sound available within countdown window
      _scheduleNextSpawn();
      _keyHandler = e => _onKey(e);
      document.addEventListener("keydown", _keyHandler);
    }
  }

  // ===========================================================================
  // Game end
  // ===========================================================================

  function _onGameEnd() {
    _gameOver = true;
    if (_rafId      !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_spawnTimer !== null) { clearTimeout(_spawnTimer);    _spawnTimer = null; }
    if (_keyHandler)          { document.removeEventListener("keydown", _keyHandler); _keyHandler = null; }

    if (_els.timerBar)   _els.timerBar.style.width = "0%";
    if (_els.timerLabel) _els.timerLabel.textContent = "0s";

    // "Time's Up!" overlay on the game container
    const gp = _els.game;
    if (gp) {
      const fin      = document.createElement("div");
      fin.className  = "oni-gt-finished-overlay";
      fin.innerHTML  = `<div class="oni-gt-finished-txt">Time's Up!</div>`;
      gp.appendChild(fin);
    }

    // Only the owner submits a score; spectators wait for GATHERING_RESULT broadcast
    if (_isOwner) setTimeout(() => _showTastePickerOrSubmit(), 700);
  }

  // ===========================================================================
  // Taste picker (exceptional only) → score submission
  // ===========================================================================

  function _showTastePickerOrSubmit() {
    if (_score >= 6) {
      // Exceptional — ask player to choose taste
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      ovl.innerHTML = `
        <div class="oni-gt-panel">
          <div class="oni-gt-title">🌿 Exceptional Haul!</div>
          <div class="oni-gt-sub">You gathered so much!<br>Choose a taste for your ingredients:</div>
          <div class="oni-gt-taste-grid">
            ${TASTES.map(t => `<button class="oni-gt-taste-btn" data-taste="${t}">${t}</button>`).join("")}
          </div>
        </div>
      `;
      ovl.querySelectorAll(".oni-gt-taste-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          _submitScore(btn.dataset.taste);
          // Disable all taste buttons to prevent double-submit
          ovl.querySelectorAll(".oni-gt-taste-btn").forEach(b => { b.disabled = true; });
        }, { once: true });
      });
    } else {
      _submitScore(null);
    }
  }

  function _submitScore(taste) {
    if (game.user?.isGM) {
      CAMP.GatheringUI.resolveScore(_actorId, { score: _score, taste });
    } else {
      CAMP.Socket.emit(CAMP.MSG.GATHERING_RESULT, { actorId: _actorId, score: _score, taste });
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

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

  // ===========================================================================
  // Public API
  // ===========================================================================

  CAMP.GatheringUI = {
    scoreResolvers:   {},
    proceedResolvers: {},

    // ── Stage 1 — Begin panel (all clients) ──────────────────────────────────
    show(actorId, actorName) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor  = game.actors?.get(actorId);
      _isOwner     = actor ? _isActorOwner(actor) : false;
      _playerImg   = actor ? _getTokenImg(actor) : "icons/svg/mystery-man.svg";

      const pName  = actor?.name ?? actorName ?? "?";
      const ovl    = document.createElement("div");
      ovl.id       = OVL_ID;

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
          // Owner starts their own countdown immediately (no socket echo)
          CAMP.GatheringUI.spectateBegin(_actorId);
          // Broadcast to all other clients
          CAMP.Socket.emit(CAMP.MSG.GATHERING_BEGIN, { actorId: _actorId });
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

    // ── Stage 2 — Countdown (all clients simultaneously) ─────────────────────
    spectateBegin(actorId) {
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;

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

    // ── Spectator live state update (per-move from owner) ─────────────────────
    onGameState({ actorId, playerPos, ingredients, score } = {}) {
      if (_isOwner) return;          // owner handles locally
      if (!_els.grid) return;        // arena not rendered yet (still in countdown)

      // Move player token
      _els.grid.querySelectorAll(".oni-gt-player").forEach(el => el.remove());
      const pCell = _getCellEl(playerPos.col, playerPos.row);
      if (pCell) {
        const img     = document.createElement("img");
        img.className = "oni-gt-player";
        img.src       = _playerImg;
        pCell.appendChild(img);
      }

      // Rebuild ingredient overlays
      _els.grid.querySelectorAll(".oni-gt-ingredient").forEach(el => el.remove());
      for (const ing of (ingredients ?? [])) {
        const cell = _getCellEl(ing.col, ing.row);
        if (!cell) continue;
        const el    = document.createElement("div");
        el.className = `oni-gt-ingredient ${ing.type}${ing.remaining < TELEGRAPH_MS ? " oni-gt-expiring" : ""}`;
        el.textContent = ing.emoji;
        cell.appendChild(el);
      }

      // Score HUD
      if (_els.scoreLabel) _els.scoreLabel.textContent = `Score: ${score}`;
    },

    // ── Stage 3 — Result reveal (all clients) ─────────────────────────────────
    applyResult(actorId, grade, taste) {
      if (_resultShown) return;
      _resultShown = true;

      _playSound(grade !== "standard" ? SFX.RESULT_GOOD : SFX.RESULT_BAD, 0.8);

      const actor  = game.actors?.get(actorId);
      const aName  = actor?.name ?? "The gatherer";
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

      const effectTxt = `${aName} found <strong>${ingCount}</strong> ingredient${ingCount > 1 ? "s" : ""} ${tasteDesc}.`;

      const ovl = document.getElementById(OVL_ID);
      if (ovl) ovl.innerHTML = "";

      const isOwnerNow = actor ? _isActorOwner(actor) : false;
      const panel      = document.createElement("div");
      panel.className  = "oni-gt-result-panel";
      panel.innerHTML  = `
        <div class="oni-gt-finished">Finished!</div>
        <div class="oni-gt-grade-txt" style="color:${gradeColor};">${gradeLabel}</div>
        <div class="oni-gt-effect-txt">${effectTxt}${tasteHint}</div>
        ${isOwnerNow ? `<button class="oni-gt-proceed-btn" id="oni-gt-proceed">Click to Proceed</button>` : ""}
      `;

      if (ovl) ovl.appendChild(panel);

      if (isOwnerNow) {
        document.getElementById("oni-gt-proceed")?.addEventListener("click", () => {
          document.getElementById("oni-gt-proceed").disabled = true;
          if (game.user?.isGM) {
            CAMP.GatheringUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.GATHERING_PROCEED, { actorId });
          }
        }, { once: true });
      }
    },

    // ── Gate resolvers ────────────────────────────────────────────────────────
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

    // ── Dismiss ───────────────────────────────────────────────────────────────
    hide() {
      _clearState();
      const el = document.getElementById(OVL_ID);
      if (!el) return;
      el.classList.add("oni-gt-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Gathering UI loaded.");
})();
