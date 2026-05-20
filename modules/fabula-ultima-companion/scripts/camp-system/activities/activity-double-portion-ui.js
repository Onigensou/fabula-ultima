// ============================================================================
// Camp Activity — Double Portion UI  (performance-optimised)
//
// Key optimisation decisions (see inline comments for detail):
//
//  1. ELEMENT CACHE (_els, _cellEls, _bubbleItemEls)
//       Every DOM element used during gameplay is looked up once and stored.
//       Zero getElementById / querySelector calls after game start.
//
//  2. EVENT DELEGATION
//       Single dragstart + dragend on gridWrap; feedZone listeners attached
//       once.  No per-cell listeners, no reattachment after every drop.
//
//  3. WEB ANIMATIONS API
//       Fall-in, ally eating/happy, and particles all use el.animate().
//       Avoids the void-offsetWidth forced-reflow needed to restart CSS
//       class animations and runs on the compositor thread.
//
//  4. PARTICLE POOL
//       12 pre-created fixed-position elements reused by index.  No DOM
//       create/destroy per drop.
//
//  5. AUDIO POOL
//       Pre-loaded Audio nodes per hot SFX (SUCCESS, FAIL, EATING).
//       Round-robin reuse for polyphonic playback.
//
//  6. PRE-COMPUTED ORDERS
//       40 orders shuffled at countdown start; _nextOrder() just advances an
//       index.  No mid-game Math.random() array allocation.
//
//  7. CACHED BOUNDING RECTS
//       feedZoneRect + allyTokenRect computed once after layout is stable.
//       No per-drop getBoundingClientRect().
//
//  8. rAF CLOSURE CAPTURE
//       bar / lbl captured in closure before loop starts.  Timer label
//       text throttled to 1 Hz (only 15 writes total in 15 s).
//
//  9. BUBBLE DIFF UPDATE
//       _updateBubble() rebuilds innerHTML only when order length changes
//       (new order); within an order it just toggles classList.filled.
//
// 10. _guardGrid() DOM-SYNC
//       When _cellEls is live, _guardGrid() patches changed cells directly
//       without re-rendering the whole grid.
//
// 11. ORDER / INIT FIX
//       Correct sequence: _nextOrder() (sets _order) → _initGrid() (fills
//       _grid, calls _guardGrid() with a real grid).
//
// CSS: will-change:transform on cells; contain:layout style on grid-wrap.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][DoublePortionUI]";
  const OVL_ID    = "oni-camp-dp-ovl";
  const STYLE_ID  = "oni-camp-dp-style";

  const DP_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rose/RoseSkill2.png";

  const SFX = {
    SUCCESS:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    FAIL:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    EATING:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Eating.mp3",
    RESULT_GOOD: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
    RESULT_BAD:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/fumble_1.WAV",
    COUNTDOWN:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:          "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
  };

  // ── Food & grid constants ─────────────────────────────────────────────────
  const FOODS     = ["🍖","🧀","🥕","🍞","🍎","🍳","🥩","🐟"];
  const GRID_COLS = 5;
  const GRID_ROWS = 4;
  const GAME_MS   = 15_000;

  // Particle burst colours (pre-allocated string array — no per-frame alloc)
  const _PCOLS = ["#f4d488","#ffe566","#c8a84b","#ffcc44","#aaffaa","#ff9944"];

  // ── Runtime state ─────────────────────────────────────────────────────────
  let _actorId     = null;
  let _targetId    = null;
  let _isOwner     = false;
  let _score       = 0;
  let _wrong       = 0;
  let _gameStartMs = null;
  let _rafId       = null;
  let _endTimer    = null;
  let _resultShown = false;
  let _gameOver    = false;

  // Flat grid [col*GRID_ROWS + row]; current order [{food,filled}]; drag state
  let _grid     = [];
  let _order    = [];
  let _dragging = null;

  // ── Pre-computed order queue ──────────────────────────────────────────────
  let _orderQueue = [];   // 40 pre-generated order arrays, made at countdown start
  let _orderIdx   = 0;

  // ── DOM element cache ─────────────────────────────────────────────────────
  // Populated by _cacheEls() once after _buildArena HTML is injected.
  // Nothing inside _handleDrop or the rAF loop may call getElementById.
  const _els = {
    timerBar:   null,
    timerLabel: null,
    score:      null,
    bubble:     null,
    allyToken:  null,
    feedZone:   null,
    gridWrap:   null,
    game:       null,
  };
  let _cellEls       = null;  // [col*GRID_ROWS + row] → HTMLElement
  let _bubbleItemEls = [];    // [i] → <span class="oni-dp-bubble-item">

  // Static bounding rects — feed zone and ally token don't move in fixed overlay
  let _feedZoneRect  = null;
  let _allyTokenRect = null;

  // ── Audio pool ────────────────────────────────────────────────────────────
  const _audioPools = {};   // src → Audio[]

  // ── Particle pool ─────────────────────────────────────────────────────────
  let _particlePool = null; // Array<HTMLElement> — 12 nodes, persistent across games
  let _particleIdx  = 0;

  // ── rAF label throttle ────────────────────────────────────────────────────
  let _lastLabelSec = -1;

  // ===========================================================================
  // State reset
  // ===========================================================================

  function _clearState() {
    if (_rafId    !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer);       _endTimer = null; }
    _actorId     = null;
    _targetId    = null;
    _isOwner     = false;
    _score       = 0;
    _wrong       = 0;
    _gameStartMs = null;
    _resultShown = false;
    _gameOver    = false;
    _grid        = [];
    _order       = [];
    _dragging    = null;
    _orderQueue  = [];
    _orderIdx    = 0;
    _lastLabelSec = -1;
    // Clear element cache — game DOM is being torn down
    for (const k of Object.keys(_els)) _els[k] = null;
    _cellEls       = null;
    _bubbleItemEls = [];
    _feedZoneRect  = null;
    _allyTokenRect = null;
    // Particle pool persists; hide any still-visible particles
    _particlePool?.forEach(p => { p.style.display = "none"; });
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

  // Pre-create Audio nodes for hot SFX so they can start without startup latency.
  // Called once during the 3+ second countdown so loading happens off the hot path.
  function _initAudioPool() {
    const POOLS = [
      [SFX.SUCCESS, 0.6,  3],
      [SFX.FAIL,    0.7,  3],
      [SFX.EATING,  0.75, 2],
    ];
    for (const [src, vol, n] of POOLS) {
      if (_audioPools[src]) continue;
      _audioPools[src] = [];
      for (let i = 0; i < n; i++) {
        try {
          const a = new Audio(src);
          a.preload = "auto";
          a.volume  = vol;
          _audioPools[src].push(a);
        } catch {}
      }
    }
  }

  // Play from pool (reuse a paused/ended node) or fall back to _playSound.
  function _playPooled(src, vol) {
    const pool = _audioPools[src];
    if (pool?.length) {
      const a = pool.find(x => x.paused || x.ended) ?? pool[0];
      try { a.currentTime = 0; a.play().catch(() => {}); return; } catch {}
    }
    _playSound(src, vol);
  }

  // ===========================================================================
  // Particle pool
  // ===========================================================================

  // Created lazily on first showArena; persists for the session.
  function _initParticlePool() {
    if (_particlePool) return;
    _particlePool = [];
    _particleIdx  = 0;
    for (let i = 0; i < 12; i++) {
      const p       = document.createElement("div");
      p.className   = "oni-dp-particle";
      p.style.display = "none";
      document.body.appendChild(p);
      _particlePool.push(p);
    }
  }

  // ===========================================================================
  // Pre-computed orders
  // ===========================================================================

  // Generate 40 orders upfront during countdown — no shuffling mid-game.
  function _precomputeOrders() {
    _orderQueue = [];
    for (let i = 0; i < 40; i++) {
      const count = 1 + Math.floor(Math.random() * 3);
      const pool  = _shuffle([...FOODS]).slice(0, count);
      _orderQueue.push(pool.map(food => ({ food, filled: false })));
    }
    _orderIdx = 0;
  }

  // Advance to next pre-computed order (deep-copy so filled flags start false).
  function _nextOrder() {
    const src =
      _orderIdx < _orderQueue.length
        ? _orderQueue[_orderIdx++]
        : _shuffle([...FOODS]).slice(0, 1 + Math.floor(Math.random() * 3))
            .map(f => ({ food: f, filled: false }));
    _order = src.map(o => ({ food: o.food, filled: false }));
    // Caller is responsible for calling _guardGrid() after _grid is populated
  }

  // Bundle — called during countdown so everything is ready before game start
  function _initGameAssets() {
    _initAudioPool();
    _initParticlePool();
    _precomputeOrders();
  }

  // ===========================================================================
  // Grid helpers
  // ===========================================================================

  function _cellKey(col, row) { return col * GRID_ROWS + row; }

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Initialise grid array with random foods, then guard it.
  // Must be called AFTER _nextOrder() so _order is set when _guardGrid runs.
  function _initGrid() {
    _grid = Array.from(
      { length: GRID_COLS * GRID_ROWS },
      () => FOODS[Math.floor(Math.random() * FOODS.length)]
    );
    _guardGrid();
  }

  // Ensure every still-needed order food is present in _grid.
  // When _cellEls is live (mid-game), also patches changed cells in the DOM
  // inline — no re-render required.
  function _guardGrid() {
    const needed = _order.filter(o => !o.filled).map(o => o.food);
    for (const food of needed) {
      if (_grid.includes(food)) continue;
      // Prefer replacing a cell that isn't a needed food; fallback to any
      let idx = _grid.findIndex(f => !needed.includes(f));
      if (idx === -1) idx = Math.floor(Math.random() * _grid.length);
      _grid[idx] = food;
      if (_cellEls?.[idx]) _cellEls[idx].textContent = food;
    }
  }

  // Remove cell at (col, row): shift column down, spawn new food at top.
  function _removeCell(col, row) {
    for (let r = row; r > 0; r--) {
      _grid[_cellKey(col, r)] = _grid[_cellKey(col, r - 1)];
    }
    _grid[_cellKey(col, 0)] = FOODS[Math.floor(Math.random() * FOODS.length)];
    _guardGrid(); // may patch other columns' DOM cells if a needed food vanished
  }

  // ===========================================================================
  // DOM cache setup  (called once after _buildArena HTML is inserted)
  // ===========================================================================

  function _cacheEls() {
    _els.timerBar   = document.getElementById("oni-dp-timer-bar");
    _els.timerLabel = document.getElementById("oni-dp-timer-label");
    _els.score      = document.getElementById("oni-dp-hud-score");
    _els.bubble     = document.getElementById("oni-dp-order-bubble");
    _els.allyToken  = document.getElementById("oni-dp-ally-token");
    _els.feedZone   = document.getElementById("oni-dp-feed-zone");
    _els.gridWrap   = document.getElementById("oni-dp-grid-wrap");
    _els.game       = document.getElementById("oni-dp-game");
  }

  // Build flat map of cell elements after innerHTML is written.
  function _buildCellMap() {
    _cellEls = new Array(GRID_COLS * GRID_ROWS);
    _els.gridWrap.querySelectorAll(".oni-dp-cell").forEach(el => {
      _cellEls[_cellKey(+el.dataset.col, +el.dataset.row)] = el;
    });
  }

  // Cache static bounding rects; overlay is position:fixed so they don't drift.
  function _cacheRects() {
    _feedZoneRect  = _els.feedZone?.getBoundingClientRect()  ?? null;
    _allyTokenRect = _els.allyToken?.getBoundingClientRect() ?? null;
  }

  // ===========================================================================
  // Grid DOM
  // ===========================================================================

  // Full grid render — called ONCE at game start (not on each new order).
  function _renderGrid() {
    const rows = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const cells = [];
      for (let c = 0; c < GRID_COLS; c++) {
        cells.push(`<div class="oni-dp-cell" data-col="${c}" data-row="${r}" draggable="true">${_grid[_cellKey(c, r)]}</div>`);
      }
      rows.push(`<div class="oni-dp-grid-row">${cells.join("")}</div>`);
    }
    _els.gridWrap.innerHTML = rows.join("");
    _buildCellMap();
  }

  // Update a single column after a drop via cached element refs + Web Animations.
  // No querySelectorAll, no handler reattachment.
  function _refreshColumn(col) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const el = _cellEls[_cellKey(col, r)];
      if (!el) continue;
      el.textContent = _grid[_cellKey(col, r)];
      if (r === 0) {
        // Web Animations API — compositor-threaded, no forced reflow
        el.animate(
          [{ transform: "translateY(-44px)", opacity: 0 },
           { transform: "translateY(0)",     opacity: 1 }],
          { duration: 220, easing: "ease-out" }
        );
      }
    }
  }

  // ===========================================================================
  // Bubble
  // ===========================================================================

  // Rebuild only when order length changes; otherwise just toggle .filled.
  function _updateBubble() {
    if (!_els.bubble) return;
    if (_bubbleItemEls.length !== _order.length) {
      _els.bubble.innerHTML = _order.map(o =>
        `<span class="oni-dp-bubble-item${o.filled ? " filled" : ""}">${o.food}</span>`
      ).join("");
      _bubbleItemEls = Array.from(_els.bubble.querySelectorAll(".oni-dp-bubble-item"));
    } else {
      for (let i = 0; i < _order.length; i++) {
        _bubbleItemEls[i].textContent = _order[i].food;
        _bubbleItemEls[i].classList.toggle("filled", _order[i].filled);
      }
    }
  }

  // ===========================================================================
  // Event delegation — one-time setup per game
  // ===========================================================================

  function _buildGameHandlers(actorId) {
    const wrap = _els.gridWrap;
    const fz   = _els.feedZone;
    if (!wrap || !fz) return;

    // Single delegated dragstart on the grid wrapper — no per-cell listeners
    wrap.addEventListener("dragstart", e => {
      const cell = e.target.closest?.(".oni-dp-cell");
      if (!cell || _gameOver) return;
      const col = +cell.dataset.col;
      const row = +cell.dataset.row;
      _dragging = { food: _grid[_cellKey(col, row)], col, row };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", _dragging.food);
      cell.classList.add("dragging-src");
    });

    wrap.addEventListener("dragend", e => {
      e.target.closest?.(".oni-dp-cell")?.classList.remove("dragging-src");
      _dragging = null;
    });

    // Feed zone — attached once
    fz.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      fz.classList.add("drag-over");
    });
    fz.addEventListener("dragleave", () => fz.classList.remove("drag-over"));
    fz.addEventListener("drop", e => {
      e.preventDefault();
      fz.classList.remove("drag-over");
      if (_dragging) { _handleDrop(_dragging.food, _dragging.col, _dragging.row); _dragging = null; }
    });
  }

  // ===========================================================================
  // Drop handler
  // ===========================================================================

  function _handleDrop(food, col, row) {
    if (!_isOwner || _gameOver) return;
    const orderItem = _order.find(o => !o.filled);
    if (!orderItem) return;

    if (food === orderItem.food) {
      // ── Correct ────────────────────────────────────────────────────────────
      _score++;
      orderItem.filled = true;

      _playPooled(SFX.EATING,  0.75);
      _playPooled(SFX.SUCCESS, 0.6);

      // Ally animation via Web Animations API — no void-offsetWidth reflow
      const at = _els.allyToken;
      if (at) {
        at.animate(
          [{ transform: "scale(1)" },
           { transform: "scale(1.18) translateY(-6px)", offset: 0.3 },
           { transform: "scale(1)" }],
          { duration: 350, easing: "ease" }
        ).finished.then(() =>
          at.animate(
            [{ transform: "scale(1)" },
             { transform: "scale(1.15) rotate(-5deg)", offset: 0.2 },
             { transform: "scale(1.15) rotate(5deg)",  offset: 0.6 },
             { transform: "scale(1)" }],
            { duration: 400, easing: "ease" }
          )
        ).catch(() => {});
      }

      _removeCell(col, row);  // updates _grid + _guardGrid (may patch other cells)
      _refreshColumn(col);    // syncs column DOM from _cellEls

      _updateBubble();
      _spawnScorePop("+1", false);
      _spawnAllyParticles();

      if (_order.every(o => o.filled)) {
        // Wait briefly then advance to next order — no full grid re-render needed
        setTimeout(() => {
          _nextOrder();    // advance pre-computed queue
          _guardGrid();    // ensure needed foods exist; patches DOM inline
          _updateBubble(); // rebuild bubble for new order length
        }, 500);
      }

    } else {
      // ── Wrong ──────────────────────────────────────────────────────────────
      _wrong++;
      _score = Math.max(0, _score - 1);

      _playPooled(SFX.FAIL, 0.7);

      const fz = _els.feedZone;
      if (fz) {
        fz.classList.add("feed-wrong");
        fz.addEventListener("animationend", () => fz.classList.remove("feed-wrong"), { once: true });
      }
      _spawnScorePop("-1", true);
    }

    // Score HUD update via cached ref — no getElementById
    if (_els.score) _els.score.textContent = `Score: ${_score} | ✗: ${_wrong}`;
  }

  // ===========================================================================
  // Particles — pooled DOM nodes + Web Animations API
  // ===========================================================================

  function _spawnAllyParticles() {
    if (!_allyTokenRect || !_particlePool) return;
    const cx = _allyTokenRect.left + _allyTokenRect.width  / 2;
    const cy = _allyTokenRect.top  + _allyTokenRect.height / 2;

    for (let i = 0; i < 10; i++) {
      const p   = _particlePool[(_particleIdx + i) % _particlePool.length];
      const ang = (i / 10) * Math.PI * 2;
      const r   = 24 + Math.random() * 20;
      const px  = (Math.cos(ang) * r).toFixed(1);
      const py  = (Math.sin(ang) * r).toFixed(1);

      p.style.cssText = `display:block;left:${cx - 3}px;top:${cy - 3}px;background:${_PCOLS[i % _PCOLS.length]};`;

      p.animate(
        [{ transform: "translate(0,0) scale(1)", opacity: 1 },
         { transform: `translate(${px}px,${py}px) scale(0)`, opacity: 0 }],
        { duration: 420, easing: "ease-out", fill: "forwards" }
      ).finished.then(() => { p.style.display = "none"; }).catch(() => {});
    }
    _particleIdx = (_particleIdx + 10) % _particlePool.length;
  }

  // Score/wrong pop — uses cached feed zone rect (no getBoundingClientRect call)
  function _spawnScorePop(label, isWrong) {
    if (!_feedZoneRect) return;
    const txt       = document.createElement("div");
    txt.className   = isWrong ? "oni-dp-wrong-pop" : "oni-dp-score-pop";
    txt.textContent = label;
    txt.style.left  = `${_feedZoneRect.left + _feedZoneRect.width / 2}px`;
    txt.style.top   = `${_feedZoneRect.top}px`;
    document.body.appendChild(txt);
    setTimeout(() => txt.remove(), 580);
  }

  // ===========================================================================
  // rAF timer — closure-captured refs, label throttled to 1 Hz
  // ===========================================================================

  function _startGameLoop() {
    // Capture refs in closure so the inner _frame function never calls getElementById
    const bar = _els.timerBar;
    const lbl = _els.timerLabel;

    function _frame() {
      if (!_els.game) return; // overlay removed
      const elapsed = Date.now() - _gameStartMs;
      const frac    = Math.max(0, 1 - elapsed / GAME_MS);
      bar.style.width = `${(frac * 100).toFixed(2)}%`;
      // Label update throttled: at most 15 text writes over the whole game
      const sec = Math.ceil(frac * GAME_MS / 1000);
      if (sec !== _lastLabelSec) {
        _lastLabelSec = sec;
        lbl.textContent = `${sec}s`;
      }
      _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);
  }

  // ===========================================================================
  // End game — submit score to GM
  // ===========================================================================

  function _endGame(actorId) {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    const actor = game.actors?.get(actorId);
    if (actor && _isActorOwner(actor)) {
      if (game.user?.isGM) {
        CAMP.DoublePortionUI.resolveScore(actorId, { score: _score, wrong: _wrong });
      } else {
        CAMP.Socket.emit(CAMP.MSG.DOUBLE_PORTION_RESULT, { actorId, score: _score, wrong: _wrong });
      }
    }
  }

  // ===========================================================================
  // Countdown
  // ===========================================================================

  function _runCountdown(count, onDone) {
    const el = document.getElementById("oni-dp-count");
    if (el) {
      el.textContent = count;
      el.className   = "oni-dp-countdown-num";
      void el.offsetWidth; // restart CSS pop animation (acceptable: pre-game, not hot path)
    }
    _playSound(SFX.COUNTDOWN, 0.8);
    if (count > 1) {
      setTimeout(() => _runCountdown(count - 1, onDone), 1000);
    } else {
      setTimeout(() => {
        const el2 = document.getElementById("oni-dp-count");
        if (el2) { el2.className = "oni-dp-go-text"; el2.textContent = "GO!"; }
        _playSound(SFX.GO, 0.9);
        setTimeout(onDone, 700);
      }, 1000);
    }
  }

  // ===========================================================================
  // Arena HTML
  // ===========================================================================

  function _buildArena(actorId, targetActorId) {
    const actor  = game.actors?.get(actorId);
    const target = game.actors?.get(targetActorId);
    const pImg   = actor  ? _getTokenImg(actor)  : "icons/svg/mystery-man.svg";
    const aImg   = target ? _getTokenImg(target) : "icons/svg/mystery-man.svg";
    const pName  = actor?.name  ?? "?";
    const aName  = target?.name ?? "?";

    return `
      <div class="oni-dp-game" id="oni-dp-game">
        <div class="oni-dp-hud-row">
          <div class="oni-dp-timer-wrap">
            <div class="oni-dp-timer-bar" id="oni-dp-timer-bar"></div>
          </div>
          <div class="oni-dp-timer-label" id="oni-dp-timer-label">15s</div>
          <div class="oni-dp-hud-score"   id="oni-dp-hud-score">Score: 0 | ✗: 0</div>
        </div>
        <div class="oni-dp-grid-wrap" id="oni-dp-grid-wrap"></div>
        <div class="oni-dp-bottom-row">
          <div class="oni-dp-player-area">
            <img src="${pImg}" class="oni-dp-actor-img" alt="${pName}">
            <span class="oni-dp-actor-label">${pName}</span>
          </div>
          <div class="oni-dp-feed-zone" id="oni-dp-feed-zone">
            <span class="oni-dp-feed-icon">🍽️</span>
            <span class="oni-dp-feed-label">Drop here</span>
          </div>
          <div class="oni-dp-ally-area">
            <div class="oni-dp-bubble" id="oni-dp-order-bubble"></div>
            <img src="${aImg}" class="oni-dp-actor-img oni-dp-ally-token" id="oni-dp-ally-token" alt="${aName}">
            <span class="oni-dp-actor-label">${aName}</span>
          </div>
        </div>
      </div>
    `;
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
        animation:oni-dp-fadein 0.35s ease forwards;
        font-family:"Signika","Noto Sans","Inter",system-ui,sans-serif;
      }
      #${OVL_ID}.oni-dp-out { animation:oni-dp-fadeout 0.3s ease forwards; }
      @keyframes oni-dp-fadein  { from{opacity:0}to{opacity:1} }
      @keyframes oni-dp-fadeout { from{opacity:1}to{opacity:0} }
      @keyframes oni-dp-slideup { from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)} }
      @keyframes oni-dp-pop     { from{transform:scale(1.55)}to{transform:scale(1)} }

      /* ── Shared picker / countdown panel ── */
      .oni-dp-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;padding:24px 28px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:14px;
        animation:oni-dp-slideup 0.3s ease forwards;
      }
      .oni-dp-title {
        font-size:1.4rem;font-weight:800;color:#6b3a1f;
        letter-spacing:.05em;text-transform:uppercase;
        display:flex;align-items:center;gap:8px;
      }
      .oni-dp-title img { width:28px;height:28px;border-radius:4px;border:none; }
      .oni-dp-sub     { font-size:.95rem;color:#8a5c2c;font-style:italic; }
      .oni-dp-waiting { font-size:1rem;color:#c8a84b;font-style:italic; }

      /* ── Ally picker ── */
      .oni-dp-ally-grid { display:flex;flex-wrap:wrap;gap:12px;justify-content:center; }
      .oni-dp-ally-card {
        display:flex;flex-direction:column;align-items:center;gap:6px;
        background:var(--camp-parchment-2,#efdfc3);
        border:2px solid var(--camp-wood-2,#8d5f38);
        border-radius:10px;padding:10px 14px;cursor:pointer;
        transition:transform .15s,box-shadow .15s;min-width:88px;
      }
      .oni-dp-ally-card:hover { transform:translateY(-3px);box-shadow:0 6px 18px rgba(0,0,0,.35); }
      .oni-dp-ally-card img  { width:64px;height:64px;border:none;border-radius:0;background:transparent;object-fit:contain; }
      .oni-dp-ally-card span { font-size:.82rem;font-weight:700;color:#5a3010;text-align:center; }

      /* ── Countdown ── */
      .oni-dp-countdown-num {
        font-size:5rem;font-weight:900;color:#c8a84b;line-height:1;
        text-shadow:0 0 30px rgba(200,168,75,.7);animation:oni-dp-pop 0.25s ease;
      }
      .oni-dp-go-text {
        font-size:3.5rem;font-weight:900;color:#3a8a35;
        text-shadow:0 0 28px rgba(58,138,53,.8);animation:oni-dp-pop 0.3s ease;
      }

      /* ── Transparent compact game container ── */
      .oni-dp-game {
        display:flex;flex-direction:column;gap:10px;
        width:510px;position:relative;
        contain:layout;
      }

      /* HUD row */
      .oni-dp-hud-row { display:flex;align-items:center;gap:8px; }
      .oni-dp-timer-wrap {
        flex:1;height:8px;background:rgba(255,255,255,.15);border-radius:4px;overflow:hidden;
        box-shadow:0 0 0 1px rgba(200,168,75,.4);
      }
      .oni-dp-timer-bar  { height:100%;width:100%;background:#c8a84b;border-radius:4px;transition:width .05s linear; }
      .oni-dp-timer-label {
        font-size:.8rem;font-weight:700;color:#e8dfc0;
        text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;min-width:26px;text-align:right;
      }
      .oni-dp-hud-score {
        font-size:.88rem;font-weight:700;color:#f4d488;
        text-shadow:0 0 8px rgba(244,212,136,.5);white-space:nowrap;
      }

      /* Food grid — contain:layout style keeps browser layout work inside the grid */
      .oni-dp-grid-wrap {
        display:flex;flex-direction:column;gap:6px;align-items:center;
        contain:layout style;
      }
      .oni-dp-grid-row  { display:flex;gap:6px; }
      .oni-dp-cell {
        width:52px;height:52px;
        background:rgba(246,235,211,.12);border:2px solid rgba(141,95,56,.5);
        border-radius:10px;display:flex;align-items:center;justify-content:center;
        font-size:1.65rem;cursor:grab;user-select:none;
        transition:box-shadow .12s,opacity .15s;
        will-change:transform;
      }
      .oni-dp-cell:hover        { transform:scale(1.12);box-shadow:0 0 14px rgba(200,168,75,.6); }
      .oni-dp-cell:active       { cursor:grabbing; }
      .oni-dp-cell.dragging-src { opacity:.35; }
      .oni-dp-cell.game-over    { cursor:default;pointer-events:none;opacity:.65; }

      /* Bottom row */
      .oni-dp-bottom-row { display:flex;align-items:flex-end;justify-content:space-between;padding:0 4px;margin-top:2px; }
      .oni-dp-player-area,.oni-dp-ally-area { display:flex;flex-direction:column;align-items:center;gap:3px; }
      .oni-dp-actor-img {
        width:80px;height:80px;object-fit:contain;border:none;border-radius:0;
        background:transparent;filter:drop-shadow(0 0 10px rgba(200,168,75,.45));
      }
      .oni-dp-actor-label { font-size:.78rem;font-weight:700;color:#f6ebd3;text-shadow:0 1px 4px rgba(0,0,0,.9); }

      /* Speech bubble above ally token */
      .oni-dp-bubble {
        position:relative;
        background:#fff;border:2px solid #bbb;border-radius:12px;
        padding:6px 10px;
        display:flex;gap:4px;align-items:center;justify-content:center;
        min-width:60px;min-height:36px;
        box-shadow:2px 2px 0 #ccc;margin-bottom:4px;
      }
      .oni-dp-bubble::after {
        content:"";position:absolute;bottom:-12px;right:22px;
        border:6px solid transparent;border-top-color:#bbb;
      }
      .oni-dp-bubble::before {
        content:"";position:absolute;bottom:-9px;right:23px;
        border:5px solid transparent;border-top-color:#fff;z-index:1;
      }
      .oni-dp-bubble-item { font-size:1.5rem;transition:opacity .2s,transform .2s; }
      .oni-dp-bubble-item.filled { opacity:.3;transform:scale(.8); }

      /* Feed zone */
      .oni-dp-feed-zone {
        width:100px;height:82px;
        border:3px dashed rgba(200,168,75,.65);border-radius:14px;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:4px;background:rgba(200,168,75,.08);
        transition:background .15s,border-color .15s;
      }
      .oni-dp-feed-zone.drag-over  { background:rgba(200,168,75,.22);border-color:rgba(200,168,75,1); }
      .oni-dp-feed-zone.feed-wrong {
        background:rgba(220,60,60,.22);border-color:rgba(220,60,60,.9);
        animation:oni-dp-feed-shake .3s ease;
      }
      @keyframes oni-dp-feed-shake { 0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)} }
      .oni-dp-feed-icon  { font-size:1.8rem; }
      .oni-dp-feed-label { font-size:.7rem;font-weight:700;color:#c8a84b; }

      /* Finished overlay */
      .oni-dp-finished-overlay {
        position:absolute;inset:0;
        background:rgba(0,0,0,.55);border-radius:8px;
        display:flex;align-items:center;justify-content:center;
        z-index:20;
        animation:oni-dp-fadein .25s ease forwards;
      }
      .oni-dp-finished-txt {
        font-size:3rem;font-weight:900;color:#f4d488;
        text-shadow:0 0 32px rgba(244,212,136,.9);letter-spacing:.08em;
        animation:oni-dp-slideup .4s ease forwards;
      }

      /* Particles — pooled elements; animation driven by Web Animations API */
      .oni-dp-particle {
        position:fixed;width:7px;height:7px;border-radius:50%;
        pointer-events:none;z-index:10001;
      }

      /* Score / wrong pops */
      .oni-dp-score-pop {
        position:fixed;font-size:1.1rem;font-weight:900;
        color:#f4d488;text-shadow:0 0 8px rgba(244,212,136,.9);
        pointer-events:none;z-index:10001;white-space:nowrap;
        animation:oni-dp-float-up .55s ease-out forwards;
      }
      .oni-dp-wrong-pop {
        position:fixed;font-size:1.1rem;font-weight:900;
        color:#ff6464;text-shadow:0 0 8px rgba(255,80,80,.8);
        pointer-events:none;z-index:10001;white-space:nowrap;
        animation:oni-dp-float-up .5s ease-out forwards;
      }
      @keyframes oni-dp-float-up {
        0%  { transform:translate(-50%,0);opacity:1; }
        60% { transform:translate(-50%,-26px);opacity:1; }
        100%{ transform:translate(-50%,-40px);opacity:0; }
      }

      /* ── Result stage ── */
      .oni-dp-result-panel {
        background:var(--camp-parchment-1,#f6ebd3);
        border:2.5px solid var(--camp-wood-2,#8d5f38);
        border-radius:14px;padding:28px 36px;
        box-shadow:0 0 0 6px rgba(90,60,34,.4),0 20px 48px rgba(0,0,0,.7);
        display:flex;flex-direction:column;align-items:center;gap:12px;
        animation:oni-dp-slideup .4s ease forwards;min-width:340px;
      }
      .oni-dp-finished {
        font-size:2.6rem;font-weight:900;color:#f4d488;
        text-shadow:0 0 24px rgba(244,212,136,.8);letter-spacing:.06em;
      }
      .oni-dp-grade-txt  { font-size:1.5rem;font-weight:800;text-shadow:0 0 16px rgba(255,255,255,.3); }
      .oni-dp-effect-txt { font-size:.88rem;color:#5a3010;font-style:italic;text-align:center; }
      .oni-dp-proceed-btn {
        margin-top:6px;padding:8px 28px;
        background:linear-gradient(180deg,#c8a84b,#9a7a2b);
        color:#1a0e00;border:2px solid #7a5c15;border-radius:8px;
        font-weight:800;font-size:.9rem;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.4);transition:filter .15s;
      }
      .oni-dp-proceed-btn:hover    { filter:brightness(1.15); }
      .oni-dp-proceed-btn:disabled { opacity:.5;cursor:not-allowed; }
    `;
    document.head.appendChild(s);
  }

  // ===========================================================================
  // Helpers (non-hot-path)
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

  CAMP.DoublePortionUI = {
    targetResolvers:  {},
    scoreResolvers:   {},
    proceedResolvers: {},

    // ── Stage 1 — Target Picker (all clients) ────────────────────────────────
    show(actorId, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor  = game.actors?.get(actorId);
      _isOwner     = actor ? _isActorOwner(actor) : false;

      const ovl    = document.createElement("div");
      ovl.id       = OVL_ID;

      if (_isOwner) {
        const cards = (allies ?? []).map(a => `
          <div class="oni-dp-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-dp-panel">
            <div class="oni-dp-title"><img src="${DP_ICON}" alt=""> Double Portion</div>
            <div class="oni-dp-sub">Who will you feed?</div>
            <div class="oni-dp-ally-grid">${cards}</div>
          </div>
        `;

        ovl.querySelectorAll(".oni-dp-ally-card").forEach(card => {
          card.addEventListener("click", () => {
            const targetId = card.dataset.targetId;
            if (!targetId) return;
            if (game.user?.isGM) {
              CAMP.DoublePortionUI.resolveTarget(actorId, targetId);
            } else {
              CAMP.Socket.emit(CAMP.MSG.DOUBLE_PORTION_TARGET, { actorId, targetActorId: targetId });
            }
          }, { once: true });
        });
      } else {
        const ownerUid  = actor ? _getOwnerUserId(actor) : null;
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? "player") : "player";
        ovl.innerHTML = `
          <div class="oni-dp-panel">
            <div class="oni-dp-title"><img src="${DP_ICON}" alt=""> Double Portion</div>
            <div class="oni-dp-waiting">Waiting for ${ownerName} to choose a target…</div>
          </div>
        `;
      }

      document.body.appendChild(ovl);
    },

    resolveTarget(actorId, targetActorId) {
      const res = this.targetResolvers?.[actorId];
      if (!res) return;
      delete this.targetResolvers[actorId];
      res(targetActorId);
    },

    // ── Stage 2 — Arena (all clients; owner plays, others watch) ─────────────
    showArena(actorId, targetActorId) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId  = actorId;
      _targetId = targetActorId;

      const actor  = game.actors?.get(actorId);
      _isOwner     = actor ? _isActorOwner(actor) : false;

      const target  = game.actors?.get(targetActorId);
      const aImg    = target ? _getTokenImg(target) : "icons/svg/mystery-man.svg";
      const aName   = target?.name ?? "?";
      const pImg    = actor  ? _getTokenImg(actor)  : "icons/svg/mystery-man.svg";
      const pName   = actor?.name ?? "?";

      const ovl     = document.createElement("div");
      ovl.id        = OVL_ID;

      if (_isOwner) {
        ovl.innerHTML = `
          <div class="oni-dp-panel">
            <div class="oni-dp-title"><img src="${DP_ICON}" alt=""> Double Portion</div>
            <div style="display:flex;gap:24px;align-items:center;">
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <img src="${pImg}" style="width:64px;height:64px;object-fit:contain;border:none;">
                <span style="font-size:.78rem;color:#5a3010;">${pName}</span>
              </div>
              <div style="font-size:1.2rem;color:#c8a84b;">→ 🍽️ →</div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <img src="${aImg}" style="width:64px;height:64px;object-fit:contain;border:none;">
                <span style="font-size:.78rem;color:#5a3010;">${aName}</span>
              </div>
            </div>
            <div class="oni-dp-countdown-num" id="oni-dp-count">3</div>
          </div>
        `;
        document.body.appendChild(ovl);

        // Pre-warm audio, particles, and orders during the countdown
        _initGameAssets();

        _runCountdown(3, () => {
          // Switch overlay to game layout
          ovl.innerHTML = _buildArena(actorId, targetActorId);

          // Cache all element refs — must come before anything that reads _els
          _cacheEls();

          // Correct order: set _order first so _guardGrid knows what's needed
          _nextOrder();
          _initGrid();      // fills _grid, calls _guardGrid with a real grid

          // Build grid DOM + cell element map
          _renderGrid();

          // Build bubble DOM + bubble item cache
          _updateBubble();

          // Attach delegated event handlers — once only
          _buildGameHandlers(actorId);

          // Cache static positions now that layout is stable
          _cacheRects();

          _lastLabelSec = -1;
          _gameStartMs  = Date.now();
          _startGameLoop();

          _endTimer = setTimeout(() => {
            // Lock all interaction immediately
            _gameOver = true;
            if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

            // Snap timer to 0 via cached refs
            if (_els.timerBar)   _els.timerBar.style.width = "0%";
            if (_els.timerLabel) _els.timerLabel.textContent = "0s";

            // Mark cells non-interactive (querySelectorAll acceptable — game is over)
            _els.gridWrap?.querySelectorAll(".oni-dp-cell").forEach(c => c.classList.add("game-over"));

            // Overlay "Finished!" on game container
            const gp = _els.game;
            if (gp) {
              const fin      = document.createElement("div");
              fin.className  = "oni-dp-finished-overlay";
              fin.innerHTML  = `<div class="oni-dp-finished-txt">Finished!</div>`;
              gp.appendChild(fin);
            }

            setTimeout(() => _endGame(actorId), 800);
          }, GAME_MS);
        });

      } else {
        // Spectator view
        const ownerUid  = actor ? _getOwnerUserId(actor) : null;
        const ownerName = ownerUid ? (game.users?.get(ownerUid)?.name ?? pName) : pName;
        ovl.innerHTML = `
          <div class="oni-dp-panel">
            <div class="oni-dp-title"><img src="${DP_ICON}" alt=""> Double Portion</div>
            <div style="display:flex;gap:20px;align-items:center;">
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <img src="${pImg}" style="width:56px;height:56px;object-fit:contain;border:none;">
                <span style="font-size:.72rem;color:#5a3010;">${pName}</span>
              </div>
              <span style="font-size:1.3rem;color:#c8a84b;">→ 🍽️ →</span>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <img src="${aImg}" style="width:56px;height:56px;object-fit:contain;border:none;">
                <span style="font-size:.72rem;color:#5a3010;">${aName}</span>
              </div>
            </div>
            <div class="oni-dp-waiting">${ownerName} is preparing a meal for ${aName}…</div>
          </div>
        `;
        document.body.appendChild(ovl);
      }
    },

    // ── Stage 3 — Reveal (all clients) ───────────────────────────────────────
    applyResult(actorId, targetActorId, grade, multiplier) {
      if (_resultShown) return;
      _resultShown = true;

      _playSound(grade !== "failure" ? SFX.RESULT_GOOD : SFX.RESULT_BAD, 0.8);

      const target = game.actors?.get(targetActorId);
      const actor  = game.actors?.get(actorId);
      const tName  = target?.name ?? "The target";

      const gradeLabel =
        grade === "perfect" ? "Perfect Meal!" :
        grade === "partial" ? "Good Enough!"  : "Scraped By…";
      const gradeColor =
        grade === "perfect" ? "#c8a84b" :
        grade === "partial" ? "#3a7a35" : "#8a3a20";
      const effectTxt =
        grade === "perfect" ? `${tName} may triple HP recovered once before the next rest.`  :
        grade === "partial" ? `${tName} may double HP recovered once before the next rest.`  :
                              `${tName} gains a small HP bonus once before the next rest.`;

      const ovl = document.getElementById(OVL_ID);
      if (ovl) ovl.innerHTML = "";

      const isOwnerNow = actor ? _isActorOwner(actor) : false;
      const panel      = document.createElement("div");
      panel.className  = "oni-dp-result-panel";
      panel.innerHTML  = `
        <div class="oni-dp-finished">Finished!</div>
        <div class="oni-dp-grade-txt" style="color:${gradeColor};">${gradeLabel}</div>
        <div class="oni-dp-effect-txt">${effectTxt}</div>
        ${isOwnerNow ? `<button class="oni-dp-proceed-btn" id="oni-dp-proceed">Click to Proceed</button>` : ""}
      `;

      if (ovl) ovl.appendChild(panel);

      if (isOwnerNow) {
        const btn = document.getElementById("oni-dp-proceed");
        btn?.addEventListener("click", () => {
          btn.disabled = true;
          if (game.user?.isGM) {
            CAMP.DoublePortionUI.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.DOUBLE_PORTION_PROCEED, { actorId });
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
      el.classList.add("oni-dp-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    },
  };

  console.debug(TAG, "Double Portion UI loaded.");
})();
