// ============================================================================
// Stealth Mode — grid adapter, facing, and relative position.
//
// The ONLY module that knows a square from a hex. Everything above it talks in
// cells ({i, j} row/column offsets) and compass directions, and stays honest on
// either grid.
//
// ── Why not just use Foundry's grid, or just write our own? ─────────────────
//
// Both, at different layers. Foundry's grid is a coordinate system:
// getOffset / getCenterPoint / getTopLeftPoint already agree with walls,
// lighting, token snapping, the camera and the ruler. Reimplementing it means
// reimplementing agreement with all five. So the coordinate maths is Foundry's.
//
// What Foundry gives us nothing for is the game: an occupancy lattice,
// movement points, wall-aware reachability, "every cell I can reach in five
// steps", an AI that can path. That is sm-lattice.js and sm-pathing.js, built
// on top of the adapter here.
//
// ── Facing ─────────────────────────────────────────────────────────────────
// Facing lives in data and overlay, never in the sprite. Tokens have no
// directional art and vertical-flipping an orthographic sprite looks wrong, so
// the vision cone drawn under the token IS the facing indicator — the player
// reads intent and danger in one glance instead of two.
// ============================================================================

import { ARC } from "./sm-constants.js";

// ── Direction vocabulary ────────────────────────────────────────────────────
// Screen space: Y increases downward, so 0° = East and angles run clockwise.
// Deliberately the same 8-key vocabulary dp-direction.js already uses, so a
// direction is portable between the two systems.

export const DIR8 = Object.freeze(["E", "SE", "S", "SW", "W", "NW", "N", "NE"]);

export const DIR_ANGLE = Object.freeze({
  E: 0, SE: 45, S: 90, SW: 135, W: 180, NW: -135, N: -90, NE: -45,
});

export const DIR_VECTOR = Object.freeze({
  E:  { di:  0, dj:  1 },
  SE: { di:  1, dj:  1 },
  S:  { di:  1, dj:  0 },
  SW: { di:  1, dj: -1 },
  W:  { di:  0, dj: -1 },
  NW: { di: -1, dj: -1 },
  N:  { di: -1, dj:  0 },
  NE: { di: -1, dj:  1 },
});

export const DIR_LABEL = Object.freeze({
  N: "North ↑", NE: "North-East ↗", E: "East →", SE: "South-East ↘",
  S: "South ↓", SW: "South-West ↙", W: "West ←", NW: "North-West ↖",
});

/** Six directions for hex-row grids, in the same screen-space convention. */
export const DIR6 = Object.freeze(["E", "SE", "SW", "W", "NW", "NE"]);

const norm180 = (deg) => {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

// ── Grid identity ───────────────────────────────────────────────────────────

const SQUARE = 1; // CONST.GRID_TYPES.SQUARE

export function isSquare(scene = canvas?.scene) {
  return Number(scene?.grid?.type ?? SQUARE) === SQUARE;
}

export function isHex(scene = canvas?.scene) {
  return Number(scene?.grid?.type ?? SQUARE) >= 2;
}

export function gridSize(scene = canvas?.scene) {
  return Number(canvas?.grid?.size ?? scene?.grid?.size ?? 100) || 100;
}

/** The direction set this scene's grid actually supports. */
export function directions(scene = canvas?.scene) {
  return isHex(scene) ? DIR6 : DIR8;
}

// ── Cell ↔ pixel ────────────────────────────────────────────────────────────
// A cell is { i, j } — row, column. Foundry v12 calls these "offsets" and
// returns them in exactly that shape, so no translation layer is needed.

export const cellKey = (cell) => `${cell.i},${cell.j}`;
export const keyToCell = (key) => {
  const [i, j] = String(key).split(",").map(Number);
  return { i, j };
};
export const sameCell = (a, b) => !!a && !!b && a.i === b.i && a.j === b.j;

/** Cell containing a pixel point. */
export function cellAt(point) {
  const o = canvas?.grid?.getOffset?.({ x: point.x, y: point.y });
  return o ? { i: o.i, j: o.j } : { i: 0, j: 0 };
}

/** Centre pixel of a cell. */
export function centerOf(cell) {
  const p = canvas?.grid?.getCenterPoint?.({ i: cell.i, j: cell.j });
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

/** Top-left pixel of a cell — where a 1×1 token document sits. */
export function topLeftOf(cell) {
  const p = canvas?.grid?.getTopLeftPoint?.({ i: cell.i, j: cell.j });
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

/** The cell a token currently occupies, from its CENTRE (size-agnostic). */
export function cellOfToken(token) {
  const doc = token?.document ?? token;
  if (!doc) return null;
  const gs = gridSize();
  const w = (Number(doc.width) || 1) * gs;
  const h = (Number(doc.height) || 1) * gs;
  return cellAt({ x: Number(doc.x) + w / 2, y: Number(doc.y) + h / 2 });
}

// ── Neighbours ──────────────────────────────────────────────────────────────

/**
 * The cells adjacent to `cell`, as { cell, dir }.
 *
 * Square grids use all eight. Hex-row grids use Foundry's own adjacency, since
 * odd/even row offsetting is exactly the kind of detail worth not reinventing;
 * each neighbour is then labelled with the compass direction closest to its
 * real bearing, so callers keep speaking one vocabulary.
 */
export function neighbours(cell, scene = canvas?.scene) {
  if (!isHex(scene)) {
    return DIR8.map((dir) => {
      const v = DIR_VECTOR[dir];
      return { cell: { i: cell.i + v.di, j: cell.j + v.dj }, dir };
    });
  }

  let raw = [];
  try {
    raw = canvas?.grid?.getAdjacentOffsets?.({ i: cell.i, j: cell.j }) ?? [];
  } catch (_) { raw = []; }

  return raw.map((o) => {
    const n = { i: o.i, j: o.j };
    return { cell: n, dir: directionBetween(cell, n) ?? "E" };
  });
}

/** Chebyshev on square (a diagonal costs one), Foundry's own measure on hex. */
export function cellDistance(a, b, scene = canvas?.scene) {
  if (!a || !b) return Infinity;
  if (!isHex(scene)) return Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j));
  try {
    const path = canvas?.grid?.measurePath?.([centerOf(a), centerOf(b)]);
    const spaces = Number(path?.spaces ?? path?.distance);
    if (Number.isFinite(spaces)) return spaces;
  } catch (_) { /* fall through */ }
  return Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j));
}

export function isAdjacent(a, b, scene = canvas?.scene) {
  return cellDistance(a, b, scene) === 1;
}

// ── Bearings and facing ─────────────────────────────────────────────────────

/** Bearing from cell `a` to cell `b`, in degrees (0 = East, clockwise). */
export function bearing(a, b) {
  const pa = centerOf(a);
  const pb = centerOf(b);
  return (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
}

/** Snap an arbitrary bearing to the nearest supported direction key. */
export function snapToDirection(deg, scene = canvas?.scene) {
  const keys = directions(scene);
  let best = keys[0];
  let bestDelta = Infinity;
  for (const k of keys) {
    const d = Math.abs(norm180(DIR_ANGLE[k] - deg));
    if (d < bestDelta) { bestDelta = d; best = k; }
  }
  return best;
}

/** The direction one would face moving from `a` to `b`. Null if same cell. */
export function directionBetween(a, b, scene = canvas?.scene) {
  if (sameCell(a, b)) return null;
  return snapToDirection(bearing(a, b), scene);
}

export function directionLabel(dir) {
  return DIR_LABEL[dir] ?? String(dir ?? "");
}

/** Turn a facing key into a unit vector in screen space. */
export function facingVector(dir) {
  const deg = DIR_ANGLE[dir] ?? 0;
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/**
 * Absolute angle, in degrees, between where `facing` points and the bearing
 * from `fromCell` to `toCell`. 0 means dead ahead, 180 means directly behind.
 */
export function angleOffFacing(fromCell, facing, toCell) {
  if (sameCell(fromCell, toCell)) return 0;
  return Math.abs(norm180(bearing(fromCell, toCell) - (DIR_ANGLE[facing] ?? 0)));
}

/**
 * Where the target sits relative to an observer's facing.
 *
 * Derived, never stored. One call feeds three systems — detection range,
 * Takedown eligibility, and the flavour the GM narrates — which is why it
 * lives here rather than being inlined at each site.
 *
 *   front  0°–45°    full sight
 *   flank  45°–135°  reduced range
 *   rear   135°–180° proximity only, and Takedown gets its bonus
 */
export function relativeArc(observerCell, facing, targetCell, halfAngle = 45) {
  const off = angleOffFacing(observerCell, facing, targetCell);
  if (off <= halfAngle) return ARC.FRONT;
  if (off <= 180 - halfAngle) return ARC.FLANK;
  return ARC.REAR;
}

/** True when `targetCell` falls inside the observer's vision cone. */
export function inCone(observerCell, facing, targetCell, halfAngle = 45) {
  return angleOffFacing(observerCell, facing, targetCell) <= halfAngle;
}

/**
 * Every cell within `radius` of `origin`, origin excluded.
 * Used for cone rendering, proximity checks and spawn placement.
 */
export function cellsWithin(origin, radius, scene = canvas?.scene) {
  const out = [];
  const r = Math.max(0, Math.floor(radius));
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      if (di === 0 && dj === 0) continue;
      const c = { i: origin.i + di, j: origin.j + dj };
      if (cellDistance(origin, c, scene) <= r) out.push(c);
    }
  }
  return out;
}

/** Is this cell inside the scene's playable rectangle? */
export function inBounds(cell, scene = canvas?.scene) {
  const s = scene ?? canvas?.scene;
  if (!s) return false;
  const gs = gridSize(s);
  const p = topLeftOf(cell);
  const dims = canvas?.dimensions;
  const minX = dims?.sceneX ?? 0;
  const minY = dims?.sceneY ?? 0;
  const maxX = minX + (dims?.sceneWidth ?? s.width ?? 0);
  const maxY = minY + (dims?.sceneHeight ?? s.height ?? 0);
  return p.x >= minX - gs * 0.5 && p.y >= minY - gs * 0.5
      && p.x < maxX + gs * 0.5 && p.y < maxY + gs * 0.5;
}
