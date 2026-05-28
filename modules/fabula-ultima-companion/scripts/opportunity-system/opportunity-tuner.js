/**
 * [ONI] Opportunity System — Live Tuner (dev / temporary tool)
 *
 * Floating draggable panel for tweaking opportunity constants in real-time.
 * Values are written to:
 *   window["oni.OpportunityTuner"]     — read by opportunity-dialog.js on each open
 *   ONI.OpportunitySystem.staggerMs    — manager getter/setter
 *   ONI.OpportunitySystem.bannerEnterMs / bannerLingerMs / bannerExitMs
 *
 * API:
 *   ONI.OpportunityTuner.show()        — show panel (auto-called on load)
 *   ONI.OpportunityTuner.hide()        — hide panel (values preserved)
 *   ONI.OpportunityTuner.copyConfig()  — log current config to console
 */
(() => {
  const TAG     = "[ONI][OpportunityTuner]";
  const GUARD   = "__ONI_OPPORTUNITY_TUNER__";
  const PANEL_ID = "oni-opp-tuner-panel";

  if (window[GUARD]) {
    // Already loaded — just re-show
    document.getElementById(PANEL_ID)?.remove();
    window[GUARD] = false;
  }

  // ── Default values (must mirror opportunity-dialog.js defaults) ──────────────
  const DIALOG_DEFAULTS = {
    RING_NORMAL:   200,
    RING_SELECTED: 248,
    WHEEL_SIZE:    645,
    PORTRAIT_IMG:  170,
    SLOT_WIDTH:    140,
    TRANSITION_MS: 260,
    SPAWN_STAGGER: 45,
  };
  const VIS_DEFAULTS = {
    v0s: 1.45,  // dist 0 scale  (selected)
    v1s: 0.90,  v1o: 0.62,  // dist 1
    v2s: 0.85,  v2o: 0.45,  // dist 2
    v3s: 0.82,  v3o: 0.33,  // dist 3
    v4s: 0.80,  v4o: 0.24,  // dist 4
    v5s: 0.78,  v5o: 0.20,  // dist 5
  };

  // ── Build VIS array from flat tuner state ────────────────────────────────────
  const Z_IDX = [11, 8, 6, 4, 3, 2];
  function buildVis(state) {
    return [0,1,2,3,4,5].map(i => ({
      scale:   Number(state[`v${i}s`] ?? VIS_DEFAULTS[`v${i}s`]),
      opacity: i === 0 ? 1.0 : Number(state[`v${i}o`] ?? VIS_DEFAULTS[`v${i}o`]),
      zIndex:  Z_IDX[i],
    }));
  }

  // ── Apply current tuner state to all systems ─────────────────────────────────
  let _state = {};

  function readInitial() {
    const sys = globalThis.ONI?.OpportunitySystem;
    _state = {
      ...DIALOG_DEFAULTS,
      ...VIS_DEFAULTS,
      ...(window["oni.OpportunityTuner"] ?? {}),
      staggerMs:    sys?.staggerMs    ?? 1500,
      bannerEnterMs: sys?.bannerEnterMs ?? 380,
      bannerLingerMs: sys?.bannerLingerMs ?? 3000,
      bannerExitMs: sys?.bannerExitMs   ?? 360,
    };
    // Flatten any existing VIS array back to flat keys
    const t = window["oni.OpportunityTuner"];
    if (Array.isArray(t?.VIS)) {
      t.VIS.forEach((v, i) => {
        _state[`v${i}s`] = v.scale;
        if (i > 0) _state[`v${i}o`] = v.opacity;
      });
    }
  }

  function applyState() {
    const sys = globalThis.ONI?.OpportunitySystem;
    window["oni.OpportunityTuner"] = {
      RING_NORMAL:   Number(_state.RING_NORMAL),
      RING_SELECTED: Number(_state.RING_SELECTED),
      WHEEL_SIZE:    Number(_state.WHEEL_SIZE),
      PORTRAIT_IMG:  Number(_state.PORTRAIT_IMG),
      SLOT_WIDTH:    Number(_state.SLOT_WIDTH),
      TRANSITION_MS: Number(_state.TRANSITION_MS),
      SPAWN_STAGGER: Number(_state.SPAWN_STAGGER),
      VIS:           buildVis(_state),
    };
    if (sys) {
      sys.staggerMs     = Number(_state.staggerMs);
      sys.bannerEnterMs  = Number(_state.bannerEnterMs);
      sys.bannerLingerMs = Number(_state.bannerLingerMs);
      sys.bannerExitMs   = Number(_state.bannerExitMs);
    }
  }

  // ── CSS ──────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("oni-opp-tuner-css")) return;
    const s = document.createElement("style");
    s.id = "oni-opp-tuner-css";
    s.textContent = `
      #oni-opp-tuner-panel {
        position: fixed; top: 60px; right: 16px;
        width: 310px; max-height: 85vh;
        overflow-y: auto; overflow-x: hidden;
        z-index: 100050;
        background: rgba(14,10,4,.96);
        border: 1.5px solid rgba(252,212,112,.45);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,.7);
        font-family: 'Signika', sans-serif; font-size: .78rem;
        color: #d4c4a8; user-select: none;
      }
      #oni-opp-tuner-panel::-webkit-scrollbar { width: 4px; }
      #oni-opp-tuner-panel::-webkit-scrollbar-thumb { background: rgba(252,212,112,.3); border-radius: 4px; }

      .opp-tuner-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px 6px;
        background: rgba(252,212,112,.10);
        border-bottom: 1px solid rgba(252,212,112,.25);
        border-radius: 9px 9px 0 0;
        cursor: grab; font-size: .8rem; font-weight: 900;
        letter-spacing: .06em; color: #fcd470;
      }
      .opp-tuner-header:active { cursor: grabbing; }
      .opp-tuner-header-btns { display: flex; gap: 6px; }
      .opp-tuner-hbtn {
        width: 18px; height: 18px; border-radius: 50%;
        border: 1.5px solid rgba(252,212,112,.5);
        background: transparent; color: #fcd470;
        font-size: .6rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background .1s;
      }
      .opp-tuner-hbtn:hover { background: rgba(252,212,112,.2); }

      .opp-tuner-section {
        border-bottom: 1px solid rgba(255,255,255,.07);
        padding: 6px 10px;
      }
      .opp-tuner-section-title {
        font-size: .68rem; font-weight: 900; letter-spacing: .08em;
        color: rgba(252,212,112,.7); margin-bottom: 5px; text-transform: uppercase;
      }
      .opp-tuner-row {
        display: flex; align-items: center; gap: 5px;
        margin-bottom: 4px;
      }
      .opp-tuner-lbl {
        width: 112px; flex-shrink: 0; font-size: .72rem;
        color: #b8a888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .opp-tuner-slider {
        flex: 1; height: 3px; accent-color: #fcd470; cursor: pointer;
      }
      .opp-tuner-num {
        width: 46px; flex-shrink: 0;
        background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.15);
        border-radius: 4px; color: #f0e0c0; font-size: .72rem; text-align: right;
        padding: 1px 4px; -moz-appearance: textfield;
      }
      .opp-tuner-num::-webkit-inner-spin-button { display: none; }
      .opp-tuner-unit { width: 20px; flex-shrink: 0; color: rgba(255,255,255,.3); font-size: .66rem; }

      .opp-tuner-footer {
        display: flex; flex-wrap: wrap; gap: 6px;
        padding: 8px 10px;
      }
      .opp-tuner-btn {
        flex: 1; padding: 5px 4px; font-size: .72rem; font-weight: 800;
        border-radius: 6px; cursor: pointer; font-family: 'Signika', sans-serif;
        white-space: nowrap; transition: filter .1s;
      }
      .opp-tuner-btn:hover { filter: brightness(1.15); }
      .opp-tuner-btn-test  { background: linear-gradient(180deg,#4a7a3a,#2e5220); border: 1.5px solid #3a6a2a; color: #c8f0b0; }
      .opp-tuner-btn-banner{ background: linear-gradient(180deg,#3a5a7a,#204060); border: 1.5px solid #2a5070; color: #b0d8f0; }
      .opp-tuner-btn-reset { background: rgba(255,80,80,.15); border: 1.5px solid rgba(255,80,80,.4); color: #ffb0b0; }
      .opp-tuner-btn-copy  { background: rgba(255,255,255,.08); border: 1.5px solid rgba(255,255,255,.2); color: #d4c4a8; }
    `;
    document.head.appendChild(s);
  }

  // ── Slider row builder ───────────────────────────────────────────────────────
  function makeRow(label, key, min, max, step, unit, container) {
    const row  = document.createElement("div");
    row.className = "opp-tuner-row";

    const lbl = document.createElement("span");
    lbl.className = "opp-tuner-lbl";
    lbl.textContent = label;
    lbl.title = label;

    const slider = document.createElement("input");
    slider.type = "range"; slider.className = "opp-tuner-slider";
    slider.min = min; slider.max = max; slider.step = step;
    slider.value = _state[key] ?? 0;

    const num = document.createElement("input");
    num.type = "number"; num.className = "opp-tuner-num";
    num.min = min; num.max = max; num.step = step;
    num.value = _state[key] ?? 0;

    const unitEl = document.createElement("span");
    unitEl.className = "opp-tuner-unit";
    unitEl.textContent = unit;

    const sync = (src, target) => {
      const v = Number(src.value);
      if (!Number.isFinite(v)) return;
      target.value = v;
      _state[key] = v;
      applyState();
    };

    slider.addEventListener("input", () => sync(slider, num));
    num.addEventListener("change", () => { sync(num, slider); });

    row.append(lbl, slider, num, unitEl);
    container.appendChild(row);
  }

  // ── Build panel ──────────────────────────────────────────────────────────────
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    // Header (draggable)
    const header = document.createElement("div");
    header.className = "opp-tuner-header";
    header.innerHTML = `<span>✦ Opportunity Tuner</span>`;
    const btns = document.createElement("div");
    btns.className = "opp-tuner-header-btns";
    const closeBtn = document.createElement("button");
    closeBtn.className = "opp-tuner-hbtn"; closeBtn.textContent = "✕"; closeBtn.title = "Close";
    closeBtn.onclick = () => panel.remove();
    btns.appendChild(closeBtn);
    header.appendChild(btns);
    panel.appendChild(header);

    // Draggable
    let drag = null;
    header.addEventListener("mousedown", e => {
      drag = { ox: e.clientX - panel.offsetLeft, oy: e.clientY - panel.offsetTop };
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      panel.style.right  = "auto";
      panel.style.left   = `${Math.max(0, e.clientX - drag.ox)}px`;
      panel.style.top    = `${Math.max(0, e.clientY - drag.oy)}px`;
    });
    document.addEventListener("mouseup", () => { drag = null; });

    // Section helper
    const section = (title) => {
      const sec = document.createElement("div");
      sec.className = "opp-tuner-section";
      const t = document.createElement("div");
      t.className = "opp-tuner-section-title"; t.textContent = title;
      sec.appendChild(t);
      panel.appendChild(sec);
      return sec;
    };

    // WHEEL GEOMETRY
    const geo = section("Wheel Geometry");
    makeRow("Ring Normal",   "RING_NORMAL",   100, 320,  5, "px", geo);
    makeRow("Ring Selected", "RING_SELECTED", 150, 380,  5, "px", geo);
    makeRow("Wheel Size",    "WHEEL_SIZE",    400, 900, 10, "px", geo);
    makeRow("Portrait Size", "PORTRAIT_IMG",   80, 260,  5, "px", geo);
    makeRow("Slot Width",    "SLOT_WIDTH",      60, 220,  5, "px", geo);

    // SLOT ANIMATION
    const anim = section("Slot Animation");
    makeRow("Transition",    "TRANSITION_MS", 50,  800, 10, "ms", anim);
    makeRow("Spawn Stagger", "SPAWN_STAGGER", 10,  150,  5, "ms", anim);

    // SLOT FOCUS (VIS table)
    const vis = section("Slot Focus (VIS)");
    makeRow("Scale [sel]",   "v0s", 0.8, 2.5, 0.01, "×", vis);
    makeRow("Scale [±1]",    "v1s", 0.3, 1.5, 0.01, "×", vis);
    makeRow("Scale [±2]",    "v2s", 0.3, 1.2, 0.01, "×", vis);
    makeRow("Scale [±3+]",   "v3s", 0.3, 1.0, 0.01, "×", vis);
    makeRow("Opacity [±1]",  "v1o", 0.0, 1.0, 0.01, "",  vis);
    makeRow("Opacity [±2]",  "v2o", 0.0, 0.9, 0.01, "",  vis);
    makeRow("Opacity [±3]",  "v3o", 0.0, 0.7, 0.01, "",  vis);
    makeRow("Opacity [±4+]", "v4o", 0.0, 0.5, 0.01, "",  vis);

    // TIMING
    const tim = section("Timing");
    makeRow("Stagger",        "staggerMs",     0,    6000, 100, "ms", tim);
    makeRow("Banner Enter",   "bannerEnterMs",  50,   1200,  20, "ms", tim);
    makeRow("Banner Linger",  "bannerLingerMs", 500,  8000, 250, "ms", tim);
    makeRow("Banner Exit",    "bannerExitMs",   50,   1200,  20, "ms", tim);

    // Footer buttons
    const footer = document.createElement("div");
    footer.className = "opp-tuner-footer";

    const mkBtn = (label, cls, cb) => {
      const b = document.createElement("button");
      b.className = `opp-tuner-btn ${cls}`;
      b.textContent = label;
      b.onclick = cb;
      footer.appendChild(b);
    };

    mkBtn("▶ Test Picker", "opp-tuner-btn-test", () => {
      const sys = globalThis.ONI?.OpportunitySystem;
      if (!sys) return;
      const actor = game.user?.character;
      const portrait = actor?.img ?? actor?.prototypeToken?.texture?.src ?? "";
      sys.testPicker(actor?.name ?? "Test", portrait);
    });

    mkBtn("▶ Test Banner", "opp-tuner-btn-banner", () => {
      globalThis.ONI?.OpportunitySystem?.testBanner("advantage");
    });

    mkBtn("↺ Reset", "opp-tuner-btn-reset", () => {
      _state = { ...DIALOG_DEFAULTS, ...VIS_DEFAULTS, staggerMs: 1500, bannerEnterMs: 380, bannerLingerMs: 3000, bannerExitMs: 360 };
      window["oni.OpportunityTuner"] = undefined;
      panel.remove();
      buildPanel();
    });

    mkBtn("⎘ Copy", "opp-tuner-btn-copy", () => {
      const cfg = window["oni.OpportunityTuner"] ?? {};
      const out = [
        "// opportunity-dialog.js",
        `let RING_NORMAL   = ${cfg.RING_NORMAL};`,
        `let RING_SELECTED = ${cfg.RING_SELECTED};`,
        `let WHEEL_SIZE    = ${cfg.WHEEL_SIZE};`,
        `let PORTRAIT_IMG  = ${cfg.PORTRAIT_IMG};`,
        `let SLOT_WIDTH    = ${cfg.SLOT_WIDTH};`,
        `let TRANSITION_MS = ${cfg.TRANSITION_MS};`,
        `let SPAWN_STAGGER = ${cfg.SPAWN_STAGGER};`,
        `let VIS = ${JSON.stringify(cfg.VIS, null, 2)};`,
        "",
        "// opportunity-manager.js",
        `let _staggerMs     = ${_state.staggerMs};`,
        `let _bannerEnterMs  = ${_state.bannerEnterMs};`,
        `let _bannerLingerMs = ${_state.bannerLingerMs};`,
        `let _bannerExitMs   = ${_state.bannerExitMs};`,
      ].join("\n");
      console.log(`${TAG} Current config:\n${out}`);
      try { navigator.clipboard.writeText(out); ui.notifications?.info("Tuner config copied to clipboard."); }
      catch(_) { ui.notifications?.info("Tuner config logged to console (clipboard unavailable)."); }
    });

    panel.appendChild(footer);
    document.body.appendChild(panel);
    window[GUARD] = true;
    return panel;
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  readInitial();
  applyState();

  globalThis.ONI = globalThis.ONI ?? {};
  globalThis.ONI.OpportunityTuner = {
    show()       { if (!document.getElementById(PANEL_ID)) buildPanel(); },
    hide()       { document.getElementById(PANEL_ID)?.remove(); },
    copyConfig() { document.querySelector(".opp-tuner-btn-copy")?.click(); },
  };

  injectStyles();
  buildPanel();

  console.debug(`${TAG} Loaded. Use ONI.OpportunityTuner.show() / .hide() / .copyConfig()`);
})();
