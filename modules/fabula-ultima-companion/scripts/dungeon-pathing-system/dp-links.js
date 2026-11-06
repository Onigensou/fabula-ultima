// ============================================================================
// Dungeon Pathing — Links (scene data) + link layer
//
// Replaces Foundry Drawing lines as the way dungeon tiles are linked. The data
// model and all pure rules are in dp-links-core.js; this file is the Foundry
// side:
//
//   DP.Links      read a scene's links, migrate a scene's Drawings to links
//   DP.LinkLayer  draws the links (one PIXI.Graphics per link, keyed by link id)
//
// Phase A look = today's look: thin white lines that stop at the tile edges,
// drawn in the primary group on the Drawings sort layer (above tiles, below
// tokens), exactly where Foundry drew the old Drawing lines. The Dungeon
// chart look replaces drawLink() later.
//
// dp-fog.js fades the paths of invisible tiles through LinkLayer.get(id).alpha,
// so redraws REUSE each link's Graphics (its alpha survives a redraw).
//
// Migration (GM, game running):
//   await DungeonPathing.Links.migrateScene(game.scenes.getName("Valley_Map010"))          // dry run
//   await DungeonPathing.Links.migrateScene(scene, { apply: true })                        // write
//   await DungeonPathing.Links.migrateAll({ apply: true })                                 // every dungeon
// A scene is only written when its walkable graph is provably unchanged.
// ============================================================================
(() => {
  const DP   = globalThis.DungeonPathing ??= {};
  const TAG  = "[DungeonPathing][Links]";
  const MOD  = "fabula-ultima-companion";
  const ROOT = "dungeonPathing";
  const Core = () => DP.LinksCore;

  // Old "cameraFollowToken" scenes that are dungeons; migration also sets their mode.
  const LEGACY_DUNGEONS = ["Vastwind_Field001", "Vastwind_Field002"];

  const dpFlags = (scene) => scene?.flags?.[MOD]?.[ROOT] ?? {};
  const switchOn = (name) => { try { return globalThis.oni?.GameState?.getSwitch?.(name) === true; } catch { return false; } };
  const sceneMode = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode ?? "";

  function isMigrated(scene) { return !!dpFlags(scene).linksVersion; }
  function read(scene) { return isMigrated(scene) ? (dpFlags(scene).links ?? {}) : {}; }
  function hasSwitchLocks(scene) { return Object.values(read(scene)).some(l => l?.requiresSwitch); }
  function touchesLinks(diff) {
    const f = diff?.flags?.[MOD]?.[ROOT];
    return !!f && ("links" in f || "linksVersion" in f || "-=links" in f);
  }

  // ── Migration ──────────────────────────────────────────────────────────────
  function sceneInput(scene) {
    const tiles = scene.tiles.contents.map(t => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height, hidden: t.hidden }));
    const drawings = scene.drawings.contents.map(d => ({ id: d.id, x: d.x, y: d.y, hidden: d.hidden, shape: { points: [...(d.shape?.points ?? [])] }, flags: d.flags }));
    return { tiles, drawings, gridSize: scene.grid?.size };
  }

  /**
   * Convert one scene's Drawing lines to links. Dry run unless `apply`.
   * Refuses to write when the walkable graph would change.
   */
  async function migrateScene(scene, { apply = false } = {}) {
    if (!scene) throw new Error("no scene");
    const report = { scene: scene.name, id: scene.id, already: isMigrated(scene) };
    if (report.already) return { ...report, applied: false, note: "already migrated" };
    const input = sceneInput(scene), core = Core();
    const r = core.migrateDrawings(input);
    const nodeIds = input.tiles.filter(t => !t.hidden).map(t => t.id);
    const cmp = core.sameNeighbours(core.legacyEdges({ ...input, switchOn }), core.edgesFromLinks(r.links, nodeIds, { switchOn }));
    const setMode = LEGACY_DUNGEONS.includes(scene.name) && sceneMode(scene) !== "dungeon";
    Object.assign(report, { links: Object.keys(r.links).length, deleteDrawings: r.migrated.length, kept: r.kept, duplicates: r.duplicates,
      sameGraph: cmp.same, diffs: cmp.diffs, setDungeonMode: setMode, applied: false });
    if (!apply) return report;
    if (!game.user?.isGM) throw new Error("GM only");
    if (!cmp.same) { console.error(TAG, "graph would change — not migrating", scene.name, cmp.diffs); return { ...report, note: "refused: graph would change" }; }

    const upd = {
      [`flags.${MOD}.${ROOT}.links`]: r.links,
      [`flags.${MOD}.${ROOT}.linksVersion`]: 1,
      [`flags.${MOD}.${ROOT}.linksMigration`]: { at: new Date().toISOString(), drawings: r.migrated.length, kept: r.kept.map(k => k.id) },
    };
    if (setMode) upd[`flags.${MOD}.oniFabula.general.sceneMode`] = "dungeon";
    await scene.update(upd);
    if (r.migrated.length) await scene.deleteEmbeddedDocuments("Drawing", r.migrated);
    console.info(TAG, `migrated ${scene.name}: ${report.links} links, ${r.migrated.length} drawings removed${setMode ? ", mode set to Dungeon" : ""}`);
    return { ...report, applied: true };
  }

  /**
   * Every dungeon scene (plus the legacy dungeons). Dry run unless `apply`.
   * Never views or activates a scene. As a guard, every scene's "visited" flag
   * (dp-scene-travel.js, drives Fast Travel) is recorded first and put back if
   * anything changed it, so a migration can never unlock Fast Travel stops.
   */
  async function migrateAll({ apply = false } = {}) {
    const out = [];
    const visitedKey = `flags.${MOD}.oniFabula.general.sceneVisited`;
    const visitedBefore = new Map(game.scenes.contents.map(s => [s.id, foundry.utils.getProperty(s, visitedKey) ?? null]));
    for (const scene of game.scenes.contents) {
      if (sceneMode(scene) !== "dungeon" && !LEGACY_DUNGEONS.includes(scene.name)) continue;
      try { out.push(await migrateScene(scene, { apply })); }
      catch (e) { out.push({ scene: scene.name, error: String(e?.message ?? e) }); }
    }
    if (apply) {
      const restored = [];
      for (const s of game.scenes.contents) {
        const was = visitedBefore.get(s.id), now = foundry.utils.getProperty(s, visitedKey) ?? null;
        if (was !== now) { await s.update({ [visitedKey]: was }); restored.push(s.name); }
      }
      if (restored.length) console.warn(TAG, "visited flag changed during migration and was restored on:", restored);
      out.visitedRestored = restored;
    }
    console.table(out.map(r => ({ scene: r.scene, links: r.links, deleted: r.deleteDrawings, kept: r.kept?.length, same: r.sameGraph, applied: r.applied, note: r.note ?? r.error ?? "" })));
    return out;
  }

  DP.Links = { MOD, ROOT, LEGACY_DUNGEONS, isMigrated, read, switchOn, hasSwitchLocks, touchesLinks, migrateScene, migrateAll };

  // ── Link layer ─────────────────────────────────────────────────────────────
  // "Dungeon chart" look: thin white paths with a soft drop shadow that run
  // into the tile centres, drawn UNDER the tile art.
  const STYLE = { color: 0xffffff, main: 3, side: 2.2, alpha: 1, shadow: 0x000000, shadowAlpha: 0.55, sx: 1.5, sy: 2 };
  const GM_DIM = 0.25;                                       // GM sees switched-off / locked links faintly
  let _root = null, _scene = null, _queued = false;
  const _g = new Map();                                      // link id → PIXI.Graphics

  function destroy() {
    for (const g of _g.values()) { g.parent?.removeChild(g); g.destroy(); }
    _g.clear();
    if (_root) { _root.parent?.removeChild(_root); _root.destroy({ children: true }); }
    _root = null; _scene = null;
  }

  function ensureRoot() {
    if (_root && !_root.destroyed && _root.parent) return _root;
    if (!canvas?.primary) return null;
    const root = new PIXI.Container();
    root.name = "oniDungeonLinks";
    root.eventMode = "none";
    root.elevation = 0;
    root.sortLayer = globalThis.PrimaryCanvasGroup?.SORT_LAYERS?.TILES ?? 500;
    root.sort = -1e6;
    canvas.primary.addChild(root);
    canvas.primary.sortDirty = true;
    _root = root;
    return root;
  }

  /** Sit one step below the lowest linked tile, on the tiles' own layer, so paths pass under the tile art. */
  function placeUnderTiles(root, links) {
    const ids = new Set(Object.values(links).flatMap(l => [l?.a, l?.b]));
    const meshes = (canvas?.tiles?.placeables ?? []).filter(t => ids.has(t.id) && t.mesh && !t.mesh.destroyed).map(t => t.mesh);
    if (!meshes.length) return;
    const elev = Math.min(...meshes.map(m => m.elevation ?? 0)), sort = Math.min(...meshes.map(m => m.sort ?? 0)) - 1;
    if (root.elevation !== elev || root.sortLayer !== meshes[0].sortLayer || root.sort !== sort) {
      root.elevation = elev; root.sortLayer = meshes[0].sortLayer; root.sort = sort; canvas.primary.sortDirty = true;
    }
  }

  function tileCenter(scene, id) {
    const t = scene.tiles.get(id); if (!t || t.hidden) return null;
    return { x: t.x + t.width / 2, y: t.y + t.height / 2, r: Math.min(t.width, t.height) / 2 };
  }

  /**
   * Points of a link from tile centre to tile centre (the tile art covers the ends).
   * A tile showing the fog / shroud "?" disc has its art hidden, so the path
   * stops at the disc's edge instead of running through it.
   */
  function linkPoints(scene, l) {
    const A = tileCenter(scene, l.a), B = tileCenter(scene, l.b);
    if (!A || !B) return null;
    const pts = [{ x: A.x, y: A.y }, ...(l.via ?? []).map(([x, y]) => ({ x, y })), { x: B.x, y: B.y }];
    const trim = (p, q, r) => { const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, k = Math.min(r, d / 2) / d; return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }; };
    if (DP.Fog?.hasDisc?.(l.a)) pts[0] = trim(pts[0], pts[1], A.r * 1.35);
    if (DP.Fog?.hasDisc?.(l.b)) pts[pts.length - 1] = trim(pts[pts.length - 1], pts[pts.length - 2], B.r * 1.35);
    return pts;
  }

  function strokePath(g, pts, dx, dy, dotted) {
    if (!dotted) { g.moveTo(pts[0].x + dx, pts[0].y + dy); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x + dx, pts[i].y + dy); return; }
    for (let i = 1; i < pts.length; i++) {          // dotted: short dashes along each segment
      const p = pts[i - 1], q = pts[i], d = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(1, Math.floor(d / 12));
      for (let k = 0; k < n; k++) { const t0 = k / n, t1 = Math.min(1, t0 + 0.5 / n);
        g.moveTo(p.x + (q.x - p.x) * t0 + dx, p.y + (q.y - p.y) * t0 + dy); g.lineTo(p.x + (q.x - p.x) * t1 + dx, p.y + (q.y - p.y) * t1 + dy); }
    }
  }
  function drawLink(g, pts, { dotted, side }) {
    const w = side ? STYLE.side : STYLE.main;
    g.clear();
    g.lineStyle({ width: w + 1.5, color: STYLE.shadow, alpha: STYLE.shadowAlpha, cap: "round", join: "round" });
    strokePath(g, pts, STYLE.sx, STYLE.sy, dotted);
    g.lineStyle({ width: w, color: STYLE.color, alpha: STYLE.alpha, cap: "round", join: "round" });
    strokePath(g, pts, 0, 0, dotted);
  }

  function redraw() {
    _queued = false;
    const scene = canvas?.scene;
    if (!scene || !isMigrated(scene)) { if (_root) destroy(); return; }
    if (_scene !== scene.id) { destroy(); _scene = scene.id; }
    const root = ensureRoot(); if (!root) return;
    const links = read(scene), gm = !!game.user?.isGM, alive = new Set();
    placeUnderTiles(root, links);
    for (const [id, l] of Object.entries(links)) {
      const pts = l && linkPoints(scene, l); if (!pts) continue;
      const shut = !!l.off || (!!l.requiresSwitch && !switchOn(l.requiresSwitch));
      if (shut && !gm) continue;                   // players never see a switched-off or locked link
      let g = _g.get(id);
      if (!g || g.destroyed) { g = new PIXI.Graphics(); g.name = `oniLink:${id}`; root.addChild(g); _g.set(id, g); }
      drawLink(g, pts, { dotted: shut, side: l.route === "side" });
      if (shut) g.alpha = GM_DIM;
      else if (g._oniWasShut) g.alpha = 1;          // re-opened: back to full (fog may lower it again)
      g._oniWasShut = shut;
      alive.add(id);
    }
    for (const [id, g] of _g) if (!alive.has(id)) { g.parent?.removeChild(g); g.destroy(); _g.delete(id); }
  }
  function queue() { if (_queued) return; _queued = true; requestAnimationFrame(redraw); }

  DP.LinkLayer = { get: (id) => _g.get(id) ?? null, root: () => (_root && !_root.destroyed ? _root : null), redraw: queue, destroy };

  Hooks.on("canvasReady", () => queue());
  Hooks.on("canvasTearDown", () => destroy());
  Hooks.on("updateScene", (scene, diff) => { if (scene.id === canvas?.scene?.id && touchesLinks(diff)) queue(); });
  for (const h of ["createTile", "updateTile", "deleteTile"]) Hooks.on(h, (doc) => { if (doc.parent?.id === canvas?.scene?.id && isMigrated(canvas.scene)) queue(); });
  Hooks.on("oniGameStateChanged", () => { if (hasSwitchLocks(canvas?.scene)) queue(); });
})();
