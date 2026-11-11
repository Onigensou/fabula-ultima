// ============================================================================
// The arena void — the arena goes PITCH BLACK under the battlers (every client).
//
// RULED (2026-11-10): the crystal phase is played in deep darkness; the ground is
// not visible at all, only the crystal's own light (and the battlers) remain.
// Nidhogg's fall turns it on as its smoke settles to black, and it stays through
// the Crystal Round; the dragon's return takes it away.
//
// Who holds it:
//   - a show, locally (holdArenaVoid(reason) -> release): the fall from its black
//     beat to its end;
//   - a STATE, on every client alike (registerVoidSource(fn)): fn(scene) -> true
//     while the void must be up; the Nidhogg rule reads its phase AE (F5-safe,
//     replicated), so a reload in the Crystal Round comes back black.
// The plate sits just above the backdrop, under every token (the death show's
// dark plate, the same sort keys), and covers the whole visible window with room
// for a screen shake. voidUp() tells the crystal host to stop clipping its light
// at the floor line (there is no floor to stop it).
// ============================================================================

import { warn } from "../battle-director/logger.js";

const _holds = new Map();      // id -> reason
const _sources = new Set();    // (scene) => boolean
let _seq = 0, _plate = null, _ticker = null, _tickerOwner = null;

/** Hold the void up on this client; returns the release (once). */
export function holdArenaVoid(reason = "hold") {
  const id = ++_seq;
  _holds.set(id, String(reason));
  ensureTicker();
  return () => { _holds.delete(id); };
}
/** A state that keeps the void up while fn(scene) is true. Returns the unregister. */
export function registerVoidSource(fn) {
  if (typeof fn !== "function") return () => {};
  _sources.add(fn);
  ensureTicker();
  return () => _sources.delete(fn);
}
/** True while the void is up on this client. */
export function voidUp() {
  if (_holds.size) return true;
  const scene = globalThis.canvas?.scene ?? null;
  for (const fn of _sources) { try { if (fn(scene)) return true; } catch { /* a source never breaks it */ } }
  return false;
}
export const arenaVoidStatus = () => ({ up: voidUp(), holds: [..._holds.values()], sources: _sources.size, plate: !!_plate?.visible });

function plate() {
  if (_plate && !_plate.destroyed && _plate.parent) return _plate;
  const prim = canvas?.primary;
  if (!prim) return null;
  const d = new PIXI.Sprite(PIXI.Texture.WHITE);
  d.tint = 0x000000; d.eventMode = "none"; d.name = "fud-arena-void";
  const bg = prim.background;
  d.elevation = bg?.elevation ?? -Infinity; d.sortLayer = bg?.sortLayer ?? 0; d.sort = (bg?.sort || 0) + 1;
  prim.addChild(d);
  prim.sortDirty = true;
  _plate = d;
  return d;
}
function step() {
  if (!canvas?.ready) return;
  const up = voidUp();
  if (!up) { if (_plate && !_plate.destroyed) _plate.visible = false; return; }
  const d = plate();
  if (!d) return;
  d.visible = true; d.alpha = 1;
  const st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1, pad = 400 / k;
  d.position.set(st.pivot.x - scr.width / (2 * k) - pad, st.pivot.y - scr.height / (2 * k) - pad);
  d.width = scr.width / k + 2 * pad; d.height = scr.height / k + 2 * pad;
}
function ensureTicker() {
  const tk = canvas?.app?.ticker ?? (typeof PIXI !== "undefined" ? PIXI.Ticker.shared : null);
  if (!tk || (_ticker && _tickerOwner === tk)) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => { try { step(); } catch (e) { warn("arena-void: step threw", e); } };
  _tickerOwner = tk;
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 1);
}

let _hooked = false;
export function initArenaVoid() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  Hooks.on("canvasReady", () => { _plate = null; ensureTicker(); });
  // a scene change ends every show's hold (the states read the new scene themselves)
  Hooks.on("canvasTearDown", () => { _holds.clear(); try { _plate?.destroy(); } catch { /* gone */ } _plate = null; });
  if (canvas?.ready) ensureTicker();
}
