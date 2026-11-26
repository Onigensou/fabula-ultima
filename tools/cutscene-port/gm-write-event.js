// Cutscene port · GM script template (port-cutscene.mjs fills __EVENT__ / __STAGE_TOKENS__ and writes <id>.gm.js).
// Runs as GM inside Foundry: run-gm.mjs evaluates it over CDP, or paste it into a GM script macro.
// Writes ONE event tile (tagged flags["fabula-ultima-companion"].cutscenePort = <id>; re-running replaces its rows),
// converts image coordinates to canvas coordinates, optionally places the staging tokens, and runs the event lint.
(async () => {
  const EV = __EVENT__;
  const STAGE_TOKENS = __STAGE_TOKENS__;
  const SCOPE = "oni-event-system", MOD = "fabula-ultima-companion", MARKER_ACTOR = "TnOKgQbmyxFzD6Oe";
  const report = { ok: false, id: EV.id, draft: EV.draft, dropped: EV.dropped, notes: [] };
  const scene = (EV.sceneId && game.scenes.get(EV.sceneId)) || game.scenes.getName(EV.sceneName);
  if (!scene) return { ...report, error: `scene not found: ${EV.sceneId || ""} ${EV.sceneName || ""}` };
  const d = scene.dimensions, px = d.sceneX, py = d.sceneY;
  report.scene = { id: scene.id, name: scene.name, padding: [px, py], size: [d.sceneWidth, d.sceneHeight] };

  // every row type must be registered in this build of the game
  const Reg = window.oni?.EventSystem?.EventRegistry;
  const types = new Set(); (function walk(rows) { for (const r of rows || []) { types.add(r.type); for (const k of ["rows", "thenRows", "elseRows", "victoryRows", "defeatRows", "successRows", "failureRows", "critRows", "fumbleRows", "yesRows", "noRows"]) if (Array.isArray(r[k])) walk(r[k]); for (const o of [...(r.options || []), ...(r.choices || [])]) walk(o.rows); } })(EV.flags.eventRows);
  const missingTypes = [...types].filter((t) => Reg && !Reg.has(t));
  if (missingTypes.length) return { ...report, error: "row types this build doesn't register: " + missingTypes.join(", ") };

  // image px → canvas px where the game wants canvas coordinates
  const XY = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
  const shiftPath = (path, sep, join) => String(path || "").split(sep).map((seg) => { const s = seg.trim(), m = s.match(XY); return m ? `${Math.round(+m[1] + px)}, ${Math.round(+m[2] + py)}` : s; }).filter(Boolean).join(join);
  const shift = (rows) => (rows || []).map((r0) => {
    const r = { ...r0 };
    if (r.type === "moveToken") r.path = shiftPath(r.path, /[;\n]/, "; ");
    if (r.type === "jumpTo") r.path = shiftPath(r.path, /\n/, "\n");
    if (r.type === "setTokenPosition" && r.mode === "point") { r.x = Math.round(+r.x + px); r.y = Math.round(+r.y + py); }
    for (const k of ["rows", "thenRows", "elseRows", "victoryRows", "defeatRows", "successRows", "failureRows", "critRows", "fumbleRows", "yesRows", "noRows"]) if (Array.isArray(r[k])) r[k] = shift(r[k]);
    if (Array.isArray(r.options)) r.options = r.options.map((o) => ({ ...o, rows: shift(o.rows) }));
    if (Array.isArray(r.choices)) r.choices = r.choices.map((o) => ({ ...o, rows: shift(o.rows) }));
    return r;
  });
  const rows = shift(EV.flags.eventRows);

  // staging tokens (sandbox): place the ones the cutscene expects and the scene lacks
  const made = [];
  if (STAGE_TOKENS) {
    const marker = game.actors.get(MARKER_ACTOR);
    for (const t of EV.tokens || []) {
      if (scene.tokens.find((k) => k.name === t.name)) continue;
      const actor = t.marker ? marker : (game.actors.getName(t.actor || t.name) || game.actors.find((a) => a.name.includes(t.actor || t.name)));
      if (!actor) { report.notes.push(`no actor for token "${t.name}" (${t.actor || "marker"})`); continue; }
      const td = (await actor.getTokenDocument({ hidden: !!t.hidden })).toObject(); delete td._id;
      td.name = t.name; td.hidden = !!t.hidden; td.lockRotation = true;
      if (t.marker) { td.width = 1; td.height = 1; td.disposition = 0; td.displayName = 0; td.displayBars = 0; td.actorLink = false; td.texture = { ...td.texture, src: "icons/svg/target.svg" }; }
      const gw = (td.width || 1) * d.size, gh = (td.height || 1) * d.size;
      td.x = Math.round(px + t.x - gw / 2); td.y = Math.round(py + t.y - gh / 2);
      td.flags = { ...td.flags, [MOD]: { ...(td.flags?.[MOD] ?? {}), cutscenePort: EV.id, ...(t.marker ? { depthExempt: true } : {}) } };
      const [doc] = await scene.createEmbeddedDocuments("Token", [td]);
      if (doc.name !== t.name) await doc.update({ name: t.name });   // Token Mold renames new tokens
      made.push(t.name);
    }
  }
  report.tokensMade = made;

  // the event tile: replace this port's tile if it exists, else create it
  const flags = { ...EV.flags, eventRows: rows, eventRowsJsonPreview: JSON.stringify(rows, null, 2) };
  const tile = { x: Math.round(px + EV.tile.x - EV.tile.w / 2), y: Math.round(py + EV.tile.y - EV.tile.h / 2), width: EV.tile.w, height: EV.tile.h, alpha: 0, hidden: false,
    flags: { [MOD]: { cutscenePort: EV.id, cutscenePortAt: new Date().toISOString(), cutscenePortDraft: !!EV.draft }, [SCOPE]: flags } };
  let doc = scene.tiles.find((t) => t.flags?.[MOD]?.cutscenePort === EV.id);
  // (an update replaces arrays whole, so the old rows don't survive under the new ones)
  if (doc) { await doc.update({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, [`flags.${MOD}`]: tile.flags[MOD], [`flags.${SCOPE}`]: flags }); report.tile = { id: doc.id, action: "updated" }; }
  else { [doc] = await scene.createEmbeddedDocuments("Tile", [{ ...tile, texture: { src: null } }]); report.tile = { id: doc.id, action: "created" }; }

  // read it back: the stored rows must equal what was sent
  const back = scene.tiles.get(doc.id)?.flags?.[SCOPE]?.eventRows;
  report.readBack = JSON.stringify(back) === JSON.stringify(rows) ? "identical" : "DIFFERENT";

  // names the rows point at that this scene doesn't have
  const names = new Set();
  (function walk(rs) { for (const r of rs || []) {
    if (r.type === "cameraPan" && (r.mode === "token" || r.mode === "twoShot") && r.name) names.add(r.name);
    if (["moveToken", "showEmote", "setFacing", "setTokenPosition"].includes(r.type) && r.target === "token" && r.name) String(r.name).split(",").forEach((n) => names.add(n.trim()));
    if (r.type === "setToken" && r.name) String(r.name).split(",").forEach((n) => names.add(n.trim()));
    if (r.type === "playAnimation" && r.where === "token" && r.name) names.add(r.name);
    for (const k of ["rows", "thenRows", "elseRows", "victoryRows", "defeatRows"]) if (Array.isArray(r[k])) walk(r[k]);
    for (const o of [...(r.options || []), ...(r.choices || [])]) walk(o.rows); } })(rows);
  report.missingTokens = [...names].filter((n) => !scene.tokens.find((t) => t.name === n || t.actor?.name === n));

  // the game's own event lint, this tile only
  try {
    const lint = await (window.FUCompanion?.api?.lint?.runEventLint?.({ sceneId: scene.id }));
    report.lint = (lint?.issues || []).filter((i) => String(i.where || "").includes(doc.id) || String(i.where || "").includes(EV.id)).map((i) => `${i.level}: ${i.message}`);
    report.lintAll = lint?.summary;
  } catch (e) { report.lint = ["lint failed: " + (e?.message || e)]; }
  report.rows = rows.length; report.ok = report.readBack === "identical";
  return report;
})()
