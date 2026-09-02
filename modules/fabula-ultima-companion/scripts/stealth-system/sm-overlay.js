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

// ── Detection marks ─────────────────────────────────────────────────────────
//
// The "!" a guard wears when it sees you and the "?" when it is unsure. This
// replaces the Foundry toast that used to announce a sighting: being seen is a
// thing that happens ON the board, next to the guard it happened to, and a
// notification in the corner pulled the player's eye away from the map at the
// exact moment the map mattered most.
//
// Its own container (not the shared Graphics layers) because these are Text
// objects with their own lifetime — they pop, hold, and fade on a timer rather
// than being redrawn with the rest of the frame.

const Z_MARKS_TOP = 500001;
let _markLayer = null;

function markLayer() {
  if (_markLayer && !_markLayer.destroyed) return _markLayer;
  const parent = canvas?.stage;
  if (!parent) return null;
  const c = new PIXI.Container();
  c.name = "Stealth DetectionMarks";
  c.zIndex = Z_MARKS_TOP;      // ABOVE tokens: it is about the token
  c.eventMode = "none";
  parent.sortableChildren = true;
  parent.addChild(c);
  _markLayer = c;
  return c;
}

const MARK_STYLE = {
  spot:    { glyph: "!", fill: 0xff5a4a, stroke: 0x2a0d09 },
  suspect: { glyph: "?", fill: 0xf3d066, stroke: 0x2e2408 },
};

/**
 * Pop a mark over a token: rise, hold, fade.
 * `cell` is where the guard stands; the mark floats above its head.
 */
export function popDetectionMark(cell, kind = "suspect", { holdMs = 950 } = {}) {
  const layer = markLayer();
  if (!layer || !cell) return;
  const spec = MARK_STYLE[kind] ?? MARK_STYLE.suspect;
  const gs = gridSize();

  let text;
  try {
    text = new PIXI.Text(spec.glyph, new PIXI.TextStyle({
      fontFamily: "Signika, sans-serif",
      fontSize: Math.round(gs * 1.05),
      fontWeight: "900",
      fill: spec.fill,
      stroke: spec.stroke,
      strokeThickness: Math.max(3, gs * 0.11),
      dropShadow: true,
      dropShadowColor: 0x000000,
      dropShadowAlpha: 0.65,
      dropShadowBlur: 4,
      dropShadowDistance: 2,
    }));
  } catch (_) { return; }

  const c = centerOf(cell);
  text.anchor.set(0.5, 1);
  text.x = c.x;
  text.y = c.y - gs * 0.45;
  text.alpha = 0;
  layer.addChild(text);

  const startY = text.y;
  const t0 = performance.now();
  const RISE = 220;

  const tick = () => {
    const t = performance.now() - t0;
    if (t < RISE) {
      const k = t / RISE;
      text.alpha = k;
      text.y = startY + (1 - k) * gs * 0.35;   // pops upward into place
      text.scale.set(0.7 + 0.3 * k);
    } else if (t < RISE + holdMs) {
      text.alpha = 1;
      text.y = startY;
      text.scale.set(1);
    } else {
      const k = Math.min(1, (t - RISE - holdMs) / 260);
      text.alpha = 1 - k;
      text.y = startY - k * gs * 0.25;
      if (k >= 1) {
        canvas.app.ticker.remove(tick);
        try { layer.removeChild(text); text.destroy(); } catch (_) {}
      }
    }
  };
  canvas.app.ticker.add(tick);
}

export function destroyMarkLayer() {
  try {
    if (_markLayer && !_markLayer.destroyed) {
      _markLayer.parent?.removeChild(_markLayer);
      _markLayer.destroy({ children: true });
    }
  } catch (_) {}
  _markLayer = null;
}

// ── Scan sonar ──────────────────────────────────────────────────────────────
//
// A ring pulsing outward from the party, and outlines on whatever it found —
// held for a beat and then faded.
//
// The point is that it reads THROUGH the fog. Foundry's fog hides everything
// past the party's own sight, which is exactly the tension the mode wants for
// ordinary movement; Scan is the deliberate exception, so its highlights are
// drawn on their own layer above the fog rather than as tokens made visible.
// Nothing about the scene's real visibility changes, and the knowledge expires.

const Z_SONAR = 500000;
let _sonarLayer = null;

function sonarLayer() {
  if (_sonarLayer && !_sonarLayer.destroyed) return _sonarLayer;
  const parent = canvas?.stage;
  if (!parent) return null;
  const c = new PIXI.Container();
  c.name = "Stealth Sonar";
  c.zIndex = Z_SONAR;
  c.eventMode = "none";
  parent.sortableChildren = true;
  parent.addChild(c);
  _sonarLayer = c;
  return c;
}

/**
 * Play the scan.
 *
 * @param {object} originCell  the party's cell
 * @param {number} radiusCells how far the pulse reaches
 * @param {Array}  finds       [{ cell, kind: "enemy"|"prop", facing? }]
 * @param {number} holdMs      how long the outlines linger
 */
export function playSonar(originCell, radiusCells, finds = [], { holdMs = 10000 } = {}) {
  const layer = sonarLayer();
  if (!layer || !originCell) return;

  const gs = gridSize();
  const origin = centerOf(originCell);
  const maxR = Math.max(1, radiusCells) * gs;

  // ── The expanding ring ──
  const ring = new PIXI.Graphics();
  layer.addChild(ring);

  const RING_MS = 1100;
  const t0 = performance.now();
  const ringTick = () => {
    const t = (performance.now() - t0) / RING_MS;
    ring.clear();
    if (t >= 1) {
      canvas.app.ticker.remove(ringTick);
      try { layer.removeChild(ring); ring.destroy(); } catch (_) {}
      return;
    }
    // Two rings, the second trailing, so it reads as a pulse rather than a
    // single expanding circle.
    for (const lag of [0, 0.22]) {
      const k = t - lag;
      if (k <= 0 || k >= 1) continue;
      const r = k * maxR;
      const a = (1 - k) * 0.75;
      ring.lineStyle(Math.max(2, gs * 0.09 * (1 - k * 0.5)), 0x7fd0ff, a);
      ring.drawCircle(origin.x, origin.y, r);
    }
    ring.lineStyle(0);
  };
  canvas.app.ticker.add(ringTick);

  // ── The finds ──
  // Each outline appears as the wavefront reaches it, so the sweep reads as
  // the thing doing the finding rather than as a list that pops in at once.
  for (const f of finds) {
    if (!f?.cell) continue;
    const d = Math.hypot(centerOf(f.cell).x - origin.x, centerOf(f.cell).y - origin.y);
    const delay = Math.min(RING_MS, (d / maxR) * RING_MS);
    setTimeout(() => outlineFind(layer, f, gs, holdMs), delay);
  }
}

/**
 * Outline one find as a SILHOUETTE of the thing itself.
 *
 * A grid bracket told you a tile was interesting; it did not tell you what was
 * standing on it. Cloning the placeable's own sprite and rendering only its
 * edge gives the shape back — you read "a guard facing away" or "a stack of
 * crates" through the fog, not "something at 12,7".
 *
 * The clone is drawn at zero fill with an OutlineFilter over it, so the sprite
 * is never visible, only its boundary. The filter is the whole reason this
 * works on arbitrary art with no per-asset authoring: it traces alpha, so a
 * barrel outlines as a barrel.
 */
function outlineFind(layer, find, gs, holdMs) {
  if (!layer || layer.destroyed) return;

  const color = find.kind === "enemy" ? 0xff6a58 : 0x8fd8ff;
  const src = resolvePlaceable(find);

  const node = src ? silhouetteOf(src, color, gs) : bracketOf(find.cell, color, gs);
  if (!node) return;
  layer.addChild(node);

  const born = performance.now();
  const FADE = 900;
  const tick = () => {
    const age = performance.now() - born;
    // A slow pulse so a held silhouette reads as a live scan return rather
    // than a decal someone left on the map.
    const pulse = 0.78 + 0.22 * Math.sin(age / 260);
    if (age < 220) node.alpha = (age / 220) * pulse;
    else if (age < holdMs) node.alpha = pulse;
    else {
      const k = (age - holdMs) / FADE;
      node.alpha = Math.max(0, (1 - k) * pulse);
      if (k >= 1) {
        canvas.app.ticker.remove(tick);
        try { layer.removeChild(node); node.destroy({ children: true }); } catch (_) {}
      }
    }
  };
  canvas.app.ticker.add(tick);
}

/** The Token or Tile a find refers to, if it is still on the canvas. */
function resolvePlaceable(find) {
  try {
    if (find.tokenId) return canvas?.tokens?.get?.(find.tokenId) ?? null;
    if (find.tileId)  return canvas?.tiles?.get?.(find.tileId) ?? null;
  } catch (_) {}
  return null;
}

/** A zero-fill clone of a placeable's sprite, wearing only its outline. */
function silhouetteOf(placeable, color, gs) {
  const base = placeable.mesh ?? placeable.icon ?? placeable.texture;
  const tex = base?.texture ?? placeable.texture;
  if (!tex) return null;

  let sprite;
  try { sprite = new PIXI.Sprite(tex); } catch (_) { return null; }

  sprite.anchor.set(0.5);
  const c = placeable.center ?? {
    x: (placeable.document?.x ?? 0) + (placeable.width ?? gs) / 2,
    y: (placeable.document?.y ?? 0) + (placeable.height ?? gs) / 2,
  };
  sprite.x = c.x;
  sprite.y = c.y;
  sprite.width = base?.width ?? placeable.width ?? gs;
  sprite.height = base?.height ?? placeable.height ?? gs;
  if ((base?.scale?.x ?? 1) < 0) sprite.scale.x = -Math.abs(sprite.scale.x);

  const Outline = PIXI.filters?.OutlineFilter
    ?? globalThis.PIXI?.filters?.OutlineFilter
    ?? globalThis.OutlineFilter;

  if (Outline) {
    // Zero fill: the sprite itself never shows, only the traced edge.
    sprite.tint = 0x000000;
    sprite.alpha = 1;
    const f = new Outline(Math.max(2, gs * 0.09), color, 0.35);
    f.knockout = true;          // discard the interior, keep the border
    sprite.filters = [f];
    return sprite;
  }

  // No OutlineFilter available in this Foundry build. Rather than show a solid
  // black rectangle where a silhouette should be, fall back to the bracket —
  // less informative, but never wrong.
  try { sprite.destroy(); } catch (_) {}
  return null;
}

/** The old corner-bracket, kept as the fallback when no sprite is available. */
function bracketOf(cell, color, gs) {
  const g = new PIXI.Graphics();
  const p = topLeftOf(cell);
  const inset = gs * 0.1;
  const s = gs - inset * 2;

  g.lineStyle(Math.max(2, gs * 0.07), color, 0.95);
  g.beginFill(color, 0.14);
  g.drawRoundedRect(p.x + inset, p.y + inset, s, s, gs * 0.18);
  g.endFill();

  const t = gs * 0.26;
  g.lineStyle(Math.max(2, gs * 0.085), color, 1);
  for (const [cx, cy, dx, dy] of [
    [p.x + inset, p.y + inset, 1, 1],
    [p.x + gs - inset, p.y + inset, -1, 1],
    [p.x + inset, p.y + gs - inset, 1, -1],
    [p.x + gs - inset, p.y + gs - inset, -1, -1],
  ]) {
    g.moveTo(cx + dx * t, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * t);
  }
  g.lineStyle(0);
  return g;
}

export function destroySonarLayer() {
  try {
    if (_sonarLayer && !_sonarLayer.destroyed) {
      _sonarLayer.parent?.removeChild(_sonarLayer);
      _sonarLayer.destroy({ children: true });
    }
  } catch (_) {}
  _sonarLayer = null;
}

// ── Stupor stars ────────────────────────────────────────────────────────────
//
// The cartoon "seeing stars" ring over a reeling guard.
//
// Unlike the !/? marks, this is PERSISTENT: it has to be true for as long as
// the condition lasts, because the player is making a decision on it — a
// stupored guard cannot be taken down, and "why is Takedown missing?" needs an
// answer visible on the board rather than in a rules doc.
//
// One container per enemy, kept across frames and reconciled against the
// broadcast list, so the animation runs continuously instead of restarting
// every time state ticks.

const Z_STUPOR = 500002;
let _stuporLayer = null;
const _stuporNodes = new Map();   // tokenId -> container
let _stuporTick = null;

function stuporLayer() {
  if (_stuporLayer && !_stuporLayer.destroyed) return _stuporLayer;
  const parent = canvas?.stage;
  if (!parent) return null;
  const c = new PIXI.Container();
  c.name = "Stealth Stupor";
  c.zIndex = Z_STUPOR;          // above tokens: it is about the token
  c.eventMode = "none";
  parent.sortableChildren = true;
  parent.addChild(c);
  _stuporLayer = c;
  return c;
}

/** A filled five-point star, drawn once and then only moved. */
function starShape(r, color) {
  const g = new PIXI.Graphics();
  g.beginFill(color, 1);
  g.lineStyle(Math.max(1, r * 0.22), 0x6b4a06, 0.9);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = (i % 2 === 0) ? r : r * 0.44;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  g.drawPolygon(pts);
  g.endFill();
  g.lineStyle(0);
  return g;
}

/**
 * Reconcile the stupor rings against the current enemy list.
 * @param {Array<{tokenId, cell, stupor}>} enemies
 */
export function drawStuporMarks(enemies) {
  const layer = stuporLayer();
  if (!layer) return;

  const gs = gridSize();
  const want = new Set(
    (enemies ?? []).filter((e) => (e.stupor ?? 0) > 0).map((e) => e.tokenId));

  // Drop rings for anyone who has come round.
  for (const [id, node] of [..._stuporNodes]) {
    if (want.has(id)) continue;
    try { layer.removeChild(node); node.destroy({ children: true }); } catch (_) {}
    _stuporNodes.delete(id);
  }

  for (const e of (enemies ?? [])) {
    if ((e.stupor ?? 0) <= 0 || !e.cell) continue;

    let node = _stuporNodes.get(e.tokenId);
    if (!node) {
      node = new PIXI.Container();
      node.__stars = [];
      const STAR_COUNT = 3;
      for (let i = 0; i < STAR_COUNT; i++) {
        const s = starShape(gs * 0.24, 0xffd75e);
        s.__phase = (i / STAR_COUNT) * Math.PI * 2;
        node.addChild(s);
        node.__stars.push(s);
      }
      layer.addChild(node);
      _stuporNodes.set(e.tokenId, node);
    }

    // Follow the token: a guard can be shoved or repositioned while reeling.
    const c = centerOf(e.cell);
    node.x = c.x;
    node.y = c.y - gs * 0.70;
  }

  // One shared ticker for every ring — three stars per guard on their own
  // tickers would be a lot of closures for a purely cosmetic orbit.
  if (_stuporNodes.size && !_stuporTick) {
    _stuporTick = () => {
      const t = performance.now() / 620;
      const gsz = gridSize();
      for (const node of _stuporNodes.values()) {
        for (const s of node.__stars) {
          const a = t + s.__phase;
          s.x = Math.cos(a) * gsz * 0.36;
          // Squashed vertically so the orbit reads as a ring seen edge-on,
          // the way the cartoon shorthand does, rather than a flat circle.
          s.y = Math.sin(a) * gsz * 0.13;
          s.rotation = a * 0.6;
          // Stars on the far side ride behind and dim slightly.
          const far = (Math.sin(a) + 1) / 2;
          s.alpha = 0.55 + 0.45 * far;
          s.scale.set(0.78 + 0.22 * far);
        }
      }
    };
    canvas.app.ticker.add(_stuporTick);
  } else if (!_stuporNodes.size && _stuporTick) {
    canvas.app.ticker.remove(_stuporTick);
    _stuporTick = null;
  }
}

export function destroyStuporLayer() {
  if (_stuporTick) { try { canvas.app.ticker.remove(_stuporTick); } catch (_) {} _stuporTick = null; }
  _stuporNodes.clear();
  try {
    if (_stuporLayer && !_stuporLayer.destroyed) {
      _stuporLayer.parent?.removeChild(_stuporLayer);
      _stuporLayer.destroy({ children: true });
    }
  } catch (_) {}
  _stuporLayer = null;
}
