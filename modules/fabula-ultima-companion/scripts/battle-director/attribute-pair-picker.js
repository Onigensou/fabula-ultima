// Attribute-Pair Picker — director-native overlay.
//
// Used by actions whose Check formula is decided by the GM at fire time
// rather than baked into the actor or skill (Hinder per RAW Core p.71:
// "the Game Master will determine the relevant Attributes based on your
// description"; Objective per p.72; ad-hoc Open Checks).
//
// Always presented on the GM client. In v1 the director IS GM-only, so
// the player asking for a Hinder ends up waiting on the same GM screen
// that already drives the director — a future multi-client revision can
// keep this picker GM-side and surface a "GM is choosing your attributes"
// hint on the player side.
//
// Lifecycle: Map<combatId, record>, same shape as TurnPicker /
// WeaponModePicker. Despawned by Stopped + boot.stop() + preflight.
//
// Returns Promise<{ ok, cancelled, A1, A2 }>.

import { log, warn } from "./logger.js";

const CSS_ID  = "fud-attribute-pair-picker-style";
const ROOT_ID = "fud-attribute-pair-picker-root";

const _overlays = new Map();

const ATTRS = Object.freeze([
  { key: "MIG", label: "MIG", icon: "fa-dumbbell",       hint: "Might"      },
  { key: "DEX", label: "DEX", icon: "fa-person-running", hint: "Dexterity"  },
  { key: "INS", label: "INS", icon: "fa-book",           hint: "Insight"    },
  { key: "WLP", label: "WLP", icon: "fa-comment-dots",   hint: "Willpower"  },
]);

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 96;
      pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    #${ROOT_ID}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    #${ROOT_ID}.is-resolving {
      transform: translate(-50%, -50%) scale(0.96);
      opacity: 0;
      transition: transform 180ms ease-out, opacity 180ms ease-out;
    }

    .fud-app-card {
      pointer-events: auto;
      width: 360px;
      max-width: 92vw;
      padding: 12px 14px 10px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-app-card .fud-app-tag {
      align-self: flex-start;
      display: inline-block;
      font-size: 9.5px; font-weight: 900; letter-spacing: 0.5px;
      color: var(--fud-stroke, #5a6a85);
      padding: 2px 8px;
      border: 1px solid var(--fud-stroke, #5a6a85);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.45);
      margin-bottom: 4px;
    }
    .fud-app-card .fud-app-title {
      font-size: 14px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #5a6a85);
      margin-bottom: 8px;
    }
    .fud-app-card .fud-app-hint {
      font-size: 11px; text-align: center; opacity: 0.85;
      margin-bottom: 8px; line-height: 1.4;
    }
    .fud-app-card .fud-app-row {
      display: flex; flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .fud-app-card .fud-app-row-label {
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;
      color: var(--fud-ink-soft, #4b4338);
      padding-left: 2px;
    }
    .fud-app-card .fud-app-attr-buttons {
      display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 5px;
    }
    .fud-app-card .fud-app-attr-btn {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 8px 4px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      background: linear-gradient(180deg, #f7ecd9, #e7d8b6);
      color: var(--fud-ink, #3a3228);
      cursor: pointer; user-select: none;
      font-weight: 800; letter-spacing: 0.32px;
      font-size: 12px;
      box-shadow: 0 2px 0 var(--fud-shadow, rgba(24,28,41,0.55));
      transition: transform 80ms ease, filter 80ms ease, background 100ms ease, border-color 100ms ease;
    }
    .fud-app-card .fud-app-attr-btn i.fa-solid {
      font-size: 14px;
      margin-bottom: 3px;
      opacity: 0.78;
    }
    .fud-app-card .fud-app-attr-btn:hover { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-app-card .fud-app-attr-btn:active { transform: translateY(0); }
    .fud-app-card .fud-app-attr-btn.is-selected {
      background: linear-gradient(180deg, var(--fud-gold-1, #a8c4d8), var(--fud-gold-2, #7a9bb6));
      color: #221b14;
      border-color: var(--fud-stroke, #5a6a85);
      box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.45) inset,
        0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55));
    }

    /* Difficulty Level input row (optional via includeDL). The DL is a
       single integer; we expose ±1 buttons + a preset chip row so the GM
       can mouse-only pick the common Fabula thresholds (5/7/10/13/16/20)
       without touching the number field directly. Number input still
       accepts typing for any custom value. */
    .fud-app-card .fud-app-dl-row {
      display: flex; flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }
    .fud-app-card .fud-app-dl-input-wrap {
      display: flex; align-items: center; gap: 6px;
      justify-content: center;
    }
    .fud-app-card .fud-app-dl-step {
      width: 28px; height: 28px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      background: linear-gradient(180deg, #f7ecd9, #e7d8b6);
      color: var(--fud-ink, #3a3228);
      font-weight: 900; font-size: 14px; line-height: 1;
      cursor: pointer; user-select: none;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 0 var(--fud-shadow, rgba(24,28,41,0.55));
      transition: filter 80ms ease, transform 80ms ease;
    }
    .fud-app-card .fud-app-dl-step:hover { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-app-card .fud-app-dl-input {
      width: 64px; height: 30px;
      text-align: center;
      font-size: 16px; font-weight: 900;
      border: 2px solid var(--fud-stroke, #5a6a85);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.55);
      color: var(--fud-ink, #3a3228);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
    }
    .fud-app-card .fud-app-dl-input:focus { outline: 2px solid var(--fud-gold-2, #7a9bb6); outline-offset: -1px; }
    .fud-app-card .fud-app-dl-presets {
      display: flex; gap: 4px;
      flex-wrap: wrap; justify-content: center;
    }
    .fud-app-card .fud-app-dl-preset {
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--fud-stroke, #5a6a85);
      background: rgba(255, 255, 255, 0.45);
      color: var(--fud-ink-soft, #4b4338);
      font-size: 10.5px; font-weight: 800;
      cursor: pointer; user-select: none;
      transition: background 80ms ease, color 80ms ease;
    }
    .fud-app-card .fud-app-dl-preset:hover { background: rgba(255, 255, 255, 0.7); }
    .fud-app-card .fud-app-dl-preset.is-selected {
      background: linear-gradient(180deg, var(--fud-gold-1, #a8c4d8), var(--fud-gold-2, #7a9bb6));
      color: #221b14;
    }

    .fud-app-card .fud-app-btn-row {
      display: flex; gap: 8px;
      margin-top: 4px;
    }
    .fud-app-card .fud-app-btn {
      flex: 1;
      padding: 8px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11.5px;
      cursor: pointer; user-select: none; text-align: center;
      box-shadow: 0 3px 0 var(--fud-shadow, rgba(24,28,41,0.55)), 0 0 0 1px rgba(255,255,255,0.5) inset;
      transition: transform 100ms ease, filter 100ms ease;
    }
    .fud-app-card .fud-app-btn.confirm {
      background: linear-gradient(180deg, var(--fud-gold-1, #a8c4d8), var(--fud-gold-2, #7a9bb6));
      color: #221b14;
    }
    .fud-app-card .fud-app-btn.cancel {
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
    }
    .fud-app-card .fud-app-btn:hover { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-app-card .fud-app-btn.is-disabled {
      filter: grayscale(0.6) brightness(0.85);
      opacity: 0.55;
      cursor: not-allowed;
      transform: none !important;
    }
  `;
  document.head.appendChild(css);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// Common Fabula Open Check DL thresholds (RAW Core p.45).
const DL_PRESETS = Object.freeze([5, 7, 10, 13, 16, 20]);

// Open the picker. The caller awaits the chosen configuration.
//   `titleText`   — banner title (e.g. "Hinder Skeleton: pick attribute pair")
//   `subtitle`    — optional explanatory hint (e.g. RAW snippet)
//   `defaults`    — optional { A1, A2 } to preselect; same keys as ATTRS
//   `includeDL`   — when true, also surface a DL input row
//   `defaultDL`   — initial DL value (only meaningful when includeDL)
//
// Returns Promise<{ ok, cancelled, A1, A2, dl? }>.
// `dl` is included only when includeDL was true (clamped to ≥ 1).
// Cancel returns { ok: false, cancelled: true }.
export async function pickAttributePair({
  director,
  titleText = "Pick Attribute Pair",
  subtitle = null,
  defaults = null,
  includeDL = false,
  defaultDL = 10,
} = {}) {
  // No GM gate: attribute-pair picker is client-local.
  ensureStyles();

  // Despawn any prior.
  const prior = _overlays.get(director.combatId);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(director.combatId); }

  const a1Buttons = ATTRS.map((a) => `
    <div class="fud-app-attr-btn ${defaults?.A1 === a.key ? "is-selected" : ""}"
         data-fud-row="1" data-fud-attr="${a.key}"
         role="button" tabindex="0" title="${escapeHtml(a.hint)}">
      <i class="fa-solid ${a.icon}" aria-hidden="true"></i>
      ${a.label}
    </div>
  `).join("");
  const a2Buttons = ATTRS.map((a) => `
    <div class="fud-app-attr-btn ${defaults?.A2 === a.key ? "is-selected" : ""}"
         data-fud-row="2" data-fud-attr="${a.key}"
         role="button" tabindex="0" title="${escapeHtml(a.hint)}">
      <i class="fa-solid ${a.icon}" aria-hidden="true"></i>
      ${a.label}
    </div>
  `).join("");

  const initialDL = Math.max(1, Number(defaultDL) || 10);
  const dlRowHTML = includeDL ? `
    <div class="fud-app-row fud-app-dl-row">
      <div class="fud-app-row-label">Difficulty Level</div>
      <div class="fud-app-dl-input-wrap">
        <div class="fud-app-dl-step" data-fud-dl-step="-1" role="button" tabindex="0" title="Decrease DL">−</div>
        <input type="number" min="1" step="1" value="${initialDL}" class="fud-app-dl-input" data-fud-dl-input="1" aria-label="Difficulty Level">
        <div class="fud-app-dl-step" data-fud-dl-step="1" role="button" tabindex="0" title="Increase DL">+</div>
      </div>
      <div class="fud-app-dl-presets">
        ${DL_PRESETS.map((n) => `<div class="fud-app-dl-preset ${n === initialDL ? "is-selected" : ""}" data-fud-dl-preset="${n}" role="button" tabindex="0">${n}</div>`).join("")}
      </div>
    </div>
  ` : "";

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-app-card" role="dialog" aria-label="Attribute Pair">
      <div class="fud-app-tag">GM: CONFIGURE CHECK</div>
      <div class="fud-app-title">${escapeHtml(titleText)}</div>
      ${subtitle ? `<div class="fud-app-hint">${subtitle}</div>` : ""}
      <div class="fud-app-row">
        <div class="fud-app-row-label">First Attribute</div>
        <div class="fud-app-attr-buttons" data-fud-row-host="1">
          ${a1Buttons}
        </div>
      </div>
      <div class="fud-app-row">
        <div class="fud-app-row-label">Second Attribute</div>
        <div class="fud-app-attr-buttons" data-fud-row-host="2">
          ${a2Buttons}
        </div>
      </div>
      ${dlRowHTML}
      <div class="fud-app-btn-row">
        <div class="fud-app-btn cancel" data-fud-action="cancel" role="button" tabindex="0">Cancel</div>
        <div class="fud-app-btn confirm is-disabled" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  log("AttributePairPicker spawned", titleText);

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;
    let keyListener = null;

    const selected = {
      A1: defaults?.A1 ?? null,
      A2: defaults?.A2 ?? null,
      dl: initialDL,
    };
    const confirmBtn = root.querySelector(".fud-app-btn.confirm");
    const dlInput = root.querySelector('[data-fud-dl-input="1"]');

    function refreshConfirmEnabled() {
      const dlOk = !includeDL || (Number.isFinite(Number(selected.dl)) && Number(selected.dl) >= 1);
      if (selected.A1 && selected.A2 && dlOk) confirmBtn.classList.remove("is-disabled");
      else confirmBtn.classList.add("is-disabled");
    }
    refreshConfirmEnabled();

    function setRow(row, attrKey) {
      const host = root.querySelector(`[data-fud-row-host="${row}"]`);
      if (!host) return;
      for (const b of host.querySelectorAll(".fud-app-attr-btn")) {
        if (b.dataset.fudAttr === attrKey) b.classList.add("is-selected");
        else b.classList.remove("is-selected");
      }
      selected[row === 1 ? "A1" : "A2"] = attrKey;
      refreshConfirmEnabled();
    }

    function setDL(value, source) {
      const n = Math.max(1, Math.floor(Number(value) || 0));
      selected.dl = n;
      if (dlInput && source !== "input") dlInput.value = String(n);
      // Highlight the matching preset chip; clear any other selected chip.
      for (const chip of root.querySelectorAll(".fud-app-dl-preset")) {
        const v = Number(chip.dataset.fudDlPreset);
        if (v === n) chip.classList.add("is-selected");
        else chip.classList.remove("is-selected");
      }
      refreshConfirmEnabled();
    }

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => {
        try { root.remove(); } catch {}
        _overlays.delete(director.combatId);
      }, 200);
      if (keyListener) {
        try { window.removeEventListener("keydown", keyListener, true); } catch {}
        keyListener = null;
      }
      resolve(result);
    };

    const buildResult = (ok) => {
      const out = ok
        ? { ok: true, cancelled: false, A1: selected.A1, A2: selected.A2 }
        : { ok: false, cancelled: true };
      if (ok && includeDL) out.dl = Math.max(1, Number(selected.dl) || 1);
      return out;
    };

    const onClick = (ev) => {
      const attrBtn = ev.target?.closest?.(".fud-app-attr-btn");
      if (attrBtn) {
        ev.stopPropagation();
        const row = Number(attrBtn.dataset.fudRow);
        const attr = attrBtn.dataset.fudAttr;
        if (row && attr) setRow(row, attr);
        return;
      }
      const dlStep = ev.target?.closest?.("[data-fud-dl-step]");
      if (dlStep) {
        ev.stopPropagation();
        const delta = Number(dlStep.dataset.fudDlStep) || 0;
        setDL((Number(selected.dl) || initialDL) + delta);
        return;
      }
      const dlPreset = ev.target?.closest?.("[data-fud-dl-preset]");
      if (dlPreset) {
        ev.stopPropagation();
        setDL(Number(dlPreset.dataset.fudDlPreset));
        return;
      }
      const actionBtn = ev.target?.closest?.("[data-fud-action]");
      if (!actionBtn) return;
      ev.stopPropagation();
      const action = actionBtn.dataset.fudAction;
      if (action === "cancel") {
        finish(buildResult(false));
      } else if (action === "confirm") {
        if (actionBtn.classList.contains("is-disabled")) {
          ui.notifications?.warn(includeDL
            ? "Pick one attribute from each row, and a Difficulty Level."
            : "Pick one attribute from each row.");
          return;
        }
        finish(buildResult(true));
      }
    };
    root.addEventListener("click", onClick);

    // Live-edit the DL input field as the GM types; commits each change
    // through setDL() so the preset chips stay in sync.
    if (dlInput) {
      dlInput.addEventListener("input", (ev) => {
        ev.stopPropagation();
        setDL(dlInput.value, "input");
      });
    }

    keyListener = (ev) => {
      if (resolved) return;
      // Don't steal Enter/Esc while the DL input is focused — the GM might
      // be typing a custom value.
      if (document.activeElement === dlInput) return;
      if (ev.key === "Escape") { ev.preventDefault(); finish(buildResult(false)); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        if (selected.A1 && selected.A2) finish(buildResult(true));
      }
    };
    window.addEventListener("keydown", keyListener, true);

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(director.combatId);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, cancelled: true });
      }
    };

    _overlays.set(director.combatId, { cleanup, root });
  });
}

export const AttributePairPicker = {
  despawn({ director }) {
    const rec = _overlays.get(director.combatId);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(director.combatId);
  },
  despawnAll() {
    for (const rec of _overlays.values()) {
      try { rec.cleanup(); } catch {}
    }
    _overlays.clear();
  },
};
