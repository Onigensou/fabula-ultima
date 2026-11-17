// ============================================================================
// Dungeon Pathing — Place badge
//
// A small pill under a dungeon tile that leads to a PLACE (an exploration map
// the party can come back to), so an Event / Story / Door tile that teleports
// somewhere reads as "a location" without its own art.
//
//   Normal view       pin + "LOCATION"
//   Helper (walkable) pin + the place name once visited, "????" before
//   Scan (every tile) pin + the place name once visited, "????" before
//
// Per-tile setting (Tile Config → Fast Travel section):
//   flags.fabula-ultima-companion.dungeonPathing.placeBadge
//     "" / unset = Off · "on" = always · "afterVisit" = only once visited
// Tile presets (Event / Story / Final Story / Settlement) carry "on"; doors and
// teleporters carry nothing. The only rule kept in code: a badge needs a working
// teleporter to ANOTHER scene, because that is where its name comes from.
//
// "Visited" (name instead of ????) = the destination scene was ever activated
// (sceneVisited) or the party has stepped on this tile. "After visit" tiles show
// only once the party has stepped on THIS tile. Fog / shroud discs and hidden passages hide
// the badge until the tile is revealed.
//
// Perf (feedback_dp_perf_pitfalls): one container per badged tile, rebuilt only
// when its label changes; containers are removed from their parent before destroy.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][PlaceBadge]";
  const MOD = "fabula-ultima-companion";
  const Z   = 999996.5;                 // above fog discs (999996), below hover (999997) and helper hands (999998)
  const MODES = new Set(["on", "afterVisit"]);

  const COL = {
    fill: 0x141008, gold: 0xe8b84b, goldText: "#f1cf72",
    unkLine: 0xa88c50, unkText: "#d9c9a5", hole: 0x141008,
  };

  const _badges = new Map();            // tileId → PIXI.Container (with ._key)

  // ── Rules ──────────────────────────────────────────────────────────────────
  function modeOf(tileDoc) {
    const v = tileDoc?.flags?.[MOD]?.[DP.PATHING_ROOT_KEY ?? "dungeonPathing"]?.placeBadge;
    return MODES.has(v) ? v : "";
  }

  function destSceneOf(scene, tileDoc) {
    const f = tileDoc?.flags?.[MOD]?.teleporter;
    if (!(f?.enabled === true || f?.enabled === "true")) return null;
    const id = f?.destination?.sceneId;
    if (!id || id === scene?.id) return null;
    return game.scenes?.get(id) ?? null;
  }

  function isVisited(scene, tileDoc, dest) {
    const g = dest?.flags?.[MOD]?.[DP.FABULA_ROOT_KEY ?? "oniFabula"]?.general;
    if (g?.sceneVisited === true || g?.sceneVisited === "true") return true;
    return !!DP.TileState?.isVisited?.(scene, tileDoc.id);
  }

  function placeName(scene, tileDoc) {
    return DP.FastTravel?.landmarkLabel?.(scene, tileDoc) || DP.locationName?.(tileDoc) || "Location";
  }

  /**
   * What the badge on this tile shows right now, or null when it shows nothing.
   * { visited, name, label, named }   label = what the pill reads
   */
  function info(tileId, scene = canvas?.scene) {
    const tileDoc = scene?.tiles?.get?.(tileId);
    if (!tileDoc) return null;
    const mode = modeOf(tileDoc);
    if (!mode) return null;
    if (tileDoc.hidden && !game.user?.isGM) return null;
    const dest = destSceneOf(scene, tileDoc);
    if (!dest) return null;
    const visited = isVisited(scene, tileDoc, dest);
    // After visit = the party has gone through THIS tile. Having reached the
    // place another way doesn't count (Sealed Cavern's way back to the Nether
    // Bridge stays plain even though the party knows the bridge).
    if (mode === "afterVisit" && !DP.TileState?.isVisited?.(scene, tileDoc.id)) return null;

    const rt = DP.Runtime;
    const near = rt?.currentNodeId === tileId || !!rt?.neighborIds?.has?.(tileId);
    if (DP.Fog?.isHiddenPassage?.(tileId)) return null;
    if (!near && DP.Fog?.isConcealed?.(tileId)) return null;

    const named = !!DP.ScanMode?.active || (!!DP.HelperMode?.enabled && !!rt?.neighborIds?.has?.(tileId));
    const name = placeName(scene, tileDoc);
    return { visited, name, named, label: !named ? "LOCATION" : (visited ? name : "????") };
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  function drawPin(g, x, y, s, color) {
    // Teardrop map pin, 9 x 11 units at s = 1, tip at (x, y + 5.5 s).
    const r = 3.6 * s, cy = y - 1.2 * s;
    g.beginFill(color);
    g.drawCircle(x, cy, r);
    g.drawPolygon([x - r * 0.86, cy + r * 0.5, x + r * 0.86, cy + r * 0.5, x, y + 5.5 * s]);
    g.endFill();
    g.beginFill(COL.hole);
    g.drawCircle(x, cy, r * 0.42);
    g.endFill();
  }

  function build(node, inf) {
    const w = node.bounds.right - node.bounds.left;
    const s = Math.max(0.75, Math.min(1.3, w / 34));
    const unk = inf.named && !inf.visited;
    const line = unk ? COL.unkLine : COL.gold;

    const text = new PIXI.Text(inf.label, {
      fontFamily: "Signika, sans-serif", fontWeight: "700",
      fontSize: (inf.named ? 10.5 : 9.5) * s, letterSpacing: inf.named ? 0.2 : 0.5,
      fill: unk ? COL.unkText : COL.goldText,
    });
    text.resolution = 4;
    text.anchor.set(0, 0.5);

    const h = (inf.named ? 17 : 15) * s, padX = (inf.named ? 7 : 5) * s;
    const pinW = 9 * s, gap = 3 * s;
    const pw = padX * 2 + pinW + gap + text.width;

    const root = new PIXI.Container();
    root.name = `ONI_DP_PlaceBadge_${node.nodeId}`;
    root.zIndex = Z;
    root.x = node.center.x;
    root.y = node.bounds.bottom + 3 * s;

    const g = new PIXI.Graphics();
    g.beginFill(0x000000, 0.35); g.drawRoundedRect(-pw / 2 + 1, 1.5, pw, h, h / 2); g.endFill();   // soft drop shadow
    g.lineStyle({ width: 1, color: line, alpha: 1 });
    g.beginFill(COL.fill, 0.92); g.drawRoundedRect(-pw / 2, 0, pw, h, h / 2); g.endFill();
    g.lineStyle(0);
    const px = -pw / 2 + padX + pinW / 2;
    drawPin(g, px, h / 2, s, unk ? 0xd9c9a5 : 0xf1cf72);
    root.addChild(g);

    text.position.set(-pw / 2 + padX + pinW + gap, h / 2);
    root.addChild(text);
    return root;
  }

  function destroyOne(tileId) {
    const c = _badges.get(tileId);
    _badges.delete(tileId);
    if (!c) return;
    try { c.parent?.removeChild(c); } catch {}
    try { c.destroy({ children: true }); } catch {}
  }

  function destroyAll() { for (const id of [..._badges.keys()]) destroyOne(id); }

  function refresh() {
    try {
      const rt = DP.Runtime, scene = canvas?.scene;
      if (!rt?.active || !rt.graph?.nodes || !scene || !canvas?.stage) return destroyAll();
      const seen = new Set();
      for (const node of rt.graph.nodes) {
        const inf = info(node.nodeId, scene);
        if (!inf) continue;
        seen.add(node.nodeId);
        const key = `${inf.label}|${inf.named}|${inf.visited}|${node.center.x},${node.bounds.bottom}`;
        const old = _badges.get(node.nodeId);
        if (old && !old.destroyed && old.parent && old._key === key) continue;
        destroyOne(node.nodeId);
        const c = build(node, inf);
        c._key = key;
        canvas.stage.sortableChildren = true;
        canvas.stage.addChild(c);
        _badges.set(node.nodeId, c);
      }
      for (const id of [..._badges.keys()]) if (!seen.has(id)) destroyOne(id);
    } catch (e) {
      console.warn(TAG, "refresh failed", e);
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  Hooks.on(DP.HOOKS?.GRAPH_REBUILT ?? "dungeonPathing.graphRebuilt", () => refresh());
  Hooks.on("canvasTearDown", () => destroyAll());
  Hooks.on("updateTile", (tileDoc, diff) => {
    if (tileDoc.parent?.id !== canvas?.scene?.id) return;
    const f = diff?.flags?.[MOD];
    if (f && (f.teleporter !== undefined || f[DP.PATHING_ROOT_KEY ?? "dungeonPathing"] !== undefined)) refresh();
  });

  DP.PlaceBadge = { modeOf, info, refresh, destroyAll };
  console.debug(TAG, "loaded");
})();
