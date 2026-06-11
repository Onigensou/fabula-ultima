// List Picker — shared director-native overlay for "choose one rich row".
//
// The single primitive behind the per-action selection steps that were each a
// bespoke parchment overlay (weapon-mode, skill, item, option-menu). Each caller
// supplies its choices as DATA — sections of rows — and gets back the picked
// row's `value`. The renderer + lifecycle + keyboard handling live here once.
//
// Generalized from weapon-mode-picker.js (the richest of the old overlays):
// sections with labels/hints, image-or-FA-fallback icons, primary/secondary
// lines, arrow+Enter nav, hover SFX, Map-keyed lifecycle, external-cancel. Adds
// number-key shortcuts + color accent (option-picker parity) and optional
// per-row badge + disabled state (for the Skill/Item migrations).
//
// API:
//   pickFromList({
//     director?, overlayKey?, title, subtitle?, zIndex?,
//     sections?: [{ label, hint?, items: row[] }],   // grouped, OR
//     options?: row[],                                // single implicit section
//     cancelLabel?, externalCancel?, numberShortcuts?,
//   }) -> Promise<value | null>   // null = cancelled
//
//   row = {
//     value,               // returned when picked (REQUIRED, any type)
//     primary,             // main label — HTML (caller escapes text)
//     secondary?,          // sub line — HTML
//     imageUrl?,           // icon image URL
//     fallbackIcon?,       // HTML (e.g. FA <i>) shown when no imageUrl
//     badge?,              // right-aligned HTML chip (e.g. a cost badge)
//     disabled?,           // greyed + non-clickable + skipped by keyboard
//     color?,              // left accent color (CSS)
//   }
//
// Style/IDs mirror the old weapon-mode overlay so the look is unchanged.

import { log, warn } from "./logger.js";
import { playUiHoverSfx } from "./director-ui-sfx.js";

const CSS_ID  = "fud-list-picker-style";
const ROOT_ID = "fud-list-picker-root";

const _overlays = new Map();
let _spawnSeq = 0;

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    .fud-lp-root {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    .fud-lp-root.is-visible  { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    .fud-lp-root.is-resolving { transform: translate(-50%, -50%) scale(0.96); opacity: 0; transition: transform 180ms ease-out, opacity 180ms ease-out; }

    .fud-lp-card {
      pointer-events: auto;
      width: 360px;
      max-width: 92vw;
      max-height: 78vh;
      display: flex; flex-direction: column;
      padding: 12px 14px 10px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-lp-card .fud-lp-title {
      font-size: 14px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
      margin-bottom: 10px;
    }
    .fud-lp-card .fud-lp-subtitle {
      font-size: 11px; text-align: center;
      color: var(--fud-ink-soft, #4b4338); opacity: 0.85;
      margin: -4px 0 9px;
    }
    .fud-lp-card .fud-lp-options {
      display: flex; flex-direction: column; gap: 6px;
      overflow-y: auto; flex: 1; min-height: 0;
    }
    .fud-lp-card .fud-lp-section-label {
      font-size: 9.5px; font-weight: 900; letter-spacing: 0.8px; text-transform: uppercase;
      color: var(--fud-stroke, #7a6a55);
      padding: 6px 4px 3px;
      border-bottom: 1px solid rgba(122, 106, 85, 0.4);
      margin-bottom: 1px;
    }
    .fud-lp-card .fud-lp-section-label:first-child { margin-top: 0; padding-top: 2px; }
    .fud-lp-card .fud-lp-section-label .hint {
      font-size: 9px; font-weight: 700; opacity: 0.75; text-transform: none;
      letter-spacing: 0.2px; margin-left: 6px;
    }
    .fud-lp-card .fud-lp-option {
      display: grid; grid-template-columns: 40px 1fr auto;
      gap: 10px; align-items: center;
      padding: 8px 12px;
      border-radius: 9px;
      border: 2px solid rgba(90, 62, 28, 0.5);
      background: linear-gradient(180deg, #fffef8, #f5eedd);
      color: #2d1f0d;
      box-shadow: 0 2px 0 rgba(41, 33, 24, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      cursor: pointer; user-select: none;
      transition: transform 100ms ease, filter 100ms ease, box-shadow 100ms ease;
    }
    .fud-lp-card .fud-lp-option:hover  { filter: brightness(1.03); transform: translateY(-1px); }
    .fud-lp-card .fud-lp-option:active { transform: translateY(0); }
    .fud-lp-card .fud-lp-option.is-kb-focused {
      background: linear-gradient(180deg, #fef5dc, #ebd9a6);
      border-color: rgba(90, 62, 28, 0.75);
      box-shadow: 0 3px 0 rgba(41, 33, 24, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.8) inset, inset 3px 0 0 var(--fud-gold-2, #b7935a);
      transform: translateY(-1px);
    }
    .fud-lp-card .fud-lp-option.is-disabled {
      cursor: not-allowed; filter: grayscale(0.5); opacity: 0.55;
      box-shadow: 0 1px 0 rgba(41, 33, 24, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.6) inset;
    }
    .fud-lp-card .fud-lp-option.is-disabled:hover { filter: grayscale(0.5); transform: none; }
    .fud-lp-card .fud-lp-option .icon {
      display: flex; align-items: center; justify-content: center;
      width: 36px; height: 36px;
    }
    .fud-lp-card .fud-lp-option .icon img {
      width: 36px; height: 36px;
      border-radius: 6px; object-fit: cover;
      border: 0 !important; outline: 0 !important; background: transparent !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35) !important;
    }
    .fud-lp-card .fud-lp-option .icon i.fa-solid { font-size: 22px; opacity: 0.9; }
    .fud-lp-card .fud-lp-option .info { min-width: 0; }
    .fud-lp-card .fud-lp-option .primary {
      font-weight: 900; letter-spacing: 0.2px; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .fud-lp-card .fud-lp-option .secondary {
      font-size: 10.5px; opacity: 0.82; font-weight: 600; letter-spacing: 0.2px; margin-top: 2px;
    }
    .fud-lp-card .fud-lp-option .secondary .dot { margin: 0 5px; opacity: 0.6; }
    .fud-lp-card .fud-lp-option .fud-lp-badge {
      font-size: 10px; font-weight: 800;
      padding: 2px 7px; border-radius: 6px;
      border: 1px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.45);
      color: var(--fud-stroke, #7a6a55);
      white-space: nowrap;
    }
    .fud-lp-card .fud-lp-cancel {
      margin-top: 8px;
      padding: 6px 10px; border-radius: 8px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase; font-size: 11px;
      cursor: pointer; text-align: center; user-select: none;
      box-shadow: 0 3px 0 rgba(41, 33, 24, 0.55), 0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
    }
    .fud-lp-card .fud-lp-cancel:hover { filter: brightness(1.05); }
  `;
  document.head.appendChild(css);
}

// Show the picker. Resolves to the chosen row's `value`, or null on cancel.
export async function pickFromList({
  director = null,
  overlayKey = null,
  title = "Choose",
  subtitle = null,
  zIndex = 96,
  sections = null,
  options = null,
  cancelLabel = "Cancel",
  externalCancel = null,
  numberShortcuts = true,
} = {}) {
  ensureStyles();

  // Normalize to sections. A flat `options` array becomes one headerless section.
  const groups = Array.isArray(sections) && sections.length
    ? sections
    : (Array.isArray(options) && options.length ? [{ label: null, hint: null, items: options }] : []);
  if (!groups.length) { warn("list-picker: no options provided — auto-cancelling"); return null; }

  const key = overlayKey ?? director?.combatId ?? `lp-${++_spawnSeq}`;
  const prior = _overlays.get(key);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(key); }

  // Flatten rows for keyboard/click lookup; remember each row's original index.
  const flat = [];
  const sectionsHTML = groups.map((section) => {
    const itemsHTML = (section.items ?? []).map((row) => {
      const idx = flat.length;
      flat.push(row);
      const disabled = !!row.disabled;
      const iconInner = row.imageUrl ? `<img src="${row.imageUrl}" alt="">` : (row.fallbackIcon ?? "");
      const badgeHTML = row.badge ? `<div class="fud-lp-badge">${row.badge}</div>` : `<div></div>`;
      const secHTML = row.secondary ? `<div class="secondary">${row.secondary}</div>` : "";
      const accent = row.color ? ` style="border-left: 4px solid ${row.color};"` : "";
      return `
        <div class="fud-lp-option${disabled ? " is-disabled" : ""}" data-fud-lp-idx="${idx}" role="button" tabindex="0"${accent}>
          <div class="icon">${iconInner}</div>
          <div class="info">
            <div class="primary">${row.primary ?? ""}</div>
            ${secHTML}
          </div>
          ${badgeHTML}
        </div>
      `;
    }).join("");
    const labelHTML = section.label
      ? `<div class="fud-lp-section-label">${section.label}${section.hint ? `<span class="hint">${section.hint}</span>` : ""}</div>`
      : "";
    return labelHTML + itemsHTML;
  }).join("");

  const overlayId = ++_spawnSeq;
  const root = document.createElement("div");
  root.className = "fud-lp-root";
  root.id = `${ROOT_ID}-${overlayId}`;
  root.style.zIndex = String(zIndex);
  root.innerHTML = `
    <div class="fud-lp-card" role="dialog" aria-label="${title}">
      <div class="fud-lp-title">${title}</div>
      ${subtitle ? `<div class="fud-lp-subtitle">${subtitle}</div>` : ""}
      <div class="fud-lp-options">${sectionsHTML}</div>
      <div class="fud-lp-cancel" data-fud-lp-action="cancel" role="button" tabindex="0">${cancelLabel}</div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  log(`list-picker: spawned "${title}" with ${flat.length} options`);

  // Indices that can receive keyboard focus / number selection (skip disabled).
  const pickable = flat.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);

  return new Promise((resolve) => {
    let resolved = false;
    let keyListener = null;
    let despawnTid = null;
    let kbPos = 0;     // position within `pickable`
    let kbActive = false;

    const getOptionEls = () => Array.from(root.querySelectorAll(".fud-lp-option"));

    function setKbFocus(pos) {
      if (!pickable.length) return;
      kbActive = true;
      kbPos = ((pos % pickable.length) + pickable.length) % pickable.length;
      const focusIdx = pickable[kbPos];
      getOptionEls().forEach((el) => {
        const i = Number(el.dataset.fudLpIdx);
        el.classList.toggle("is-kb-focused", i === focusIdx);
      });
      playUiHoverSfx();
    }

    root.addEventListener("pointerenter", (e) => {
      if (kbActive && e.target?.closest?.(".fud-lp-option")) {
        kbActive = false;
        getOptionEls().forEach((el) => el.classList.remove("is-kb-focused"));
      }
    }, true);

    const finish = (value, cancelled = false) => {
      if (resolved) return;
      resolved = true;
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => { try { root.remove(); } catch {} _overlays.delete(key); }, 200);
      if (keyListener) { try { window.removeEventListener("keydown", keyListener, true); } catch {} keyListener = null; }
      resolve(cancelled ? null : value);
    };

    const pickByIdx = (idx) => {
      const row = flat[idx];
      if (!row || row.disabled) return;
      finish(row.value);
    };

    root.addEventListener("click", (ev) => {
      const cancelEl = ev.target?.closest?.("[data-fud-lp-action='cancel']");
      if (cancelEl) { ev.stopPropagation(); finish(null, true); return; }
      const rowEl = ev.target?.closest?.("[data-fud-lp-idx]");
      if (!rowEl) return;
      ev.stopPropagation();
      pickByIdx(Number(rowEl.dataset.fudLpIdx));
    });

    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Escape" || ev.key === "x" || ev.key === "X") { ev.preventDefault(); finish(null, true); return; }
      if (ev.key === "ArrowUp")   { ev.preventDefault(); setKbFocus(kbPos - 1); return; }
      if (ev.key === "ArrowDown") { ev.preventDefault(); setKbFocus(kbPos + 1); return; }
      if (ev.key === "Enter" || ev.key === "z" || ev.key === "Z") {
        ev.preventDefault();
        if (kbActive && pickable.length) pickByIdx(pickable[kbPos]);
        return;
      }
      if (numberShortcuts) {
        const n = parseInt(ev.key, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 9) {
          const idx = n - 1;
          if (idx < flat.length && !flat[idx].disabled) { ev.preventDefault(); pickByIdx(idx); }
        }
      }
    };
    window.addEventListener("keydown", keyListener, true);

    // External cancellation (caller lost a race / needs to tear this down).
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => { if (!resolved) { try { finish(null, true); } catch {} } });
    }

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(key);
      if (!resolved) { resolved = true; resolve(null); }
    };
    _overlays.set(key, { cleanup, root });
  });
}

export const ListPicker = {
  despawn({ director, overlayKey } = {}) {
    const key = overlayKey ?? director?.combatId;
    const rec = key != null ? _overlays.get(key) : null;
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(key);
  },
  despawnAll() {
    for (const rec of _overlays.values()) { try { rec.cleanup(); } catch {} }
    _overlays.clear();
  },
};
