// scripts/battle-director/keyword-tooltip.js
// DOM-based keyword / status explanation panel for the Action Card.
//
// When the user clicks a highlighted Action Keyword (e.g. "Unleash") or a
// status chip (e.g. "Bleed") inside the card's Effect section, this panel
// slides in to the LEFT of the action card showing that term's rules text.
// Mirrors the invoke HUD's singleton + parchment styling
// (`invoke/invoke-hud.js`) but is purely informational — no dimmer, no aura,
// no resolve Promise.
//
// Content is supplied by the caller from the static `keyword-registry.js`
// (label / icon / kind / descHtml). This module never reads the live journal.
//
// Toggle semantics (owned by the action-card click handler, which calls
// `toggleKeywordTooltip`):
//   - click a chip            → open its tooltip
//   - click the same chip     → close it
//   - click a different chip  → swap content (close old, open new)
//   - card teardown           → dismissKeywordTooltip()
//
// SFX: the click cue is played by the delegated director-ui-sfx listener
// (the chip carries `[data-fud-kw]`, added to its INTERACTIVE_SELECTOR), so
// the panel itself stays silent — same "click" feel as every other card
// control.
//
// Stable import URL (no ?cb=) so the module singleton survives cache-busted
// loads of its callers.

import { DAMAGE as DAMAGE_TYPE_STYLE } from "../linked-text/lt-terms.js";

const PANEL_ID = "fud-kw-tooltip";
const CSS_ID   = "fud-kw-tooltip-style";
const PANEL_W  = 256;

// ── Singleton ─────────────────────────────────────────────────────────────────

let _active = null; // { key, el }

export function getActiveKey() {
  return _active?.key ?? null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = `
    /* ── Keyword / status tooltip panel ── */
    #${PANEL_ID} {
      position: fixed;
      z-index: 96;
      width: ${PANEL_W}px;
      pointer-events: none;
      opacity: 0;
      /* ease-in (open): slide in FROM the left + fade */
      transform: translateX(-16px);
      transition: opacity 200ms ease-out, transform 200ms cubic-bezier(.2,.7,.2,1);
      font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif;
    }
    #${PANEL_ID}.is-visible {
      pointer-events: auto;
      opacity: 1;
      transform: translateX(0);
    }

    /* ── Card shell (mirrors invoke HUD parchment) ── */
    .fud-kt-card {
      width: 100%;
      padding: 12px 13px 11px;
      border: 2px solid var(--fud-stroke,#7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top,#f6f1e6), var(--fud-parchment-bot,#ebe3d0));
      box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.45) inset;
      color: var(--fud-ink,#3a3228);
    }
    .fud-kt-kicker {
      font-size: 11px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
      opacity: .6; margin-bottom: 4px;
    }
    .fud-kt-head {
      display: flex; align-items: center; gap: 8px; margin-bottom: 9px;
    }
    .fud-kt-icon {
      width: 28px; height: 28px; object-fit: contain;
      border: none; background: transparent; border-radius: 0; box-shadow: none; flex-shrink: 0;
    }
    .fud-kt-fa {
      width: 28px; text-align: center; font-size: 22px; line-height: 1; flex-shrink: 0;
      color: var(--fud-dmg-c, inherit); text-shadow: 0 0 6px var(--fud-dmg-glow, transparent);
    }
    .fud-kt-title.is-dmg { color: var(--fud-dmg-c, inherit); text-shadow: 0 0 4px var(--fud-dmg-glow, transparent); }
    .fud-kt-title {
      font-size: 16px; font-weight: 900; line-height: 1.1; color: var(--fud-ink,#3a3228);
    }
    .fud-kt-body {
      font-size: 12px; line-height: 1.5; opacity: .92;
    }
    .fud-kt-body p { margin: 0 0 6px; }
    .fud-kt-body p:last-child { margin-bottom: 0; }
    .fud-kt-body ul { margin: 4px 0; padding-left: 18px; }
    .fud-kt-body img { display: none; } /* icon already shown in the header */
    .fud-kt-body a { color: inherit; text-decoration: underline; pointer-events: none; }
    /* The same card as a hover tooltip that follows the cursor. */
    .fud-kw-hover {
      position: fixed; left: 0; top: 0; z-index: 9500; width: ${PANEL_W}px;
      pointer-events: none; transform-origin: 0 0;
      font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif;
    }
    .fud-kw-hover[hidden] { display: none; }
    .fud-kt-meta { font-weight: 700; }
  `;
  document.head.appendChild(s);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );

function _kicker(kind) {
  return kind === "status" ? "Status" : "Keyword";
}

// Position the panel to the LEFT of the action card (the invoke HUD sits to
// the right; this is its mirror). Falls back to a left-of-center spot when the
// card isn't found.
function _position(el, cardRoot) {
  const card = cardRoot?.querySelector?.(".fud-bf-card") ?? cardRoot;
  const r = card?.getBoundingClientRect?.();
  if (r && r.width) {
    const left = Math.max(8, r.left - PANEL_W - 8);
    el.style.left      = `${left}px`;
    el.style.top       = `${r.top}px`;
    el.style.maxHeight = `${window.innerHeight - r.top - 12}px`;
    el.style.overflowY = "auto";
  } else {
    el.style.left = `calc(50% - ${PANEL_W + 172}px)`;
    el.style.top  = "20%";
  }
}

function _buildHTML(entry) {
  const iconSafe = entry?.icon && !/['"<>\n\r]/.test(String(entry.icon))
    ? String(entry.icon) : null;
  // Damage types use the colored element icon (linked-text DAMAGE), never the
  // registry's image file — same look as the chip on the card.
  const dmg = entry?.category === "damage" ? DAMAGE_TYPE_STYLE[String(entry.label ?? "").toLowerCase()] : null;
  const dmgVars = dmg ? ` style="--fud-dmg-c:${esc(dmg.color)};--fud-dmg-glow:${esc(dmg.glow)}"` : "";
  const iconHTML = dmg
    ? `<i class="fa-solid ${esc(dmg.fa)} fud-kt-fa"${dmgVars} aria-hidden="true"></i>`
    : iconSafe ? `<img class="fud-kt-icon" src="${esc(iconSafe)}" alt="">` : "";
  // descHtml is authored content from the static registry (harvested from the
  // keyword journals). It's trusted module data, not user input, so it renders
  // as HTML; nested links are de-activated via CSS (pointer-events:none).
  const body = entry?.descHtml
    ? String(entry.descHtml)
    : `<p style="opacity:.6">No description available.</p>`;
  return `<div class="fud-kt-card">
    <div class="fud-kt-kicker">${esc(entry?.kicker ?? (dmg ? "Damage Type" : _kicker(entry?.kind)))}</div>
    <div class="fud-kt-head">
      ${iconHTML}
      <div class="fud-kt-title${dmg ? " is-dmg" : ""}"${dmgVars}>${esc(entry?.label ?? "Keyword")}</div>
    </div>
    <div class="fud-kt-body">${body}</div>
  </div>`;
}

// ── Hover form ───────────────────────────────────────────────────────────────
// The same card on a cursor hover, for lists that have no room for the text.
// `entry` as the panel's, plus an optional `kicker` to replace Keyword / Status.
// Marked fu-inspect-keep so Battle Inspect doesn't darken it along with the HUD.

const HOVER_GAP = 16;
let _hover = null;
let _hoverScale = 1;

export function moveKeywordHover(x, y) {
  if (!_hover || _hover.hidden) return;
  const w = PANEL_W * _hoverScale, h = _hover.offsetHeight * _hoverScale;
  const left = x + HOVER_GAP + w > window.innerWidth - 8 ? x - HOVER_GAP - w : x + HOVER_GAP;
  const top = Math.max(8, Math.min(y + HOVER_GAP, window.innerHeight - h - 8));
  _hover.style.transform = `translate(${Math.max(8, left)}px, ${top}px) scale(${_hoverScale})`;
}

export function showKeywordHover(entry, { x = 0, y = 0, scale = 1 } = {}) {
  ensureStyles();
  if (!_hover?.isConnected) {
    _hover = document.createElement("div");
    _hover.className = "fud-kw-hover fu-inspect-keep";
    _hover.setAttribute("role", "tooltip");
    document.body.appendChild(_hover);
  }
  _hoverScale = scale;
  _hover.innerHTML = _buildHTML(entry);
  _hover.hidden = false;
  moveKeywordHover(x, y);
}

export function hideKeywordHover() {
  if (_hover) _hover.hidden = true;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function _spawn(entry, cardRoot) {
  ensureStyles();
  document.getElementById(PANEL_ID)?.remove();
  const el = document.createElement("div");
  el.id = PANEL_ID;
  el.innerHTML = _buildHTML(entry);
  document.body.appendChild(el);
  _position(el, cardRoot);
  // Double rAF so the initial (hidden) transform paints before we flip to
  // visible — otherwise the slide+fade is skipped.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
  return el;
}

// ease-out (close): slide out TO the right + fade. WAAPI (not class swap) to
// avoid the transition-property race the invoke HUD hit on its cancel route.
function _despawn(el) {
  if (!el?.parentNode) return;
  el.style.pointerEvents = "none";
  const anim = el.animate(
    [
      { opacity: "1", transform: "translateX(0)" },
      { opacity: "0", transform: "translateX(16px)" },
    ],
    { duration: 200, easing: "cubic-bezier(.8,0,.8,.3)", fill: "forwards" }
  );
  const cleanup = () => { try { el.remove(); } catch {} };
  anim.addEventListener("finish", cleanup, { once: true });
  setTimeout(cleanup, 350);
}

// Close the active tooltip (no-op when none open). Used on card teardown.
export function dismissKeywordTooltip() {
  if (!_active) return;
  const { el } = _active;
  _active = null;
  _despawn(el);
}

// Toggle entry-point used by the action-card click handler.
//   - same key already open  → close
//   - different key / nothing → open (swapping out any current one)
// `entry` = registry record { label, icon, kind, descHtml }.
export function toggleKeywordTooltip({ key, entry, cardRoot } = {}) {
  if (!key || !entry) return;
  if (_active?.key === key) { dismissKeywordTooltip(); return; }
  // Swap: tear down the current panel immediately (no lingering animation
  // overlap), then spawn the new one.
  if (_active) { try { _active.el.remove(); } catch {} _active = null; }
  const el = _spawn(entry, cardRoot);
  _active = { key, el };
}
