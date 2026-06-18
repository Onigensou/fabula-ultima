// List Picker — shared director-native overlay for "choose one rich row".
//
// The single primitive behind the per-action selection steps that were each a
// bespoke parchment overlay (weapon-mode, skill, item, option-menu). Each caller
// supplies its choices as DATA — sections of rows — and gets back the picked
// row's `value`. The renderer + lifecycle + keyboard handling live here once.
//
// Generalized from weapon-mode-picker.js (the richest of the old overlays), then
// grown to absorb skill + item: sections, image/FA-fallback icons, primary/
// secondary lines, badge (+ tones), disabled rows, dwell tooltips, color accent,
// arrow+number nav, scroll-into-view, hover SFX, external-cancel, optional tabs.
//
// API — pickFromList(opts) -> Promise<value | null>   (null = cancelled)
//
//   opts = {
//     // --- content (give sections OR options) ---
//     sections?:  [{ label?, hint?, items: row[], emptyText? }],  // grouped; ≥2 + tabbed = tabs
//                 // an empty section still renders (tab + empty-state line);
//                 // picker opens on the first non-empty section
//     options?:   row[],                              // flat list (one implicit section)
//
//     // --- chrome ---
//     title?:     string,        // header (default "Choose")
//     subtitle?:  string,        // sub-header line under the title
//     cancelLabel?: string,      // cancel button text (default "Cancel")
//     width?:     number,        // card width px (default 360; e.g. 420/480)
//     listHeight?: string,       // fixed scroll-area height (CSS length) for a
//                                // consistent card size — selectors set it; menus omit it
//
//     // --- behavior ---
//     tabbed?:        boolean,   // render sections as tabs when ≥2 (else stacked)
//     numberShortcuts?: boolean, // 1–9 select the nth navigable row (default true)
//     autoFocusFirst?: boolean,  // focus the first navigable row at spawn
//
//     // --- lifecycle / plumbing ---
//     director?:      Director,  // overlay keyed by director.combatId
//     overlayKey?:    string,    // explicit key (overrides director)
//     externalCancel?: Promise,  // resolve to tear the overlay down (-> null)
//     zIndex?:        number,    // stacking (default 96; above the action card)
//   }
//
//   row = {
//     value,                 // REQUIRED — returned verbatim when picked (any type)
//     primary,               // main label — HTML (caller escapes text)
//     secondary?,            // sub line — HTML (wraps; use .bullet/.dot/.check-attr spans)
//     secondaryNoWrap?,      // clamp secondary to one ellipsized line (long meta)
//     imageUrl?,             // 40px icon image URL
//     fallbackIcon?,         // HTML (e.g. FA <i>) shown when no imageUrl
//     badge?,                // right-aligned HTML chip (e.g. a cost badge)
//     badgeTone?,            // "free" (green) | "danger" (red) | undefined (neutral)
//     disabled?,             // greyed + non-clickable + skipped by keyboard
//     color?,                // left accent color (CSS)
//     tooltip?,              // dwell-hover popup: { name?, cost?, missing?, body? }
//   }
//
// Returned by a thin caller (weapon-mode/skill/item) that maps its domain data to
// rows; `value` carries whatever that caller wants back (a mode string, a
// {skillUuid,...}, a {mode,key,...}). Also exports ListPicker.{despawn,despawnAll}.

import { log, warn } from "./logger.js";
import { playUiHoverSfx } from "./director-ui-sfx.js";

const CSS_ID  = "fud-list-picker-style";
const ROOT_ID = "fud-list-picker-root";
const TIP_ID  = "fud-list-picker-tip";

const _overlays = new Map();
let _spawnSeq = 0;

// Description-tooltip singleton (body-mounted), shared across overlays. Shown on
// dwell-hover when a row carries a `tooltip` payload.
let _tipEl = null;
let _tipHideTid = null;
const HOVER_DWELL_MS = 600;

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
    /* Optional tab bar (tabbed mode, ≥2 sections). Each section is a panel. */
    .fud-lp-card .fud-lp-tabs { display: flex; gap: 4px; margin-bottom: 8px; flex-shrink: 0; }
    .fud-lp-card .fud-lp-tab {
      flex: 1; text-align: center; padding: 6px 8px; border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.4);
      font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--fud-stroke, #7a6a55); cursor: pointer; user-select: none;
      transition: background 100ms ease, color 100ms ease;
    }
    .fud-lp-card .fud-lp-tab:hover { background: rgba(255, 255, 255, 0.7); }
    .fud-lp-card .fud-lp-tab.is-active {
      background: linear-gradient(180deg, #fef5dc, #ebd9a6);
      color: #3a3228; border-color: rgba(90, 62, 28, 0.75);
    }
    .fud-lp-card .fud-lp-tab .tab-count { font-size: 9px; opacity: 0.7; margin-left: 5px; font-weight: 700; text-transform: none; letter-spacing: 0.2px; }
    .fud-lp-card .fud-lp-panel { display: none; flex-direction: column; gap: 6px; }
    .fud-lp-card .fud-lp-panel.is-active { display: flex; }
    .fud-lp-card .fud-lp-section-label {
      font-size: 9.5px; font-weight: 900; letter-spacing: 0.8px; text-transform: uppercase;
      color: var(--fud-stroke, #7a6a55);
      padding: 6px 4px 3px;
      border-bottom: 1px solid rgba(122, 106, 85, 0.4);
      margin-bottom: 1px;
    }
    .fud-lp-card .fud-lp-section-label:first-child { margin-top: 0; padding-top: 2px; }
    .fud-lp-card .fud-lp-empty {
      padding: 18px 12px; text-align: center;
      color: var(--fud-stroke, #7a6a55); font-size: 11px; font-style: italic; opacity: 0.85;
    }
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
    /* Icon-less lists (e.g. most open_action_menus) drop the 40px icon column so
       rows sit flush-left instead of with an empty gutter. */
    .fud-lp-card.no-icons .fud-lp-option { grid-template-columns: 1fr auto; }
    .fud-lp-card.no-icons .fud-lp-option .icon { display: none; }
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
    .fud-lp-card .fud-lp-option .info { min-width: 0; overflow: hidden; }
    .fud-lp-card .fud-lp-option .primary {
      font-weight: 900; letter-spacing: 0.2px; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .fud-lp-card .fud-lp-option .secondary {
      font-size: 10.5px; opacity: 0.82; font-weight: 600; letter-spacing: 0.2px; margin-top: 2px;
    }
    .fud-lp-card .fud-lp-option .secondary { line-height: 1.3; }
    /* Single-line ellipsized secondary (opt-in via row.secondaryNoWrap) — keeps
       long meta (e.g. an item granting many sub-items) on one clipped line
       instead of spilling the row. */
    .fud-lp-card .fud-lp-option .secondary.is-nowrap {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fud-lp-card .fud-lp-option .secondary .dot { margin: 0 5px; opacity: 0.6; }
    .fud-lp-card .fud-lp-option .secondary .bullet { white-space: nowrap; }
    .fud-lp-card .fud-lp-option .secondary .check-attr {
      font-weight: 800; letter-spacing: 0.4px;
      padding: 1px 5px; border-radius: 4px;
      background: rgba(40, 30, 18, 0.14); color: #4a3208;
    }
    .fud-lp-card .fud-lp-option .primary .source-tag { font-size: 10px; opacity: 0.8; }
    .fud-lp-card .fud-lp-option .fud-lp-badge {
      font-size: 10px; font-weight: 800;
      padding: 2px 7px; border-radius: 6px;
      border: 1px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.45);
      color: var(--fud-stroke, #7a6a55);
      white-space: nowrap;
    }
    .fud-lp-card .fud-lp-option .fud-lp-badge.is-free {
      background: rgba(40, 100, 40, 0.18); border-color: rgba(40, 100, 40, 0.32); color: #194c19;
    }
    .fud-lp-card .fud-lp-option .fud-lp-badge.is-danger {
      background: rgba(110, 30, 30, 0.18); border-color: rgba(110, 30, 30, 0.32); color: #6b1e1e;
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

    /* Description tooltip — body-mounted singleton, shown on dwell-hover. */
    #${TIP_ID} {
      position: fixed; max-width: 320px; max-height: 70vh; overflow: hidden;
      padding: 10px 12px;
      background: linear-gradient(180deg, #fff8e8, #f0e4cc);
      border: 2px solid var(--fud-stroke, #7a6a55); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      font-size: 11.5px; line-height: 1.4;
      z-index: 99; pointer-events: none; opacity: 0;
      transition: opacity 120ms ease;
    }
    #${TIP_ID} .tip-body { overflow-wrap: anywhere; }
    #${TIP_ID}.is-visible { opacity: 1; }
    #${TIP_ID} .tip-name { font-weight: 900; font-size: 12.5px; margin-bottom: 4px; letter-spacing: 0.2px; }
    #${TIP_ID} .tip-body { margin: 0; }
    #${TIP_ID} .tip-cost { font-weight: 800; color: #4a3208; }
  `;
  document.head.appendChild(css);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// Tooltip singleton helpers (ported from the old skill-picker so it folds in).
function ensureTip() {
  if (_tipEl) return;
  _tipEl = document.createElement("div");
  _tipEl.id = TIP_ID;
  document.body.appendChild(_tipEl);
}
function showTip(payload, anchorRect) {
  if (!_tipEl || !payload) return;
  if (_tipHideTid) { clearTimeout(_tipHideTid); _tipHideTid = null; }
  const parts = [];
  if (payload.name)    parts.push(`<div class="tip-name">${escapeHtml(payload.name)}</div>`);
  if (payload.cost)    parts.push(`<div class="tip-cost">Cost: ${escapeHtml(payload.cost)}</div>`);
  if (payload.missing) parts.push(`<div class="tip-cost" style="color:#7a1a1a;">Missing: ${escapeHtml(payload.missing)}</div>`);
  if (payload.body)    parts.push(`<p class="tip-body">${escapeHtml(payload.body)}</p>`);
  _tipEl.innerHTML = parts.join("");
  // Position to the right of the row, clamped to the viewport using the
  // tooltip's ACTUAL size. (A long description can be tall — the old fixed -120
  // guess let it spill past the bottom edge for rows low on screen.) offsetW/H
  // are valid here even at opacity:0 since the element isn't display:none.
  const tw = _tipEl.offsetWidth;
  const th = _tipEl.offsetHeight;
  const x = Math.max(8, Math.min(window.innerWidth - tw - 8, anchorRect.right + 8));
  const y = Math.max(8, Math.min(window.innerHeight - th - 8, anchorRect.top));
  _tipEl.style.left = `${x}px`;
  _tipEl.style.top = `${y}px`;
  _tipEl.classList.add("is-visible");
}
function hideTip() {
  if (!_tipEl) return;
  _tipEl.classList.remove("is-visible");
  if (_tipHideTid) clearTimeout(_tipHideTid);
  _tipHideTid = setTimeout(() => { try { _tipEl.innerHTML = ""; } catch {} }, 180);
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
  autoFocusFirst = false,
  width = 360,
  tabbed = false,
  listHeight = null,
} = {}) {
  ensureStyles();
  ensureTip();

  // Normalize to sections. A flat `options` array becomes one headerless section.
  const groups = Array.isArray(sections) && sections.length
    ? sections
    : (Array.isArray(options) && options.length ? [{ label: null, hint: null, items: options }] : []);
  if (!groups.length) { warn("list-picker: no options provided — auto-cancelling"); return null; }

  const key = overlayKey ?? director?.combatId ?? `lp-${++_spawnSeq}`;
  const prior = _overlays.get(key);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(key); }

  // Flatten rows for keyboard/click lookup; remember each row's section index.
  const flat = [];
  const rowSection = [];

  const renderRow = (row, idx) => {
    const disabled = !!row.disabled;
    const iconInner = row.imageUrl ? `<img src="${row.imageUrl}" alt="">` : (row.fallbackIcon ?? "");
    const toneClass = row.badgeTone === "free" ? " is-free" : row.badgeTone === "danger" ? " is-danger" : "";
    const badgeHTML = row.badge ? `<div class="fud-lp-badge${toneClass}">${row.badge}</div>` : `<div></div>`;
    const secHTML = row.secondary ? `<div class="secondary${row.secondaryNoWrap ? " is-nowrap" : ""}">${row.secondary}</div>` : "";
    const accent = row.color ? ` style="border-left: 4px solid ${row.color};"` : "";
    const tipAttr = row.tooltip ? ` data-fud-lp-tip="${encodeURIComponent(JSON.stringify(row.tooltip))}"` : "";
    return `
      <div class="fud-lp-option${disabled ? " is-disabled" : ""}" data-fud-lp-idx="${idx}" role="button" tabindex="0"${accent}${tipAttr}>
        <div class="icon">${iconInner}</div>
        <div class="info">
          <div class="primary">${row.primary ?? ""}</div>
          ${secHTML}
        </div>
        ${badgeHTML}
      </div>
    `;
  };

  // Build each section's rows once (recording section membership per flat row).
  // An empty section still renders — its panel shows an empty-state line — so a
  // fixed tab set (e.g. Item's Use/Create) keeps every tab present + clickable.
  const builtSections = groups.map((section, si) => {
    const rows = section.items ?? [];
    const itemsHTML = rows.length
      ? rows.map((row) => {
          const idx = flat.length;
          flat.push(row);
          rowSection.push(si);
          return renderRow(row, idx);
        }).join("")
      : `<div class="fud-lp-empty">${escapeHtml(section.emptyText ?? "Nothing here.")}</div>`;
    return { label: section.label, hint: section.hint, itemsHTML };
  });

  // Tabbed only when explicitly requested AND there are ≥2 sections — a single
  // section needs no tab. Each section becomes a switchable panel; otherwise the
  // sections stack (labels inline) as a single scroll list.
  const useTabs = tabbed && builtSections.length >= 2;
  // Open on the first NON-empty tab so the picker never lands on an empty list
  // when another tab has rows. (Falls back to 0 if all are empty.)
  const firstNonEmpty = groups.findIndex((s) => (s.items ?? []).length > 0);
  const activeStart = firstNonEmpty >= 0 ? firstNonEmpty : 0;
  // Fixed scroll-area height (opt-in) — keeps the selector pickers (weapon/skill/
  // item) a consistent size regardless of item count. Menus omit it so they stay
  // content-sized.
  const optionsStyle = listHeight ? ` style="flex:none;height:${listHeight}"` : "";
  let middleHTML;
  if (useTabs) {
    const tabBar = `<div class="fud-lp-tabs">${builtSections.map((s, si) =>
      `<div class="fud-lp-tab${si === activeStart ? " is-active" : ""}" data-fud-lp-tab="${si}" role="tab">${s.label ?? `Tab ${si + 1}`}${s.hint ? `<span class="tab-count">${s.hint}</span>` : ""}</div>`
    ).join("")}</div>`;
    const panels = builtSections.map((s, si) =>
      `<div class="fud-lp-panel${si === activeStart ? " is-active" : ""}" data-fud-lp-panel="${si}">${s.itemsHTML}</div>`
    ).join("");
    middleHTML = `${tabBar}<div class="fud-lp-options"${optionsStyle}>${panels}</div>`;
  } else {
    const stacked = builtSections.map((s) =>
      (s.label ? `<div class="fud-lp-section-label">${s.label}${s.hint ? `<span class="hint">${s.hint}</span>` : ""}</div>` : "") + s.itemsHTML
    ).join("");
    middleHTML = `<div class="fud-lp-options"${optionsStyle}>${stacked}</div>`;
  }

  // Drop the icon column entirely when no row carries an icon (flush-left rows).
  const hasAnyIcon = flat.some((r) => r.imageUrl || r.fallbackIcon);

  const overlayId = ++_spawnSeq;
  const root = document.createElement("div");
  root.className = "fud-lp-root";
  root.id = `${ROOT_ID}-${overlayId}`;
  root.style.zIndex = String(zIndex);
  root.innerHTML = `
    <div class="fud-lp-card${hasAnyIcon ? "" : " no-icons"}" role="dialog" aria-label="${title}" style="width:${Number(width) || 360}px">
      <div class="fud-lp-title">${title}</div>
      ${subtitle ? `<div class="fud-lp-subtitle">${subtitle}</div>` : ""}
      ${middleHTML}
      <div class="fud-lp-cancel" data-fud-lp-action="cancel" role="button" tabindex="0">${cancelLabel}</div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  // Tell any on-screen action-card overlay to hide while this menu is up — and
  // ONLY while it's up. Paired with the close signal in finish()/cleanup() so
  // the card hides exactly when a picker is genuinely visible (no speculative
  // out-and-in flash on a pickerless recompute). Idempotent via the flag.
  let _pickerSignalLive = false;
  try { Hooks.callAll("fud.actionPickerOpen"); _pickerSignalLive = true; } catch {}
  const firePickerClose = () => {
    if (!_pickerSignalLive) return;
    _pickerSignalLive = false;
    try { Hooks.callAll("fud.actionPickerClose"); } catch {}
  };

  log(`list-picker: spawned "${title}" with ${flat.length} options`);

  // Indices that can receive keyboard focus / number selection (skip disabled).
  const pickable = flat.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);

  return new Promise((resolve) => {
    let resolved = false;
    let keyListener = null;
    let despawnTid = null;
    let hoverDwellTid = null;
    let kbPos = 0;     // position within the current nav set
    let kbActive = false;
    let activePanel = activeStart;  // active tab index (tabbed mode only)

    const getOptionEls = () => Array.from(root.querySelectorAll(".fud-lp-option"));
    // Navigable (non-disabled) row indices for the current context — all rows
    // when stacked, or just the active panel's rows when tabbed.
    const currentNav = () => useTabs ? pickable.filter((i) => rowSection[i] === activePanel) : pickable;

    function setKbFocus(pos) {
      const nav = currentNav();
      if (!nav.length) return;
      kbActive = true;
      kbPos = ((pos % nav.length) + nav.length) % nav.length;
      const focusIdx = nav[kbPos];
      let focusedEl = null;
      getOptionEls().forEach((el) => {
        const i = Number(el.dataset.fudLpIdx);
        const on = i === focusIdx;
        el.classList.toggle("is-kb-focused", on);
        if (on) focusedEl = el;
      });
      if (focusedEl) focusedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      playUiHoverSfx();
    }

    root.addEventListener("pointerenter", (e) => {
      if (kbActive && e.target?.closest?.(".fud-lp-option")) {
        kbActive = false;
        getOptionEls().forEach((el) => el.classList.remove("is-kb-focused"));
      }
    }, true);

    // Tooltip dwell — show a row's description popup after a hover pause.
    root.addEventListener("mousemove", (ev) => {
      if (resolved) return;
      const rowEl = ev.target?.closest?.(".fud-lp-option");
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      if (!rowEl || !rowEl.dataset.fudLpTip) { hideTip(); return; }
      const rect = rowEl.getBoundingClientRect();
      hoverDwellTid = setTimeout(() => {
        if (resolved) return;
        try { showTip(JSON.parse(decodeURIComponent(rowEl.dataset.fudLpTip)), rect); } catch {}
      }, HOVER_DWELL_MS);
    });
    root.addEventListener("mouseleave", () => {
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      hideTip();
    });

    // Optional: focus the first navigable row at spawn (Enter selects immediately).
    if (autoFocusFirst) {
      const nav = currentNav();
      if (nav.length) {
        kbActive = true; kbPos = 0;
        const focusIdx = nav[0];
        requestAnimationFrame(() => {
          if (resolved) return;
          getOptionEls().forEach((el) => el.classList.toggle("is-kb-focused", Number(el.dataset.fudLpIdx) === focusIdx));
        });
      }
    }

    const finish = (value, cancelled = false) => {
      if (resolved) return;
      resolved = true;
      hideTip();
      if (hoverDwellTid) { clearTimeout(hoverDwellTid); hoverDwellTid = null; }
      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      firePickerClose();
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
      // Tab switch (tabbed mode): toggle active tab + panel, reset kb focus.
      const tabEl = ev.target?.closest?.("[data-fud-lp-tab]");
      if (tabEl) {
        ev.stopPropagation();
        const si = Number(tabEl.dataset.fudLpTab);
        if (Number.isFinite(si) && si !== activePanel) {
          activePanel = si;
          root.querySelectorAll("[data-fud-lp-tab]").forEach((t) => t.classList.toggle("is-active", Number(t.dataset.fudLpTab) === si));
          root.querySelectorAll("[data-fud-lp-panel]").forEach((p) => p.classList.toggle("is-active", Number(p.dataset.fudLpPanel) === si));
          kbActive = false; kbPos = 0;
          getOptionEls().forEach((el) => el.classList.remove("is-kb-focused"));
          hideTip();
        }
        return;
      }
      const rowEl = ev.target?.closest?.("[data-fud-lp-idx]");
      if (!rowEl) return;
      ev.stopPropagation();
      pickByIdx(Number(rowEl.dataset.fudLpIdx));
    });

    keyListener = (ev) => {
      if (resolved) return;
      // Don't steal keys while the user is typing in an input field, textarea,
      // <select>, or any contenteditable surface (chat box, sheet fields, etc.).
      const ae = document.activeElement;
      if (ae) {
        const tag = ae.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable) return;
      }
      if (ev.key === "Escape" || ev.key === "x" || ev.key === "X") { ev.preventDefault(); finish(null, true); return; }
      if (ev.key === "ArrowUp")   { ev.preventDefault(); setKbFocus(kbPos - 1); return; }
      if (ev.key === "ArrowDown") { ev.preventDefault(); setKbFocus(kbPos + 1); return; }
      if (ev.key === "Enter" || ev.key === "z" || ev.key === "Z") {
        ev.preventDefault();
        const nav = currentNav();
        if (kbActive && nav.length) pickByIdx(nav[kbPos]);
        return;
      }
      if (numberShortcuts) {
        const n = parseInt(ev.key, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 9) {
          const nav = currentNav();
          if (n <= nav.length) { ev.preventDefault(); pickByIdx(nav[n - 1]); }
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
      try { clearTimeout(hoverDwellTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      firePickerClose();
      try { root.remove(); } catch {}
      _overlays.delete(key);
      hideTip();
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
