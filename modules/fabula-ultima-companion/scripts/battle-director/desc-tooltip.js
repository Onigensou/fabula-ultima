// Shared dwell-tooltip used by the action card's reaction pills,
// equipment options, item rows, skill rows — and by the token-anchored
// ReactionMenu's blades. Same visual + behavior everywhere.
//
// Surfaces tagged with `data-fud-equip-desc` (HTML body) and
// `data-fud-equip-desc-name` (header) auto-surface a styled tooltip
// after ~600ms hover dwell. Optional `data-fud-equip-stats` (HTML)
// renders a chip strip between name and body.
//
// API:
//   ensureDescTooltipStyles()
//     - Idempotent. Injects the singleton CSS rules on first call.
//
//   attachDescTooltip(rootEl, { isAlive })
//     - Binds mouseover / mouseout / scroll handlers to rootEl.
//       Hovering any descendant with [data-fud-equip-desc] or
//       [data-fud-equip-stats] schedules the tooltip after 600ms; the
//       tooltip is a body-mounted singleton (one instance shared
//       across all attachments) so multiple menus don't multiply DOM.
//     - `isAlive` (optional): function returning true while the menu /
//       card is still alive. When false at the dwell-fire moment, the
//       tooltip is suppressed (user already closed the surface).
//     - Returns a cleanup function — call when the surface unmounts.

import { warn } from "./logger.js";

const STYLE_ID = "fud-bf-desc-tip-style";
const SINGLETON_ID = "fud-bf-desc-tip-singleton";

export function ensureDescTooltipStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    .fud-bf-desc-tip {
      position: fixed;
      z-index: 2147483646;
      max-width: 340px;
      min-width: 200px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: var(--fud-parchment, #f1e6c4);
      color: var(--fud-ink, #3a3228);
      font-family: "Signika", "Roboto", sans-serif;
      font-size: 11.5px;
      line-height: 1.45;
      box-shadow: 0 6px 20px rgba(24, 28, 41, 0.45);
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .fud-bf-desc-tip.is-visible { opacity: 1; }
    .fud-bf-desc-tip .fud-bf-desc-tip-name {
      font-size: 12.5px;
      font-weight: 800;
      margin-bottom: 4px;
      color: var(--fud-ink, #3a3228);
      border-bottom: 1px dashed rgba(90, 106, 133, 0.35);
      padding-bottom: 3px;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 6px;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stats:empty { display: none; }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-acc,
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-dmg,
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-def {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-acc {
      background: rgba(122, 106, 85, 0.18);
      color: var(--fud-stroke, #7a6a55);
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-dmg {
      background: rgba(154, 75, 34, 0.18);
      color: #8a4b22;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-def {
      background: rgba(42, 110, 61, 0.18);
      color: #2a6e3d;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-trait {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.4px;
      background: rgba(58, 50, 40, 0.10);
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-trait.is-flag {
      background: rgba(154, 75, 34, 0.16);
      color: #8a4b22;
      text-transform: uppercase;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-body { font-weight: 400; }
    .fud-bf-desc-tip .fud-bf-desc-tip-body p { margin: 0 0 6px; }
    .fud-bf-desc-tip .fud-bf-desc-tip-body p:last-child { margin-bottom: 0; }

    /* Mode footer chip — small "Auto-apply / Asks" hint shown at the
       bottom of reaction tooltips. Same style as the action-card pill
       row's existing variant so the surfaces match. */
    .fud-bf-desc-tip .fud-bf-reaction-tip-foot {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed rgba(90, 106, 133, 0.35);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: rgba(58, 50, 40, 0.75);
    }
  `;
  document.head.appendChild(css);
}

function ensureSingletonEl() {
  let el = document.getElementById(SINGLETON_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = SINGLETON_ID;
  el.className = "fud-bf-desc-tip";
  el.innerHTML = `
    <div class="fud-bf-desc-tip-name"></div>
    <div class="fud-bf-desc-tip-stats"></div>
    <div class="fud-bf-desc-tip-body"></div>
  `;
  document.body.appendChild(el);
  return el;
}

function positionTip(tip, anchor) {
  const a = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 8;
  let left = a.right + margin;
  if (left + tipRect.width > window.innerWidth - 4) {
    left = Math.max(4, a.left - tipRect.width - margin);
  }
  let top = a.top;
  if (top + tipRect.height > window.innerHeight - 4) {
    top = Math.max(4, window.innerHeight - tipRect.height - 4);
  }
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}

const SELECTOR = "[data-fud-equip-desc], [data-fud-equip-stats]";

export function attachDescTooltip(rootEl, { isAlive } = {}) {
  if (!rootEl) return () => {};
  ensureDescTooltipStyles();

  let descShowTid = null;
  let descShowRaf = null;
  let descTarget = null;
  const alive = () => (typeof isAlive === "function" ? !!isAlive() : true);

  const showTip = (target) => {
    if (!alive()) return;
    const desc  = target.dataset.fudEquipDesc;
    const stats = target.dataset.fudEquipStats || "";
    if (!desc && !stats) return;
    const name = target.dataset.fudEquipDescName || "";
    const tip = ensureSingletonEl();
    tip.querySelector(".fud-bf-desc-tip-name").textContent = name;
    tip.querySelector(".fud-bf-desc-tip-stats").innerHTML = stats;
    // Description from CSB skill/item docs is local trusted HTML.
    tip.querySelector(".fud-bf-desc-tip-body").innerHTML = desc ?? "";
    positionTip(tip, target);
    if (descShowRaf != null) {
      try { cancelAnimationFrame(descShowRaf); } catch {}
    }
    descShowRaf = requestAnimationFrame(() => {
      descShowRaf = null;
      if (!alive()) return;
      tip.classList.add("is-visible");
    });
  };
  const hideTip = () => {
    try { clearTimeout(descShowTid); } catch {}
    descShowTid = null;
    if (descShowRaf != null) {
      try { cancelAnimationFrame(descShowRaf); } catch {}
      descShowRaf = null;
    }
    descTarget = null;
    const tip = document.getElementById(SINGLETON_ID);
    if (tip) tip.classList.remove("is-visible");
  };
  const onOver = (ev) => {
    const opt = ev.target?.closest?.(SELECTOR);
    if (!opt) return;
    if (opt === descTarget) return;
    hideTip();
    descTarget = opt;
    descShowTid = setTimeout(() => {
      if (descTarget === opt && document.body.contains(opt)) showTip(opt);
    }, 600);
  };
  const onOut = (ev) => {
    const opt = ev.target?.closest?.(SELECTOR);
    if (!opt) return;
    const next = ev.relatedTarget?.closest?.(SELECTOR);
    if (next === opt) return;
    hideTip();
  };

  try {
    rootEl.addEventListener("mouseover", onOver);
    rootEl.addEventListener("mouseout", onOut);
    rootEl.addEventListener("scroll", hideTip, true);
  } catch (e) { warn("attachDescTooltip: bind threw", e); }

  return () => {
    try { rootEl.removeEventListener("mouseover", onOver); } catch {}
    try { rootEl.removeEventListener("mouseout", onOut); } catch {}
    try { rootEl.removeEventListener("scroll", hideTip, true); } catch {}
    hideTip();
  };
}

// Manual hide — used by callers that close the surface programmatically
// (e.g. ReactionMenu.despawn) and want the tooltip to vanish even if
// the user's mouse was still hovering a blade at close time.
export function hideDescTooltip() {
  const tip = document.getElementById(SINGLETON_ID);
  if (tip) tip.classList.remove("is-visible");
}
