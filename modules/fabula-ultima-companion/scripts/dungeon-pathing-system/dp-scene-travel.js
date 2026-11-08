// ============================================================================
// Dungeon Pathing System — Scene Travel
//
// Lets players travel between Town / Dungeon / Overworld scenes they have
// previously visited.  Activated by the travel button shown in Exploration
// and Dungeon scene modes when Fast Travel is enabled.
//
// Flow:
//   1. Player clicks travel button → showDialog()
//   2. JRPG-styled dialog lists visited Town + Dungeon scenes as panel buttons
//   3. Player clicks or presses Enter on a destination → confirmation prompt
//   4. Gryphon pick-up animation → GM activates scene + places token at spawn
//   5. On arrival: token hidden → gryphon drops token off → gryphon flies away
//
// Scene flags (all under oniFabula.general.*):
//   isOverworld, isTown, isDungeon  — explicit type tags (set in Scene Config)
//   sceneVisited                   — auto-set true on first activation
//   spawnPoint = { x, y }          — manual spawn; falls back to scene centre
//   navigationName                 — custom name shown in the Travel dialog
//
// Socket messages (raw game.socket):
//   DP_MARK_SCENE_VISITED  — non-GM → GM: mark a scene as visited
//   DP_SCENE_TRAVEL        — player → GM: set up token + activate destination
//   DP_TRAVEL_ARRIVING     — broadcast before scene switch: prime drop-off anim
// ============================================================================
(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[DungeonPathing][SceneTravel]";

  const FABULA_ROOT = DP.FABULA_ROOT_KEY ?? "oniFabula";
  const GEN_KEY     = DP.GENERAL_KEY     ?? "general";
  const SOCKET_CH   = `module.${MODULE_ID}`;
  const MSG_VISITED = "DP_MARK_SCENE_VISITED";
  const MSG_TRAVEL  = "DP_SCENE_TRAVEL";
  const GUARD       = "__ONI_DP_ST_SOCKET__";

  // ── Scene-flag helpers ──────────────────────────────────────────────────────
  function general(scene) {
    return scene?.flags?.[MODULE_ID]?.[FABULA_ROOT]?.[GEN_KEY] ?? {};
  }

  function getSceneType(scene) {
    const g = general(scene);
    if (g.isDungeon)   return "dungeon";
    if (g.isTown)      return "town";
    if (g.isOverworld) return "overworld";
    // Fallback: infer from sceneMode when explicit type flags are not set.
    // Only an explicit isTown tag makes a town; an exploration map (a mural,
    // a bridge) is a place inside its region, listed with its entrances.
    if (g.sceneMode === "dungeon")     return "dungeon";
    if (g.sceneMode === "exploration") return "exploration";
    if (g.sceneMode === "camp")        return "camp";
    return null;
  }

  function isSceneVisited(scene) {
    return !!general(scene).sceneVisited;
  }

  function isFtEnabled(scene) {
    const raw = general(scene ?? canvas?.scene).fastTravelEnabled;
    return raw !== false && raw !== "false" && raw !== 0;
  }

  function getSpawnPoint(scene) {
    const sp = general(scene).spawnPoint;
    if (sp && typeof sp.x === "number" && typeof sp.y === "number") return sp;
    const w = scene?.width  ?? scene?.dimensions?.width  ?? 3000;
    const h = scene?.height ?? scene?.dimensions?.height ?? 3000;
    return { x: w / 2, y: h / 2 };
  }

  function getNavigationName(scene) {
    const name = general(scene)?.navigationName?.trim?.();
    return (name && name.length) ? name : (scene?.name ?? "");
  }

  // Emoji shown on the travel button — dungeon→🏘️ (town icon), everything else→⛰️
  function getTravelEmoji(scene) {
    const type = getSceneType(scene ?? canvas?.scene);
    return type === "dungeon" ? "🏘️" : "⛰️";
  }

  // ── Eligible destinations ───────────────────────────────────────────────────
  // Towns land on their spawn point. Every other visited map (dungeon,
  // exploration, camp) is listed under its REGION — the scene folder, e.g.
  // "Valley of the Dragon" — with the exact points the party can land on:
  //   • dungeon map: its visited landmarks (Fast Travel rules) + the doors the
  //     party is known to arrive through;
  //   • exploration / camp map: the arrival spot of each known door into it,
  //     else its spawn point when one is set.
  // A door is "known" when its tile was visited (dungeon map) or its map was
  // visited (exploration map). All derived from existing data — nothing new
  // is stored.
  const REGION_MODES = new Set(["dungeon", "exploration", "camp"]);

  function sceneModeOf(scene) { return general(scene).sceneMode ?? null; }
  function isTownScene(scene) { const v = general(scene).isTown; return v === true || v === "true"; }
  // Scene Config "Not a Travel Destination" (joke / secret / one-off maps, e.g. Misty Field).
  function isNoTravel(scene) { const v = general(scene).noTravelDestination; return v === true || v === "true"; }
  function regionOf(scene) { return scene?.folder?.id ?? scene?.folder ?? null; }
  function regionName(id) { return (id && game.folders?.get(id)?.name) || "Other Places"; }

  // "Valley of the Dragon - Lower Trail" under region "Valley of the Dragon" → "Lower Trail".
  function shortName(name, region) {
    const n = String(name ?? "").trim();
    const r = String(region ?? "").trim();
    if (r && n.toLowerCase().startsWith(r.toLowerCase() + " - ")) return n.slice(r.length + 3).trim() || n;
    return n;
  }

  function isEnabledTeleporter(tile) {
    const f = tile?.flags?.[MODULE_ID]?.teleporter;
    return (f?.enabled === true || f?.enabled === "true") && !!f?.destination;
  }

  function resolveDest(dest) {
    const sc = game.scenes?.get(dest?.sceneId);
    if (!sc) return null;
    if (dest.type === "tile") {
      const t = sc.tiles?.get?.(dest.tileId);
      return t ? { scene: sc, x: t.x + t.width / 2, y: t.y + t.height / 2, tileId: t.id } : null;
    }
    const x = Number(dest.x), y = Number(dest.y);
    return (Number.isFinite(x) && Number.isFinite(y)) ? { scene: sc, x, y, tileId: null } : null;
  }

  // sceneId → [{ x, y, tileId, fromSceneId }] for every known door into it.
  function buildArrivalIndex() {
    const idx = new Map();
    for (const src of game.scenes ?? []) {
      const srcMode = sceneModeOf(src);
      if (!srcMode || srcMode === "none") continue;
      for (const tile of src.tiles ?? []) {
        if (!isEnabledTeleporter(tile)) continue;
        const dest = tile.flags[MODULE_ID].teleporter.destination;
        if (!dest.sceneId || dest.sceneId === src.id) continue;
        // known: the party has used / seen this door. Dungeon maps only offer
        // known entrances; a fixed-landing map (exploration, camp) only needs
        // to be visited itself — e.g. Eisendrache Kingdom, where the party
        // started, before its Overworld door could ever be marked.
        const known = srcMode === "dungeon"
          ? !!DP.TileState?.isVisited?.(src, tile.id)
          : isSceneVisited(src);
        const p = resolveDest(dest);
        if (!p) continue;
        const list = idx.get(p.scene.id) ?? [];
        list.push({ x: p.x, y: p.y, tileId: p.tileId, fromSceneId: src.id, known, srcTileId: tile.id });
        idx.set(p.scene.id, list);
      }
    }
    return idx;
  }

  function tilePoint(scene, tile, region) {
    const FT = DP.FastTravel;
    return {
      tileId: tile.id,
      x: tile.x + tile.width / 2,
      y: tile.y + tile.height / 2,
      isDoor: !!FT?.isLocationNode?.(tile),
      label: shortName(FT?.landmarkLabel?.(scene, tile) ?? "Landmark", region),
    };
  }

  function pointsForScene(scene, arrivals, region) {
    const FT   = DP.FastTravel;
    const pts  = [];
    const seen = new Set();
    const add  = (p) => {
      const k = p.tileId ?? `${Math.round(p.x / 10)},${Math.round(p.y / 10)}`;
      if (seen.has(k)) return;
      seen.add(k);
      pts.push(p);
    };

    if (DP.isWorldMap?.(scene)) {
      // World map: ONE fixed landing point — the location node that leads
      // into the area the party is in now (Valley Underground → "Valley of
      // the Dragon - Entrance"), i.e. where they stood before entering it.
      // Prefer a visited node; else any visited location; else none.
      const hereRegion = regionOf(canvas?.scene);
      const nodes = (scene.tiles ?? []).filter(t => isEnabledTeleporter(t));
      const visited = (t) => !!DP.TileState?.isVisited?.(scene, t.id);
      const intoHere = nodes.filter(t => {
        const dest = game.scenes.get(t.flags[MODULE_ID].teleporter.destination?.sceneId);
        return dest && hereRegion && regionOf(dest) === hereRegion;
      });
      const pick = intoHere.find(visited) ?? intoHere[0] ?? nodes.find(visited)
        ?? (scene.tiles ?? []).find(t => FT?.isLandmark?.(scene, t) && visited(t));
      if (pick) add({ ...tilePoint(scene, pick, region), label: shortName(FT?.landmarkLabel?.(scene, pick) ?? "World Map", region) });
    } else if (sceneModeOf(scene) === "dungeon") {
      for (const tile of scene.tiles ?? []) {
        if (!FT?.isLandmark?.(scene, tile)) continue;
        if (!DP.TileState?.isVisited?.(scene, tile.id)) continue;
        add(tilePoint(scene, tile, region));
      }
      for (const a of arrivals) {
        if (!a.known) continue;
        const tile = (a.tileId && scene.tiles?.get?.(a.tileId)) || FT?.tileAtPoint?.(scene, a.x, a.y);
        if (!tile) continue;
        const t = FT?.landmarkType?.(scene, tile);
        if ((t === "story" || t === "final") && !DP.TileState?.isExpired?.(scene, tile.id)) continue;
        add(tilePoint(scene, tile, region));
      }
    } else {
      // Exploration / camp map: ONE fixed landing point, like a town — no
      // choosing. The map itself being visited is enough; its landing spot
      // comes from a door into it from a dungeon map (incl. the world map) —
      // a shop / inn reached only from inside a town is not a travel point.
      // Where to land, in order:
      //   1. the map's spawn point, if set;
      //   2. the entrance from the world map (Valley Entrance: "from Overworld");
      //   3. a door the party has used, else any door from a dungeon map.
      const doors = arrivals.filter(a => sceneModeOf(game.scenes.get(a.fromSceneId)) === "dungeon");
      if (doors.length) {
        const fromWorld = doors.find(a => DP.isWorldMap?.(game.scenes.get(a.fromSceneId)));
        const sp  = general(scene).spawnPoint ? getSpawnPoint(scene) : null;
        const pick = sp ?? fromWorld ?? doors.find(a => a.known) ?? doors[0];
        add({ tileId: null, x: pick.x, y: pick.y, isDoor: false, label: "Entrance" });
      } else if (general(scene).spawnPoint) {
        const sp = getSpawnPoint(scene);
        add({ tileId: null, x: sp.x, y: sp.y, isDoor: false, label: "Entrance" });
      }
    }
    // Two "Camp"s on one map → "Camp 1", "Camp 2".
    const count = {};
    for (const p of pts) count[p.label] = (count[p.label] ?? 0) + 1;
    const nth = {};
    for (const p of pts) if (count[p.label] > 1) p.label = `${p.label} ${(nth[p.label] = (nth[p.label] ?? 0) + 1)}`;
    return pts;
  }

  /**
   * Visited maps with their landing points, grouped by region.
   * @param {object} [o]
   * @param {string|null} [o.regionId]  only this region (undefined = all)
   * @param {string|null} [o.excludeSceneId]  default: the current map
   * @returns {{ scene, id, name, regionId, regionName, points }[]}
   */
  function getRegionMaps({ regionId = undefined, excludeSceneId = canvas?.scene?.id ?? null } = {}) {
    const arrivals = buildArrivalIndex();
    const maps = [];
    for (const scene of game.scenes ?? []) {
      if (scene.id === excludeSceneId) continue;
      if (!isSceneVisited(scene) || isTownScene(scene) || isNoTravel(scene)) continue;
      if (!REGION_MODES.has(sceneModeOf(scene))) continue;
      const world = !!DP.isWorldMap?.(scene);
      // The world map is its own section ("World Map"), not its scene folder.
      const rid = world ? "__worldmap__" : regionOf(scene);
      if (regionId !== undefined && rid !== regionId) continue;
      const rName  = world ? "World Map" : regionName(rid);
      const points = pointsForScene(scene, arrivals.get(scene.id) ?? [], rName);
      if (!points.length) continue;
      // dungeon = the party chooses where to land (map preview); place = fixed landing.
      const kind = (!world && sceneModeOf(scene) === "dungeon") ? "dungeon" : "place";
      maps.push({ scene, id: scene.id, name: shortName(getNavigationName(scene), rName), regionId: rid, regionName: rName, points, world, kind });
    }
    // World map first, then the region the party is in, then the rest A→Z;
    // inside a region, dungeon maps before places.
    const hereRegion = regionOf(canvas?.scene);
    maps.sort((a, b) =>
      (b.world - a.world) ||
      ((b.regionId === hereRegion) - (a.regionId === hereRegion)) ||
      a.regionName.localeCompare(b.regionName) ||
      ((a.kind === "dungeon" ? 0 : 1) - (b.kind === "dungeon" ? 0 : 1)) ||
      String(a.scene.name).localeCompare(String(b.scene.name), undefined, { numeric: true }));
    return maps;
  }

  function getEligibleDestinations() {
    const current = canvas?.scene;
    const towns = [];
    for (const scene of game.scenes ?? []) {
      if (scene.id === current?.id) continue;
      if (!isSceneVisited(scene) || !isTownScene(scene) || isNoTravel(scene)) continue;
      towns.push({ id: scene.id, name: scene.name, scene, type: "town" });
    }
    return { towns, maps: getRegionMaps() };
  }

  // ── JRPG dialog styles ──────────────────────────────────────────────────────
  const TRAVEL_STYLE_ID = "oni-dp-travel-dialog-styles";

  function injectTravelStyles() {
    if (document.getElementById(TRAVEL_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = TRAVEL_STYLE_ID;
    s.textContent = `
/* === ONI JRPG Travel Dialog === */
.oni-jrpg-travel-dialog.dialog .window-header {
  background: linear-gradient(90deg,
    #3b1a06 0%, #6b3410 25%, #7a3c12 50%, #6b3410 75%, #3b1a06 100%) !important;
  border-bottom: 3px solid #2a1200 !important;
  color: #f5e2b4 !important;
  text-shadow: 0 1px 4px rgba(0,0,0,0.9);
  letter-spacing: 1px;
  font-family: serif;
}

.oni-jrpg-travel-dialog.dialog .window-content {
  background:
    radial-gradient(ellipse at 5% 95%, rgba(160,100,50,0.2) 0%, transparent 50%),
    radial-gradient(ellipse at 95% 5%, rgba(120,80,30,0.14) 0%, transparent 50%),
    linear-gradient(165deg, #f7eacc 0%, #ede1b6 35%, #e8d9a8 65%, #f0e4c0 100%) !important;
  border-top: none !important;
  box-shadow: inset 0 0 28px rgba(100,60,20,0.18) !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons {
  background: rgba(80,42,10,0.18) !important;
  border-top: 2px solid rgba(90,50,15,0.35) !important;
  padding: 8px !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons button {
  background: linear-gradient(180deg, #6e3712 0%, #4a2008 100%) !important;
  color: #f5e2b4 !important;
  border: 1px solid #3b1a06 !important;
  border-radius: 5px !important;
  font-family: serif !important;
  letter-spacing: 0.5px !important;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8) !important;
}

.oni-jrpg-travel-dialog.dialog .dialog-buttons button:hover {
  background: linear-gradient(180deg, #804020 0%, #5a2e10 100%) !important;
  filter: brightness(1.08) !important;
}

/* Category labels */
.oni-travel-category {
  font-family: serif;
  font-size: 11px;
  font-weight: 700;
  color: #5a2d0c;
  text-transform: uppercase;
  letter-spacing: 2px;
  padding: 6px 4px 4px;
  border-bottom: 1px solid rgba(90,45,12,0.35);
  margin: 8px 0 7px;
}
.oni-travel-category:first-child { margin-top: 2px; }
/* Dungeon / Places sub-group inside a region */
.oni-travel-sub {
  font-family: serif;
  font-size: 11px;
  font-weight: 700;
  font-style: italic;
  color: #7a3c12;
  letter-spacing: 1px;
  padding: 2px 4px 4px 10px;
  margin: 2px 0 4px;
}

/* Destination panel buttons */
.oni-travel-dest {
  position: relative;
  width: 100%;
  height: 72px;
  border: 2px solid #8b5a2b;
  border-radius: 8px;
  background: linear-gradient(135deg,
    rgba(248,235,198,0.97) 0%, rgba(232,214,172,0.93) 100%);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  box-shadow:
    0 2px 8px rgba(0,0,0,0.22),
    inset 0 1px 0 rgba(255,255,255,0.55),
    inset 0 -1px 0 rgba(0,0,0,0.08);
  transition:
    filter 150ms ease,
    transform 120ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
  text-align: left;
}
.oni-travel-dest:last-child { margin-bottom: 0; }
.oni-travel-dest:hover,
.oni-travel-dest.oni-travel-focused {
  filter: brightness(1.06);
  border-color: #c4852e;
  transform: translateY(-2px);
  box-shadow:
    0 0 0 2px rgba(196,133,46,0.4),
    0 6px 16px rgba(0,0,0,0.3),
    inset 0 1px 0 rgba(255,255,255,0.55);
}
.oni-travel-dest:active {
  transform: translateY(0);
  filter: brightness(0.95);
  box-shadow: 0 1px 4px rgba(0,0,0,0.22);
}

/* Left: name */
.oni-dest-left {
  position: relative;
  z-index: 2;
  padding: 0 12px 0 16px;
  flex: 0 0 auto;
  max-width: 56%;
}
.oni-dest-name {
  font-family: serif;
  font-size: 21px;
  font-weight: 900;
  color: #3d1f00;
  line-height: 1.15;
  text-shadow: 0 1px 0 rgba(255,255,255,0.65);
  word-break: break-word;
}

/* Right: scene thumbnail */
.oni-dest-thumb {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 65%;
  background-size: cover;
  background-position: center;
  opacity: 0.28;
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,0.45) 28%,
    rgba(0,0,0,0.85) 65%,
    #000 100%);
  mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,0.45) 28%,
    rgba(0,0,0,0.85) 65%,
    #000 100%);
}

/* Long lists scroll instead of running off screen */
.oni-travel-list { max-height: 62vh; overflow-y: auto; padding-right: 4px !important; }
    `;
    document.head.appendChild(s);
  }

  // ── Watcher copy (MirrorPrompt) ─────────────────────────────────────────────
  // The same destination list, display only, with the controller's focus.
  const ST_MIRROR_KIND = "dp.sceneTravel";

  function registerWatcher() {
    globalThis.FUCompanion?.api?.MirrorPrompt?.register?.(ST_MIRROR_KIND, {
      show(ctx) {
        if (!ctx.payload?.content) return null;
        injectTravelStyles();
        let btns = [];
        const setFocus = (idx) => btns.forEach((b, i) => b.classList.toggle("oni-travel-focused", i === idx));
        const d = new Dialog(
          {
            title:   `🗺️ Travel — ${ctx.operatorName} is choosing…`,
            content: ctx.payload.content,
            buttons: {},
            render:  (html) => {
              btns = Array.from(html[0].querySelectorAll(".oni-travel-dest"));
              btns.forEach(b => { b.disabled = true; b.style.pointerEvents = "none"; });
              setFocus(ctx.state?.focus ?? 0);
            },
          },
          { classes: ["oni-jrpg-travel-dialog", "dialog"], width: 420 }
        );
        d.render(true);
        return {
          patch: (state) => { if (Number.isInteger(state?.focus)) setFocus(state.focus); },
          close: () => { d.close().catch?.(() => {}); },
        };
      },
    });
  }

  // ── Map preview (pick a landing point on another map) ───────────────────────
  // The chosen map's image fills the screen with its landing points marked
  // (each point's own tile icon; nothing else of the map, so unexplored tiles
  // stay hidden). Same loop as Fast Travel: ◀ ▶ / arrow keys / wheel cycle the
  // points and the view pans + zooms to each; click a point or Enter picks it;
  // Esc goes back. Every other client watches a read-only copy (MirrorPrompt).
  const MP_MIRROR_KIND = "dp.mapPreview";
  const MP_STYLE_ID    = "oni-dp-map-preview-styles";

  function injectPreviewStyles() {
    if (document.getElementById(MP_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = MP_STYLE_ID;
    s.textContent = `
.oni-mp { position: fixed; inset: 0; z-index: 99990; background: rgba(8,5,2,0.86);
  opacity: 0; transition: opacity 260ms ease; }
.oni-mp.mp-visible { opacity: 1; }
.oni-mp img { border: none !important; box-shadow: none; max-width: none; }
.oni-mp-box { position: absolute; left: 70px; right: 70px; top: 64px; bottom: 56px; overflow: hidden;
  border: 2px solid rgba(200,160,80,0.65); border-radius: 8px; box-shadow: 0 0 24px rgba(0,0,0,0.7); background: #000; }
.oni-mp-world { position: absolute; left: 0; top: 0; transform-origin: 0 0;
  background-size: 100% 100%; background-repeat: no-repeat;
  transition: transform 500ms cubic-bezier(.4,0,.2,1); }
.oni-mp-pt { position: absolute; transform: translate(-50%,-50%); cursor: pointer; }
.oni-mp-pt.mp-ring { border-radius: 50%; border: 3px solid rgba(255,217,102,0.0); transition: border-color 200ms ease; }
.oni-mp-pt.mp-ring.mp-focused { border-color: rgba(255,217,102,0.95); }
.oni-mp-pt.mp-dot { border-radius: 50%; background: radial-gradient(circle, #ffe9a8 0%, #d9a441 70%, #8b5a2b 100%);
  border: 2px solid #3d1f00; }
.oni-mp-pt img.mp-hand { position: absolute; left: 70%; top: 50%; transform: translateY(-50%);
  filter: drop-shadow(0 0 6px rgba(0,0,0,0.8)); display: none; pointer-events: none; }
.oni-mp-pt.mp-focused img.mp-hand { display: block; }
.oni-mp-pt.mp-focused { filter: drop-shadow(0 0 10px rgba(255,217,102,0.95)); }
.oni-mp-title { position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  padding: 6px 22px; border-radius: 8px; white-space: nowrap; pointer-events: none;
  font-family: serif; font-size: 22px; font-weight: 900; color: #f5e2b4; text-shadow: 0 0 8px rgba(0,0,0,0.9);
  background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.94) 0%, rgba(45,32,14,0.97) 100%);
  border: 2px solid rgba(200,160,80,0.65); }
.oni-mp-title .mp-point { color: #e8c870; }
.oni-mp-hint { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); white-space: nowrap;
  font-family: "Signika", sans-serif; font-size: 15px; font-style: italic; color: #e8c870; pointer-events: none;
  text-shadow: 0 0 6px rgba(0,0,0,0.9); }
.oni-mp-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 80px;
  display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; user-select: none;
  font-size: 28px; color: #e8c870; text-shadow: 0 0 8px rgba(0,0,0,0.9);
  background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.92) 0%, rgba(45,32,14,0.96) 100%);
  border: 2px solid rgba(200,160,80,0.65); box-shadow: 0 0 14px rgba(0,0,0,0.55); }
.oni-mp-nav:hover { filter: brightness(1.2); }
.oni-mp-nav.mp-left { left: 10px; } .oni-mp-nav.mp-right { right: 10px; }
.oni-mp.mp-readonly .oni-mp-nav, .oni-mp.mp-readonly .oni-mp-pt { pointer-events: none; }
    `;
    document.head.appendChild(s);
  }

  // Path lines (SVG) + path tiles of a dungeon map into the preview world.
  // Player view only: hidden / switched-off paths are left out (LinkLayer),
  // invisible tiles stay hidden, fog / unrevealed shroud tiles show their disc.
  // Only tiles that are path nodes are drawn — not décor or effect tiles.
  // Returns the ids of the tiles drawn with their own art.
  function drawDungeonLayer(world, scene, d, W, H) {
    const drawn = new Set();
    if (sceneModeOf(scene) !== "dungeon") return drawn;
    const links = DP.LinkLayer?.playerLinks?.(scene) ?? [];
    if (!links.length) return drawn;

    const Fog = DP.Fog;
    const revealed = scene.flags?.[MODULE_ID]?.[DP.PATHING_ROOT_KEY ?? "dungeonPathing"]?.fogRevealed ?? {};
    const shown = (id) => {
      const t = scene.tiles?.get?.(id);
      return !!t && !t.hidden && Fog?.getFogMode?.(t) !== "invisible";
    };

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible;";
    const nodeIds = new Set();
    for (const l of links) {
      if (!shown(l.a) || !shown(l.b)) continue;
      nodeIds.add(l.a); nodeIds.add(l.b);
      const pts = l.pts.map(p => `${p.x - d.sceneX},${p.y - d.sceneY}`).join(" ");
      const w = l.side ? 2.2 : 3;
      for (const [stroke, width, opacity, dx, dy] of [["#000", w + 1.5, 0.55, 1.5, 2], [l.color, w, 1, 0, 0]]) {
        const pl = document.createElementNS(NS, "polyline");
        pl.setAttribute("points", pts);
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", stroke);
        pl.setAttribute("stroke-width", width);
        pl.setAttribute("stroke-opacity", opacity);
        pl.setAttribute("stroke-linecap", "round");
        pl.setAttribute("stroke-linejoin", "round");
        if (l.dotted) pl.setAttribute("stroke-dasharray", "2 7");
        if (dx || dy) pl.setAttribute("transform", `translate(${dx} ${dy})`);
        svg.appendChild(pl);
      }
    }
    world.appendChild(svg);

    for (const id of nodeIds) {
      const t = scene.tiles.get(id);
      const mode = Fog?.getFogMode?.(t);
      const veiled = mode === "fog" || (mode === "shroud" && !revealed[id]);
      const src = veiled ? (Fog?.TEXTURES?.[mode] ?? "") : (t.texture?.src ?? "");
      if (!src) continue;
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = `position:absolute;left:${t.x - d.sceneX}px;top:${t.y - d.sceneY}px;` +
        `width:${t.width}px;height:${t.height}px;pointer-events:none;`;
      world.appendChild(img);
      if (!veiled) drawn.add(id);
    }
    return drawn;
  }

  /**
   * Draw the preview. Returns { setFocus(i), close() }.
   * opts: { sceneId, name, points, focus, readOnly, operatorName, onFocus(i), onPick(i), onBack() }
   */
  function buildMapPreview(opts) {
    injectPreviewStyles();
    const scene = game.scenes.get(opts.sceneId);
    const pts   = opts.points ?? [];
    const esc   = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    const d     = scene?.dimensions ?? { sceneX: 0, sceneY: 0, sceneWidth: scene?.width ?? 1000, sceneHeight: scene?.height ?? 1000 };
    const W = d.sceneWidth, H = d.sceneHeight;
    const grid = Number(scene?.grid?.size ?? 100) || 100;
    const img  = scene?.background?.src ?? scene?.thumb ?? "";

    const root = document.createElement("div");
    root.className = "oni-mp" + (opts.readOnly ? " mp-readonly" : "");
    root.innerHTML = `
      <div class="oni-mp-box"><div class="oni-mp-world" style="width:${W}px;height:${H}px;background-image:url('${img}');"></div></div>
      <div class="oni-mp-title"></div>
      ${pts.length > 1 ? `<div class="oni-mp-nav mp-left">&#9664;</div><div class="oni-mp-nav mp-right">&#9654;</div>` : ""}
      <div class="oni-mp-hint">${opts.readOnly
        ? `${esc(opts.operatorName ?? "The leader")} is choosing where to land…`
        : "◀ ▶ / wheel: choose · click or Enter: travel · Esc: back"}</div>`;
    const box   = root.querySelector(".oni-mp-box");
    const world = root.querySelector(".oni-mp-world");
    const title = root.querySelector(".oni-mp-title");

    // Dungeon map: draw it as the party would see it on the board — its path
    // lines and path tiles, with the same fog rules (nothing a player can't see).
    const drawnTiles = drawDungeonLayer(world, scene, d, W, H);

    const els = pts.map((p, i) => {
      const tile = p.tileId ? scene?.tiles?.get?.(p.tileId) : null;
      const onBoard = !!(tile && drawnTiles.has(tile.id));
      // A point already drawn on the board gets a ring around it; any other
      // point (exploration map entrance) a gold dot about one grid square wide.
      const size = onBoard ? Math.max(tile.width, tile.height) * 1.25 : grid * 0.6;
      const el = document.createElement("div");
      el.className = "oni-mp-pt" + (onBoard ? " mp-ring" : " mp-dot");
      el.style.left = `${p.x - d.sceneX}px`;
      el.style.top  = `${p.y - d.sceneY}px`;
      el.style.width = el.style.height = `${size}px`;
      el.innerHTML = `<img class="mp-hand" src="${DP.HAND_CURSOR_URL}" style="width:${size * 0.9}px;height:${size * 0.9}px;filter:sepia(1) saturate(4) hue-rotate(5deg) brightness(1.15);">`;
      if (!opts.readOnly) el.addEventListener("click", (ev) => { ev.stopPropagation(); opts.onPick?.(i); });
      world.appendChild(el);
      return el;
    });

    let focus = Math.min(Math.max(0, opts.focus ?? 0), Math.max(0, pts.length - 1));
    const frame = (i) => {
      const bw = box.clientWidth || window.innerWidth - 140;
      const bh = box.clientHeight || window.innerHeight - 120;
      const fit = Math.min(bw / W, bh / H);
      // Camera like on the board: the map's own starting zoom (scene initial view),
      // scaled to the preview box; else a close-up of fit. Never smaller than fit.
      const boardZoom = Number(scene?.initial?.scale) || 0;
      const s = Math.max(fit, boardZoom ? boardZoom * Math.min(bw / window.innerWidth, bh / window.innerHeight) : Math.min(1.2, fit * 2.2));
      const p = pts[i] ?? { x: d.sceneX + W / 2, y: d.sceneY + H / 2 };
      let tx = bw / 2 - (p.x - d.sceneX) * s;
      let ty = bh / 2 - (p.y - d.sceneY) * s;
      tx = W * s <= bw ? (bw - W * s) / 2 : Math.min(0, Math.max(bw - W * s, tx));
      ty = H * s <= bh ? (bh - H * s) / 2 : Math.min(0, Math.max(bh - H * s, ty));
      world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    };
    const setFocus = (i) => {
      if (!pts.length) return;
      focus = ((i % pts.length) + pts.length) % pts.length;
      els.forEach((el, k) => el.classList.toggle("mp-focused", k === focus));
      title.innerHTML = `${esc(opts.name)} — <span class="mp-point">${esc(pts[focus]?.label)}</span>`;
      frame(focus);
    };

    if (!opts.readOnly) {
      root.querySelector(".mp-left")?.addEventListener("click", () => opts.onFocus?.(focus - 1));
      root.querySelector(".mp-right")?.addEventListener("click", () => opts.onFocus?.(focus + 1));
      root.addEventListener("wheel", (ev) => { ev.preventDefault(); opts.onFocus?.(focus + (ev.deltaY > 0 ? 1 : -1)); }, { passive: false });
    }
    document.body.appendChild(root);
    // First frame without the pan animation, then fade in.
    world.style.transition = "none";
    setFocus(focus);
    requestAnimationFrame(() => { world.style.transition = ""; root.classList.add("mp-visible"); });
    const onResize = () => frame(focus);
    window.addEventListener("resize", onResize);

    return {
      get focus() { return focus; },
      setFocus,
      close() {
        window.removeEventListener("resize", onResize);
        root.classList.remove("mp-visible");
        setTimeout(() => root.remove(), 280);
      },
    };
  }

  function registerPreviewWatcher() {
    globalThis.FUCompanion?.api?.MirrorPrompt?.register?.(MP_MIRROR_KIND, {
      show(ctx) {
        const p = ctx.payload ?? {};
        if (!p.sceneId) return null;
        const view = buildMapPreview({ ...p, focus: ctx.state?.focus ?? 0, readOnly: true, operatorName: ctx.operatorName });
        return {
          patch: (state) => { if (Number.isInteger(state?.focus)) view.setFocus(state.focus); },
          close: () => view.close(),
        };
      },
    });
  }

  /** Operator: preview map m and let the player pick a point. → point | null (back). */
  function pickPointOnMap(m) {
    return new Promise((resolve) => {
      const points = m.points.map(p => ({ x: p.x, y: p.y, tileId: p.tileId ?? null, isDoor: !!p.isDoor, label: p.label }));
      const mirror = globalThis.FUCompanion?.api?.MirrorPrompt?.open?.(MP_MIRROR_KIND,
        { sceneId: m.id, name: m.name, points }) ?? null;
      let done = false;
      let view = null;
      const finish = (val) => {
        if (done) return;
        done = true;
        window.removeEventListener("keydown", onKey, true);
        view?.close();
        mirror?.close(val == null ? null : view?.focus ?? null);
        resolve(val);
      };
      const focusTo = (i) => {
        view.setFocus(i);
        mirror?.patch({ focus: view.focus });
        DP.Sound?.playFastTravelCycle?.();
      };
      const pick = (i) => {
        if (i !== view.focus) { view.setFocus(i); mirror?.patch({ focus: view.focus }); }
        DP.Sound?.playConfirm?.();
        finish(m.points[view.focus] ?? null);
      };
      const onKey = (ev) => {
        const k = ev.key;
        if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Enter", "Escape"].includes(k)) {
          ev.preventDefault(); ev.stopImmediatePropagation();
        } else return;
        if (k === "ArrowLeft" || k === "ArrowUp")    focusTo(view.focus - 1);
        if (k === "ArrowRight" || k === "ArrowDown") focusTo(view.focus + 1);
        if (k === "Enter")  pick(view.focus);
        if (k === "Escape") { DP.Sound?.playCancel?.(); finish(null); }
      };
      view = buildMapPreview({ sceneId: m.id, name: m.name, points, focus: 0, onFocus: focusTo, onPick: pick });
      window.addEventListener("keydown", onKey, true);
    });
  }

  // ── Travel dialog ───────────────────────────────────────────────────────────
  async function showDialog() {
    const currentScene = canvas?.scene;

    if (!isFtEnabled(currentScene)) {
      ui.notifications?.warn?.("Travel is disabled for this scene.");
      return;
    }

    const api = globalThis.__ONI_MOVEMENT_CONTROL_API__;
    if (api?.isCurrentUserMainController) {
      const isCtrl = await api.isCurrentUserMainController().catch(() => false);
      if (!isCtrl) {
        ui.notifications?.warn?.("Travel is only available to the Main Controller.");
        return;
      }
    }

    const { towns, maps } = getEligibleDestinations();

    if (!towns.length && !maps.length) {
      ui.notifications?.info?.("No places to travel to yet. Visit a town, a Camp or a map exit first!");
      return;
    }

    DP.Sound?.playConfirm?.();

    // Every destination is a button; `dests` holds what each one lands on.
    const dests = [];
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    const thumbOf = (scene) => {
      const thumb = scene.thumb ?? scene.background?.src ?? "";
      return thumb ? `<div class="oni-dest-thumb" style="background-image:url('${thumb}');"></div>` : "";
    };

    let content = `<div class="oni-travel-list" style="padding:2px 0;">`;

    if (towns.length) {
      content += `<div class="oni-travel-category"><i class="fas fa-city"></i> Towns</div>`;
      for (const e of towns) {
        const i = dests.push({ sceneId: e.id, point: null, label: getNavigationName(e.scene) }) - 1;
        content += `
          <button type="button" class="oni-travel-dest" data-dest="${i}" tabindex="-1">
            <div class="oni-dest-left"><div class="oni-dest-name">${esc(getNavigationName(e.scene))}</div></div>
            ${thumbOf(e.scene)}
          </button>`;
      }
    }

    // Each region: "Dungeon" maps (choose where to land on the preview) first,
    // then "Places" (fixed landing). The world map is one section by itself.
    let lastRegion = null, lastKind = null;
    for (const m of maps) {
      if (m.regionId !== lastRegion) {
        lastRegion = m.regionId; lastKind = null;
        content += `<div class="oni-travel-category"><i class="fas fa-map"></i> ${esc(m.regionName)}</div>`;
      }
      if (!m.world && m.kind !== lastKind) {
        lastKind = m.kind;
        content += m.kind === "dungeon"
          ? `<div class="oni-travel-sub"><i class="fas fa-dungeon"></i> Dungeon</div>`
          : `<div class="oni-travel-sub"><i class="fas fa-location-dot"></i> Places</div>`;
      }
      // Same panel button as before, one per map; the landing point is
      // chosen on the map preview that opens next.
      const i = dests.push({ sceneId: m.id, map: m }) - 1;
      content += `
        <button type="button" class="oni-travel-dest" data-dest="${i}" tabindex="-1">
          <div class="oni-dest-left"><div class="oni-dest-name">${esc(m.name)}</div></div>
          ${thumbOf(m.scene)}
        </button>`;
    }
    content += `</div>`;

    // Everyone else watches the destination list read-only, focus echoed.
    const mirror = globalThis.FUCompanion?.api?.MirrorPrompt?.open?.(ST_MIRROR_KIND, { content }) ?? null;

    const selectedId = await new Promise(resolve => {
      let resolved = false;
      let focusedIdx = 0;
      let keyHandler = null;

      const d = new Dialog(
        {
          title:   "🗺️ Travel",
          content,
          buttons: {
            cancel: {
              label:    "✕ Cancel",
              callback: () => {
                DP.Sound?.playCancel?.();
                if (!resolved) { resolved = true; resolve(null); }
              },
            },
          },
          default: "cancel",
          render:  (html) => {
            const container = html[0];
            const btns = Array.from(container.querySelectorAll(".oni-travel-dest"));
            if (!btns.length) return;

            const setFocus = (idx, sound = true) => {
              btns.forEach(b => b.classList.remove("oni-travel-focused"));
              focusedIdx = ((idx % btns.length) + btns.length) % btns.length;
              btns[focusedIdx]?.classList.add("oni-travel-focused");
              btns[focusedIdx]?.scrollIntoView?.({ block: "nearest" });
              mirror?.patch({ focus: focusedIdx });
              if (sound) DP.Sound?.playHover?.();
            };

            // Auto-select first button (no sound on init)
            setFocus(0, false);

            btns.forEach((btn, i) => {
              btn.addEventListener("mouseenter", () => setFocus(i));
              btn.addEventListener("click", () => {
                if (resolved) return;
                resolved = true;
                DP.Sound?.playConfirm?.();
                d.close();
                resolve(btn.dataset.dest ?? null);
              });
            });

            keyHandler = (ev) => {
              if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
                ev.preventDefault(); ev.stopPropagation();
                setFocus(focusedIdx + 1);
              } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
                ev.preventDefault(); ev.stopPropagation();
                setFocus(focusedIdx - 1);
              } else if (ev.key === "Enter") {
                ev.preventDefault(); ev.stopPropagation();
                const btn = btns[focusedIdx];
                if (btn && !resolved) {
                  resolved = true;
                  DP.Sound?.playConfirm?.();
                  d.close();
                  resolve(btn.dataset.dest ?? null);
                }
              }
              // Escape propagates naturally to Dialog's built-in close handler
            };
            window.addEventListener("keydown", keyHandler, true);
          },
          close: () => {
            if (keyHandler) {
              window.removeEventListener("keydown", keyHandler, true);
              keyHandler = null;
            }
            if (!resolved) { resolved = true; DP.Sound?.playCancel?.(); resolve(null); }
          },
        },
        { classes: ["oni-jrpg-travel-dialog", "dialog"], width: 420 }
      );
      d.render(true);
    });
    mirror?.close(selectedId ?? null);

    if (selectedId == null) return;
    const dest = dests[Number(selectedId)];
    if (!dest) return;
    if (dest.map && dest.map.kind !== "dungeon") {
      // World map / exploration / camp map: fixed landing point, straight to the confirm.
      return confirmAndTravel(dest.sceneId, dest.map.points[0], dest.map.name);
    }
    if (dest.map) {
      // Dungeon map: pick the landing point on the map preview; Esc = back.
      const point = await pickPointOnMap(dest.map);
      if (!point) return showDialog();
      const went = await confirmAndTravel(dest.sceneId, point, `${dest.map.name} — ${point.label}`);
      if (!went) return showDialog();
      return;
    }
    await confirmAndTravel(dest.sceneId, null, dest.label);
  }

  // Yes / No, then travel. point = { x, y, tileId, isDoor } or null (spawn point).
  async function confirmAndTravel(sceneId, point, label, { onConfirmed = null } = {}) {
    const destScene = game.scenes.get(sceneId);
    if (!destScene) return false;
    // Parchment Yes / No that every other client watches (teleporter prompt).
    const ask = globalThis.TeleporterSystem?.askYesNo;
    const confirmed = ask
      ? await ask(["Travel to ", label, "?"])
      : await Dialog.confirm({
          title:   "Confirm Travel",
          content: `<p style="text-align:center;padding:8px;">Travel to <b>${label}</b>?</p>`,
        });
    if (!confirmed) {
      DP.Sound?.playCancel?.();
      return false;
    }
    try { onConfirmed?.(); } catch (e) { console.warn(TAG, "onConfirmed:", e); }
    await executeTravelTo(destScene, point).catch(e => console.error(TAG, "executeTravelTo failed:", e));
    return true;
  }

  // Where the party token's centre goes. A dungeon tile lands like a walk
  // does (tile centre + the party token offset) so the map finds the node.
  function landingSpot(destScene, point) {
    if (!point) return getSpawnPoint(destScene);
    if (point.tileId && sceneModeOf(destScene) === "dungeon") {
      return {
        x: point.x + Number(DP.UI?.TOKEN_OFFSET?.x ?? 0),
        y: point.y + Number(DP.UI?.TOKEN_OFFSET?.y ?? 0),
      };
    }
    return { x: point.x, y: point.y };
  }

  // ── Execute travel ──────────────────────────────────────────────────────────
  async function executeTravelTo(destScene, point = null) {
    // Capture source scene BEFORE any scene switch
    const fromSceneId = canvas?.scene?.id ?? null;
    const dpState     = globalThis.__ONI_DUNGEON_PATHING__?.state ?? null;

    // Resolve party token: dungeon state first, then canvas fallback for exploration/town mode
    // (in non-dungeon scenes, bootstrap calls deactivate() which nulls state.partyToken)
    let token = dpState?.partyToken ?? null;
    if (!token && canvas?.ready) {
      token = await DP.Graph?.resolvePartyToken?.().catch(() => null) ?? null;
    }

    const spawn   = landingSpot(destScene, point);
    // Landing on a door: once the drop-off finishes, this client (the one
    // choosing) offers that door's own "Enter <place>?" prompt.
    window.__ONI_DP_DOOR_OFFER__ = (point?.isDoor && point.tileId)
      ? { sceneId: destScene.id, tileId: point.tileId }
      : null;
    const actorId = token?.actor?.id ?? token?.document?.actorId ?? null;

    // Play gryphon pick-up animation if there is a party token on the current canvas
    if (token && canvas?.ready) {
      const gSize = Number(canvas?.grid?.size ?? 100) || 100;
      const tw    = Number(token.document?.width  ?? 1) * gSize;
      const th    = Number(token.document?.height ?? 1) * gSize;
      const tkCX  = Number(token.document.x) + tw / 2;
      const tkCY  = Number(token.document.y) + th / 2;
      canvas.animatePan?.({ x: tkCX, y: tkCY, duration: 400 });
      game.socket.emit(SOCKET_CH, { type: "DP_FT_PAN", payload: { x: tkCX, y: tkCY } });
      await new Promise(r => setTimeout(r, 450));

      // Broadcast to non-controller clients; everyone plays eagle sound then gryphon together
      game.socket.emit(SOCKET_CH, { type: "DP_ST_ANIM", payload: { userId: game.user?.id } });
      await DP.Sound?.playFastTravelEagle?.(450).catch(() => {});
      const pickupResult = await DP.FastTravel?.runGryphonAnimation?.(token).catch(() => null);
      // Source token will be deleted by setupTokenAndActivate; release its guard now
      if (pickupResult?.pickupGuardId != null) Hooks.off("refreshToken", pickupResult.pickupGuardId);
    }

    // Install guards BEFORE the scene switch so the destination token is hidden from the start.
    // drawToken (one-shot): fires during Token._draw() — sets mesh.alpha=0 immediately.
    // refreshToken (persistent): fires after _refreshAlpha() on every render cycle —
    //   keeps mesh.alpha=0 until runDropOffAnimation releases it at the reveal moment.
    let drawGuardId   = null;
    let refreshGuardId = null;
    if (actorId) {
      drawGuardId = Hooks.on("drawToken", (tp) => {
        if (tp.document?.actorId !== actorId) return;
        if (tp.mesh) tp.mesh.alpha = 0;
        Hooks.off("drawToken", drawGuardId);
      });
      refreshGuardId = Hooks.on("refreshToken", (tp) => {
        if (tp.document?.actorId !== actorId) return;
        if (tp.mesh) tp.mesh.alpha = 0;
      });
    }

    // Prime drop-off animation on all clients before scene switch
    const dropOffPayload = { sceneId: destScene.id, actorId };
    window.__ONI_DP_DROPOFF_SCENE__ = { ...dropOffPayload, drawGuardId, refreshGuardId };
    game.socket.emit(SOCKET_CH, { type: "DP_TRAVEL_ARRIVING", payload: dropOffPayload });

    if (game.user?.isGM) {
      await setupTokenAndActivate(destScene, actorId, spawn.x, spawn.y, fromSceneId);
    } else {
      const travelPayload = { toSceneId: destScene.id, actorId, spawnX: spawn.x, spawnY: spawn.y, fromSceneId };
      game.socket.emit(SOCKET_CH, { type: MSG_TRAVEL, payload: travelPayload });
      // Watchdog: if the canvas hasn't switched after 3 s, the GM may have missed the
      // first message (rare near startup). Re-emit once — setupTokenAndActivate is idempotent.
      const departingId = canvas?.scene?.id ?? null;
      await new Promise(r => setTimeout(r, 3000));
      if (canvas?.scene?.id === departingId && canvas?.scene?.id !== destScene.id) {
        console.warn(TAG, "MSG_TRAVEL watchdog: destination not active after 3 s — re-emitting.");
        game.socket.emit(SOCKET_CH, { type: MSG_TRAVEL, payload: travelPayload });
      }
    }
  }

  // ── GM: ensure token on destination + activate scene ───────────────────────
  async function setupTokenAndActivate(destScene, actorId, spawnX, spawnY, fromSceneId = null) {
    if (!game.user?.isGM) return;

    const gSize = destScene.grid?.size ?? 100;

    // Token setup — wrapped so any unexpected throw never prevents scene activation.
    try {
      if (actorId) {
        const actor = game.actors.get(actorId);
        if (actor) {
          // Cleanup-first: delete any stale token for this actor at destination before creating fresh.
          const existingAtDest = destScene.tokens?.find?.(t => t.actorId === actorId) ?? null;
          if (existingAtDest) {
            await existingAtDest.delete()
              .catch(e => console.warn(TAG, "cleanup dest stale token:", e));
          }
          const tokenData   = actor.prototypeToken.toObject();
          tokenData.x       = Math.round(spawnX - (tokenData.width  ?? 1) * gSize / 2);
          tokenData.y       = Math.round(spawnY - (tokenData.height ?? 1) * gSize / 2);
          tokenData.actorId = actorId;
          await destScene.createEmbeddedDocuments("Token", [tokenData])
            .catch(e => console.warn(TAG, "token create failed:", e));
        }
      }
    } catch (e) {
      console.warn(TAG, "token setup failed (non-fatal — activate will still proceed):", e);
    }

    // Activate scene. If the first attempt throws or the canvas hasn't switched
    // after 2 s (rare near startup), retry once.
    try {
      await destScene.activate();
    } catch (e) {
      console.error(TAG, "scene activate attempt 1 threw:", e);
    }
    await new Promise(r => setTimeout(r, 2000));
    if (canvas?.scene?.id !== destScene.id) {
      console.warn(TAG, "scene not active 2 s after attempt 1 — retrying activate…");
      await destScene.activate()
        .catch(e => console.error(TAG, "scene activate attempt 2 threw:", e));
    }

    // Background cleanup: delete party token from source scene after we've already switched
    if (fromSceneId && actorId && fromSceneId !== destScene.id) {
      const fromScene = game.scenes.get(fromSceneId);
      const oldToken  = fromScene?.tokens?.find?.(t => t.actorId === actorId);
      if (oldToken) {
        oldToken.delete().catch(e => console.warn(TAG, "cleanup source token:", e));
      }
    }
  }

  // ── Scene-visited tracking ──────────────────────────────────────────────────
  async function markSceneVisited(scene) {
    if (!scene || !game.user?.isGM) return;
    if (isSceneVisited(scene)) return;
    await scene.setFlag(MODULE_ID, `${FABULA_ROOT}.${GEN_KEY}.sceneVisited`, true)
      .catch(e => console.warn(TAG, "markSceneVisited failed:", e));
    console.debug(TAG, `Scene "${scene.name}" marked as visited.`);
  }

  // ── Drop-off animation trigger (called from canvasReady) ────────────────────
  // By the time this runs, the drawToken guard installed in executeTravelTo has already fired
  // and set token.alpha = 0 as the token was drawn.  This function reinforces that hiding,
  // pans the camera, and then plays the drop-off animation.
  async function triggerDropOff(actorId, sceneMode, refreshGuardId = null) {
    if (!actorId) return;

    // Reinforce mesh hiding — the refreshToken guard should already be keeping mesh.alpha=0,
    // but belt-and-suspenders here in case of any timing gap.
    let token = canvas.tokens?.placeables?.find?.(t => t.document?.actorId === actorId) ?? null;
    if (token?.mesh) token.mesh.alpha = 0;

    if (sceneMode === "dungeon") {
      // Wait for dungeon pathing standby (graph rebuilt + party token assigned, max 5 s)
      await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 5000);
        Hooks.once("dungeonPathing.standbyStart", () => {
          if (!done) { done = true; clearTimeout(timer); resolve(); }
        });
      });
      // Prefer the dp-state token reference (most current after rebuild)
      const dpToken = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
      if (dpToken) { token = dpToken; }
      if (token?.mesh) token.mesh.alpha = 0;

      if (token && canvas?.ready) {
        const gSize = Number(canvas?.grid?.size ?? 100) || 100;
        const tw    = Number(token.document?.width  ?? 1) * gSize;
        const th    = Number(token.document?.height ?? 1) * gSize;
        canvas.animatePan?.({ x: Number(token.document.x) + tw / 2, y: Number(token.document.y) + th / 2, duration: 300 });
        await new Promise(r => setTimeout(r, 350));
        if (token.mesh) token.mesh.alpha = 0;
        await DP.FastTravel?.runDropOffAnimation?.(token, { refreshGuardId }).catch(() => {
          if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
          if (token?.mesh) token.mesh.alpha = 1;
        });
        const offer = window.__ONI_DP_DOOR_OFFER__;
        window.__ONI_DP_DOOR_OFFER__ = null;
        if (offer?.sceneId === canvas?.scene?.id && token?.document) {
          const tileDoc = canvas.scene.tiles?.get?.(offer.tileId);
          if (tileDoc) {
            globalThis.TeleporterSystem?.offerTeleport?.(tileDoc, token.document)
              ?.catch?.(e => console.warn(TAG, "door offer:", e));
          }
        }
      } else {
        if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
      }
    } else {
      if (token && canvas?.ready) {
        const gSize = Number(canvas?.grid?.size ?? 100) || 100;
        const tw    = Number(token.document?.width  ?? 1) * gSize;
        const th    = Number(token.document?.height ?? 1) * gSize;
        canvas.animatePan?.({ x: Number(token.document.x) + tw / 2, y: Number(token.document.y) + th / 2, duration: 400 });
        await new Promise(r => setTimeout(r, 450));
        if (token.mesh) token.mesh.alpha = 0;
        await DP.FastTravel?.runDropOffAnimation?.(token, { refreshGuardId }).catch(() => {
          if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
          if (token?.mesh) token.mesh.alpha = 1;
        });
      } else {
        if (refreshGuardId != null) Hooks.off("refreshToken", refreshGuardId);
      }
    }
  }

  // ── Socket listener ─────────────────────────────────────────────────────────
  function setupSocketListener() {
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      // Mark scene visited (non-GM → GM)
      if (msg?.type === MSG_VISITED) {
        if (!game.user?.isGM) return;
        if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;   // multi-GM dedupe
        const scene = game.scenes.get(msg.payload?.sceneId);
        if (scene) await markSceneVisited(scene);
        return;
      }

      // Cross-scene travel request (player → GM)
      if (msg?.type === MSG_TRAVEL) {
        if (!game.user?.isGM) return;
        // Multi-GM dedupe: gate to one GM so the destination token isn't
        // created twice and the scene isn't activated twice (delete-then-create
        // race in setupTokenAndActivate).
        if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;
        const { toSceneId, actorId, spawnX, spawnY, fromSceneId } = msg.payload ?? {};
        const dest = game.scenes.get(toSceneId);
        if (!dest) { console.warn(TAG, "travel: destination not found:", toSceneId); return; }
        await setupTokenAndActivate(dest, actorId, spawnX, spawnY, fromSceneId ?? null)
          .catch(e => console.error(TAG, "setupTokenAndActivate (socket) failed:", e));
        return;
      }

      // Prime drop-off animation on non-initiating clients
      if (msg?.type === "DP_TRAVEL_ARRIVING") {
        const { sceneId, actorId: aId } = msg.payload ?? {};
        // Install guards so the destination token is hidden from the moment it is drawn.
        let drawGId = null;
        let refreshGId = null;
        if (aId) {
          drawGId = Hooks.on("drawToken", (tp) => {
            if (tp.document?.actorId !== aId) return;
            if (tp.mesh) tp.mesh.alpha = 0;
            Hooks.off("drawToken", drawGId);
          });
          refreshGId = Hooks.on("refreshToken", (tp) => {
            if (tp.document?.actorId !== aId) return;
            if (tp.mesh) tp.mesh.alpha = 0;
          });
        }
        window.__ONI_DP_DROPOFF_SCENE__ = { sceneId, actorId: aId, drawGuardId: drawGId, refreshGuardId: refreshGId };
        return;
      }

      // Pick-up animation broadcast from the controller
      if (msg?.type === "DP_ST_ANIM") {
        if (msg.payload?.userId === game.user?.id) return;
        const tkn = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken ?? null;
        if (tkn) {
          (DP.Sound?.playFastTravelEagle?.(450) ?? Promise.resolve())
            .catch(() => {})
            .then(() => DP.FastTravel?.runGryphonAnimation?.(tkn, { waitForUpdate: true }))
            .catch(() => { if (tkn.mesh) tkn.mesh.alpha = 1; });
        }
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  DP.SceneTravel = {
    showDialog,
    getSceneType,
    getTravelEmoji,
    getNavigationName,
    isSceneVisited,
    isFtEnabled,
    getEligibleDestinations,
    getRegionMaps,
    regionOf,
    regionName,
    confirmAndTravel,
    markSceneVisited,
  };

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    injectTravelStyles(); // pre-inject so first dialog open is instant
    setupSocketListener();
    registerWatcher();
    registerPreviewWatcher();

    Hooks.on("canvasReady", async () => {
      const scene = canvas?.scene;

      // Drop-off animation — token is hidden by the pre-installed guards.
      const dropOff = window.__ONI_DP_DROPOFF_SCENE__;
      if (dropOff?.sceneId === scene?.id) {
        window.__ONI_DP_DROPOFF_SCENE__ = null;
        // drawToken guard is one-shot — clean up defensively in case it never fired
        if (dropOff.drawGuardId != null) Hooks.off("drawToken", dropOff.drawGuardId);
        // refreshToken guard is handed to triggerDropOff → runDropOffAnimation — do NOT release here
        triggerDropOff(dropOff.actorId, general(scene).sceneMode, dropOff.refreshGuardId).catch(() => null);
      }

      // Auto-mark scene as visited when it becomes the active scene.
      // Only marks scenes with a sceneMode set to avoid marking every scene.
      if (!scene?.active) return;
      const sceneMode = general(scene).sceneMode;
      if (!sceneMode || sceneMode === "none") return;

      if (game.user?.isGM) {
        await markSceneVisited(scene);
      } else {
        game.socket.emit(SOCKET_CH, { type: MSG_VISITED, payload: { sceneId: scene.id } });
      }
    });

    console.debug(TAG, "Scene Travel System loaded.");
  });
})();
