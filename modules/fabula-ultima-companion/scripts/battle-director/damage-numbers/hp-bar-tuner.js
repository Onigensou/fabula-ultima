// HP Bar Tuner — in-game panel for fine-tuning the transient NPC HP bar look.
//
// GM-facing dev tool (Developer Tools launcher → "HP bar tuner"). Sliders for
// the world-scoped tuning knobs (position / height / width / roundness /
// scale); every input change live-previews on the selected token, Save writes
// the world setting (all clients render with it from the next hit — the bar
// module reads the setting fresh on every spawn, no reload needed).
//
// Preview is LOCAL-ONLY (renderNpcHpBarLocal, no broadcast) and clears live
// bars first so each preview SPAWNS with the newest geometry instead of
// retargeting one built from the old values.
//
// Not a manifest entry: imported by director-boot.js + initialised on its
// ready hook — loads on a normal hard-reload, no relaunch.

import { log, warn } from "../logger.js";
import { registerDevTool } from "../dev-tools-menu.js";
import {
  TUNING_SETTING,
  TUNING_DEFAULTS,
  getBarTuning,
  renderNpcHpBarLocal,
  clearNpcHpBars,
} from "./director-hp-bar.js";

const MODULE_ID = "fabula-ultima-companion";
const PANEL_ID = "fud-hpbar-tuner-panel";
const STYLE_ID = "fud-hpbar-tuner-style";

// knob → slider range/step + label. Order = panel order.
const KNOBS = [
  { key: "offsetX",    label: "Position X (px)",  min: -200, max: 200, step: 1 },
  { key: "offsetY",    label: "Position Y (px)",  min: -200, max: 200, step: 1 },
  { key: "height",     label: "Bar height (px)",  min: 3,    max: 32,  step: 1 },
  { key: "widthScale", label: "Bar width (×token)", min: 0.3, max: 2.5, step: 0.05 },
  { key: "radius",     label: "Corner roundness (px)", min: 0, max: 40, step: 1 },
  { key: "scale",      label: "Overall scale (×)", min: 0.5,  max: 2,   step: 0.05 },
];

let _booted = false;
let _draft = null; // unsaved knob values while the panel is open

function targetTokenUuid() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const tok = controlled[0] ?? canvas?.tokens?.placeables?.[0] ?? null;
  return tok?.document?.uuid ?? null;
}

// Local-only preview with the DRAFT (unsaved) values. The bar module reads
// getBarTuning() → game.settings at spawn, and we must NOT write the world
// setting per slider tick (that spams the DB and every client). So the draft
// is injected by patching game.settings.get for the duration of the
// SYNCHRONOUS spawn call only, restored in `finally` — nothing else can
// observe the patch.
function previewWithDraft() {
  const t = targetTokenUuid();
  if (!t) { ui.notifications?.warn("HP bar tuner: no token on canvas to preview on."); return; }
  clearNpcHpBars();
  const origGet = game.settings.get;
  game.settings.get = function (ns, key, ...rest) {
    if (ns === MODULE_ID && key === TUNING_SETTING) return { ..._draft };
    return origGet.call(this, ns, key, ...rest);
  };
  try {
    // Loss crossing Crisis: shows ghost, drain, and the green→yellow shift.
    renderNpcHpBarLocal({ tokenUuid: t, fromFrac: 0.8, toFrac: 0.45 });
  } finally {
    game.settings.get = origGet;
  }
}

async function saveDraft() {
  try {
    await game.settings.set(MODULE_ID, TUNING_SETTING, { ..._draft });
    ui.notifications?.info("HP bar tuning saved — live for all clients on the next hit.");
    log("hp-bar-tuner: saved", _draft);
  } catch (e) {
    warn("hp-bar-tuner: save failed", e);
    ui.notifications?.error("HP bar tuning save failed (GM only) — see console.");
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; left: 70px; bottom: 70px; z-index: 100003;
  width: 280px; padding: 12px; border-radius: 10px;
  background: rgba(18, 22, 26, .96); border: 1px solid rgba(120, 220, 160, .25);
  box-shadow: 0 10px 30px rgba(0,0,0,.5); color: #e7f0ea;
  font-family: "Inter","Segoe UI",system-ui,sans-serif;
}
#${PANEL_ID} h4 { margin: 0 0 6px; font-size: 13px; letter-spacing: .3px; }
#${PANEL_ID} .fud-hpt-hint { font-size: 10px; opacity: .72; margin-bottom: 10px; line-height: 1.35; }
#${PANEL_ID} .fud-hpt-row { margin: 7px 0; }
#${PANEL_ID} label { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 2px; }
#${PANEL_ID} label b { font-weight: 600; opacity: .9; }
#${PANEL_ID} label span { opacity: .85; font-variant-numeric: tabular-nums; }
#${PANEL_ID} input[type=range] { width: 100%; }
#${PANEL_ID} .fud-hpt-buttons { display: flex; gap: 6px; margin-top: 10px; }
#${PANEL_ID} button {
  flex: 1; padding: 6px 8px; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
  color: #e7f0ea; font-size: 12px;
}
#${PANEL_ID} button:hover { background: rgba(120,220,160,.18); }
#${PANEL_ID} button.fud-hpt-save { border-color: rgba(120,220,160,.5); }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function fmt(v, step) {
  return step < 1 ? Number(v).toFixed(2) : String(Math.round(v));
}

function togglePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) { existing.remove(); _draft = null; return; }
  ensureStyle();
  _draft = { ...getBarTuning() };

  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const h = document.createElement("h4");
  h.textContent = "📏 HP Bar Tuner";
  panel.appendChild(h);

  const hint = document.createElement("div");
  hint.className = "fud-hpt-hint";
  hint.textContent = "Select a token, drag a slider — every change previews locally on it. Save writes the world setting (all clients, next hit). Values persist until you Save; closing the panel discards the draft.";
  panel.appendChild(hint);

  const valueEls = {};
  for (const k of KNOBS) {
    const row = document.createElement("div");
    row.className = "fud-hpt-row";
    const label = document.createElement("label");
    const name = document.createElement("b");
    name.textContent = k.label;
    const val = document.createElement("span");
    val.textContent = fmt(_draft[k.key], k.step);
    valueEls[k.key] = val;
    label.appendChild(name);
    label.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(k.min);
    input.max = String(k.max);
    input.step = String(k.step);
    input.value = String(_draft[k.key]);
    input.addEventListener("input", () => {
      _draft[k.key] = Number(input.value);
      val.textContent = fmt(_draft[k.key], k.step);
      previewWithDraft();
    });
    row.appendChild(label);
    row.appendChild(input);
    panel.appendChild(row);
    k._input = input; // for Reset to sync sliders
  }

  const buttons = document.createElement("div");
  buttons.className = "fud-hpt-buttons";

  const preview = document.createElement("button");
  preview.textContent = "Preview";
  preview.addEventListener("click", () => previewWithDraft());

  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    _draft = { ...TUNING_DEFAULTS };
    for (const k of KNOBS) {
      k._input.value = String(_draft[k.key]);
      valueEls[k.key].textContent = fmt(_draft[k.key], k.step);
    }
    previewWithDraft();
  });

  const save = document.createElement("button");
  save.className = "fud-hpt-save";
  save.textContent = "Save";
  save.addEventListener("click", () => saveDraft());

  buttons.appendChild(preview);
  buttons.appendChild(reset);
  buttons.appendChild(save);
  panel.appendChild(buttons);

  document.body.appendChild(panel);
  previewWithDraft();
}

export function initHpBarTuner() {
  if (_booted) return;
  try {
    registerDevTool({ id: "hp-bar-tuner", icon: "📏", label: "HP bar tuner", onClick: togglePanel });
    _booted = true;
    log("hp-bar-tuner: registered as dev tool");
  } catch (e) {
    warn("initHpBarTuner threw", e);
  }
}
