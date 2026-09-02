// ============================================================================
// Stealth Mode — canvas overlay: vision cones, reachable cells, path arrow.
//
// One persistent PIXI.Graphics per layer, cleared and redrawn rather than
// created and destroyed — the shape dp-overlay.js uses, for the same reason:
// a redraw that allocates is a redraw that stutters.
//
// ── The cone is the whole indicator ────────────────────────────────────────
// A chevron for facing plus a shaded tile-set for range was two marks saying
// one thing, and on an alerted map the tile-sets overlapped into static. Now
// a single smooth wedge radiates from the guard along its facing and fades out
// at its rim; its COLOUR carries that guard.s state — calm, suspicious,
// hunting. Direction and threat in one shape, and nothing to read through.
//
// ── Layering ───────────────────────────────────────────────────────────────
// Everything sits on the PRIMARY group, BELOW tokens. A cone drawn over a
// guard would hide the guard, and the cone exists to say where the guard is
// looking, not to replace them.
// ============================================================================

import { ALERT, AI } from "./sm-constants.js";
import { centerOf, topLeftOf, gridSize, facingVector } from "./sm-grid.js";


const Z_CONE  = 55;
const Z_REACH = 60;
const Z_MARK  = 65;

// Warm parchment/gold to match the Battle Director's surfaces; the alert
// colours stay hot so they read as a warning against it.
const COL = Object.freeze({
  reach:      0xd5b67a,   // gold — the same token as a BD blade edge
  reachEdge:  0xf6f1e6,
  arrow:      0xf3d98b,
  arrowEdge:  0x7a6a55,
  calm:       0x6fbfa3,
  suspicious: 0xe8c05a,
  hunting:    0xef6a58,
});

let _cones = null;
let _reach = null;
let _marks = null;

function layerParent() {
  return canvas?.primary ?? canvas?.stage ?? null;
}

function ensure(ref, name, z) {
  if (ref && !ref.destroyed) return ref;
  const parent = layerParent();
  if (!parent) return null;
  const g = new PIXI.Graphics();
  g.name = name;
  g.zIndex = z;
  g.eventMode = "none";     // never steal a click from the board
  parent.sortableChildren = true;
  parent.addChild(g);
  return g;
}

export function clearAll() {
  for (const g of [_cones, _reach, _marks]) if (g && !g.destroyed) g.clear();
}

export function destroyAll() {
  for (const g of [_cones, _reach, _marks]) {
    try { if (g && !g.destroyed) { g.parent?.removeChild(g); g.destroy(); } } catch (_) {}
  }
  _cones = _reach = _marks = null;
}

// ── Vision cones ────────────────────────────────────────────────────────────

/** A guard's colour comes from what IT is doing, not the scene-wide tier. */
function coneColor(enemy) {
  if (enemy.ai === AI.CHASE || enemy.ai === AI.SEARCH) return COL.hunting;
  if (enemy.ai === AI.SUSPICIOUS) return COL.suspicious;
  return COL.calm;
}

/**
 * Draw every guard's vision cone.
 *
 * ── Why this is NOT the per-tile detection map ─────────────────────────────
 * An earlier pass shaded every watched TILE. It was accurate and unreadable:
 * on an alerted map a dozen overlapping tile-grids turned the board into
 * static, and the thing a player actually needs — which way is this guard
 * looking, and how worried should I be — was buried in it.
 *
 * So the drawn cone is a single smooth wedge that fades to nothing at its
 * outer edge, and the exact per-cell detection set stays in sm-vision.js where
 * the rules read it. The picture is a cue; the maths is still exact.
 *
 * The fade is built from concentric wedge bands rather than a real gradient,
 * because PIXI.Graphics has no radial gradient fill and a band stack is both
 * cheaper and sharper than a generated texture.
 */
export function drawCones(enemies, tune) {
  _cones = ensure(_cones, "Stealth Cones", Z_CONE);
  if (!_cones) return;
  _cones.clear();

  const gs = gridSize();
  const base = tune?.coneAlpha ?? 0.13;
  const half = ((tune?.coneHalfAngle ?? 45) * Math.PI) / 180;
  const range = (tune?.visionRange ?? 8) * gs;

  for (const e of (enemies ?? [])) {
    if (!e?.cell) continue;
    const color = coneColor(e);
    const hot = e.ai === AI.CHASE || e.ai === AI.SEARCH;
    const warm = e.ai === AI.SUSPICIOUS;
    const gain = hot ? 2.2 : warm ? 1.6 : 1.0;

    drawFadedWedge(centerOf(e.cell), e.facing, range, half, color, base * gain);
  }
}

/**
 * A wedge that fades out toward its far edge.
 *
 * BANDS bands from the origin outward, each an annular slice, alpha falling
 * on a curve so the near end reads solid and the far end dissolves instead of
 * ending on a hard line. The hard line was what made the old cone look pasted
 * onto the map.
 */
function drawFadedWedge(origin, facing, range, halfAngle, color, peakAlpha) {
  const v = facingVector(facing);
  const a0 = Math.atan2(v.y, v.x);
  const BANDS = 14;
  const STEPS = 14;              // arc resolution per band

  for (let b = 0; b < BANDS; b++) {
    const r0 = (b / BANDS) * range;
    const r1 = ((b + 1) / BANDS) * range;
    const t = b / (BANDS - 1);

    // Quadratic falloff: holds near the guard, dissolves fast at the rim.
    const alpha = peakAlpha * Math.pow(1 - t, 2.1);
    if (alpha < 0.004) continue;

    _cones.beginFill(color, alpha);
    // Outward along one edge...
    for (let i = 0; i <= STEPS; i++) {
      const ang = a0 - halfAngle + (2 * halfAngle * i) / STEPS;
      const x = origin.x + Math.cos(ang) * r1;
      const y = origin.y + Math.sin(ang) * r1;
      if (i === 0) _cones.moveTo(x, y); else _cones.lineTo(x, y);
    }
    // ...and back along the inner arc, so the band is a closed ring slice.
    for (let i = STEPS; i >= 0; i--) {
      const ang = a0 - halfAngle + (2 * halfAngle * i) / STEPS;
      _cones.lineTo(origin.x + Math.cos(ang) * r0, origin.y + Math.sin(ang) * r0);
    }
    _cones.closePath();
    _cones.endFill();
  }

  // A bright core at the guard's own tile, so facing survives a cone that a
  // wall or a short range has squashed to almost nothing.
  _cones.beginFill(color, Math.min(0.6, peakAlpha * 3));
  _cones.moveTo(origin.x, origin.y);
  for (let i = 0; i <= STEPS; i++) {
    const ang = a0 - halfAngle + (2 * halfAngle * i) / STEPS;
    _cones.lineTo(origin.x + Math.cos(ang) * range * 0.14, origin.y + Math.sin(ang) * range * 0.14);
  }
  _cones.closePath();
  _cones.endFill();
}

// ── Reachable cells ─────────────────────────────────────────────────────────

/**
 * Highlight what the party can reach.
 *
 * Only drawn while movement mode is engaged. Permanently lit tiles turned the
 * board into a permanent glow that competed with the cones — which are the
 * information the player is actually reading.
 */
export function drawReachable(reach) {
  _reach = ensure(_reach, "Stealth Reachable", Z_REACH);
  if (!_reach) return;
  _reach.clear();
  if (!reach) return;

  const gs = gridSize();
  const inset = Math.max(1, gs * 0.08);
  const size = gs - inset * 2;

  for (const node of reach.values()) {
    if (node.cost === 0) continue;         // the party's own tile needs no mark
    const p = topLeftOf(node.cell);
    // Gold fill carries the colour; the pale edge is only a rim. Weighted the
    // other way the white rim dominated on a dark map and the whole set read
    // as grey static rather than as warm, walkable ground.
    _reach.lineStyle(Math.max(1, gs * 0.035), COL.reachEdge, 0.2);
    _reach.beginFill(COL.reach, 0.3);
    _reach.drawRoundedRect(p.x + inset, p.y + inset, size, size, gs * 0.16);
    _reach.endFill();
    _reach.lineStyle(0);
  }
}

// ── The path arrow ──────────────────────────────────────────────────────────

/**
 * Trace a route as an ARROW rather than a hairline.
 *
 * A plain polyline was ambiguous about direction and vanished against a busy
 * map. A thick gold stroke with a dark casing reads at any zoom, and the head
 * says which end is the destination without the player having to infer it.
 */
export function drawPathArrow(path, origin) {
  _marks = ensure(_marks, "Stealth Marks", Z_MARK);
  if (!_marks || !path?.length) return;

  const gs = gridSize();
  const pts = [origin ? centerOf(origin) : null, ...path.map((c) => centerOf(c))].filter(Boolean);
  if (pts.length < 2) return;

  const bodyW = Math.max(3, gs * 0.17);
  const caseW = bodyW + Math.max(2, gs * 0.07);

  // Stop the shaft short so it does not poke through the arrowhead.
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dx = last.x - prev.x, dy = last.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const headLen = gs * 0.46;
  const shaftEnd = { x: last.x - ux * headLen * 0.72, y: last.y - uy * headLen * 0.72 };
  const shaft = [...pts.slice(0, -1), shaftEnd];

  const stroke = (width, color, alpha) => {
    _marks.lineStyle({ width, color, alpha, join: "round", cap: "round" });
    _marks.moveTo(shaft[0].x, shaft[0].y);
    for (const p of shaft.slice(1)) _marks.lineTo(p.x, p.y);
    _marks.lineStyle(0);
  };

  stroke(caseW, COL.arrowEdge, 0.85);   // dark casing, for contrast on any map
  stroke(bodyW, COL.arrow, 0.95);

  // Head
  const hw = gs * 0.3;
  const px = -uy, py = ux;
  const baseX = last.x - ux * headLen, baseY = last.y - uy * headLen;

  _marks.lineStyle({ width: Math.max(2, gs * 0.05), color: COL.arrowEdge, alpha: 0.85, join: "round" });
  _marks.beginFill(COL.arrow, 0.95);
  _marks.moveTo(last.x, last.y);
  _marks.lineTo(baseX + px * hw, baseY + py * hw);
  _marks.lineTo(baseX - px * hw, baseY - py * hw);
  _marks.closePath();
  _marks.endFill();
  _marks.lineStyle(0);

  // A ring on the destination tile — the arrow says direction, this says
  // "and you stop exactly here".
  _marks.lineStyle(Math.max(2, gs * 0.05), COL.arrow, 0.5);
  _marks.drawCircle(last.x, last.y, gs * 0.42);
  _marks.lineStyle(0);
}

export function clearMarks() {
  if (_marks && !_marks.destroyed) _marks.clear();
}

/** Ring a cell — a takedown target, a diversion point, a scan result. */
export function markCell(cell, { color = 0xf3d98b, alpha = 0.9, filled = false } = {}) {
  _marks = ensure(_marks, "Stealth Marks", Z_MARK);
  if (!_marks || !cell) return;
  const gs = gridSize();
  const c = centerOf(cell);
  if (filled) {
    _marks.beginFill(color, alpha * 0.28);
    _marks.drawCircle(c.x, c.y, gs * 0.38);
    _marks.endFill();
  }
  _marks.lineStyle(Math.max(2, gs * 0.06), color, alpha);
  _marks.drawCircle(c.x, c.y, gs * 0.38);
  _marks.lineStyle(0);
}
