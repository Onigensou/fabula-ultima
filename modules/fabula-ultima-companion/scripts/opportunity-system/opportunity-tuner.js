/**
 * [ONI] Opportunity System — Live Tuner  (dev / temporary tool)
 *
 * Floating draggable panel — parchment theme.
 * Each row: label | slider ——————————— | live value | unit
 *
 * Changes take effect the next time "▶ Test Picker" is clicked (or any real crit).
 * Banner timing changes take effect immediately (manager setters).
 *
 * ONI.OpportunityTuner.show()        re-show panel
 * ONI.OpportunityTuner.hide()        hide panel (values preserved)
 * ONI.OpportunityTuner.copyConfig()  log / copy ready-to-paste source lines
 */
(() => {
  const TAG      = "[ONI][OpportunityTuner]";
  const PANEL_ID = "oni-opp-tuner-panel";
  const CSS_ID   = "oni-opp-tuner-css";

  // Tear down any previous instance (re-running the script refreshes the panel)
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(CSS_ID)?.remove();

  // ── Defaults (must mirror the `let` variables in opportunity-dialog.js) ──────
  const DEFAULTS = {
    // Wheel geometry
    RING_NORMAL:   245,
    RING_SELECTED: 280,
    WHEEL_SIZE:    645,
    PORTRAIT_IMG:  170,
    SLOT_WIDTH:    140,
    // Slot animation
    TRANSITION_MS: 260,
    SPAWN_STAGGER:  50,
    // VIS table — flat keys (built into array on applyState)
    v0s: 1.73,                         // dist-0 scale  (selected)
    v1s: 1.11, v1o: 0.97,              // dist-1
    v2s: 0.92, v2o: 0.86,              // dist-2
    v3s: 0.82, v3o: 0.67,              // dist-3
    v4s: 0.80, v4o: 0.48,              // dist-4
    v5s: 0.78, v5o: 0.20,              // dist-5
    // Timing + position + size (manager)
    staggerMs:      800,
    bannerEnterMs:  750,
    bannerLingerMs: 2500,
    bannerExitMs:   410,
    bannerTopPx:    100,  // px from top (100 = confirmed good)
    bannerWidthPx:  300,  // 0 = auto (content-driven)
    bannerHeightPx:   0,  // 0 = auto
  };

  // ── State — starts from current live values or defaults ─────────────────────
  let S = {};

  function readLiveState() {
    const sys = globalThis.ONI?.OpportunitySystem;
    const saved = window["oni.OpportunityTuner"] ?? {};
    S = { ...DEFAULTS };

    // Pull saved dialog constants
    for (const k of ["RING_NORMAL","RING_SELECTED","WHEEL_SIZE","PORTRAIT_IMG","SLOT_WIDTH","TRANSITION_MS","SPAWN_STAGGER"])
      if (saved[k] != null) S[k] = Number(saved[k]);

    // Unpack saved VIS array back to flat keys
    if (Array.isArray(saved.VIS)) {
      saved.VIS.forEach((v, i) => {
        S[`v${i}s`] = v.scale ?? DEFAULTS[`v${i}s`];
        if (i > 0) S[`v${i}o`] = v.opacity ?? DEFAULTS[`v${i}o`];
      });
    }

    // Pull live manager values (setters are the source of truth for timing)
    if (sys) {
      S.staggerMs      = sys.staggerMs      ?? DEFAULTS.staggerMs;
      S.bannerEnterMs  = sys.bannerEnterMs  ?? DEFAULTS.bannerEnterMs;
      S.bannerLingerMs = sys.bannerLingerMs ?? DEFAULTS.bannerLingerMs;
      S.bannerExitMs   = sys.bannerExitMs   ?? DEFAULTS.bannerExitMs;
      S.bannerTopPx    = sys.bannerTopPx    ?? DEFAULTS.bannerTopPx;
      S.bannerWidthPx  = sys.bannerWidthPx  ?? DEFAULTS.bannerWidthPx;
      S.bannerHeightPx = sys.bannerHeightPx ?? DEFAULTS.bannerHeightPx;
    }
  }

  // ── Commit current state to all systems ─────────────────────────────────────
  const Z_IDX = [11, 8, 6, 4, 3, 2];
  function buildVIS() {
    return [0,1,2,3,4,5].map(i => ({
      scale:   Number(S[`v${i}s`]),
      opacity: i === 0 ? 1.0 : Number(S[`v${i}o`]),
      zIndex:  Z_IDX[i],
    }));
  }

  function applyState() {
    window["oni.OpportunityTuner"] = {
      RING_NORMAL:   S.RING_NORMAL,
      RING_SELECTED: S.RING_SELECTED,
      WHEEL_SIZE:    S.WHEEL_SIZE,
      PORTRAIT_IMG:  S.PORTRAIT_IMG,
      SLOT_WIDTH:    S.SLOT_WIDTH,
      TRANSITION_MS: S.TRANSITION_MS,
      SPAWN_STAGGER: S.SPAWN_STAGGER,
      VIS: buildVIS(),
    };
    const sys = globalThis.ONI?.OpportunitySystem;
    if (sys) {
      sys.staggerMs      = S.staggerMs;
      sys.bannerEnterMs  = S.bannerEnterMs;
      sys.bannerLingerMs = S.bannerLingerMs;
      sys.bannerExitMs   = S.bannerExitMs;
      sys.bannerTopPx    = S.bannerTopPx;
      sys.bannerWidthPx  = S.bannerWidthPx;
      sys.bannerHeightPx = S.bannerHeightPx;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function fmt(v, step) {
    return step < 1 ? Number(v).toFixed(2) : String(Math.round(v));
  }

  // ── CSS ─────────────────────────────────────────────────────────────────────
  function injectCSS() {
    const s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent = `
      #${PANEL_ID} {
        position: fixed; top: 60px; right: 16px;
        width: 320px; max-height: 88vh;
        overflow-y: auto; overflow-x: hidden;
        z-index: 100050;
        background:
          radial-gradient(110% 70% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.12) 25%, transparent 50%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 60%, #e4d0b5 100%);
        border: 2px solid rgba(91,63,38,.75);
        border-radius: 10px;
        box-shadow: 0 10px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,248,232,.7);
        font-family: 'Signika', sans-serif;
        font-size: .78rem; color: #3b2a19;
      }
      #${PANEL_ID}::-webkit-scrollbar { width: 5px; }
      #${PANEL_ID}::-webkit-scrollbar-thumb {
        background: rgba(91,63,38,.35); border-radius: 4px;
      }

      .opp-t-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 13px 7px;
        background: rgba(91,63,38,.14);
        border-bottom: 1.5px solid rgba(91,63,38,.3);
        border-radius: 9px 9px 0 0;
        cursor: grab; font-size: .82rem; font-weight: 900;
        letter-spacing: .05em; color: #3b2a19;
      }
      .opp-t-header:active { cursor: grabbing; }
      .opp-t-close {
        width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid rgba(91,63,38,.5);
        background: transparent; color: #5a3a1a; font-size: .7rem; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background .1s;
      }
      .opp-t-close:hover { background: rgba(91,63,38,.18); }

      .opp-t-section {
        padding: 7px 12px 5px;
        border-bottom: 1.5px solid rgba(91,63,38,.15);
      }
      .opp-t-section-title {
        font-size: .66rem; font-weight: 900; letter-spacing: .09em;
        color: rgba(91,63,38,.75); text-transform: uppercase;
        margin-bottom: 6px;
      }

      /* Each row: label | slider | value | unit */
      .opp-t-row {
        display: grid;
        grid-template-columns: 108px 1fr 42px 20px;
        align-items: center; gap: 5px;
        margin-bottom: 5px;
      }
      .opp-t-lbl {
        font-size: .72rem; color: #5a3a1a;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .opp-t-slider {
        width: 100%;
        accent-color: #8a5020;
        cursor: pointer;
      }
      .opp-t-val {
        font-size: .73rem; font-weight: 800; color: #3b2a19;
        text-align: right; white-space: nowrap;
      }
      .opp-t-unit {
        font-size: .65rem; color: rgba(91,63,38,.5);
        white-space: nowrap;
      }

      .opp-t-footer {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 6px; padding: 8px 12px;
      }
      .opp-t-btn {
        padding: 6px 4px; font-size: .72rem; font-weight: 800;
        border-radius: 7px; cursor: pointer;
        font-family: 'Signika', sans-serif; white-space: nowrap;
        transition: filter .1s, transform .1s;
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        border: 2px solid rgba(91,63,38,.65); color: #3b2a19;
      }
      .opp-t-btn:hover { filter: brightness(1.07); transform: translateY(-1px); }
      .opp-t-btn-test   { border-color: #3a6a2a; color: #2a5020; }
      .opp-t-btn-banner { border-color: #2a5070; color: #1a3555; }
      .opp-t-btn-reset  { border-color: rgba(160,50,50,.6); color: #8a2020; }
      .opp-t-btn-copy   { border-color: rgba(91,63,38,.5); }
    `;
    document.head.appendChild(s);
  }

  // ── Slider row factory ───────────────────────────────────────────────────────
  function addRow(container, label, key, min, max, step, unit) {
    const row    = document.createElement("div");
    row.className = "opp-t-row";

    const lbl  = document.createElement("span");
    lbl.className = "opp-t-lbl"; lbl.textContent = label; lbl.title = label;

    const slider = document.createElement("input");
    slider.type      = "range";
    slider.className = "opp-t-slider";
    slider.min   = String(min);
    slider.max   = String(max);
    slider.step  = String(step);
    slider.value = String(S[key] ?? min);

    const valEl = document.createElement("span");
    valEl.className   = "opp-t-val";
    valEl.textContent = fmt(S[key] ?? min, step);

    const unitEl = document.createElement("span");
    unitEl.className   = "opp-t-unit";
    unitEl.textContent = unit;

    // oninput fires on every thumb move — most reliable approach
    slider.oninput = function () {
      const v = parseFloat(this.value);
      S[key] = v;
      valEl.textContent = fmt(v, step);
      applyState();
    };

    row.append(lbl, slider, valEl, unitEl);
    container.appendChild(row);
  }

  // ── Build panel ──────────────────────────────────────────────────────────────
  function buildPanel() {
    injectCSS();
    readLiveState();
    applyState(); // write current state to globals so tuner is in sync on open

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    // Header
    const header = document.createElement("div");
    header.className = "opp-t-header";
    header.innerHTML = `<span>✦ Opportunity Tuner</span>`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "opp-t-close"; closeBtn.textContent = "✕"; closeBtn.title = "Close";
    closeBtn.onclick = () => panel.remove();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Draggable
    let drag = null;
    header.addEventListener("mousedown", e => {
      const r = panel.getBoundingClientRect();
      drag = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      panel.style.right = "auto";
      panel.style.left  = `${Math.max(0, Math.min(window.innerWidth  - 330, e.clientX - drag.ox))}px`;
      panel.style.top   = `${Math.max(0, Math.min(window.innerHeight - 100, e.clientY - drag.oy))}px`;
    });
    document.addEventListener("mouseup", () => { drag = null; });

    // Section helper
    const section = (title) => {
      const sec  = document.createElement("div");
      sec.className = "opp-t-section";
      const ttl  = document.createElement("div");
      ttl.className = "opp-t-section-title"; ttl.textContent = title;
      sec.appendChild(ttl);
      panel.appendChild(sec);
      return sec;
    };

    // ── Wheel Geometry
    const geo = section("Wheel Geometry");
    addRow(geo, "Ring Normal",   "RING_NORMAL",   100, 320,  5, "px");
    addRow(geo, "Ring Selected", "RING_SELECTED", 160, 380,  5, "px");
    addRow(geo, "Wheel Size",    "WHEEL_SIZE",    400, 900, 10, "px");
    addRow(geo, "Portrait Size", "PORTRAIT_IMG",   80, 260,  5, "px");
    addRow(geo, "Slot Width",    "SLOT_WIDTH",     60, 220,  5, "px");

    // ── Slot Animation
    const anim = section("Slot Animation");
    addRow(anim, "Transition",    "TRANSITION_MS",  50,  800, 10, "ms");
    addRow(anim, "Spawn Stagger", "SPAWN_STAGGER",  10,  150,  5, "ms");

    // ── Slot Focus (VIS)
    const vis = section("Slot Focus (VIS)");
    addRow(vis, "Scale [sel]",    "v0s",  0.80, 2.50, 0.01, "×");
    addRow(vis, "Scale [±1]",     "v1s",  0.30, 1.50, 0.01, "×");
    addRow(vis, "Scale [±2]",     "v2s",  0.30, 1.20, 0.01, "×");
    addRow(vis, "Scale [±3+]",    "v3s",  0.30, 1.00, 0.01, "×");
    addRow(vis, "Opacity [±1]",   "v1o",  0.00, 1.00, 0.01, "");
    addRow(vis, "Opacity [±2]",   "v2o",  0.00, 0.90, 0.01, "");
    addRow(vis, "Opacity [±3]",   "v3o",  0.00, 0.70, 0.01, "");
    addRow(vis, "Opacity [±4+]",  "v4o",  0.00, 0.50, 0.01, "");

    // ── Timing
    const tim = section("Timing");
    addRow(tim, "Stagger",           "staggerMs",       0,  6000, 100, "ms");
    addRow(tim, "Banner Enter",      "bannerEnterMs",  50,  1200,  20, "ms");
    addRow(tim, "Banner Linger",     "bannerLingerMs", 500, 8000, 250, "ms");
    addRow(tim, "Banner Exit",       "bannerExitMs",   50,  1200,  20, "ms");
    addRow(tim, "Banner Top",        "bannerTopPx",     0,   500,   5, "px");
    addRow(tim, "Banner Width(0=auto)","bannerWidthPx", 0,  1400,  10, "px");
    addRow(tim, "Banner Ht(0=auto)", "bannerHeightPx",  0,   200,   5, "px");

    // ── Footer buttons
    const footer = document.createElement("div");
    footer.className = "opp-t-footer";

    const btn = (label, cls, cb) => {
      const b = document.createElement("button");
      b.className = `opp-t-btn ${cls}`; b.textContent = label; b.onclick = cb;
      footer.appendChild(b);
    };

    btn("▶ Test Picker", "opp-t-btn-test", () => {
      const sys    = globalThis.ONI?.OpportunitySystem;
      const actor  = game.user?.character;
      const portrait = actor?.img ?? actor?.prototypeToken?.texture?.src ?? "";
      sys?.testPicker(actor?.name ?? "Test", portrait);
    });

    btn("▶ Test Banner", "opp-t-btn-banner", () => {
      globalThis.ONI?.OpportunitySystem?.testBanner("advantage");
    });

    btn("↺ Reset", "opp-t-btn-reset", () => {
      window["oni.OpportunityTuner"] = undefined;
      panel.remove();
      buildPanel();
    });

    btn("⎘ Copy Config", "opp-t-btn-copy", () => {
      const cfg = window["oni.OpportunityTuner"] ?? {};
      const lines = [
        "// ── opportunity-dialog.js ──────────────────",
        `  let RING_NORMAL   = ${cfg.RING_NORMAL ?? S.RING_NORMAL};`,
        `  let RING_SELECTED = ${cfg.RING_SELECTED ?? S.RING_SELECTED};`,
        `  let WHEEL_SIZE    = ${cfg.WHEEL_SIZE ?? S.WHEEL_SIZE};`,
        `  let PORTRAIT_IMG  = ${cfg.PORTRAIT_IMG ?? S.PORTRAIT_IMG};`,
        `  let SLOT_WIDTH    = ${cfg.SLOT_WIDTH ?? S.SLOT_WIDTH};`,
        `  let TRANSITION_MS = ${cfg.TRANSITION_MS ?? S.TRANSITION_MS};`,
        `  let SPAWN_STAGGER = ${cfg.SPAWN_STAGGER ?? S.SPAWN_STAGGER};`,
        `  let VIS = ${JSON.stringify(cfg.VIS ?? buildVIS(), null, 4)};`,
        "",
        "// ── opportunity-manager.js ──────────────────",
        `  let _staggerMs     = ${S.staggerMs};`,
        `  let _bannerEnterMs  = ${S.bannerEnterMs};`,
        `  let _bannerLingerMs = ${S.bannerLingerMs};`,
        `  let _bannerExitMs   = ${S.bannerExitMs};`,
        `  let _bannerTopPx    = ${S.bannerTopPx};`,
        `  let _bannerWidthPx  = ${S.bannerWidthPx};`,
        `  let _bannerHeightPx = ${S.bannerHeightPx};`,
      ].join("\n");

      console.log(`${TAG} Config:\n${lines}`);
      try {
        navigator.clipboard.writeText(lines);
        ui?.notifications?.info("Opportunity tuner config copied to clipboard.");
      } catch (_) {
        ui?.notifications?.info("Config logged to console (clipboard unavailable).");
      }
    });

    panel.appendChild(footer);
    document.body.appendChild(panel);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OpportunityTuner = {
    show()       { if (!document.getElementById(PANEL_ID)) buildPanel(); },
    hide()       { document.getElementById(PANEL_ID)?.remove(); },
    copyConfig() { document.querySelector(".opp-t-btn-copy")?.click(); },
  };

  buildPanel();
  console.debug(`${TAG} Ready. ONI.OpportunityTuner.show() / .hide() / .copyConfig()`);
})();
