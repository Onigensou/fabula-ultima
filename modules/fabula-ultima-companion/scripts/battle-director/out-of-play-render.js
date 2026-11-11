// ============================================================================
// Out of play — how it is drawn (every client): a token whose actor is out of
// play (out-of-play.js) is not on the field, so its mesh, bars, nameplate,
// effect icons, border, tooltip and sprite shadow stay hidden, every frame, on
// every client (the GM too: it is not a hidden token, it is not there).
//
// Every frame rather than on refresh hooks: Foundry, the 3D camera and the
// idle animations all write the mesh's alpha, so the last word has to come just
// before the render (the same place the Sealing Crystal host hides its mesh).
// The token document is never touched, so taking the effect off brings it back
// with Foundry's own next refresh.
// ============================================================================

import { warn } from "./logger.js";
import { isOutOfPlay } from "./out-of-play.js";
import { holdShadow } from "../sealing-crystal/crystal-host-lib.js";

const _held = new Map();   // tokenId -> token we have hidden

function hide(t) {
  try { if (t.mesh) t.mesh.alpha = 0; } catch { /* gone */ }
  for (const k of ["bars", "nameplate", "effects", "tooltip", "border", "targetArrows", "targetPips"]) {
    const o = t[k];
    if (o && !o.destroyed && o.visible) o.visible = false;
  }
  holdShadow(t, 0);
}
function restore(t) {
  if (!t || t.destroyed) return;
  holdShadow(t, 1);
  try { t.renderFlags?.set?.({ refreshState: true, refreshBars: true, refreshNameplate: true, refreshEffects: true, refreshVisibility: true }); } catch { /* older core */ }
}

function step() {
  if (!canvas?.ready) return;
  const seen = new Set();
  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.destroyed || !t.actor || !isOutOfPlay(t.actor)) continue;
    seen.add(t.id);
    _held.set(t.id, t);
    hide(t);
  }
  for (const [id, t] of _held) if (!seen.has(id)) { _held.delete(id); restore(t); }
}

let _ticker = null, _tickerOwner = null;
function ensureTicker() {
  const tk = canvas?.app?.ticker ?? (typeof PIXI !== "undefined" ? PIXI.Ticker.shared : null);
  if (!tk || (_ticker && _tickerOwner === tk)) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => { try { step(); } catch (e) { warn("out-of-play: step threw", e); } };
  _tickerOwner = tk;
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 1);
}

let _hooked = false;
export function initOutOfPlayRender() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  Hooks.on("canvasReady", () => { _held.clear(); ensureTicker(); });
  if (canvas?.ready) ensureTicker();
}
export const outOfPlayRenderStatus = () => ({ hidden: [..._held.values()].map((t) => t.name) });
