// ============================================================================
// Dungeon Maker — UI (GM only). Logic: dp-maker.js.
//
// A 🛠️ button on dungeon maps opens the maker: Foundry's own UI fades out and
// the cream editor slides in (Super Mario Maker 2 layout, game-comfy theme):
//   top    parts bar (recent parts, category stripe) + 🔍 all parts
//   left   map card (settings), session clock (→ Map Check), start flag, events
//   right  library · eraser · undo · redo · reset · zoom
//   panel  in-hand help, inspector (tile / path), events editor, switches & keys
//   bottom ▶ Play (practice run) ↔ ✎ Make
// ============================================================================
(() => {
  const DP = globalThis.DungeonPathing ??= {};
  const MOD = "fabula-ultima-companion", ROOT = "dungeonPathing";
  const M = () => DP.Maker;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const opt = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  const CAT = { Tiles: "#5bc85b", Paths: "#4aa8ff", Gimmicks: "#ff9a3c", Fog: "#b58cff" };
  const ui = { root: null, btn: null, modal: null, recent: ["path", "tile:blank", "tile:random_battle", "tile:item", "tile:skill_check", "gim:gate", "gim:ward", "gim:bridge", "gim:ledge", "gim:hidden"], part: null };

  const CSS = `
.oni-maker-on #ui-left, .oni-maker-on #ui-top, .oni-maker-on #ui-right, .oni-maker-on #hotbar, .oni-maker-on #players, .oni-maker-on #oni-dp-tip,
.oni-maker-on .oni-dp-mode-btn, .oni-maker-on #oni-dp-status-hud, .oni-maker-on #oni-clock-gm-root, .oni-maker-on #oni-combatbtn-root,
.oni-maker-on #notifications { opacity: 0 !important; pointer-events: none !important; transition: opacity .25s ease; }
#oni-maker { position: fixed; inset: 0; z-index: 100000; pointer-events: none; font-family: Signika, sans-serif; --cream: #fffaf1; --cream2: #f6ecda; --line: #ead9bb; --ink: #5a3d22; --ink2: #8a6a48; --hi: #ffcf5a; }
#oni-maker button { width: auto; height: auto; line-height: normal; margin: 0; flex: none; min-width: 0; }
#oni-maker > * { pointer-events: auto; transition: transform .45s cubic-bezier(.2,.8,.2,1), opacity .35s ease; }
#oni-maker.off .mk-top { transform: translateY(-110%); } #oni-maker.off .mk-left { transform: translateX(-115%); }
#oni-maker.off .mk-right, #oni-maker.off .mk-panel { transform: translateX(115%); } #oni-maker.off .mk-play { transform: translateY(160%); }
#oni-maker.off .mk-select, #oni-maker.off .mk-modal { opacity: 0; }
#oni-maker .mk-left, #oni-maker .mk-right { transition-delay: .06s; } #oni-maker .mk-play, #oni-maker .mk-panel { transition-delay: .1s; }
#oni-maker .mk-top { position: absolute; left: 0; right: 340px; top: 0; height: 80px; display: flex; align-items: center; gap: 7px; padding: 0 12px; overflow-x: auto; scrollbar-width: none;
  background: radial-gradient(circle at 1px 1px, rgba(214,190,150,.35) 1px, transparent 1.5px) 0 0 / 14px 14px, var(--cream); border-bottom: 3px solid var(--line); box-shadow: 0 4px 14px rgba(70,45,15,.18); }
#oni-maker .mk-top::-webkit-scrollbar { display: none; }
#oni-maker .mk-exit { flex: 0 0 auto; height: 44px; padding: 0 14px; border-radius: 999px; border: 0; background: var(--cream2); color: var(--ink); font: 700 14px Signika, sans-serif; cursor: pointer; box-shadow: 0 3px 0 var(--line); }
#oni-maker .mk-card { flex: 0 0 auto; width: 54px; height: 54px; background: #fff; border: 0; border-top: 6px solid var(--c); border-radius: 14px; box-shadow: 0 3px 0 var(--line); display: grid; place-items: center; cursor: pointer; padding: 0; }
#oni-maker .mk-card:hover { transform: translateY(-2px); } .mk-card.on { outline: 3px solid var(--hi); outline-offset: 2px; }
#oni-maker .mk-card img { width: 34px; height: 34px; object-fit: contain; }
#oni-maker .mk-card.big { width: 90px; height: 84px; align-content: center; gap: 2px; } .mk-card.big small { font: 600 11px Signika, sans-serif; color: var(--ink); line-height: 1.1; text-align: center; padding: 0 3px; }
#oni-maker .mk-tok { width: 32px; height: 32px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #f6dc7a, #c8960c 60%, #6e4f06); display: grid; place-items: center; }
#oni-maker .mk-tok b { width: 24px; height: 24px; border-radius: 50%; background: #2a2016; color: var(--c); display: grid; place-items: center; font: 700 14px Signika, sans-serif; }
#oni-maker .mk-fog { width: 36px; height: 22px; border-radius: 50%; border: 2.5px solid var(--c); display: grid; place-items: center; color: var(--c); font: 800 15px Signika, sans-serif; }
#oni-maker .mk-search { margin-left: auto; position: sticky; right: 0; flex: 0 0 auto; width: 54px; height: 54px; border-radius: 50%; border: 0; background: #fff; box-shadow: 0 3px 0 var(--line); font-size: 22px; cursor: pointer; }
#oni-maker .mk-left { position: absolute; left: 0; top: 83px; bottom: 0; width: 100px; display: flex; flex-direction: column; gap: 9px; padding: 9px; background: rgba(255,250,241,.94); border-right: 3px solid var(--line); overflow-y: auto; }
#oni-maker .mk-lc { background: #fff; border: 0; border-radius: 14px; box-shadow: 0 3px 0 var(--line); padding: 7px 5px; color: var(--ink); font: 700 12px Signika, sans-serif; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; text-align: center; }
#oni-maker .mk-lc img { width: 100%; border-radius: 9px; } .mk-lc b { font-size: 16px; } .mk-lc span { font-weight: 600; font-size: 11px; color: var(--ink2); line-height: 1.15; word-break: break-word; }
#oni-maker .mk-right { position: absolute; right: 340px; top: 83px; width: 76px; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 9px 0; }
#oni-maker .mk-rb { width: 54px; height: 54px; border-radius: 50%; border: 0; background: var(--cream); color: var(--ink); box-shadow: 0 3px 0 var(--line), 0 6px 14px rgba(0,0,0,.22); font: 700 21px Signika, sans-serif; cursor: pointer; }
#oni-maker .mk-rb.on { background: var(--hi); } .mk-rb[disabled] { opacity: .5; cursor: default; }
#oni-maker .mk-zoom button { display: block; width: 46px; height: 30px; margin-top: 5px; border-radius: 10px; border: 0; background: var(--cream); color: var(--ink); font: 700 14px Signika, sans-serif; cursor: pointer; box-shadow: 0 3px 0 var(--line); }
#oni-maker .mk-select { position: absolute; top: 94px; right: 430px; background: var(--cream); color: var(--ink); border: 0; box-shadow: 0 3px 0 var(--line), 0 6px 14px rgba(0,0,0,.2); border-radius: 999px; padding: 7px 16px; font: 700 14px Signika, sans-serif; cursor: pointer; }
#oni-maker .mk-select.on { background: var(--hi); }
#oni-maker .mk-play { position: absolute; left: 112px; bottom: 12px; width: 116px; height: 78px; border: 0; border-radius: 14px; color: #fff; font: 700 21px Signika, sans-serif; cursor: pointer; overflow: hidden; padding-top: 15px;
  background: linear-gradient(180deg, #79cf86, #55b366); box-shadow: 0 4px 0 #3f8f4e, 0 8px 16px rgba(0,0,0,.25); }
#oni-maker .mk-play::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 14px; background: repeating-linear-gradient(-55deg, #fffaf1 0 9px, #5a3d22 9px 18px); }
#oni-maker .mk-play.make { background: linear-gradient(180deg, #fffaf1, #f1e3c8); color: var(--ink); box-shadow: 0 4px 0 var(--line), 0 8px 16px rgba(0,0,0,.25); }
#oni-maker .mk-panel { position: absolute; right: 0; top: 0; bottom: 0; width: 340px; background: #fbf4e6; border-left: 3px solid var(--line); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; color: var(--ink); }
#oni-maker .mk-c { background: #fffaf1; border: 1px solid var(--line); border-radius: 16px; padding: 12px; }
#oni-maker .mk-c h3 { margin: 0 0 8px; font: 700 12px Signika, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #b07a2a; border: 0; }
#oni-maker .mk-c p, #oni-maker .mk-note { color: var(--ink2); font-size: 13px; margin: 0 0 6px; }
#oni-maker .mk-c label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--ink2); margin-bottom: 7px; }
#oni-maker .mk-c input[type=text], #oni-maker .mk-c input[type=number], #oni-maker .mk-c select, #oni-maker .mk-c textarea { background: #fff; color: var(--ink); border: 2px solid var(--line); border-radius: 10px; padding: 5px 7px; font: 13px Signika, sans-serif; width: 100%; height: auto; }
#oni-maker .mk-c .chk { flex-direction: row; align-items: center; gap: 7px; color: var(--ink); font-size: 13px; } .mk-c .chk input { width: auto; }
#oni-maker .mk-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
#oni-maker .mk-btn { font: 700 13px Signika, sans-serif; color: var(--ink); background: #fff; border: 0; border-radius: 10px; padding: 6px 11px; cursor: pointer; box-shadow: 0 2px 0 var(--line); width: auto; line-height: 1.3; }
#oni-maker .mk-btn.danger { color: #c0503b; } .mk-btn.on { background: var(--hi); }
#oni-maker .mk-sub { padding: 8px; border: 1px dashed var(--line); border-radius: 10px; margin-bottom: 7px; }
#oni-maker .mk-ev { background: #fbf3e4; border: 1px solid var(--line); border-radius: 10px; padding: 7px; margin-bottom: 7px; display: flex; flex-direction: column; gap: 5px; }
#oni-maker .mk-evl { display: grid; grid-template-columns: 34px 1fr 1.2fr auto; gap: 4px; align-items: center; font-size: 12px; } .mk-evl b { color: #b07a2a; } .mk-evl select { padding: 3px 4px; font-size: 12px; }
#oni-maker .mk-evl .x { border: 0; background: none; color: #c0503b; font-size: 15px; cursor: pointer; width: auto; }
#oni-maker .mk-stat { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid #f0e3cb; font-size: 13px; } .mk-stat small { display: block; color: var(--ink2); font-size: 11.5px; }
#oni-maker .mk-chip { font: 700 11px Signika, sans-serif; padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; align-self: center; }
#oni-maker .mk-modal { position: absolute; left: 120px; right: 440px; top: 96px; bottom: 110px; color: var(--ink); border-radius: 20px; padding: 18px 20px; overflow: auto; background: var(--cream); box-shadow: 0 14px 34px rgba(0,0,0,.35); }
#oni-maker .mk-modal h3 { margin: 0 0 6px; font: 700 19px Signika, sans-serif; border: 0; } .mk-modal h4 { margin: 14px 0 7px; font: 700 13px Signika, sans-serif; border-left: 5px solid var(--c, var(--line)); padding-left: 7px; border-bottom: 0; }
#oni-maker .mk-grid { display: flex; flex-wrap: wrap; gap: 9px; }
#oni-maker .mk-x { position: absolute; top: 12px; right: 14px; width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--cream2); color: var(--ink); font: 700 15px Signika, sans-serif; cursor: pointer; }
#oni-maker .mk-kv { display: grid; grid-template-columns: max-content 1fr; gap: 7px 16px; font-size: 14px; } .mk-kv span { color: var(--ink2); }
#oni-maker .mk-check { display: grid; grid-template-columns: auto 1fr; gap: 3px 9px; background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; text-align: left; width: 100%; color: var(--ink); font: 13px Signika, sans-serif; }
#oni-maker .mk-check small { grid-column: 2; color: var(--ink2); }
#oni-dp-devbtn { position: fixed; z-index: 99979; left: 20px; bottom: 160px; width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; font-size: 22px;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.92) 0%, rgba(45,32,14,0.96) 100%); box-shadow: 0 0 14px rgba(0,0,0,0.55); color: #e8c870; }
#oni-dp-devbtn:hover { filter: brightness(1.15); }
@media (prefers-reduced-motion: reduce) { #oni-maker > * { transition: none !important; } }`;

  function ensureCss() { if (document.getElementById("oni-maker-css")) return; const s = document.createElement("style"); s.id = "oni-maker-css"; s.textContent = CSS; document.head.appendChild(s); }

  // ── Parts ──────────────────────────────────────────────────────────────────
  function parts() {
    const P = [];
    for (const t of M().palette()) P.push({ k: `tile:${t.type}`, cat: "Tiles", name: t.label, img: t.img });
    P.push({ k: "path", cat: "Paths", name: "Path (drag to draw)" });
    for (const [k, g] of Object.entries(M().GIMMICKS)) P.push({ k: `gim:${k}`, cat: "Gimmicks", name: g.name, col: g.col, glyph: g.glyph });
    for (const [v, n, c] of [["fog", "Fog", "#9fb6c4"], ["shroud", "Shroud", "#d9b800"], ["invisible", "Invisible", "#b58cff"], ["", "Clear fog", "#9aa"]]) P.push({ k: `fog:${v}`, cat: "Fog", name: n, col: c });
    return P;
  }
  function icon(p) {
    if (p.img) return `<img src="${esc(p.img)}" alt="">`;
    if (p.k === "path") return `<svg viewBox="0 0 40 40" width="34" height="34"><circle cx="8" cy="30" r="5" fill="#c9a77a"/><circle cx="32" cy="10" r="5" fill="#c9a77a"/><path d="M8 30 Q 14 12 32 10" stroke="#3b3326" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M8 30 Q 14 12 32 10" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`;
    if (p.k.startsWith("gim:")) return `<span class="mk-tok" style="--c:${p.col}"><b>${esc(p.glyph)}</b></span>`;
    return `<span class="mk-fog" style="--c:${p.col}">${p.k === "fog:invisible" ? "◌" : p.k === "fog:" ? "✕" : "?"}</span>`;
  }
  function pick(k) {
    const m = M(), [kind, v] = k.split(":");
    if (kind === "tile") { m.tool = "tile"; m.palType = v; } else if (kind === "path") m.tool = "path"; else if (kind === "gim") { m.tool = "gimmick"; m.gim = v; } else if (kind === "fog") { m.tool = "fog"; m.fogPart = v; }
    ui.part = k; ui.recent = [k, ...ui.recent.filter(x => x !== k)].slice(0, 10); m.linkFrom = null; m.pendingTrigger = null; ui.modal = null; render();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const m = M(); if (!m) return;
    devButton();
    if (!m.active) { if (ui.root) closeChrome(); return; }
    ensureCss(); document.body.classList.add("oni-maker-on");
    if (!ui.root) { ui.root = document.createElement("div"); ui.root.id = "oni-maker"; ui.root.className = "off"; document.body.appendChild(ui.root); requestAnimationFrame(() => requestAnimationFrame(() => ui.root?.classList.remove("off"))); }
    const P = parts(), byK = new Map(P.map(p => [p.k, p])), cur = ["select", "erase"].includes(m.tool) ? null : ui.part;
    if (m.playtest) { ui.root.innerHTML = `<button class="mk-play make" data-a="make">✎ Make</button>`; bind(); return; }
    const sceneName = canvas.scene?.navName || canvas.scene?.name || "";
    ui.root.innerHTML = `
      <div class="mk-top"><button class="mk-exit" data-a="done">✕ Done</button>
        ${ui.recent.map(k => byK.get(k)).filter(Boolean).map(p => `<button class="mk-card ${cur === p.k ? "on" : ""}" style="--c:${CAT[p.cat]}" data-part="${esc(p.k)}" title="${esc(p.name)}">${icon(p)}</button>`).join("")}
        <button class="mk-search" data-a="parts" title="All parts">🔍</button></div>
      <div class="mk-left">
        <button class="mk-lc" data-a="map"><img src="${esc(canvas.scene?.background?.src ?? "")}" alt=""><span>${esc(sceneName)}</span></button>
        <button class="mk-lc" data-a="check" title="Map Check"><b>⏱ ${Math.floor(m.sessionMinutes() / 60)}h ${String(m.sessionMinutes() % 60).padStart(2, "0")}m</b><span>session · Map Check</span></button>
        <button class="mk-lc" data-a="start" title="Select a tile, then press to move the start"><b>⚑</b><span>Start: ${esc(m.startTile() ? m.tileName(m.startTile()) : "none")}</span></button>
        <button class="mk-lc" data-a="events"><b>⚡ ${DP.Links.events(canvas.scene).length}</b><span>events</span></button>
      </div>
      <div class="mk-right">
        <button class="mk-rb" data-a="lib" title="Library: save, load, export">≡</button>
        <button class="mk-rb ${m.tool === "erase" ? "on" : ""}" data-a="erase" title="Eraser">⌫</button>
        <button class="mk-rb" data-a="undo" title="Undo (Ctrl+Z)" ${m.undo.length ? "" : "disabled"}>↶</button>
        <button class="mk-rb" data-a="redo" title="Redo (Ctrl+Y)" ${m.redo.length ? "" : "disabled"}>↷</button>
        <div class="mk-zoom"><button data-a="zin">+</button><button data-a="zout">−</button><button data-a="fit">Fit</button></div>
      </div>
      <button class="mk-select ${m.tool === "select" ? "on" : ""}" data-a="select">✥ Select</button>
      <button class="mk-play" data-a="play">▶ Play</button>
      <div class="mk-panel">${panel()}</div>
      ${ui.modal ? `<div class="mk-modal">${modal(P)}</div>` : ""}`;
    bind(); m.drawOverlay();
  }
  function heldText() {
    const m = M();
    if (m.pendingTrigger) return "Now click the tile that triggers it (Esc to skip).";
    return ({ select: "Select: click a tile or path. Drag a tile to move it (its paths follow). On a selected path, drag a square to bend it, or a dot to add a bend.",
      erase: "Eraser: click a tile (its paths go with it) or a path.", tile: `Holding ${m.label(m.palType)}: click empty map to place it.`,
      path: "Holding Path: drag from a tile across the map to lay Blank tiles as you go, or click two tiles to link them.",
      gimmick: `Holding ${m.GIMMICKS[m.gim]?.name}: click a path. ${m.GIMMICKS[m.gim]?.desc ?? ""}`,
      fog: `Holding ${m.fogPart ? m.fogPart[0].toUpperCase() + m.fogPart.slice(1) : "Clear fog"}: click a tile.` })[m.tool] ?? "";
  }
  function panel() {
    const m = M(), s = canvas.scene, L = DP.Links.read(s);
    let insp = "";
    if (m.selTile && s.tiles.get(m.selTile)) { const t = s.tiles.get(m.selTile), fog = t.getFlag(MOD, `${ROOT}.fogMode`) ?? "";
      insp = `<div class="mk-c"><h3>Tile</h3>
        <label>Name in event lists<input type="text" data-f="tname" value="${esc(t.getFlag(MOD, `${ROOT}.makerName`) ?? "")}" placeholder="${esc(m.label(m.typeOf(t.id)))}"></label>
        <label>Type<select data-f="ttype">${opt(m.palette().map(p => [p.type, p.label]), m.typeOf(t.id))}</select></label>
        <label>Concealment<select data-f="tfog">${opt([["", "None"], ["fog", "Fog (clears while next to it)"], ["shroud", "Shroud (lifts for good)"], ["invisible", "Invisible (hidden passage)"]], fog)}</select></label>
        <div class="mk-row"><button class="mk-btn" data-a="playhere">▶ Playtest from here</button><button class="mk-btn" data-a="setstart">⚑ Start here</button><button class="mk-btn danger" data-a="deltile">Delete</button></div></div>`; }
    else if (m.selLink && L[m.selLink]) { const l = L[m.selLink], lt = l.lock ? (l.lock.lever ? "lever" : l.lock.type) : "none", hz = l.hazard?.effectConfig;
      insp = `<div class="mk-c"><h3>Path</h3><p>${esc(m.tileName(l.a))} → ${esc(m.tileName(l.b))}</p>
        <label>Name players see<input type="text" data-f="label" value="${esc(l.label ?? "")}" placeholder="e.g. Old iron gate"></label>
        <div class="mk-row" style="margin-bottom:7px"><button class="mk-btn ${l.route !== "side" ? "on" : ""}" data-a="main">Main path</button><button class="mk-btn ${l.route === "side" ? "on" : ""}" data-a="side">Side path</button></div>
        <div class="mk-row" style="margin-bottom:7px"><button class="mk-btn ${!l.oneWay ? "on" : ""}" data-a="both">Both ways</button><button class="mk-btn ${l.oneWay ? "on" : ""}" data-a="oneway">One-way</button>${l.oneWay ? `<button class="mk-btn" data-a="swap">⇆ Swap</button>` : ""}</div>
        <label>Lock<select data-f="lock">${opt([["none", "No lock"], ["switch", "Story switch (ward)"], ["lever", "Lever gate"], ["key", "Key item"], ["check", "Skill check"]], lt)}</select></label>
        ${lt === "switch" || lt === "lever" ? `<div class="mk-sub"><label>Opens when switch is ON<input type="text" data-f="swname" value="${esc(l.lock.name)}"></label></div>` : ""}
        ${lt === "key" ? `<div class="mk-sub"><label>Item name<input type="text" data-f="item" value="${esc(l.lock.item)}"></label><label class="chk"><input type="checkbox" data-f="consume" ${l.lock.consume ? "checked" : ""}> Item is used up</label></div>` : ""}
        ${lt === "check" ? `<div class="mk-sub"><div class="mk-row"><select data-f="attrA" style="flex:1">${opt(["MIG", "DEX", "INS", "WLP"].map(a => [a, a]), l.lock.attrA)}</select><select data-f="attrB" style="flex:1">${opt(["MIG", "DEX", "INS", "WLP"].map(a => [a, a]), l.lock.attrB)}</select></div>
          <label>Difficulty (DL)<input type="number" data-f="dl" min="6" max="16" value="${Number(l.lock.dl) || 10}"></label><label class="chk"><input type="checkbox" data-f="stays" ${l.lock.stays !== false ? "checked" : ""}> Stays open after one success</label></div>` : ""}
        <label>Hidden<select data-f="hidden">${opt([["", "Always shown"], ["adjacent", "Until the party lands at either end"], ["event", "Until an event connects it"]], l.hidden?.by ?? "")}</select></label>
        <label class="chk"><input type="checkbox" data-f="collapse" ${l.collapse ? "checked" : ""}> Breaks after one crossing</label>
        <label class="chk"><input type="checkbox" data-f="hazard" ${hz ? "checked" : ""}> Hazard while crossing</label>
        ${hz ? `<div class="mk-sub"><label>Damage to each member<input type="number" data-f="hzdmg" min="0" max="99" value="${Number(hz.resourceValue) || 0}"></label><p class="mk-note">Same effect setup as a Hazard tile; more options come with the tile effect editor.</p></div>` : ""}
        <div class="mk-row"><button class="mk-btn" data-a="straight" ${(l.via ?? []).length ? "" : "disabled"}>Straighten</button><button class="mk-btn danger" data-a="dellink">Delete path</button></div></div>`; }
    const E = DP.Links.events(s);
    const evHtml = E.map((e, i) => eventRow(e, i)).join("") || `<p>No events yet.</p>`;
    const reg = m.registry().map(r => `<div class="mk-stat"><span>${r.kind === "switch" ? "Switch" : "Key"}: ${esc(r.name)}<small>${r.kind === "switch" ? `used by ${r.used} · set here by ${r.set}` : `${r.used} gate(s)`}</small></span>
      <span class="mk-chip" style="color:${r.kind === "switch" ? (r.used && !r.set ? "#c08a12" : "#3c9a5b") : "#b07a2a"}">${r.kind === "switch" ? (r.used && !r.set ? "never set here" : "ok") : "check"}</span></div>`).join("") || `<p>No switches or keys yet.</p>`;
    return `<div class="mk-c"><h3>In hand</h3><p>${esc(heldText())}</p><p class="mk-note">Parts on the top bar; 🔍 shows all. Ctrl+Z / Ctrl+Y undo and redo. Right-drag pans.</p></div>
      ${insp}<div class="mk-c" data-sec="events"><h3>Events</h3><p>When something happens, do things. Runs on the GM.</p>${evHtml}<button class="mk-btn" data-a="addev">+ Add event</button></div>
      <div class="mk-c"><h3>Switches and keys</h3>${reg}</div>`;
  }
  const ACT = { connect: ["Connect path", "eventlink"], open: ["Open lock on", "lockedlink"], setSwitch: ["Turn switch ON", "switch"], break: ["Break path", "link"], reveal: ["Clear fog on", "fogtile"] };
  function argOptions(kind, cur) {
    const m = M(), s = canvas.scene, L = DP.Links.read(s);
    const tiles = s.tiles.contents.filter(t => s.flags?.[MOD]?.[ROOT]?.tileStates?.[t.id]);
    if (kind === "tile") return opt(tiles.map(t => [t.id, m.tileName(t.id)]), cur);
    if (kind === "fogtile") return opt(tiles.filter(t => t.getFlag(MOD, `${ROOT}.fogMode`)).map(t => [t.id, m.tileName(t.id)]), cur);
    if (kind === "link") return opt(Object.keys(L).map(id => [id, m.linkName(id)]), cur);
    if (kind === "lockedlink") return opt(Object.entries(L).filter(([, l]) => l.lock).map(([id]) => [id, m.linkName(id)]), cur);
    if (kind === "eventlink") return opt(Object.entries(L).filter(([, l]) => l.hidden?.by === "event").map(([id]) => [id, m.linkName(id)]), cur);
    if (kind === "switch") { const names = new Set(Object.values(L).filter(l => l.lock?.type === "switch").map(l => l.lock.name)); if (cur) names.add(cur); return opt([...names].map(n => [n, n]), cur); }
    return "";
  }
  function eventRow(e, i) {
    const cond = e.cond?.type ?? "none";
    return `<div class="mk-ev" data-ev="${i}">
      <div class="mk-evl"><b>When</b><select data-k="when.type">${opt([["land", "party lands on"], ["switch", "switch turns ON"]], e.when?.type)}</select>
        ${e.when?.type === "switch" ? `<input type="text" data-k="when.arg" value="${esc(e.when.arg)}">` : `<select data-k="when.arg">${argOptions("tile", e.when?.arg)}</select>`}<span></span></div>
      <div class="mk-evl"><b>If</b><select data-k="cond.type">${opt([["none", "always"], ["item", "party has item"], ["switch", "switch is ON"]], cond)}</select>
        ${cond === "none" ? "<span></span>" : `<input type="text" data-k="cond.arg" value="${esc(e.cond?.arg ?? "")}">`}<span></span></div>
      ${(e.then ?? []).map((a, j) => `<div class="mk-evl"><b>${j ? "and" : "Then"}</b><select data-k="then.${j}.type">${opt(Object.entries(ACT).map(([k, v]) => [k, v[0]]), a.type)}</select>
        ${a.type === "setSwitch" ? `<input type="text" data-k="then.${j}.arg" value="${esc(a.arg)}">` : `<select data-k="then.${j}.arg">${argOptions(ACT[a.type]?.[1], a.arg)}</select>`}<button class="x" data-delact="${j}">×</button></div>`).join("")}
      <div class="mk-row"><button class="mk-btn" data-addact>+ Action</button><button class="mk-btn danger" data-delev>Delete</button></div></div>`;
  }
  function modal(P) {
    const m = M(), x = `<button class="mk-x" data-a="closemodal">✕</button>`, s = canvas.scene;
    if (ui.modal === "parts") return `${x}<h3>Parts</h3>${Object.keys(CAT).map(c => `<h4 style="--c:${CAT[c]}">${c}</h4><div class="mk-grid">${P.filter(p => p.cat === c).map(p => `<button class="mk-card big" style="--c:${CAT[c]}" data-part="${esc(p.k)}">${icon(p)}<small>${esc(p.name)}</small></button>`).join("")}</div>`).join("")}`;
    if (ui.modal === "check") return `${x}<h3>Map Check</h3>${m.mapCheck().map((c, i) => `<button class="mk-check" data-chk="${i}"><span class="mk-chip" style="color:${c.sev === "ok" ? "#3c9a5b" : c.sev === "warn" ? "#c08a12" : "#c0503b"}">${c.sev === "ok" ? "✓" : c.sev === "warn" ? "!" : "✕"}</span><b>${esc(c.title)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</button>`).join("")}`;
    if (ui.modal === "map") { const d = s.flags?.[MOD]?.oniDungeon ?? {}, g = s.flags?.[MOD]?.oniFabula?.general ?? {};
      const ws = Object.entries(g).filter(([k, v]) => k.startsWith("wellspring_") && v).map(([k]) => k.replace("wellspring_", "")).join(" + ") || "none";
      return `${x}<h3>Map settings · ${esc(s.navName || s.name)}</h3><p class="mk-note">Read from this scene. Edit them in Scene Config → Fabula tabs.</p>
        <div class="mk-kv"><span>Scene mode</span><b>${esc(g.sceneMode ?? "")}</b><span>Wellsprings</span><b>${esc(ws)}</b><span>Threat level</span><b>${esc(d.threatLevel ?? "")}</b>
        <span>Battle map</span><b>${esc(game.scenes.get(String(d.battleMap ?? "").replace("Scene.", ""))?.name ?? "none")}</b><span>Battle / boss BGM</span><b>${esc(d.battleBGM ?? "")} · ${esc(d.bossBGM ?? "")}</b>
        <span>Tiles · paths · events</span><b>${s.tiles.size} · ${Object.keys(DP.Links.read(s)).length} · ${DP.Links.events(s).length}</b></div>`; }
    if (ui.modal === "lib") { const snaps = s.getFlag(MOD, `${ROOT}.makerSnapshots`) ?? [];
      return `${x}<h3>Library</h3><p class="mk-note">Save up to 3 versions of this map, load one back, or move a dungeon between worlds as text.</p>
        <div class="mk-row"><input type="text" data-f="snapname" placeholder="Snapshot name" style="flex:1;min-width:0;background:#fff;border:2px solid #ead9bb;border-radius:10px;padding:6px 8px;color:#5a3d22"><button class="mk-btn" data-a="snapsave">Save</button></div>
        ${snaps.map((sn, i) => `<div class="mk-stat"><span>${esc(sn.name)}<small>${esc(sn.at)} · ${sn.tiles} tiles · ${sn.links} paths</small></span><span class="mk-row"><button class="mk-btn" data-load="${i}">Load</button><button class="mk-btn danger" data-delsnap="${i}">×</button></span></div>`).join("") || `<p>No snapshots yet.</p>`}
        <h4>Export / import</h4><textarea data-f="json" rows="5" style="width:100%;font:12px ui-monospace,monospace;background:#fff;border:2px solid #ead9bb;border-radius:10px;color:#5a3d22"></textarea>
        <div class="mk-row"><button class="mk-btn" data-a="export">Export</button><button class="mk-btn" data-a="import">Import</button></div>`; }
    return "";
  }

  // ── Events from the UI ─────────────────────────────────────────────────────
  function bind() {
    const m = M(), r = ui.root, s = canvas.scene, q = (sel) => r.querySelector(sel);
    r.querySelectorAll("[data-part]").forEach(b => b.onclick = () => pick(b.dataset.part));
    r.querySelectorAll("[data-a]").forEach(b => b.onclick = () => act(b.dataset.a));
    r.querySelectorAll("[data-chk]").forEach(b => b.onclick = () => { const c = m.mapCheck()[+b.dataset.chk]; if (c?.ids?.length) { m.selTile = c.ids[0]; m.selLink = null; const t = s.tiles.get(c.ids[0]); canvas.animatePan({ x: t.x, y: t.y, duration: 300 }); ui.modal = null; render(); } });
    r.querySelectorAll("[data-load]").forEach(b => b.onclick = async () => { const sn = (s.getFlag(MOD, `${ROOT}.makerSnapshots`) ?? [])[+b.dataset.load]; if (sn) { await m.restoreSnapshot(sn.data); DP.LinkPlay.hint(`Loaded "${sn.name}".`); } });
    r.querySelectorAll("[data-delsnap]").forEach(b => b.onclick = async () => { const a = [...(s.getFlag(MOD, `${ROOT}.makerSnapshots`) ?? [])]; a.splice(+b.dataset.delsnap, 1); await s.setFlag(MOD, `${ROOT}.makerSnapshots`, a); render(); });
    const sel = m.selTile, lnk = m.selLink, L = DP.Links.read(s), l = lnk ? L[lnk] : null, F = (f) => q(`[data-f="${f}"]`);
    if (sel) {
      F("tname")?.addEventListener("change", e => m.ops.renameTile(sel, e.target.value.trim()));
      F("ttype")?.addEventListener("change", e => m.ops.retype(sel, e.target.value));
      F("tfog")?.addEventListener("change", e => m.ops.setFog(sel, e.target.value));
    }
    if (l) {
      const P = (patch) => m.ops.patchLink(lnk, patch);
      F("label")?.addEventListener("change", e => P({ label: e.target.value }));
      F("lock")?.addEventListener("change", e => { const v = e.target.value;
        P({ lock: v === "none" ? undefined : v === "switch" ? { type: "switch", name: "Ward" } : v === "lever" ? { type: "switch", name: `Lever ${1 + Object.values(L).filter(x => x.lock?.lever).length}`, lever: true }
          : v === "key" ? { type: "key", item: "Rusty Key", consume: false } : { type: "check", attrA: "MIG", attrB: "DEX", dl: 10, stays: true } }); });
      F("swname")?.addEventListener("change", e => P({ lock: { ...l.lock, name: e.target.value.trim() } }));
      F("item")?.addEventListener("change", e => P({ lock: { ...l.lock, item: e.target.value.trim() } }));
      F("consume")?.addEventListener("change", e => P({ lock: { ...l.lock, consume: e.target.checked } }));
      F("attrA")?.addEventListener("change", e => P({ lock: { ...l.lock, attrA: e.target.value } }));
      F("attrB")?.addEventListener("change", e => P({ lock: { ...l.lock, attrB: e.target.value } }));
      F("dl")?.addEventListener("change", e => P({ lock: { ...l.lock, dl: Math.max(6, Math.min(16, +e.target.value || 10)) } }));
      F("stays")?.addEventListener("change", e => P({ lock: { ...l.lock, stays: e.target.checked } }));
      F("hidden")?.addEventListener("change", e => P({ hidden: e.target.value ? { by: e.target.value } : undefined }));
      F("collapse")?.addEventListener("change", e => P({ collapse: e.target.checked || undefined }));
      F("hazard")?.addEventListener("change", e => P({ hazard: e.target.checked ? { effectConfig: { enabled: true, targetMode: "all", useResourceChange: true, resourceType: "damage", resourceValue: 5, elementType: "elementless", ignoreReduction: false, weaponType: "none_ef", vfxType: "none", silent: false } } : undefined }));
      F("hzdmg")?.addEventListener("change", e => P({ hazard: { effectConfig: { ...l.hazard.effectConfig, resourceValue: Math.max(0, +e.target.value || 0) } } }));
    }
    // events editor
    const E = foundry.utils.deepClone(DP.Links.events(s));
    r.querySelectorAll(".mk-ev").forEach(box => { const i = +box.dataset.ev, e = E[i];
      box.querySelectorAll("[data-k]").forEach(inp => inp.addEventListener("change", () => { const k = inp.dataset.k.split("."), v = inp.value;
        if (k[0] === "when") { e.when[k[1]] = v; if (k[1] === "type") e.when.arg = v === "land" ? (m.selTile ?? m.startTile() ?? "") : "Ward"; }
        if (k[0] === "cond") { e.cond ??= { type: "none", arg: "" }; e.cond[k[1]] = v; if (k[1] === "type") e.cond.arg = ""; }
        if (k[0] === "then") { const a = e.then[+k[1]]; a[k[2]] = v; if (k[2] === "type") a.arg = ""; }
        m.ops.setEvents(E); }));
      box.querySelectorAll("[data-delact]").forEach(b => b.onclick = () => { e.then.splice(+b.dataset.delact, 1); m.ops.setEvents(E); });
      box.querySelector("[data-addact]").onclick = () => { e.then.push({ type: "setSwitch", arg: "" }); m.ops.setEvents(E); };
      box.querySelector("[data-delev]").onclick = () => { E.splice(i, 1); m.ops.setEvents(E); };
    });
  }
  async function act(a) {
    const m = M(), s = canvas.scene;
    switch (a) {
      case "done": return closeMaker();
      case "parts": case "map": case "lib": case "check": ui.modal = ui.modal === a ? null : a; return render();
      case "closemodal": ui.modal = null; return render();
      case "events": return ui.root.querySelector('[data-sec="events"]')?.scrollIntoView({ behavior: "smooth" });
      case "start": case "setstart": if (!m.selTile) return DP.LinkPlay.hint("Select a tile first."); await s.setFlag(MOD, `${ROOT}.makerStart`, m.selTile); return render();
      case "erase": m.tool = m.tool === "erase" ? "select" : "erase"; return render();
      case "select": m.tool = "select"; ui.part = null; return render();
      case "undo": return m.undoStep(); case "redo": return m.redoStep();
      case "zin": return canvas.animatePan({ scale: Math.min(3, canvas.stage.scale.x * 1.2), duration: 150 });
      case "zout": return canvas.animatePan({ scale: Math.max(0.2, canvas.stage.scale.x / 1.2), duration: 150 });
      case "fit": return canvas.animatePan({ x: s.dimensions.width / 2, y: s.dimensions.height / 2, scale: Math.min(window.innerWidth / s.dimensions.width, window.innerHeight / s.dimensions.height) * 0.9, duration: 250 });
      case "play": case "playhere": return m.startPlaytest(a === "playhere" ? m.selTile : (m.selTile ?? m.startTile()));
      case "make": return m.stopPlaytest();
      case "deltile": return m.selTile && m.ops.eraseTile(m.selTile);
      case "dellink": return m.selLink && m.ops.eraseLink(m.selLink);
      case "main": case "side": return m.ops.patchLink(m.selLink, { route: a });
      case "both": return m.ops.patchLink(m.selLink, { oneWay: false });
      case "oneway": return m.ops.patchLink(m.selLink, { oneWay: true });
      case "swap": { const l = DP.Links.read(s)[m.selLink]; return m.ops.patchLink(m.selLink, { a: l.b, b: l.a, via: [...(l.via ?? [])].reverse() }); }
      case "straight": return m.ops.patchLink(m.selLink, { via: [] });
      case "addev": return m.ops.setEvents([...DP.Links.events(s), { id: foundry.utils.randomID(16), when: { type: "land", arg: m.selTile ?? m.startTile() ?? "" }, cond: { type: "none", arg: "" }, then: [{ type: "setSwitch", arg: "" }] }]);
      case "snapsave": { const name = ui.root.querySelector('[data-f="snapname"]')?.value.trim() || `Snapshot ${new Date().toLocaleString()}`, data = m.snapshot();
        const a2 = [{ name, at: new Date().toLocaleString(), tiles: data.tiles.length, links: Object.keys(data.links).length, data }, ...(s.getFlag(MOD, `${ROOT}.makerSnapshots`) ?? [])].slice(0, 3);   // ~80 KB each: scene flags count toward the world payload
        await s.setFlag(MOD, `${ROOT}.makerSnapshots`, a2); return render(); }
      case "export": { const ta = ui.root.querySelector('[data-f="json"]'); ta.value = JSON.stringify(m.snapshot()); ta.select(); return DP.LinkPlay.hint("Exported. Copy the text to share this dungeon."); }
      case "import": { try { const d = JSON.parse(ui.root.querySelector('[data-f="json"]').value); if (!d.tiles || !d.links) throw 0; await m.restoreSnapshot(d); DP.LinkPlay.hint("Imported."); } catch { DP.LinkPlay.hint("That text isn't a dungeon export."); } return; }
    }
  }

  // ── Open / close with the slide ────────────────────────────────────────────
  function openMaker() { if (!game.user?.isGM) return; M().open(); render(); const s = canvas.scene; canvas.animatePan({ x: s.dimensions.width / 2, y: s.dimensions.height / 2, scale: Math.min((window.innerWidth - 540) / s.dimensions.width, (window.innerHeight - 110) / s.dimensions.height), duration: 520 }); }
  function closeMaker() { if (!ui.root) return M().close(); ui.root.classList.add("off"); setTimeout(() => { M().close(); closeChrome(); }, 420); }
  function closeChrome() { ui.root?.remove(); ui.root = null; ui.modal = null; document.body.classList.remove("oni-maker-on"); }
  /** The 🛠️ dev-tool button: GM only, on dungeon maps (and any scene with links). */
  function devButton() {
    const show = !!game.user?.isGM && !!canvas?.scene && (canvas.scene.flags?.[MOD]?.oniFabula?.general?.sceneMode === "dungeon" || DP.Links?.isMigrated?.(canvas.scene)) && !M()?.active;
    if (!show) { ui.btn?.remove(); ui.btn = null; return; }
    if (ui.btn && document.body.contains(ui.btn)) return;
    ensureCss(); ui.btn = document.createElement("button"); ui.btn.id = "oni-dp-devbtn"; ui.btn.title = "Dungeon Maker (GM)"; ui.btn.textContent = "🛠️";
    ui.btn.onclick = openMaker; document.body.appendChild(ui.btn);
  }

  Hooks.once("ready", () => { if (!DP.Maker) return; DP.Maker.onChange = render; });
  Hooks.on("canvasReady", () => { if (DP.Maker?.active) closeMaker(); render(); });
  Hooks.on("updateScene", (s) => { if (DP.Maker?.active && s.id === canvas?.scene?.id) render(); });
  for (const h of ["createTile", "updateTile", "deleteTile"]) Hooks.on(h, (d) => { if (DP.Maker?.active && d.parent?.id === canvas?.scene?.id) render(); });
  DP.MakerUI = { open: openMaker, close: closeMaker, render };
})();
