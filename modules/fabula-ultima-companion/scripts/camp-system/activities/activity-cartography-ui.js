// ============================================================================
// Camp Activity — Cartography UI
//
// Snake minigame overlay.
//
// Stages:
//   1 — Waiting   ("Click to Begin" for owner; spectators see "Waiting…")
//   2 — Countdown (3 → 2 → 1 → GO! — all clients run this locally)
//   3 — Playing   (owner runs game loop + emits ticks; spectators render from ticks)
//   4 — Result    (grade + charges + "Click to Proceed" for owner)
//
// Sync flow:
//   GM broadcasts CARTOGRAPHY_START → all call show()        (GM direct too)
//   Owner clicks Begin → emits CARTOGRAPHY_BEGIN → all call spectateBegin()
//   [15 s game; owner emits CARTOGRAPHY_TICK every 300 ms for spectators]
//   Owner emits CARTOGRAPHY_RESULT { score, hits } → GM calls resolveScore()
//   GM broadcasts CARTOGRAPHY_RESULT { score, hits, charges } → all call applyResult()
//   Owner clicks Proceed → emits CARTOGRAPHY_PROCEED → GM calls resolveProceed()
//   GM broadcasts CARTOGRAPHY_DONE → all call hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][CartographyUI]";
  const OVL_ID    = "oni-camp-carto-ovl";
  const STYLE_ID  = "oni-camp-carto-style";

  // ── Grid / game config ─────────────────────────────────────────────────────
  const COLS              = 15;
  const ROWS              = 15;
  const CELL_PX           = 32;
  const TICK_MS           = 100;           // 10 fps game loop
  const GAME_DURATION_MS  = 15_000;
  const SPECTATOR_SYNC_MS = 300;           // send full state to spectators every 300 ms
  const INVINCIBLE_MS     = 600;           // grace period after a hit
  const HAZARD_LIFETIME_MS = 4_000;        // how long each hazard stays on board
  const INIT_TRAIL_LEN    = 3;             // snake starts 3 cells long
  const TREASURE_ICON     = "fa-treasure-chest";
  const HAZARD_POOL       = ["fa-dragon", "fa-spider", "fa-skull", "fa-crow", "fa-bat"];

  // ── Sound URLs ─────────────────────────────────────────────────────────────
  const _BASE      = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
  const SFX_PICKUP    = `${_BASE}emotion_up.wav`;
  const SFX_HIT       = `${_BASE}Soundboard/Damage3.ogg`;
  const SFX_COUNTDOWN = `${_BASE}check_ready.wav`;
  const SFX_GO        = `${_BASE}Critical_1.wav`;
  const SFX_RESULT    = `${_BASE}Up3.ogg`;

  function _sfx(src, vol = 0.7) {
    try { AudioHelper.play({ src, volume: vol, autoplay: true, loop: false }, false); } catch {}
  }

  // ── Module-level state ─────────────────────────────────────────────────────
  let _actorId        = null;
  let _isOwner        = false;
  let _tokenImg       = null;

  // Game state (owner-authoritative)
  let _phase          = "idle";   // idle | waiting | countdown | playing | result
  let _head           = { x: 7, y: 7 };
  let _trail          = [];       // [{x,y}] ordered head-first
  let _dir            = { dx: 1, dy: 0 };
  let _nextDir        = { dx: 1, dy: 0 };
  let _growPending    = 0;
  let _score          = 0;
  let _hits           = 0;
  let _invincibleUntil = 0;
  let _treasure       = null;    // {x,y}
  let _hazards        = [];      // [{x,y,icon,despawnAt}]
  let _gameStartTs    = 0;
  let _timeLeft       = GAME_DURATION_MS;

  // rAF (owner only)
  let _rafId       = null;
  let _lastTickMs  = 0;
  let _lastSyncMs  = 0;

  // ── Public API ─────────────────────────────────────────────────────────────
  CAMP.CartographyUI = {
    scoreResolvers:   {},
    proceedResolvers: {},

    // Called on all clients when GM broadcasts START
    show(actorId, actorName) {
      if (document.getElementById(OVL_ID)) return;
      _clearState();
      _actorId  = actorId;
      _isOwner  = _checkIsOwner(actorId);

      const actor = game.actors?.get(actorId);
      _tokenImg = actor?.prototypeToken?.texture?.src ?? actor?.img ?? null;

      _ensureStyle();
      document.body.appendChild(_buildOverlay(actorName));
      _phase = "waiting";

      if (_isOwner) {
        document.getElementById("oni-carto-begin-btn")
          ?.addEventListener("click", _onBeginClick);
      }
    },

    // Called on all clients when GM broadcasts DONE
    hide() {
      _stopLoop();
      _clearState();
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      ovl.classList.add("oni-carto-fade-out");
      ovl.addEventListener("animationend", () => ovl.remove(), { once: true });
    },

    // Called on all clients when GM broadcasts RESULT (with charges)
    applyResult(actorId, score, hits, charges) {
      if (!document.getElementById(OVL_ID)) return;
      _phase = "result";
      _stopLoop();
      _sfx(SFX_RESULT);
      _showResultPanel(actorId, score, hits, charges);
    },

    // GM only — called by socket handler or directly by GM-owner
    resolveScore(actorId, score, hits) {
      const fn = this.scoreResolvers?.[actorId];
      if (!fn) return;
      delete this.scoreResolvers[actorId];
      fn({ score, hits });
    },

    // GM only — called by socket handler or directly by GM-owner
    resolveProceed(actorId) {
      const fn = this.proceedResolvers?.[actorId];
      if (!fn) return;
      delete this.proceedResolvers[actorId];
      fn();
    },

    // Called on non-owner clients when owner emits CARTOGRAPHY_BEGIN
    spectateBegin(actorId) {
      if (actorId !== _actorId) return;
      if (_isOwner) return;
      if (_phase !== "waiting") return;
      _startCountdown();
    },

    // Called on non-owner clients when owner emits CARTOGRAPHY_TICK
    onTick(payload) {
      if (payload?.actorId !== _actorId) return;
      if (_isOwner) return;
      if (_phase !== "playing") return;
      _renderSpectatorState(payload);
    },
  };

  // ── Owner: Begin button ────────────────────────────────────────────────────
  function _onBeginClick() {
    document.getElementById("oni-carto-begin-btn")?.remove();
    document.getElementById("oni-carto-waiting-label")
      ?.style.setProperty("display", "none");
    CAMP.Socket.emit(CAMP.MSG.CARTOGRAPHY_BEGIN, { actorId: _actorId });
    _startCountdown();
  }

  // ── Countdown (runs locally on all clients) ────────────────────────────────
  function _startCountdown() {
    if (_phase !== "waiting") return;
    _phase = "countdown";

    const preGame   = document.getElementById("oni-carto-pre-game");
    const countdown = document.getElementById("oni-carto-countdown");
    if (preGame)   preGame.style.display   = "none";
    if (countdown) countdown.style.display = "flex";

    const steps = ["3", "2", "1", "GO!"];
    let i = 0;

    function tick() {
      if (!document.getElementById(OVL_ID)) return;
      countdown.textContent = steps[i];
      _sfx(i < 3 ? SFX_COUNTDOWN : SFX_GO, i < 3 ? 0.6 : 0.75);
      if (i === steps.length - 1) {
        setTimeout(() => {
          if (countdown) countdown.style.display = "none";
          _startGame();
        }, 700);
        return;
      }
      i++;
      setTimeout(tick, 800);
    }
    tick();
  }

  // ── Game start ─────────────────────────────────────────────────────────────
  function _startGame() {
    if (!document.getElementById(OVL_ID)) return;
    _phase        = "playing";
    _gameStartTs  = performance.now();
    _lastTickMs   = _gameStartTs;
    _lastSyncMs   = _gameStartTs;
    _score        = 0;
    _hits         = 0;
    _timeLeft     = GAME_DURATION_MS;
    _invincibleUntil = 0;

    // Init snake in center moving right
    const cx = Math.floor(COLS / 2);
    const cy = Math.floor(ROWS / 2);
    _head     = { x: cx, y: cy };
    _trail    = Array.from({ length: INIT_TRAIL_LEN }, (_, i) => ({ x: cx - i, y: cy }));
    _dir      = { dx: 1, dy: 0 };
    _nextDir  = { dx: 1, dy: 0 };
    _growPending = 0;

    // Spawn treasure then hazards (sequential so _randomEmpty excludes each)
    _hazards   = [];
    _treasure  = _randomEmpty();
    _hazards.push(_spawnHazard());
    _hazards.push(_spawnHazard());

    // Show grid + HUD
    const grid = document.getElementById("oni-carto-grid");
    const hud  = document.getElementById("oni-carto-hud");
    if (grid) grid.style.display = "grid";
    if (hud)  hud.style.display  = "flex";

    if (_isOwner) {
      document.addEventListener("keydown", _onKey);
      _render();
      _rafId = requestAnimationFrame(_frame);
    }
    // Spectators wait passively for CARTOGRAPHY_TICK events
  }

  // ── Owner game loop ────────────────────────────────────────────────────────
  function _frame(ts) {
    if (_phase !== "playing") return;
    if (!document.getElementById(OVL_ID)) { _stopLoop(); return; }

    _timeLeft = Math.max(0, GAME_DURATION_MS - (ts - _gameStartTs));
    _updateHUD();

    if (_timeLeft <= 0) {
      _endGame();
      return;
    }

    if (ts - _lastTickMs >= TICK_MS) {
      _lastTickMs = ts;
      _gameTick();
    }

    if (ts - _lastSyncMs >= SPECTATOR_SYNC_MS) {
      _lastSyncMs = ts;
      _emitTick();
    }

    _rafId = requestAnimationFrame(_frame);
  }

  function _gameTick() {
    // Commit queued direction
    _dir = { ..._nextDir };

    // Move head (wrap at edges)
    _head = {
      x: (_head.x + _dir.dx + COLS) % COLS,
      y: (_head.y + _dir.dy + ROWS) % ROWS,
    };

    // Extend trail
    _trail.unshift({ ..._head });
    if (_growPending > 0) {
      _growPending--;
    } else {
      _trail.pop();
    }

    // Treasure pickup
    if (_treasure && _head.x === _treasure.x && _head.y === _treasure.y) {
      _score      += 10;
      _growPending += 3;
      _treasure    = _randomEmpty();
      _floatText("+10", _head.x, _head.y, "gain");
      _sfx(SFX_PICKUP, 0.65);
    }

    const now = performance.now();

    // Respawn expired hazards
    for (let i = 0; i < _hazards.length; i++) {
      if (now >= _hazards[i].despawnAt) _hazards[i] = _spawnHazard();
    }

    // Collision checks (skip if invincible)
    if (now >= _invincibleUntil) {
      // Hazard collision
      for (const h of _hazards) {
        if (_head.x === h.x && _head.y === h.y) { _onHit(); break; }
      }

      // Trail collision — skip index 0 (that IS the head)
      if (now >= _invincibleUntil) {
        for (let i = 1; i < _trail.length; i++) {
          if (_head.x === _trail[i].x && _head.y === _trail[i].y) { _onHit(); break; }
        }
      }
    }

    _render();
  }

  function _onHit() {
    _hits++;
    _score           = Math.max(0, _score - 5);
    _invincibleUntil = performance.now() + INVINCIBLE_MS;
    _floatText("-5", _head.x, _head.y, "loss");
    _sfx(SFX_HIT, 0.7);

    const grid = document.getElementById("oni-carto-grid");
    if (grid) {
      grid.classList.add("oni-carto-flash-red");
      setTimeout(() => grid?.classList.remove("oni-carto-flash-red"), 300);
    }
  }

  function _onKey(e) {
    const map = {
      ArrowUp:    { dx:  0, dy: -1 }, w: { dx:  0, dy: -1 },
      ArrowDown:  { dx:  0, dy:  1 }, s: { dx:  0, dy:  1 },
      ArrowLeft:  { dx: -1, dy:  0 }, a: { dx: -1, dy:  0 },
      ArrowRight: { dx:  1, dy:  0 }, d: { dx:  1, dy:  0 },
    };
    const nd = map[e.key];
    if (!nd) return;
    // Forbid 180° reversal
    if (nd.dx !== -_dir.dx || nd.dy !== -_dir.dy) _nextDir = nd;
    if (e.key.startsWith("Arrow")) e.preventDefault();
  }

  function _endGame() {
    _stopLoop();
    if (!_isOwner) return;
    CAMP.Socket.emit(CAMP.MSG.CARTOGRAPHY_RESULT, {
      actorId: _actorId,
      score:   _score,
      hits:    _hits,
    });
    // emit has no self-echo — GM owner must resolve directly
    if (game.user?.isGM) {
      CAMP.CartographyUI.resolveScore(_actorId, _score, _hits);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function _render() {
    const grid = document.getElementById("oni-carto-grid");
    if (!grid) return;
    const cells = grid.querySelectorAll(".oni-carto-cell");
    const len   = _trail.length;

    cells.forEach(c => { c.className = "oni-carto-cell"; c.innerHTML = ""; c.style.opacity = ""; });

    // Trail (index 1+)
    for (let i = 1; i < len; i++) {
      const cell = cells[_trail[i].y * COLS + _trail[i].x];
      if (!cell) continue;
      cell.classList.add("oni-carto-trail");
      cell.style.opacity = String(Math.max(0.35, 1 - (i / len) * 0.65));
    }

    // Head (index 0)
    const headCell = cells[_head.y * COLS + _head.x];
    if (headCell) {
      headCell.classList.add("oni-carto-head");
      headCell.innerHTML = _tokenImg
        ? `<img src="${_tokenImg}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;pointer-events:none;">`
        : `<i class="fas fa-user" style="font-size:16px;color:#fff;"></i>`;
    }

    // Treasure
    if (_treasure) {
      const tc = cells[_treasure.y * COLS + _treasure.x];
      if (tc) {
        tc.classList.add("oni-carto-treasure");
        tc.innerHTML = `<i class="fas ${TREASURE_ICON}" style="font-size:17px;color:#ffd700;filter:drop-shadow(0 0 5px rgba(255,215,0,0.9));"></i>`;
      }
    }

    // Hazards
    for (const h of _hazards) {
      const hc = cells[h.y * COLS + h.x];
      if (!hc) continue;
      hc.classList.add("oni-carto-hazard");
      hc.innerHTML = `<i class="fas ${h.icon}" style="font-size:15px;color:#e74c3c;filter:drop-shadow(0 0 4px rgba(231,76,60,0.85));"></i>`;
    }
  }

  function _renderSpectatorState(payload) {
    const { head, trail, treasure, hazards, score, hits, timeLeft } = payload;
    const grid = document.getElementById("oni-carto-grid");
    if (!grid) return;

    const cells = grid.querySelectorAll(".oni-carto-cell");
    const len   = trail?.length ?? 0;

    cells.forEach(c => { c.className = "oni-carto-cell"; c.innerHTML = ""; c.style.opacity = ""; });

    for (let i = 1; i < len; i++) {
      const cell = cells[trail[i].y * COLS + trail[i].x];
      if (!cell) continue;
      cell.classList.add("oni-carto-trail");
      cell.style.opacity = String(Math.max(0.35, 1 - (i / len) * 0.65));
    }

    if (head) {
      const hc = cells[head.y * COLS + head.x];
      if (hc) {
        hc.classList.add("oni-carto-head");
        hc.innerHTML = _tokenImg
          ? `<img src="${_tokenImg}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;pointer-events:none;">`
          : `<i class="fas fa-user" style="font-size:16px;color:#fff;"></i>`;
      }
    }

    if (treasure) {
      const tc = cells[treasure.y * COLS + treasure.x];
      if (tc) {
        tc.classList.add("oni-carto-treasure");
        tc.innerHTML = `<i class="fas ${TREASURE_ICON}" style="font-size:17px;color:#ffd700;filter:drop-shadow(0 0 5px rgba(255,215,0,0.9));"></i>`;
      }
    }

    for (const h of (hazards ?? [])) {
      const hc = cells[h.y * COLS + h.x];
      if (!hc) continue;
      hc.classList.add("oni-carto-hazard");
      hc.innerHTML = `<i class="fas ${h.icon}" style="font-size:15px;color:#e74c3c;filter:drop-shadow(0 0 4px rgba(231,76,60,0.85));"></i>`;
    }

    const scoreEl = document.getElementById("oni-carto-score");
    const hitsEl  = document.getElementById("oni-carto-hits");
    const timerEl = document.getElementById("oni-carto-timer");
    if (scoreEl) scoreEl.textContent = score ?? 0;
    if (hitsEl)  hitsEl.textContent  = hits  ?? 0;
    if (timerEl) timerEl.textContent = ((timeLeft ?? 0) / 1000).toFixed(1) + "s";
  }

  function _emitTick() {
    CAMP.Socket.emit(CAMP.MSG.CARTOGRAPHY_TICK, {
      actorId:  _actorId,
      head:     { ..._head },
      trail:    _trail.map(t => ({ x: t.x, y: t.y })),
      treasure: _treasure ? { ..._treasure } : null,
      hazards:  _hazards.map(h => ({ x: h.x, y: h.y, icon: h.icon })),
      score:    _score,
      hits:     _hits,
      timeLeft: _timeLeft,
    });
  }

  // ── Result panel ───────────────────────────────────────────────────────────
  function _showResultPanel(actorId, score, hits, charges) {
    document.getElementById("oni-carto-grid")?.style.setProperty("display", "none");
    document.getElementById("oni-carto-floats")?.style.setProperty("display", "none");
    document.getElementById("oni-carto-hud")?.style.setProperty("display", "none");
    document.getElementById("oni-carto-pre-game")?.style.setProperty("display", "none");

    const result = document.getElementById("oni-carto-result");
    if (!result) return;
    result.style.display = "flex";

    const gradeLabel =
      charges === 3 ? "Perfect!" :
      charges === 2 ? "Good!" :
                      "Standard";
    const gradeColor =
      charges === 3 ? "#c8a84b" :
      charges === 2 ? "#4caf50" :
                      "#8a8a8a";
    const chargeLabel = charges === 1 ? "1 Charge" : `${charges} Charges`;
    const isOwner = _checkIsOwner(actorId);

    result.innerHTML = `
      <div class="oni-carto-res-grade" style="color:${gradeColor};">${gradeLabel}</div>
      <div class="oni-carto-res-row">Score: <strong>${score}</strong></div>
      <div class="oni-carto-res-row">Errors: <strong>${hits}</strong></div>
      <div class="oni-carto-res-row">
        Cartography &rarr; <strong style="color:#c8a84b;">${chargeLabel}</strong>
      </div>
      <div class="oni-carto-res-desc">
        Once before the next rest, when your group makes a Travel Roll,
        you may reroll the die and keep the new result.
      </div>
      ${isOwner ? `<button id="oni-carto-proceed-btn" class="oni-carto-proceed-btn">Click to Proceed</button>` : ""}
    `;

    if (isOwner) {
      document.getElementById("oni-carto-proceed-btn")?.addEventListener("click", () => {
        if (game.user?.isGM) {
          CAMP.CartographyUI.resolveProceed(actorId);
        } else {
          CAMP.Socket.emit(CAMP.MSG.CARTOGRAPHY_PROCEED, { actorId });
        }
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _randomEmpty() {
    const occ = new Set(_trail.map(t => `${t.x},${t.y}`));
    if (_treasure) occ.add(`${_treasure.x},${_treasure.y}`);
    for (const h of _hazards) occ.add(`${h.x},${h.y}`);

    let pos, attempts = 0;
    do {
      pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      attempts++;
    } while (occ.has(`${pos.x},${pos.y}`) && attempts < 300);
    return pos;
  }

  function _spawnHazard() {
    const pos  = _randomEmpty();
    const icon = HAZARD_POOL[Math.floor(Math.random() * HAZARD_POOL.length)];
    return { ...pos, icon, despawnAt: performance.now() + HAZARD_LIFETIME_MS };
  }

  function _floatText(text, cellX, cellY, type) {
    let layer = document.getElementById("oni-carto-floats");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "oni-carto-floats";
      layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;";
      document.getElementById("oni-carto-grid-wrap")?.appendChild(layer);
    }
    const el = document.createElement("div");
    el.className = `oni-carto-float oni-carto-float-${type}`;
    el.textContent = text;
    el.style.left = `${cellX * CELL_PX + CELL_PX / 2}px`;
    el.style.top  = `${cellY * CELL_PX}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  function _updateHUD() {
    const s = document.getElementById("oni-carto-score");
    const h = document.getElementById("oni-carto-hits");
    const t = document.getElementById("oni-carto-timer");
    if (s) s.textContent = _score;
    if (h) h.textContent = _hits;
    if (t) t.textContent = (_timeLeft / 1000).toFixed(1) + "s";
  }

  function _stopLoop() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    document.removeEventListener("keydown", _onKey);
  }

  function _clearState() {
    _stopLoop();
    _actorId = null; _isOwner = false; _tokenImg = null;
    _phase   = "idle";
    _head    = { x: 7, y: 7 };
    _trail   = []; _dir = { dx: 1, dy: 0 }; _nextDir = { dx: 1, dy: 0 };
    _growPending = 0; _score = 0; _hits = 0; _invincibleUntil = 0;
    _treasure = null; _hazards = [];
    _gameStartTs = 0; _timeLeft = GAME_DURATION_MS;
    _rafId = null; _lastTickMs = 0; _lastSyncMs = 0;
  }

  function _checkIsOwner(actorId) {
    const actor = game.actors?.get(actorId);
    const uid   = Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ── Overlay builder ────────────────────────────────────────────────────────
  function _buildOverlay(actorName) {
    const ovl = document.createElement("div");
    ovl.id = OVL_ID;
    ovl.innerHTML = `
      <div class="oni-carto-frame">

        <div class="oni-carto-header">
          <span class="oni-carto-actor-name">${actorName ?? "?"}</span>
          <span class="oni-carto-title">Cartography</span>
        </div>

        <div id="oni-carto-hud" class="oni-carto-hud" style="display:none;">
          <span>Score: <strong id="oni-carto-score">0</strong></span>
          <span>Errors: <strong id="oni-carto-hits">0</strong></span>
          <span id="oni-carto-timer">15.0s</span>
        </div>

        <div id="oni-carto-pre-game" class="oni-carto-pre-game">
          <i class="fas fa-map" style="font-size:2.5rem;color:#c8a84b;opacity:.7;"></i>
          <div id="oni-carto-waiting-label" class="oni-carto-waiting-label">
            ${_isOwner ? "Navigate the map — collect treasure, avoid hazards!" : "Waiting for the explorer…"}
          </div>
          ${_isOwner ? `<button id="oni-carto-begin-btn" class="oni-carto-begin-btn">Begin</button>` : ""}
        </div>

        <div id="oni-carto-countdown" class="oni-carto-countdown" style="display:none;"></div>

        <div id="oni-carto-grid-wrap" style="position:relative;">
          <div id="oni-carto-grid" class="oni-carto-grid" style="display:none;">
            ${Array.from({ length: ROWS * COLS }, () => `<div class="oni-carto-cell"></div>`).join("")}
          </div>
        </div>

        <div id="oni-carto-result" class="oni-carto-result" style="display:none;"></div>

        <div class="oni-carto-legend">
          <span><i class="fas ${TREASURE_ICON}" style="color:#ffd700;"></i> +10 pts</span>
          <span><i class="fas fa-dragon" style="color:#e74c3c;"></i> Hazard −5 pts</span>
          <span style="display:inline-block;width:12px;height:12px;background:#2a7a50;border-radius:2px;vertical-align:middle;margin-right:3px;"></span>Trail −5 pts
        </div>

      </div>
    `;
    return ovl;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function _ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.82);
        animation: oni-carto-fadein 0.4s ease forwards;
      }
      #${OVL_ID}.oni-carto-fade-out {
        animation: oni-carto-fadeout 0.5s ease forwards;
      }
      .oni-carto-frame {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        background: rgba(12,8,3,0.95); border: 1px solid #5a3e10;
        border-radius: 10px; padding: 18px 24px;
        color: #e8dfc0;
        box-shadow: 0 0 50px rgba(0,0,0,0.9), inset 0 0 0 1px rgba(200,168,75,0.08);
        min-width: 530px;
      }
      .oni-carto-header {
        display: flex; align-items: baseline; gap: 10px;
      }
      .oni-carto-actor-name { font-size: 1.05rem; font-weight: 700; opacity: .85; }
      .oni-carto-title {
        font-size: 1.5rem; font-weight: 800;
        letter-spacing: 0.12em; text-transform: uppercase; color: #c8a84b;
      }
      .oni-carto-hud {
        display: flex; gap: 24px; font-size: 0.92rem;
        padding: 4px 14px; background: rgba(0,0,0,0.35);
        border: 1px solid rgba(200,168,75,0.15); border-radius: 6px;
        min-width: 300px; justify-content: space-between;
      }
      .oni-carto-pre-game {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        padding: 20px 0; min-height: 100px; justify-content: center;
      }
      .oni-carto-waiting-label {
        font-size: 0.95rem; opacity: 0.75; font-style: italic; text-align: center;
      }
      .oni-carto-begin-btn {
        padding: 9px 28px; font-size: 1rem; font-weight: 700;
        background: #c8a84b; color: #1a0d00;
        border: none; border-radius: 6px; cursor: pointer;
        letter-spacing: 0.06em; transition: background .15s;
      }
      .oni-carto-begin-btn:hover { background: #e0c060; }
      .oni-carto-countdown {
        font-size: 3.5rem; font-weight: 900; color: #c8a84b;
        text-shadow: 0 0 24px rgba(200,168,75,0.8);
        display: flex; align-items: center; justify-content: center;
        min-height: 70px; min-width: 120px;
        animation: oni-carto-pop 0.3s ease;
      }
      .oni-carto-grid {
        grid-template-columns: repeat(${COLS}, ${CELL_PX}px);
        grid-template-rows: repeat(${ROWS}, ${CELL_PX}px);
        border: 2px solid #3a2a08;
        background: #080502;
        box-shadow: 0 0 24px rgba(200,168,75,0.12);
      }
      .oni-carto-cell {
        width: ${CELL_PX}px; height: ${CELL_PX}px;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid rgba(255,255,255,0.03);
        box-sizing: border-box; overflow: hidden;
      }
      .oni-carto-trail    { background: #1e6040; }
      .oni-carto-head     { background: #2fa060; }
      .oni-carto-treasure { background: rgba(255,215,0,0.06); }
      .oni-carto-hazard   { background: rgba(231,76,60,0.06); }
      .oni-carto-grid.oni-carto-flash-red {
        box-shadow: 0 0 0 3px #e74c3c, 0 0 24px rgba(231,76,60,0.5);
      }
      .oni-carto-float {
        position: absolute;
        transform: translateX(-50%);
        font-size: 0.88rem; font-weight: 800;
        pointer-events: none; white-space: nowrap;
        animation: oni-carto-float-up 0.9s ease forwards;
      }
      .oni-carto-float-gain { color: #ffd700; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
      .oni-carto-float-loss { color: #e74c3c; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
      .oni-carto-result {
        flex-direction: column; align-items: center; gap: 10px;
        padding: 16px 0; min-height: 180px; min-width: 300px; justify-content: center;
      }
      .oni-carto-res-grade {
        font-size: 2.2rem; font-weight: 900;
        letter-spacing: 0.1em; text-transform: uppercase;
      }
      .oni-carto-res-row { font-size: 0.98rem; }
      .oni-carto-res-desc {
        font-size: 0.78rem; opacity: .65; font-style: italic;
        text-align: center; max-width: 320px; margin-top: 4px;
      }
      .oni-carto-proceed-btn {
        margin-top: 10px; padding: 8px 22px; font-size: 0.9rem; font-weight: 700;
        background: #c8a84b; color: #1a0d00;
        border: none; border-radius: 6px; cursor: pointer; transition: background .15s;
      }
      .oni-carto-proceed-btn:hover { background: #e0c060; }
      .oni-carto-legend {
        display: flex; gap: 14px; font-size: 0.75rem; opacity: .6; align-items: center;
        flex-wrap: wrap; justify-content: center;
      }
      @keyframes oni-carto-fadein  { from { opacity: 0 } to { opacity: 1 } }
      @keyframes oni-carto-fadeout { from { opacity: 1 } to { opacity: 0 } }
      @keyframes oni-carto-pop {
        0%   { transform: scale(0.7); }
        70%  { transform: scale(1.1); }
        100% { transform: scale(1.0); }
      }
      @keyframes oni-carto-float-up {
        0%   { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-44px); }
      }
    `;
    document.head.appendChild(s);
  }

  console.debug(TAG, "Cartography UI loaded.");
})();
