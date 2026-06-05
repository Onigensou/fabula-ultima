// Option Picker — director-native overlay for `open_action_menu`.
//
// A minimal parchment overlay that shows a title + a list of clickable
// options. Used by the `open_action_menu` effect_kind to pause an effect
// chain, ask the GM/player to choose between inline-defined options, and
// resume with the chosen option's effect.
//
// Style cousin of skill-picker.js but stripped down — no icons, no cost
// badges, no section grouping. Each option is just a parchment row with
// a bold label + optional sub-description text.
//
// Returns a Promise resolving to `{ index, option } | null` (null on
// Escape / cancel).

import { log, warn } from "./logger.js";

const CSS_ID  = "fud-option-picker-style";
const ROOT_ID = "fud-option-picker-root";

const _overlays = new Map();
let _spawnSeq = 0;  // multiple picks may stack mid-chain; key overlays uniquely

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    .fud-opt-picker-root {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 97;
      pointer-events: none;
      transition: transform 180ms cubic-bezier(.2,.7,.2,1), opacity 180ms ease-out;
    }
    .fud-opt-picker-root.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    .fud-opt-picker-root.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; transition: transform 160ms ease-out, opacity 160ms ease-out; }

    .fud-opt-picker-card {
      pointer-events: auto;
      width: 380px;
      max-width: 90vw;
      max-height: 70vh;
      display: flex; flex-direction: column;
      padding: 12px 14px 12px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-opt-picker-title {
      font-size: 13.5px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
      margin-bottom: 8px;
    }
    .fud-opt-picker-subtitle {
      font-size: 11px;
      text-align: center;
      color: var(--fud-ink-soft, #4b4338);
      opacity: 0.85;
      margin-bottom: 8px;
    }
    .fud-opt-picker-list {
      display: flex; flex-direction: column; gap: 4px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .fud-opt-picker-row {
      display: flex; flex-direction: column;
      gap: 2px;
      padding: 8px 12px;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      user-select: none;
      transition: background-color 100ms ease, transform 80ms ease, filter 100ms ease;
    }
    .fud-opt-picker-row:hover {
      background: rgba(255, 255, 255, 0.85);
      transform: translateY(-1px);
      filter: brightness(1.04);
    }
    .fud-opt-picker-row:active { transform: translateY(0); }
    .fud-opt-picker-row .fud-opt-picker-label {
      font-size: 13px;
      font-weight: 800;
      color: var(--fud-ink, #3a3228);
    }
    .fud-opt-picker-row .fud-opt-picker-desc {
      font-size: 10.5px;
      opacity: 0.75;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-opt-picker-row .fud-opt-picker-num {
      display: inline-block;
      min-width: 16px;
      font-size: 10px;
      font-weight: 900;
      color: var(--fud-stroke, #7a6a55);
      margin-right: 5px;
      opacity: 0.7;
    }
    .fud-opt-picker-cancel {
      align-self: center;
      margin-top: 10px;
      padding: 6px 14px;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.55);
      color: var(--fud-ink, #3a3228);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      user-select: none;
      transition: background-color 100ms ease;
    }
    .fud-opt-picker-cancel:hover { background: rgba(255, 255, 255, 0.85); }
  `;
  document.head.appendChild(css);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// Show the picker. Returns a Promise of { index, option } or null.
//
// `options` is an array; each entry is whatever the caller passes —
// the picker just reads `.label` (required) and `.description` (optional)
// for display. The caller decides what to do with the rest.
//
// Number-key shortcuts (1..9) select the Nth option for quick play.
// Escape cancels (returns null). Click outside the card does NOT cancel
// (would conflict with mid-action card chains — only explicit Cancel
// resolves null).
export async function pickOption({
  title = "Choose an option",
  subtitle = null,
  options = [],
  cancelLabel = "Cancel",
  director = null,
} = {}) {
  if (!Array.isArray(options) || !options.length) {
    warn("option-picker: no options provided — auto-cancelling");
    return null;
  }
  // No GM gate: option picker is client-local.
  ensureStyles();

  const overlayId = ++_spawnSeq;
  const root = document.createElement("div");
  root.className = "fud-opt-picker-root";
  root.id = `${ROOT_ID}-${overlayId}`;

  const rowsHTML = options.map((opt, i) => {
    const label = escapeHtml(opt.label ?? `Option ${i + 1}`);
    const desc = opt.description ? escapeHtml(opt.description) : "";
    const numHint = i < 9 ? `<span class="fud-opt-picker-num">${i + 1}.</span>` : "";
    const descHTML = desc ? `<div class="fud-opt-picker-desc">${desc}</div>` : "";
    return `
      <div class="fud-opt-picker-row" data-fud-opt-idx="${i}" role="button" tabindex="0">
        <div class="fud-opt-picker-label">${numHint}${label}</div>
        ${descHTML}
      </div>
    `;
  }).join("");

  const subtitleHTML = subtitle
    ? `<div class="fud-opt-picker-subtitle">${escapeHtml(subtitle)}</div>`
    : "";

  root.innerHTML = `
    <div class="fud-opt-picker-card" role="dialog" aria-label="${escapeHtml(title)}">
      <div class="fud-opt-picker-title">${escapeHtml(title)}</div>
      ${subtitleHTML}
      <div class="fud-opt-picker-list">${rowsHTML}</div>
      <div class="fud-opt-picker-cancel" data-fud-opt-action="cancel" role="button" tabindex="0">${escapeHtml(cancelLabel)}</div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  log(`option-picker: spawned "${title}" with ${options.length} options`);

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;
    let keyListener = null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => {
        try { root.remove(); } catch {}
        _overlays.delete(overlayId);
      }, 180);
      if (keyListener) {
        try { window.removeEventListener("keydown", keyListener, true); } catch {}
        keyListener = null;
      }
      resolve(result);
    };

    root.addEventListener("click", (ev) => {
      const cancelEl = ev.target?.closest?.("[data-fud-opt-action='cancel']");
      if (cancelEl) { ev.stopPropagation(); finish(null); return; }
      const rowEl = ev.target?.closest?.("[data-fud-opt-idx]");
      if (!rowEl) return;
      ev.stopPropagation();
      const idx = Number(rowEl.dataset.fudOptIdx);
      if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) return;
      finish({ index: idx, option: options[idx] });
    });

    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Escape") { ev.preventDefault(); finish(null); return; }
      const n = parseInt(ev.key, 10);
      if (!Number.isFinite(n) || n < 1 || n > 9) return;
      const idx = n - 1;
      if (idx >= options.length) return;
      ev.preventDefault();
      finish({ index: idx, option: options[idx] });
    };
    window.addEventListener("keydown", keyListener, true);

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(overlayId);
      if (!resolved) { resolved = true; resolve(null); }
    };
    _overlays.set(overlayId, { cleanup, root });
  });
}

// Despawn helper for stop()/cleanup paths.
export const OptionPicker = {
  despawnAll() {
    for (const rec of _overlays.values()) {
      try { rec.cleanup(); } catch {}
    }
    _overlays.clear();
  },
};
