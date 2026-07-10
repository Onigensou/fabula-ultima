// ============================================================================
// Ritual System — live tuner for the "Offer Material" button.
//
//     FUCompanion.api.ritual.tuner.material()
//
// Every knob is a CSS custom property that ritual-hud-styles.js reads with an
// inline fallback and never declares. The tuner writes them onto
// document.documentElement, where they are inherited by the button — an
// inherited root variable only wins because no closer rule declares one. That
// is the whole mechanism; there is no !important anywhere.
//
// Values persist in localStorage and are re-applied on every boot, so a look
// you settle on survives a reload without touching the source. "Copy CSS"
// prints the delta from the defaults, ready to paste back into the stylesheet
// as the new baseline.
//
// This is a tuning tool, not a settings UI: it is local to the operator, GM or
// not, and it never writes to the world.
// ============================================================================

import { RITUAL_TAG, RITUAL_MATERIAL_ICON } from "./ritual-const.js";
import { injectRitualStyles } from "./ritual-hud-styles.js";

const STORE_KEY = "oni.ritual.matTune";
const STYLE_ID = "oni-ritual-mat-tuner-styles";

// name → { label, type, default, min, max, step, unit }
// `default` MUST mirror the fallback in ritual-hud-styles.js, or "Reset" would
// silently move the button somewhere the stylesheet never puts it.
const KNOBS = [
  { k: "--rm-fill-1",  label: "Fill (top)",      type: "color",  def: "#7d3428" },
  { k: "--rm-fill-2",  label: "Fill (bottom)",   type: "color",  def: "#57231b" },
  { k: "--rm-border",  label: "Border",          type: "color",  def: "#ffd84d" },
  { k: "--rm-lip",     label: "Bottom lip",      type: "color",  def: "#3a1712" },
  { k: "--rm-text",    label: "Label",           type: "color",  def: "#3b2a19" },
  { k: "--rm-stroke",  label: "Label stroke",    type: "color",  def: "#ffe14d" },
  { k: "--rm-glow-c1", label: "Glow (inner)",    type: "color",  def: "#ffe14d" },
  { k: "--rm-glow-c2", label: "Glow (outer)",    type: "color",  def: "#ffd84d" },

  // "Outline" is the width VISIBLE OUTSIDE the glyph. The stylesheet doubles it,
  // because the fill hides the inner half of the stroke it is drawn from.
  { k: "--rm-stroke-w", label: "Outline (outer)", type: "range", def: 1,    min: 0,  max: 3,  step: 0.05, unit: "px" },
  { k: "--rm-fat",      label: "Glyph fatten",   type: "range",  def: 0,    min: 0,  max: 1.5, step: 0.05, unit: "px" },
  { k: "--rm-glow-1",   label: "Glow inner blur",type: "range",  def: 2,    min: 0,  max: 20, step: 1,    unit: "px" },
  { k: "--rm-glow-2",   label: "Glow outer blur",type: "range",  def: 11,   min: 0,  max: 40, step: 1,    unit: "px" },
  { k: "--rm-weight",   label: "Font weight",    type: "range",  def: 500,  min: 400, max: 900, step: 100 },
  { k: "--rm-size",     label: "Font size",      type: "range",  def: 14.5, min: 9,  max: 26, step: 0.5,  unit: "px" },
  { k: "--rm-letter",   label: "Letter spacing", type: "range",  def: 0.3,  min: -1, max: 3,  step: 0.1,  unit: "px" },
  { k: "--rm-pad-x",    label: "Padding X",      type: "range",  def: 14,   min: 0,  max: 40, step: 1,    unit: "px" },
  { k: "--rm-pad-y",    label: "Padding Y",      type: "range",  def: 6,    min: 0,  max: 24, step: 1,    unit: "px" },
  { k: "--rm-min-h",    label: "Min height",     type: "range",  def: 36,   min: 24, max: 64, step: 1,    unit: "px" },
  { k: "--rm-radius",   label: "Corner radius",  type: "range",  def: 9,    min: 0,  max: 24, step: 1,    unit: "px" },
  { k: "--rm-border-w", label: "Border width",   type: "range",  def: 2,    min: 0,  max: 6,  step: 0.5,  unit: "px" },
  { k: "--rm-icon",     label: "Icon size",      type: "range",  def: 22,   min: 0,  max: 44, step: 1,    unit: "px" },
  { k: "--rm-gap",      label: "Icon gap",       type: "range",  def: 8,    min: 0,  max: 24, step: 1,    unit: "px" },
];

const byKey = Object.fromEntries(KNOBS.map((k) => [k.k, k]));

/** The glow colours are authored as rgba() but tuned as hex — keep both usable. */
function toCssValue(knob, raw) {
  if (knob.type === "color") return raw;
  return `${raw}${knob.unit ?? ""}`;
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); }
  catch { return {}; }
}
function save(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

function applyOne(key, raw) {
  const knob = byKey[key];
  if (!knob) return;
  document.documentElement.style.setProperty(key, toCssValue(knob, raw));
}

/** Re-apply a saved look. Called once on ready, before any window opens. */
export function applyStoredMatTuning() {
  const state = load();
  for (const [k, v] of Object.entries(state)) applyOne(k, v);
  if (Object.keys(state).length) console.debug(RITUAL_TAG, "material button tuning restored", state);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#oni-rmt {
  position: fixed; top: 70px; right: 24px; z-index: 2147483000;
  width: 310px; max-height: 78vh; display: flex; flex-direction: column;
  background: linear-gradient(180deg, #f6ebd3, #efdfc3);
  border: 3px solid #8d5f38; border-radius: 10px; color: #3b2a19;
  box-shadow: 0 14px 40px rgba(0,0,0,.5);
  font-family: "Signika", sans-serif; font-size: 12px;
}
#oni-rmt img { border: 0 !important; outline: 0 !important; box-shadow: none !important; background: none !important; }
#oni-rmt .rmt-head {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: move;
  background: linear-gradient(180deg, #a87649, #6f4526); color: #f6ebd3;
  border-radius: 6px 6px 0 0; border-bottom: 2px solid #9a7a2b;
}
#oni-rmt .rmt-head .t { font-weight: 700; font-size: 13px; }
#oni-rmt .rmt-x { margin-left: auto; cursor: pointer; opacity: .85; }
#oni-rmt .rmt-preview {
  display: flex; align-items: center; justify-content: center; padding: 12px;
  background: rgba(0,0,0,.10); border-bottom: 1px solid #caa44d;
}
#oni-rmt .rmt-body { overflow-y: auto; padding: 8px 10px; }
#oni-rmt .rmt-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
#oni-rmt .rmt-row label { flex: 0 0 104px; opacity: .85; }
#oni-rmt .rmt-row input[type=range] { flex: 1; min-width: 0; }
#oni-rmt .rmt-row input[type=color] { width: 42px; height: 20px; padding: 0; border: 1px solid #9a7a2b; background: none; }
#oni-rmt .rmt-row .v { flex: 0 0 46px; text-align: right; font-variant-numeric: tabular-nums; opacity: .8; }
#oni-rmt .rmt-foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #caa44d; }
#oni-rmt .rmt-foot button { flex: 1; width: auto; padding: 5px 8px; cursor: pointer; font-weight: 700;
  border: 2px solid #6f4526; border-radius: 6px; background: linear-gradient(180deg,#f4d488,#caa44d); color: #6f4526; }
#oni-rmt .rmt-foot button.ghost { background: #e7d3b1; }
#oni-rmt .rmt-note { padding: 0 10px 8px; opacity: .7; font-size: 11px; }
`;
  document.head.appendChild(s);
}

function makeDraggable(panel, handle) {
  let dx = 0, dy = 0, dragging = false;
  handle.addEventListener("pointerdown", (ev) => {
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = ev.clientX - r.left; dy = ev.clientY - r.top;
    handle.setPointerCapture(ev.pointerId);
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    panel.style.left = `${ev.clientX - dx}px`;
    panel.style.top = `${ev.clientY - dy}px`;
    panel.style.right = "auto";
  });
  handle.addEventListener("pointerup", (ev) => { dragging = false; handle.releasePointerCapture(ev.pointerId); });
}

/** Only the knobs that differ from the stylesheet's fallbacks. */
function cssDelta(state) {
  const lines = [];
  for (const knob of KNOBS) {
    const v = state[knob.k];
    if (v === undefined || String(v) === String(knob.def)) continue;
    lines.push(`  ${knob.k}: ${toCssValue(knob, v)};`);
  }
  if (!lines.length) return "/* Offer Material: unchanged from the defaults. */";
  return `:root {\n${lines.join("\n")}\n}`;
}

export function openMatTuner() {
  document.getElementById("oni-rmt")?.remove();
  injectStyles();
  // The preview button needs the window's stylesheet, which is otherwise only
  // injected when the ritual window first opens.
  injectRitualStyles();

  const state = load();
  const valueOf = (knob) => (state[knob.k] !== undefined ? state[knob.k] : knob.def);

  const panel = document.createElement("div");
  panel.id = "oni-rmt";
  panel.innerHTML = `
    <div class="rmt-head"><span class="t">Offer Material — Tuner</span><span class="rmt-x" title="Close">✕</span></div>
    <div class="rmt-preview">
      <button class="oni-ritual-mat" data-preview>
        <img class="mat-crystal" src="${RITUAL_MATERIAL_ICON}" />
        <span data-text="Offer Material">Offer Material</span>
      </button>
    </div>
    <div class="rmt-body">
      ${KNOBS.map((knob) => {
        const v = valueOf(knob);
        if (knob.type === "color") {
          return `<div class="rmt-row"><label>${knob.label}</label>
            <input type="color" data-k="${knob.k}" value="${v}" />
            <span class="v" data-v="${knob.k}">${v}</span></div>`;
        }
        return `<div class="rmt-row"><label>${knob.label}</label>
          <input type="range" data-k="${knob.k}" min="${knob.min}" max="${knob.max}" step="${knob.step}" value="${v}" />
          <span class="v" data-v="${knob.k}">${v}${knob.unit ?? ""}</span></div>`;
      }).join("")}
    </div>
    <div class="rmt-note">Live on the real button. Saved locally; survives reload.</div>
    <div class="rmt-foot">
      <button data-act="copy">Copy CSS</button>
      <button class="ghost" data-act="reset">Reset</button>
    </div>`;
  document.body.appendChild(panel);
  makeDraggable(panel, panel.querySelector(".rmt-head"));

  // The preview button is a real .oni-ritual-mat, so it inherits the same root
  // variables — what you see here is exactly what the window will render.
  const paint = (knob, raw) => {
    state[knob.k] = raw;
    applyOne(knob.k, raw);
    panel.querySelector(`[data-v="${knob.k}"]`).textContent = `${raw}${knob.type === "color" ? "" : (knob.unit ?? "")}`;
    save(state);
  };

  for (const input of panel.querySelectorAll("[data-k]")) {
    const knob = byKey[input.dataset.k];
    input.addEventListener("input", () => paint(knob, input.value));
  }

  panel.querySelector(".rmt-x").addEventListener("click", () => panel.remove());
  panel.querySelector('[data-act="reset"]').addEventListener("click", () => {
    for (const knob of KNOBS) document.documentElement.style.removeProperty(knob.k);
    localStorage.removeItem(STORE_KEY);
    panel.remove();
    openMatTuner();
    ui.notifications?.info("Offer Material: reset to stylesheet defaults.");
  });
  panel.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    const css = cssDelta(state);
    try { await navigator.clipboard.writeText(css); ui.notifications?.info("Offer Material CSS copied."); }
    catch { ui.notifications?.warn("Clipboard blocked — CSS printed to console."); }
    console.log(`${RITUAL_TAG} Offer Material tuning:\n${css}`);
  });

  return panel;
}
