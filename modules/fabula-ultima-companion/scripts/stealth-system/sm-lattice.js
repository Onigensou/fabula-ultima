// ============================================================================
// Stealth Mode — occupancy lattice + pathing.
//
// The layer Foundry has no answer for. Native walls tell us whether a single
// step collides; they cannot tell us "every cell reachable in five steps",
// which is the whole interaction model here, nor can they path an AI.
//
// ── What a cell knows ──────────────────────────────────────────────────────
//   passable   walls do not block entry from at least one neighbour
//   cover      a prop tile marked as cover overlaps it (feeds detection)
//   blocker    a prop tile marked solid overlaps it (blocks movement)
//   occupant   token id standing here
//   lit        any scene light reaches it (feeds detection)
//
// ── Walls stay native ──────────────────────────────────────────────────────
// 173 walls already exist on the prototype scene, the GM authors them with a
// tool they know, and ONE call answers both "can I walk here" and "can that
// guard see me". Rebuilding that in our own format would mean re-authoring
// every map for nothing.
//
// Props are the exception, because a Foundry wall cannot be pushed. A crate is
// a Tile carrying our own flags; the lattice derives its blocked cells from the
// tile's bounds at build time. Destroy or shove it and we rebuild — no wall
// document is ever touched, so nothing leaks into permanent scene geometry.
//
// ── Cost ───────────────────────────────────────────────────────────────────
// ~1,200 cells on the prototype map. A full BFS is sub-millisecond, so the
// lattice is rebuilt on any scene change rather than incrementally patched;
// incremental invalidation is where this kind of cache goes subtly wrong.
// ============================================================================

import { MODULE_ID, TAG, CONFIG_FLAG } from "./sm-constants.js";
import {
  cellKey, keyToCell, sameCell, cellAt, centerOf, topLeftOf, cellOfToken,
  neighbours, cellDistance, gridSize, inBounds,
} from "./sm-grid.js";

/** Our namespace on a Tile's flags. Joins the four already there. */
export const TILE_FLAG = "stealthProp";

let _lattice = null;
let _builtFor = null;   // scene id the current lattice belongs to

// ── Prop tiles ──────────────────────────────────────────────────────────────

/**
 * Read a tile's stealth-prop config.
 * @returns {{cover:boolean, solid:boolean, movable:boolean, destructible:boolean, hp:number}|null}
 */
export function propConfigOf(tileDoc) {
  const f = tileDoc?.flags?.[MODULE_ID]?.[TILE_FLAG];
  if (!f || f.enabled === false) return null;
  return {
    cover:        f.cover !== false,          // a prop is cover unless told otherwise
    solid:        f.solid !== false,          // ...and blocks movement unless told otherwise
    movable:      !!f.movable,
    destructible: !!f.destructible,
    hp:           Number(f.hp ?? 1) || 1,
    label:        String(f.label ?? "").trim(),
  };
}

/** Cells a tile's bounds overlap. Props are free-placed, so this is geometric. */
function cellsUnderTile(tileDoc, scene) {
  const gs = gridSize(scene);
  const x = Number(tileDoc.x) || 0;
  const y = Number(tileDoc.y) || 0;
  const w = Number(tileDoc.width) || gs;
  const h = Number(tileDoc.height) || gs;

  // Sample the tile's footprint on a half-cell lattice. A barrel 21px wide on a
  // 35px grid covers exactly one cell and must not be missed; sampling beats
  // rounding the corners, which drops sub-cell props entirely.
  const step = Math.max(4, gs / 3);
  const seen = new Map();
  for (let px = x; px <= x + w; px += step) {
    for (let py = y; py <= y + h; py += step) {
      const c = cellAt({ x: px, y: py });
      seen.set(cellKey(c), c);
    }
  }
  // Always include the centre, for a prop smaller than one sample step.
  const mid = cellAt({ x: x + w / 2, y: y + h / 2 });
  seen.set(cellKey(mid), mid);
  return [...seen.values()];
}

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * Build the lattice for a scene. Cheap enough to call on any change.
 * @returns {{cells:Map<string,object>, scene:Scene, bounds:object}}
 */
export function buildLattice(scene = canvas?.scene) {
  const t0 = performance.now();
  const cells = new Map();
  if (!scene) return { cells, scene: null, bounds: null };

  const dims = canvas?.dimensions;
  const gs = gridSize(scene);
  const originCell = cellAt({ x: dims?.sceneX ?? 0, y: dims?.sceneY ?? 0 });
  const farCell = cellAt({
    x: (dims?.sceneX ?? 0) + (dims?.sceneWidth ?? scene.width ?? 0) - 1,
    y: (dims?.sceneY ?? 0) + (dims?.sceneHeight ?? scene.height ?? 0) - 1,
  });

  const iMin = Math.min(originCell.i, farCell.i);
  const iMax = Math.max(originCell.i, farCell.i);
  const jMin = Math.min(originCell.j, farCell.j);
  const jMax = Math.max(originCell.j, farCell.j);

  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const cell = { i, j };
      cells.set(cellKey(cell), {
        i, j,
        passable: true,
        cover: false,
        blocker: null,      // tile id, when a solid prop sits here
        occupant: null,     // token id
        lit: false,
      });
    }
  }

  // --- Prop tiles ---
  for (const tileDoc of (scene.tiles ?? [])) {
    if (tileDoc.hidden) continue;
    const cfg = propConfigOf(tileDoc);
    if (!cfg) continue;
    for (const c of cellsUnderTile(tileDoc, scene)) {
      const rec = cells.get(cellKey(c));
      if (!rec) continue;
      if (cfg.cover) rec.cover = true;
      if (cfg.solid) { rec.passable = false; rec.blocker = tileDoc.id; }
    }
  }

  // --- Lighting ---
  // Detection reads this: a lit cell is easier to be seen in. Cheap radial
  // test rather than the real light polygon — a guard's eyes are not a
  // rendering pipeline, and the tuning knob absorbs the difference.
  for (const light of (scene.lights ?? [])) {
    if (light.hidden) continue;
    const bright = Number(light.config?.bright ?? 0);
    const dim = Number(light.config?.dim ?? 0);
    const rangeUnits = Math.max(bright, dim);
    if (rangeUnits <= 0) continue;
    const px = (rangeUnits / (scene.grid?.distance || 1)) * gs;
    const origin = cellAt({ x: light.x, y: light.y });
    const radius = Math.ceil(px / gs);
    for (let di = -radius; di <= radius; di++) {
      for (let dj = -radius; dj <= radius; dj++) {
        const c = { i: origin.i + di, j: origin.j + dj };
        const rec = cells.get(cellKey(c));
        if (!rec) continue;
        if (cellDistance(origin, c, scene) <= radius) rec.lit = true;
      }
    }
  }

  _lattice = { cells, scene, bounds: { iMin, iMax, jMin, jMax } };
  _builtFor = scene.id;

  console.debug(TAG, `lattice built: ${cells.size} cells in ${(performance.now() - t0).toFixed(1)}ms`);
  return _lattice;
}

export function getLattice(scene = canvas?.scene) {
  if (!_lattice || _builtFor !== scene?.id) return buildLattice(scene);
  return _lattice;
}

export function invalidateLattice() {
  _lattice = null;
  _builtFor = null;
}

export function cellRecord(cell, scene = canvas?.scene) {
  return getLattice(scene).cells.get(cellKey(cell)) ?? null;
}

/** Refresh which cells hold tokens. Far cheaper than a full rebuild. */
export function syncOccupancy(scene = canvas?.scene) {
  const lat = getLattice(scene);
  for (const rec of lat.cells.values()) rec.occupant = null;
  for (const tokenDoc of (scene?.tokens ?? [])) {
    if (tokenDoc.hidden) continue;
    const c = cellOfToken(tokenDoc);
    const rec = c ? lat.cells.get(cellKey(c)) : null;
    if (rec) rec.occupant = tokenDoc.id;
  }
  return lat;
}

// ── Wall queries ────────────────────────────────────────────────────────────

/**
 * Can something move from cell `a` into adjacent cell `b`?
 *
 * Uses the same call exploration mode already gates movement with, so a wall
 * that stops the party in one mode stops them in the other.
 */
export function canStep(a, b, scene = canvas?.scene) {
  const rec = cellRecord(b, scene);
  if (!rec || !rec.passable) return false;
  if (!inBounds(b, scene)) return false;
  try {
    const blocked = CONFIG.Canvas.polygonBackends.move.testCollision(
      centerOf(a), centerOf(b), { type: "move", mode: "any" },
    );
    return !blocked;
  } catch (e) {
    // A collision backend that throws must not make the whole map impassable.
    console.warn(TAG, "move collision test threw — treating as open:", e);
    return true;
  }
}

/** Unobstructed line of sight between two cells? */
export function hasLineOfSight(a, b, scene = canvas?.scene) {
  if (sameCell(a, b)) return true;
  try {
    return !CONFIG.Canvas.polygonBackends.sight.testCollision(
      centerOf(a), centerOf(b), { type: "sight", mode: "any" },
    );
  } catch (e) {
    console.warn(TAG, "sight collision test threw — treating as visible:", e);
    return true;
  }
}

// ── Pathing ─────────────────────────────────────────────────────────────────

/**
 * Every cell reachable from `origin` within `budget` steps.
 *
 * This is the reachable-cell overlay, and it is why the movement layer had to
 * be ours: a plain BFS over the lattice, respecting walls, solid props and
 * (optionally) other tokens.
 *
 * @returns {Map<string, {cell:object, cost:number, from:string|null}>}
 */
export function reachable(origin, budget, {
  scene = canvas?.scene,
  blockedBy = null,        // Set<tokenId> whose cells are impassable
  ignoreOccupants = false,
} = {}) {
  const out = new Map();
  if (!origin || budget < 0) return out;

  const lat = getLattice(scene);
  const startKey = cellKey(origin);
  out.set(startKey, { cell: origin, cost: 0, from: null });

  let frontier = [origin];
  for (let step = 1; step <= budget; step++) {
    const next = [];
    for (const cur of frontier) {
      for (const { cell } of neighbours(cur, scene)) {
        const key = cellKey(cell);
        if (out.has(key)) continue;
        const rec = lat.cells.get(key);
        if (!rec || !rec.passable) continue;
        if (!ignoreOccupants && rec.occupant) {
          if (!blockedBy || blockedBy.has(rec.occupant)) continue;
        }
        if (!canStep(cur, cell, scene)) continue;
        out.set(key, { cell, cost: step, from: cellKey(cur) });
        next.push(cell);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  return out;
}

/** Walk a reachable() map back into an ordered path, origin excluded. */
export function pathFromReachable(reach, target) {
  const path = [];
  let key = cellKey(target);
  let guard = 0;
  while (reach.has(key) && guard++ < 10000) {
    const node = reach.get(key);
    if (node.from === null) break;
    path.unshift(node.cell);
    key = node.from;
  }
  return path;
}

/**
 * A* from `origin` to `goal`. Used by the AI, which needs a route that may run
 * far past one turn's movement budget.
 *
 * `maxExpansions` is a hard stop, not a tuning knob: an enemy pathing at an
 * unreachable target across a large map would otherwise scan every cell every
 * activation. Returning an empty path lets the AI fall back to a direct step,
 * which is a better failure than a frame hitch.
 */
export function findPath(origin, goal, {
  scene = canvas?.scene,
  ignoreOccupants = true,
  maxExpansions = 4000,
} = {}) {
  if (!origin || !goal || sameCell(origin, goal)) return [];
  const lat = getLattice(scene);

  const open = new Map();  // key → {cell, g, f, from}
  const closed = new Set();
  const startKey = cellKey(origin);
  open.set(startKey, { cell: origin, g: 0, f: cellDistance(origin, goal, scene), from: null });

  const came = new Map();
  let expansions = 0;

  while (open.size && expansions++ < maxExpansions) {
    let bestKey = null;
    let best = null;
    for (const [k, n] of open) if (!best || n.f < best.f) { best = n; bestKey = k; }
    open.delete(bestKey);
    closed.add(bestKey);
    came.set(bestKey, best.from);

    if (sameCell(best.cell, goal)) {
      const path = [];
      let k = bestKey;
      let guard = 0;
      while (k && guard++ < 10000) {
        const n = came.get(k);
        if (n === null || n === undefined) break;
        path.unshift(keyToCell(k));
        k = n;
      }
      return path;
    }

    for (const { cell } of neighbours(best.cell, scene)) {
      const key = cellKey(cell);
      if (closed.has(key)) continue;
      const rec = lat.cells.get(key);
      if (!rec || !rec.passable) continue;
      if (!ignoreOccupants && rec.occupant) continue;
      if (!canStep(best.cell, cell, scene)) continue;

      const g = best.g + 1;
      const existing = open.get(key);
      if (existing && existing.g <= g) continue;
      open.set(key, { cell, g, f: g + cellDistance(cell, goal, scene), from: bestKey });
    }
  }

  return [];
}

/**
 * The reachable cell closest to `goal` within `budget` steps.
 * What an AI actually wants: "get as near as you can this turn".
 */
export function stepToward(origin, goal, budget, opts = {}) {
  const scene = opts.scene ?? canvas?.scene;
  const reach = reachable(origin, budget, opts);
  let best = null;
  let bestDist = Infinity;
  for (const node of reach.values()) {
    const d = cellDistance(node.cell, goal, scene);
    // Ties break toward the cheaper cell, so a guard does not wander sideways
    // for the same distance it could have held.
    if (d < bestDist || (d === bestDist && best && node.cost < best.cost)) {
      bestDist = d; best = node;
    }
  }
  if (!best || sameCell(best.cell, origin)) return { cell: origin, path: [], reach };
  return { cell: best.cell, path: pathFromReachable(reach, best.cell), reach };
}
