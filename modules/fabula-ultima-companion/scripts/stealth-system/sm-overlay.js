// ============================================================================
// Stealth Mode — canvas overlay: reachable cells, vision cones, facing.
//
// One persistent PIXI.Graphics per layer, cleared and redrawn rather than
// created and destroyed — the same shape dp-overlay.js uses, for the same
// reason: a hover redraw that allocates is a hover redraw that stutters.
//
// ── Layering ───────────────────────────────────────────────────────────────
// Cones and reachability sit on the PRIMARY canvas group, BELOW tokens. A cone
// drawn over a guard would hide the guard, and the cone exists to tell you
// where the guard is looking, not to replace them.
//
// The cone doubles as the facing indicator. Tokens here have no directional
// art and vertical-flipping an orthographic sprite looks wrong, so rather than
// invent a second marker the thing that already communicates danger also
// communicates heading — one glance, not two.
// ============================================================================

import { ALERT_COLOR, ARC } from "./sm-constants.js";
import {
  centerOf, topLeftOf, gridSize, cellKey, facingVector, DIR_ANGLE,
} from "./sm-grid.js";
import { visibleCells } from "./sm-vision.js";

const Z_REACH = 60;
const Z_CONE  = 55;
const Z_MARK  = 65;

let _reach = null;
let _cones = null;
let _marks = null;

function layerParent() {
  // Below tokens, above the background.
  return canvas?.primary ?? canvas?.stage ?? null;
}

function ensure(ref, name, z) {
  if (ref && !ref.destroyed) return ref;
  const parent = layerParent();
  if (!parent) return null;
  const g = new PIXI.Graphics();
  g.name = name;
  g.zIndex = z;
  g.eventMode = "none";     // never steal a click from the canvas
  parent.sortableChildren = true;
  parent.addChild(g);
  return g;
}

export function clearAll() {
  for (const g of [_reach, _cones, _marks]) {
    if (g && !g.destroyed) g.clear();
  }
}

export function destroyAll() {
  for (const g of [_reach, _cones, _marks]) {
    try { if (g && !g.destroyed) { g.parent?.removeChild(g); g.destroy(); } } catch (_) {}
  }
  _reach = _cones = _marks = null;
}

// ── Reachability ────────────────────────────────────────────────────────────

/**
 * Highlight every cell the party can reach.
 * `reach` is the Map returned by sm-lattice.reachable().
 */
export function drawReachable(reach, { color = 0x4fd1a5, alpha = 0.16 } = {}) {
  _reach = ensure(_reach, "Stealth Reachable", Z_REACH);
  if (!_reach) return;
  _reach.clear();
  if (!reach) return;

  const gs = gridSize();
  const inset = Math.max(1, gs * 0.06);

  for (const node of reach.values()) {
    if (node.cost === 0) continue;   // the party's own cell needs no highlight
    const p = topLeftOf(node.cell);
    _reach.beginFill(color, alpha);
    _reach.drawRoundedRect(p.x + inset, p.y + inset, gs - inset * 2, gs - inset * 2, gs * 0.12);
    _reach.endFill();
  }
}

/** Trace a committed path, so the player sees the route before it walks. */
export function drawPath(path, { color = 0xffffff, alpha = 0.7 } = {}) {
  _marks = ensure(_marks, "Stealth Marks", Z_MARK);
  if (!_marks || !path?.length) return;
  const gs = gridSize();
  _marks.lineStyle(Math.max(2, gs * 0.06), color, alpha);
  const start = centerOf(path[0]);
  _marks.moveTo(start.x, start.y);
  for (const cell of path.slice(1)) {
    const c = centerOf(cell);
    _marks.lineTo(c.x, c.y);
  }
  _marks.lineStyle(0);
}

// ── Vision cones + facing ───────────────────────────────────────────────────

/**
 * Draw every enemy's cone and facing chevron.
 * @param {Array<{cell,facing,ai,awareness}>} enemies
 */
export function drawCones(enemies, tune, { alertTier = "stealth" } = {}) {
  _cones = ensure(_cones, "Stealth Cones", Z_CONE);
  _marks = ensure(_marks, "Stealth Marks", Z_MARK);
  if (!_cones) return;

  _cones.clear();
  if (_marks && !_marks.destroyed) _marks.clear();

  const gs = gridSize();
  const tierColor = Number(String(ALERT_COLOR[alertTier] ?? "#ffffff").replace("#", "0x"));

  for (const e of (enemies ?? [])) {
    if (!e?.cell) continue;

    // Colour by what this guard is doing, not by the global tier — a single
    // hunting guard in an otherwise calm room is the thing worth seeing.
    const hot = e.ai === "chase" || e.ai === "search";
    const warm = e.ai === "suspicious";
    const color = hot ? 0xf26b5b : warm ? 0xe8c05a : tierColor;
    const alpha = tune.coneAlpha * (hot ? 1.6 : warm ? 1.3 : 1);

    for (const v of visibleCells(e.cell, e.facing, tune)) {
      const p = topLeftOf(v.cell);
      _cones.beginFill(color, v.near ? alpha * 1.7 : alpha);
      _cones.drawRect(p.x, p.y, gs, gs);
      _cones.endFill();
    }

    drawFacingChevron(e, color, gs);
  }
}

/**
 * A chevron on the facing edge of the guard's own cell.
 *
 * Small and low-contrast on purpose: the cone carries the information, and a
 * loud arrow on every guard turns a stealth map into a christmas tree.
 */
function drawFacingChevron(enemy, color, gs) {
  if (!_marks || _marks.destroyed) return;

  const c = centerOf(enemy.cell);
  const v = facingVector(enemy.facing);
  const r = gs * 0.42;
  const tip = { x: c.x + v.x * r, y: c.y + v.y * r };

  // Perpendicular, for the chevron's two trailing arms.
  const px = -v.y;
  const py = v.x;
  const arm = gs * 0.16;
  const back = gs * 0.14;

  _marks.lineStyle(Math.max(2, gs * 0.055), color, 0.95);
  _marks.moveTo(tip.x - v.x * back + px * arm, tip.y - v.y * back + py * arm);
  _marks.lineTo(tip.x, tip.y);
  _marks.lineTo(tip.x - v.x * back - px * arm, tip.y - v.y * back - py * arm);
  _marks.lineStyle(0);
}

/** Ring a cell — the takedown target, a diversion point, a spawn marker. */
export function markCell(cell, { color = 0xffd966, alpha = 0.9, filled = false } = {}) {
  _marks = ensure(_marks, "Stealth Marks", Z_MARK);
  if (!_marks || !cell) return;
  const gs = gridSize();
  const c = centerOf(cell);
  if (filled) {
    _marks.beginFill(color, alpha * 0.3);
    _marks.drawCircle(c.x, c.y, gs * 0.38);
    _marks.endFill();
  }
  _marks.lineStyle(Math.max(2, gs * 0.06), color, alpha);
  _marks.drawCircle(c.x, c.y, gs * 0.38);
  _marks.lineStyle(0);
}
