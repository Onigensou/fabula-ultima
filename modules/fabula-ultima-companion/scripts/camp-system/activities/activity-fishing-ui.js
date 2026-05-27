// ============================================================================
// Camp Activity — Fishing UI
//
// Two-phase minigame overlay.
//
// Phase 1 — Casting
//   Vertical gauge oscillates 0→100→0. Owner presses SPACE to lock it.
//   "Perfect!" at ≥97. Cast strength determines catch chance + fish tier (+ WLP).
//   After cast: wait 1.5–3 s, then roll for catch.
//
// Phase 2 — Battle
//   Left bar: fish icon bounces up/down erratically. Player holds SPACE to
//   raise their fishing bar upward; it falls under gravity when released.
//   Right bar: Fish HP fills while fish is inside bar, drains when outside.
//   Win: HP reaches 100%. Lose: HP reaches 0%.
//
// Stat influence (read from actor.system.props):
//   MIG → HP fill rate       DEX → gauge speed + bar up-speed
//   INS → fishing bar height  WLP → catch chance + tier thresholds
//
// Round flow:
//   Round 1 — gated by owner's "Cast Line" button.
//   Rounds 2/3 — GM broadcasts FISHING_NEXT_ROUND; all clients auto-transition.
//
// Socket sync:
//   GM  → all  FISHING_START     → show()
//   own → all  FISHING_BEGIN     → spectateBegin()     (round 1 spectators)
//   own → all  FISHING_CAST      → onCast()            (cast value snapshot)
//   own → all  FISHING_HIT       → onHit()             (battle heartbeat ~250 ms)
//   own → GM   FISHING_RESULT    → resolveRound()      (round score)
//   GM  → all  FISHING_RESULT    → applyResult()       (round reveal)
//   GM  → all  FISHING_NEXT_ROUND→ beginRound()        (rounds 2/3 transition)
//   own → GM   FISHING_PROCEED   → resolveProceed()
//   GM  → all  FISHING_DONE      → hide()
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const TAG       = "[CampSystem][FishingUI]";
  const OVL_ID    = "oni-camp-fish-ovl";
  const STYLE_ID  = "oni-camp-fish-style";

  // ---------------------------------------------------------------------------
  // Sound URLs
  // ---------------------------------------------------------------------------
  const SFX = {
    SLOW_REEL:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/slowReel.wav",
    FAST_REEL:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/fastReel.wav",
    LINE_CAST:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Water_Drop.mp3",
    FISH_LOST:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/participant_exit.wav",
    FISH_CAUGHT: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/emotion_up.wav",
  };

  // ---------------------------------------------------------------------------
  // Fish tier tables (mirrors activity-fishing.js — needed for display)
  // ---------------------------------------------------------------------------
  const FISH_TIERS  = [
    ["Small Fish",   "Mudfish",   "Pebblecarp"],
    ["River Trout",  "Silverscale", "Speckled Bass"],
    ["Coral Bass",   "Goldfish",  "Moonfish"],
    ["Starfish",     "Dragonscale Carp", "Phantom Eel"],
  ];
  const TIER_NAMES  = ["Shallow Waters", "River Catch", "Deep Waters", "Legendary"];
  const TIER_COLORS = ["#7a8c7a",        "#3a7a35",     "#3a5a9a",    "#c8a84b"];

  // ---------------------------------------------------------------------------
  // Base game constants
  // ---------------------------------------------------------------------------
  const GAUGE_H          = 260;   // px — gauge track height
  const BASE_GAUGE_SPEED = 45;    // units/sec at DEX 8
  const BATTLE_BAR_H     = 300;   // px — gameplay bar height
  const BASE_BAR_H       = 60;    // px — fishing bar height at INS 8
  const BASE_UP_SPEED    = 180;   // px/sec bar rises when SPACE held (DEX 8)
  const BAR_DOWN_SPEED   = 120;   // px/sec bar falls (gravity, fixed)
  const BASE_FILL_RATE   = 15;    // %/sec HP fills when fish in zone (MIG 8)
  const HP_DRAIN_RATE    = 10;    // %/sec HP drains when fish out of zone (fixed)
  const FISH_START_HP    = 50;    // %
  const HIT_INTERVAL_MS  = 250;   // ms — battle heartbeat to spectators

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let _actorId      = null;
  let _actorName    = null;
  let _isOwner      = false;
  let _currentRound = 1;
  let _totalRounds  = 3;
  let _catches      = [];    // accumulated this session

  // Stat cache (only meaningful when _isOwner)
  let _stats = { mig: 8, dex: 8, ins: 8, wlp: 8 };

  // Derived from stats
  let _gaugeSpeed  = BASE_GAUGE_SPEED;
  let _fillRate    = BASE_FILL_RATE;
  let _barUpSpeed  = BASE_UP_SPEED;
  let _playerBarH  = BASE_BAR_H;

  // Casting phase
  let _gaugeValue  = 0;
  let _gaugeDir    = 1;
  let _castLocked  = false;
  let _gaugeRafId  = null;
  let _gaugeLastMs = 0;

  // Battle phase
  let _fishY           = BATTLE_BAR_H / 2;
  let _fishVel         = 100;
  let _fishDirChangeMs = 0;
  let _playerBarY      = 0;
  let _fishHp          = FISH_START_HP;
  let _spaceDown       = false;
  let _battleActive    = false;
  let _battleRafId     = null;
  let _battleLastMs    = 0;
  let _hitIntervalId   = null;

  // Audio
  let _slowReelAudio = null;
  let _fastReelAudio = null;

  // Input
  let _spaceHandler  = null;

  // DOM cache
  const _el = {};

  // ---------------------------------------------------------------------------
  // Ownership helpers
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _checkIsOwner(actorId) {
    const actor = game.actors?.get(actorId);
    if (!actor) return game.user?.isGM ?? false;
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  // ---------------------------------------------------------------------------
  // Stat helpers
  // ---------------------------------------------------------------------------
  function _loadStats(actorId) {
    const actor = game.actors?.get(actorId);
    const p = actor?.system?.props ?? {};
    _stats = {
      mig: parseInt(p.mig_current) || 8,
      dex: parseInt(p.dex_current) || 8,
      ins: parseInt(p.ins_current) || 8,
      wlp: parseInt(p.wlp_current) || 8,
    };
  }

  function _applyStats() {
    _gaugeSpeed  = Math.max(20, BASE_GAUGE_SPEED - (_stats.dex - 8) * 0.75);
    _fillRate    = Math.max(5,  BASE_FILL_RATE   + (_stats.mig - 8) * 0.75);
    _barUpSpeed  = Math.max(80, BASE_UP_SPEED    + (_stats.dex - 8) * 5);
    _playerBarH  = Math.min(130, Math.max(30, BASE_BAR_H + (_stats.ins - 8) * 5));
  }

  function _catchChance(strength) {
    return Math.min(95, Math.max(5, 35 + strength * 0.45 + (_stats.wlp - 8) * 2));
  }

  function _fishTier(strength) {
    const shift = (_stats.wlp - 8) * 1.5;
    if (strength >= Math.max(50, 97 - shift)) return 3;
    if (strength >= Math.max(20, 66 - shift)) return 2;
    if (strength >= Math.max(5,  33 - shift)) return 1;
    return 0;
  }

  function _pickFish(strength) {
    const tier  = _fishTier(strength);
    const pool  = FISH_TIERS[tier];
    return { fishName: pool[Math.floor(Math.random() * pool.length)], tier };
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  function _playSound(src, volume = 0.7) {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch {
      try { const a = new Audio(src); a.volume = volume; a.play().catch(() => {}); } catch {}
    }
  }

  function _startLoop(src, volume = 0.5) {
    try {
      const a = new Audio(src);
      a.volume = volume;
      a.loop   = true;
      a.play().catch(() => {});
      return a;
    } catch { return null; }
  }

  function _stopLoop(a) {
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch {}
  }

  // ---------------------------------------------------------------------------
  // State cleanup
  // ---------------------------------------------------------------------------
  function _clearState() {
    if (_gaugeRafId  !== null) { cancelAnimationFrame(_gaugeRafId);  _gaugeRafId  = null; }
    if (_battleRafId !== null) { cancelAnimationFrame(_battleRafId); _battleRafId = null; }
    if (_hitIntervalId !== null) { clearInterval(_hitIntervalId); _hitIntervalId = null; }
    _removeSpaceHandler();
    _stopLoop(_slowReelAudio); _slowReelAudio = null;
    _stopLoop(_fastReelAudio); _fastReelAudio = null;

    _gaugeValue   = 0;
    _gaugeDir     = 1;
    _castLocked   = false;
    _fishY        = BATTLE_BAR_H / 2;
    _playerBarY   = BATTLE_BAR_H / 2 - BASE_BAR_H / 2;
    _fishHp       = FISH_START_HP;
    _spaceDown    = false;
    _battleActive = false;
    Object.keys(_el).forEach(k => _el[k] = null);
  }

  function _removeSpaceHandler() {
    if (!_spaceHandler) return;
    document.removeEventListener("keydown", _spaceHandler, { capture: true });
    document.removeEventListener("keyup",   _spaceHandler, { capture: true });
    _spaceHandler = null;
  }

  // ---------------------------------------------------------------------------
  // CSS injection
  // ---------------------------------------------------------------------------
  function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position:fixed; inset:0; z-index:10000;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.84);
        animation: oni-fish-fadein .35s ease forwards;
      }
      #${OVL_ID}.oni-fish-out { animation: oni-fish-fadeout .3s ease forwards; }
      @keyframes oni-fish-fadein  { from{opacity:0} to{opacity:1} }
      @keyframes oni-fish-fadeout { from{opacity:1} to{opacity:0} }
      @keyframes oni-fish-pop   { from{transform:scale(1.4);opacity:.4} to{transform:scale(1);opacity:1} }
      @keyframes oni-fish-swim  {
        0%,100% { transform:translateX(0); }
        40%     { transform:translateX(20px); }
      }
      @keyframes oni-fish-shimmer {
        0%,100% { transform:translateX(-10px); opacity:.25; }
        50%     { transform:translateX(20px);  opacity:.45; }
      }
      @keyframes oni-fish-hit-flash {
        0%  { opacity:1; transform:scale(1); }
        60% { opacity:1; transform:scale(1.15); }
        100%{ opacity:0; transform:scale(1.3); }
      }

      /* ── Card ─────────────────── */
      .oni-fish-card {
        background:linear-gradient(160deg,#0d1a24,#162636);
        border:2px solid #1e4a6b; border-radius:14px;
        padding:24px 30px 22px; width:720px; max-width:96vw;
        box-shadow:0 8px 40px rgba(0,0,0,.85);
        color:#b8d4e8; font-family:'Palatino Linotype',serif;
        position:relative; user-select:none;
      }

      /* ── Header ───────────────── */
      .oni-fish-header {
        display:flex; justify-content:space-between; align-items:center;
        margin-bottom:18px;
      }
      .oni-fish-title { font-size:1.3em; font-weight:700; color:#5ab8e8; letter-spacing:.04em; }
      .oni-fish-actor { font-size:.88em; opacity:.65; }
      .oni-fish-round { font-size:.9em; color:#5ab8e8; opacity:.8; font-weight:700; }

      /* ── Cast scene ────────────── */
      .oni-fish-scene {
        display:flex; gap:20px;
        align-items:flex-end; justify-content:center;
        min-height:300px;
      }
      .oni-fish-gauge-wrap {
        display:flex; flex-direction:column; align-items:center; gap:5px;
      }
      .oni-fish-gauge-lbl { font-size:.75em; opacity:.5; text-transform:uppercase; letter-spacing:.06em; }
      .oni-fish-gauge-track {
        width:30px; height:${GAUGE_H}px;
        background:#0a1520; border:1px solid #1e4a6b;
        border-radius:15px; position:relative; overflow:hidden;
      }
      .oni-fish-gauge-fill {
        position:absolute; bottom:0; left:0; right:0;
        background:linear-gradient(to top,#1e8a3a,#5af080);
        border-radius:15px; transition:none; will-change:height;
      }
      .oni-fish-gauge-fill.perfect {
        background:linear-gradient(to top,#c8a84b,#ffef80);
        box-shadow:0 0 14px 4px rgba(200,168,75,.65);
      }
      .oni-fish-gauge-num {
        font-size:1em; font-weight:700; color:#5af080;
        min-width:36px; text-align:center;
      }
      .oni-fish-gauge-num.perfect { color:#c8a84b; }

      /* centre: avatar + pond */
      .oni-fish-center {
        flex:1; display:flex; flex-direction:column;
        align-items:center; justify-content:flex-end;
      }
      .oni-fish-scene-row { display:flex; align-items:flex-end; gap:0; width:100%; justify-content:center; }
      .oni-fish-avatar-wrap { display:flex; flex-direction:column; align-items:center; }
      .oni-fish-bubble {
        background:rgba(10,21,32,.85); border:1px solid #1e4a6b;
        border-radius:10px; padding:5px 12px; font-size:.82em;
        color:#b8d4e8; margin-bottom:6px; white-space:nowrap;
        min-height:28px; display:flex; align-items:center; justify-content:center;
      }
      .oni-fish-avatar {
        width:80px; height:80px; border-radius:8px;
        border:2px solid #1e4a6b; object-fit:cover;
      }
      .oni-fish-pond {
        width:220px; height:120px;
        background:linear-gradient(180deg,#1a4a6a 0%,#0d2e4a 60%,#081e30 100%);
        border-radius:50% 50% 30% 30%/30% 30% 20% 20%;
        border:2px solid #1e4a6b;
        position:relative; overflow:hidden; margin-left:16px;
      }
      .oni-fish-shimmer {
        position:absolute; top:22%; left:8%; right:8%; height:3px;
        background:linear-gradient(90deg,transparent,rgba(90,184,232,.35),transparent);
        border-radius:2px; animation:oni-fish-shimmer 3s ease-in-out infinite;
      }
      .oni-fish-fshadow {
        position:absolute; font-size:2em; top:38%; left:18%;
        opacity:.3; color:#1a5a8a; animation:oni-fish-swim 4s ease-in-out infinite;
        filter:blur(1px);
      }
      .oni-fish-fshadow2 { top:55%; left:48%; font-size:1.3em; animation-delay:-2s; }
      .oni-fish-ground { width:100%; height:14px; background:linear-gradient(180deg,#2a1e10,#1a1008); border-radius:4px 4px 0 0; }

      /* ── Begin area ─────────────── */
      .oni-fish-begin-area { text-align:center; padding:10px 0 4px; }
      .oni-fish-begin-hint { font-size:.86em; opacity:.6; font-style:italic; margin-bottom:12px; }
      .oni-fish-begin-btn {
        padding:10px 32px; background:#1e6a9a; color:#e8f4fc;
        border:none; border-radius:8px; font-size:1.05em; font-weight:700;
        cursor:pointer; font-family:inherit; transition:background .15s;
      }
      .oni-fish-begin-btn:hover { background:#2a8ac8; }

      /* ── Spectate wait ──────────── */
      .oni-fish-spec-wait { text-align:center; padding:24px 0; font-size:.9em; opacity:.5; font-style:italic; }

      /* ── Hit flash ──────────────── */
      .oni-fish-hit-overlay {
        position:fixed; inset:0; z-index:10100;
        display:flex; align-items:center; justify-content:center;
        pointer-events:none; background:rgba(255,60,60,.06);
      }
      .oni-fish-hit-text {
        font-size:2.8em; font-weight:900; color:#ff4444;
        font-family:'Palatino Linotype',serif;
        text-shadow:0 0 30px rgba(255,80,80,.8);
        animation:oni-fish-hit-flash .75s ease forwards;
      }

      /* ── Battle area ────────────── */
      .oni-fish-battle { display:flex; align-items:center; justify-content:center; gap:32px; padding:4px 0 8px; }
      .oni-fish-bar-lbl { font-size:.75em; opacity:.5; text-transform:uppercase; letter-spacing:.06em; text-align:center; margin-bottom:4px; }

      /* Gameplay bar (left) */
      .oni-fish-game-bar {
        width:62px; height:${BATTLE_BAR_H}px;
        background:#0a1520; border:2px solid #1e4a6b;
        border-radius:10px; position:relative; overflow:hidden;
      }
      .oni-fish-player-bar {
        position:absolute; left:3px; right:3px;
        background:linear-gradient(180deg,#2a8a3a,#1e6a2a);
        border-radius:6px; box-shadow:0 0 8px rgba(42,138,58,.4);
        transition:none; will-change:top,height;
      }
      .oni-fish-player-bar.in-zone {
        background:linear-gradient(180deg,#3ab84a,#28a03a);
        box-shadow:0 0 14px rgba(58,184,74,.7);
      }
      .oni-fish-icon {
        position:absolute; left:50%; transform:translateX(-50%);
        font-size:1.5em; transition:none; will-change:top;
        filter:drop-shadow(0 0 4px rgba(90,184,232,.5));
      }

      /* HP bar (right) */
      .oni-fish-hp-wrap { display:flex; flex-direction:column; align-items:center; gap:0; }
      .oni-fish-hp-track {
        width:28px; height:${BATTLE_BAR_H}px;
        background:#0a1520; border:1px solid #1e4a6b;
        border-radius:14px; position:relative; overflow:hidden;
      }
      .oni-fish-hp-fill {
        position:absolute; bottom:0; left:0; right:0;
        background:linear-gradient(to top,#c84a4a,#e86060);
        border-radius:14px; transition:none; will-change:height;
      }
      .oni-fish-hp-num { font-size:.82em; font-weight:700; color:#e86060; text-align:center; margin-top:4px; }

      /* ── Hint ───────────────────── */
      .oni-fish-hint { text-align:center; font-size:.8em; opacity:.5; margin-top:9px; letter-spacing:.04em; }
      .oni-fish-key { display:inline-block; padding:2px 8px; background:#0a1520; border:1px solid #1e4a6b; border-radius:4px; font-family:monospace; }

      /* ── Round result ───────────── */
      .oni-fish-round-result { text-align:center; padding:8px 0 4px; animation:oni-fish-pop .35s ease forwards; }
      .oni-fish-catch-name { font-size:1.3em; font-weight:700; color:#5af080; }
      .oni-fish-catch-tier { font-size:.82em; margin-top:3px; opacity:.7; }
      .oni-fish-no-catch { font-size:1.1em; color:#7a9ab8; opacity:.7; font-style:italic; }

      /* ── Final summary ──────────── */
      .oni-fish-summary { text-align:center; padding:10px 0 6px; animation:oni-fish-pop .35s ease forwards; }
      .oni-fish-summary-head { font-size:1.2em; font-weight:700; margin-bottom:6px; }
      .oni-fish-summary-list { list-style:none; padding:0; margin:0 0 12px; font-size:.95em; }
      .oni-fish-summary-list li { margin:3px 0; }
      .oni-fish-summary-empty { font-size:.9em; opacity:.55; font-style:italic; margin-bottom:12px; }
      .oni-fish-proceed-btn {
        padding:9px 28px; background:#1e3a5a; color:#b8d4e8;
        border:1px solid #3a7ab8; border-radius:8px;
        font-size:.95em; font-weight:700; cursor:pointer; font-family:inherit;
        transition:background .15s;
      }
      .oni-fish-proceed-btn:hover { background:#2a5a8a; }

      /* ── Stat row ───────────────── */
      .oni-fish-stat-row {
        display:flex; gap:14px; justify-content:center;
        font-size:.74em; opacity:.45; margin-top:10px; letter-spacing:.04em;
      }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // HTML builders
  // ---------------------------------------------------------------------------
  function _actorImg() {
    return game.actors?.get(_actorId)?.img ?? "icons/svg/mystery-man.svg";
  }

  function _buildOverlay() {
    const existing = document.getElementById(OVL_ID);
    if (existing) existing.remove();
    _injectStyles();

    const ovl = document.createElement("div");
    ovl.id = OVL_ID;
    ovl.innerHTML = `
      <div class="oni-fish-card">
        <div class="oni-fish-header">
          <div>
            <div class="oni-fish-title">🎣 Fishing</div>
            <div class="oni-fish-actor">${_actorName ?? ""}</div>
          </div>
          <div class="oni-fish-round" id="oni-fish-round-lbl">
            Round ${_currentRound} / ${_totalRounds}
          </div>
        </div>

        <div id="oni-fish-stage">
          ${_isOwner ? _htmlBeginArea() : _htmlSpecWait()}
        </div>

        <div class="oni-fish-stat-row" id="oni-fish-stat-row">
          <span>MIG&nbsp;<strong id="oni-fish-s-mig">${_stats.mig}</strong></span>
          <span>DEX&nbsp;<strong id="oni-fish-s-dex">${_stats.dex}</strong></span>
          <span>INS&nbsp;<strong id="oni-fish-s-ins">${_stats.ins}</strong></span>
          <span>WLP&nbsp;<strong id="oni-fish-s-wlp">${_stats.wlp}</strong></span>
        </div>

        <button class="oni-fish-proceed-btn" id="oni-fish-proceed" style="display:none;margin-top:14px;">
          Click to Proceed
        </button>
      </div>
    `;
    document.body.appendChild(ovl);
    return ovl;
  }

  function _htmlBeginArea() {
    return `
      <div class="oni-fish-begin-area" id="oni-fish-begin-area">
        <div class="oni-fish-begin-hint">Stop the gauge at the right moment for a stronger cast!</div>
        <button class="oni-fish-begin-btn" id="oni-fish-begin-btn">Cast Line</button>
      </div>
    `;
  }

  function _htmlSpecWait(label) {
    return `<div class="oni-fish-spec-wait">${label ?? `Watching ${_actorName ?? "the fisher"} fish…`}</div>`;
  }

  function _htmlCastScene(interactive) {
    return `
      <div class="oni-fish-scene">
        <div class="oni-fish-gauge-wrap">
          <div class="oni-fish-gauge-lbl">Cast</div>
          <div class="oni-fish-gauge-track">
            <div class="oni-fish-gauge-fill" id="oni-fish-g-fill" style="height:0%;"></div>
          </div>
          <div class="oni-fish-gauge-num" id="oni-fish-g-num">0</div>
        </div>
        <div class="oni-fish-center">
          <div class="oni-fish-scene-row">
            <div class="oni-fish-avatar-wrap">
              <div class="oni-fish-bubble" id="oni-fish-bubble">
                ${interactive ? "Press SPACE to cast!" : "Casting…"}
              </div>
              <img class="oni-fish-avatar" src="${_actorImg()}" alt="">
            </div>
            <div class="oni-fish-pond">
              <div class="oni-fish-shimmer"></div>
              <div class="oni-fish-fshadow">🐟</div>
              <div class="oni-fish-fshadow oni-fish-fshadow2">🐡</div>
            </div>
          </div>
          <div class="oni-fish-ground"></div>
        </div>
      </div>
      ${interactive
        ? `<div class="oni-fish-hint"><span class="oni-fish-key">SPACE</span> — stop the gauge</div>`
        : `<div class="oni-fish-hint">Spectating cast…</div>`
      }
    `;
  }

  function _htmlBattleScene(interactive) {
    return `
      <div class="oni-fish-battle">
        <div>
          <div class="oni-fish-bar-lbl">Reel</div>
          <div class="oni-fish-game-bar" id="oni-fish-game-bar">
            <div class="oni-fish-player-bar" id="oni-fish-pbar"
                 style="top:${_playerBarY}px;height:${_playerBarH}px;"></div>
            <div class="oni-fish-icon" id="oni-fish-ficon"
                 style="top:${(_fishY - 14).toFixed(1)}px;">🐟</div>
          </div>
        </div>
        <div class="oni-fish-hp-wrap">
          <div class="oni-fish-bar-lbl">Fish HP</div>
          <div class="oni-fish-hp-track">
            <div class="oni-fish-hp-fill" id="oni-fish-hp-fill"
                 style="height:${_fishHp.toFixed(1)}%;"></div>
          </div>
          <div class="oni-fish-hp-num" id="oni-fish-hp-num">${Math.round(_fishHp)}%</div>
        </div>
      </div>
      ${interactive
        ? `<div class="oni-fish-hint">Hold <span class="oni-fish-key">SPACE</span> to reel in</div>`
        : `<div class="oni-fish-hint">Spectating battle…</div>`
      }
    `;
  }

  // ---------------------------------------------------------------------------
  // DOM cache helpers
  // ---------------------------------------------------------------------------
  function _cacheCastEls() {
    _el.gFill  = document.getElementById("oni-fish-g-fill");
    _el.gNum   = document.getElementById("oni-fish-g-num");
    _el.bubble = document.getElementById("oni-fish-bubble");
  }

  function _cacheBattleEls() {
    _el.pbar   = document.getElementById("oni-fish-pbar");
    _el.ficon  = document.getElementById("oni-fish-ficon");
    _el.hpFill = document.getElementById("oni-fish-hp-fill");
    _el.hpNum  = document.getElementById("oni-fish-hp-num");
  }

  function _updateRoundLbl() {
    const el = document.getElementById("oni-fish-round-lbl");
    if (el) el.textContent = `Round ${_currentRound} / ${_totalRounds}`;
  }

  // ---------------------------------------------------------------------------
  // Casting gauge — rAF loop
  // ---------------------------------------------------------------------------
  function _startGaugeLoop() {
    _gaugeValue  = 0;
    _gaugeDir    = 1;
    _castLocked  = false;
    _gaugeLastMs = performance.now();

    function _frame(ts) {
      if (_castLocked || !document.getElementById(OVL_ID)) return;
      const dt = Math.min(ts - _gaugeLastMs, 50) / 1000;
      _gaugeLastMs = ts;
      _gaugeValue += _gaugeDir * _gaugeSpeed * dt;
      if (_gaugeValue >= 100) { _gaugeValue = 100; _gaugeDir = -1; }
      if (_gaugeValue <= 0)   { _gaugeValue = 0;   _gaugeDir =  1; }
      _drawGauge(_gaugeValue);
      _gaugeRafId = requestAnimationFrame(_frame);
    }
    _gaugeRafId = requestAnimationFrame(_frame);
  }

  function _drawGauge(val) {
    if (_el.gFill) {
      _el.gFill.style.height = `${val.toFixed(1)}%`;
      _el.gFill.classList.toggle("perfect", val >= 97);
    }
    if (_el.gNum) {
      _el.gNum.textContent = Math.round(val);
      _el.gNum.classList.toggle("perfect", val >= 97);
    }
  }

  // ---------------------------------------------------------------------------
  // Spacebar — casting (owner, keydown once to lock)
  // ---------------------------------------------------------------------------
  function _attachCastSpace(actorId) {
    _removeSpaceHandler();
    const h = (e) => {
      if (e.type !== "keydown" || e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _removeSpaceHandler();
      _onCastSpacePress(actorId);
    };
    _spaceHandler = h;
    document.addEventListener("keydown", _spaceHandler, { capture: true });
  }

  function _onCastSpacePress(actorId) {
    if (_castLocked) return;
    _castLocked = true;
    if (_gaugeRafId !== null) { cancelAnimationFrame(_gaugeRafId); _gaugeRafId = null; }

    const strength = Math.round(_gaugeValue);
    const perfect  = strength >= 97;

    if (_el.bubble) _el.bubble.textContent = perfect ? "✨ Perfect cast!" : `Cast: ${strength}`;
    if (_el.gNum)   { _el.gNum.style.fontSize = perfect ? "1.3em" : ""; }

    _playSound(SFX.LINE_CAST, 0.8);
    CAMP.Socket.emit(CAMP.MSG.FISHING_CAST, { actorId, strength, perfect });

    setTimeout(() => _beginWaitPhase(actorId, strength), 800);
  }

  // ---------------------------------------------------------------------------
  // Wait phase — slow reel + dots, then roll for catch
  // ---------------------------------------------------------------------------
  function _beginWaitPhase(actorId, strength) {
    if (_el.bubble) _el.bubble.textContent = "…";
    _slowReelAudio = _startLoop(SFX.SLOW_REEL, 0.4);

    const waitMs = 1500 + Math.random() * 1500;
    const frames = [".", "..", "...", ".."];
    let fi = 0;
    const dotTimer = setInterval(() => {
      if (_el.bubble) _el.bubble.textContent = frames[fi++ % frames.length];
    }, 380);

    setTimeout(() => {
      clearInterval(dotTimer);
      _stopLoop(_slowReelAudio); _slowReelAudio = null;

      const caught = Math.random() * 100 < _catchChance(strength);
      if (!caught) {
        _onNoCatch(actorId);
      } else {
        const { fishName, tier } = _pickFish(strength);
        _onCaught(actorId, fishName, tier);
      }
    }, waitMs);
  }

  function _onNoCatch(actorId) {
    if (_el.bubble) _el.bubble.textContent = "Nothing…";
    CAMP.Socket.emit(CAMP.MSG.FISHING_RESULT, { actorId, fishName: null });
  }

  // ---------------------------------------------------------------------------
  // Hit — flash then battle
  // ---------------------------------------------------------------------------
  function _onCaught(actorId, fishName, tier) {
    if (_el.bubble) _el.bubble.textContent = "Fish on!";

    const flash = document.createElement("div");
    flash.className = "oni-fish-hit-overlay";
    flash.innerHTML = `<div class="oni-fish-hit-text">Hit!</div>`;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 800);

    setTimeout(() => _startBattle(actorId, fishName, tier), 900);
  }

  // ---------------------------------------------------------------------------
  // Battle phase — rAF game loop (owner)
  // ---------------------------------------------------------------------------
  function _startBattle(actorId, fishName, tier) {
    const stage = document.getElementById("oni-fish-stage");
    if (!stage) return;

    // Reset state
    _fishY        = BATTLE_BAR_H * 0.35;
    _playerBarY   = BATTLE_BAR_H / 2 - _playerBarH / 2;
    _fishHp       = FISH_START_HP;
    _fishVel      = (Math.random() < 0.5 ? 1 : -1) * (90 + Math.random() * 60);
    _fishDirChangeMs = performance.now() + 500 + Math.random() * 700;
    _spaceDown    = false;
    _battleActive = true;

    stage.innerHTML = _htmlBattleScene(true);
    _cacheBattleEls();

    _fastReelAudio = _startLoop(SFX.FAST_REEL, 0.45);

    // Spacebar hold/release handler
    _removeSpaceHandler();
    const spH = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _spaceDown = (e.type === "keydown");
    };
    _spaceHandler = spH;
    document.addEventListener("keydown", _spaceHandler, { capture: true });
    document.addEventListener("keyup",   _spaceHandler, { capture: true });

    // rAF loop
    _battleLastMs = performance.now();
    function _frame(ts) {
      if (!_battleActive || !document.getElementById(OVL_ID)) return;
      const dt = Math.min(ts - _battleLastMs, 50) / 1000;
      _battleLastMs = ts;

      // Fish movement
      if (ts >= _fishDirChangeMs) {
        const spd = 80 + Math.random() * 100 + (_fishHp / 100) * 80;
        _fishVel = (Math.random() < 0.5 ? 1 : -1) * spd;
        _fishDirChangeMs = ts + 500 + Math.random() * 900;
      }
      _fishY += _fishVel * dt;
      if (_fishY < 14)                 { _fishY = 14;                   _fishVel = Math.abs(_fishVel); }
      if (_fishY > BATTLE_BAR_H - 14)  { _fishY = BATTLE_BAR_H - 14;   _fishVel = -Math.abs(_fishVel); }

      // Player bar
      if (_spaceDown) {
        _playerBarY -= _barUpSpeed  * dt;
      } else {
        _playerBarY += BAR_DOWN_SPEED * dt;
      }
      _playerBarY = Math.max(0, Math.min(BATTLE_BAR_H - _playerBarH, _playerBarY));

      // Zone check
      const inZone = _fishY >= _playerBarY && _fishY <= (_playerBarY + _playerBarH);

      // HP
      _fishHp = inZone
        ? Math.min(100, _fishHp + _fillRate   * dt)
        : Math.max(0,   _fishHp - HP_DRAIN_RATE * dt);

      // DOM
      if (_el.ficon)  _el.ficon.style.top    = `${(_fishY - 14).toFixed(1)}px`;
      if (_el.pbar)   {
        _el.pbar.style.top    = `${_playerBarY.toFixed(1)}px`;
        _el.pbar.style.height = `${_playerBarH}px`;
        _el.pbar.classList.toggle("in-zone", inZone);
      }
      if (_el.hpFill) _el.hpFill.style.height  = `${_fishHp.toFixed(1)}%`;
      if (_el.hpNum)  _el.hpNum.textContent     = `${Math.round(_fishHp)}%`;

      // End conditions
      if (_fishHp >= 100) { _endBattle(actorId, true,  fishName); return; }
      if (_fishHp <= 0)   { _endBattle(actorId, false, fishName); return; }

      _battleRafId = requestAnimationFrame(_frame);
    }
    _battleRafId = requestAnimationFrame(_frame);

    // Heartbeat to spectators
    _hitIntervalId = setInterval(() => {
      if (!_battleActive) return;
      CAMP.Socket.emit(CAMP.MSG.FISHING_HIT, {
        actorId,
        fishY:  _fishY,
        barY:   _playerBarY,
        fishHp: _fishHp,
        inZone: (_fishY >= _playerBarY && _fishY <= _playerBarY + _playerBarH),
      });
    }, HIT_INTERVAL_MS);
  }

  function _endBattle(actorId, won, fishName) {
    _battleActive = false;
    if (_battleRafId   !== null) { cancelAnimationFrame(_battleRafId); _battleRafId = null; }
    if (_hitIntervalId !== null) { clearInterval(_hitIntervalId); _hitIntervalId = null; }
    _removeSpaceHandler();
    _stopLoop(_fastReelAudio); _fastReelAudio = null;

    _playSound(won ? SFX.FISH_CAUGHT : SFX.FISH_LOST, 0.9);
    CAMP.Socket.emit(CAMP.MSG.FISHING_RESULT, {
      actorId,
      fishName: won ? fishName : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Round result display (called on all clients via applyResult)
  // ---------------------------------------------------------------------------
  function _showRoundResult(actorId, round, fishName, catches) {
    // Stop any live loops
    _battleActive = false;
    if (_battleRafId !== null) { cancelAnimationFrame(_battleRafId); _battleRafId = null; }
    if (_hitIntervalId !== null) { clearInterval(_hitIntervalId); _hitIntervalId = null; }

    _catches = catches ?? [];

    const stage = document.getElementById("oni-fish-stage");
    if (!stage) return;

    if (fishName) {
      const tier      = FISH_TIERS.findIndex(pool => pool.includes(fishName));
      const tierColor = TIER_COLORS[Math.max(0, tier)];
      const tierName  = TIER_NAMES[Math.max(0, tier)];
      stage.innerHTML = `
        <div class="oni-fish-round-result">
          <div class="oni-fish-catch-name">🐟 ${fishName}</div>
          <div class="oni-fish-catch-tier" style="color:${tierColor};">${tierName}</div>
        </div>
      `;
    } else {
      const msgs = ["Nothing this time…","The fish got away…","No bite.","It slipped off the hook…"];
      stage.innerHTML = `
        <div class="oni-fish-round-result">
          <div class="oni-fish-no-catch">${msgs[Math.floor(Math.random() * msgs.length)]}</div>
        </div>
      `;
    }

    // Last round → show summary + proceed button
    if (round >= _totalRounds) {
      setTimeout(() => _showSummary(actorId), 1200);
    }
  }

  function _showSummary(actorId) {
    const stage = document.getElementById("oni-fish-stage");
    if (!stage) return;

    const hasCatch   = _catches.length > 0;
    const headColor  = hasCatch ? "#5af080" : "#7a9ab8";
    const headline   = hasCatch ? `Caught ${_catches.length} fish!` : "The fish weren't biting.";
    const listHTML   = hasCatch
      ? `<ul class="oni-fish-summary-list">${_catches.map(f => `<li>🐟 ${f}</li>`).join("")}</ul>`
      : `<div class="oni-fish-summary-empty">You caught nothing today.</div>`;

    stage.innerHTML = `
      <div class="oni-fish-summary">
        <div class="oni-fish-summary-head" style="color:${headColor};">${headline}</div>
        ${listHTML}
      </div>
    `;

    if (_isOwner) {
      const btn = document.getElementById("oni-fish-proceed");
      if (btn) {
        btn.style.display = "block";
        btn.onclick = () => {
          btn.disabled = true;
          if (game.user?.isGM) {
            CAMP.FishingUI?.resolveProceed(actorId);
          } else {
            CAMP.Socket.emit(CAMP.MSG.FISHING_PROCEED, { actorId });
          }
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Transition to cast phase (called on all clients for each round start)
  // ---------------------------------------------------------------------------
  function _enterCastPhase(actorId, round, totalRounds) {
    _currentRound = round;
    _totalRounds  = totalRounds;
    _castLocked   = false;
    _updateRoundLbl();

    const stage = document.getElementById("oni-fish-stage");
    if (!stage) return;

    if (_isOwner) {
      stage.innerHTML = _htmlCastScene(true);
      _cacheCastEls();
      _applyStats();
      _startGaugeLoop();
      _attachCastSpace(actorId);
    } else {
      stage.innerHTML = _htmlCastScene(false);
      _cacheCastEls();
      _startGaugeLoop(); // spectator mirrors gauge at same speed
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  CAMP.FishingUI ??= {};
  CAMP.FishingUI.roundResolvers   ??= {};
  CAMP.FishingUI.proceedResolvers ??= {};

  Object.assign(CAMP.FishingUI, {

    // GM broadcasts FISHING_START → all clients call show()
    show(actorId, actorName, broadcastStats) {
      _clearState();
      _actorId      = actorId;
      _actorName    = actorName;
      _isOwner      = _checkIsOwner(actorId);
      _catches      = [];
      _currentRound = 1;
      _totalRounds  = 3;

      if (_isOwner) {
        _loadStats(actorId);   // read fresh from actor
        _applyStats();
      } else if (broadcastStats) {
        // Spectators: use stats broadcast by GM so the row shows real values
        _stats = {
          mig: broadcastStats.mig ?? 8,
          dex: broadcastStats.dex ?? 8,
          ins: broadcastStats.ins ?? 8,
          wlp: broadcastStats.wlp ?? 8,
        };
        _applyStats();   // derive _playerBarH etc. so spectator battle view is consistent
      }

      _buildOverlay();

      // Owner: wire the "Cast Line" begin button for round 1
      if (_isOwner) {
        const btn = document.getElementById("oni-fish-begin-btn");
        if (btn) {
          btn.onclick = () => {
            btn.disabled = true;
            // Notify spectators to start their gauge
            CAMP.Socket.emit(CAMP.MSG.FISHING_BEGIN, { actorId });
            // Owner transitions to cast scene
            _enterCastPhase(actorId, 1, _totalRounds);
          };
        }
      }
    },

    // Received by spectators when owner clicks "Cast Line" (round 1 only)
    spectateBegin(actorId) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      _enterCastPhase(actorId, _currentRound, _totalRounds);
    },

    // Received by ALL clients when GM broadcasts FISHING_NEXT_ROUND (rounds 2/3)
    beginRound(actorId, round, totalRounds) {
      if (!document.getElementById(OVL_ID)) return;
      _enterCastPhase(actorId, round ?? _currentRound, totalRounds ?? _totalRounds);
    },

    // Spectators receive cast value snapshot
    onCast(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      const { strength, perfect } = payload ?? {};
      // Snap gauge to the cast value
      if (_gaugeRafId !== null) { cancelAnimationFrame(_gaugeRafId); _gaugeRafId = null; }
      _gaugeValue = strength ?? 0;
      _drawGauge(_gaugeValue);
      if (_el.bubble) _el.bubble.textContent = perfect ? "✨ Perfect cast!" : `Cast: ${strength}`;
    },

    // Spectators receive battle heartbeat
    onHit(payload) {
      if (_isOwner) return;
      if (!document.getElementById(OVL_ID)) return;
      const { fishY, barY, fishHp, inZone } = payload ?? {};

      // Ensure battle DOM exists
      if (!_el.ficon) {
        const stage = document.getElementById("oni-fish-stage");
        if (stage && !stage.querySelector(".oni-fish-battle")) {
          stage.innerHTML = _htmlBattleScene(false);
          _cacheBattleEls();
        }
      }

      if (_el.ficon  && fishY  != null) _el.ficon.style.top    = `${(fishY - 14).toFixed(1)}px`;
      if (_el.pbar   && barY   != null) {
        _el.pbar.style.top    = `${barY.toFixed(1)}px`;
        _el.pbar.style.height = `${_playerBarH}px`;
        _el.pbar.classList.toggle("in-zone", !!inZone);
      }
      if (_el.hpFill && fishHp != null) _el.hpFill.style.height  = `${fishHp.toFixed(1)}%`;
      if (_el.hpNum  && fishHp != null) _el.hpNum.textContent     = `${Math.round(fishHp)}%`;
    },

    // GM broadcasts FISHING_RESULT → all clients call applyResult()
    applyResult(actorId, round, fishName, catches) {
      _showRoundResult(actorId, round, fishName, catches);
    },

    // GM only — called from camp-socket when owner submits round result
    resolveRound(actorId, result) {
      const resolver = this.roundResolvers?.[actorId];
      if (!resolver) return;
      delete this.roundResolvers[actorId];
      resolver(result ?? { fishName: null });
    },

    // GM only — called from camp-socket when owner clicks Proceed
    resolveProceed(actorId) {
      const resolver = this.proceedResolvers?.[actorId];
      if (!resolver) return;
      delete this.proceedResolvers[actorId];
      resolver();
    },

    hide() {
      const ovl = document.getElementById(OVL_ID);
      if (!ovl) return;
      ovl.classList.add("oni-fish-out");
      setTimeout(() => { ovl.remove(); _clearState(); }, 350);
    },
  });

  console.debug(TAG, "Fishing UI loaded.");
})();
