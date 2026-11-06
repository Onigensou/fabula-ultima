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
    return !!f && ("links" in f || "linksVersion" in f || "-=links" in f || "linkState" in f || "events" in f);
  }
  /** In-play state: { revealed, unlocked, broken, events, lastCheck } (dp-links-core.js). */
  function state(scene) { return dpFlags(scene).linkState ?? {}; }
  function events(scene) { return isMigrated(scene) ? (dpFlags(scene).events ?? []) : []; }

  // ── In-play changes: always written by the primary GM ──────────────────────
  // Any client asks; the primary GM writes the scene flag (GM Host / dedupe rule).
  const RAW_CH = `module.${MOD}`, MSG = "DP_LINKS";
  const isPrimaryGM = () => !!game.user?.isGM && (DP.isPrimaryGM?.() ?? true);
  const stateKey = (k) => `flags.${MOD}.${ROOT}.linkState.${k}`;

  /** op: reveal | unlock | break (payload.id) · land (payload.tileId) · check (payload.id) */
  function request(scene, op, payload = {}) {
    const p = { sceneId: scene.id, op, ...payload };
    if (isPrimaryGM()) return handle(p);
    game.socket.emit(RAW_CH, { type: MSG, payload: p });
  }
  async function handle(p) {
    const scene = game.scenes.get(p.sceneId); if (!scene || !isMigrated(scene)) return;
    if (p.op === "reveal") return scene.update({ [stateKey(`revealed.${p.id}`)]: true });
    if (p.op === "unlock") return scene.update({ [stateKey(`unlocked.${p.id}`)]: true });
    if (p.op === "break") return scene.update({ [stateKey(`broken.${p.id}`)]: true });
    if (p.op === "land") return runEvents(scene, "land", p.tileId);
    if (p.op === "check") return runCheck(scene, p.id);
  }
  Hooks.once("ready", () => game.socket?.on(RAW_CH, (msg) => {
    if (msg?.type !== MSG || !isPrimaryGM()) return;
    handle(msg.payload).catch(e => console.error(TAG, "link request failed", e));
  }));

  async function partyActors() {
    try {
      const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      const props = res?.db?.system?.props ?? {};
      return [1, 2, 3, 4].map(i => String(props[`member_id_${i}`] ?? "").trim().replace(/^Actor\./, "")).filter(Boolean).map(id => game.actors.get(id)).filter(Boolean);
    } catch { return []; }
  }
  async function partyHas(itemName) { return (await partyActors()).some(a => a.items?.some?.(i => i.name === itemName)); }

  /** Skill-check lock, run on the GM like a Gusty tile (DP.TileCheckGate is GM-only). */
  async function runCheck(scene, id) {
    const l = read(scene)[id]; if (!l?.lock || l.lock.type !== "check") return;
    const cfg = { mode: l.lock.mode ?? "group", leaderMode: "players_choose", attrA: l.lock.attrA ?? "MIG", attrB: l.lock.attrB ?? "DEX",
      dl: Number(l.lock.dl) || 10, triggerOn: "success", label: l.label || "Obstacle" };
    let pass = false;
    try { pass = !!(await DP.TileCheckGate?.request?.(await partyActors(), cfg))?.triggered; } catch (e) { console.warn(TAG, "link check failed", e); }
    const upd = { [stateKey("lastCheck")]: { id, pass, at: Date.now() } };
    if (pass && l.lock.stays !== false) upd[stateKey(`unlocked.${id}`)] = true;
    await scene.update(upd);
  }

  // ── Events: When → If → Then (primary GM only) ─────────────────────────────
  async function condOk(e) {
    const c = e.cond; if (!c || !c.type || c.type === "none") return true;
    if (c.type === "switch") return switchOn(c.arg);
    if (c.type === "item") return partyHas(c.arg);
    return true;
  }
  async function runAction(scene, a) {
    const L = read(scene)[a.arg];
    switch (a.type) {
      case "connect":   return scene.update({ [stateKey(`revealed.${a.arg}`)]: true });
      case "open":      if (L?.lock?.type === "switch") await globalThis.oni?.GameState?.setSwitch?.(L.lock.name, true);
                        return scene.update({ [stateKey(`unlocked.${a.arg}`)]: true });
      case "setSwitch": return globalThis.oni?.GameState?.setSwitch?.(a.arg, true);
      case "break":     return scene.update({ [stateKey(`broken.${a.arg}`)]: true });
      case "reveal":    return DP.TileState?.markFogRevealed?.(scene, a.arg);
      default:          console.warn(TAG, `event action "${a.type}" is not built yet`);
    }
  }
  async function runEvents(scene, trigger, arg) {
    if (!isPrimaryGM()) return;
    const due = Core().eventsFor(events(scene), trigger, arg, state(scene));
    for (const e of due) {
      if (!(await condOk(e))) continue;
      await scene.update({ [stateKey(`events.${e.id}`)]: true });     // once only, written first
      for (const a of e.then ?? []) { try { await runAction(scene, a); } catch (err) { console.error(TAG, "event action failed", e.id, a, err); } }
    }
  }
  Hooks.on("oniGameStateChanged", () => {
    if (!isPrimaryGM()) return; const sc = canvas?.scene; if (!isMigrated(sc)) return;
    for (const e of events(sc)) if (e.when?.type === "switch" && switchOn(e.when.arg)) runEvents(sc, "switch", e.when.arg).catch(() => {});
  });

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

  DP.Links = { MOD, ROOT, LEGACY_DUNGEONS, isMigrated, read, state, events, switchOn, hasSwitchLocks, touchesLinks, migrateScene, migrateAll,
    request, partyHas, partyActors };

  // ── Link layer ─────────────────────────────────────────────────────────────
  // "Dungeon chart" look: thin white paths with a soft drop shadow that run
  // into the tile centres, drawn UNDER the tile art. Each link is a Container
  // (path + markers); dp-fog fades that container's alpha for invisible tiles,
  // so redraws reuse it.
  //
  // Path states:  white = open · lock colour + token = locked · orange + "!" =
  // hazard · crack token = breaks after one crossing · running gold chevrons
  // only (no line) = one-way · GM-only dotted violet + eye = not found yet ·
  // GM-only faint dotted = switched off.
  const STYLE = { color: 0xffffff, main: 3, side: 2.2, alpha: 1, shadow: 0x000000, shadowAlpha: 0.55, sx: 1.5, sy: 2 };
  const GM_DIM = 0.25;
  const COL = { switch: 0x7cffb0, lever: 0xe8c070, key: 0xb89cff, check: 0xf0c060, hazard: 0xff9a4a, collapse: 0xe0a060, hidden: 0xc08cff, gold: 0xe8b84b };
  const GLYPH = { switch: "✺", lever: "⟋", key: "▣", check: "⚄", hazard: "!", collapse: "⌇", hidden: "◉" };
  let _root = null, _scene = null, _queued = false, _prev = null;
  const _c = new Map();                                      // link id → PIXI.Container { _line, _marks, _chev }
  const _fx = new Map();                                     // link id → { kind, t0, dur, fromB, color }
  let _tickOn = false;
  const reduce = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function destroy() {
    for (const c of _c.values()) { c.parent?.removeChild(c); c.destroy({ children: true }); }
    _c.clear(); _fx.clear(); _prev = null;
    if (_root) { _root.parent?.removeChild(_root); _root.destroy({ children: true }); }
    _root = null; _scene = null;
    if (_tickOn) { canvas?.app?.ticker?.remove(tick); _tickOn = false; }
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
  const pathLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; };
  function pointAt(pts, t) {
    const L = pathLen(pts) * Math.max(0, Math.min(1, t)); let s = 0;
    for (let i = 1; i < pts.length; i++) { const p = pts[i - 1], q = pts[i], d = Math.hypot(q.x - p.x, q.y - p.y);
      if (s + d >= L) { const k = d ? (L - s) / d : 0; return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, ang: Math.atan2(q.y - p.y, q.x - p.x) }; } s += d; }
    const p = pts[pts.length - 2], q = pts[pts.length - 1]; return { x: q.x, y: q.y, ang: Math.atan2(q.y - p.y, q.x - p.x) };
  }
  /** Sub-path between fractions t0..t1 (for draw-in). */
  function subPath(pts, t0, t1) {
    const out = [pointAt(pts, t0)], L = pathLen(pts); let s = 0;
    for (let i = 1; i < pts.length - 1; i++) { s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); const f = s / L; if (f > t0 && f < t1) out.push(pts[i]); }
    out.push(pointAt(pts, t1)); return out;
  }

  function strokePath(g, pts, dx, dy, dotted) {
    if (!dotted) { g.moveTo(pts[0].x + dx, pts[0].y + dy); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x + dx, pts[i].y + dy); return; }
    for (let i = 1; i < pts.length; i++) {          // dotted: short dashes along each segment
      const p = pts[i - 1], q = pts[i], d = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(1, Math.floor(d / 12));
      for (let k = 0; k < n; k++) { const t0 = k / n, t1 = Math.min(1, t0 + 0.5 / n);
        g.moveTo(p.x + (q.x - p.x) * t0 + dx, p.y + (q.y - p.y) * t0 + dy); g.lineTo(p.x + (q.x - p.x) * t1 + dx, p.y + (q.y - p.y) * t1 + dy); }
    }
  }
  function drawLine(g, pts, { dotted, side, color = STYLE.color, alpha = STYLE.alpha }) {
    const w = side ? STYLE.side : STYLE.main;
    g.lineStyle({ width: w + 1.5, color: STYLE.shadow, alpha: STYLE.shadowAlpha * alpha, cap: "round", join: "round" });
    strokePath(g, pts, STYLE.sx, STYLE.sy, dotted);
    g.lineStyle({ width: w, color, alpha, cap: "round", join: "round" });
    strokePath(g, pts, 0, 0, dotted);
  }
  /** Fade from nothing, masked: a soft front runs from the party's end toward the far end. */
  function drawSweep(g, pts, k, fromB, side) {
    const w = side ? STYLE.side : STYLE.main, n = Math.max(8, Math.round(pathLen(pts) / 6)), front = k * 1.4, soft = 0.4;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n, tt = fromB ? 1 - (t0 + t1) / 2 : (t0 + t1) / 2, a = Math.max(0, Math.min(1, (front - tt) / soft));
      if (a <= 0) continue; const e = a * a * (3 - 2 * a), seg = subPath(pts, t0, t1);
      g.lineStyle({ width: w + 1.5, color: STYLE.shadow, alpha: STYLE.shadowAlpha * e, cap: "round" }); strokePath(g, seg, STYLE.sx, STYLE.sy, false);
      g.lineStyle({ width: w, color: STYLE.color, alpha: e, cap: "round" }); strokePath(g, seg, 0, 0, false);
    }
  }

  /** Brass board-game token with a coloured face glyph. */
  function token(color, glyph, r = 11) {
    const c = new PIXI.Container(), g = new PIXI.Graphics();
    g.beginFill(0x000000, 0.4); g.drawEllipse(1.5, r * 0.45 + 2, r, r * 0.55); g.endFill();
    g.beginFill(0xc8960c); g.drawCircle(0, 0, r); g.endFill();
    g.beginFill(0xf6dc7a, 0.6); g.drawCircle(-r * 0.25, -r * 0.3, r * 0.45); g.endFill();
    g.beginFill(0x111111); g.drawCircle(0, 0, r * 0.76); g.endFill();
    g.lineStyle({ width: 1, color, alpha: 0.6 }); g.drawCircle(0, 0, r * 0.76);
    const t = new PIXI.Text(glyph, { fontFamily: "Signika, sans-serif", fontWeight: "700", fontSize: Math.round(r * 1.05), fill: color });
    t.anchor.set(0.5); c.addChild(g, t); return c;
  }
  function ribbon(text, color) {
    const c = new PIXI.Container(), t = new PIXI.Text(text, { fontFamily: "Signika, sans-serif", fontWeight: "700", fontSize: 10.5, fill: color });
    t.anchor.set(0.5); const w = t.width + 12, g = new PIXI.Graphics();
    g.lineStyle({ width: 1.2, color }); g.beginFill(0x1a1206); g.drawPolygon([-w / 2 - 4, 0, -w / 2, -7, w / 2, -7, w / 2 + 4, 0, w / 2, 7, -w / 2, 7]); g.endFill();
    c.addChild(g, t); return c;
  }

  /** What a link looks like right now (for this viewer). */
  function lookOf(id, l, st, gm) {
    if (!l || l.off || (l.requiresSwitch && !switchOn(l.requiresSwitch))) return gm ? { kind: "shut" } : null;
    if (st.broken?.[id]) return null;
    if (l.hidden && !st.revealed?.[id]) return gm ? { kind: "hidden" } : null;
    const lock = l.lock && !st.unlocked?.[id] && !(l.lock.type === "switch" && switchOn(l.lock.name)) ? l.lock : null;
    if (lock) { const k = lock.lever ? "lever" : lock.type; return { kind: "locked", lockKind: k, color: COL[k] ?? COL.key, dl: lock.type === "check" ? Number(lock.dl) || 10 : null }; }
    if (l.oneWay) return { kind: "oneway" };
    if (l.hazard) return { kind: "hazard" };
    if (l.collapse) return { kind: "collapse" };
    return { kind: "open" };
  }

  function paint(c, id, l, pts, look) {
    const line = c._line; line.clear(); c._marks.removeChildren().forEach(m => m.destroy({ children: true }));
    const side = l.route === "side", mid = pointAt(pts, 0.5), fx = _fx.get(id);
    c._pts = pts; c._look = look; c._side = side;
    if (fx && (fx.kind === "sweep" || fx.kind === "drawin" || fx.kind === "fall")) return;   // the ticker draws these
    switch (look.kind) {
      case "shut":     drawLine(line, pts, { dotted: true, side, alpha: GM_DIM }); return;
      case "hidden":   drawLine(line, pts, { dotted: true, side, color: COL.hidden, alpha: 0.55 }); addMark(c, token(COL.hidden, GLYPH.hidden, 9), mid, 0.7); return;
      case "locked":   drawLine(line, pts, { dotted: true, side, color: look.color });
                       addMark(c, token(look.color, GLYPH[look.lockKind] ?? "?"), mid);
                       if (look.dl) addMark(c, ribbon(`DL ${look.dl}`, look.color), { x: mid.x, y: mid.y + 22 });
                       return;
      case "oneway":   return;                                  // chevrons only, drawn by the ticker
      case "hazard":   drawLine(line, pts, { side, color: COL.hazard }); addMark(c, token(COL.hazard, GLYPH.hazard, 9.5), mid); return;
      case "collapse": drawLine(line, pts, { side }); addMark(c, token(COL.collapse, GLYPH.collapse, 9.5), mid); return;
      default:         drawLine(line, pts, { side });
    }
  }
  function addMark(c, m, p, alpha = 1) { m.position.set(p.x, p.y); m.alpha = alpha; c._marks.addChild(m); }

  // ── One shared ticker: one-way chevrons + reveal / unlock / break animations ──
  function tick() {
    const now = performance.now(); let busy = false;
    for (const [id, c] of _c) {
      if (c.destroyed) continue;
      if (c._look?.kind === "oneway" && c._pts) {            // running chevrons toward b
        busy = true; const g = c._chev, pts = c._pts, len = pathLen(pts), off = reduce() ? 0 : ((now / 28) % 18);
        g.clear();
        for (let d = 8 + off; d < len - 8; d += 18) { const p = pointAt(pts, d / len), ca = Math.cos(p.ang), sa = Math.sin(p.ang);
          const P = (x, y) => [p.x + x * ca - y * sa, p.y + x * sa + y * ca];
          for (const [w, col, a] of [[5, 0x140c00, 0.75], [2.6, COL.gold, 1]]) { g.lineStyle({ width: w, color: col, alpha: a, cap: "round", join: "round" });
            g.moveTo(...P(-5, -6)); g.lineTo(...P(3, 0)); g.lineTo(...P(-5, 6)); } }
      } else if (c._chev?.geometry?.graphicsData?.length) c._chev.clear();
      const fx = _fx.get(id); if (!fx) continue;
      busy = true; const k = Math.min(1, (now - fx.t0) / fx.dur), line = c._line;
      if (fx.kind === "sweep") { line.clear(); drawSweep(line, c._pts, k, fx.fromB, c._side); }
      else if (fx.kind === "drawin") { line.clear(); const t = Math.min(1, k / 0.7);
        const seg = fx.fromB ? subPath(c._pts, 1 - t, 1) : subPath(c._pts, 0, t); if (t > 0.01) drawLine(line, seg, { side: c._side });
        if (k > 0.7 && !c._stamp) { c._stamp = token(COL.gold, "∞", 11); const m = pointAt(c._pts, 0.5); c._stamp.position.set(m.x, m.y); c.addChild(c._stamp); }
        if (c._stamp) { const s = (k - 0.7) / 0.3, sc = s < 0.5 ? 1.9 - 1.8 * s : 1; c._stamp.scale.set(sc); c._stamp.alpha = k > 0.92 ? 1 - (k - 0.92) / 0.08 : 1; } }
      else if (fx.kind === "unlock") { const m = c._marks.children[0]; if (m) { m.scale.set(1 + k * 0.6); m.alpha = 1 - k; } }
      else if (fx.kind === "fall") { line.clear(); const n = Math.max(4, Math.round(pathLen(c._pts) / 10));
        for (let i = 0; i < n; i++) { const seg = subPath(c._pts, i / n, (i + 1) / n), drop = k * k * 70 * (1 + (i % 3) * 0.4);
          drawLine(line, seg.map(p => ({ x: p.x + (i % 2 ? 1 : -1) * k * 6, y: p.y + drop })), { side: c._side, alpha: Math.max(0, 1 - k * 1.1) }); } }
      if (k >= 1) { _fx.delete(id); if (c._stamp) { c._stamp.destroy(); c._stamp = null; } queue(); }
    }
    if (!busy) { canvas?.app?.ticker?.remove(tick); _tickOn = false; }
  }
  function wake() { if (_tickOn || !canvas?.app?.ticker) return; canvas.app.ticker.add(tick); _tickOn = true; }
  function startFx(id, kind, dur, extra = {}) { _fx.set(id, { kind, t0: performance.now(), dur: reduce() ? 1 : dur, ...extra }); wake(); }

  function redraw() {
    _queued = false;
    const scene = canvas?.scene;
    if (!scene || !isMigrated(scene)) { if (_root) destroy(); return; }
    if (_scene !== scene.id) { destroy(); _scene = scene.id; }
    const root = ensureRoot(); if (!root) return;
    const links = read(scene), st = state(scene), gm = !!game.user?.isGM, alive = new Set();
    placeUnderTiles(root, links);
    // Animate what changed since the last draw (not on first draw of a scene).
    const prev = _prev; _prev = JSON.parse(JSON.stringify(st));
    const here = DP.Runtime?.currentNodeId ?? null;
    if (prev) for (const [id, l] of Object.entries(links)) {
      if (st.revealed?.[id] && !prev.revealed?.[id]) {
        const fromB = here ? here === l.b : false;
        startFx(id, l.hidden?.by === "event" ? "drawin" : "sweep", l.hidden?.by === "event" ? 1700 : 1400, { fromB });
      }
      if ((st.unlocked?.[id] && !prev.unlocked?.[id])) startFx(id, "unlock", 900);
      if (st.broken?.[id] && !prev.broken?.[id]) startFx(id, "fall", 1100);
    }
    for (const [id, l] of Object.entries(links)) {
      const pts = l && linkPoints(scene, l); if (!pts) continue;
      let look = lookOf(id, l, st, gm);
      const fx = _fx.get(id);
      if (!look && fx?.kind === "fall") look = { kind: "open" };        // keep it on screen while it falls
      if (!look) continue;
      let c = _c.get(id);
      if (!c || c.destroyed) { c = new PIXI.Container(); c.name = `oniLink:${id}`; c._line = new PIXI.Graphics(); c._chev = new PIXI.Graphics(); c._marks = new PIXI.Container();
        c.addChild(c._line, c._chev, c._marks); root.addChild(c); _c.set(id, c); }
      if (fx?.kind === "unlock" && c._look?.kind === "locked") { c._pts = pts; }      // keep the old token while it pops
      else paint(c, id, l, pts, look);
      const shut = look.kind === "shut";
      if (shut) c.alpha = GM_DIM; else if (c._oniWasShut) c.alpha = 1;
      c._oniWasShut = shut;
      if (look.kind === "oneway" || fx) wake();
      alive.add(id);
    }
    for (const [id, c] of _c) if (!alive.has(id)) { c.parent?.removeChild(c); c.destroy({ children: true }); _c.delete(id); }
  }
  function queue() { if (_queued) return; _queued = true; requestAnimationFrame(redraw); }

  DP.LinkLayer = { get: (id) => _c.get(id) ?? null, root: () => (_root && !_root.destroyed ? _root : null), redraw: queue, destroy };

  Hooks.on("canvasReady", () => queue());
  Hooks.on("canvasTearDown", () => destroy());
  Hooks.on("updateScene", (scene, diff) => { if (scene.id === canvas?.scene?.id && touchesLinks(diff)) queue(); });
  for (const h of ["createTile", "updateTile", "deleteTile"]) Hooks.on(h, (doc) => { if (doc.parent?.id === canvas?.scene?.id && isMigrated(canvas.scene)) queue(); });
  Hooks.on("oniGameStateChanged", () => { if (isMigrated(canvas?.scene)) queue(); });
})();
