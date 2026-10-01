// [ONI] Skill Forge — the canvas's geometry and rules.
// ---------------------------------------------------------------------------
// The Wire tab draws a skill's steps on an unbounded, pannable, zoomable
// canvas. Everything that canvas DECIDES lives here, with no Foundry and no
// DOM, so it can be held by a suite:
//
//   autoLayout      where a card goes when nobody has placed it
//   zoomAt / fit    the view transform (pan x/y + scale k)
//   edgeGeometry    the curve an arrow follows
//   linkFieldsFor   which reference a drawn link may become
//   load/saveLayout per-user placement, in browser storage
//
// ⚠ PLACEMENT IS NOT SKILL DATA. Card positions are kept in the viewer's own
// browser storage, never on the document. Writing them to the item would make
// every drag an item update (~360 ms of CSB work on an actor's copy) and a row
// of churn in `_authored-export` — the review surface a world push is read
// through, where noise is exactly what hides a one-line removal.

import { REF_FIELDS, FIRE_POINTS } from "./graph-model.js";
import { columnsForKind } from "./step-palette.js";

/** The node id the document's fire points leave from. */
export const DOC_NODE = "__document__";

export const CARD_W = 210;
export const COL_GAP = 110;
export const ROW_GAP = 26;
/** Height assumed for a card that has not been measured yet. */
export const EST_H = 90;
// Low enough that Fit can show a very wide fan-out whole: 150 steps as a
// binary tree is ~75 leaves in one column, ~8000 px tall. Unreadable that far
// out, but Fit is for finding your way, then you zoom in.
export const ZOOM_MIN = 0.04;
export const ZOOM_MAX = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A left-to-right layered layout.
 *
 * Column = reference depth from a fire point (`assignDepths`), with the
 * document's own card one column further left. Rows nothing reaches get a
 * column of their own at the far right — they never run, and putting them
 * beside the live ones would read as if they did.
 *
 * Within a column, cards are ordered by the average row of whatever points at
 * them (one barycentre pass), which removes most crossings in the tree-shaped
 * graphs skills actually have, without pretending to be a full Sugiyama.
 *
 * @param {object} graph   toGraph() output
 * @param {Map}    depths  assignDepths() output
 * @param {object} sizes   { [id]: { w, h } } measured card sizes, optional
 * @returns {Object<string,{x:number,y:number}>}
 */
export function autoLayout(graph, depths, sizes = {}) {
  const hOf = (id) => sizes[id]?.h || EST_H;
  const colX = (c) => c * (CARD_W + COL_GAP);

  const maxDepth = Math.max(-1, ...[...depths.values()]);
  const columns = new Map();
  const put = (c, id) => { if (!columns.has(c)) columns.set(c, []); columns.get(c).push(id); };

  put(0, DOC_NODE);
  for (const n of graph.nodes) {
    put(depths.has(n.id) ? depths.get(n.id) + 1 : maxDepth + 2, n.id);
  }

  const pos = {};
  const parents = new Map();
  for (const e of graph.edges) {
    if (!e.to) continue;
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to).push(e.from);
  }

  const stacked = (ids) => ids.reduce((s, id) => s + hOf(id) + ROW_GAP, -ROW_GAP);
  const tallest = Math.max(...[...columns.values()].map(stacked));

  for (const c of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(c);
    const centre = (id) => {
      const ys = (parents.get(id) ?? []).map((p) => pos[p]).filter(Boolean).map((p) => p.y);
      return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : Infinity;
    };
    // Stable: equal centres (incl. no placed parent) keep table order.
    const order = ids.map((id, i) => ({ id, i, c: centre(id) }))
      .sort((a, b) => (a.c - b.c) || (a.i - b.i));
    // Each column is centred on the tallest one's midline, so a wide fan-out
    // spreads above AND below its parent instead of hanging off the top.
    let y = (tallest - stacked(ids)) / 2;
    for (const { id } of order) {
      pos[id] = { x: colX(c), y };
      y += hOf(id) + ROW_GAP;
    }
  }
  return pos;
}

/** Saved placement wins; anything unplaced falls back to the auto layout. */
export function resolveLayout(auto, saved = {}) {
  const out = {};
  for (const [id, p] of Object.entries(auto)) {
    const s = saved[id];
    out[id] = s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: s.x, y: s.y } : { ...p };
  }
  return out;
}

/** Zoom by `factor` keeping the screen point (px, py) fixed under the cursor. */
export function zoomAt(view, factor, px, py) {
  const k = clamp(view.k * factor, ZOOM_MIN, ZOOM_MAX);
  const r = k / view.k;
  return { k, x: px - (px - view.x) * r, y: py - (py - view.y) * r };
}

/** Screen (canvas-relative) point → world point. */
export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

/**
 * The view that shows every box, centred, never zoomed past 100%: a small
 * skill should look like a small skill, not be blown up to fill the window.
 */
export function fitView(boxes, width, height, pad = 40) {
  if (!boxes.length || width <= 0 || height <= 0) return { x: pad, y: pad, k: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const k = clamp(Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh, 1), ZOOM_MIN, ZOOM_MAX);
  return { k, x: (width - bw * k) / 2 - minX * k, y: (height - bh * k) / 2 - minY * k };
}

/**
 * The arrow from one card to another: out of the source's right edge, into
 * the target's left edge. A link that runs BACKWARDS (target left of source)
 * gets wider handles so it loops round instead of cutting through both cards.
 *
 * `slot`/`slots` fan out several arrows leaving the same card so they do not
 * all start from one pixel.
 */
export function edgeGeometry(a, b, { slot = 0, slots = 1 } = {}) {
  const spread = Math.min(a.h - 16, 14 * (slots - 1));
  const sy0 = a.y + a.h / 2 + (slots > 1 ? (slot / (slots - 1) - 0.5) * spread : 0);
  const sx = a.x + a.w, sy = sy0;
  const tx = b.x, ty = b.y + b.h / 2;
  const dx = tx - sx;
  const c = dx >= 40 ? Math.max(40, dx / 2) : 90 + Math.min(200, Math.abs(dx) * 0.25);
  const d = `M ${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`;
  // The cubic's t = 0.5 point; with symmetric handles it is the chord midpoint.
  return { d, mx: (sx + tx) / 2, my: (sy + ty) / 2, sx, sy, tx, ty };
}

/** A straight-ish rubber band from a card's port to the cursor. */
export function dragPath(sx, sy, tx, ty) {
  const c = Math.max(30, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`;
}

/**
 * Which references a link drawn FROM one card TO another may become.
 *
 * The rule that keeps the canvas from being the editor that writes a column
 * the row's kind does not declare (written, reported as saved, silently
 * dropped): a field is offered only if the row ALREADY carries it, or the
 * column registry declares it for this row's `effect_kind`. Trigger rows get
 * no registry fallback — the registry describes effect rows only.
 *
 * Step fields point at any named effect row; target fields only at a
 * `targeting` row (anything else is a reserved word, typed, not drawn).
 *
 * @returns {{ options: Array<{field,label,kind,current}>, reason: string|null }}
 */
export function linkFieldsFor(graph, fromId, toId) {
  const to = graph.nodes.find((n) => n.id === toId);
  if (!to) return { options: [], reason: "no such step" };
  if (fromId === toId) return { options: [], reason: "a step cannot point at itself" };
  if (to.isTrigger) return { options: [], reason: "a trigger row starts on its own — nothing points at one" };
  if (to.labelIsSynthetic) return { options: [], reason: "that step has no name, so nothing can point at it" };

  if (fromId === DOC_NODE) {
    // Only the fire points this document carries, plus on_activate — adding a
    // new fire point means adding a document prop, which is not a link.
    const carried = Object.entries(FIRE_POINTS)
      .filter(([f]) => f === "on_activate_effect_ref" || f in (graph.entries ?? {}));
    const options = carried
      .map(([field, label]) => ({ field, label, kind: "single", current: graph.entries?.[field] || "" }))
      // Already starting there: offering it would be a no-op dressed as a
      // "replaces X" with X the very same step.
      .filter((o) => o.current !== to.label);
    return { options, reason: options.length ? null : "the skill already starts there" };
  }

  const from = graph.nodes.find((n) => n.id === fromId);
  if (!from) return { options: [], reason: "no such step" };
  const declared = from.isTrigger ? new Set() : new Set(columnsForKind(from.kind).map((c) => c.key));
  const carried = new Set([...(from.keyOrder ?? []), ...Object.keys(from.refs ?? {})]);
  const isTargeting = String(to.kind).trim() === "targeting";

  const options = [];
  let alreadyLinked = 0;
  for (const [field, spec] of Object.entries(REF_FIELDS)) {
    if (spec.points_at === "target" && !isTargeting) continue;
    if (!carried.has(field) && !declared.has(field)) continue;
    const current = graph.edges
      .filter((e) => e.from === fromId && e.field === field)
      .sort((a, b) => a.order - b.order).map((e) => e.toLabel);
    // Already linked this way: nothing to offer.
    if (current.includes(to.label)) { alreadyLinked += 1; continue; }
    options.push({ field, label: spec.label, kind: spec.kind, current: current.join(", ") });
  }
  return {
    options,
    reason: options.length ? null
      : alreadyLinked ? `"${from.label}" already points at "${to.label}"`
      : `a ${from.kind || "row"} step has no reference that can point at a ${to.kind || "row"} step`,
  };
}

// ── per-user placement ──────────────────────────────────────────────────────

export const layoutKey = (uuid) => `fu.skillForge.layout.${uuid}`;

/** `{ pos: {id:{x,y}}, view: {x,y,k}|null }` — never throws, never null. */
export function loadLayout(storage, uuid) {
  const empty = { pos: {}, view: null };
  if (!storage || !uuid) return empty;
  try {
    const raw = storage.getItem(layoutKey(uuid));
    if (!raw) return empty;
    const v = JSON.parse(raw);
    const view = v?.view && ["x", "y", "k"].every((k) => Number.isFinite(v.view[k])) ? v.view : null;
    return { pos: v?.pos && typeof v.pos === "object" ? v.pos : {}, view };
  } catch { return empty; }
}

/** Persist placement for the ids that still exist. False if storage refused. */
export function saveLayout(storage, uuid, { pos = {}, view = null } = {}, liveIds = null) {
  if (!storage || !uuid) return false;
  const keep = liveIds ? Object.fromEntries(Object.entries(pos).filter(([id]) => liveIds.has(id))) : pos;
  try {
    storage.setItem(layoutKey(uuid), JSON.stringify({ pos: keep, view }));
    return true;
  } catch { return false; }
}

export function clearLayout(storage, uuid) {
  try { storage?.removeItem(layoutKey(uuid)); return true; } catch { return false; }
}
