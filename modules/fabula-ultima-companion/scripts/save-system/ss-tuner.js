// ============================================================================
// SS Tuner — Save System UI/UX Live Tuning Helper
//
// Bootstrap (paste into Foundry console or a Script macro):
//   fetch('modules/fabula-ultima-companion/scripts/save-system/ss-tuner.js').then(r=>r.text()).then(eval)
//
// The tuner opens the Save System UI automatically, then floats INSIDE the
// overlay (as a child) so it appears above the panel without z-index fights.
// Sliders live-patch a <style> override tag. Click EXPORT to get the JSON.
// ============================================================================
(async () => {
  const SS = globalThis.SaveSystem;
  if (!SS?.UI) { ui.notifications?.warn("[SS Tuner] SaveSystem.UI not found."); return; }

  // ── Open the save UI if not already open ─────────────────────────────────────
  if (!document.getElementById("save-system-overlay")) {
    SS.UI.open();
    await new Promise(r => setTimeout(r, 80));  // wait for first render
  }

  const overlay = document.getElementById("save-system-overlay");
  if (!overlay) { ui.notifications?.warn("[SS Tuner] Could not find overlay after open()."); return; }

  // Remove any existing tuner
  document.getElementById("ss-tuner")?.remove();
  document.getElementById("ss-tuner-css")?.remove();

  // ── Default values — keep in sync with save-ui.js ────────────────────────────
  const P = {
    panelWidthMin:    720,
    panelWidthPct:    92,
    panelWidthMax:    1570,
    panelPadH:        63,
    panelPadV:        59,
    slotGap:          28,
    slotBodyPad:      28,
    slotBodyGap:      40,
    portraitH:        125,
    portraitMaxW:     160,
    portraitsMaxW:    387,
    portraitGap:      4,
    portraitMarginR:  0,
    confInnerMinW:    457,
    titleSize:        28,
    slotNameSize:     16,
    slotSubSize:      9,
    slotNumSize:      16,
    blendMode:        0,    // 0=normal, 1=multiply
  };

  // ── CSS injector (overrides save-ui.js values) ────────────────────────────────
  function applyCSS(p) {
    let s = document.getElementById("ss-tuner-css");
    if (!s) { s = document.createElement("style"); s.id = "ss-tuner-css"; document.head.appendChild(s); }
    s.textContent = `
      .ss-panel {
        width: clamp(${p.panelWidthMin}px, ${p.panelWidthPct}vw, ${p.panelWidthMax}px) !important;
        padding: ${p.panelPadV}px ${p.panelPadH}px !important;
      }
      .ss-slots          { gap: ${p.slotGap}px !important; }
      .ss-slot-body      { padding: ${p.slotBodyPad}px 22px !important; gap: ${p.slotBodyGap}px !important; }
      .ss-slot-portrait  { height: ${p.portraitH}px !important; max-width: ${p.portraitMaxW}px !important;
                           mix-blend-mode: ${p.blendMode ? "multiply" : "normal"} !important; }
      .ss-slot-portraits { max-width: ${p.portraitsMaxW}px !important; gap: ${p.portraitGap}px !important;
                           margin-right: ${p.portraitMarginR}px !important; }
      .ss-slot-info      { margin-left: 0 !important; }
      .ss-conf-inner     { min-width: ${p.confInnerMinW}px !important; }
      .ss-title          { font-size: ${p.titleSize}px !important; }
      .ss-slot-name      { font-size: ${p.slotNameSize}px !important; }
      .ss-slot-party, .ss-slot-loc, .ss-slot-date { font-size: ${p.slotSubSize}px !important; }
      .ss-slot-num       { font-size: ${p.slotNumSize}px !important; }
    `;
  }

  // ── Slider definitions: [label, key, min, max] ───────────────────────────────
  const ROWS = [
    ["— Panel —",        null,             0,    0  ],
    ["Width min px",     "panelWidthMin",  400,  1600],
    ["Width % vw",       "panelWidthPct",  50,   100 ],
    ["Width max px",     "panelWidthMax",  600,  1800],
    ["Padding H px",     "panelPadH",      10,   100 ],
    ["Padding V px",     "panelPadV",      10,   80  ],
    ["— Slots —",        null,             0,    0   ],
    ["Slot gap px",      "slotGap",        2,    30  ],
    ["Body pad px",      "slotBodyPad",    4,    40  ],
    ["Body gap px",      "slotBodyGap",    4,    40  ],
    ["— Portraits —",    null,             0,    0   ],
    ["Height px",        "portraitH",      40,   220 ],
    ["Max-width px",     "portraitMaxW",   30,   200 ],
    ["Container px",     "portraitsMaxW",  100,  700 ],
    ["Gap px",           "portraitGap",    0,    40  ],
    ["Margin-right px",  "portraitMarginR", 0,   120 ],
    ["— Confirm —",      null,             0,    0   ],
    ["Inner min-w px",   "confInnerMinW",  200,  700 ],
    ["— Text —",         null,             0,    0   ],
    ["Title px",         "titleSize",      12,   42  ],
    ["Slot name px",     "slotNameSize",   8,    28  ],
    ["Slot sub px",      "slotSubSize",    7,    20  ],
    ["Slot num px",      "slotNumSize",    7,    24  ],
  ];

  // ── Build slider HTML ─────────────────────────────────────────────────────────
  let rows = "";
  for (const [label, key, min, max] of ROWS) {
    if (!key) {
      rows += `<div style="margin:8px 0 3px;color:#f5d060;letter-spacing:2px;font-size:9px;border-top:1px solid #3a2008;padding-top:7px;">${label}</div>`;
      continue;
    }
    rows += `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span style="width:118px;color:#c8a05a;font-size:9px;flex-shrink:0;">${label}</span>
        <input type="range" id="ss-t-${key}" min="${min}" max="${max}" value="${P[key]}"
          style="flex:1;accent-color:#e8a820;height:12px;cursor:pointer;"
          onmousedown="event.stopPropagation()">
        <span id="ss-tv-${key}" style="width:34px;text-align:right;color:#f0e0a0;font-size:9px;">${P[key]}</span>
      </div>`;
  }

  // ── Build panel ───────────────────────────────────────────────────────────────
  const el = document.createElement("div");
  el.id = "ss-tuner";
  // Positioned INSIDE the overlay — absolute so it floats above the panel
  Object.assign(el.style, {
    position: "absolute", top: "12px", right: "12px", zIndex: "9999",
    background: "#1a0f04", border: "1px solid #c9a22a", borderRadius: "8px",
    padding: "12px 16px 10px", color: "#e8d880", fontFamily: "monospace", fontSize: "10px",
    minWidth: "290px", boxShadow: "0 8px 32px rgba(0,0,0,0.9)",
    userSelect: "none", cursor: "default",
  });

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-size:12px;font-weight:bold;color:#f5d060;letter-spacing:3px;">SS TUNER</span>
      <button id="ss-t-close" style="padding:3px 8px;background:#200a04;border:1px solid #8b3820;color:#f08060;cursor:pointer;font-family:monospace;font-size:9px;border-radius:3px;">✕ CLOSE</button>
    </div>
    <div style="font-size:8px;color:#7a5428;margin-bottom:4px;">drag sliders with mouse · use arrow keys to step</div>
    ${rows}
    <div style="margin-top:10px;display:flex;gap:6px;align-items:center;">
      <span style="font-size:9px;color:#c8a05a;flex-shrink:0;">Sprite blend</span>
      <button id="ss-t-blend" style="flex:1;padding:5px;background:#1e1006;border:1px solid #7a5428;color:#c8a05a;cursor:pointer;font-family:monospace;font-size:9px;border-radius:4px;">NORMAL</button>
    </div>
    <div style="margin-top:6px;display:flex;gap:6px;">
      <button id="ss-t-export" style="flex:1;padding:6px;background:#2e1a06;border:1px solid #c9a22a;color:#f5d060;cursor:pointer;font-family:monospace;font-size:9px;letter-spacing:2px;border-radius:4px;">EXPORT JSON</button>
    </div>
    <pre id="ss-t-out" style="display:none;margin:8px 0 0;background:#0d0600;border:1px solid #5a3810;border-radius:4px;padding:7px;font-size:8px;color:#c8a870;max-height:140px;overflow-y:auto;white-space:pre-wrap;"></pre>
  `;

  // ── Survive _render() ── each render replaces overlay.innerHTML, destroying tuner.
  // Monkey-patch _render to re-append el after every call.
  const _origRender = SS.UI._render.bind(SS.UI);
  SS.UI._render = function() {
    _origRender();
    if (SS.UI._el && !SS.UI._el.contains(el)) SS.UI._el.appendChild(el);
  };

  // Initial append
  overlay.appendChild(el);

  // ── Stop save-system keyboard capture from swallowing slider arrow keys ────────
  el.addEventListener("keydown",  e => e.stopImmediatePropagation(), { capture: true });
  el.addEventListener("keyup",    e => e.stopImmediatePropagation(), { capture: true });
  el.addEventListener("mousedown",e => e.stopPropagation());
  el.addEventListener("click",    e => e.stopPropagation());

  // ── Wire sliders ──────────────────────────────────────────────────────────────
  for (const [, key] of ROWS) {
    if (!key) continue;
    const slider = el.querySelector(`#ss-t-${key}`);
    const valEl  = el.querySelector(`#ss-tv-${key}`);
    slider.addEventListener("input", () => {
      P[key] = Number(slider.value);
      valEl.textContent = slider.value;
      applyCSS(P);
    });
  }

  // ── Blend mode toggle ─────────────────────────────────────────────────────────
  const blendBtn = el.querySelector("#ss-t-blend");
  blendBtn.addEventListener("click", () => {
    P.blendMode = P.blendMode ? 0 : 1;
    blendBtn.textContent = P.blendMode ? "MULTIPLY" : "NORMAL";
    blendBtn.style.color = P.blendMode ? "#f5d060" : "#c8a05a";
    blendBtn.style.borderColor = P.blendMode ? "#c9a22a" : "#7a5428";
    applyCSS(P);
  });

  // ── Export ─────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-t-export").addEventListener("click", () => {
    const json = JSON.stringify(P, null, 2);
    const out  = el.querySelector("#ss-t-out");
    out.textContent = json;
    out.style.display = "block";
    console.log("[SS Tuner] Final values:\n" + json);
  });

  // ── Close ──────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-t-close").addEventListener("click", () => {
    SS.UI._render = _origRender;   // restore before removing
    el.remove();
    document.getElementById("ss-tuner-css")?.remove();
  });

  applyCSS(P);
  console.log("[SS Tuner] Ready. Adjust sliders, then click EXPORT JSON and paste the result here.");
})();
