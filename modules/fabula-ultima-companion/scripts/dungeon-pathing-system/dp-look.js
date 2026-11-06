// ============================================================================
// Dungeon Pathing — Look (the "Dungeon chart" visuals)
//
//   DP.Look.unknownDisc(w, h, fogMode)  the "?" isometric disc + UNKNOWN label that
//                                       dp-fog.js shows on fog / shroud tiles
//   DP.Look.showGlow(node) / hideGlow() soft glow UNDER a hovered tile (replaces
//                                       dp-overlay's gold square on migrated scenes)
//   DP.Tooltip                          cream speech bubble with the tile's name,
//                                       only in Helper mode (walkable tiles) or Scan
//                                       mode (any tile)
//
// Performance (feedback_dp_perf_pitfalls): textures are baked once; one shared
// ticker drives every mist blob and the glow fade and removes itself when idle;
// containers are removed from their parent before destroy; the tooltip reads no
// layout inside its frame loop.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Look]";
  const reduceMotion = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // ── Baked textures ─────────────────────────────────────────────────────────
  const _tex = {};
  function softTexture(key, rgb) {
    if (_tex[key] && !_tex[key].baseTexture?.destroyed) return _tex[key];
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, `rgba(${rgb},1)`); grd.addColorStop(0.45, `rgba(${rgb},0.45)`); grd.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return (_tex[key] = PIXI.Texture.from(c));
  }

  // ── One shared ticker for mist + glow fades ────────────────────────────────
  const _mist = new Set();          // containers with ._mistBlobs
  let _glowFade = null;             // { sprite, from, to, t0, dur }
  let _tickerOn = false;
  function tick() {
    const now = performance.now();
    for (const c of _mist) {
      if (c.destroyed || !c.parent) { _mist.delete(c); continue; }
      if (reduceMotion()) continue;
      for (const b of c._mistBlobs) { const a = b._ang + (now / 7000) * b._dir;
        b.x = c._cx + Math.cos(a) * b._r * 1.5; b.y = c._cy + Math.sin(a) * b._r * 0.7; }
    }
    if (_glowFade) { const f = _glowFade, k = Math.min(1, (now - f.t0) / f.dur);
      if (f.sprite.destroyed) _glowFade = null;
      else { f.sprite.alpha = f.from + (f.to - f.from) * k; if (k >= 1) { if (f.to === 0) f.sprite.visible = false; _glowFade = null; } } }
    if (!_mist.size && !_glowFade) { canvas?.app?.ticker?.remove(tick); _tickerOn = false; }
  }
  function wake() { if (_tickerOn || !canvas?.app?.ticker) return; canvas.app.ticker.add(tick); _tickerOn = true; }

  // ── "?" disc for fog / shroud tiles ────────────────────────────────────────
  const FOG_COL = 0xcfe0ea, SHROUD_COL = 0xf3dc4a;
  function unknownDisc(w, h, fogMode) {
    const root = new PIXI.Container();
    const col = fogMode === "shroud" ? SHROUD_COL : FOG_COL, css = fogMode === "shroud" ? "#f3dc4a" : "#cfe0ea";
    const cx = w / 2, cy = h * 0.78, rx = w * 0.62, ry = h * 0.35;
    root._cx = cx; root._cy = cy - h * 0.1;
    if (fogMode === "fog") {                                  // drifting mist over the area
      const tex = softTexture("mist", "226,236,246"); root._mistBlobs = [];
      for (let i = 0; i < 7; i++) { const s = new PIXI.Sprite(tex); s.anchor.set(0.5);
        s.width = w * (1.6 + (i % 4) * 0.35); s.height = s.width * 0.55; s.alpha = 0.32;
        s._ang = i * 0.8; s._dir = i % 2 ? 1 : -1; s._r = w * (0.35 + (i % 3) * 0.35);
        root.addChild(s); root._mistBlobs.push(s); }
      _mist.add(root); wake();
    }
    const g = new PIXI.Graphics();
    g.lineStyle({ width: 4, color: 0x000000, alpha: 0.5 }); g.drawEllipse(cx, cy, rx, ry);
    g.lineStyle({ width: 2.2, color: col, alpha: 1 }); g.beginFill(col, fogMode === "shroud" ? 0.1 : 0.14); g.drawEllipse(cx, cy, rx, ry); g.endFill();
    root.addChild(g);
    const q = new PIXI.Text("?", { fontFamily: "Signika, sans-serif", fontWeight: "800", fontSize: Math.round(h * 0.95), fill: css, stroke: "#2a2000", strokeThickness: 4 });
    q.anchor.set(0.5, 1); q.position.set(cx, cy + h * 0.06); root.addChild(q);
    const label = new PIXI.Text("UNKNOWN", { fontFamily: "Signika, sans-serif", fontWeight: "700", fontSize: 9.5, fill: css, letterSpacing: 0.5 });
    label.anchor.set(0.5, 0.5);
    const pill = new PIXI.Graphics(), pw = label.width + 10, py = cy + ry + 9;
    pill.lineStyle({ width: 1, color: col }); pill.beginFill(0x141008, 0.9); pill.drawRoundedRect(cx - pw / 2, py - 6.5, pw, 13, 6); pill.endFill();
    label.position.set(cx, py); root.addChild(pill, label);
    return root;
  }

  // ── Soft glow under the hovered tile ───────────────────────────────────────
  let _glow = null;
  function showGlow(node, { blocked = false } = {}) {
    const root = DP.LinkLayer?.root?.(); if (!root || !node) return false;
    if (!_glow || _glow.destroyed) { _glow = new PIXI.Sprite(softTexture("glow", "255,255,255")); _glow.anchor.set(0.5); _glow.visible = false; _glow.alpha = 0; }
    if (_glow.parent !== root) root.addChild(_glow);       // last child = above the links, still under the tiles
    const size = Math.max(node.width, node.height) * 2.2;
    _glow.width = _glow.height = size; _glow.position.set(node.center.x, node.center.y);
    _glow.tint = blocked ? 0xff7a6b : 0xffd66e; _glow.visible = true;
    _glowFade = { sprite: _glow, from: _glow.alpha, to: 0.85, t0: performance.now(), dur: reduceMotion() ? 1 : 140 }; wake();
    return true;
  }
  function hideGlow() {
    if (!_glow || _glow.destroyed || !_glow.visible) return;
    _glowFade = { sprite: _glow, from: _glow.alpha, to: 0, t0: performance.now(), dur: reduceMotion() ? 1 : 120 }; wake();
  }

  DP.Look = { unknownDisc, showGlow, hideGlow };

  // ── Helper / Scan tooltip: cream speech bubble ─────────────────────────────
  const STYLE_ID = "oni-dp-tip-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style"); s.id = STYLE_ID;
    s.textContent = `
#oni-dp-tip { position: fixed; z-index: 99990; pointer-events: none; left: 0; top: 0;
  opacity: 0; transform: translate(-50%, calc(-100% + 8px)); transition: opacity 200ms cubic-bezier(.2,.8,.2,1), transform 200ms cubic-bezier(.2,.8,.2,1); }
#oni-dp-tip.show { opacity: 1; transform: translate(-50%, -100%); }
#oni-dp-tip .b { position: relative; background: #fffaf1; color: #3a2410; border: 2px solid #4a2c18; border-radius: 12px; padding: 4px 12px 5px;
  font: 700 13px "Palatino Linotype", Palatino, Georgia, serif; white-space: nowrap; box-shadow: 0 3px 10px rgba(40,24,8,.35); margin-bottom: 9px; text-align: center; }
#oni-dp-tip .b small { display: block; font: 600 11.5px Signika, sans-serif; color: #7a5634; }
#oni-dp-tip .b::after, #oni-dp-tip .b::before { content: ""; position: absolute; left: 50%; border: 8px solid transparent; border-bottom: 0; }
#oni-dp-tip .b::before { bottom: -9px; margin-left: -8px; border-top-color: #4a2c18; }
#oni-dp-tip .b::after { bottom: -6px; margin-left: -6px; border-width: 6px; border-bottom: 0; border-top-color: #fffaf1; }
@media (prefers-reduced-motion: reduce) { #oni-dp-tip { transition: none; } }`;
    document.head.appendChild(s);
  }
  let _el = null, _node = null, _raf = null, _throttle = 0;
  function el() { if (_el && document.body.contains(_el)) return _el; ensureStyle(); _el = document.createElement("div"); _el.id = "oni-dp-tip"; _el.innerHTML = `<div class="b"></div>`; document.body.appendChild(_el); return _el; }
  function track() {
    _raf = null; if (!_node || !_el) return;
    try { const p = canvas.clientCoordinatesFromCanvas({ x: _node.center.x, y: _node.bounds.top - 2 }); _el.style.left = `${p.x}px`; _el.style.top = `${p.y}px`; } catch {}
    _raf = requestAnimationFrame(track);
  }
  function show(node, title, sub = "") {
    const e = el(), b = e.firstElementChild;
    if (_node?.nodeId === node.nodeId && e.classList.contains("show")) return;
    if (_node && _node.nodeId !== node.nodeId) { e.classList.remove("show"); void e.offsetWidth; }   // restart the rise for the new tile
    b.innerHTML = ""; b.textContent = title; if (sub) { const s = document.createElement("small"); s.textContent = sub; b.appendChild(s); }
    _node = node; if (!_raf) track(); requestAnimationFrame(() => e.classList.add("show"));
  }
  function hide() { if (_el) _el.classList.remove("show"); _node = null; if (_raf) { cancelAnimationFrame(_raf); _raf = null; } }

  function tileTitle(node) {
    if (!game.user?.isGM && DP.Fog?.isConcealed?.(node.nodeId)) return "Unknown";
    const raw = DP.TileEventRegistry?.get?.(node.tileType)?.label ?? node.name ?? "Tile";
    // Registry labels read "SkillCheck Tile"; players see "Skill Check".
    return String(raw).replace(/\s*\(.*\)$/, "").replace(/\s*Tile$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Tile";
  }
  function onMove(ev) {
    const now = performance.now(); if (now - _throttle < 60) return; _throttle = now;
    if (DP.Maker?.active) return hide();
    const rt = DP.Runtime, helper = !!DP.HelperMode?.enabled, scan = !!DP.ScanMode?.active;
    if (!rt?.active || !rt.graph || !(helper || scan) || rt.busy || DP.ConfirmDialog?.isOpen) return hide();
    const p = DP.Graph.clientToWorld(ev.clientX, ev.clientY);
    const ids = scan ? rt.graph.nodes.map(n => n.nodeId) : [...(rt.neighborIds ?? [])];
    let hit = null;
    for (const id of ids) { const n = rt.graph.nodeMap.get(id), b = n?.bounds; if (!b) continue;
      if (p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom) { hit = n; break; } }
    if (!hit || (!game.user?.isGM && DP.Fog?.isHiddenPassage?.(hit.nodeId))) return hide();
    show(hit, tileTitle(hit));
  }
  Hooks.on("canvasReady", () => { hide(); const v = canvas?.app?.view; if (v && !v._oniTip) { v.addEventListener("pointermove", onMove, { passive: true }); v._oniTip = true; } });
  Hooks.on("canvasTearDown", () => { hide(); _mist.clear(); if (_glow && !_glow.destroyed) { _glow.parent?.removeChild(_glow); _glow.destroy(); } _glow = null; _glowFade = null; });
  DP.Tooltip = { show, hide };
})();
