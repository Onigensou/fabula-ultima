// ============================================================================
// Dungeon Maker — editor logic (GM only)
//
// Builds dungeons on the scene the GM is viewing: tiles, links (dp-links-core),
// gimmicks, fog, events. UI chrome lives in dp-maker-ui.js; this file owns the
// data writes, canvas input, the editor overlay and the practice-run Playtest.
//
// While the maker is open:
//   - left-button input on the canvas is captured here (DP's click/hover and
//     Foundry's layers don't see it); right-drag pan and wheel zoom still work
//   - every change first pushes a snapshot (undo/redo)
//   - nothing runs gameplay; Playtest moves a ghost party over a LOCAL copy of
//     the link state and shows tile events as notes. It writes nothing.
// ============================================================================
(() => {
  const DP   = globalThis.DungeonPathing ??= {};
  const TAG  = "[DungeonPathing][Maker]";
  const MOD  = "fabula-ultima-companion";
  const ROOT = "dungeonPathing";
  const Core = () => DP.LinksCore;
  const sc = () => canvas?.scene;
  const F = (k) => `flags.${MOD}.${ROOT}.${k}`;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const M = DP.Maker = {
    active: false, tool: "select", palType: "blank", gim: "gate", fogPart: "fog",
    selTile: null, selLink: null, linkFrom: null, pendingTrigger: null,
    undo: [], redo: [], playtest: null, busy: false,
    onChange: () => {},                       // dp-maker-ui.js re-renders
  };

  // ── Reading ────────────────────────────────────────────────────────────────
  const links = () => DP.Links.read(sc());
  const events = () => DP.Links.events(sc());
  const tileStates = () => sc()?.flags?.[MOD]?.[ROOT]?.tileStates ?? {};
  const typeOf = (id) => tileStates()[id]?.currentType ?? tileStates()[id]?.initialType ?? "blank";
  const label = (type) => String(DP.TileEventRegistry?.get?.(type)?.label ?? String(type ?? "Tile").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())).replace(/\s*\(.*\)$/, "").replace(/\s*Tile$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  function tileName(id) { const t = sc()?.tiles.get(id); if (!t) return "(gone)"; return t.getFlag(MOD, `${ROOT}.makerName`) || `${label(typeOf(id))} · ${id.slice(0, 4)}`; }
  function linkName(id) { const l = links()[id]; if (!l) return "(gone)"; return l.label || `${label(typeOf(l.a))} – ${label(typeOf(l.b))} · ${id.slice(0, 4)}`; }
  function center(id) { const t = sc()?.tiles.get(id); return t ? { x: t.x + t.width / 2, y: t.y + t.height / 2, w: t.width, h: t.height } : null; }
  /** Every tile type that has a sample somewhere in the world (so it can be cloned with its MAT setup). */
  function sampleTile(type) {
    for (const s of [sc(), ...game.scenes.contents]) { if (!s) continue; const st = s.flags?.[MOD]?.[ROOT]?.tileStates ?? {};
      for (const t of s.tiles.contents) if ((st[t.id]?.initialType ?? st[t.id]?.currentType) === type) return t; }
    return null;
  }
  function palette() {
    // Registered tile events plus every type the world's dungeons already use (Skill Check, Trap, Healing, Door…).
    const seen = new Set((DP.TileEventRegistry?.list?.() ?? []).map(r => r.typeKey));
    for (const s of game.scenes.contents) for (const st of Object.values(s.flags?.[MOD]?.[ROOT]?.tileStates ?? {})) if (st?.initialType) seen.add(st.initialType);
    seen.delete("unknown"); const types = [...seen];
    return types.filter(t => sampleTile(t)).map(t => ({ type: t, label: label(t), img: sampleTile(t)?.texture?.src }));
  }

  // ── Writing (each change is undoable) ──────────────────────────────────────
  function snapshot() {
    const s = sc();
    return { links: foundry.utils.deepClone(links()), events: foundry.utils.deepClone(events()), tileStates: foundry.utils.deepClone(tileStates()),
      tiles: s.tiles.contents.map(t => t.toObject()) };
  }
  async function change(fn) {
    if (M.busy) return; M.busy = true;
    try { M.undo.push(snapshot()); if (M.undo.length > 40) M.undo.shift(); M.redo = []; await fn(); }
    catch (e) { console.error(TAG, e); ui.notifications?.error?.(`Dungeon Maker: ${e.message ?? e}`); }
    finally { M.busy = false; M.onChange(); }
  }
  /**
   * Replace the scene's links with `next`. Foundry MERGES flag objects on update,
   * so a key a path no longer has (a removed lock, an old lock's item…) would
   * survive a plain write: changed or removed paths are deleted first, then the
   * full set is written.
   */
  async function writeLinks(next) {
    const s = sc(), cur = links(), del = {};
    for (const id of Object.keys(cur)) if (!(id in next) || JSON.stringify(cur[id]) !== JSON.stringify(next[id])) del[F(`links.-=${id}`)] = null;
    if (Object.keys(del).length) await s.update(del);
    await s.update({ [F("links")]: next, [F("linksVersion")]: 1 });
  }
  async function writeEvents(next) { await sc().update({ [F("events")]: next, [F("linksVersion")]: 1 }); }
  async function restore(snap) {
    const s = sc(), want = new Map(snap.tiles.map(t => [t._id, t])), have = new Map(s.tiles.contents.map(t => [t.id, t]));
    const del = [...have.keys()].filter(id => !want.has(id)); if (del.length) await s.deleteEmbeddedDocuments("Tile", del);
    const add = [...want.values()].filter(t => !have.has(t._id)); if (add.length) await s.createEmbeddedDocuments("Tile", add, { keepId: true });
    const upd = [...want.values()].filter(t => have.has(t._id)).map(t => { const h = have.get(t._id);
      return (h.x !== t.x || h.y !== t.y || h.texture.src !== t.texture.src || JSON.stringify(h.flags) !== JSON.stringify(t.flags)) ? { _id: t._id, x: t.x, y: t.y, texture: t.texture, flags: t.flags } : null; }).filter(Boolean);
    if (upd.length) await s.updateEmbeddedDocuments("Tile", upd);
    await writeLinks(snap.links); await writeEvents(snap.events); await s.update({ [F("tileStates")]: snap.tileStates });
  }
  M.undoStep = async () => { const snap = M.undo.pop(); if (!snap || M.busy) return; M.busy = true; try { M.redo.push(snapshot()); await restore(snap); } finally { M.busy = false; M.onChange(); } };
  M.redoStep = async () => { const snap = M.redo.pop(); if (!snap || M.busy) return; M.busy = true; try { M.undo.push(snapshot()); await restore(snap); } finally { M.busy = false; M.onChange(); } };
  M.restoreSnapshot = (snap) => change(() => restore(snap));
  M.snapshot = snapshot;

  async function cloneTile(type, x, y) {
    const src = sampleTile(type) ?? sampleTile("blank"); if (!src) throw new Error(`no ${type} tile to copy anywhere in the world`);
    const d = src.toObject(); delete d._id; d.x = Math.round(x - d.width / 2); d.y = Math.round(y - d.height / 2); d.hidden = false;
    foundry.utils.setProperty(d, `flags.${MOD}.${ROOT}.fogMode`, ""); foundry.utils.setProperty(d, `flags.${MOD}.${ROOT}.makerName`, "");
    const [t] = await sc().createEmbeddedDocuments("Tile", [d]);
    await sc().update({ [F(`tileStates.${t.id}`)]: { initialType: type, currentType: type, initialTexture: src.texture.src } });
    return t.id;
  }
  /** Change a tile's type: take the sample tile's art and event setup, keep position, fog and links. */
  async function retype(id, type) {
    const src = sampleTile(type); if (!src) throw new Error(`no ${type} tile to copy`);
    const t = sc().tiles.get(id), keepFog = t.getFlag(MOD, `${ROOT}.fogMode`) ?? "", keepName = t.getFlag(MOD, `${ROOT}.makerName`) ?? "";
    const flags = foundry.utils.deepClone(src.flags); foundry.utils.setProperty(flags, `${MOD}.${ROOT}.fogMode`, keepFog); foundry.utils.setProperty(flags, `${MOD}.${ROOT}.makerName`, keepName);
    await t.update({ "texture.src": src.texture.src, flags });
    await sc().update({ [F(`tileStates.${id}`)]: { initialType: type, currentType: type, initialTexture: src.texture.src } });
  }
  const newId = () => foundry.utils.randomID(16);

  M.ops = {
    placeTile: (x, y) => change(async () => { M.selTile = await cloneTile(M.palType, x, y); M.selLink = null; }),
    moveTile: (id, x, y) => change(async () => { const t = sc().tiles.get(id); await t.update({ x: Math.round(x - t.width / 2), y: Math.round(y - t.height / 2) }); }),
    retype: (id, type) => change(() => retype(id, type)),
    setFog: (id, mode) => change(() => sc().tiles.get(id).update({ [`flags.${MOD}.${ROOT}.fogMode`]: mode })),
    renameTile: (id, name) => change(() => sc().tiles.get(id).update({ [`flags.${MOD}.${ROOT}.makerName`]: name })),
    eraseTile: (id) => change(async () => {
      const L = foundry.utils.deepClone(links()); for (const [k, l] of Object.entries(L)) if (l.a === id || l.b === id) delete L[k];
      const E = events().filter(e => e.when?.arg !== id).map(e => ({ ...e, then: (e.then ?? []).filter(a => a.arg !== id) }));
      await writeLinks(L); await writeEvents(E); await sc().deleteEmbeddedDocuments("Tile", [id]); M.selTile = null; }),
    addLink: (a, b, extra = {}) => change(async () => { if (Core().linkBetween(links(), a, b, { revealed: new Proxy({}, { get: () => true }) })) return;
      const id = newId(), L = { ...foundry.utils.deepClone(links()), [id]: { a, b, route: "main", oneWay: false, via: [], off: false, requiresSwitch: "", label: "", ...extra } };
      await writeLinks(L); M.selLink = id; M.selTile = null; }),
    /** Draw-a-path: new tiles + links in one change. chain = [{ id } | { x, y }] in order. */
    drawChain: (chain) => change(async () => { const ids = [];
      for (const p of chain) ids.push(p.id ?? await cloneTile("blank", p.x, p.y));
      const L = foundry.utils.deepClone(links());
      for (let i = 1; i < ids.length; i++) if (!Core().linkBetween(L, ids[i - 1], ids[i], { revealed: new Proxy({}, { get: () => true }) }))
        L[newId()] = { a: ids[i - 1], b: ids[i], route: "main", oneWay: false, via: [], off: false, requiresSwitch: "", label: "" };
      await writeLinks(L); }),
    patchLink: (id, patch) => change(async () => { const L = foundry.utils.deepClone(links()); if (!L[id]) return;
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete L[id][k]; else L[id][k] = v; } await writeLinks(L); }),
    eraseLink: (id) => change(async () => { const L = foundry.utils.deepClone(links()); delete L[id];
      await writeLinks(L); await writeEvents(events().map(e => ({ ...e, then: (e.then ?? []).filter(a => a.arg !== id) }))); M.selLink = null; }),
    setEvents: (E) => change(() => writeEvents(E)),
  };

  // ── Gimmicks: ready-made bundles dropped on a path ─────────────────────────
  const HAZARD_DEFAULT = { enabled: true, targetMode: "all", useResourceChange: true, resourceType: "damage", resourceValue: 5, elementType: "elementless",
    ignoreReduction: false, weaponType: "none_ef", useActiveEffect: false, activeEffectsJson: "", vfxType: "none", silent: false };
  M.GIMMICKS = {
    gate:     { name: "Gate",              col: "#b89cff", glyph: "▣", desc: "Locked until the party uses a key item.", patch: () => ({ lock: { type: "key", item: "Rusty Key", consume: false } }), label: "Iron gate" },
    ward:     { name: "Ward",              col: "#7cffb0", glyph: "✺", desc: "Sealed until a switch turns ON. Then click the tile that lifts it (Esc = leave it to a story event).", patch: () => ({ lock: { type: "switch", name: "Ward" } }), label: "Ward of light", trigger: "setSwitch" },
    obstacle: { name: "Obstacle",          col: "#f0c060", glyph: "⚄", desc: "A skill check to pass (MIG + DEX, DL 10).", patch: () => ({ lock: { type: "check", attrA: "MIG", attrB: "DEX", dl: 10, stays: true } }), label: "Rubble" },
    ledge:    { name: "Ledge",             col: "#e8b84b", glyph: "➜", desc: "One-way. Swap the direction in the inspector.", patch: () => ({ oneWay: true }), label: "Ledge drop" },
    hidden:   { name: "Hidden path",       col: "#c08cff", glyph: "◉", desc: "Invisible until the party lands at either end, then it stays found.", patch: () => ({ hidden: { by: "adjacent" } }), label: "Hidden path" },
    bridge:   { name: "Rope bridge",       col: "#ffd766", glyph: "≋", desc: "Appears when an event fires. Then click the tile that drops it.", patch: () => ({ hidden: { by: "event" } }), label: "Rope bridge", trigger: "connect" },
    collapse: { name: "Collapsing bridge", col: "#e0a060", glyph: "⌇", desc: "Breaks after the party crosses it once.", patch: () => ({ collapse: true }), label: "Crumbling bridge" },
    lever:    { name: "Lever gate",        col: "#e8c070", glyph: "⟋", desc: "Closed until a lever tile is stepped on. Then click the lever tile.", patch: () => ({ lock: { type: "switch", name: `Lever ${1 + Object.values(links()).filter(l => l.lock?.lever).length}`, lever: true } }), label: "Lever gate", trigger: "setSwitch" },
    hazard:   { name: "Hazard",            col: "#ff9a4a", glyph: "!", desc: "Crossing applies an effect (5 damage by default; same setup as a Hazard tile).", patch: () => ({ hazard: { effectConfig: { ...HAZARD_DEFAULT } } }), label: "Narrow ledge" },
  };
  M.dropGimmick = async (linkId) => {
    const g = M.GIMMICKS[M.gim], l = links()[linkId]; if (!g || !l) return;
    await M.ops.patchLink(linkId, { ...g.patch(), label: l.label || g.label });
    M.selLink = linkId; M.selTile = null;
    if (g.trigger) { M.pendingTrigger = { linkId, action: g.trigger }; DP.LinkPlay?.hint?.(g.trigger === "connect" ? "Now click the tile that drops it." : "Now click the tile that triggers it (Esc to skip)."); }
    M.onChange();
  };
  async function finishTrigger(tileId) {
    const p = M.pendingTrigger; M.pendingTrigger = null; const l = links()[p.linkId]; if (!l) return;
    const ev = { id: newId(), when: { type: "land", arg: tileId }, cond: { type: "none", arg: "" }, then: [{ type: p.action, arg: p.action === "connect" ? p.linkId : l.lock?.name }] };
    await M.ops.setEvents([...events(), ev]);
    if (M.gim === "lever" && !sc().tiles.get(tileId).getFlag(MOD, `${ROOT}.makerName`)) await M.ops.renameTile(tileId, "Lever");
    DP.LinkPlay?.hint?.("Event added.");
  }

  // ── Map Check + registry ───────────────────────────────────────────────────
  const LOOT = new Set(["gold", "item", "consumable", "weapon", "armor", "accessory", "treasure", "gathering", "dirt", "fishing"]);
  M.mapCheck = () => {
    const s = sc(), L = links(), ids = s.tiles.contents.filter(t => tileStates()[t.id]).map(t => t.id);
    const start = M.startTile() ?? ids[0], out = [];
    if (!start) return out;
    const { unreachable, traps } = Core().mapCheck({ tileIds: ids, links: L, start });
    out.push(unreachable.length ? { sev: "err", title: `${unreachable.length} tile(s) can't be reached`, sub: "No route from the start, even with every lock open.", ids: unreachable } : { sev: "ok", title: "Every tile can be reached" });
    out.push(traps.length ? { sev: "err", title: `One-way trap: ${traps.length} tile(s)`, sub: "The party can get there but never back to the start.", ids: traps } : { sev: "ok", title: "No one-way traps" });
    const deg = (id) => Object.values(L).filter(l => !l.off && (l.a === id || l.b === id)).length;
    const dull = ids.filter(id => deg(id) === 1 && !LOOT.has(typeOf(id)) && !["door", "event", "story", "final_story", "camp"].includes(typeOf(id)));
    out.push(dull.length ? { sev: "warn", title: `${dull.length} dead end(s) with no loot`, sub: "Dead ends are where loot goes.", ids: dull } : { sev: "ok", title: "Every dead end has loot" });
    for (const r of M.registry()) if (r.kind === "switch" && r.used && !r.set) out.push({ sev: "warn", title: `Switch "${r.name}" is never turned on here`, sub: "Fine for a story switch set elsewhere; otherwise this way stays sealed." });
    return out;
  };
  M.registry = () => {
    const L = links(), E = events(), sw = new Map(), keys = new Map();
    for (const l of Object.values(L)) { if (l.lock?.type === "switch") sw.set(l.lock.name, { used: (sw.get(l.lock.name)?.used ?? 0) + 1, set: 0 });
      if (l.lock?.type === "key") keys.set(l.lock.item, (keys.get(l.lock.item) ?? 0) + 1); }
    for (const e of E) for (const a of e.then ?? []) if (a.type === "setSwitch") { const r = sw.get(a.arg) ?? { used: 0, set: 0 }; r.set++; sw.set(a.arg, r); }
    return [...[...sw].map(([name, r]) => ({ kind: "switch", name, ...r })), ...[...keys].map(([name, used]) => ({ kind: "key", name, used }))];
  };
  M.startTile = () => { const id = sc()?.getFlag(MOD, `${ROOT}.makerStart`); if (id && sc().tiles.get(id)) return id;
    return sc()?.tiles.contents.find(t => typeOf(t.id) === "door")?.id ?? null; };
  M.sessionMinutes = () => { let m = 0, story = 0; for (const t of sc().tiles.contents) { const ty = tileStates()[t.id]?.currentType; if (!ty) continue;
    if (ty === "blank") m += 0.7; else if (["event", "story", "final_story"].includes(ty)) story = 34; else if (ty !== "door") m += 9; } return Math.round(m + story); };
  M.tileName = tileName; M.linkName = linkName; M.palette = palette; M.typeOf = typeOf; M.label = label;

  // ── Canvas input (capture before Foundry / DP) ─────────────────────────────
  function worldAt(ev) { return DP.Graph.clientToWorld(ev.clientX, ev.clientY); }
  function hitTile(p) { for (const t of sc().tiles.contents) { if (t.hidden || !tileStates()[t.id]) continue;
      if (p.x >= t.x - 6 && p.x <= t.x + t.width + 6 && p.y >= t.y - 6 && p.y <= t.y + t.height + 6) return t.id; } return null; }
  function hitLink(p, tol = 10) {
    let best = null, bd = tol / (canvas.stage.scale.x || 1);
    for (const [id, l] of Object.entries(links())) { const pts = DP.LinkLayer.points(sc(), l); if (!pts) continue;
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)), d = Math.hypot(p.x - a.x - dx * k, p.y - a.y - dy * k);
        if (d < bd) { bd = d; best = id; } } }
    return best;
  }
  function hitVia(p) { const l = M.selLink && links()[M.selLink]; if (!l) return null; const s = canvas.stage.scale.x || 1;
    const pts = [center(l.a), ...(l.via ?? []).map(([x, y]) => ({ x, y })), center(l.b)];
    for (let i = 1; i < pts.length; i++) { const mid = i < pts.length - 1 ? pts[i] : null;
      if (mid && Math.hypot(p.x - mid.x, p.y - mid.y) < 10 / s) return { kind: "move", index: i - 1 };
      const a = pts[i - 1], b = pts[i], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(p.x - m.x, p.y - m.y) < 9 / s) return { kind: "insert", index: i - 1, at: m }; }
    return null; }

  let drag = null;
  const isCanvas = (ev) => ev.target === canvas?.app?.view;
  function onDown(ev) {
    if (!M.active || !isCanvas(ev) || ev.button !== 0) return;
    ev.stopPropagation(); ev.preventDefault();
    if (M.playtest) return playtestClick(ev);
    const p = worldAt(ev), t = hitTile(p);
    drag = { x: ev.clientX, y: ev.clientY, p, moved: false, tile: null, via: null, chain: null };
    if (M.tool === "select") { const v = hitVia(p); if (v) drag.via = v; else if (t) drag.tile = t; }
    if (M.tool === "path" && t) drag.chain = [{ id: t }];
  }
  function onMove(ev) {
    if (!M.active || !drag) return;
    ev.stopPropagation();
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 4) drag.moved = true;
    drag.cur = worldAt(ev);
    if (drag.chain && drag.moved) {
      const last = drag.chain[drag.chain.length - 1], lp = last.id ? center(last.id) : last, over = hitTile(drag.cur);
      if (over && over !== last.id && !drag.chain.some(c => c.id === over)) drag.chain.push({ id: over });
      else if (!over && Math.hypot(drag.cur.x - lp.x, drag.cur.y - lp.y) > Math.max(62, (lp.w ?? 27) * 2.3)) drag.chain.push({ x: drag.cur.x, y: drag.cur.y });
    }
    drawOverlay();
  }
  async function onUp(ev) {
    if (!M.active || !drag) return;
    ev.stopPropagation(); const d = drag; drag = null; const p = worldAt(ev);
    if (d.moved) {
      if (d.tile) await M.ops.moveTile(d.tile, p.x, p.y);
      else if (d.via) { const l = links()[M.selLink], via = foundry.utils.deepClone(l.via ?? []);
        if (d.via.kind === "move") via[d.via.index] = [Math.round(p.x), Math.round(p.y)]; else via.splice(d.via.index, 0, [Math.round(p.x), Math.round(p.y)]);
        await M.ops.patchLink(M.selLink, { via }); }
      else if (d.chain && d.chain.length > 1) await M.ops.drawChain(d.chain);
      drawOverlay(); return;
    }
    const t = hitTile(p), l = t ? null : hitLink(p);
    if (M.pendingTrigger) { if (t) await finishTrigger(t); M.onChange(); return; }
    switch (M.tool) {
      case "select":  M.selTile = t; M.selLink = l; break;
      case "tile":    if (t) { M.selTile = t; M.selLink = null; } else await M.ops.placeTile(p.x, p.y); break;
      case "path":    if (t) { if (M.linkFrom && M.linkFrom !== t) { await M.ops.addLink(M.linkFrom, t); M.linkFrom = null; } else M.linkFrom = M.linkFrom === t ? null : t; } else M.linkFrom = null; break;
      case "gimmick": if (l) await M.dropGimmick(l); else DP.LinkPlay?.hint?.("Drop a gimmick on a path."); break;
      case "fog":     if (t) { await M.ops.setFog(t, M.fogPart); M.selTile = t; } break;
      case "erase":   if (t) await M.ops.eraseTile(t); else if (l) await M.ops.eraseLink(l); break;
    }
    M.onChange();
  }
  function onKey(ev) {
    if (!M.active || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (ev.key === "Escape") { M.linkFrom = null; if (M.pendingTrigger) { M.pendingTrigger = null; DP.LinkPlay?.hint?.("Left for a story event: turn the switch on from any event."); } ev.stopPropagation(); M.onChange(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); ev.stopPropagation(); ev.shiftKey ? M.redoStep() : M.undoStep(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") { ev.preventDefault(); ev.stopPropagation(); M.redoStep(); }
    if (ev.key === "Delete" && !M.playtest) { ev.stopPropagation(); if (M.selTile) M.ops.eraseTile(M.selTile); else if (M.selLink) M.ops.eraseLink(M.selLink); }
  }

  // ── Editor overlay (selection, handles, wires, path preview) ───────────────
  let _ov = null;
  function overlay() { if (_ov && !_ov.destroyed && _ov.parent) return _ov; _ov = new PIXI.Graphics(); _ov.name = "oniMakerOverlay"; _ov.zIndex = 999995; canvas.stage.sortableChildren = true; canvas.stage.addChild(_ov); return _ov; }
  function drawOverlay() {
    if (!M.active || !canvas?.ready) return; const g = overlay(); g.clear(); const s = canvas.stage.scale.x || 1;
    const ring = (id, col) => { const c = center(id); if (!c) return; g.lineStyle({ width: 3 / s, color: col, alpha: 0.95 }); g.drawCircle(c.x, c.y, c.w * 0.75); };
    if (M.selTile) ring(M.selTile, 0x7fe0ff);
    if (M.linkFrom) ring(M.linkFrom, 0x7fe0ff);
    const L = links();
    if (M.selLink && L[M.selLink]) { const l = L[M.selLink], pts = [center(l.a), ...(l.via ?? []).map(([x, y]) => ({ x, y })), center(l.b)];
      g.lineStyle({ width: 10 / s, color: 0xe8b84b, alpha: 0.35 }); g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
      g.lineStyle({ width: 1.5 / s, color: 0x1a1206 });
      for (let i = 1; i < pts.length - 1; i++) { g.beginFill(0xe8b84b); g.drawRect(pts[i].x - 5 / s, pts[i].y - 5 / s, 10 / s, 10 / s); g.endFill(); }
      for (let i = 1; i < pts.length; i++) { const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 }; g.beginFill(0xfffaf1, 0.9); g.drawCircle(m.x, m.y, 4 / s); g.endFill(); } }
    // event wires: trigger tile → what it changes (editor only)
    for (const e of DP.Links.events(sc())) { if (e.when?.type !== "land") continue; const A = center(e.when.arg); if (!A) continue;
      for (const a of e.then ?? []) { let B = null;
        if (["connect", "open", "break"].includes(a.type) && L[a.arg]) { const pts = DP.LinkLayer.points(sc(), L[a.arg]); B = pts?.[Math.floor(pts.length / 2)] ?? null; if (pts && pts.length === 2) B = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; }
        if (a.type === "setSwitch") { const l = Object.values(L).find(x => x.lock?.type === "switch" && x.lock.name === a.arg); if (l) { const c1 = center(l.a), c2 = center(l.b); B = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 }; } }
        if (a.type === "reveal") B = center(a.arg);
        if (!B) continue;
        g.lineStyle({ width: 2 / s, color: 0x7fe0ff, alpha: 0.9 }); const mx = (A.x + B.x) / 2, my = Math.min(A.y, B.y) - 40;
        const N = 24; let px = A.x, py = A.y; for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t, x = u * u * A.x + 2 * u * t * mx + t * t * B.x, y = u * u * A.y + 2 * u * t * my + t * t * B.y; if (i % 2) { g.moveTo(px, py); g.lineTo(x, y); } px = x; py = y; }
        g.beginFill(0x7fe0ff); g.drawCircle(A.x, A.y, 4 / s); g.drawCircle(B.x, B.y, 4 / s); g.endFill(); } }
    if (drag?.chain) { g.lineStyle({ width: 2.5 / s, color: 0x7fe0ff, alpha: 0.9 }); const pts = drag.chain.map(c => c.id ? center(c.id) : c); if (drag.cur) pts.push(drag.cur);
      g.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) g.lineTo(q.x, q.y); for (const c of drag.chain) if (!c.id) { g.beginFill(0x7fe0ff, 0.5); g.drawCircle(c.x, c.y, 10); g.endFill(); } }
    if (drag?.tile && drag.moved && drag.cur) { const c = center(drag.tile); g.lineStyle({ width: 2 / s, color: 0x7fe0ff }); g.drawCircle(drag.cur.x, drag.cur.y, c.w / 2); }
  }
  M.drawOverlay = drawOverlay;

  // ── Playtest: practice run, GM screen only, nothing written ────────────────
  function ghostSprite() {
    const tok = sc().tokens.contents.find(t => /party/i.test(t.name)) ?? null;
    const src = tok?.texture?.src ?? game.actors.find(a => /party/i.test(a.name))?.prototypeToken?.texture?.src;
    const spr = PIXI.Sprite.from(src ?? "icons/svg/mystery-man.svg"); spr.anchor.set(0.5, 1); spr.zIndex = 999994; spr.alpha = 0.95;
    const h = (canvas.grid.size || 60) * 1.15; spr.height = h; spr.scale.x = spr.scale.y; canvas.stage.addChild(spr); return spr;
  }
  M.startPlaytest = (fromId) => {
    const start = fromId ?? M.selTile ?? M.startTile(); if (!start) return DP.LinkPlay?.hint?.("Pick a tile or set a start first.");
    const st = { revealed: {}, unlocked: {}, broken: {}, events: {} }, sw = {};
    M.playtest = { at: start, state: st, switches: sw, ghost: ghostSprite(), trail: [start] };
    placeGhost(start); DP.LinkLayer.setOverride({ state: st, switches: sw }); revealAround(start, false);
    DP.LinkPlay?.hint?.(`Playtest from ${tileName(start)}. Practice only: nothing is saved, no battles or loot.`); M.onChange();
  };
  M.stopPlaytest = () => { const p = M.playtest; if (!p) return; if (p.ghost && !p.ghost.destroyed) { p.ghost.parent?.removeChild(p.ghost); p.ghost.destroy(); }
    M.lastTrail = p.trail; M.playtest = null; DP.LinkLayer.setOverride(null); M.onChange(); };
  function placeGhost(id) { const c = center(id), g = M.playtest?.ghost; if (c && g) g.position.set(c.x, c.y + c.h * 0.2); }
  async function glide(from, to) { const g = M.playtest.ghost, a = center(from), b = center(to), t0 = performance.now(), dur = 420;
    await new Promise(res => { const step = () => { const k = Math.min(1, (performance.now() - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      g.position.set(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e + a.h * 0.2); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); }); }
  function refresh() { DP.LinkLayer.setOverride({ state: M.playtest.state, switches: M.playtest.switches }); }
  function revealAround(id, animate = true) { const p = M.playtest; for (const lid of Core().toRevealOnLanding(links(), id, p.state)) p.state.revealed[lid] = true; if (animate) refresh(); }
  async function playtestClick(ev) {
    const p = M.playtest; if (!p || p.moving) return;
    const to = hitTile(worldAt(ev)); if (!to || to === p.at) return;
    const ctx = { state: p.state, switchOn: (n) => (n in p.switches) ? p.switches[n] : DP.Links.switchOn(n) };
    const hit = Core().linkBetween(links(), p.at, to, p.state); if (!hit) return;
    const r = Core().stepRule(hit.id, hit.link, p.at, ctx), l = hit.link, ghostTok = { center: center(p.at), mesh: p.ghost, renderFlags: null };
    if (!r.ok) {
      if (r.reason === "oneway" || r.reason === "switch") { DP.LinkPlay.hint(r.reason === "oneway" ? "One-way: you can't go this direction." : "Sealed. Something has to open this way first."); return; }
      if (r.reason === "key") { const pick = await DP.LinkPlay.prompt({ document: null }, `${l.label || "Locked"} · ${l.lock.item}`, [{ label: "🗝  Use Key", cls: "oni-dp-btn-key", value: "y" }, { label: "⟲  Go Back", cls: "oni-dp-btn-revert", value: "n" }].map(b => b), ghostAnchor());
        if (pick !== "y") return; p.state.unlocked[hit.id] = true; refresh(); await wait(900); }
      else if (r.reason === "check") { const pick = await DP.LinkPlay.prompt({ document: null }, `${l.label || "Obstacle"} · ${l.lock.attrA} + ${l.lock.attrB} · DL ${l.lock.dl} (practice: pick the result)`,
          [{ label: "✔  Passes", cls: "oni-dp-btn-confirm", value: "pass" }, { label: "✖  Fails", cls: "oni-dp-btn-revert", value: "fail" }], ghostAnchor());
        if (pick !== "pass") { DP.LinkPlay.hint("The check fails. Try again or go another way."); return; } p.state.unlocked[hit.id] = true; refresh(); await wait(900); }
    }
    p.moving = true;
    try {
      await glide(p.at, to); const from = p.at; p.at = to; p.trail.push(to);
      if (l.hazard) DP.LinkPlay.hint(`${l.label || "Hazard"}: the effect would apply here (practice: not applied).`);
      if (l.collapse) { p.state.broken[hit.id] = true; refresh(); }
      revealAround(to);
      for (const e of Core().eventsFor(DP.Links.events(sc()), "land", to, p.state)) { p.state.events[e.id] = true;
        for (const a of e.then ?? []) { if (a.type === "connect") p.state.revealed[a.arg] = true; if (a.type === "break") p.state.broken[a.arg] = true;
          if (a.type === "open") { p.state.unlocked[a.arg] = true; const ll = links()[a.arg]; if (ll?.lock?.type === "switch") p.switches[ll.lock.name] = true; }
          if (a.type === "setSwitch") p.switches[a.arg] = true; } }
      refresh();
      const ty = typeOf(to); if (!["blank", "door"].includes(ty)) setTimeout(() => DP.LinkPlay.hint(`${label(ty)} would trigger here.`), 500);
    } finally { p.moving = false; }
  }
  function ghostAnchor() { const g = M.playtest?.ghost; if (!g) return null; return { x: g.x + 20, y: g.y - (g.height || 60) / 2 }; }

  // ── Open / close ───────────────────────────────────────────────────────────
  M.open = () => {
    if (M.active || !game.user?.isGM || !canvas?.ready) return;
    M.active = true; M.undo = []; M.redo = [];
    window.addEventListener("pointerdown", onDown, true); window.addEventListener("pointermove", onMove, true); window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    DP.Overlay?.clearHover?.(); DP.Tooltip?.hide?.(); drawOverlay(); M.onChange();
  };
  M.close = () => {
    if (!M.active) return; if (M.playtest) M.stopPlaytest();
    M.active = false; M.selTile = M.selLink = M.linkFrom = M.pendingTrigger = null;
    window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("pointermove", onMove, true); window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    if (_ov && !_ov.destroyed) { _ov.parent?.removeChild(_ov); _ov.destroy(); } _ov = null; M.onChange();
  };
  Hooks.on("canvasTearDown", () => { if (M.active) M.close(); });
  Hooks.on("updateScene", (s) => { if (M.active && s.id === sc()?.id) drawOverlay(); });
  for (const h of ["createTile", "updateTile", "deleteTile"]) Hooks.on(h, () => { if (M.active) drawOverlay(); });
  Hooks.on("canvasPan", () => { if (M.active) drawOverlay(); });
})();
