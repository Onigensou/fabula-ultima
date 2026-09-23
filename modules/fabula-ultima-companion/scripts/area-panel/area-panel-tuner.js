// ============================================================================
// Area Name Panel — tuner
// ----------------------------------------------------------------------------
// A GM-only window for tuning the plaque by eye, live, against a real scene.
// Every slider repaints the panel on the spot (CSS variables — see applyVars in
// area-panel.js), so there is no reload cycle between a nudge and seeing it.
//
// Three states worth keeping straight:
//   - the SHIPPED defaults, in TUNING (area-panel-core.js)
//   - the SAVED overrides, in a world setting, which every client reads
//   - the DRAFT in this window, painted but not saved until you press Save
//
// Closing without saving reverts to the saved values, so experimenting is free.
// "Copy constants" gives the block to paste back into TUNING when a look is
// settled for good and should stop living in world data.
//
// Open it from Scene Config (Area Name Panel → Tune appearance) or with
//   FUCompanion.api.areaPanel.tuner()
// ============================================================================

import { TUNABLE, diffFromDefaults, exportSnippet, mergeTuning } from "./area-panel-core.js";

const MODULE_ID = "fabula-ultima-companion";
const ROOT_ID   = "fu-area-tuner";
const STYLE_ID  = "fu-area-tuner-style";
const TAG = "[AreaPanel][Tuner]";

const SAMPLE_DEFAULT = "Eisendrache Kingdom";

// draft = the values this window is painting; null when closed.
let draft = null;
let sample = SAMPLE_DEFAULT;
let held = true;   // keep the plaque on screen while tuning

const api = () => globalThis.FUCompanion?.api?.areaPanel;

// ── style ─────────────────────────────────────────────────────────────────
// Same parchment/wood language as the camp UI, so the tuner does not look like
// a debug console bolted onto the game.

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 90px;
      right: 26px;
      width: 372px;
      max-height: 78vh;
      z-index: 100001;
      display: flex;
      flex-direction: column;
      border: 2.5px solid var(--camp-wood-3, #6f4526);
      border-radius: 12px;
      background: linear-gradient(180deg,
        var(--camp-parchment-1, #f6ebd3) 0%,
        var(--camp-parchment-3, #e7d3b1) 100%);
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
      color: var(--camp-ink, #3b2a19);
      font-family: "Signika", "Noto Sans", sans-serif;
      font-size: 13px;
    }

    #${ROOT_ID} .fu-at-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: move;
      border-bottom: 2px solid var(--camp-wood-3, #6f4526);
      background: linear-gradient(180deg,
        var(--camp-gold-2, #caa44d) 0%,
        var(--camp-gold-3, #9a7a2b) 100%);
      font-weight: 700;
      letter-spacing: .04em;
      border-radius: 9px 9px 0 0;
    }
    #${ROOT_ID} .fu-at-head .fu-at-title { flex: 1 1 auto; }
    #${ROOT_ID} .fu-at-head button {
      flex: 0 0 auto;
      width: 24px; height: 24px; line-height: 1;
      padding: 0;
      border: 1.5px solid var(--camp-wood-3, #6f4526);
      border-radius: 6px;
      background: var(--camp-parchment-1, #f6ebd3);
      color: var(--camp-ink, #3b2a19);
      cursor: pointer;
    }

    #${ROOT_ID} .fu-at-body { overflow-y: auto; padding: 10px 12px 4px; }

    #${ROOT_ID} .fu-at-bar {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 10px;
    }
    #${ROOT_ID} .fu-at-bar input[type="text"] {
      flex: 1 1 auto; min-width: 0;
      height: 26px;
      border: 1.5px solid var(--camp-wood-2, #8d5f38);
      border-radius: 6px;
      background: #fffaf0;
      color: var(--camp-ink, #3b2a19);
      padding: 0 8px;
    }

    #${ROOT_ID} button.fu-at-btn {
      padding: 4px 10px;
      border: 1.5px solid var(--camp-wood-3, #6f4526);
      border-radius: 7px;
      background: linear-gradient(180deg, var(--camp-gold-1, #f4d488), var(--camp-gold-2, #caa44d));
      color: var(--camp-ink, #3b2a19);
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    #${ROOT_ID} button.fu-at-btn:hover { filter: brightness(1.07); }
    #${ROOT_ID} button.fu-at-btn.is-off {
      background: var(--camp-parchment-2, #efdfc3);
      font-weight: 600;
    }

    #${ROOT_ID} .fu-at-group {
      margin: 10px 0 4px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 11px;
      opacity: .75;
      border-bottom: 1px solid rgba(111,69,38,.35);
    }

    #${ROOT_ID} .fu-at-row {
      display: grid;
      grid-template-columns: 116px 1fr 64px;
      align-items: center;
      gap: 7px;
      padding: 3px 0;
    }
    #${ROOT_ID} .fu-at-row > label { font-size: 12px; }
    #${ROOT_ID} .fu-at-row.is-changed > label { font-weight: 700; }
    #${ROOT_ID} .fu-at-row.is-changed > label::after { content: " *"; color: #9a5a1a; }
    #${ROOT_ID} .fu-at-row input[type="range"] { width: 100%; accent-color: var(--camp-wood-2, #8d5f38); }
    #${ROOT_ID} .fu-at-row input[type="number"] {
      width: 100%;
      height: 24px;
      border: 1.5px solid var(--camp-wood-2, #8d5f38);
      border-radius: 5px;
      background: #fffaf0;
      color: var(--camp-ink, #3b2a19);
      padding: 0 4px;
      font-size: 12px;
    }
    #${ROOT_ID} .fu-at-hint {
      grid-column: 1 / -1;
      margin: -2px 0 2px;
      font-size: 11px;
      opacity: .7;
    }

    #${ROOT_ID} .fu-at-foot {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 8px 12px 10px;
      border-top: 2px solid var(--camp-wood-3, #6f4526);
    }
    #${ROOT_ID} textarea.fu-at-snippet {
      width: 100%;
      height: 108px;
      margin-top: 6px;
      border: 1.5px solid var(--camp-wood-2, #8d5f38);
      border-radius: 6px;
      background: #fffaf0;
      color: var(--camp-ink, #3b2a19);
      font-family: "Consolas", "Courier New", monospace;
      font-size: 11px;
      resize: vertical;
      display: none;
    }
    #${ROOT_ID} textarea.fu-at-snippet.is-open { display: block; }
  `;
  document.head.appendChild(style);
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Repaint the plaque from the draft.
 *
 * A held plaque is already sitting at rest, and every look knob is a CSS
 * variable, so a drag updates it in place — re-running the slide on each input
 * event would strobe it. Only an explicit `replay` (or a hold with nothing on
 * screen) fires the animation again.
 */
function paint({ replay = false } = {}) {
  const a = api();
  if (!a) return;
  a.applyPreview(draft);

  const el = document.getElementById("fu-area-panel");
  const onScreen = !!el && getComputedStyle(el).visibility === "visible";
  if (replay || (held && !onScreen)) a.preview(sample, { stay: held });
}

function markChanged(root) {
  const changed = diffFromDefaults(draft);
  for (const row of root.querySelectorAll(".fu-at-row[data-key]")) {
    row.classList.toggle("is-changed", row.dataset.key in changed);
  }
}

function syncInputs(root) {
  const merged = mergeTuning(draft);
  for (const field of TUNABLE) {
    const row = root.querySelector(`.fu-at-row[data-key="${field.key}"]`);
    if (!row) continue;
    const v = merged[field.key];
    row.querySelector('input[type="range"]').value = String(v);
    row.querySelector('input[type="number"]').value = String(v);
  }
  markChanged(root);
}

function makeDraggable(root, handle) {
  let startX = 0, startY = 0, baseX = 0, baseY = 0, dragging = false;

  const onMove = (ev) => {
    if (!dragging) return;
    const r = root.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 4, Math.max(4, baseX + ev.clientX - startX));
    const y = Math.min(window.innerHeight - 40, Math.max(4, baseY + ev.clientY - startY));
    root.style.left = `${Math.round(x)}px`;
    root.style.top = `${Math.round(y)}px`;
    root.style.right = "auto";
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    const r = root.getBoundingClientRect();
    dragging = true; startX = ev.clientX; startY = ev.clientY; baseX = r.left; baseY = r.top;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

// ── build ─────────────────────────────────────────────────────────────────

function buildRows(body) {
  let group = null;
  for (const field of TUNABLE) {
    if (field.group !== group) {
      group = field.group;
      const h = document.createElement("div");
      h.className = "fu-at-group";
      h.textContent = group;
      body.appendChild(h);
    }

    const row = document.createElement("div");
    row.className = "fu-at-row";
    row.dataset.key = field.key;

    const label = document.createElement("label");
    label.textContent = `${field.label}${field.unit ? ` (${field.unit})` : ""}`;

    const range = document.createElement("input");
    range.type = "range";
    range.min = String(field.min); range.max = String(field.max); range.step = String(field.step);

    const num = document.createElement("input");
    num.type = "number";
    num.min = String(field.min); num.max = String(field.max); num.step = String(field.step);

    // A timing change cannot be seen on a plaque already sitting at rest, so
    // it re-fires the animation — but only when Hold is off, since a held
    // plaque never reaches the dwell or the exit anyway.
    const commit = (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const clamped = Math.min(field.max, Math.max(field.min, n));
      draft[field.key] = clamped;
      range.value = String(clamped);
      num.value = String(clamped);
      markChanged(document.getElementById(ROOT_ID));
      paint({ replay: field.group === "Timing" && !held });
    };

    range.addEventListener("input", () => commit(range.value));
    num.addEventListener("change", () => commit(num.value));

    row.append(label, range, num);
    body.appendChild(row);

    if (field.hint) {
      const hint = document.createElement("div");
      hint.className = "fu-at-hint";
      hint.textContent = field.hint;
      row.appendChild(hint);
    }
  }
}

function build() {
  ensureStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;

  // Head ------------------------------------------------------------------
  const head = document.createElement("div");
  head.className = "fu-at-head";
  const title = document.createElement("span");
  title.className = "fu-at-title";
  title.textContent = "Area Panel Tuner";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.title = "Close (discards unsaved changes)";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => close());
  head.append(title, closeBtn);

  // Body ------------------------------------------------------------------
  const body = document.createElement("div");
  body.className = "fu-at-body";

  const bar = document.createElement("div");
  bar.className = "fu-at-bar";

  // Debounced: replaying the slide on every keystroke would strobe the plaque.
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = sample;
  nameInput.title = "Sample area name";
  let nameTimer = null;
  const commitName = () => {
    sample = nameInput.value.trim() || SAMPLE_DEFAULT;
    paint({ replay: true });
  };
  nameInput.addEventListener("input", () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(commitName, 450);
  });
  nameInput.addEventListener("change", () => { clearTimeout(nameTimer); commitName(); });

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "fu-at-btn";
  playBtn.textContent = "Play";
  playBtn.title = "Run the full in / hold / out cycle";
  // Play always drops the hold — you cannot watch a dwell on a pinned plaque.
  playBtn.addEventListener("click", () => {
    held = false;
    holdBtn.classList.add("is-off");
    api()?.preview(sample, { stay: false });
  });

  const holdBtn = document.createElement("button");
  holdBtn.type = "button";
  holdBtn.className = "fu-at-btn";
  holdBtn.textContent = "Hold";
  holdBtn.title = "Keep the plaque on screen while you tune";
  holdBtn.addEventListener("click", () => {
    held = !held;
    holdBtn.classList.toggle("is-off", !held);
    if (held) paint({ replay: true });
    else api()?.hide();
  });

  bar.append(nameInput, playBtn, holdBtn);
  body.appendChild(bar);
  buildRows(body);

  // Foot ------------------------------------------------------------------
  const foot = document.createElement("div");
  foot.className = "fu-at-foot";

  const snippet = document.createElement("textarea");
  snippet.className = "fu-at-snippet";
  snippet.readOnly = true;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "fu-at-btn";
  saveBtn.textContent = "Save";
  saveBtn.title = "Store these values for every client";
  saveBtn.addEventListener("click", async () => {
    const ok = await api()?.save(draft);
    if (ok) ui.notifications?.info?.("Area panel tuning saved.");
  });

  const revertBtn = document.createElement("button");
  revertBtn.type = "button";
  revertBtn.className = "fu-at-btn is-off";
  revertBtn.textContent = "Revert";
  revertBtn.title = "Back to the last saved values";
  revertBtn.addEventListener("click", () => {
    draft = api()?.saved() ?? {};
    syncInputs(root);
    paint({ replay: true });
  });

  const defaultsBtn = document.createElement("button");
  defaultsBtn.type = "button";
  defaultsBtn.className = "fu-at-btn is-off";
  defaultsBtn.textContent = "Defaults";
  defaultsBtn.title = "Back to the values shipped in the code (not saved until you press Save)";
  defaultsBtn.addEventListener("click", () => {
    draft = {};
    syncInputs(root);
    paint({ replay: true });
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "fu-at-btn is-off";
  copyBtn.textContent = "Copy constants";
  copyBtn.title = "The TUNING block to paste into area-panel-core.js";
  copyBtn.addEventListener("click", async () => {
    const text = exportSnippet(draft);
    snippet.value = text;
    snippet.classList.add("is-open");
    snippet.select?.();
    try { await navigator.clipboard.writeText(text); ui.notifications?.info?.("Constants copied to clipboard."); }
    catch (_e) { ui.notifications?.warn?.("Clipboard blocked — copy from the box below."); }
    console.log(`${TAG} constants:\n${text}`);
  });

  foot.append(saveBtn, revertBtn, defaultsBtn, copyBtn, snippet);

  root.append(head, body, foot);
  document.body.appendChild(root);
  makeDraggable(root, head);
  syncInputs(root);
  return root;
}

// ── open / close ──────────────────────────────────────────────────────────

export function open() {
  if (!game.user?.isGM) { ui.notifications?.warn?.("The area panel tuner is GM only."); return null; }
  const existing = document.getElementById(ROOT_ID);
  if (existing) { existing.style.display = ""; return existing; }

  draft = api()?.saved() ?? {};
  held = true;
  const root = build();
  paint({ replay: true });
  return root;
}

/** Close and put the panel back on whatever is SAVED — the draft is dropped. */
export function close() {
  const root = document.getElementById(ROOT_ID);
  if (root) root.remove();
  draft = null;
  const a = api();
  a?.hide();
  a?.refresh();
}

export function isOpen() { return !!document.getElementById(ROOT_ID); }

Hooks.once("ready", () => {
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.areaPanelTuner = { open, close, isOpen };
});
