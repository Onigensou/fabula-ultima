// ============================================================================
// [BattleEnd: SummaryUI Listener] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Run this ONCE per client per session (include in your Dev Bootstrap).
// Listens for socket messages and renders the BattleEnd "Victory Summary" UI.
//
// UI Layers (requested):
// Dim (lowest) >>> Panel >>> Title + Footer >>> Token Sprite >>> Level Up Text
//
// Footer Stats (NEW):
// - Total Damage (dummy, roll 0 -> value)
// - Total Healing (dummy, roll 0 -> value)
// - Total Zenit (REAL: sum of zenit gains in payload, roll 0 -> value)
// - Total Round (dummy for now; fades in with footer)
// - Rank (dummy; label fades first, letter scales in with anticipation delay)
//
// Animations:
// - Title wipe-in + dim fade-in
// - Cards slide/fade in with sprite lead
// - EXP animations (segments) -> Zenit animations (per actor)
// - Footer appears after panels, number rolls start
// - Hold, then outro (wipe out + fade out)
//
// NOTE:
// - Total Round is left as dummy until your payload stores combat.round snapshot.
// - Rank / Damage / Healing are left as dummy until you wire logic.
// ============================================================================

(async () => {
  const DEBUG = true;
  const tag = "[BattleEnd:SummaryUI:Listener]";
  const log = (...a) => DEBUG && console.log(tag, ...a);

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG_TYPE = "ONI_BATTLEEND_SUMMARY_UI";

  // ---------------------------------------------------------------------------
  // CONFIG (match your SummaryUI_Designer / Tuner)
  // ---------------------------------------------------------------------------
  const LOCK_INTERACTIONS_DEFAULT = true;

  // scaling
  const PANEL_SCALE = 1.25;
  const TITLE_SCALE = 1.3;
  const LEVELUP_SCALE = 2;

  // NEW: nudge LEVEL UP! position (relative to each card)
  const LEVELUP_NUDGE_LEFT = 0; // px (+ = right, - = left)
  const LEVELUP_NUDGE_TOP  = 3; // px (+ = down,  - = up)

  // Dim overlay
  const DIM_OPACITY = 0.28;

  // Title animation (Victory)
  const TITLE_EASE_MS = 1500;
  const TITLE_OUT_MS = 360;
  const TITLE_AFTER_PAUSE_MS = 50;

  // Panel animation
  const INTRO_STAGGER_MS = 120;
  const INTRO_EASE_MS = 520;

  // Sprite animation
  const SPRITE_EASE_MS = 520;
  const SPRITE_LEAD_MS = 80;

  // Footer animation
  const FOOTER_EASE_MS = 420;
  const FOOTER_AFTER_PANELS_MS = 120;

  // Footer number roll timing
  const DAMAGE_ROLL_MS = 900;
  const HEALING_ROLL_MS = 900;
  const ZENIT_ROLL_MS = 900;

  // Rank anticipation
  const RANK_LETTER_DELAY_MS = 520;
  const RANK_SCALE_FROM = 1.75;

  // sprite positioning
  const SPRITE_SIZE = 135;
  const SPRITE_LEFT = -42;
  const SPRITE_TOP  = -54;

  // reserve space so sprite doesn't cover text/bars
  const SPRITE_RESERVE_TOP  = 10;
  const SPRITE_RESERVE_LEFT = 47;

  // underline toggle
  const TITLE_UNDERLINE_ENABLED = false;

  // Behavior guard
  const MIN_VISIBLE_AFTER_INTRO_MS = 5000;

  // ---------------------------------------------------------------------------
  // Dummy footer data (wire later)
  // ---------------------------------------------------------------------------
  const DUMMY_TOTAL_DAMAGE = 0;
  const DUMMY_TOTAL_HEALING = 0;
  const DUMMY_TOTAL_ROUNDS = "—";
  const DUMMY_RANK_LETTER = "S";

  // ---------------------------------------------------------------------------
  // Tick SFX (metronome while EXP + per-actor Zenit animates)
  // ---------------------------------------------------------------------------
  const TICK_SFX_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/System_Tick.mp3";

  function createTickPool({ poolSize = 4, volume = 0.55, playbackRate = 1.0 } = {}) {
    const pool = [];
    const vol = Math.max(0, Math.min(1, Number(volume)));
    const rate = Math.max(0.5, Math.min(4.0, Number(playbackRate)));

    for (let i = 0; i < poolSize; i++) {
      const a = new Audio(TICK_SFX_SRC);
      a.preload = "auto";
      a.loop = false;
      a.volume = vol;
      a.playbackRate = rate;
      pool.push(a);
    }
    return pool;
  }

  function startTickMetronome({
    intervalMs = 72,
    volume = 0.55,
    playbackRate = 1.35,
    poolSize = 4
  } = {}) {
    try {
      const ms = Math.max(30, Number(intervalMs) || 72);
      const pool = createTickPool({ poolSize, volume, playbackRate });
      let idx = 0;

      const timerId = setInterval(() => {
        const a = pool[idx];
        idx = (idx + 1) % pool.length;
        try {
          a.pause();
          a.currentTime = 0;
          a.play().catch(() => {});
        } catch {}
      }, ms);

      return { timerId, pool };
    } catch (err) {
      console.warn(`${tag} Tick metronome start failed:`, err);
      return null;
    }
  }

  function stopTickMetronome(metro) {
    try {
      if (!metro) return;
      if (metro.timerId) clearInterval(metro.timerId);

      const pool = Array.isArray(metro.pool) ? metro.pool : [];
      for (const a of pool) {
        try {
          a.pause();
          a.currentTime = 0;
          a.src = "";
        } catch {}
      }
    } catch (err) {
      console.warn(`${tag} Tick metronome stop failed:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Level Up SFX (play exactly when LEVEL UP flash happens)
  // ---------------------------------------------------------------------------
  const LEVELUP_SFX_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/SE_SYS_Upgrade_New_success2.ogg";

  function createLevelUpPool({ poolSize = 6, volume = 0.5, playbackRate = 1.0 } = {}) {
    const pool = [];
    const vol = Math.max(0, Math.min(1, Number(volume)));
    const rate = Math.max(0.5, Math.min(4.0, Number(playbackRate)));

    for (let i = 0; i < poolSize; i++) {
      const a = new Audio(LEVELUP_SFX_SRC);
      a.preload = "auto";
      a.loop = false;
      a.volume = vol;
      a.playbackRate = rate;
      pool.push(a);
    }
    return pool;
  }

  const __LEVELUP_POOL__ = createLevelUpPool({ poolSize: 6, volume: 0.8, playbackRate: 1.0 });
  let __LEVELUP_POOL_IDX__ = 0;

  // Dedupe guard: only allow ONE level-up sound per animation frame
  let __LEVELUP_SFX_SCHEDULED__ = false;

  function playLevelUpSfx() {
    try {
      if (__LEVELUP_SFX_SCHEDULED__ === true) return;
      __LEVELUP_SFX_SCHEDULED__ = true;

      requestAnimationFrame(() => {
        __LEVELUP_SFX_SCHEDULED__ = false;

        const pool = __LEVELUP_POOL__;
        if (!Array.isArray(pool) || !pool.length) return;

        const a = pool[__LEVELUP_POOL_IDX__];
        __LEVELUP_POOL_IDX__ = (__LEVELUP_POOL_IDX__ + 1) % pool.length;

        a.pause();
        a.currentTime = 0;
        a.play().catch(() => {});
      });
    } catch (err) {
      __LEVELUP_SFX_SCHEDULED__ = false;
      console.warn(`${tag} LevelUp SFX play failed:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Idempotent install guard
  // ---------------------------------------------------------------------------
  if (window.__ONI_BATTLEEND_SUMMARYUI_LISTENER_INSTALLED__ === true) {
    ui.notifications?.info?.("BattleEnd SummaryUI Listener: already installed on this client.");
    log("Already installed.");
    return;
  }
  window.__ONI_BATTLEEND_SUMMARYUI_LISTENER_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)));

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function safeInt(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  function isVideoSrc(src) {
    const s = String(src || "").toLowerCase();
    return s.endsWith(".webm") || s.endsWith(".mp4");
  }

  // EXP -> percent:
  // in your system: expStart=1, levelUpAt=10, progress = (exp - 1) / 9
  function expToPct(exp, expStart, levelUpAt) {
    const start = Number(expStart);
    const cap = Number(levelUpAt);
    const denom = Math.max(1e-6, (cap - start));
    const t = (Number(exp) - start) / denom;
    return clamp(t * 100, 0, 100);
  }

  function animateNumber(el, to, { from = 0, duration = 800, formatter = (n) => String(n) } = {}) {
    if (!el) return;
    const start = performance.now();
    const a = Number(from) || 0;
    const b = Number(to) || 0;

    const tick = (now) => {
      if (!document.body.contains(el)) return;
      const t = Math.min(1, (now - start) / Math.max(1, duration));
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const v = a + (b - a) * e;

      el.textContent = formatter(Math.round(v));
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = formatter(Math.round(b));
    };

    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // CSS injection (matches your Designer)
  // ---------------------------------------------------------------------------
  function ensureStyles() {
    const id = "oni-battleend-summaryui-style";
    const old = document.getElementById(id);
    if (old) old.remove();

    const underlineDisplay = TITLE_UNDERLINE_ENABLED ? "block" : "none";

    // scaling compensation (TITLE_SCALE + LEVELUP_SCALE remain independent)
    const __panelScale = Math.max(0.01, Number(PANEL_SCALE) || 1);
    const __titleScaleEff   = (Number(TITLE_SCALE)   || 1) / __panelScale;
    const __levelupScaleEff = (Number(LEVELUP_SCALE) || 1) / __panelScale;

    const css = `
      :root {
        --oni-sum-bg: rgba(8, 10, 14, 0.62);
        --oni-sum-border: rgba(255,255,255,0.18);
        --oni-sum-text: rgba(255,255,255,0.92);
        --oni-sum-sub: rgba(255,255,255,0.72);
        --oni-sum-accent: rgba(255, 210, 120, 0.95);
        --oni-sum-bar-bg: rgba(255,255,255,0.14);
        --oni-sum-bar-fill: rgba(255, 210, 120, 0.95);
        --oni-sum-shadow: 0 10px 30px rgba(0,0,0,0.35);

        --oni-panel-scale: ${__panelScale};
        --oni-title-scale: ${__titleScaleEff};
        --oni-levelup-scale: ${__levelupScaleEff};

        --oni-levelup-nudge-x: ${LEVELUP_NUDGE_LEFT}px;
        --oni-levelup-nudge-y: ${LEVELUP_NUDGE_TOP}px;
      }

      .oni-sum-root {
        position: fixed;
        inset: 0;
        z-index: 100000;
        pointer-events: none;
        font-family: "Signika", "Segoe UI", sans-serif;
      }

      /* ==========================================================
         LAYER 0: DIM (LOWEST)
      ========================================================== */
      .oni-sum-dim {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,1);
        opacity: 0;
        transition: opacity ${TITLE_EASE_MS}ms ease-in-out;
        pointer-events: none;
        z-index: 0;
      }
      .oni-sum-dim.is-in { opacity: ${DIM_OPACITY}; }
      .oni-sum-dim.is-out {
        opacity: 0;
        transition: opacity ${TITLE_OUT_MS}ms ease-in-out;
      }

      /* blocks interactions if enabled */
      .oni-sum-lock {
        position: absolute;
        inset: 0;
        pointer-events: auto;
        background: rgba(0,0,0,0.0);
        z-index: 10;
      }

      /* scaled wrapper */
      .oni-sum-ui {
        position: absolute;
        inset: 0;
        transform: scale(var(--oni-panel-scale));
        transform-origin: top left;
        pointer-events: none;
        z-index: 1;
      }

      .oni-sum-grid {
        position: absolute;
        left: 28px;
        top: 180px;
        width: 520px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-auto-rows: auto;
        gap: 12px;
      }

      /* ==========================================================
         LAYER 1: PANEL
      ========================================================== */
      .oni-sum-item { position: relative; }

      .oni-sum-card {
        background: var(--oni-sum-bg);
        border: 1px solid var(--oni-sum-border);
        border-radius: 12px;
        box-shadow: var(--oni-sum-shadow);
        padding: calc(12px + ${SPRITE_RESERVE_TOP}px) 14px 12px 14px;
        opacity: 0;
        transform: translateX(-42px);
        transition: opacity ${INTRO_EASE_MS}ms ease, transform ${INTRO_EASE_MS}ms ease;
        overflow: hidden;
        position: relative;
        z-index: 1;
      }

      .oni-sum-item .oni-sum-card {
        padding-left: calc(14px + ${SPRITE_RESERVE_LEFT}px);
      }

      .oni-sum-card.is-in { opacity: 1; transform: translateX(0px); }
      .oni-sum-card.is-out {
        opacity: 0;
        transform: translateX(-42px);
        transition: opacity 360ms ease-in-out, transform 360ms ease-in-out;
      }

      /* ==========================================================
         FOOTER STATS (same z as TITLE)
      ========================================================== */
      .oni-sum-footer {
        position: absolute;
        left: 28px;
        width: 520px;
        top: 0px;
        z-index: 2;
        pointer-events: none;

        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;

        opacity: 0;
        transform: translateY(8px);
        transition: opacity ${FOOTER_EASE_MS}ms ease, transform ${FOOTER_EASE_MS}ms ease;
      }
      .oni-sum-footer.is-in { opacity: 1; transform: translateY(0px); }
      .oni-sum-footer.is-out {
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 280ms ease, transform 280ms ease;
      }

      .oni-sum-foot-row {
        width: 520px;
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 10px;
        text-align: right;
      }

      .oni-sum-foot-label {
        color: var(--oni-sum-sub);
        font-weight: 900;
        font-size: 12px;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        opacity: 0.95;
        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
           0 2px 0 rgba(0,0,0,0.35);
      }

      .oni-sum-foot-value {
        color: var(--oni-sum-text);
        font-weight: 1000;
        font-size: 16px;
        font-variant-numeric: tabular-nums;
        min-width: 64px;
        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
           0 2px 0 rgba(0,0,0,0.35);
      }

      .oni-sum-rank-row {
        width: 520px;
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 12px;
        margin-top: 4px;
      }

      .oni-sum-rank-label {
        color: rgba(255,255,255,0.86);
        font-weight: 1000;
        font-size: 18px;
        letter-spacing: 1px;
        text-transform: uppercase;
        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
           0 2px 0 rgba(0,0,0,0.35);

        opacity: 0;
        transform: translateY(6px);
        transition: opacity 320ms ease, transform 320ms ease;
        transition-delay: 0ms;
      }

      .oni-sum-footer.is-in .oni-sum-rank-label {
        opacity: 1;
        transform: translateY(0px);
      }

      .oni-sum-rank-letter {
        color: rgba(255,255,255,0.98);
        font-weight: 1100;
        font-size: 54px;
        letter-spacing: 2px;
        line-height: 1;

        text-shadow:
          -2px  0px 0 rgba(0,0,0,0.80),
           2px  0px 0 rgba(0,0,0,0.80),
           0px -2px 0 rgba(0,0,0,0.80),
           0px  2px 0 rgba(0,0,0,0.80),
           0 6px 0 rgba(0,0,0,0.40),
           0 16px 34px rgba(0,0,0,0.35);

        opacity: 0;
        transform: scale(${RANK_SCALE_FROM});
        transform-origin: right bottom;

        transition:
          opacity 360ms ease,
          transform 520ms ease;

        transition-delay: ${RANK_LETTER_DELAY_MS}ms;
      }

      .oni-sum-footer.is-in .oni-sum-rank-letter {
        opacity: 1;
        transform: scale(1);
      }

      /* ==========================================================
         LAYER 2: TITLE
      ========================================================== */
      .oni-sum-title {
        position: absolute;
        left: 0;
        top: 80px;
        width: 100vw;
        padding-left: 28px;
        pointer-events: none;
        z-index: 2;

        clip-path: inset(0 100% 0 0);
        will-change: clip-path;
        transform: translateY(-6px);
        transition:
          clip-path ${TITLE_EASE_MS}ms ease-in-out,
          transform ${TITLE_EASE_MS}ms ease-in-out;
      }

      .oni-sum-title-inner {
        display: inline-block;
        transform: scale(var(--oni-title-scale));
        transform-origin: left top;

        font-weight: 1000;
        font-size: 42px;
        letter-spacing: 2px;
        color: rgba(255,255,255,0.98);

        text-shadow:
          -2px  0px 0 rgba(0,0,0,0.75),
           2px  0px 0 rgba(0,0,0,0.75),
           0px -2px 0 rgba(0,0,0,0.75),
           0px  2px 0 rgba(0,0,0,0.75),
          -2px -2px 0 rgba(0,0,0,0.65),
           2px -2px 0 rgba(0,0,0,0.65),
          -2px  2px 0 rgba(0,0,0,0.65),
           2px  2px 0 rgba(0,0,0,0.65),
           0 3px 0 rgba(0,0,0,0.55),
           0 12px 28px rgba(0,0,0,0.35);
      }

      .oni-sum-title::after {
        content: "";
        display: ${underlineDisplay};
        position: absolute;
        left: -80px;
        right: 0;
        top: calc(100% + 10px);
        height: 4px;
        pointer-events: none;
        background: linear-gradient(
          90deg,
          rgba(255,255,255,0.98) 0%,
          rgba(255,255,255,0.78) 28%,
          rgba(255,255,255,0.45) 52%,
          rgba(255,255,255,0.00) 100%
        );
        box-shadow:
          0 0 10px rgba(255,255,255,0.10),
          0 2px 0 rgba(0,0,0,0.22);
      }

      .oni-sum-title.is-in {
        clip-path: inset(0 0% 0 0);
        transform: translateY(0px);
      }

      .oni-sum-title.is-out {
        clip-path: inset(0 100% 0 0);
        transform: translateY(-4px);
        transition:
          clip-path ${TITLE_OUT_MS}ms ease-in-out,
          transform ${TITLE_OUT_MS}ms ease-in-out;
      }

      /* ==========================================================
         LAYER 3: TOKEN SPRITE
      ========================================================== */
      .oni-sum-sprite {
        position: absolute;
        left: ${SPRITE_LEFT}px;
        top: ${SPRITE_TOP}px;
        width: ${SPRITE_SIZE}px;
        height: ${SPRITE_SIZE}px;
        z-index: 3;
        pointer-events: none;
        background: transparent !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        overflow: visible;

        opacity: 0;
        transform: translateX(-18px) translateY(-10px) scale(0.985);
        transition: opacity ${SPRITE_EASE_MS}ms ease, transform ${SPRITE_EASE_MS}ms ease;
      }
      .oni-sum-sprite.is-in { opacity: 1; transform: translateX(0px) translateY(0px) scale(1); }
      .oni-sum-sprite.is-out {
        opacity: 0;
        transform: translateX(-14px) translateY(-6px) scale(0.99);
        transition: opacity 360ms ease-in-out, transform 360ms ease-in-out;
      }

      .oni-sum-sprite img,
      .oni-sum-sprite video {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        background: transparent !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        filter: none !important;
      }

      /* ==========================================================
         LAYER 4: LEVEL UP TEXT (HIGHEST)
      ========================================================== */
      .oni-sum-levelup-float {
        position: absolute;
        left: 0;
        right: 0;
        top: -18px;
        z-index: 4;
        pointer-events: none;

        padding: 0 12px;
        text-align: center;

        font-weight: 1000;
        font-size: 18px;
        letter-spacing: 1px;
        color: rgba(255,255,255,0.96);

        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
          -1px -1px 0 rgba(0,0,0,0.70),
           1px -1px 0 rgba(0,0,0,0.70),
          -1px  1px 0 rgba(0,0,0,0.70),
           1px  1px 0 rgba(0,0,0,0.70),
           0 2px 0 rgba(0,0,0,0.35);

        opacity: 0;
        transform:
          translate(var(--oni-levelup-nudge-x), var(--oni-levelup-nudge-y))
          scale(var(--oni-levelup-scale));
        transform-origin: center top;
      }

      .oni-sum-levelup-float.is-show {
        animation: oniSumLevelUpFloat 3600ms ease-in-out forwards;
      }

      @keyframes oniSumLevelUpFloat {
        0% {
          opacity: 0;
          transform:
            translate(var(--oni-levelup-nudge-x), calc(var(--oni-levelup-nudge-y) - 10px))
            scale(calc(var(--oni-levelup-scale) * 0.98));
        }
        8% {
          opacity: 1;
          transform:
            translate(var(--oni-levelup-nudge-x), var(--oni-levelup-nudge-y))
            scale(calc(var(--oni-levelup-scale) * 1.00));
        }
        92% {
          opacity: 1;
          transform:
            translate(var(--oni-levelup-nudge-x), var(--oni-levelup-nudge-y))
            scale(calc(var(--oni-levelup-scale) * 1.02));
        }
        100% {
          opacity: 0;
          transform:
            translate(var(--oni-levelup-nudge-x), calc(var(--oni-levelup-nudge-y) - 8px))
            scale(calc(var(--oni-levelup-scale) * 0.99));
        }
      }

      /* panel content */
      .oni-sum-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }

      .oni-sum-name {
        color: var(--oni-sum-text);
        font-weight: 800;
        font-size: 18px;
        letter-spacing: 0.2px;
        text-shadow: 0 1px 0 rgba(0,0,0,0.35);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 320px;
      }

      .oni-sum-lv {
        color: var(--oni-sum-sub);
        font-weight: 800;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .oni-sum-lv strong { color: var(--oni-sum-text); font-size: 16px; }

      .oni-sum-exp-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .oni-sum-exp-label {
        color: var(--oni-sum-sub);
        font-weight: 800;
        font-size: 12px;
        letter-spacing: 0.6px;
        text-transform: uppercase;
      }

      .oni-sum-exp-pct {
        color: var(--oni-sum-text);
        font-weight: 900;
        font-size: 14px;
        min-width: 56px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .oni-sum-bar {
        margin-top: 6px;
        height: 10px;
        background: var(--oni-sum-bar-bg);
        border-radius: 999px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.14);
      }

      .oni-sum-bar-fill {
        height: 100%;
        width: 0%;
        background: var(--oni-sum-bar-fill);
        border-radius: 999px;
        box-shadow: 0 0 14px rgba(255, 210, 120, 0.28);
      }

      .oni-sum-zenit-row {
        margin-top: 10px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
      }

      .oni-sum-zenit-icon {
        width: 28px;
        height: 28px;
        object-fit: contain;
        background: transparent !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        filter: none !important;
        display: block;
        opacity: 1;
      }

      .oni-sum-zenit-num {
        color: var(--oni-sum-text);
        font-weight: 1000;
        font-size: 16px;
        letter-spacing: 0.2px;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 1px 0 rgba(0,0,0,0.35);
        min-width: 64px;
        text-align: right;
      }
    `;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // DOM builders
  // ---------------------------------------------------------------------------
  function buildRoot({ runId, lockInteractions }) {
    // clean older
    const old = document.querySelector(".oni-sum-root");
    if (old) old.remove();

    const root = document.createElement("div");
    root.className = "oni-sum-root";
    root.dataset.runId = String(runId ?? "");

    const dim = document.createElement("div");
    dim.className = "oni-sum-dim";
    root.appendChild(dim);

    if (lockInteractions) {
      const lock = document.createElement("div");
      lock.className = "oni-sum-lock";

      const stop = (ev) => {
        try { ev.preventDefault(); } catch {}
        try { ev.stopPropagation(); } catch {}
        try { ev.stopImmediatePropagation(); } catch {}
        return false;
      };

      lock.addEventListener("mousedown", stop, true);
      lock.addEventListener("mouseup", stop, true);
      lock.addEventListener("mousemove", stop, true);
      lock.addEventListener("click", stop, true);
      lock.addEventListener("dblclick", stop, true);
      lock.addEventListener("contextmenu", stop, true);
      lock.addEventListener("wheel", stop, { capture: true, passive: false });
      lock.addEventListener("touchstart", stop, { capture: true, passive: false });
      lock.addEventListener("touchmove", stop, { capture: true, passive: false });
      lock.addEventListener("touchend", stop, { capture: true, passive: false });

      root.appendChild(lock);
    }

    const uiWrap = document.createElement("div");
    uiWrap.className = "oni-sum-ui";
    root.appendChild(uiWrap);

    const title = document.createElement("div");
    title.className = "oni-sum-title";
    title.innerHTML = `<div class="oni-sum-title-inner">VICTORY!</div>`;
    uiWrap.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "oni-sum-grid";
    uiWrap.appendChild(grid);

    document.body.appendChild(root);
    return { root, dim, uiWrap, title, grid };
  }

  function buildSprite(src) {
    const wrap = document.createElement("div");
    wrap.className = "oni-sum-sprite";

    if (isVideoSrc(src)) {
      const v = document.createElement("video");
      v.src = src;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.addEventListener("canplay", () => {
        const p = v.play();
        if (p?.catch) p.catch(() => {});
      });
      wrap.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "Sprite";
      img.loading = "eager";
      wrap.appendChild(img);
    }

    return wrap;
  }

    function pickSpriteSrcForEntry(entry) {
    // 1) explicit from payload (future-proof)
    const fromPayload = String(entry?.spriteSrc ?? "").trim();
    if (fromPayload) return fromPayload;

    // 2) derive from Actor
    const actorId = String(entry?.actorId ?? "").trim();
    const actor = actorId ? game.actors?.get?.(actorId) : null;

    // NEW: prefer Standard sprite from your Actor sheet data
    // Path requested: _token.actor.system.props.sprite_standard
    // Here we have Actor directly, so: actor.system.props.sprite_standard
    const standardSprite = String(actor?.system?.props?.sprite_standard ?? "").trim();
    if (standardSprite) return standardSprite;

    // 3) fallback: token image (prototype token texture)
    const tokenSrc = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    if (tokenSrc) return tokenSrc;

    // 4) fallback: actor portrait
    const img = String(actor?.img ?? "").trim();
    if (img) return img;

    // 5) fallback (empty)
    return "";
  }

  function buildCard(entry, zenitIconSrc) {
    const item = document.createElement("div");
    item.className = "oni-sum-item";

    const spriteSrc = pickSpriteSrcForEntry(entry);
    const sprite = buildSprite(spriteSrc);
    item.appendChild(sprite);

    const levelUp = document.createElement("div");
    levelUp.className = "oni-sum-levelup-float";
    levelUp.textContent = "LEVEL UP!";
    item.appendChild(levelUp);

    const card = document.createElement("div");
    card.className = "oni-sum-card";
    card.dataset.actorId = String(entry.actorId ?? "");

    const header = document.createElement("div");
    header.className = "oni-sum-header";

    const name = document.createElement("div");
    name.className = "oni-sum-name";
    name.textContent = String(entry.actorName ?? "Unknown");

    const lv = document.createElement("div");
    lv.className = "oni-sum-lv";
    lv.innerHTML = `Lv <strong class="oni-sum-lv-num">${Number(entry.level?.before ?? 1)}</strong>`;

    header.appendChild(name);
    header.appendChild(lv);
    card.appendChild(header);

    const expRow = document.createElement("div");
    expRow.className = "oni-sum-exp-row";

    const expLabel = document.createElement("div");
    expLabel.className = "oni-sum-exp-label";
    expLabel.textContent = "EXP";

    const pct = document.createElement("div");
    pct.className = "oni-sum-exp-pct";
    pct.textContent = "0%";

    expRow.appendChild(expLabel);
    expRow.appendChild(pct);
    card.appendChild(expRow);

    const bar = document.createElement("div");
    bar.className = "oni-sum-bar";

    const fill = document.createElement("div");
    fill.className = "oni-sum-bar-fill";

    bar.appendChild(fill);
    card.appendChild(bar);

    const zRow = document.createElement("div");
    zRow.className = "oni-sum-zenit-row";

    const zIcon = document.createElement("img");
    zIcon.className = "oni-sum-zenit-icon";
    zIcon.alt = "Zenit";
    zIcon.src = String(zenitIconSrc ?? "");
    zRow.appendChild(zIcon);

    const zNum = document.createElement("div");
    zNum.className = "oni-sum-zenit-num";
    zNum.textContent = String(safeInt(entry?.zenitBefore ?? 0, 0));
    zRow.appendChild(zNum);

    card.appendChild(zRow);

    item.appendChild(card);
    return { item, card, sprite, levelUp };
  }

  function buildFooter({ totalDamage, totalHealing, totalZenit, totalRounds, rankLetter }) {
    const footer = document.createElement("div");
    footer.className = "oni-sum-footer";

    const mkRow = (labelText, valueClass, initialText) => {
      const row = document.createElement("div");
      row.className = "oni-sum-foot-row";

      const label = document.createElement("div");
      label.className = "oni-sum-foot-label";
      label.textContent = String(labelText);

      const value = document.createElement("div");
      value.className = `oni-sum-foot-value ${valueClass || ""}`.trim();
      value.textContent = String(initialText);

      row.appendChild(label);
      row.appendChild(value);
      return { row, value };
    };

    const dmg = mkRow("Total Damage", "oni-sum-foot-dmg", "0");
    const heal = mkRow("Total Healing", "oni-sum-foot-heal", "0");
    const zen = mkRow("Total Zenit", "oni-sum-foot-zenit", "0");

    const roundsRow = document.createElement("div");
    roundsRow.className = "oni-sum-foot-row";

    const roundsLabel = document.createElement("div");
    roundsLabel.className = "oni-sum-foot-label";
    roundsLabel.textContent = "Total Round";

    const roundsValue = document.createElement("div");
    roundsValue.className = "oni-sum-foot-value";
    roundsValue.textContent = String(totalRounds ?? "—");

    roundsRow.appendChild(roundsLabel);
    roundsRow.appendChild(roundsValue);

    const rankRow = document.createElement("div");
    rankRow.className = "oni-sum-rank-row";

    const rankLabel = document.createElement("div");
    rankLabel.className = "oni-sum-rank-label";
    rankLabel.textContent = "Rank";

    const rankValue = document.createElement("div");
    rankValue.className = "oni-sum-rank-letter";
    rankValue.textContent = String(rankLetter ?? "S");

    rankRow.appendChild(rankLabel);
    rankRow.appendChild(rankValue);

    footer.appendChild(dmg.row);
    footer.appendChild(heal.row);
    footer.appendChild(zen.row);
    footer.appendChild(roundsRow);
    footer.appendChild(rankRow);

    return { footer, dmgValueEl: dmg.value, healValueEl: heal.value, zenitValueEl: zen.value };
  }

  function positionFooterUnderGrid(gridEl, footerEl, gapPx = 16) {
    if (!gridEl || !footerEl) return;
    const top = (gridEl.offsetTop || 0) + (gridEl.offsetHeight || 0) + gapPx;
    footerEl.style.top = `${top}px`;
    footerEl.style.left = `${gridEl.offsetLeft || 28}px`;
    footerEl.style.width = `${gridEl.offsetWidth || 520}px`;
  }

  // ---------------------------------------------------------------------------
  // Animation helpers (bar / level / zenit)
  // ---------------------------------------------------------------------------
  function setBar(card, pct) {
    const fill = card.querySelector(".oni-sum-bar-fill");
    const pctEl = card.querySelector(".oni-sum-exp-pct");
    const p = clamp(Number(pct), 0, 100);

    if (fill) fill.style.width = `${p.toFixed(2)}%`;
    if (pctEl) pctEl.textContent = `${Math.round(p)}%`;
  }

  function setLevel(card, levelNumber) {
    const lvNum = card.querySelector(".oni-sum-lv-num");
    if (lvNum) lvNum.textContent = String(Math.floor(Number(levelNumber)));
  }

  function flashLevelUp(levelUpEl) {
    if (!levelUpEl) return;
    levelUpEl.classList.remove("is-show");
    void levelUpEl.offsetWidth;
    levelUpEl.classList.add("is-show");
  }

  function setZenit(card, value) {
    const el = card.querySelector(".oni-sum-zenit-num");
    if (el) el.textContent = String(Math.floor(Number(value) || 0));
  }

  async function animateSegment(card, pctFrom, pctTo, durationMs) {
    const start = performance.now();
    const a = Number(pctFrom);
    const b = Number(pctTo);
    const d = Math.max(60, Number(durationMs));

    return new Promise((resolve) => {
      function tick(t) {
        const u = clamp((t - start) / d, 0, 1);
        const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOutQuad
        const v = a + (b - a) * eased;
        setBar(card, v);

        if (u >= 1) return resolve();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  async function animateCountUp(card, fromVal, toVal, durationMs) {
    const start = performance.now();
    const a = Math.floor(Number(fromVal) || 0);
    const b = Math.floor(Number(toVal) || 0);
    const d = Math.max(120, Number(durationMs) || 600);

    setZenit(card, a);

    return new Promise((resolve) => {
      function tick(t) {
        const u = clamp((t - start) / d, 0, 1);
        const eased = 1 - Math.pow(1 - u, 3); // easeOutCubic
        const v = Math.round(a + (b - a) * eased);
        setZenit(card, v);

        if (u >= 1) return resolve();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  async function playCardExpAnimation(card, levelUpEl, entry, rule) {
    const expStart = Number(rule?.expStart ?? 1);
    const levelUpAt = Number(rule?.levelUpAt ?? 10);

    const beforeExp = Number(entry?.exp?.before ?? expStart);
    const beforePct = expToPct(beforeExp, expStart, levelUpAt);
    setBar(card, beforePct);

    const baseLevel = Number(entry?.level?.before ?? 1);
    setLevel(card, baseLevel);

    const segments = Array.isArray(entry?.segments) ? entry.segments : [];
    if (!segments.length) return;

    const msPerPercent = 12;
    const minSegMs = 180;

    let currentLevel = baseLevel;

    for (const seg of segments) {
      const fromExp = Number(seg?.from ?? expStart);
      const toExp = Number(seg?.to ?? expStart);

      const fromPct = expToPct(fromExp, expStart, levelUpAt);
      const toPct = expToPct(toExp, expStart, levelUpAt);

      const delta = Math.abs(toPct - fromPct);
      const dur = Math.max(minSegMs, delta * msPerPercent);

      await animateSegment(card, fromPct, toPct, dur);

      if (seg?.levelUp === true) {
        playLevelUpSfx();
        flashLevelUp(levelUpEl);

        currentLevel += 1;
        setLevel(card, currentLevel);

        await sleep(120);
        setBar(card, 0);
        await sleep(140);
      }
    }
  }

  async function playCardZenitAnimation(card, entry) {
    const before = safeInt(entry?.zenitBefore, safeInt(entry?.zenitAfter, 0));
    const after  = safeInt(entry?.zenitAfter, before);

    setZenit(card, before);
    if (after <= before) return;

    const delta = after - before;
    const dur = clamp(650 + delta * 6, 700, 1800);
    await animateCountUp(card, before, after, dur);
  }

  // ---------------------------------------------------------------------------
  // Outro teardown
  // ---------------------------------------------------------------------------
  async function teardownAnimated(root) {
    if (!root) return;

    const dim = root.querySelector(".oni-sum-dim");
    const title = root.querySelector(".oni-sum-title");
    const cards = Array.from(root.querySelectorAll(".oni-sum-card"));
    const sprites = Array.from(root.querySelectorAll(".oni-sum-sprite"));
    const levelUps = Array.from(root.querySelectorAll(".oni-sum-levelup-float"));
    const footer = root.querySelector(".oni-sum-footer");

    if (title) title.classList.add("is-out");
    if (dim) dim.classList.add("is-out");
    if (footer) footer.classList.add("is-out");

    for (const s of sprites) s.classList.add("is-out");
    for (const c of cards) c.classList.add("is-out");
    for (const lu of levelUps) lu.style.opacity = "0";

    await sleep(Math.max(TITLE_OUT_MS, 360));
    try { root.remove(); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Main runner
  // ---------------------------------------------------------------------------
  async function runSummaryUI(data) {
    ensureStyles();

    const runId = String(data?.runId ?? `sum_${Date.now()}`);
    const lockInteractions = ("lockInteractions" in (data ?? {}))
      ? !!data.lockInteractions
      : LOCK_INTERACTIONS_DEFAULT;

    const entries = Array.isArray(data?.entries) ? data.entries.slice() : [];
    const rule = data?.rule ?? { expStart: 1, levelUpAt: 10 };

    const zenitIconSrc =
      String(data?.zenitIconSrc ?? "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png");

    if (!entries.length) {
      ui.notifications?.warn?.("BattleEnd SummaryUI: No entries to show.");
      return;
    }

    // -----------------------------------------------------------------------
    // NEW: Footer totals (Damage/Healing/Round/Rank dummy; Zenit is real)
    // -----------------------------------------------------------------------
    const totalZenit = entries.reduce((acc, e) => {
      const gain = ("zenitGain" in (e ?? {}))
        ? safeInt(e.zenitGain, 0)
        : Math.max(0, safeInt(e?.zenitAfter, 0) - safeInt(e?.zenitBefore, 0));
      return acc + Math.max(0, gain);
    }, 0);

    
    // NEW: Total Round (real) if provided by broadcaster payload
    const roundsRaw = ("totalRounds" in (data ?? {})) ? data.totalRounds : null;
    const roundsN = (typeof roundsRaw === "number") ? roundsRaw : parseFloat(String(roundsRaw ?? ""));
    const totalRoundsText =
      (Number.isFinite(roundsN) && roundsN > 0) ? String(Math.floor(roundsN)) : DUMMY_TOTAL_ROUNDS;

const footerData = {
      totalDamage: (Number.isFinite(safeInt(data?.totalDamage, NaN)) ? safeInt(data?.totalDamage, DUMMY_TOTAL_DAMAGE) : DUMMY_TOTAL_DAMAGE),
      totalHealing: (Number.isFinite(safeInt(data?.totalHealing, NaN)) ? safeInt(data?.totalHealing, DUMMY_TOTAL_HEALING) : DUMMY_TOTAL_HEALING),
      totalZenit: totalZenit,
      totalRounds: totalRoundsText,
      rankLetter: String(data?.rank?.letter ?? data?.rankLetter ?? DUMMY_RANK_LETTER)
    };

    const { root, dim, uiWrap, title, grid } = buildRoot({ runId, lockInteractions });

    // Build cards (max 4, 2x2)
    const shown = entries.slice(0, 4);
    const cards = [];

    for (const e of shown) {
      const built = buildCard(e, zenitIconSrc);
      grid.appendChild(built.item);
      cards.push({ ...built, entry: e });
    }

    // Build + attach footer
    const footerBuilt = buildFooter(footerData);
    uiWrap.appendChild(footerBuilt.footer);

    // Position footer once layout exists
    await sleep(0);
    positionFooterUnderGrid(grid, footerBuilt.footer, 16);

    // Autoplay unlock attempt for videos (webm) on first user input
    const unlock = () => {
      document.removeEventListener("pointerdown", unlock, true);
      for (const v of document.querySelectorAll(".oni-sum-root video")) {
        try {
          const p = v.play();
          if (p?.catch) p.catch(() => {});
        } catch {}
      }
    };
    document.addEventListener("pointerdown", unlock, true);

    // Title + Dim in
    await sleep(0);
    dim.classList.add("is-in");
    title.classList.add("is-in");

    await sleep(TITLE_EASE_MS);
    await sleep(TITLE_AFTER_PAUSE_MS);

    // Intro: sprite lead + panel stagger
    for (let i = 0; i < cards.length; i++) {
      await sleep(INTRO_STAGGER_MS);
      cards[i].sprite?.classList.add("is-in");
      await sleep(SPRITE_LEAD_MS);
      cards[i].card?.classList.add("is-in");
    }

    await sleep(INTRO_EASE_MS);

    // Re-position footer (grid height might change slightly after assets load)
    positionFooterUnderGrid(grid, footerBuilt.footer, 16);

    // Footer ease in (after panels)
    await sleep(FOOTER_AFTER_PANELS_MS);
    footerBuilt.footer.classList.add("is-in");

    // Footer number rolls (Damage/Healing are dummy, Zenit is real)
    await sleep(40);
    animateNumber(footerBuilt.dmgValueEl, footerData.totalDamage, {
      from: 0,
      duration: DAMAGE_ROLL_MS,
      formatter: (n) => Number(n).toLocaleString(),
    });

    await sleep(60);
    animateNumber(footerBuilt.healValueEl, footerData.totalHealing, {
      from: 0,
      duration: HEALING_ROLL_MS,
      formatter: (n) => Number(n).toLocaleString(),
    });

    await sleep(60);
    animateNumber(footerBuilt.zenitValueEl, footerData.totalZenit, {
      from: 0,
      duration: ZENIT_ROLL_MS,
      formatter: (n) => Number(n).toLocaleString(),
    });

    // Mark intro done time (for minimum visible guarantee)
    const introDoneAtMs = Date.now();

    // ----------------------------------------------------------------------
    // Tick SFX: ONLY while EXP + per-actor Zenit are actively animating
    // ----------------------------------------------------------------------
    let tickMetro = null;

    try {
      const expMsPerPercent = 12;
      const tickIntervalMs = Math.max(35, Math.min(90, expMsPerPercent * 6));

      tickMetro = startTickMetronome({
        intervalMs: tickIntervalMs,
        volume: 0.55,
        playbackRate: 1.35,
        poolSize: 4
      });

      // 1) EXP animations (parallel)
      await Promise.all(cards.map(({ card, levelUp, entry }) => playCardExpAnimation(card, levelUp, entry, rule)));

      // 2) Per-actor Zenit animations (parallel) — AFTER EXP finishes
      await Promise.all(cards.map(({ card, entry }) => playCardZenitAnimation(card, entry)));

    } finally {
      stopTickMetronome(tickMetro);
      tickMetro = null;
    }

    // 3) Hold AFTER animations (silent)
    const holdMs = Number(data?.holdMs ?? 1400);
    await sleep(holdMs);

    // Ensure visible at least N ms after it fully eased in
    const elapsedSinceIntroMs = Date.now() - introDoneAtMs;
    if (elapsedSinceIntroMs < MIN_VISIBLE_AFTER_INTRO_MS) {
      await sleep(MIN_VISIBLE_AFTER_INTRO_MS - elapsedSinceIntroMs);
    }

    // Outro + cleanup
    await teardownAnimated(root);
  }

  // --------------------------------------------------------------------------
  // Expose a local runner so the GM can render immediately (socket may not echo)
  // --------------------------------------------------------------------------
  window.ONI_BattleEnd_SummaryUI = window.ONI_BattleEnd_SummaryUI ?? {};
  window.ONI_BattleEnd_SummaryUI.run = runSummaryUI;
  log("Local API ready: window.ONI_BattleEnd_SummaryUI.run(payload) ✅");

  // --------------------------------------------------------------------------
  // Socket listener
  // --------------------------------------------------------------------------
  game.socket.on(SOCKET_CHANNEL, async (msg) => {
    try {
      if (!msg || msg.type !== MSG_TYPE) return;

      const intendedSceneId = String(msg?.sceneId ?? "");
      if (intendedSceneId && canvas?.scene?.id && intendedSceneId !== canvas.scene.id) {
        log("SummaryUI message for different scene; ignored.", { intendedSceneId, current: canvas.scene.id });
        return;
      }

      log("Received SummaryUI ✅", msg);
      await runSummaryUI(msg.payload);
    } catch (err) {
      console.error(`${tag} handler error:`, err);
    }
  });

  ui.notifications?.info?.("BattleEnd SummaryUI Listener installed ✅");
  log("Installed. Listening on:", SOCKET_CHANNEL);
})();
