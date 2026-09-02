// ============================================================================
// Stealth Mode — the command blades.
//
// The Octopath-style menu the Battle Director already uses for a creature's
// turn, reused here so a stealth turn and a combat turn are operated the same
// way. Parchment-and-gold, anchored beside the acting token, one blade per
// command, staggered in.
//
// Deliberately a port of the LOOK rather than an import of the module: BD's
// turn-ui.js is bound to a combatant, a director instance and a page-flipping
// action list, none of which exist here. What carries over is the visual
// language — the same tokens (--fud-*), the same slide-in, the same hover.
//
// ── Sub-menus instead of dialogs ───────────────────────────────────────────
// Objective used to open a Foundry Dialog, which broke the flow: the player
// left the board, read a list, and came back. Now picking Objective swaps the
// blade stack in place for the objective list, with Back returning. One
// interaction model for the whole turn.
// ============================================================================

import { playUiHoverSfx, playUiClickSfx } from "../battle-director/director-ui-sfx.js";

const ROOT_ID = "oni-stealth-blades";
const STYLE_ID = "oni-stealth-blades-style";

const GAP_PX = 10;
const EDGE_PAD_X = 18;
const EDGE_PAD_Y = -6;
const DURATION_MS = 300;
const STAGGER_MS = 34;

let _root = null;
let _items = [];
let _anchorToken = null;
let _tickHandle = null;
let _hooks = [];

// ── Styles ──────────────────────────────────────────────────────────────────
// The --fud-* tokens are the Battle Director's, copied verbatim so the two
// menus cannot drift apart in a later theme pass.

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = STYLE_ID;
  css.textContent = `
    #${ROOT_ID}{
      position:fixed; left:0; top:0; z-index:70; pointer-events:none;
      --sm-parchment-top:#f6f1e6;
      --sm-parchment-bot:#ebe3d0;
      --sm-ink:#3a3228;
      --sm-gold-1:#d5b67a;
      --sm-gold-2:#b7935a;
      --sm-stroke:#7a6a55;
      --sm-shadow:rgba(41,33,24,.55);
      --sm-highlight:rgba(255,255,255,.7);
    }
    #${ROOT_ID} .sm-item{ position:absolute; transform-origin:left center; pointer-events:auto; }
    #${ROOT_ID} .sm-blade{
      position:relative; display:inline-flex; align-items:center; gap:8px;
      padding:9px 15px 9px 20px;
      color:var(--sm-ink);
      font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
      font-weight:800; letter-spacing:.32px; text-transform:uppercase; white-space:nowrap;
      font-size:13px; user-select:none; cursor:pointer; opacity:0;
      background:linear-gradient(180deg,var(--sm-parchment-top),var(--sm-parchment-bot));
      border:2px solid var(--sm-stroke); border-radius:12px;
      box-shadow:0 4px 0 var(--sm-shadow), 0 0 0 1px var(--sm-highlight) inset;
      text-shadow:0 1px 0 var(--sm-highlight);
      transition: margin-left .12s ease-out, filter .12s ease, box-shadow .12s ease;
      will-change: margin-left, filter, box-shadow;
    }
    #${ROOT_ID} .sm-blade::before{
      content:""; position:absolute; left:-12px; top:50%; transform:translateY(-50%);
      width:12px; height:76%;
      background:linear-gradient(180deg,var(--sm-gold-1),var(--sm-gold-2));
      border:2px solid var(--sm-stroke); border-right:none; border-radius:10px 0 0 10px;
      box-shadow:0 0 0 1px var(--sm-highlight) inset;
    }
    #${ROOT_ID} .sm-blade:hover:not(.is-disabled){
      margin-left:-6px; filter:brightness(1.04);
      box-shadow:0 6px 0 var(--sm-shadow), 0 0 0 1px var(--sm-highlight) inset;
    }
    #${ROOT_ID} .sm-blade.is-disabled{
      cursor:not-allowed; filter:grayscale(.6) brightness(.85); opacity:.55 !important;
    }
    #${ROOT_ID} .sm-blade .sm-note{
      font-weight:700; font-size:10.5px; letter-spacing:.2px; text-transform:none;
      opacity:.62; margin-left:2px;
    }
    /* Back reads as a way out, not another choice: cool grey-green edge. */
    #${ROOT_ID} .sm-blade.is-back::before{
      background:linear-gradient(180deg,#b9b2a2,#8e8778);
    }
  `;
  document.head.appendChild(css);
}

// ── Anchoring ───────────────────────────────────────────────────────────────

function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

function worldAnchor(token) {
  if (!token || token.destroyed) return null;
  const c = token.center ?? { x: (token.x ?? 0) + (token.w ?? 100) / 2, y: (token.y ?? 0) + (token.h ?? 100) / 2 };
  return { x: c.x + (token.w ?? 100) * 0.55, y: c.y - (token.h ?? 100) * 0.10 };
}

function layout() {
  if (!_items.length || !_anchorToken || _anchorToken.destroyed) return;
  const a = worldAnchor(_anchorToken);
  if (!a) return;
  const ctr = worldToClient(a.x, a.y);

  const h = _items[0].el.getBoundingClientRect().height || 34;
  const rowH = h + GAP_PX;
  // Grow UPWARD from the token, the way BD's stack does, so the list never
  // covers the ground the player is about to walk onto.
  const rise = rowH * (_items.length - 1);

  for (let i = 0; i < _items.length; i++) {
    const it = _items[i];
    it.x = ctr.x + EDGE_PAD_X;
    it.y = (ctr.y - rise) + EDGE_PAD_Y + i * rowH;
    it.el.style.left = `${it.x}px`;
    it.el.style.top = `${it.y}px`;
  }
}

// ── Spawn / despawn ─────────────────────────────────────────────────────────

/**
 * Show a stack of command blades beside `token`.
 *
 * @param {Token} token
 * @param {Array<{id,label,note?,disabled?,reason?,back?}>} commands
 * @param {(id:string)=>void} onPick
 */
export function showBlades(token, commands, onPick) {
  hideBlades();
  if (!token || !commands?.length) return;
  ensureStyles();

  _anchorToken = token;
  _root = document.createElement("div");
  _root.id = ROOT_ID;
  document.body.appendChild(_root);

  const start = performance.now();

  commands.forEach((cmd, i) => {
    const wrap = document.createElement("div");
    wrap.className = "sm-item";

    const blade = document.createElement("div");
    blade.className = "sm-blade" + (cmd.disabled ? " is-disabled" : "") + (cmd.back ? " is-back" : "");
    blade.innerHTML = cmd.note
      ? `<span>${cmd.label}</span><span class="sm-note">${cmd.note}</span>`
      : `<span>${cmd.label}</span>`;
    if (cmd.disabled && cmd.reason) blade.title = cmd.reason;

    // Same cursor cues the Battle Director menus use, so the two feel like one
    // interface rather than two systems that happen to share a palette.
    blade.addEventListener("pointerenter", () => { if (!cmd.disabled) playUiHoverSfx(); });
    blade.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (cmd.disabled) return;
      playUiClickSfx();
      onPick?.(cmd.id);
    });
    // The blades sit over the canvas; without this a click also reaches the
    // board handler and spends a move on whatever tile is underneath.
    blade.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    wrap.appendChild(blade);
    _root.appendChild(wrap);
    _items.push({ el: wrap, blade, delay: i * STAGGER_MS, x: 0, y: 0 });
  });

  layout();

  // Slide + fade in, staggered. Runs on the ticker so it stays in step with
  // canvas panning rather than fighting it.
  _tickHandle = () => {
    const now = performance.now();
    layout();
    for (const it of _items) {
      const t = Math.min(1, Math.max(0, (now - start - it.delay) / DURATION_MS));
      const k = 1 - Math.pow(1 - t, 3);
      it.blade.style.opacity = String(k);
      it.blade.style.transform = `translateX(${(1 - k) * -26}px)`;
    }
  };
  canvas.app.ticker.add(_tickHandle);

  for (const h of ["canvasPan", "canvasReady"]) {
    const id = Hooks.on(h, layout);
    _hooks.push({ h, id });
  }
}

export function hideBlades() {
  if (_tickHandle) { try { canvas.app.ticker.remove(_tickHandle); } catch (_) {} _tickHandle = null; }
  for (const { h, id } of _hooks) { try { Hooks.off(h, id); } catch (_) {} }
  _hooks = [];
  _items = [];
  _anchorToken = null;
  try { _root?.remove(); } catch (_) {}
  _root = null;
}

export const bladesVisible = () => !!_root;
