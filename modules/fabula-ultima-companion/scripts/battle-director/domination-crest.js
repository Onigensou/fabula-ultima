// Dominance Crest — floating boss emblem showing banked Dominance Point(s).
//
// A small socket-and-gem crest hovering above a boss token whenever the
// "Dominance Point" pool AE exists on its actor: one diamond socket per point
// of cap, dark inset when empty, ignited red-orange gem (slow ember pulse)
// when banked. JRPG boost-pip vibes (Octopath boost / FFXIII stagger gem) —
// players read at a glance whether the boss is holding its Domination charge.
//
// Fully AE-replication-driven, like the Domination outline shimmer: the pool
// AE replicates to every client, so each client renders its own crest off
// createActiveEffect / updateActiveEffect / deleteActiveEffect hooks — zero
// socket traffic, F5-safe via the canvasReady rescan. Screen-space DOM
// repositioned per frame (same anchoring approach as the Octopath menu).
//
// Lifecycle: appears at the first Dominance accrual (round 3), stays as a dim
// socket after the point is spent (the pool AE is a persistent_counter that
// rests at 0), ignition flash on gain, dims on spend (the Domination burst
// covers the spend moment). Swept away with the pool AE at scene end.

import { log, warn } from "./logger.js";
import { findDominancePointAe, DOMINANCE_POINT_CAP } from "./domination.js";

const FLAG_NS = "fabula-ultima-companion";
const STYLE_ID = "fud-dominance-crest-style";

const _crests = new Map(); // tokenId -> { el, gems: HTMLElement[], lastCharges, missingFrames }
let _tickerOn = false;
let _hooksOn = false;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.fud-dom-crest {
  position: fixed; display: flex; gap: 7px; align-items: center;
  transform: translate(-50%, -100%);
  z-index: 99978; pointer-events: none;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.55));
}
.fud-dom-crest .gem {
  width: 13px; height: 13px; transform: rotate(45deg);
  border: 2px solid #4a3826;
  border-radius: 3px;
  background: radial-gradient(circle at 40% 35%, #2b2118 0%, #161009 80%);
  box-shadow: 0 0 0 1px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,255,255,.08);
  transition: background .3s ease, box-shadow .3s ease;
}
.fud-dom-crest .gem.is-lit {
  border-color: #8a4a1c;
  background: radial-gradient(circle at 38% 32%, #ffe9b0 0%, #ff9034 34%, #e0301a 72%, #7a0e08 100%);
  animation: fud-dom-gem-pulse 2.4s ease-in-out infinite;
}
.fud-dom-crest .gem.is-igniting {
  animation: fud-dom-gem-ignite .7s cubic-bezier(.2,1.6,.3,1) 1,
             fud-dom-gem-pulse 2.4s ease-in-out .7s infinite;
}
@keyframes fud-dom-gem-pulse {
  0%, 100% { box-shadow: 0 0 5px 1px rgba(255,90,30,.55), 0 0 0 1px rgba(0,0,0,.6); }
  50%      { box-shadow: 0 0 11px 3px rgba(255,140,50,.9), 0 0 0 1px rgba(0,0,0,.6); }
}
@keyframes fud-dom-gem-ignite {
  0%   { transform: rotate(45deg) scale(2.1); box-shadow: 0 0 26px 10px rgba(255,190,90,1); }
  100% { transform: rotate(45deg) scale(1); }
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

function readCharges(actor) {
  const ae = findDominancePointAe(actor);
  if (!ae) return null; // no pool at all → no crest
  const f = ae.flags?.[FLAG_NS] ?? {};
  return {
    charges: Math.max(0, Number(f.charges ?? 0) || 0),
    max: Math.max(1, Number(f.chargesMax ?? DOMINANCE_POINT_CAP) || 1),
  };
}

function buildCrest(token, pool) {
  ensureStyles();
  const el = document.createElement("div");
  el.className = "fud-dom-crest";
  const gems = [];
  for (let i = 0; i < pool.max; i++) {
    const g = document.createElement("div");
    g.className = "gem";
    el.appendChild(g);
    gems.push(g);
  }
  document.body.appendChild(el);
  const rec = { el, gems, lastCharges: -1, missingFrames: 0 };
  _crests.set(token.id, rec);
  paintCrest(rec, pool.charges, { ignite: false });
  if (!_tickerOn) { PIXI.Ticker.shared.add(crestTick); _tickerOn = true; }
  return rec;
}

function paintCrest(rec, charges, { ignite } = {}) {
  if (rec.lastCharges === charges) return;
  const gained = charges > rec.lastCharges && rec.lastCharges >= 0;
  rec.lastCharges = charges;
  rec.gems.forEach((g, i) => {
    const lit = i < charges;
    g.classList.toggle("is-lit", lit);
    g.classList.remove("is-igniting");
    if (lit && (ignite || gained)) {
      // restart the one-shot ignite animation
      void g.offsetWidth;
      g.classList.add("is-igniting");
    }
  });
}

function dropCrest(tokenId) {
  const rec = _crests.get(tokenId);
  if (!rec) return;
  try { rec.el.remove(); } catch {}
  _crests.delete(tokenId);
  if (!_crests.size && _tickerOn) {
    try { PIXI.Ticker.shared.remove(crestTick); } catch {}
    _tickerOn = false;
  }
}

function crestTick() {
  if (!_crests.size) return;
  for (const [tokenId, rec] of _crests) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) {
      // Placeables rebuild across canvas redraws — short grace before drop.
      if (++rec.missingFrames > 30) dropCrest(tokenId);
      else rec.el.style.opacity = "0";
      continue;
    }
    rec.missingFrames = 0;
    const c = token.center ?? { x: token.x + (token.w ?? 100) / 2, y: token.y + (token.h ?? 100) / 2 };
    const pt = worldToClient(c.x, token.y);
    rec.el.style.left = `${pt.x}px`;
    rec.el.style.top = `${pt.y - 8}px`;
    // Follow the token's visibility (fog, Escape fade, hidden toggle).
    rec.el.style.opacity = token.visible === false ? "0" : String(token.alpha ?? 1);
  }
}

// Re-derive this actor's crest state on every of its canvas tokens.
function syncActorCrest(actor) {
  if (!actor) return;
  const pool = readCharges(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch {}
  for (const token of tokens) {
    if (!pool) { dropCrest(token.id); continue; }
    const rec = _crests.get(token.id) ?? buildCrest(token, pool);
    paintCrest(rec, pool.charges);
  }
}

function rescanCanvas() {
  for (const rec of _crests.values()) { try { rec.el.remove(); } catch {} }
  _crests.clear();
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor) syncActorCrest(token.actor);
  }
}

function isDominancePoolAe(effect) {
  const f = effect?.flags?.[FLAG_NS] ?? {};
  return String(f.chargeKey ?? "").trim().toLowerCase() === "dominance"
    || String(effect?.name ?? "").trim() === "Dominance Point";
}

// Idempotent — called on every client from director-boot's ready hook.
export function initDominationCrest() {
  if (_hooksOn) return;
  _hooksOn = true;
  const onAeEvent = (effect) => {
    if (isDominancePoolAe(effect) && effect.parent?.documentName === "Actor") {
      syncActorCrest(effect.parent);
    }
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);
  Hooks.on("canvasReady", rescanCanvas);
  if (canvas?.ready) rescanCanvas();
  log("dominance-crest: watcher installed");
}
