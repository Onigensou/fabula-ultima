// ============================================================================
// Camp Activity — Double Portion UI
//
// Food Order drag-and-drop minigame overlay.
//
// Stages:
//   1 — Target Picker   (same ally-card pattern as Combat Lesson)
//   2 — Countdown + Minigame (15 s: drag the correct food to feed the ally)
//   3 — Reveal          (grade + effect + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts DOUBLE_PORTION_START   → all call show()
//   Owner picks ally → emits DOUBLE_PORTION_TARGET → GM
//   GM broadcasts DOUBLE_PORTION_MINIGAME → all call showArena()
//   [15 s game; owner collects score & wrong count]
//   Owner emits DOUBLE_PORTION_RESULT { score, wrong } → GM
//   GM broadcasts DOUBLE_PORTION_RESULT { grade, multiplier } → all applyResult()
//   Owner "Click to Proceed" → emits DOUBLE_PORTION_PROCEED → GM
//   GM broadcasts DOUBLE_PORTION_DONE → all hide()
//
// Score rules:
//   Correct delivery: score++
//   Wrong delivery:   score = Math.max(0, score - 1)
//   Grade at end:
//     wrong == 0 && score > 0  → "perfect"  → ×3 HP recovery
//     score > 0                → "partial"  → ×2 HP recovery
//     else                     → "failure"  → low bonus (AE note only)
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][DoublePortionUI]";
  const OVL_ID    = "oni-camp-dp-ovl";
  const STYLE_ID  = "oni-camp-dp-style";

  const DP_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rose/RoseSkill2.png";

  const SFX = {
    SUCCESS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
    FAIL:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/failed_1.wav",
    EATING:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Eating.mp3",
    RESULT_GOOD: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/success2.ogg",
    RESULT_BAD:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/fumble_1.WAV",
    COUNTDOWN: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    GO:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav",
  };

  // ---------------------------------------------------------------------------
  // Food definitions
  // ---------------------------------------------------------------------------
  const FOODS = ["🍖", "🧀", "🥕", "🍞", "🍎", "🍳", "🥩", "🐟"];
  const GRID_COLS  = 5;
  const GRID_ROWS  = 4;
  const GAME_MS    = 15_000;

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId      = null;   // caster
  let _targetId     = null;   // ally
  let _isOwner      = false;
  let _score        = 0;
  let _wrong        = 0;
  let _gameStartMs  = null;
  let _rafId        = null;
  let _endTimer     = null;
  let _resultShown  = false;
  let _gameOver     = false;  // set true when timer fires; blocks further drops

  // Grid state: flat array [col*GRID_ROWS + row], each cell = food emoji or null
  let _grid = [];
  // Current order: array of { food, filled }
  let _order = [];
  // Track drag state
  let _dragging = null; // { food, col, row }

  function _clearState() {
    if (_rafId    !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_endTimer !== null) { clearTimeout(_endTimer); _endTimer = null; }
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
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _playSound(src, volume = 0.7) {
    try {
      const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      if (AH) { AH.play({ src, volume, autoplay: true, loop: false }, false); return; }
    } catch {}
    try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
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

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------------------------------------------------------------------------
  // Grid helpers
  // ---------------------------------------------------------------------------
  function _cellKey(col, row) { return col * GRID_ROWS + row; }

  function _initGrid() {
    _grid = [];
    for (let c = 0; c < GRID_COLS; c++) {
      for (let r = 0; r < GRID_ROWS; r++) {
        _grid[_cellKey(c, r)] = FOODS[Math.floor(Math.random() * FOODS.length)];
      }
    }
    _guardGrid();
  }

  // Ensure every still-needed order food appears at least once in the grid.
  function _guardGrid() {
    const needed = _order.filter(o => !o.filled).map(o => o.food);
    for (const food of needed) {
      const exists = _grid.some(f => f === food);
      if (!exists) {
        // Replace a random cell that isn't one of the needed foods
        const replaceable = [];
        for (let i = 0; i < _grid.length; i++) {
          if (!needed.includes(_grid[i])) replaceable.push(i);
        }
        if (replaceable.length > 0) {
          const idx = replaceable[Math.floor(Math.random() * replaceable.length)];
          _grid[idx] = food;
        } else {
          // All cells are needed foods — just replace a random one
          const idx = Math.floor(Math.random() * _grid.length);
          _grid[idx] = food;
        }
      }
    }
  }

  // Remove cell at (col, row): shift column down, spawn new food at top.
  // Returns the new food spawned at top of that column.
  function _removeCell(col, row) {
    // Shift everything above row downward by 1
    for (let r = row; r > 0; r--) {
      _grid[_cellKey(col, r)] = _grid[_cellKey(col, r - 1)];
    }
    // New random food at top (row 0)
    const needed  = _order.filter(o => !o.filled).map(o => o.food);
    const newFood = FOODS[Math.floor(Math.random() * FOODS.length)];
    _grid[_cellKey(col, 0)] = newFood;
    _guardGrid();
  }

  // Generate a new order (1–3 random foods) after the previous is complete.
  function _newOrder() {
    const count = 1 + Math.floor(Math.random() * 3); // 1–3
    const pool  = _shuffle([...FOODS]).slice(0, count);
    _order = pool.map(food => ({ food, filled: false }));
    _guardGrid();
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

      /* ── Transparent compact game container (no box, no background) ── */
      .oni-dp-game {
        display:flex;flex-direction:column;gap:10px;
        width:510px;position:relative;
      }

      /* HUD row — timer + label + score, light colours on dark bg */
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

      /* Food grid */
      .oni-dp-grid-wrap { display:flex;flex-direction:column;gap:6px;align-items:center; }
      .oni-dp-grid-row  { display:flex;gap:6px; }
      .oni-dp-cell {
        width:52px;height:52px;
        background:rgba(246,235,211,.12);border:2px solid rgba(141,95,56,.5);
        border-radius:10px;display:flex;align-items:center;justify-content:center;
        font-size:1.65rem;cursor:grab;user-select:none;
        transition:transform .12s,box-shadow .12s,opacity .15s;
      }
      .oni-dp-cell:hover        { transform:scale(1.12);box-shadow:0 0 14px rgba(200,168,75,.6); }
      .oni-dp-cell:active       { cursor:grabbing; }
      .oni-dp-cell.dragging-src { opacity:.35; }
      .oni-dp-cell.game-over    { cursor:default;pointer-events:none;opacity:.65; }
      .oni-dp-cell.fall-in      { animation:oni-dp-fall-in .22s ease-out; }
      @keyframes oni-dp-fall-in { from{transform:translateY(-44px);opacity:0}to{transform:translateY(0);opacity:1} }

      /* Bottom row — player | feed zone | ally+bubble */
      .oni-dp-bottom-row { display:flex;align-items:flex-end;justify-content:space-between;padding:0 4px;margin-top:2px; }
      .oni-dp-player-area,.oni-dp-ally-area { display:flex;flex-direction:column;align-items:center;gap:3px; }
      .oni-dp-actor-img {
        width:80px;height:80px;object-fit:contain;border:none;border-radius:0;
        background:transparent;filter:drop-shadow(0 0 10px rgba(200,168,75,.45));
      }
      .oni-dp-actor-label { font-size:.78rem;font-weight:700;color:#f6ebd3;text-shadow:0 1px 4px rgba(0,0,0,.9); }
      .oni-dp-ally-token.eating { animation:oni-dp-eat .35s ease; }
      .oni-dp-ally-token.happy  { animation:oni-dp-happy .4s ease; }
      @keyframes oni-dp-eat   { 0%{transform:scale(1)}30%{transform:scale(1.18) translateY(-6px)}100%{transform:scale(1)} }
      @keyframes oni-dp-happy { 0%{transform:scale(1)}20%{transform:scale(1.15) rotate(-5deg)}60%{transform:scale(1.15) rotate(5deg)}100%{transform:scale(1)} }

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
      .oni-dp-feed-zone.drag-over { background:rgba(200,168,75,.22);border-color:rgba(200,168,75,1); }
      .oni-dp-feed-zone.feed-wrong {
        background:rgba(220,60,60,.22);border-color:rgba(220,60,60,.9);
        animation:oni-dp-feed-shake .3s ease;
      }
      @keyframes oni-dp-feed-shake { 0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)} }
      .oni-dp-feed-icon  { font-size:1.8rem; }
      .oni-dp-feed-label { font-size:.7rem;font-weight:700;color:#c8a84b; }

      /* Finished overlay — sits on top of the game container, blocks interaction */
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

      /* Particles / pops */
      .oni-dp-particle {
        position:fixed;width:7px;height:7px;border-radius:50%;
        pointer-events:none;z-index:10001;
        animation:oni-dp-particle-fly .42s ease-out forwards;
      }
      @keyframes oni-dp-particle-fly {
        0%  { transform:translate(0,0) scale(1);opacity:1; }
        100%{ transform:translate(var(--px),var(--py)) scale(0);opacity:0; }
      }
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
      .oni-dp-grade-txt { font-size:1.5rem;font-weight:800;text-shadow:0 0 16px rgba(255,255,255,.3); }
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

  // ---------------------------------------------------------------------------
  // Render the food grid DOM from _grid state
  // ---------------------------------------------------------------------------
  function _renderGrid(animate = false) {
    const wrap = document.getElementById("oni-dp-grid-wrap");
    if (!wrap) return;

    const rows = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const cells = [];
      for (let c = 0; c < GRID_COLS; c++) {
        cells.push(`
          <div class="oni-dp-cell${animate && r === 0 ? ' fall-in' : ''}"
               data-col="${c}" data-row="${r}"
               draggable="true">
            ${_grid[_cellKey(c, r)]}
          </div>
        `);
      }
      rows.push(`<div class="oni-dp-grid-row">${cells.join("")}</div>`);
    }
    wrap.innerHTML = rows.join("");
    _attachDragHandlers();
  }

  // Refresh only a single column (after removing a cell).
  function _refreshColumn(col, newTopFoodEl) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const el = document.querySelector(`.oni-dp-cell[data-col="${col}"][data-row="${r}"]`);
      if (!el) continue;
      el.textContent = _grid[_cellKey(col, r)];
      if (r === 0) el.classList.add("fall-in");
    }
    _attachDragHandlers();
  }

  // ---------------------------------------------------------------------------
  // Drag & drop handlers
  // ---------------------------------------------------------------------------
  function _attachDragHandlers() {
    document.querySelectorAll(`#${OVL_ID} .oni-dp-cell`).forEach(cell => {
      cell.addEventListener("dragstart", e => {
        const col  = parseInt(cell.dataset.col);
        const row  = parseInt(cell.dataset.row);
        const food = _grid[_cellKey(col, row)];
        _dragging  = { food, col, row };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", food);
        cell.classList.add("dragging-src");
      });
      cell.addEventListener("dragend", () => {
        cell.classList.remove("dragging-src");
        _dragging = null;
      });
    });

    const feedZone = document.getElementById("oni-dp-feed-zone");
    if (!feedZone) return;

    feedZone.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      feedZone.classList.add("drag-over");
    });
    feedZone.addEventListener("dragleave", () => {
      feedZone.classList.remove("drag-over");
    });
    feedZone.addEventListener("drop", e => {
      e.preventDefault();
      feedZone.classList.remove("drag-over");
      if (!_dragging) return;
      _handleDrop(_dragging.food, _dragging.col, _dragging.row);
      _dragging = null;
    });
  }

  function _handleDrop(food, col, row) {
    if (!_isOwner || _gameOver) return;

    // Find the first unfulfilled order item
    const orderItem = _order.find(o => !o.filled);
    if (!orderItem) return;

    if (food === orderItem.food) {
      // ── Correct ──────────────────────────────────────────────────────────
      _score++;
      orderItem.filled = true;

      _playSound(SFX.EATING, 0.75);
      _playSound(SFX.SUCCESS, 0.6);

      // Animate ally
      const allyEl = document.getElementById("oni-dp-ally-token");
      if (allyEl) {
        allyEl.classList.remove("eating", "happy");
        void allyEl.offsetWidth;
        allyEl.classList.add("eating");
        allyEl.addEventListener("animationend", () => {
          allyEl.classList.remove("eating");
          allyEl.classList.add("happy");
          allyEl.addEventListener("animationend", () => allyEl.classList.remove("happy"), { once: true });
        }, { once: true });
      }

      // Remove cell & refill column
      _removeCell(col, row);
      _refreshColumn(col);

      // Update bubble
      _updateBubble();

      // Score pop at feed zone
      _spawnScorePop("+1", false);

      // Particles at ally token
      _spawnAllyParticles();

      // Check if order fully fulfilled
      if (_order.every(o => o.filled)) {
        // Brief pause, then new order
        setTimeout(() => {
          _newOrder();
          _updateBubble();
          _guardGrid();
          _renderGrid(false);
        }, 500);
      }

      // Update score HUD
      const hudEl = document.getElementById("oni-dp-hud-score");
      if (hudEl) hudEl.textContent = `Score: ${_score} | ✗: ${_wrong}`;

    } else {
      // ── Wrong ─────────────────────────────────────────────────────────────
      _wrong++;
      _score = Math.max(0, _score - 1);

      _playSound(SFX.FAIL, 0.7);

      // Flash feed zone
      const fz = document.getElementById("oni-dp-feed-zone");
      if (fz) {
        fz.classList.add("feed-wrong");
        fz.addEventListener("animationend", () => fz.classList.remove("feed-wrong"), { once: true });
      }

      _spawnScorePop("-1", true);

      const hudEl = document.getElementById("oni-dp-hud-score");
      if (hudEl) hudEl.textContent = `Score: ${_score} | ✗: ${_wrong}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Update speech bubble
  // ---------------------------------------------------------------------------
  function _updateBubble() {
    const bubble = document.getElementById("oni-dp-order-bubble");
    if (!bubble) return;
    bubble.innerHTML = _order.map(o => `
      <span class="oni-dp-bubble-item${o.filled ? " filled" : ""}">${o.food}</span>
    `).join("");
  }

  // ---------------------------------------------------------------------------
  // Particles near the ally token
  // ---------------------------------------------------------------------------
  function _spawnAllyParticles() {
    const allyEl = document.getElementById("oni-dp-ally-token");
    if (!allyEl) return;
    const rect   = allyEl.getBoundingClientRect();
    const cx     = rect.left + rect.width  / 2;
    const cy     = rect.top  + rect.height / 2;

    const COLORS = ["#f4d488", "#ffe566", "#c8a84b", "#ffcc44", "#aaffaa", "#ff9944"];
    for (let i = 0; i < 10; i++) {
      const p   = document.createElement("div");
      p.className = "oni-dp-particle";
      const ang = (i / 10) * Math.PI * 2;
      const r   = 24 + Math.random() * 20;
      p.style.left       = `${cx - 3}px`;
      p.style.top        = `${cy - 3}px`;
      p.style.background = COLORS[i % COLORS.length];
      p.style.setProperty("--px", `${Math.cos(ang) * r}px`);
      p.style.setProperty("--py", `${Math.sin(ang) * r}px`);
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 450);
    }
  }

  function _spawnScorePop(label, isWrong) {
    const fz = document.getElementById("oni-dp-feed-zone");
    if (!fz) return;
    const rect = fz.getBoundingClientRect();
    const txt  = document.createElement("div");
    txt.className = isWrong ? "oni-dp-wrong-pop" : "oni-dp-score-pop";
    txt.textContent = label;
    txt.style.left = `${rect.left + rect.width / 2}px`;
    txt.style.top  = `${rect.top}px`;
    document.body.appendChild(txt);
    setTimeout(() => txt.remove(), 580);
  }

  // ---------------------------------------------------------------------------
  // rAF game loop — timer bar (owner) or no-op (spectator)
  // ---------------------------------------------------------------------------
  function _startGameLoop(isOwner) {
    function _frame() {
      if (!document.getElementById(OVL_ID)) return;
      if (isOwner) {
        const elapsed = Date.now() - _gameStartMs;
        const pct     = Math.max(0, 1 - elapsed / GAME_MS);
        const bar     = document.getElementById("oni-dp-timer-bar");
        if (bar) bar.style.width = `${pct * 100}%`;
        const lbl     = document.getElementById("oni-dp-timer-label");
        if (lbl) lbl.textContent = `${Math.ceil(Math.max(0, GAME_MS - elapsed) / 1000)}s`;
      }
      _rafId = requestAnimationFrame(_frame);
    }
    _rafId = requestAnimationFrame(_frame);
  }

  // ---------------------------------------------------------------------------
  // End game — submit score to GM
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Countdown helper
  // ---------------------------------------------------------------------------
  function _runCountdown(count, onDone) {
    const el = document.getElementById("oni-dp-count");
    if (el) {
      el.textContent = count;
      el.className   = "oni-dp-countdown-num";
      void el.offsetWidth;
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

  // ---------------------------------------------------------------------------
  // Build the compact game panel HTML
  // Order row sits directly above the grid so the player can glance between them.
  // ---------------------------------------------------------------------------
  function _buildArena(actorId, targetActorId) {
    const actor  = game.actors?.get(actorId);
    const target = game.actors?.get(targetActorId);
    const pImg   = actor  ? _getTokenImg(actor)  : "icons/svg/mystery-man.svg";
    const aImg   = target ? _getTokenImg(target) : "icons/svg/mystery-man.svg";
    const pName  = actor?.name  ?? "?";
    const aName  = target?.name ?? "?";

    return `
      <div class="oni-dp-game" id="oni-dp-game">

        <!-- HUD: timer bar + score on one compact line -->
        <div class="oni-dp-hud-row">
          <div class="oni-dp-timer-wrap">
            <div class="oni-dp-timer-bar" id="oni-dp-timer-bar"></div>
          </div>
          <div class="oni-dp-timer-label" id="oni-dp-timer-label">15s</div>
          <div class="oni-dp-hud-score"   id="oni-dp-hud-score">Score: 0 | ✗: 0</div>
        </div>

        <!-- Food grid -->
        <div class="oni-dp-grid-wrap" id="oni-dp-grid-wrap"></div>

        <!-- Bottom row: player | feed zone | ally (with speech bubble above) -->
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.DoublePortionUI = {
    targetResolvers:  {},
    scoreResolvers:   {},
    proceedResolvers: {},

    // --------------------------------------------------------------------
    // Stage 1 — Target Picker (all clients)
    // --------------------------------------------------------------------
    show(actorId, allies) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId = actorId;

      const actor   = game.actors?.get(actorId);
      _isOwner      = actor ? _isActorOwner(actor) : false;

      const ovl     = document.createElement("div");
      ovl.id        = OVL_ID;

      if (_isOwner) {
        const cards = (allies ?? []).map(a => `
          <div class="oni-dp-ally-card" data-target-id="${a.id}">
            <img src="${a.img}" alt="${a.name}">
            <span>${a.name}</span>
          </div>
        `).join("");

        ovl.innerHTML = `
          <div class="oni-dp-panel">
            <div class="oni-dp-title">
              <img src="${DP_ICON}" alt=""> Double Portion
            </div>
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
            <div class="oni-dp-title">
              <img src="${DP_ICON}" alt=""> Double Portion
            </div>
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

    // --------------------------------------------------------------------
    // Stage 2 — Show game arena (all clients); owner plays, others watch
    // --------------------------------------------------------------------
    showArena(actorId, targetActorId) {
      document.getElementById(OVL_ID)?.remove();
      _clearState();
      _ensureStyle();
      _actorId  = actorId;
      _targetId = targetActorId;

      const actor  = game.actors?.get(actorId);
      _isOwner     = actor ? _isActorOwner(actor) : false;

      const ovl    = document.createElement("div");
      ovl.id       = OVL_ID;

      // Countdown panel (shared appearance for owner; spectators see static panel)
      const target  = game.actors?.get(targetActorId);
      const aImg    = target ? _getTokenImg(target) : "icons/svg/mystery-man.svg";
      const aName   = target?.name ?? "?";
      const pImg    = actor  ? _getTokenImg(actor)  : "icons/svg/mystery-man.svg";
      const pName   = actor?.name ?? "?";

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

        _runCountdown(3, () => {
          // Switch to game layout
          ovl.innerHTML = _buildArena(actorId, targetActorId);

          _newOrder();
          _initGrid();
          _renderGrid(false);
          _updateBubble();

          _gameStartMs = Date.now();
          _startGameLoop(true);
          _endTimer = setTimeout(() => {
            // Lock all game interaction immediately
            _gameOver = true;
            if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }

            // Snap timer to 0
            const bar = document.getElementById("oni-dp-timer-bar");
            if (bar) bar.style.width = "0%";
            const lbl = document.getElementById("oni-dp-timer-label");
            if (lbl) lbl.textContent = "0s";

            // Mark all cells non-interactive via CSS class
            document.querySelectorAll(`#${OVL_ID} .oni-dp-cell`).forEach(c => c.classList.add("game-over"));

            // Overlay "Finished!" on top of the panel — blocks all pointer events below it
            const gamePanel = document.getElementById("oni-dp-game");
            if (gamePanel) {
              const fin = document.createElement("div");
              fin.className = "oni-dp-finished-overlay";
              fin.innerHTML = `<div class="oni-dp-finished-txt">Finished!</div>`;
              gamePanel.appendChild(fin);
            }

            setTimeout(() => _endGame(actorId), 800);
          }, GAME_MS);
        });

      } else {
        // Spectator view — simple waiting panel
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

    // --------------------------------------------------------------------
    // Stage 3 — Reveal (all clients)
    // --------------------------------------------------------------------
    applyResult(actorId, targetActorId, grade, multiplier) {
      if (_resultShown) return;
      _resultShown = true;

      const isGood = grade !== "failure";
      _playSound(isGood ? SFX.RESULT_GOOD : SFX.RESULT_BAD, 0.8);

      const target = game.actors?.get(targetActorId);
      const actor  = game.actors?.get(actorId);
      const tName  = target?.name ?? "The target";

      const gradeLabel =
        grade === "perfect" ? "Perfect Meal!" :
        grade === "partial" ? "Good Enough!"  :
                              "Scraped By…";
      const gradeColor =
        grade === "perfect" ? "#c8a84b" :
        grade === "partial" ? "#3a7a35" :
                              "#8a3a20";
      const effectTxt =
        grade === "perfect" ? `${tName} may triple HP recovered once before the next rest.` :
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

    // --------------------------------------------------------------------
    // Gate resolvers
    // --------------------------------------------------------------------
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

    // --------------------------------------------------------------------
    // Dismiss
    // --------------------------------------------------------------------
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
