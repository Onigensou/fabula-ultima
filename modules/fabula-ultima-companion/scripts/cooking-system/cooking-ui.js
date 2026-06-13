// ============================================================================
// Cooking System — UI Layer (DOM overlay, no Application windows)
// CookingMainPanel  : fixed-position overlay visible on all clients
// CookingPickerPanel: ingredient picker (per-player, bottom-right corner)
// globalThis.CookingUI : manager singleton
// ============================================================================
(() => {
  const GUARD = "__ONI_COOKING_UI__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const TAG = "[FUCompanion][CookingUI]";

  const SFX = {
    OPEN:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav",
    HOVER:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Success_1.wav",
    SELECT:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/cooking_ingredient_selected.wav",
    CONFIRM: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/check_ready.wav",
    THROW:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Fall.ogg",
    ABSORB:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_create.wav",
    START:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/cooking_begin.mp3",
    RESULTS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/bond_level_3.wav",
    EAT:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Eating.mp3",
  };
  let _hoverSfxTs = 0;
  function _sfx(src) {
    try { AudioHelper?.play?.({ src, volume: 0.75, autoplay: true, loop: false }, false); } catch(e) {}
  }

  const TASTES = ["bitter", "salty", "sour", "sweet", "umami"];
  const TASTE_META = {
    bitter: { label: "Bitter", color: "#3a7a3a", angle: 90,   tip: "Strengthens defensive and magical effects" },
    salty:  { label: "Salty",  color: "#2a5fa8", angle: 18,   tip: "Enhances healing and restoration power" },
    sour:   { label: "Sour",   color: "#c07020", angle: -54,  tip: "Boosts offensive capabilities of the dish" },
    sweet:  { label: "Sweet",  color: "#b03060", angle: -126, tip: "Improves buffs and beneficial status effects" },
    umami:  { label: "Umami",  color: "#7040b0", angle: 162,  tip: "Amplifies overall dish potency and duration" },
  };

  // ── Spider chart SVG ───────────────────────────────────────────────────────
  const _CHART_R = 108, _CHART_CX = 150, _CHART_CY = 150;
  function _chartPt(t, frac) {
    const rad = TASTE_META[t].angle * Math.PI / 180;
    return { x: _CHART_CX + frac * _CHART_R * Math.cos(rad), y: _CHART_CY - frac * _CHART_R * Math.sin(rad) };
  }

  function _spiderSvg(tasteValues) {
    let grid = "";
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const pts = TASTES.map(t => { const p = _chartPt(t,f); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ");
      grid += `<polygon points="${pts}" fill="none" stroke="rgba(91,63,38,${f===1?0.22:0.09})" stroke-width="${f===1?0.8:0.45}"/>`;
    }
    let axes = "";
    for (const t of TASTES) {
      const p = _chartPt(t,1);
      axes += `<line x1="${_CHART_CX}" y1="${_CHART_CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="rgba(91,63,38,0.13)" stroke-width="0.55"/>`;
    }
    const vals = TASTES.map(t => Math.min(1, (Number(tasteValues?.[t] ?? 0)) / 8));
    const hasData = vals.some(v => v > 0);
    const dpts = TASTES.map((t,i) => { const p = _chartPt(t, vals[i]); return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; }).join(" ");
    const dots = TASTES.map((t,i) => {
      const p = _chartPt(t, vals[i]);
      return `<circle data-taste="${t}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4" fill="${TASTE_META[t].color}" stroke="rgba(255,255,255,0.6)" stroke-width="1.2"${vals[i] < 0.001 ? ' style="display:none"' : ''}/>`;
    }).join("");
    let labels = "";
    for (const t of TASTES) {
      const p = _chartPt(t, 1.25);
      labels += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${TASTE_META[t].color}" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#f6ebd3" stroke-width="2.5">${TASTE_META[t].label}</text>`;
    }
    const polyHide = hasData ? "" : " style=\"display:none\"";
    return `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" class="oni-cook-chart">${grid}${axes}<polygon class="oni-cook-data-poly" points="${dpts}" fill="rgba(184,153,64,0.22)" stroke="rgba(141,100,20,0.7)" stroke-width="1.4" stroke-linejoin="round"${polyHide}/><g class="oni-cook-data-dots">${dots}</g>${labels}</svg>`;
  }

  // Update only the animated data layer inside an existing chart SVG
  function _updateChartDOM(svgEl, tv) {
    const vals = TASTES.map(t => Math.min(1, (Number(tv?.[t] ?? 0)) / 8));
    const hasData = vals.some(v => v > 0.001);
    const poly = svgEl.querySelector(".oni-cook-data-poly");
    if (poly) {
      const dpts = TASTES.map((t,i) => { const p = _chartPt(t, vals[i]); return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; }).join(" ");
      poly.setAttribute("points", dpts);
      poly.style.display = hasData ? "" : "none";
    }
    TASTES.forEach((t, i) => {
      const dot = svgEl.querySelector(`circle[data-taste="${t}"]`);
      if (dot) {
        if (vals[i] > 0.001) { const p = _chartPt(t, vals[i]); dot.setAttribute("cx", p.x.toFixed(2)); dot.setAttribute("cy", p.y.toFixed(2)); dot.style.display = ""; }
        else { dot.style.display = "none"; }
      }
    });
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  const COOK_CSS = `
    /* ── Main overlay ── */
    #oni-cook-main {
      position:fixed; inset:0; z-index:1600;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.5); pointer-events:auto;
    }
    .oni-cook-main-panel {
      position:relative;
      background:linear-gradient(180deg,#f6ebd3 0%,#eddecb 55%,#e4d0b5 100%);
      border:2.5px solid rgba(91,63,38,.9);
      border-radius:16px;
      box-shadow:0 12px 36px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.7);
      color:#3b2a19;
      width:680px; max-width:95vw;
      display:flex; flex-direction:column;
      overflow:hidden;
    }
    .oni-cook-panel-header {
      padding:9px 16px; text-align:center;
      background:linear-gradient(180deg,#e8d5a3,#dfc890);
      border-bottom:2px solid rgba(184,153,64,.55);
      font-size:15px; font-weight:900; color:#5a3800; letter-spacing:.06em;
    }

    /* ── Board grid ── */
    .oni-cook-board {
      display:grid;
      grid-template-areas:"tl center tr" "bl center br";
      grid-template-columns:160px 1fr 160px;
      grid-template-rows:175px 175px;
      gap:8px; padding:10px;
    }
    .oni-cook-corner-area.tl{grid-area:tl;} .oni-cook-corner-area.tr{grid-area:tr;}
    .oni-cook-corner-area.bl{grid-area:bl;} .oni-cook-corner-area.br{grid-area:br;}
    .oni-cook-center-area{grid-area:center;display:flex;align-items:center;justify-content:center;position:relative;}

    /* ── Corner slots ── */
    .oni-cook-corner {
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:5px;padding:8px;border-radius:12px;height:100%;box-sizing:border-box;
      background:rgba(255,255,255,.35);border:1.5px solid rgba(91,63,38,.2);
    }
    .oni-cook-portrait {
      width:52px;height:52px;border-radius:50%;object-fit:cover;
      border:2px solid rgba(91,63,38,.35); flex-shrink:0;
    }
    .oni-cook-actor-name { font-size:11px;color:#5a3800;text-align:center;font-weight:700;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .oni-cook-ing-slot {
      width:60px;height:60px;border:2px dashed rgba(91,63,38,.3);border-radius:9px;
      display:flex;align-items:center;justify-content:center;
      transition:border-color .2s,background .2s;background:rgba(255,255,255,.3);flex-shrink:0;
    }
    .oni-cook-ing-slot.preview { border-color:rgba(184,153,64,.75);background:rgba(255,200,50,.1); }
    .oni-cook-ing-slot.locked  { border-style:solid;border-color:#2e7d32;background:rgba(46,125,50,.12); }
    .oni-cook-ing-img { width:50px;height:50px;object-fit:contain;border:none!important; }
    .oni-cook-ing-name { font-size:9.5px;font-weight:700;text-align:center;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:4px;line-height:1.4;min-height:1.4em; }
    .oni-cook-ing-name.preview { color:#5a3800; }
    .oni-cook-ing-name.locked  { color:#1b6b1f; }

    /* ── Center area ── */
    .oni-cook-chart { width:288px;height:288px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;opacity:.95; }
    .oni-cook-pot-img { width:68px;height:68px;object-fit:contain;position:relative;z-index:2;filter:drop-shadow(0 3px 8px rgba(91,63,38,.4));transition:transform .3s;border:none!important; }
    @keyframes oni-cook-pot-bounce { 0%,100%{transform:translateY(0) scale(1)} 30%{transform:translateY(-10px) scale(1.06)} 60%{transform:translateY(2px) scale(.96)} 80%{transform:translateY(-4px) scale(1.02)} }
    @keyframes oni-cook-pot-idle { 0%,100%{transform:translateY(0) rotate(0deg)} 35%{transform:translateY(-4px) rotate(-1.2deg)} 65%{transform:translateY(-3px) rotate(0.8deg)} }
    @keyframes oni-cook-anticipate { 0%,100%{filter:drop-shadow(0 3px 8px rgba(91,63,38,.4))} 50%{filter:drop-shadow(0 0 20px rgba(200,160,30,.8)) drop-shadow(0 3px 8px rgba(91,63,38,.4))} }
    .oni-cook-pot-img.bouncing { animation:oni-cook-pot-bounce .7s ease; }
    .oni-cook-pot-img.idling  { animation:oni-cook-pot-idle 2.4s ease-in-out infinite; }
    .oni-cook-anticipating .oni-cook-pot-img.idling { animation:oni-cook-pot-idle 2.4s ease-in-out infinite, oni-cook-anticipate 1.3s ease infinite; }

    /* ── Commit area (Into the Pot button, shown by picker — inside center-area) ── */
    .oni-cook-commit-area { position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:4;white-space:nowrap; }
    .oni-cook-commit-btn { padding:5px 20px;background:linear-gradient(180deg,#4caf50,#2e7d32);color:#fff;font-size:11.5px;font-weight:700;border:2px solid #2e7d32;border-radius:6px;cursor:pointer;letter-spacing:.03em;transition:filter .12s,transform .1s;box-shadow:0 2px 7px rgba(0,0,0,.22); }
    .oni-cook-commit-btn:hover:not(:disabled) { filter:brightness(1.1);transform:translateY(-1px); }
    .oni-cook-commit-btn:disabled { opacity:.32;cursor:default;pointer-events:none; }

    /* ── Taste label hotspots & tooltip ── */
    .oni-cook-lhs { position:absolute;width:44px;height:18px;transform:translate(-50%,-50%);z-index:4;cursor:default; }
    .oni-cook-taste-tip { position:fixed;z-index:99999;pointer-events:none;background:rgba(255,252,248,.97);border:1.5px solid rgba(91,63,38,.5);border-radius:8px;padding:7px 11px;max-width:200px;font-size:11px;color:#2a1200;line-height:1.55;box-shadow:0 5px 18px rgba(0,0,0,.35); }

    /* ── Drag & drop ── */
    .oni-cook-ing-slot.oni-cook-drop-hover { border-style:solid!important;border-color:#4caf50!important;background:rgba(76,175,80,.18)!important;box-shadow:0 0 8px rgba(76,175,80,.4); }
    .oni-cook-picker-slot[draggable="true"] { cursor:grab; }
    .oni-cook-picker-slot[draggable="true"]:active { cursor:grabbing; }

    /* ── Panel enter / exit animations ── */
    @keyframes oni-cook-bg-in    { from{opacity:0}                                             to{opacity:1} }
    @keyframes oni-cook-bg-out   { from{opacity:1}                                             to{opacity:0} }
    @keyframes oni-cook-panel-in { from{opacity:0;transform:translateX(40px) scale(.96)}       to{opacity:1;transform:none} }
    @keyframes oni-cook-panel-out{ from{opacity:1;transform:none}                              to{opacity:0;transform:translateX(40px) scale(.96)} }
    #oni-cook-main                   { animation:oni-cook-bg-in .22s ease both; }
    .oni-cook-main-panel             { animation:oni-cook-panel-in .32s cubic-bezier(.22,.61,.36,1) both; }
    #oni-cook-main.oni-cook-exit     { animation:oni-cook-bg-out .24s ease both;pointer-events:none; }
    #oni-cook-main.oni-cook-exit .oni-cook-main-panel { animation:oni-cook-panel-out .22s ease-in both; }

    /* ── Picker enter / exit animations ── */
    @keyframes oni-cook-picker-in  { from{opacity:0;transform:translateX(-22px)} to{opacity:1;transform:none} }
    @keyframes oni-cook-picker-out { from{opacity:1;transform:none}              to{opacity:0;transform:translateX(-22px)} }
    #oni-cook-picker                      { animation:oni-cook-picker-in  .26s cubic-bezier(.22,.61,.36,1) both; }
    #oni-cook-picker.oni-cook-picker-exit { animation:oni-cook-picker-out .18s ease-in both; pointer-events:none; }

    /* ── Status bar ── */
    .oni-cook-status-bar { padding:5px 14px;background:rgba(0,0,0,.07);border-top:1px solid rgba(91,63,38,.2);font-size:11px;color:#7a5000;text-align:center;font-style:italic; }

    /* ── Results overlay ── */
    .oni-cook-results-overlay { position:absolute;inset:0;z-index:10;background:rgba(20,10,5,.95);border-radius:14px;display:flex;align-items:center;justify-content:center; }
    @keyframes oni-cook-burst { 0%{transform:scale(.3) rotate(-4deg);opacity:0} 55%{transform:scale(1.12) rotate(2deg);opacity:1} 100%{transform:scale(1) rotate(0);opacity:1} }
    @keyframes oni-cook-flash { 0%,100%{background:rgba(20,10,5,.95)} 18%{background:rgba(184,153,64,.25)} 38%{background:rgba(20,10,5,.95)} }
    .oni-cook-results-overlay.bursting { animation:oni-cook-flash .7s ease; }
    .oni-cook-results-inner { display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px;text-align:center; }
    .oni-cook-results-inner.burst-in { animation:oni-cook-burst .75s cubic-bezier(.34,1.56,.64,1) both; }
    .oni-cook-results-img { width:96px;height:96px;object-fit:contain;border:none!important;filter:drop-shadow(0 0 20px rgba(220,180,50,.8)); }
    .oni-cook-results-kind { font-size:12px;color:#d4a844;font-style:italic; }
    .oni-cook-results-name { font-size:22px;font-weight:900;color:#ffd700;text-shadow:0 0 22px rgba(255,215,0,.5),0 2px 4px rgba(0,0,0,.9);letter-spacing:.05em; }
    .oni-cook-results-check { font-size:12px;color:#c8a864;font-style:italic; }
    .oni-cook-results-effect { font-size:11.5px;color:#e8d8a0;max-width:340px;line-height:1.65;background:rgba(255,255,255,.07);border:1px solid rgba(220,180,50,.25);border-radius:6px;padding:7px 12px;text-align:left; }

    .oni-cook-proceed-btn { margin-top:8px;padding:10px 30px;background:linear-gradient(180deg,#4caf50,#2e7d32);color:#fff;font-size:14px;font-weight:800;border:2px solid #2e7d32;border-radius:8px;cursor:pointer;letter-spacing:.04em;transition:filter .12s,transform .1s;box-shadow:0 4px 12px rgba(0,0,0,.3); }
    .oni-cook-proceed-btn:hover { filter:brightness(1.12);transform:translateY(-1px); }

    /* ── Flying ingredient ── */
    .oni-cook-fly-ing { pointer-events:none!important;z-index:9999!important;border:none!important;border-radius:8px;box-shadow:0 2px 12px rgba(91,63,38,.5); }

    /* ── Layout wrapper (picker + main panel side by side) ── */
    .oni-cook-layout { display:flex; flex-direction:row; align-items:flex-start; gap:12px; }
    #oni-cook-picker-slot { display:flex; align-items:stretch; }

    /* ── Picker panel ── */
    #oni-cook-picker {
      position:fixed; bottom:20px; right:20px; z-index:1650;
      background:linear-gradient(180deg,#f6ebd3 0%,#eddecb 55%,#e4d0b5 100%);
      border:2.5px solid rgba(91,63,38,.9);
      border-radius:14px;
      box-shadow:0 8px 28px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,248,232,.7);
      color:#3b2a19; width:300px;
      display:flex; flex-direction:column; overflow:hidden;
      max-height:calc(100vh - 40px);
    }
    #oni-cook-picker.oni-cook-picker--docked {
      position:relative; bottom:auto; right:auto; z-index:auto;
      max-height:min(560px, calc(100vh - 80px));
    }
    .oni-cook-picker-header {
      padding:8px 14px 6px;
      background:linear-gradient(180deg,#e8d5a3,#dfc890);
      border-bottom:2px solid rgba(184,153,64,.5);
      font-size:11.5px; color:#5a3800; text-align:center; font-weight:600;
    }
    .oni-cook-picker-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:10px;overflow-y:auto;flex:1; }
    .oni-cook-picker-grid::-webkit-scrollbar { width:5px; }
    .oni-cook-picker-grid::-webkit-scrollbar-track { background:rgba(0,0,0,.06); }
    .oni-cook-picker-grid::-webkit-scrollbar-thumb { background:rgba(91,63,38,.35);border-radius:3px; }
    .oni-cook-picker-slot { position:relative;aspect-ratio:1;border-radius:9px;border:2px solid rgba(91,63,38,.25);background:rgba(255,255,255,.5);cursor:pointer;transition:border-color .12s,background .12s,transform .08s;display:flex;align-items:center;justify-content:center;overflow:hidden; }
    .oni-cook-picker-slot:hover { border-color:rgba(184,153,64,.8);background:rgba(255,220,100,.15);transform:translateY(-2px);box-shadow:0 3px 8px rgba(0,0,0,.15); }
    .oni-cook-picker-slot.selected { border-color:#2e7d32;background:rgba(46,125,50,.15);box-shadow:0 0 0 1px rgba(46,125,50,.4) inset; }
    .oni-cook-picker-slot img { width:46px;height:46px;object-fit:contain;border:none!important;pointer-events:none; }
    .oni-cook-slot-qty { position:absolute;bottom:2px;right:3px;font-size:9px;font-weight:900;color:#fff;background:rgba(59,42,25,.7);border-radius:999px;padding:0 4px;min-width:14px;text-align:center;pointer-events:none; }
    .oni-cook-slot-check { position:absolute;top:2px;left:3px;font-size:10px;display:none;pointer-events:none; }
    .oni-cook-picker-slot.selected .oni-cook-slot-check { display:block; }
    .oni-cook-picker-empty { padding:12px 16px 4px;text-align:center;font-style:italic;color:#8a6840;font-size:12px; }
    /* Skip slot in picker grid */
    .oni-cook-skip-slot { border-style:dashed!important;border-color:rgba(91,63,38,.3)!important;background:rgba(0,0,0,.04)!important;flex-direction:column!important;gap:2px; }
    .oni-cook-skip-slot:hover { border-color:rgba(160,50,50,.55)!important;background:rgba(200,50,50,.06)!important;transform:translateY(-2px);box-shadow:0 3px 8px rgba(0,0,0,.1)!important; }
    .oni-cook-skip-slot.selected { border-color:rgba(180,60,60,.8)!important;background:rgba(200,50,50,.14)!important;box-shadow:0 0 0 1px rgba(180,60,60,.4) inset!important; }
    .oni-cook-skip-icon { font-size:17px;color:rgba(91,63,38,.35);line-height:1;pointer-events:none; }
    .oni-cook-skip-slot:hover .oni-cook-skip-icon,.oni-cook-skip-slot.selected .oni-cook-skip-icon { color:rgba(180,60,60,.8); }
    .oni-cook-skip-label { font-size:9px;color:rgba(91,63,38,.5);font-weight:700;pointer-events:none; }
    .oni-cook-skip-slot.selected .oni-cook-skip-label { color:rgba(160,50,50,.9); }

    /* Tooltip — white/light so it stands out against parchment UI */
    .oni-cook-tooltip { position:fixed;z-index:99999;pointer-events:none;background:rgba(255,252,248,.97);border:1.5px solid rgba(91,63,38,.5);border-radius:8px;padding:7px 11px;max-width:200px;font-size:11px;color:#2a1200;line-height:1.55;box-shadow:0 5px 18px rgba(0,0,0,.35); }
    .oni-cook-tt-name { font-weight:800;color:#3d1a00;margin-bottom:3px;font-size:12px; }
    .oni-cook-tt-desc { color:#5a3000;font-style:italic;opacity:.9; }
  `;

  // ── CookingMainPanel (DOM-based) ───────────────────────────────────────────
  class CookingMainPanel {
    constructor(sessionId, entries, cookerActorId) {
      this.sessionId = sessionId;
      this.entries = entries;
      this.cookerActorId = cookerActorId;
      this._el = null;
      this._slots = {};
      this._hover = {};
      this._tastes = Object.fromEntries(TASTES.map(t => [t, 0]));
      this._displayedTv = Object.fromEntries(TASTES.map(t => [t, 0]));
      this._chartAnimId = null;
    }

    get rendered() { return !!this._el && document.body.contains(this._el); }

    render() {
      document.getElementById("oni-cook-main")?.remove();
      const el = document.createElement("div");
      el.id = "oni-cook-main";
      el.innerHTML = this._buildHTML();
      document.body.appendChild(el);
      this._el = el;
      this._bindEvents();
    }

    _cornerHTML(e, pos) {
      if (!e) return `<div class="oni-cook-corner-area ${pos}"></div>`;
      return `<div class="oni-cook-corner-area ${pos}">
        <div class="oni-cook-corner" data-actor-id="${e.actorId}">
          <img class="oni-cook-portrait" src="${e.portraitUrl || 'icons/svg/mystery-man.svg'}">
          <div class="oni-cook-actor-name">${e.actorName}</div>
          <div class="oni-cook-ing-slot" data-actor-id="${e.actorId}">
            <img class="oni-cook-ing-img" src="" style="display:none">
          </div>
          <div class="oni-cook-ing-name"></div>
        </div>
      </div>`;
    }

    _labelHotspots() {
      const scale = 288 / 300;
      return Object.entries(TASTE_META).map(([t, m]) => {
        const rad = m.angle * Math.PI / 180;
        const svgX = _CHART_CX + _CHART_R * 1.25 * Math.cos(rad);
        const svgY = _CHART_CY - _CHART_R * 1.25 * Math.sin(rad);
        const left = `calc(50% + ${(svgX * scale - 144).toFixed(1)}px)`;
        const top  = `calc(50% + ${(svgY * scale - 144).toFixed(1)}px)`;
        return `<div class="oni-cook-lhs" data-taste="${t}" style="left:${left};top:${top};"></div>`;
      }).join("");
    }

    _buildHTML() {
      const POS = ["tl","tr","bl","br"];
      const corners = POS.map((pos,i) => this._cornerHTML(this.entries[i], pos)).join("");
      return `<div class="oni-cook-layout">
        <div id="oni-cook-picker-slot"></div>
        <div class="oni-cook-main-panel">
          <div class="oni-cook-panel-header">🍲 Party Hot-Pot</div>
          <div class="oni-cook-board">
            ${corners}
            <div class="oni-cook-center-area">
              ${_spiderSvg(this._tastes)}
              <img class="oni-cook-pot-img" src="https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/pht.png">
              ${this._labelHotspots()}
              <div class="oni-cook-commit-area" style="display:none">
                <button class="oni-cook-commit-btn" disabled>Into the Pot! 🍲</button>
              </div>
            </div>
          </div>
          <div class="oni-cook-status-bar">Waiting for everyone to choose an ingredient...</div>
          <div class="oni-cook-results-overlay" style="display:none">
            <div class="oni-cook-results-inner">
              <img class="oni-cook-results-img" src="icons/svg/item-bag.svg">
              <div class="oni-cook-results-kind"></div>
              <div class="oni-cook-results-name"></div>
              <div class="oni-cook-results-check" style="display:none"></div>
              <div class="oni-cook-results-effect" style="display:none"></div>
              <button class="oni-cook-proceed-btn" style="display:none">🍽️ Proceed</button>
            </div>
          </div>
        </div>
      </div>`;
    }

    _bindEvents() {
      this._el?.querySelector(".oni-cook-proceed-btn")?.addEventListener("click", () => {
        _sfx(SFX.EAT);
        game.socket?.emit(SOCKET_CH, { type:"COOKING_SFX", sfx:"EAT", sessionId:this.sessionId });
        game.socket?.emit(SOCKET_CH, { type:"COOKING_PROCEED", sessionId:this.sessionId, userId:game.user?.id });
        globalThis.FUCompanion?.api?.cooking?.proceed?.(this.sessionId);
        this.close();
      });

      // Taste label tooltips — via hotspot divs (.oni-cook-lhs) placed over each label
      this._tasteTip = document.createElement("div");
      this._tasteTip.className = "oni-cook-taste-tip";
      this._tasteTip.style.display = "none";
      document.body.appendChild(this._tasteTip);

      this._el.querySelectorAll(".oni-cook-lhs").forEach(hs => {
        const taste = hs.dataset.taste;
        const m = TASTE_META[taste];
        if (!m) return;
        hs.addEventListener("mouseenter", ev => {
          if (!this._tasteTip) return;
          this._tasteTip.innerHTML = `<div class="oni-cook-tt-name" style="color:${m.color}">${m.label}</div><div class="oni-cook-tt-desc">${m.tip}</div>`;
          this._tasteTip.style.display = "";
          this._tasteTip.style.left = `${ev.clientX + 14}px`;
          this._tasteTip.style.top  = `${ev.clientY - 8}px`;
        });
        hs.addEventListener("mousemove", ev => {
          if (this._tasteTip && this._tasteTip.style.display !== "none") {
            this._tasteTip.style.left = `${ev.clientX + 14}px`;
            this._tasteTip.style.top  = `${ev.clientY - 8}px`;
          }
        });
        hs.addEventListener("mouseleave", () => {
          if (this._tasteTip) this._tasteTip.style.display = "none";
        });
      });
    }

    _slotEl(actorId) { return this._el?.querySelector(`.oni-cook-ing-slot[data-actor-id="${actorId}"]`); }

    _repaintSlot(actorId) {
      if (!this.rendered) return;
      const slot = this._slotEl(actorId);
      if (!slot) return;
      const locked = this._slots[actorId];
      const hover  = locked?.locked ? null : this._hover[actorId]; // locked state takes priority
      const active = locked?.locked ? locked : hover;
      const img = slot.querySelector(".oni-cook-ing-img");
      if (active?.itemImg) { img.src = active.itemImg; img.style.display = ""; }
      else { img.style.display = "none"; }
      slot.classList.toggle("preview", !locked?.locked && !!hover?.itemImg);
      slot.classList.toggle("locked",  !!locked?.locked);
      const nameEl = slot.closest(".oni-cook-corner")?.querySelector(".oni-cook-ing-name");
      if (nameEl) {
        const active = locked?.locked ? locked : hover;
        if (active?.itemName) {
          nameEl.textContent = locked?.locked ? `✓ ${active.itemName}` : active.itemName;
          nameEl.className = `oni-cook-ing-name ${locked?.locked ? "locked" : "preview"}`;
        } else {
          nameEl.textContent = "";
          nameEl.className = "oni-cook-ing-name";
        }
      }
    }

    setHover(actorId, itemImg, itemName, itemTaste, itemTaste2) {
      if (this._slots[actorId]?.locked) return;
      this._hover[actorId] = itemImg ? { itemImg, itemName } : null;
      this._repaintSlot(actorId);
      // Live chart preview: show what the taste profile would look like with this ingredient added
      if (itemImg) {
        const hypo = { ...this._tastes };
        if (itemTaste  && TASTES.includes(itemTaste))  hypo[itemTaste]  = (hypo[itemTaste]  || 0) + 2;
        if (itemTaste2 && TASTES.includes(itemTaste2)) hypo[itemTaste2] = (hypo[itemTaste2] || 0) + 1;
        this._renderChart(hypo);
      } else {
        this._renderChart(this._tastes);
      }
    }

    _renderChart(tv) {
      if (!this.rendered) return;
      const svgEl = this._el?.querySelector(".oni-cook-chart");
      if (!svgEl) return;
      // Cancel any in-progress animation
      if (this._chartAnimId) { cancelAnimationFrame(this._chartAnimId); this._chartAnimId = null; }
      const from = { ...this._displayedTv };
      const to   = tv;
      const same = TASTES.every(t => Math.abs((from[t]||0) - (to[t]||0)) < 0.001);
      if (same) return;
      const start = performance.now(), dur = 320;
      const step = (now) => {
        if (!this.rendered) return;
        const p = Math.min(1, (now - start) / dur);
        const e = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
        const interp = {};
        for (const t of TASTES) interp[t] = (from[t]||0) + ((to[t]||0) - (from[t]||0)) * e;
        _updateChartDOM(svgEl, interp);
        this._displayedTv = interp;
        if (p < 1) { this._chartAnimId = requestAnimationFrame(step); }
        else { this._chartAnimId = null; this._displayedTv = { ...to }; }
      };
      this._chartAnimId = requestAnimationFrame(step);
    }

    setSlot(actorId, itemImg, itemName, locked) {
      this._slots[actorId] = { itemImg: itemImg || null, itemName: itemName || null, locked };
      this._hover[actorId] = null;
      this._repaintSlot(actorId);
      this._refreshStatus();
    }

    setTastes(tv) {
      this._tastes = tv;
      this._renderChart(tv);
    }

    _refreshStatus() {
      const n = Object.values(this._slots).filter(s => s.locked).length;
      const t = this.entries.length;
      const bar = this._el?.querySelector(".oni-cook-status-bar");
      if (bar) bar.textContent = n >= t ? "🍲 All ingredients in! Preparing the pot..." : `Waiting... (${n}/${t} ready)`;
    }

    async runAnimation(contributions) {
      if (!this.rendered) return;
      const statusBar = this._el.querySelector(".oni-cook-status-bar");
      if (statusBar) statusBar.textContent = "🍲 Into the pot...";
      const potEl = this._el.querySelector(".oni-cook-pot-img");
      if (!potEl) return;

      for (const c of contributions) {
        if (!this.rendered) break;
        _sfx(SFX.THROW);
        const pRect = potEl.getBoundingClientRect();
        const pCX = pRect.left + pRect.width / 2, pCY = pRect.top + pRect.height / 2;
        const sEl = this._el.querySelector(`.oni-cook-ing-slot[data-actor-id="${c.actorId}"]`);
        if (sEl) {
          const sRect = sEl.getBoundingClientRect();
          const fly = document.createElement("img");
          fly.src = c.itemImg || "icons/svg/item-bag.svg";
          fly.className = "oni-cook-fly-ing";
          Object.assign(fly.style, {
            position:"fixed", width:"52px", height:"52px", objectFit:"contain",
            left:`${sRect.left+sRect.width/2-26}px`, top:`${sRect.top+sRect.height/2-26}px`,
            zIndex:"9999",
            transition:"left .85s cubic-bezier(.3,0,.15,1.4),top .85s cubic-bezier(.3,0,.15,1.4),opacity .25s .72s,transform .85s"
          });
          document.body.appendChild(fly);
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          fly.style.left = `${pCX-26}px`; fly.style.top = `${pCY-26}px`;
          fly.style.opacity = "0"; fly.style.transform = "scale(0.15) rotate(180deg)";
          await new Promise(r => setTimeout(r, 900));
          fly.remove();
          _sfx(SFX.ABSORB);
          sEl.querySelector(".oni-cook-ing-img").style.display = "none";
          // Pot bounce on each landing
          potEl.classList.remove("bouncing");
          void potEl.offsetWidth; // force reflow to restart animation
          potEl.classList.add("bouncing");
          setTimeout(() => potEl.classList.remove("bouncing"), 750);
        }
        // Gap before next throw
        await new Promise(r => setTimeout(r, 650));
      }

      // Pot starts idling while waiting for group check result
      potEl.classList.add("idling");
      this._el.querySelector(".oni-cook-main-panel")?.classList.add("oni-cook-anticipating");
    }

    showResults(outcome, isCookerHere) {
      if (!this.rendered) return;
      _sfx(SFX.RESULTS);
      const overlay = this._el.querySelector(".oni-cook-results-overlay");
      if (!overlay) return;
      overlay.classList.add("bursting");
      setTimeout(() => overlay.classList.remove("bursting"), 750);

      overlay.querySelector(".oni-cook-results-img").src = outcome.dishImg || "icons/svg/item-bag.svg";
      overlay.querySelector(".oni-cook-results-kind").innerHTML = outcome.kindLabel || "";
      overlay.querySelector(".oni-cook-results-name").textContent = outcome.dishName || "???";

      const checkEl = overlay.querySelector(".oni-cook-results-check");
      if (checkEl) {
        const c = outcome.cookerCheck;
        if (c) {
          checkEl.textContent = c.isCrit ? `🎲 Check: ${c.total} — Critical!` : c.isFumble ? `🎲 Check: ${c.total} — Fumble!` : `🎲 Check: ${c.total}`;
          checkEl.style.display = "";
        } else {
          checkEl.style.display = "none";
        }
      }

      const effectEl = overlay.querySelector(".oni-cook-results-effect");
      if (effectEl) {
        effectEl.textContent = outcome.dishEffect || "";
        effectEl.style.display = outcome.dishEffect ? "" : "none";
      }

      const proceedBtn = overlay.querySelector(".oni-cook-proceed-btn");
      if (isCookerHere && proceedBtn) proceedBtn.style.display = "";
      overlay.querySelector(".oni-cook-results-inner")?.classList.add("burst-in");
      this._el.querySelector(".oni-cook-main-panel")?.classList.remove("oni-cook-anticipating");
      this._el.querySelector(".oni-cook-pot-img")?.classList.remove("idling");
      overlay.style.display = "";
    }

    close() {
      if (this._chartAnimId) { cancelAnimationFrame(this._chartAnimId); this._chartAnimId = null; }
      this._tasteTip?.remove(); this._tasteTip = null;
      const el = this._el; this._el = null;
      if (el) { el.classList.add("oni-cook-exit"); setTimeout(() => el.remove(), 260); }
    }
  }

  // ── CookingPickerPanel (DOM-based) ─────────────────────────────────────────
  class CookingPickerPanel {
    constructor(sessionId, actorId, choices, onSubmit, actorName = null) {
      this.sessionId = sessionId;
      this.actorId   = actorId;
      this.actorName = actorName;
      this.choices   = choices;
      this._selected = null;
      this._onSubmit = onSubmit;
      this._el = null;
      this._tip = null;
    }

    get rendered() { return !!this._el && document.body.contains(this._el); }

    render() {
      document.getElementById("oni-cook-picker")?.remove();
      document.querySelectorAll(".oni-cook-tooltip").forEach(t => t.remove());
      const el = document.createElement("div");
      el.id = "oni-cook-picker";
      el.innerHTML = this._buildHTML();
      const anchor = document.getElementById("oni-cook-picker-slot");
      if (anchor) {
        el.classList.add("oni-cook-picker--docked");
        anchor.appendChild(el);
      } else {
        document.body.appendChild(el);
      }
      this._el = el;
      this._tip = document.createElement("div");
      this._tip.className = "oni-cook-tooltip";
      this._tip.style.display = "none";
      document.body.appendChild(this._tip);

      // Wire main-panel commit button
      const commitArea = document.querySelector(".oni-cook-commit-area");
      const commitBtn  = document.querySelector(".oni-cook-commit-btn");
      if (commitArea) commitArea.style.display = "";
      if (commitBtn) {
        this._onCommit = () => { _sfx(SFX.CONFIRM); this._submit(this._selected === "__skip__" ? null : this._selected); };
        commitBtn.addEventListener("click", this._onCommit);
      }
      // Pre-select skip in empty state
      if (!this.choices.length) {
        this._selected = "__skip__";
        if (commitBtn) commitBtn.disabled = false;
      } else {
        if (commitBtn) commitBtn.disabled = true;
      }

      // Drag & drop: actor's slot and pot image accept drops
      const actorSlot = document.querySelector(`.oni-cook-ing-slot[data-actor-id="${this.actorId}"]`);
      const potImg    = document.querySelector(".oni-cook-pot-img");
      this._onDragOver  = ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; };
      this._onDrop      = ev => { ev.preventDefault(); const id = ev.dataTransfer.getData("text/plain"); if (id) { _sfx(SFX.CONFIRM); this._submit(id); } };
      this._onDragEnter = () => actorSlot?.classList.add("oni-cook-drop-hover");
      this._onDragLeave = () => actorSlot?.classList.remove("oni-cook-drop-hover");
      [actorSlot, potImg].forEach(t => { if (!t) return; t.addEventListener("dragover", this._onDragOver); t.addEventListener("drop", this._onDrop); });
      if (actorSlot) { actorSlot.addEventListener("dragenter", this._onDragEnter); actorSlot.addEventListener("dragleave", this._onDragLeave); }

      this._bindEvents();
    }

    _skipSlotHTML(selected = false) {
      return `<div class="oni-cook-picker-slot oni-cook-skip-slot${selected ? " selected" : ""}" data-id="__skip__"><span class="oni-cook-skip-icon">✕</span><span class="oni-cook-skip-label">Skip</span></div>`;
    }

    _buildHTML() {
      const header = `<div class="oni-cook-picker-header">🥘 ${this.actorName ? `Picking for <b>${this.actorName}</b>` : "Choose Your Ingredient"}</div>`;
      if (!this.choices.length) {
        return `${header}<div class="oni-cook-picker-empty">No materials to contribute.</div>
          <div class="oni-cook-picker-grid">${this._skipSlotHTML(true)}</div>`;
      }
      const slots = this.choices.map(c => `
        <div class="oni-cook-picker-slot" draggable="true" data-id="${c.id}" data-img="${c.img||''}" data-name="${c.name}" data-taste="${c.taste||''}" data-taste2="${c.taste2||''}" data-desc="${(c.description||'').replace(/"/g,'&quot;')}">
          <img src="${c.img||'icons/svg/item-bag.svg'}">
          <span class="oni-cook-slot-qty">${c.qty}</span>
          <span class="oni-cook-slot-check">✓</span>
        </div>`).join("");
      return `${header}<div class="oni-cook-picker-grid">${slots}${this._skipSlotHTML()}</div>`;
    }

    _updateCommitBtn() {
      const btn = document.querySelector(".oni-cook-commit-btn");
      if (btn) btn.disabled = !this._selected;
    }

    _bindEvents() {
      const el = this._el;
      if (!el) return;

      el.querySelectorAll(".oni-cook-picker-slot").forEach(slot => {
        const isSkip = slot.classList.contains("oni-cook-skip-slot");

        slot.addEventListener("mouseenter", ev => {
          const s = ev.currentTarget;
          if (isSkip) {
            this._tip.innerHTML = `<div class="oni-cook-tt-name" style="color:#8a2020">Skip</div><div class="oni-cook-tt-desc">Contribute nothing to the pot</div>`;
            this._tip.style.display = "";
            // Clear hover preview if we're not showing a selected ingredient
            if (this._selected && this._selected !== "__skip__") return; // keep selected preview
            game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:null, itemName:null, itemTaste:null, itemTaste2:null });
            globalThis.CookingUI?._applyHover(this.actorId, null, null, null, null);
            return;
          }
          const taste = s.dataset.taste, taste2 = s.dataset.taste2 || null;
          const desc = s.dataset.desc || "";
          this._tip.innerHTML = `<div class="oni-cook-tt-name">${s.dataset.name}</div>${desc ? `<div class="oni-cook-tt-desc">${desc}</div>` : ""}`;
          this._tip.style.display = "";
          const now = Date.now();
          if (now - _hoverSfxTs > 100) { _sfx(SFX.HOVER); _hoverSfxTs = now; }
          if (this._selected !== s.dataset.id) {
            const img = s.dataset.img, name = s.dataset.name;
            game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:img, itemName:name, itemTaste:taste||null, itemTaste2:taste2 });
            globalThis.CookingUI?._applyHover(this.actorId, img, name, taste||null, taste2);
          }
        });

        slot.addEventListener("mousemove", ev => {
          if (this._tip) { this._tip.style.left=`${ev.clientX+14}px`; this._tip.style.top=`${ev.clientY-8}px`; }
        });

        slot.addEventListener("mouseleave", () => {
          if (this._tip) this._tip.style.display = "none";
          // Revert to selected ingredient preview (or clear if skip/none selected)
          if (this._selected && this._selected !== "__skip__") {
            const selSlot = el.querySelector(`.oni-cook-picker-slot[data-id="${this._selected}"]`);
            if (selSlot) {
              const img = selSlot.dataset.img, name = selSlot.dataset.name;
              const t = selSlot.dataset.taste||null, t2 = selSlot.dataset.taste2||null;
              game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:img, itemName:name, itemTaste:t, itemTaste2:t2 });
              globalThis.CookingUI?._applyHover(this.actorId, img, name, t, t2);
              return;
            }
          }
          game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:null, itemName:null, itemTaste:null, itemTaste2:null });
          globalThis.CookingUI?._applyHover(this.actorId, null, null, null, null);
        });

        if (!isSkip) {
          slot.addEventListener("dragstart", ev => {
            ev.dataTransfer.setData("text/plain", slot.dataset.id);
            ev.dataTransfer.effectAllowed = "copy";
          });
        }

        slot.addEventListener("click", ev => {
          const s = ev.currentTarget;
          const id = s.dataset.id;
          if (this._selected === id) {
            // Deselect
            _sfx(SFX.SELECT);
            this._selected = null;
            el.querySelectorAll(".oni-cook-picker-slot").forEach(e => e.classList.remove("selected"));
            this._updateCommitBtn();
            game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:null, itemName:null, itemTaste:null, itemTaste2:null });
            globalThis.CookingUI?._applyHover(this.actorId, null, null, null, null);
          } else {
            _sfx(SFX.HOVER);
            this._selected = id;
            el.querySelectorAll(".oni-cook-picker-slot").forEach(e => e.classList.remove("selected"));
            s.classList.add("selected");
            this._updateCommitBtn();
            if (isSkip) {
              // Skip selected — clear preview
              game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:null, itemName:null, itemTaste:null, itemTaste2:null });
              globalThis.CookingUI?._applyHover(this.actorId, null, null, null, null);
            } else {
              const img = s.dataset.img, name = s.dataset.name;
              const t = s.dataset.taste||null, t2 = s.dataset.taste2||null;
              game.socket?.emit(SOCKET_CH, { type:"COOKING_HOVER", sessionId:this.sessionId, actorId:this.actorId, itemImg:img, itemName:name, itemTaste:t, itemTaste2:t2, isSelect:true });
              globalThis.CookingUI?._applyHover(this.actorId, img, name, t, t2, true);
            }
          }
        });
      });
    }

    _submit(itemId) {
      const cb = this._onSubmit;
      this.close();
      cb?.(itemId);
    }

    _cleanup() {
      this._tip?.remove(); this._tip = null;
      // Unwire and hide commit button
      const commitBtn = document.querySelector(".oni-cook-commit-btn");
      if (commitBtn && this._onCommit) { commitBtn.removeEventListener("click", this._onCommit); this._onCommit = null; }
      const commitArea = document.querySelector(".oni-cook-commit-area");
      if (commitArea) commitArea.style.display = "none";
      // Unwire drag & drop
      const actorSlot = document.querySelector(`.oni-cook-ing-slot[data-actor-id="${this.actorId}"]`);
      const potImg    = document.querySelector(".oni-cook-pot-img");
      [actorSlot, potImg].forEach(t => { if (!t) return; t.removeEventListener("dragover", this._onDragOver); t.removeEventListener("drop", this._onDrop); });
      if (actorSlot) { actorSlot.removeEventListener("dragenter", this._onDragEnter); actorSlot.removeEventListener("dragleave", this._onDragLeave); actorSlot.classList.remove("oni-cook-drop-hover"); }
      this._onDragOver = null; this._onDrop = null; this._onDragEnter = null; this._onDragLeave = null;
    }
    close() {
      this._cleanup();
      const el = this._el; this._el = null;
      if (el) { el.classList.add("oni-cook-picker-exit"); setTimeout(() => el.remove(), 200); }
    }
  }

  // ── Manager singleton ──────────────────────────────────────────────────────
  let _main = null;

  const CookingUI = {
    _applyHover(actorId, itemImg, itemName, itemTaste, itemTaste2, isSelect = false) {
      if (isSelect && itemImg) _sfx(SFX.HOVER);
      _main?.setHover(actorId, itemImg||null, itemName||null, itemTaste||null, itemTaste2||null);
    },

    playSfx(key) {
      if (SFX[key]) _sfx(SFX[key]);
    },

    openMainPanel(sessionId, entries, cookerActorId) {
      _main?.close();
      _main = new CookingMainPanel(sessionId, entries, cookerActorId);
      _main.render();
      _sfx(SFX.OPEN);
      return _main;
    },

    openPicker(sessionId, actorId, choices, actorName = null) {
      return new Promise(resolve => {
        new CookingPickerPanel(sessionId, actorId, choices, resolve, actorName).render();
      });
    },

    applyState(sessionId, slots, tasteValues) {
      if (!_main?.rendered || _main.sessionId !== sessionId) return;
      for (const [id, s] of Object.entries(slots ?? {})) {
        _main.setSlot(id, s.itemImg || null, s.itemName || null, !!s.locked);
      }
      if (tasteValues) _main.setTastes(tasteValues);
    },

    async runAnimation(sessionId, contributions) {
      if (!_main?.rendered || _main.sessionId !== sessionId) return;
      await _main.runAnimation(contributions);
    },

    showResults(sessionId, outcome) {
      if (!_main?.rendered || _main.sessionId !== sessionId) return;
      const cooker = game.actors?.get(_main.cookerActorId);
      const isMine = cooker && (game.user?.isGM || cooker.isOwner);
      _main.showResults(outcome, isMine);
    },

    closeAll() {
      _main?.close(); _main = null;
      document.getElementById("oni-cook-picker")?.remove();
      document.querySelectorAll(".oni-cook-tooltip").forEach(t => t.remove());
      document.querySelector(".oni-cook-commit-area")?.style.setProperty("display", "none");
      document.querySelectorAll(".oni-cook-taste-tip").forEach(t => t.remove());
    },
    getMain() { return _main; },
  };

  globalThis.CookingUI = CookingUI;

  Hooks.once("ready", () => {
    const el = document.createElement("style");
    el.id = "oni-cook-styles";
    el.textContent = COOK_CSS;
    document.head.appendChild(el);
    console.debug(TAG, "Cooking UI loaded.");
  });
})();
