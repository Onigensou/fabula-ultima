// ============================================================================
// Out-of-Combat Healing — layout tuner.
//
// A small draggable panel that live-edits HEAL_TUNE (the HUD's layout
// constants) and applies changes instantly via HealingHUD.applyTune(). Use it
// to dial in the design, then click "Copy config" and paste the values into
// HEAL_TUNE's defaults in healing-const.js to bake them in.
//
// Opened via FUCompanion.api.healing.tuner.open() (or the "Healing HUD Tuner"
// macro). Opens the HUD first if it isn't already up.
// ============================================================================

import { HEAL_TAG, HEAL_TUNE } from "./healing-const.js";
import { HealingHUD } from "./healing-hud-app.js";

const PANEL_ID = "oni-heal-tuner";

// [key, label, kind, min, max, step]
const CONTROLS = [
  ["__g", "Panels"],
  ["frameWidth",   "Frame width (px)",    "num", 800, 1700, 5],
  ["frameHeight",  "Frame height (px)",   "num", 380, 1040, 5],
  ["pickerWidth",  "Picker width (%)",    "num", 18,  60,   1],
  ["cellGap",      "Panel gap (px)",      "num", 0,   48,   1],
  ["__g", "Battle sprite (floating)"],
  ["spriteWidth",  "Sprite width (px)",   "num", 50,  280,  2],
  ["spriteHeight", "Sprite height (px)",  "num", 50,  320,  2],
  ["spriteRight",  "Offset from right (px)", "num", -120, 120, 1],
  ["spriteBottom", "Offset from bottom (px)", "num", -120, 120, 1],
  ["__g", "Actor name"],
  ["nameSize",        "Name font (px)",     "num", 12, 40, 1],
  ["nameStrokeColor", "Name stroke color",  "color"],
  ["nameStrokeWidth", "Name stroke (px)",   "num", 0,  5,  0.1],
  ["__g", "Stat text"],
  ["resSize",   "Value font (px)",  "num", 10, 30, 1],
  ["labelSize", "Label font (px)",  "num", 8,  24, 1],
  ["rowGap",    "Row gap (px)",     "num", 0,  24, 1],
];

let _panel = null;

function injectStyles() {
  if (document.getElementById(PANEL_ID + "-styles")) return;
  const s = document.createElement("style");
  s.id = PANEL_ID + "-styles";
  s.textContent = `
#${PANEL_ID} {
  position: fixed; top: 70px; right: 24px; z-index: 2147483647;
  width: 300px; max-height: 86vh; overflow-y: auto;
  background: rgba(22,24,32,0.97); color: #e9eef7;
  border: 1px solid #4a5a86; border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.6); font: 12px/1.4 "Signika", sans-serif;
}
#${PANEL_ID} .tn-head {
  display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:move;
  background: linear-gradient(90deg,#2c3a64,#1d2440); border-radius:10px 10px 0 0;
  font-weight:700; font-size:13px; user-select:none;
}
#${PANEL_ID} .tn-head .x { margin-left:auto; cursor:pointer; opacity:.8; padding:0 4px; }
#${PANEL_ID} .tn-head .x:hover { opacity:1; color:#ff8a8a; }
#${PANEL_ID} .tn-body { padding: 8px 12px 12px; }
#${PANEL_ID} .tn-group { margin:12px 0 4px; font-weight:700; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#9fb4e0; border-bottom:1px solid rgba(159,180,224,.25); padding-bottom:3px; }
#${PANEL_ID} .tn-row { display:flex; align-items:center; gap:8px; margin:6px 0; }
#${PANEL_ID} .tn-row label { flex:1; min-width:0; }
#${PANEL_ID} .tn-row input[type=range] { flex:0 0 96px; }
#${PANEL_ID} .tn-row input[type=number] { flex:0 0 58px; width:58px; background:#11141f; color:#e9eef7; border:1px solid #3a4566; border-radius:5px; padding:3px 5px; }
#${PANEL_ID} .tn-row input[type=color] { flex:0 0 38px; height:26px; padding:0; border:1px solid #3a4566; border-radius:5px; background:#11141f; }
#${PANEL_ID} .tn-actions { display:flex; gap:8px; margin-top:14px; }
#${PANEL_ID} .tn-btn { flex:1; text-align:center; padding:7px; border-radius:7px; cursor:pointer; font-weight:700; border:1px solid #4a5a86; background:#2a3658; color:#e9eef7; }
#${PANEL_ID} .tn-btn:hover { background:#36457a; }
#${PANEL_ID} .tn-btn.reset { background:#5a2a2a; border-color:#864a4a; }
`;
  document.head.appendChild(s);
}

function applyLive() { try { HealingHUD.applyTune(); } catch (e) { console.warn(HEAL_TAG, "tuner applyTune failed", e); } }

function buildRow([key, label, kind, min, max, step]) {
  if (key === "__g") return `<div class="tn-group">${label}</div>`;
  const val = HEAL_TUNE[key];
  if (kind === "color") {
    return `<div class="tn-row" data-key="${key}" data-kind="color">
      <label>${label}</label>
      <input type="color" value="${val}">
    </div>`;
  }
  return `<div class="tn-row" data-key="${key}" data-kind="num">
    <label>${label}</label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}">
    <input type="number" min="${min}" max="${max}" step="${step}" value="${val}">
  </div>`;
}

function exportConfig() {
  const lines = Object.entries(HEAL_TUNE).map(([k, v]) =>
    `  ${k}: ${typeof v === "string" ? `"${v}"` : v},`);
  const snippet = `export const HEAL_TUNE = {\n${lines.join("\n")}\n};`;
  try { navigator.clipboard?.writeText(snippet); } catch {}
  console.log(`${HEAL_TAG} HEAL_TUNE config:\n${snippet}`);
  ui.notifications?.info("Healing tuner: config copied to clipboard (also in console).");
}

const DEFAULTS = { ...HEAL_TUNE };

function resetConfig() {
  Object.assign(HEAL_TUNE, DEFAULTS);
  applyLive();
  // Refresh inputs.
  _panel?.querySelectorAll(".tn-row").forEach((row) => {
    const key = row.dataset.key;
    row.querySelectorAll("input").forEach((inp) => { inp.value = HEAL_TUNE[key]; });
  });
}

function makeDraggable(panel, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("x")) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
    panel.style.right = "auto"; panel.style.left = `${ox}px`; panel.style.top = `${oy}px`;
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panel.style.left = `${ox + e.clientX - sx}px`;
    panel.style.top = `${oy + e.clientY - sy}px`;
  });
  window.addEventListener("pointerup", () => { dragging = false; });
}

export function openHealingTuner() {
  // Ensure the HUD is up so changes are visible.
  if (!HealingHUD.isOpen) HealingHUD.open();
  if (_panel) { _panel.remove(); _panel = null; }

  injectStyles();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="tn-head">❤ Healing Tuner <span class="x" title="Close">✕</span></div>
    <div class="tn-body">
      ${CONTROLS.map(buildRow).join("")}
      <div class="tn-actions">
        <div class="tn-btn copy">Copy config</div>
        <div class="tn-btn reset">Reset</div>
      </div>
    </div>`;
  document.body.appendChild(panel);
  _panel = panel;

  panel.querySelector(".x").addEventListener("click", () => { panel.remove(); _panel = null; });
  panel.querySelector(".copy").addEventListener("click", exportConfig);
  panel.querySelector(".reset").addEventListener("click", resetConfig);

  // Bind inputs.
  panel.querySelectorAll(".tn-row").forEach((row) => {
    const key = row.dataset.key;
    const kind = row.dataset.kind;
    const inputs = [...row.querySelectorAll("input")];
    const onInput = (raw) => {
      HEAL_TUNE[key] = kind === "color" ? String(raw) : Number(raw);
      // Sync the sibling input (range <-> number).
      inputs.forEach((i) => { if (i.value !== String(raw)) i.value = raw; });
      applyLive();
    };
    inputs.forEach((inp) => inp.addEventListener("input", (e) => onInput(e.target.value)));
  });

  makeDraggable(panel, panel.querySelector(".tn-head"));
  return panel;
}
