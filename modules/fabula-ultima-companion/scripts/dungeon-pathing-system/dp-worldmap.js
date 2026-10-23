// ============================================================================
// Dungeon Pathing — World Map presentation (Phase 4)
// ----------------------------------------------------------------------------
//   Area entry      The party token crossing into a Fabula Area (dp-regions.js)
//                   plays the Area Name Panel on every client and, on the
//                   primary GM, swaps the music to the area's track.
//   Threat badges   Each Travel tile wears the die the party will actually
//                   roll there (tile → area → scene threat, Well-Traveled
//                   applied), coloured by threat.
//   Cleared stamps  A location tile whose "Cleared when switch" is ON shows ✓.
//   Locked routes   A path drawing with "Requires switch" is not walkable —
//                   and invisible to players — until that switch is ON.
//
// Switches are the Event System's (oni.GameState, on the party DB actor), so a
// story event that sets a switch opens a road or stamps a dungeon cleared.
// Locked routes work in any Dungeon-mode scene; the rest is world-map only.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const MOD = "fabula-ultima-companion";
  const TAG = "[DungeonPathing][WorldMap]";
  const PK  = () => DP.PATHING_ROOT_KEY ?? "dungeonPathing";

  const ARRIVAL_MUSIC_DELAY_MS = 2500;   // after the scene's own playlist starts
  const LOCKED_GM_ALPHA        = 0.25;   // GM still sees a locked route to edit it

  const THREAT_COLOR = Object.freeze({
    minimal: 0x6fbf73, low: 0xd8c25a, medium: 0xe0913c, high: 0xd9534f, very_high: 0x9b59d0,
  });

  const log  = (...a) => console.debug(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ── Switch gates ───────────────────────────────────────────────────────────
  const flagOf = (doc, key) => String(doc?.flags?.[MOD]?.[PK()]?.[key] ?? "").trim();
  const switchOn = (name) => {
    try { return globalThis.oni?.GameState?.getSwitch?.(name) === true; } catch { return false; }
  };

  /** A drawing with `requiresSwitch` set is locked while that switch is OFF. */
  function isRouteLocked(drawingDoc) {
    const name = flagOf(drawingDoc, "requiresSwitch");
    return !!name && !switchOn(name);
  }

  function isCleared(tileDoc) {
    const name = flagOf(tileDoc, "clearedSwitch");
    return !!name && switchOn(name);
  }

  const sceneHasGates = (scene) =>
    (scene?.drawings ?? []).some(d => flagOf(d, "requiresSwitch")) ||
    (scene?.tiles ?? []).some(t => flagOf(t, "clearedSwitch"));

  // Foundry's refresh resets a drawing's alpha, so re-apply after each refresh.
  function applyRouteAlpha(drawing) {
    if (!drawing?.document || !isRouteLocked(drawing.document)) return;
    drawing.alpha = game.user?.isGM ? LOCKED_GM_ALPHA : 0;
  }
  Hooks.on("refreshDrawing", (d) => { try { applyRouteAlpha(d); } catch {} });

  // A flag change does not refresh a drawing's state on its own; ask every
  // switch-gated drawing to refresh (that re-runs applyRouteAlpha, or restores
  // Foundry's own alpha once the route opens).
  function refreshGatedRoutes() {
    for (const d of canvas?.drawings?.placeables ?? []) {
      // Flagged drawings only: dp-fog hides "invisible" passages by alpha too,
      // and a refresh would flash those visible.
      if (flagOf(d.document, "requiresSwitch")) d.renderFlags?.set?.({ refreshState: true });
    }
  }
  Hooks.on(DP.HOOKS?.GRAPH_REBUILT ?? "dungeonPathing.graphRebuilt", () => { try { refreshGatedRoutes(); } catch {} });
  Hooks.on("updateDrawing", (doc) => {
    if (doc.parent?.id === canvas?.scene?.id) canvas.drawings?.get(doc.id)?.renderFlags?.set?.({ refreshState: true });
  });

  // A switch flipped (or a save loaded): re-gate routes and stamps.
  Hooks.on("oniGameStateChanged", () => {
    if (!sceneHasGates(canvas?.scene)) return;
    refreshGatedRoutes();
    globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch?.(() => {});
  });

  // ── Badges (threat die, cleared stamp) ─────────────────────────────────────
  let _layer = null;

  function ensureLayer() {
    if (_layer && !_layer.destroyed && _layer.parent) return _layer;
    if (!canvas?.stage) return null;
    const c = new PIXI.Container();
    c.name = "ONI DungeonPathing WorldMap Badges";
    c.zIndex = 999990;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(c);
    _layer = c;
    return c;
  }

  function clearBadges() {
    if (_layer && !_layer.destroyed) _layer.removeChildren().forEach(ch => ch.destroy({ children: true }));
  }

  function pill(text, fill, x, y, size) {
    const g = new PIXI.Container();
    const t = new PIXI.Text(text, { fontFamily: "Signika, sans-serif", fontSize: size, fontWeight: "bold",
                                    fill: 0xffffff, stroke: 0x000000, strokeThickness: 2 });
    const w = t.width + size * 0.7, h = t.height + 2;
    const bg = new PIXI.Graphics();
    bg.beginFill(0x1c140a, 0.88).lineStyle(1.5, fill, 1).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
    t.anchor.set(0.5);
    g.addChild(bg, t);
    g.position.set(x, y);
    return g;
  }

  // The die is what the party rolls: Well-Traveled steps it down (travel-roll-api).
  async function effectiveDieFn() {
    const TR = globalThis.TravelRoll;
    if (!TR) return (f) => f;
    const members = await TR.resolvePartyMembers?.().catch?.(() => []) ?? [];
    const wt = TR.getWellTraveledHolder?.(members);
    return (f) => (wt ? TR.reduceDieOneSize(f) : f);
  }

  const concealed = (scene, tileDoc) => {
    const mode = flagOf(tileDoc, "fogMode");
    if (!mode) return false;
    return !(mode === "shroud" && DP.TileState?.isFogRevealed?.(scene, tileDoc.id));
  };

  async function drawBadges() {
    const scene = canvas?.scene;
    clearBadges();
    if (!scene || !DP.isWorldMap?.(scene)) return;
    const layer = ensureLayer();
    if (!layer) return;
    const eff = await effectiveDieFn();
    const TR  = globalThis.TravelRoll;
    // The party sprite stands on its node — a badge there would cover it.
    const hereId = globalThis.__ONI_DUNGEON_PATHING__?.state?.currentNode?.nodeId ?? null;

    for (const tileDoc of scene.tiles ?? []) {
      if (tileDoc.hidden || concealed(scene, tileDoc) || tileDoc.id === hereId) continue;
      const type = DP.TileState?.getCurrentType?.(scene, tileDoc.id);
      const cx = tileDoc.x + tileDoc.width / 2;
      const size = Math.max(9, Math.round(tileDoc.height * 0.42));

      if (type === DP.TILE_TYPES.TRAVEL && TR) {
        const level = DP.Travel?.threatFor?.(tileDoc, scene) ?? "medium";
        const die = eff(TR.getDieFormula(level)).replace(/^1/, "");
        layer.addChild(pill(die, THREAT_COLOR[level] ?? 0xffffff, cx, tileDoc.y - size * 0.7, size));
      }
      if (isCleared(tileDoc)) {
        // Above the tile: location nodes never carry a threat badge, and below
        // sits the route and often the party sprite.
        layer.addChild(pill("✓ Cleared", 0xe8c870, cx, tileDoc.y - size * 0.7, size));
      }
    }
  }

  Hooks.on(DP.HOOKS?.GRAPH_REBUILT ?? "dungeonPathing.graphRebuilt", () => {
    drawBadges().catch(e => warn("badges failed", e));
  });
  Hooks.on("canvasTearDown", () => { clearBadges(); _layer = null; });

  // Painting or editing an Area changes the threat under a Travel tile without
  // any graph rebuild — redraw the badges directly.
  const redrawIfHere = (doc) => {
    const scene = doc?.parent?.documentName === "Scene" ? doc.parent : doc?.parent?.parent;
    if (scene?.id === canvas?.scene?.id) drawBadges().catch(e => warn("badges failed", e));
  };
  for (const h of ["createRegion", "updateRegion", "deleteRegion",
                   "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(h, redrawIfHere);
  }

  // ── Area entry: panel on every client, music on the primary GM ─────────────
  let _lastArea = { sceneId: null, regionId: null };
  let _areaMusic = null;   // { playlistId, soundId } we started

  const isPrimaryGM = () => game.user?.isGM && (globalThis.FUCompanion?.isPrimaryGM?.() ?? true);

  function partyTokenDoc(scene) {
    const t = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken;
    return (t?.document?.parent?.id === scene?.id) ? t.document : null;
  }

  // The area is decided by the NODE the party stands on, at its tile centre —
  // the same point encounters use. The token itself is no good: pathing draws
  // it offset from its tile (feet anchoring), so its centre can sit inside an
  // area while the tile it stands on is outside.
  function areaAtToken(scene, tokenDoc, pos = {}) {
    const g = scene?.grid?.size ?? canvas?.grid?.size ?? 100;
    const x = (pos.x ?? tokenDoc.x) + (tokenDoc.width ?? 1) * g / 2;
    const y = (pos.y ?? tokenDoc.y) + (tokenDoc.height ?? 1) * g / 2;
    const nodes = globalThis.__ONI_DUNGEON_PATHING__?.state?.graph?.nodes ?? [];
    const node  = DP.Graph?.findNodeForPoint?.({ x, y }, nodes);
    const tile  = node ? scene.tiles?.get?.(node.nodeId) : null;
    return DP.Areas?.areaAt?.(scene, tile ? { tile } : { point: { x, y } }) ?? null;
  }

  async function playAreaMusic(name) {
    for (const pl of game.playlists ?? []) {
      const snd = pl.sounds?.getName?.(name);
      if (!snd) continue;
      if (snd.playing) { _areaMusic = { playlistId: pl.id, soundId: snd.id }; return; }
      // v12 Playlist#playing is a boolean — `.playing?.length` would stop nothing.
      await Promise.allSettled((game.playlists ?? []).filter(p => p.playing).map(p => p.stopAll()));
      await pl.playSound(snd);
      _areaMusic = { playlistId: pl.id, soundId: snd.id };
      log(`area music: ${pl.name} / ${snd.name}`);
      return;
    }
    warn(`area music track not found in any playlist: "${name}"`);
  }

  /** Leave an area's music: stop our track and put the scene's own back. */
  async function restoreSceneMusic(scene) {
    if (!_areaMusic) return;
    const pl = game.playlists.get(_areaMusic.playlistId);
    const snd = pl?.sounds?.get(_areaMusic.soundId);
    _areaMusic = null;
    if (snd?.playing) await pl.stopSound(snd);
    const scenePl = scene?.playlist, sceneSnd = scene?.playlistSound;
    if (scenePl && sceneSnd) await scenePl.playSound(sceneSnd);
    else if (scenePl) await scenePl.playAll();
  }

  async function applyMusic(scene, hit) {
    if (!isPrimaryGM()) return;
    if (globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.()) return;
    const name = String(hit?.behavior?.system?.music ?? "").trim();
    if (name) await playAreaMusic(name);
    else await restoreSceneMusic(scene);
  }

  function onAreaChange(scene, hit) {
    if (hit && hit.behavior?.system?.announce !== false) {
      globalThis.FUCompanion?.api?.areaPanel?.announce?.(hit.region.name);
    }
    applyMusic(scene, hit).catch(e => warn("area music failed", e));
  }

  Hooks.on("updateToken", (tokenDoc, changes) => {
    try {
      if (!("x" in changes) && !("y" in changes)) return;
      const scene = tokenDoc.parent;
      if (scene?.id !== canvas?.scene?.id || !DP.isWorldMap?.(scene)) return;
      if (partyTokenDoc(scene)?.id !== tokenDoc.id) return;
      const hit = areaAtToken(scene, tokenDoc, { x: changes.x, y: changes.y });
      const regionId = hit?.region?.id ?? null;
      if (_lastArea.sceneId === scene.id && _lastArea.regionId === regionId) return;
      _lastArea = { sceneId: scene.id, regionId };
      onAreaChange(scene, hit);
    } catch (e) { warn("area entry check failed", e); }
  });

  // Arriving on a world map (scene change, battle return): remember where the
  // party stands without a banner — the scene's own Area Name Panel plays —
  // and bring the area's music in once the scene's playlist has started.
  Hooks.on(DP.HOOKS?.GRAPH_REBUILT ?? "dungeonPathing.graphRebuilt", () => {
    const scene = canvas?.scene;
    if (!scene || !DP.isWorldMap?.(scene) || _lastArea.sceneId === scene.id) return;
    const tok = partyTokenDoc(scene);
    if (!tok) return;
    const hit = areaAtToken(scene, tok);
    _lastArea = { sceneId: scene.id, regionId: hit?.region?.id ?? null };
    if (hit?.behavior?.system?.music) setTimeout(() => applyMusic(scene, hit).catch(() => {}), ARRIVAL_MUSIC_DELAY_MS);
  });
  Hooks.on("canvasTearDown", () => { _lastArea = { sceneId: null, regionId: null }; });

  // ── Drawing Config: the route lock field ───────────────────────────────────
  Hooks.on("renderDrawingConfig", (app, html) => {
    try {
      if (!game.user?.isGM) return;
      const root = html?.[0] ?? html;
      const doc  = app.document ?? app.object;
      if (!root || !doc || root.querySelector(".oni-route-lock")) return;
      const host = root.querySelector('.tab[data-tab="lines"]') ?? root.querySelector("form");
      if (!host) return;
      const wrap = document.createElement("div");
      wrap.className = "form-group oni-route-lock";
      wrap.innerHTML = `
        <label>Route requires switch</label>
        <div class="form-fields"><input type="text" placeholder="e.g. Bridge Repaired"
             name="flags.${MOD}.${PK()}.requiresSwitch" /></div>
        <p class="notes">Dungeon pathing: this path cannot be walked — and players cannot see it —
          until this Event System switch is ON. Blank = always open.</p>`;
      wrap.querySelector("input").value = flagOf(doc, "requiresSwitch");
      host.appendChild(wrap);
      app.setPosition?.({ height: "auto" });
    } catch (e) { warn("drawing config inject failed", e); }
  });

  DP.WorldMap = { isRouteLocked, isCleared, drawBadges, _internals: { effectiveDieFn, areaAtToken } };
})();
