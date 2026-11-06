// ============================================================================
// Dungeon Pathing — Links core (pure logic, no Foundry)
//
// A scene's tile links live on the scene as data instead of Foundry Drawing
// lines:   flags.fabula-ultima-companion.dungeonPathing.links = { [id]: link }
//          flags.fabula-ultima-companion.dungeonPathing.linksVersion = 1
//
// link = {
//   a, b      tile ids (for a one-way link the party may only go a → b)
//   route     "main" | "side"
//   oneWay    false
//   via       [[x, y], …] absolute bend points between the two tiles (may be [])
//   off       true = switched off: not walkable, players never see it
//             (migrated from a hidden Drawing, which the graph ignored)
//   requiresSwitch  "" | switch name — not walkable until the switch is ON
//                   (the world map's locked routes, dp-worldmap.js)
//   label     ""  name players see (Dungeon Maker)
// }
// Later phases add lock / hidden / hazard / collapse; unknown keys are kept.
//
// A scene WITHOUT linksVersion still reads its Drawings (dp-graph.js), so a
// world can be migrated one scene at a time.
//
// Loaded by Foundry (module.json, before dp-graph.js) and by
// dp-links-core.test.mjs through node:vm — keep it free of Foundry globals.
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};

  const N = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const dist = (a, b) => Math.hypot(N(a.x) - N(b.x), N(a.y) - N(b.y));
  const pairKey = (a, b) => [a, b].sort().join("<>");

  /** Same snap radius dp-graph.js uses for drawing ends. */
  const snapRadius = (gridSize) => Math.max(80, (Number(gridSize) || 100) * 0.75);

  /** Drawing shape points (flat [x0,y0,x1,y1…], [[x,y]…] or [{x,y}…]) → [{x,y}] local. */
  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    if (points.every(p => typeof p === "number")) {
      const out = [];
      for (let i = 0; i < points.length - 1; i += 2) out.push({ x: N(points[i]), y: N(points[i + 1]) });
      return out;
    }
    if (points.every(p => Array.isArray(p))) return points.filter(p => p.length >= 2).map(p => ({ x: N(p[0]), y: N(p[1]) }));
    if (points.every(p => p && typeof p === "object")) return points.map(p => ({ x: N(p.x), y: N(p.y) }));
    return [];
  }

  /** Nearest tile centre to a point, accepted only inside the snap radius. */
  function nearestTile(point, tiles, radius) {
    let best = null, bd = Infinity;
    for (const t of tiles) { const d = dist(point, t); if (d < bd) { bd = d; best = t; } }
    return best && bd <= radius ? best : null;
  }

  /**
   * Turn one scene's Drawings into links, using exactly the rules dp-graph.js
   * applies to drawings today, so the walkable graph does not change.
   *
   * @param {object} p
   * @param {{id,x,y,width,height,hidden}[]} p.tiles     tile documents (hidden tiles are not graph nodes)
   * @param {{id,x,y,hidden,shape:{points},flags}[]} p.drawings  drawing documents
   * @param {number} p.gridSize
   * @param {string} [p.mod]  module id for flags
   * @returns {{ links: object, migrated: string[], kept: {id,reason}[], duplicates: {id,of}[] }}
   *   migrated = drawing ids that became links (safe to delete)
   *   kept     = drawings that are not links (decoration, masks…) — leave them alone
   *   duplicates = extra drawings joining a pair already linked (the graph ignored them too)
   */
  function migrateDrawings({ tiles, drawings, gridSize, mod = "fabula-ultima-companion" }) {
    const nodes = (tiles || []).filter(t => !t.hidden).map(t => ({ id: t.id, x: N(t.x) + N(t.width) / 2, y: N(t.y) + N(t.height) / 2 }));
    const radius = snapRadius(gridSize);
    const links = {}, migrated = [], kept = [], duplicates = [], seen = new Map();
    for (const d of drawings || []) {
      const local = normalizePoints(d.shape?.points ?? d.points ?? []);
      const abs = local.map(p => ({ x: N(d.x) + p.x, y: N(d.y) + p.y }));
      if (abs.length < 2) { kept.push({ id: d.id, reason: "not a line" }); continue; }
      const first = abs[0], last = abs[abs.length - 1];
      if (dist(first, last) <= 10) { kept.push({ id: d.id, reason: "too short to be a link" }); continue; }
      const a = nearestTile(first, nodes, radius), b = nearestTile(last, nodes, radius);
      if (!a || !b || a.id === b.id) { kept.push({ id: d.id, reason: "ends are not on two tiles" }); continue; }
      const key = pairKey(a.id, b.id);
      if (seen.has(key)) { duplicates.push({ id: d.id, of: seen.get(key) }); migrated.push(d.id); continue; }
      const f = d.flags?.[mod] ?? {};
      const dpf = f.dungeonPathing ?? {};
      seen.set(key, d.id);
      links[d.id] = {
        a: a.id, b: b.id,
        route: f.pathKind === "side" ? "side" : "main",
        oneWay: false,
        via: abs.slice(1, -1).map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]),
        off: !!d.hidden,
        requiresSwitch: String(dpf.requiresSwitch ?? "").trim(),
        label: "",
      };
      migrated.push(d.id);
    }
    return { links, migrated, kept, duplicates };
  }

  /**
   * Walkable edges from a scene's links — the same shape dp-graph.js has always
   * produced ({ fromNodeId, toNodeId, drawingId }), so every consumer keeps working.
   * `drawingId` now carries the link id (migrated links keep their drawing's id).
   *
   * @param {object} links
   * @param {Set<string>|string[]} nodeIds  ids of tiles that are graph nodes
   * @param {{ switchOn?: (name) => boolean }} [ctx]
   */
  function edgesFromLinks(links, nodeIds, ctx = {}) {
    const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
    const switchOn = ctx.switchOn ?? (() => false);
    const edges = [], seen = new Set();
    for (const [id, l] of Object.entries(links || {})) {
      if (!l || l.off) continue;
      if (!ids.has(l.a) || !ids.has(l.b) || l.a === l.b) continue;
      if (l.requiresSwitch && !switchOn(l.requiresSwitch)) continue;
      const key = pairKey(l.a, l.b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromNodeId: l.a, toNodeId: l.b, drawingId: id, linkId: id });
    }
    return edges;
  }

  /** Neighbour sets per node — used to prove a migration changed nothing. */
  function neighbourMap(edges) {
    const m = new Map();
    const add = (x, y) => { if (!m.has(x)) m.set(x, new Set()); m.get(x).add(y); };
    for (const e of edges) { add(e.fromNodeId, e.toNodeId); add(e.toNodeId, e.fromNodeId); }
    return m;
  }
  function sameNeighbours(edgesA, edgesB) {
    const A = neighbourMap(edgesA), B = neighbourMap(edgesB), diffs = [];
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const a = [...(A.get(id) ?? [])].sort().join(","), b = [...(B.get(id) ?? [])].sort().join(",");
      if (a !== b) diffs.push({ tile: id, before: a, after: b });
    }
    return { same: diffs.length === 0, diffs };
  }

  /**
   * The old drawing → edge rule, kept here so tests and the migration report
   * can compare against it without a canvas. Mirrors dp-graph.js buildEdges.
   */
  function legacyEdges({ tiles, drawings, gridSize, mod = "fabula-ultima-companion", switchOn = () => false }) {
    const nodes = (tiles || []).filter(t => !t.hidden).map(t => ({ id: t.id, x: N(t.x) + N(t.width) / 2, y: N(t.y) + N(t.height) / 2 }));
    const radius = snapRadius(gridSize), edges = [], seen = new Set();
    for (const d of drawings || []) {
      if (d.hidden) continue;
      // dp-worldmap.js isRouteLocked: a switch-gated line is not an edge until its switch is ON
      const gate = String(d.flags?.[mod]?.dungeonPathing?.requiresSwitch ?? "").trim();
      if (gate && !switchOn(gate)) continue;
      const local = normalizePoints(d.shape?.points ?? d.points ?? []);
      const abs = local.map(p => ({ x: N(d.x) + p.x, y: N(d.y) + p.y }));
      if (abs.length < 2) continue;
      const first = abs[0], last = abs[abs.length - 1];
      if (dist(first, last) <= 10) continue;
      const a = nearestTile(first, nodes, radius), b = nearestTile(last, nodes, radius);
      if (!a || !b || a.id === b.id) continue;
      const key = pairKey(a.id, b.id);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromNodeId: a.id, toNodeId: b.id, drawingId: d.id });
    }
    return edges;
  }

  // ── Map Check helpers (Dungeon Maker lints) ─────────────────────────────────
  /** Tiles reachable from `start`, honouring one-way links; `open(link)` decides passability. */
  function reachable(start, links, open = () => true) {
    const seen = new Set([start]), q = [start];
    const list = Object.values(links || {});
    while (q.length) {
      const c = q.shift();
      for (const l of list) {
        if (l.off || !open(l)) continue;
        let n = null;
        if (l.a === c) n = l.b; else if (l.b === c && !l.oneWay) n = l.a;
        if (n && !seen.has(n)) { seen.add(n); q.push(n); }
      }
    }
    return seen;
  }
  /**
   * Basic map lints. `tileIds` = every tile on the map; `start` = the entrance.
   * unreachable — no route from the entrance even with every lock open
   * traps       — reachable, but no way back to the entrance (one-way mistakes)
   */
  function mapCheck({ tileIds, links, start }) {
    const all = [...(tileIds || [])];
    const from = reachable(start, links);
    const unreachable = all.filter(id => !from.has(id));
    const traps = all.filter(id => from.has(id) && id !== start && !reachable(id, links).has(start));
    return { unreachable, traps };
  }

  DP.LinksCore = { snapRadius, normalizePoints, migrateDrawings, edgesFromLinks, sameNeighbours, legacyEdges, reachable, mapCheck, pairKey };
})();
