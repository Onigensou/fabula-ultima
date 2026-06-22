// scripts/battle-director/invoke/invoke-hud.js
// DOM-based invoke HUD — replaces Foundry Dialog popups with an in-game
// overlay that slides in to the right of the action card.
//
// Singleton: at most one HUD (trait or bond) can be alive at once.
// Mutual exclusion: opening a new type auto-dismisses the current one.
// Toggle: calling dismissActive() from outside (e.g. re-clicking the
//   invoke button on the action card) closes the active HUD.
//
// Stable import URL (no ?cb= cache-bust) so the module singleton
// persists across cache-busted invoke-worker loads.

import { playSfx } from "../director-sfx.js";

const HUD_ID    = "fud-invoke-hud";
const DIMMER_ID = "fud-invoke-dimmer";
const AURA_ID   = "fud-invoke-aura";
const CSS_ID    = "fud-invoke-hud-style";

// All SFX go through playSfx (Web Audio, same pipeline as main BD hits/heals).
// dieSelect = longer cue (selecting), dieDeselect = short cue (unselecting).
const SFX = Object.freeze({
  trait:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Ougi1.ogg",
  bond:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/EXSkill.ogg",
  cancel:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_cleared.wav",
  hover:       "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
  confirm:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fabula_Point.ogg",
  dieSelect:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_5.wav",
  dieDeselect: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_5_Short.wav",
  dice:        "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav",
  traitUp:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/trait_up1.wav",
  traitDown:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/trait_down2.wav",
});

// All invoke SFX URLs exported so director-vfx can warm them at battle start.
export const INVOKE_SFX_URLS = Object.values(SFX);

// ── Singleton ─────────────────────────────────────────────────────────────────

let _active   = null; // { type, el, _resolve }
let _dimmerEl = null;
let _auraEl   = null;

export function getActiveType() {
  return _active?.type ?? null;
}

// Called externally (action-card toggle, or cleanup on card close).
export function dismissActive({ root, ar } = {}) {
  if (!_active) return;
  const { el, _resolve, type } = _active;
  _active = null;
  if (root && ar) _restoreCardFromAr(root, ar);
  // Spectator HUDs have no interaction to cancel — skip the cancel cue.
  if (type !== "spectator") _playHud(SFX.cancel);
  _despawnDimmer();
  _despawnAura();
  _despawn(el, _resolve ? () => _resolve(null) : undefined);
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function _playHud(url, vol = 0.8) {
  try { playSfx(url, vol); } catch {}
}

let _lastHoverMs = 0;
function playHoverSfx() {
  const now = Date.now();
  if (now - _lastHoverMs < 80) return;
  _lastHoverMs = now;
  _playHud(SFX.hover, 0.4);
}

// ── Styles ────────────────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = `
    /* ── Invoke HUD panel ── */
    #${HUD_ID} {
      position: fixed;
      z-index: 96;
      width: 256px;
      pointer-events: none;
      opacity: 0;
      transform: translateX(-16px);
      transition: opacity 200ms ease-out, transform 200ms cubic-bezier(.2,.7,.2,1);
      font-family: "Inter","Signika","Segoe UI",system-ui,sans-serif;
    }
    #${HUD_ID}.is-visible {
      pointer-events: auto;
      opacity: 1;
      transform: translateX(0);
    }
    #${HUD_ID}.is-dismissing {
      opacity: 0 !important;
      transform: translateX(-16px) !important;
      pointer-events: none !important;
      transition: opacity 200ms ease-in, transform 200ms cubic-bezier(.8,0,.8,.3) !important;
    }

    /* ── Screen dimmer ── */
    #${DIMMER_ID} {
      position: fixed;
      inset: 0;
      z-index: 40;
      background: rgba(0,0,0,0.55);
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease-out;
    }
    #${DIMMER_ID}.is-visible { opacity: 1; }
    #${DIMMER_ID}.is-dismissing {
      opacity: 0 !important;
      transition: opacity 450ms ease-in !important;
    }

    /* ── Token aura ── */
    #${AURA_ID} {
      position: fixed;
      z-index: 41;
      pointer-events: none;
      transform: translate(-50%, -50%);
      opacity: 0;
      transition: opacity 250ms ease-out;
    }
    #${AURA_ID}.is-visible { opacity: 1; }
    #${AURA_ID}.is-dismissing {
      opacity: 0 !important;
      transition: opacity 400ms ease-in !important;
    }
    .fud-invoke-aura-glow {
      position: absolute;
      inset: -15%;
      border-radius: 50%;
      background: radial-gradient(ellipse at center,
        rgba(255,153,36,0.50) 0%,
        rgba(255,120,20,0.22) 40%,
        transparent           72%);
      animation: fud-invoke-glow-pulse 2s ease-in-out infinite;
    }
    .fud-invoke-particle {
      position: absolute;
      width: 2px;
      height: 30px;
      border-radius: 1px;
      background: linear-gradient(to bottom,
        rgba(255,153,36,0)   0%,
        rgba(255,153,36,.9) 35%,
        rgba(255,203,66,1)  50%,
        rgba(255,153,36,.9) 65%,
        rgba(255,153,36,0) 100%);
      box-shadow: 0 0 4px rgba(255,153,36,.9);
      animation: fud-invoke-particle-rise 0.75s linear infinite both;
    }

    /* ── Card shell ── */
    .fud-ih-card {
      width: 100%;
      padding: 12px 13px 11px;
      border: 2px solid var(--fud-stroke,#7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top,#f6f1e6), var(--fud-parchment-bot,#ebe3d0));
      box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.45) inset;
      color: var(--fud-ink,#3a3228);
    }
    .fud-ih-header {
      font-size: 11px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
      opacity: .6; margin-bottom: 3px;
    }
    .fud-ih-title {
      font-size: 15px; font-weight: 900; margin-bottom: 10px; color: var(--fud-ink,#3a3228);
    }

    /* ── Trait: die cards ── */
    .fud-ih-dice-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 8px;
    }
    .fud-ih-die {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 8px 6px; border-radius: 10px; cursor: pointer; user-select: none;
      border: 2px solid rgba(87,58,33,.6);
      background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.4) 0%, transparent 40%),
        linear-gradient(180deg, #f6ebd3 0%, #e7d3b1 100%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 3px 8px rgba(0,0,0,.18);
      transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .fud-ih-die:hover { filter: brightness(1.05); }
    .fud-ih-die.on {
      border-color: #e35151;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 3px 8px rgba(0,0,0,.18),
        0 0 10px rgba(227,81,81,.4);
      background: radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.6) 0%,
        rgba(255,255,255,.2) 30%, transparent 60%),
        linear-gradient(180deg, #fff3dc 0%, #e8cea0 100%);
    }
    .fud-ih-die-icon  { width:32px; height:32px; object-fit:contain; border:none; background:transparent; border-radius:0; box-shadow:none; outline:none; }
    .fud-ih-die-label { font-size:11px; font-weight:700; opacity:.65; line-height:1; }
    .fud-ih-die-val   { font-size:24px; font-weight:900; line-height:1; margin-top:1px; }

    /* ── Bond: row list ── */
    .fud-ih-bond-list  { display:flex; flex-direction:column; gap:5px; margin-bottom:8px; }
    .fud-ih-bond-row {
      display: grid; grid-template-columns: 1fr auto auto; align-items: center;
      gap: 7px; padding: 6px 9px;
      border: 2px solid rgba(87,58,33,.55); border-radius: 10px;
      background: linear-gradient(180deg, #f6ebd3, #e7d3b1);
      cursor: pointer; user-select: none;
      transition: filter .1s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .fud-ih-bond-row:hover { filter: brightness(1.04); }
    .fud-ih-bond-row.sel {
      border-color: #FFBB55;
      box-shadow: 0 0 0 2px rgba(255,187,85,.28), 0 3px 8px rgba(0,0,0,.15);
    }
    .fud-ih-bond-name   { font-size:13px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fud-ih-bond-hearts { display:flex; gap:2px; align-items:center; }
    .fud-ih-bond-bonus  { font-size:17px; font-weight:400; font-style:italic; min-width:22px; text-align:right; }

    /* ── Shared ── */
    .fud-ih-hint {
      font-size: 11px; opacity: .62; margin-bottom: 10px; line-height: 1.45;
    }
    .fud-ih-btns { display: flex; gap: 6px; }
    .fud-ih-btn {
      flex: 1; padding: 7px 0; border: none; border-radius: 9px;
      font-size: 13px; font-weight: 800; letter-spacing: .2px;
      cursor: pointer; user-select: none;
      transition: filter .1s ease, transform .06s ease;
    }
    .fud-ih-btn:active { transform: translateY(1px); }
    .fud-ih-confirm {
      background: linear-gradient(180deg, #c9a24a, #a07a28);
      color: #fff8e7;
      box-shadow: 0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.22);
    }
    .fud-ih-confirm:hover:not(:disabled) { filter: brightness(1.09); }
    .fud-ih-confirm:disabled { opacity: .38; cursor: default; pointer-events: none; }
    .fud-ih-cancel {
      background: rgba(87,58,33,.1);
      color: var(--fud-ink,#3a3228);
      border: 1.5px solid rgba(87,58,33,.3);
    }
    .fud-ih-cancel:hover { background: rgba(87,58,33,.18); }

    /* ── Spectator (read-only mirror) ── */
    #${HUD_ID}.is-spectating .fud-ih-card { cursor: default; }
    #${HUD_ID}.is-spectating .fud-ih-die,
    #${HUD_ID}.is-spectating .fud-ih-bond-row { cursor: default; pointer-events: none; }
    .fud-ih-spectate-tag {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
      opacity: .7; margin-bottom: 9px; color: #a07a28;
    }
    .fud-ih-spectate-tag .dot {
      width: 7px; height: 7px; border-radius: 50%; background: #c9a24a;
      box-shadow: 0 0 6px rgba(201,162,74,.8);
      animation: fud-ih-spectate-pulse 1.1s ease-in-out infinite;
    }
    @keyframes fud-ih-spectate-pulse {
      0%, 100% { opacity: .35; transform: scale(.8); }
      50%      { opacity: 1;   transform: scale(1.15); }
    }

    /* ── Aura keyframes ── */
    @keyframes fud-invoke-glow-pulse {
      0%, 100% { opacity: 0.35; transform: scale(1); }
      50%      { opacity: 0.72; transform: scale(1.08); }
    }
    @keyframes fud-invoke-particle-rise {
      0%   { opacity: 0;   transform: translateY(10px)   translateX(0); }
      12%  { opacity: 1; }
      75%  { opacity: 0.7; }
      100% { opacity: 0;   transform: translateY(-200px) translateX(var(--pdx, 0px)); }
    }
  `;
  document.head.appendChild(s);
}

// ── Number bounce animation ───────────────────────────────────────────────────

let _bounceStyleInjected = false;
function _ensureBounceStyle() {
  if (_bounceStyleInjected) return;
  _bounceStyleInjected = true;
  const s = document.createElement("style");
  s.id = "fud-num-anim-style";
  s.textContent = `@keyframes fud-num-bounce{0%{transform:scale(1)}18%{transform:scale(1.5)}55%{transform:scale(0.88)}80%{transform:scale(1.04)}100%{transform:scale(1)}}`;
  document.head.appendChild(s);
}

export function animateAccTotal(totalEl, toVal) {
  if (!totalEl) return;
  const fromVal = parseInt(totalEl.textContent, 10) || 0;
  if (fromVal === toVal) { totalEl.textContent = toVal; return; }

  _ensureBounceStyle();
  totalEl.style.display = "inline-block";
  totalEl.style.transformOrigin = "center";
  totalEl.style.animation = "none";
  void totalEl.offsetWidth;
  totalEl.style.animation = "fud-num-bounce 650ms cubic-bezier(.15,.8,.2,1) forwards";

  const duration = 700;
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    totalEl.textContent = Math.round(fromVal + (toVal - fromVal) * eased);
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      totalEl.textContent = toVal;
      setTimeout(() => { if (totalEl) totalEl.style.animation = ""; }, 100);
    }
  }
  requestAnimationFrame(tick);
}

// ── Screen dimmer ─────────────────────────────────────────────────────────────
// Uses a PIXI Graphics rect injected into canvas.primary so it sits above the
// scene background but below the token layer and all DOM HUDs.
// Falls back to a DOM div if PIXI/canvas is unavailable.

function _spawnDimmer() {
  // If a prior PIXI graphic was orphaned (canvas rebuilt on scene change), clear ref.
  if (_dimmerEl && !(_dimmerEl instanceof HTMLElement) && !_dimmerEl.parent) {
    _dimmerEl = null;
  }
  if (_dimmerEl) return;

  // ── PIXI path ──
  try {
    if (window.PIXI && canvas?.primary) {
      const g = new PIXI.Graphics();
      // PIXI v8 API; fall back to v7 if needed.
      try { g.rect(-50000, -50000, 100000, 100000).fill(0x000000); }
      catch { g.beginFill(0x000000).drawRect(-50000, -50000, 100000, 100000).endFill(); }
      g.alpha = 0;
      canvas.primary.addChild(g);
      // If canvas.tokens is a sibling layer above canvas.primary in the stage,
      // our graphic is already below tokens. If tokens are inside canvas.primary,
      // push the graphic below them.
      if (canvas.tokens?.parent === canvas.primary) {
        try {
          const ti = canvas.primary.getChildIndex(canvas.tokens);
          canvas.primary.setChildIndex(g, ti);
        } catch {}
      }
      _dimmerEl = g;
      const TARGET = 0.5, DURATION = 120, t0 = performance.now();
      const fi = (now) => {
        if (_dimmerEl !== g) return;
        g.alpha = Math.min((now - t0) / DURATION, 1) * TARGET;
        if (g.alpha < TARGET) requestAnimationFrame(fi);
      };
      requestAnimationFrame(fi);
      return;
    }
  } catch {}

  // ── DOM fallback ──
  const el = document.createElement("div");
  el.id = DIMMER_ID;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
  _dimmerEl = el;
}

function _despawnDimmer() {
  const d = _dimmerEl;
  if (!d) return;
  _dimmerEl = null;

  if (d instanceof HTMLElement) {
    d.classList.add("is-dismissing");
    const cleanup = () => { try { d.remove(); } catch {} };
    d.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 600);
  } else {
    // PIXI Graphics — rAF fade-out then destroy
    const startAlpha = d.alpha;
    const DURATION = 450, t0 = performance.now();
    const fo = (now) => {
      if (!d.parent) { try { d.destroy(); } catch {} return; }
      const t = Math.min((now - t0) / DURATION, 1);
      d.alpha = startAlpha * (1 - t);
      if (t < 1) requestAnimationFrame(fo);
      else { try { d.parent.removeChild(d); d.destroy(); } catch {} }
    };
    requestAnimationFrame(fo);
  }
}

// ── Token aura ────────────────────────────────────────────────────────────────
// Positions a glow + particle effect centered on the attacking token.
// Pure DOM/CSS — no PIXI involvement.

// 12 vertical-line particles: spread across token width, staggered across 0.75s cycle
const _PARTICLES = [
  { lp: 30, tp: 88, dx:  -6, delay: 0.00 },
  { lp: 55, tp: 85, dx:   4, delay: 0.14 },
  { lp: 44, tp: 92, dx:   0, delay: 0.28 },
  { lp: 70, tp: 87, dx:   8, delay: 0.40 },
  { lp: 22, tp: 90, dx:  -9, delay: 0.55 },
  { lp: 51, tp: 84, dx:   5, delay: 0.08 },
  { lp: 38, tp: 91, dx:  -4, delay: 0.68 },
  { lp: 63, tp: 89, dx:   7, delay: 0.32 },
  { lp: 46, tp: 86, dx:  -2, delay: 0.47 },
  { lp: 76, tp: 93, dx:  -7, delay: 0.62 },
  { lp: 15, tp: 88, dx:   3, delay: 0.22 },
  { lp: 58, tp: 86, dx:   6, delay: 0.75 },
];

function _getTokenScreenRect(tokenUuid) {
  if (!tokenUuid) return null;
  try {
    const token = canvas?.tokens?.placeables?.find(t => t.document?.uuid === tokenUuid);
    if (!token) return null;
    const st = canvas.stage?.worldTransform;
    if (!st) return null;
    const scale = st.a;
    const canvasEl = document.getElementById("board") ?? canvas.app?.view ?? null;
    const bounds = canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0 };
    const cx = bounds.left + (token.x + token.w / 2) * scale + st.tx;
    const cy = bounds.top  + (token.y + token.h / 2) * scale + st.ty;
    return { cx, cy, w: token.w * scale, h: token.h * scale };
  } catch { return null; }
}

function _spawnAura(tokenUuid) {
  if (_auraEl) return;
  const rect = _getTokenScreenRect(tokenUuid);
  if (!rect) return; // token not on canvas — skip silently

  const size = Math.max(rect.w, rect.h) * 1.9;
  const el = document.createElement("div");
  el.id = AURA_ID;
  el.style.left   = `${rect.cx}px`;
  el.style.top    = `${rect.cy}px`;
  el.style.width  = `${size}px`;
  el.style.height = `${size}px`;

  const glow = document.createElement("div");
  glow.className = "fud-invoke-aura-glow";
  el.appendChild(glow);

  for (const p of _PARTICLES) {
    const span = document.createElement("span");
    span.className = "fud-invoke-particle";
    span.style.left = `${p.lp}%`;
    span.style.top  = `${p.tp}%`;
    span.style.setProperty("--pdx", `${p.dx}px`);
    span.style.animationDelay = `${p.delay}s`;
    el.appendChild(span);
  }

  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
  _auraEl = el;
}

function _despawnAura() {
  const el = _auraEl;
  if (!el) return;
  _auraEl = null;
  el.classList.add("is-dismissing");
  const cleanup = () => { try { el.remove(); } catch {} };
  el.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 600);
}

// ── DOM lifecycle ─────────────────────────────────────────────────────────────

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );

function _positionHud(el, cardRoot) {
  const card = cardRoot?.querySelector?.(".fud-bf-card");
  if (card) {
    const r = card.getBoundingClientRect();
    const hudW = 256 + 4;
    const left = Math.min(r.right + 8, window.innerWidth - hudW - 8);
    el.style.left      = `${left}px`;
    el.style.top       = `${r.top}px`;
    el.style.maxHeight = `${window.innerHeight - r.top - 12}px`;
    el.style.overflowY = "auto";
  } else {
    el.style.left = "calc(50% + 172px)";
    el.style.top  = "20%";
  }
}

function _attachHoverSfx(el) {
  for (const b of el.querySelectorAll(".fud-ih-die, .fud-ih-btn")) {
    b.addEventListener("mouseenter", playHoverSfx);
  }
}

function _spawnEl(html, cardRoot) {
  document.getElementById(HUD_ID)?.remove();
  const el = document.createElement("div");
  el.id = HUD_ID;
  el.innerHTML = html;
  document.body.appendChild(el);
  _positionHud(el, cardRoot);
  _attachHoverSfx(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")));
  return el;
}

function _despawn(el, onDone) {
  if (!el?.parentNode) { onDone?.(); return; }
  el.style.pointerEvents = "none";
  // Use WAAPI instead of CSS class-swap — avoids transition-property race
  // that caused the cancel-button route to not animate.
  const anim = el.animate(
    [
      { opacity: "1", transform: "translateX(0)" },
      { opacity: "0", transform: "translateX(-16px)" },
    ],
    { duration: 200, easing: "cubic-bezier(.8,0,.8,.3)", fill: "forwards" }
  );
  const cleanup = () => { try { el.remove(); } catch {} onDone?.(); };
  anim.addEventListener("finish", cleanup, { once: true });
  setTimeout(cleanup, 350);
}

// Despawns the HUD panel, dimmer, and aura, then resolves the Promise.
function _resolveHud(el, resolveFn, result, sfxKey) {
  if (_active?.el === el) _active = null;
  if (sfxKey) _playHud(SFX[sfxKey]);
  _despawnDimmer();
  _despawnAura();
  _despawn(el, () => resolveFn(result));
}

// ── Bond card preview helpers ─────────────────────────────────────────────────

function _previewBondOnCard(root, ar, bonus) {
  if (!root || !ar?.roll) return;
  const roll     = ar.roll;
  const newCB    = (Number(roll.checkBonus) || 0) + bonus;
  const newTotal = (Number(roll.rA) || 0) + (Number(roll.rB) || 0) + newCB;

  const totalEl = root.querySelector(".fud-bf-acc-row .total");
  if (totalEl) totalEl.textContent = newTotal;

  const accRow = root.querySelector(".fud-bf-acc-row");
  if (accRow) {
    let pill = accRow.querySelector(".bonus");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "bonus fud-ih-preview-bonus";
      const spacer = accRow.querySelector(".spacer");
      if (spacer) accRow.insertBefore(pill, spacer);
      else accRow.appendChild(pill);
    }
    if (newCB !== 0) {
      pill.textContent = newCB >= 0 ? `+${newCB}` : `${newCB}`;
      pill.style.display = "";
    } else {
      pill.style.display = "none";
    }
  }

  const rows      = root.querySelectorAll(".fud-bf-target-row");
  const ptResults = ar.perTargetResults ?? [];
  rows.forEach((row, i) => {
    const r = ptResults[i];
    if (!r) return;
    // DEF unknown — never reveal hit/miss in preview
    if (r.studied === false) return;
    const resultEl = row.querySelector(".t-result");
    if (!resultEl) return;
    const hit   = roll.isCrit || (!roll.isFumble && newTotal >= (r.defense ?? 0));
    const cls   = roll.isCrit ? "crit" : hit ? "hit" : "miss";
    const label = roll.isCrit ? "Critical Hit" : hit ? "Hit" : "Miss";
    resultEl.className   = `t-result ${cls}`;
    resultEl.textContent = label;
  });
}

function _restoreCardFromAr(root, ar) {
  if (!root || !ar?.roll) return;
  const roll = ar.roll;

  const totalEl = root.querySelector(".fud-bf-acc-row .total");
  if (totalEl) totalEl.textContent = roll.total;

  const accRow = root.querySelector(".fud-bf-acc-row");
  if (accRow) {
    const pill = accRow.querySelector(".bonus");
    const cb   = Number(roll.checkBonus) || 0;
    if (cb !== 0) {
      if (pill) {
        pill.textContent   = cb >= 0 ? `+${cb}` : `${cb}`;
        pill.style.display = "";
      } else {
        const p = document.createElement("span");
        p.className   = "bonus";
        p.textContent = cb >= 0 ? `+${cb}` : `${cb}`;
        const spacer = accRow.querySelector(".spacer");
        if (spacer) accRow.insertBefore(p, spacer);
        else accRow.appendChild(p);
      }
    } else if (pill) {
      pill.style.display = "none";
    }
  }

  const rows      = root.querySelectorAll(".fud-bf-target-row");
  const ptResults = ar.perTargetResults ?? [];
  rows.forEach((row, i) => {
    const r = ptResults[i];
    if (!r || r.studied === false) return; // keep ??? masking for unstudied targets
    const resultEl = row.querySelector(".t-result");
    if (!resultEl || resultEl.textContent.trim() === "???") return;
    const cls   = r.isCrit ? "crit" : r.hit ? "hit" : "miss";
    const label = r.isCrit ? "Critical Hit" : r.hit ? "Hit" : "Miss";
    resultEl.className   = `t-result ${cls}`;
    resultEl.textContent = label;
  });
}

// ── Trait outcome sound ───────────────────────────────────────────────────────

export function playTraitOutcomeSfx(oldTotal, newTotal) {
  _playHud(SFX.dice, 0.85);
  setTimeout(() => {
    _playHud(newTotal >= oldTotal ? SFX.traitUp : SFX.traitDown, 0.9);
  }, 1800);
}

// ── Trait HUD ─────────────────────────────────────────────────────────────────

const ATTR_ICONS = {
  DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
  MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
  INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
};
const iconFor = (attr) =>
  ATTR_ICONS[String(attr || "").toUpperCase()] ??
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";

export function showTraitHUD({ roll, root, tokenUuid = null, onSelectionChange = null }) {
  ensureStyles();
  if (_active) {
    const old = _active;
    _active = null;
    _despawn(old.el, () => old._resolve(null));
  }
  _playHud(SFX.trait, 0.3);

  const { A1, A2, dA, dB, rA, rB } = roll;
  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Trait</div>
    <div class="fud-ih-title">Choose which die to reroll</div>
    <div class="fud-ih-dice-grid">
      <div class="fud-ih-die" data-which="A" tabindex="0" role="checkbox" aria-checked="false">
        <img class="fud-ih-die-icon" src="${iconFor(A1)}" alt="${esc(A1)}">
        <span class="fud-ih-die-label">d${esc(dA)}</span>
        <span class="fud-ih-die-val">${esc(rA)}</span>
      </div>
      <div class="fud-ih-die" data-which="B" tabindex="0" role="checkbox" aria-checked="false">
        <img class="fud-ih-die-icon" src="${iconFor(A2)}" alt="${esc(A2)}">
        <span class="fud-ih-die-label">d${esc(dB)}</span>
        <span class="fud-ih-die-val">${esc(rB)}</span>
      </div>
    </div>
    <div class="fud-ih-hint">Click one or both to select. Click again to deselect.</div>
    <div class="fud-ih-btns">
      <button class="fud-ih-btn fud-ih-confirm" data-confirm disabled>Reroll</button>
      <button class="fud-ih-btn fud-ih-cancel"  data-cancel>Cancel</button>
    </div>
  </div>`;

  const el = _spawnEl(html, root);
  _spawnDimmer();
  _spawnAura(tokenUuid);

  return new Promise((resolve) => {
    _active = { type: "trait", el, _resolve: resolve };

    const confirmBtn = el.querySelector("[data-confirm]");
    const dieA = el.querySelector('[data-which="A"]');
    const dieB = el.querySelector('[data-which="B"]');

    const updateConfirm = () => {
      confirmBtn.disabled = !(dieA.classList.contains("on") || dieB.classList.contains("on"));
    };
    const toggle = (dieEl) => {
      const next = !dieEl.classList.contains("on");
      dieEl.classList.toggle("on", next);
      dieEl.setAttribute("aria-checked", String(next));
      _playHud(next ? SFX.dieSelect : SFX.dieDeselect, 0.7);
      updateConfirm();
      // Live-selection echo — let spectators watch the dice light up.
      try { onSelectionChange?.({ a: dieA.classList.contains("on"), b: dieB.classList.contains("on") }); } catch {}
    };

    for (const [dieEl, peer] of [[dieA, dieB], [dieB, dieA]]) {
      dieEl.addEventListener("click", () => toggle(dieEl));
      dieEl.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(dieEl); }
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); peer.focus(); }
      });
    }

    confirmBtn.addEventListener("click", () => {
      const aOn = dieA.classList.contains("on");
      const bOn = dieB.classList.contains("on");
      const choice = aOn && bOn ? "AB" : aOn ? "A" : bOn ? "B" : null;
      _playHud(SFX.dice, 0.85);
      _resolveHud(el, resolve, choice, null);
    });

    el.querySelector("[data-cancel]").addEventListener("click", () => {
      _resolveHud(el, resolve, null, "cancel");
    });
  });
}

// ── Bond HUD ──────────────────────────────────────────────────────────────────

function _svgHeart(state) {
  const fill = state === "pos" ? "#E85A70" : "#7B62C0";
  return `<svg viewBox="0 0 16 16" width="13" height="13" style="display:block;flex-shrink:0">
    <path d="M8 13.8s-4.8-3.3-6-5.3C1 5.7 2.1 3.4 4.1 3.2c1.2-.1 2.2.4 2.9 1.2.6-.8 1.6-1.3 2.9-1.2 2 .2 3 2.3 2.1 4.2-1.1 2-6 6.4-6 6.4z"
          fill="${fill}" stroke="#5A4637" stroke-width="1.1"/>
  </svg>`;
}

function _bondHearts(actor, bondIndex) {
  const P = actor?.system?.props ?? {};
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const SLOTS = [
    { pos: "admiration", neg: "inferiority" },
    { pos: "loyalty",    neg: "mistrust"    },
    { pos: "affection",  neg: "hatred"      },
  ];
  const hearts = [];
  for (const [i, s] of SLOTS.entries()) {
    const v = norm(P[`emotion_${bondIndex}_${i + 1}`]);
    if (v === s.pos) hearts.push("pos");
    else if (v === s.neg) hearts.push("neg");
  }
  hearts.sort((a, b) => (a === "pos" ? -1 : b === "pos" ? 1 : 0));
  return hearts;
}

function _bondRowHTML(bond, i, selIdx, actor) {
  const hearts = _bondHearts(actor, bond.index).map(_svgHeart).join("");
  return `<div class="fud-ih-bond-row${i === selIdx ? " sel" : ""}"
             data-bidx="${i}" tabindex="0" role="option"
             aria-selected="${i === selIdx ? "true" : "false"}">
    <span class="fud-ih-bond-name">${esc(bond.name)}</span>
    <span class="fud-ih-bond-hearts">${hearts}</span>
    <span class="fud-ih-bond-bonus">+${bond.bonus}</span>
  </div>`;
}

export async function showBondHUD({ bonds, attacker, root, ar, tokenUuid = null, onSelectionChange = null }) {
  const viable = bonds.filter((b) => (b?.bonus || 0) > 0);
  if (!viable.length) return null;
  if (viable.length === 1) return viable[0].index;

  ensureStyles();
  if (_active) {
    const old = _active;
    _active = null;
    _despawn(old.el, () => old._resolve(null));
  }
  _playHud(SFX.bond, 0.3);

  let selectedIdx = 0;
  const buildList = () =>
    viable.map((b, i) => _bondRowHTML(b, i, selectedIdx, attacker)).join("");

  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Bond</div>
    <div class="fud-ih-title">Choose a Bond</div>
    <div class="fud-ih-bond-list" role="listbox">${buildList()}</div>
    <div class="fud-ih-hint">Bond bonus is +1 per filled emotion (max +3).</div>
    <div class="fud-ih-btns">
      <button class="fud-ih-btn fud-ih-confirm" data-confirm>Invoke</button>
      <button class="fud-ih-btn fud-ih-cancel"  data-cancel>Cancel</button>
    </div>
  </div>`;

  const el = _spawnEl(html, root);
  _spawnDimmer();
  _spawnAura(tokenUuid);

  return new Promise((resolve) => {
    _active = { type: "bond", el, _resolve: resolve };

    const list       = el.querySelector(".fud-ih-bond-list");
    const confirmBtn = el.querySelector("[data-confirm]");

    let _restoreTimer = null;
    const scheduleRestore = () => {
      _restoreTimer = setTimeout(() => {
        if (ar && root) _restoreCardFromAr(root, ar);
      }, 60);
    };
    const cancelRestore = () => clearTimeout(_restoreTimer);

    const refresh = () => {
      list.innerHTML = buildList();
      for (const row of list.querySelectorAll(".fud-ih-bond-row")) {
        const i = Number(row.dataset.bidx);
        row.addEventListener("mouseenter", () => {
          cancelRestore();
          playHoverSfx();
          if (ar && root) _previewBondOnCard(root, ar, viable[i].bonus);
          // Live-selection echo — spectator highlight follows the actor's cursor.
          try { onSelectionChange?.({ idx: i }); } catch {}
        });
        row.addEventListener("mouseleave", () => { scheduleRestore(); });
        row.addEventListener("click", () => {
          selectedIdx = i; refresh();
          try { onSelectionChange?.({ idx: i }); } catch {}
        });
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
            ev.preventDefault();
            selectedIdx = Math.max(0, Math.min(viable.length - 1, selectedIdx + (ev.key === "ArrowUp" ? -1 : 1)));
            refresh();
            list.querySelector(`[data-bidx="${selectedIdx}"]`)?.focus();
            try { onSelectionChange?.({ idx: selectedIdx }); } catch {}
          }
          if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); row.click(); }
        });
      }
    };
    refresh();

    confirmBtn.addEventListener("click", () => {
      cancelRestore();
      if (ar && root) _restoreCardFromAr(root, ar);
      const chosen = viable[selectedIdx];
      _resolveHud(el, resolve, chosen?.index ?? null, "confirm");
    });

    el.querySelector("[data-cancel]").addEventListener("click", () => {
      cancelRestore();
      if (ar && root) _restoreCardFromAr(root, ar);
      _resolveHud(el, resolve, null, "cancel");
    });
  });
}

// ── Spectator HUDs (read-only mirror) ──────────────────────────────────────────
// Shown on every NON-acting client while the actor decides. Same dimmer + aura +
// panel + open cue as the real HUD, but no interaction and no Promise — the panel
// is a window into what the actor is doing, torn down by dismissSpectator() when
// the actor commits (INVOKE_CHOICE → result animates via patchCardDom) or cancels.

// Supersede whatever HUD is currently up (real or spectator) before spawning a
// new spectator panel. A real HUD never coexists with a spectator one on the
// same client (the actor isn't a spectator of their own action), but the card
// could be re-broadcast; this keeps the singleton honest.
function _supersedeForSpectator() {
  if (!_active) return;
  const old = _active;
  _active = null;
  if (old._resolve) _despawn(old.el, () => old._resolve(null));
  else _despawn(old.el);
}

export function showTraitSpectator({ roll, actorName, root, tokenUuid = null }) {
  if (!roll) return null;
  ensureStyles();
  _supersedeForSpectator();
  _playHud(SFX.trait, 0.3);

  const { A1, A2, dA, dB, rA, rB } = roll;
  const who = esc(actorName || "The attacker");
  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Trait</div>
    <div class="fud-ih-title">${who} is rerolling…</div>
    <div class="fud-ih-spectate-tag"><span class="dot"></span>Spectating</div>
    <div class="fud-ih-dice-grid">
      <div class="fud-ih-die" data-which="A">
        <img class="fud-ih-die-icon" src="${iconFor(A1)}" alt="${esc(A1)}">
        <span class="fud-ih-die-label">d${esc(dA)}</span>
        <span class="fud-ih-die-val">${esc(rA)}</span>
      </div>
      <div class="fud-ih-die" data-which="B">
        <img class="fud-ih-die-icon" src="${iconFor(A2)}" alt="${esc(A2)}">
        <span class="fud-ih-die-label">d${esc(dB)}</span>
        <span class="fud-ih-die-val">${esc(rB)}</span>
      </div>
    </div>
    <div class="fud-ih-hint">Waiting for ${who} to choose which die to reroll…</div>
  </div>`;

  const el = _spawnEl(html, root);
  el.classList.add("is-spectating");
  _spawnDimmer();
  _spawnAura(tokenUuid);
  _active = { type: "spectator", kind: "trait", el, sel: { a: false, b: false } };
  return el;
}

export function showBondSpectator({ bonds, actorName, root, tokenUuid = null }) {
  const viable = (bonds ?? []).filter((b) => (b?.bonus || 0) > 0);
  if (!viable.length) return null;
  ensureStyles();
  _supersedeForSpectator();
  _playHud(SFX.bond, 0.3);

  const who  = esc(actorName || "The attacker");
  const rows = viable.map((b, i) => {
    const hearts = (b.hearts ?? []).map(_svgHeart).join("");
    return `<div class="fud-ih-bond-row${i === 0 ? " sel" : ""}" data-bidx="${i}">
      <span class="fud-ih-bond-name">${esc(b.name)}</span>
      <span class="fud-ih-bond-hearts">${hearts}</span>
      <span class="fud-ih-bond-bonus">+${b.bonus}</span>
    </div>`;
  }).join("");

  const html = `<div class="fud-ih-card">
    <div class="fud-ih-header">Invoke Bond</div>
    <div class="fud-ih-title">${who} is choosing a Bond…</div>
    <div class="fud-ih-spectate-tag"><span class="dot"></span>Spectating</div>
    <div class="fud-ih-bond-list" role="list">${rows}</div>
    <div class="fud-ih-hint">Waiting for ${who} to choose a Bond…</div>
  </div>`;

  const el = _spawnEl(html, root);
  el.classList.add("is-spectating");
  _spawnDimmer();
  _spawnAura(tokenUuid);
  _active = { type: "spectator", kind: "bond", el, sel: { idx: 0 } };
  return el;
}

// ── Live-selection appliers (Phase 2) ──────────────────────────────────────────
// Reflect the actor's in-progress selection onto this client's read-only
// spectator HUD. No-op unless a spectator HUD of the matching kind is up.

export function applyTraitSpectatorSelection({ a = false, b = false } = {}) {
  if (_active?.type !== "spectator" || _active.kind !== "trait") return;
  const el = _active.el;
  const prev = _active.sel ?? { a: false, b: false };
  const dieA = el.querySelector('.fud-ih-die[data-which="A"]');
  const dieB = el.querySelector('.fud-ih-die[data-which="B"]');
  if (dieA) dieA.classList.toggle("on", !!a);
  if (dieB) dieB.classList.toggle("on", !!b);
  // Tick cue when a die's state flips, matching the actor's own select/deselect.
  if (a !== prev.a) _playHud(a ? SFX.dieSelect : SFX.dieDeselect, 0.5);
  if (b !== prev.b) _playHud(b ? SFX.dieSelect : SFX.dieDeselect, 0.5);
  _active.sel = { a: !!a, b: !!b };
}

export function applyBondSpectatorSelection({ idx = 0 } = {}) {
  if (_active?.type !== "spectator" || _active.kind !== "bond") return;
  const el = _active.el;
  const prev = _active.sel?.idx ?? -1;
  const rows = el.querySelectorAll(".fud-ih-bond-row");
  rows.forEach((row, i) => row.classList.toggle("sel", i === idx));
  if (idx !== prev) playHoverSfx();
  _active.sel = { idx };
}

// Tear down the spectator HUD. On a committed trait reroll, pass
// { traitOutcome: { oldTotal, newTotal } } so the dice + up/down cue plays in
// sync with the card's result animation (patchCardDom). Otherwise a soft
// confirm/cancel cue plays. No-op if no spectator HUD is up. `expectKind`
// ("trait"|"bond") gates the dismiss so a stale close for one invoke type
// can't tear down a freshly-opened HUD of the other type (rapid type-switch).
export function dismissSpectator({ traitOutcome = null, cancelled = false, expectKind = null } = {}) {
  if (!_active || _active.type !== "spectator") return;
  if (expectKind && _active.kind !== expectKind) return;
  const { el } = _active;
  _active = null;
  if (traitOutcome) playTraitOutcomeSfx(traitOutcome.oldTotal, traitOutcome.newTotal);
  else _playHud(cancelled ? SFX.cancel : SFX.confirm, 0.6);
  _despawnDimmer();
  _despawnAura();
  _despawn(el);
}

// True when a read-only spectator HUD is currently shown on this client.
export function isSpectatorActive() {
  return _active?.type === "spectator";
}
