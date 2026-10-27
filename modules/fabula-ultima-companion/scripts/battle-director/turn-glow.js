// Acting-token glow — the creature whose turn it is breathes a soft outline
// and stands in a pool of floor light for the whole turn. Gold for the party,
// red for enemies. Glow only: nothing moves or scales.
//
// Driven by the round bar: renderTurnActionsLocal (director-round-banner.js)
// calls setTurnGlow with the spotlighted combatant on EVERY client, so the glow
// lands with the spotlight swap, leaves when the turn ends, and a reload or a
// late joiner picks it up from the next tracker snapshot. Nothing is written to
// the token; each client draws its own.
//
// The outline is a PIXI filter on the token mesh, re-attached every tick
// because other systems replace mesh.filters wholesale (target-picker dim,
// battler poses) and canvas redraws rebuild the placeable. The floor light is a
// sprite in the primary group sorted just under the tokens, positioned from
// the placeable each tick so it follows the turn step.

import { warn } from "./logger.js";

// "r,g,b" — the mockup's party gold / enemy red.
const SIDE_RGB = { party: [255, 216, 102], enemy: [255, 70, 60] };
// Gold reads brighter than red at the same strength, so the party's glow and
// floor light are toned down (user, 2026-10-26: "lessen the gold a bit").
const SIDE_STRENGTH = { party: 0.7, enemy: 1 };
const BREATH_MS = 3400;     // one way; alternates (in → out → in …)
const FADE_IN_MS = 450;
const FADE_OUT_MS = 300;
const FLOOR_ALPHA = 0.7;
// Just under the tokens (TOKENS = 700) and above drawings (600).
const FLOOR_SORT_LAYER = 699;

let _rec = null;            // { tokenId, side, start, fadeOutAt, glow, outline, floor }
let _tickerOn = false;
let _floorTexture = null;

const tokenIdOf = (uuid) => String(uuid ?? "").split(".Token.").pop()?.split(".")[0] || null;
const rgbHex = ([r, g, b]) => (r << 16) | (g << 8) | b;
// Eased 0..1..0 over 2×BREATH_MS (an alternate ease-in-out CSS animation).
const breath = (ms) => 0.5 - 0.5 * Math.cos((ms / BREATH_MS) * Math.PI);

// Show the glow on one token (or clear it with null). Idempotent per token.
export function setTurnGlow(target) {
  try {
    const tokenId = target?.tokenId ?? tokenIdOf(target?.tokenUuid);
    const side = target?.side === "enemy" ? "enemy" : "party";
    if (_rec && !_rec.fadeOutAt && _rec.tokenId === tokenId && _rec.side === side) return;
    if (_rec && !_rec.fadeOutAt) _rec.fadeOutAt = performance.now();
    if (!tokenId) return;
    // A token still fading out is replaced outright.
    if (_rec) dropRecord(_rec);
    _rec = { tokenId, side, start: performance.now(), fadeOutAt: null, glow: null, outline: null, floor: null };
    ensureTicker();
  } catch (e) { warn("setTurnGlow threw", e); }
}

function ensureTicker() {
  if (_tickerOn) return;
  try { PIXI.Ticker.shared.add(tick); _tickerOn = true; } catch (e) { warn("turn-glow: ticker add failed", e); }
}

function stopTicker() {
  if (!_tickerOn) return;
  try { PIXI.Ticker.shared.remove(tick); } catch { /* already gone */ }
  _tickerOn = false;
}

function makeFilters(rgb) {
  const color = rgbHex(rgb);
  const F = PIXI?.filters ?? {};
  let glow = null, outline = null;
  try {
    if (typeof F.GlowFilter === "function") {
      glow = new F.GlowFilter({ distance: 16, outerStrength: 2, innerStrength: 0, color, quality: 0.3 });
      glow.padding = 20;
    }
  } catch (e) { warn("turn-glow: GlowFilter failed", e); }
  try {
    if (typeof F.OutlineFilter === "function") {
      outline = new F.OutlineFilter(2, color, 0.3);
      outline.padding = 4;
    }
  } catch (e) { warn("turn-glow: OutlineFilter failed", e); }
  return { glow, outline };
}

// White radial pool; tinted per side.
function floorTexture() {
  if (_floorTexture && !_floorTexture.destroyed) return _floorTexture;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(255,255,255,.9)");
  grad.addColorStop(0.5, "rgba(255,255,255,.4)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  _floorTexture = PIXI.Texture.from(c);
  return _floorTexture;
}

function ensureFloor(rec, token) {
  const f = rec.floor;
  if (f && !f.destroyed && f.parent === canvas.primary) return f;
  try {
    const s = new PIXI.Sprite(floorTexture());
    s.anchor.set(0.5);
    s.tint = rgbHex(SIDE_RGB[rec.side]);
    s.blendMode = PIXI.BLEND_MODES.ADD;
    s.eventMode = "none";
    s.sortLayer = FLOOR_SORT_LAYER;
    s.elevation = Number(token.document?.elevation) || 0;
    s.sort = 0;
    canvas.primary.addChild(s);
    canvas.primary.sortDirty = true;
    rec.floor = s;
    return s;
  } catch (e) {
    warn("turn-glow: floor sprite failed", e);
    return null;
  }
}

function attachFilters(rec, mesh) {
  if (!rec.glow && !rec.outline) Object.assign(rec, makeFilters(SIDE_RGB[rec.side]));
  const want = [rec.outline, rec.glow].filter(Boolean);
  const have = mesh.filters ?? [];
  if (want.every((f) => have.includes(f))) return;
  mesh.filters = [...have.filter((f) => !want.includes(f)), ...want];
}

function detachFilters(rec, mesh) {
  if (!mesh?.filters) return;
  const mine = [rec.outline, rec.glow];
  const rest = mesh.filters.filter((f) => !mine.includes(f));
  mesh.filters = rest.length ? rest : null;
}

function dropRecord(rec) {
  try { detachFilters(rec, canvas?.tokens?.get?.(rec.tokenId)?.mesh); } catch { /* token gone */ }
  try { if (rec.floor && !rec.floor.destroyed) rec.floor.destroy(); } catch { /* canvas torn down */ }
  rec.floor = null;
  if (_rec === rec) _rec = null;
}

function tick() {
  const rec = _rec;
  if (!rec) { stopTicker(); return; }
  try {
    const now = performance.now();
    const token = canvas?.tokens?.get?.(rec.tokenId);
    const mesh = token?.mesh;
    if (!token || token.destroyed || !mesh || mesh.destroyed) {
      // Canvas redraw in progress, or the token left. Keep waiting while the
      // glow is meant to be on; a fading one just ends.
      if (rec.fadeOutAt) dropRecord(rec);
      return;
    }
    let k = Math.min(1, (now - rec.start) / FADE_IN_MS);
    if (rec.fadeOutAt) {
      k = Math.min(k, Math.max(0, 1 - (now - rec.fadeOutAt) / FADE_OUT_MS));
      if (k <= 0) { dropRecord(rec); return; }
    }
    const b = breath(now - rec.start);
    const s = SIDE_STRENGTH[rec.side] ?? 1;

    attachFilters(rec, mesh);
    if (rec.outline) {
      rec.outline.thickness = (2 + 0.5 * b) * k;
      try { rec.outline.alpha = k; } catch { /* older pixi-filters */ }
    }
    if (rec.glow) {
      rec.glow.outerStrength = (2 + 2.5 * b) * k * s;
      try { rec.glow.alpha = (0.8 + 0.15 * b) * k * s; } catch { /* older pixi-filters */ }
    }

    const floor = ensureFloor(rec, token);
    if (floor) {
      const w = Math.max(token.w * 0.9, Math.abs(mesh.width) * 1.7);
      const ay = mesh.anchor?.y ?? 0.5;
      floor.position.set(mesh.x, mesh.y + (1 - ay) * Math.abs(mesh.height) - w * 0.04);
      floor.width = w * (1 + 0.08 * b);
      floor.height = w * 0.29 * (1 + 0.12 * b);
      floor.alpha = FLOOR_ALPHA * (0.85 + 0.15 * (1 - b)) * k * s;
      const elev = Number(token.document?.elevation) || 0;
      if (floor.elevation !== elev) { floor.elevation = elev; canvas.primary.sortDirty = true; }
    }
  } catch (e) {
    warn("turn-glow: tick threw — dropping the glow", e);
    dropRecord(rec);
  }
}

Hooks.on("canvasTearDown", () => {
  // The primary group is destroyed with the canvas; the record survives and
  // rebuilds its sprite on the next canvas.
  if (_rec) _rec.floor = null;
});
