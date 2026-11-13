// ============================================================================
// Cooking System — UI Layer (DOM overlay, no Application windows)  — v2
// CookingMainPanel  : the shared hot-pot panel (every client)
// CookingPickerPanel: per-player ingredient picker, docked left of the panel
// globalThis.CookingUI : manager singleton (called by cooking-api.js)
//
// v2 adds: flavor-wheel chart (scale starts at the pot rim), flavor pips
// (pop-in run → left-to-right fuse / bounce / muddle / perfect harmony),
// recipe + taste wheels (host decides, clients replay), Yaminabe (cook-only,
// one-way switch + confirm, ink-blot transition, app-style dark theme,
// hidden picks), cookbook overlay, richer result card, tuned SFX.
// ============================================================================
(() => {
  const GUARD = "__ONI_COOKING_UI__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const TAG = "[FUCompanion][CookingUI]";
  const F = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";

  // ── SFX ────────────────────────────────────────────────────────────────────
  // Volumes: the dish reveal is the loudest reward; pip events stay soft (bond-summary sound family).
  const SFX = {
    OPEN:    [F + "Sound/bond_create.wav", .45],
    HOVER:   [F + "Sound/Success_1.wav", .3],
    SELECT:  [F + "Sound/cooking_ingredient_selected.wav", .4],
    CONFIRM: [F + "Sound/check_ready.wav", .45],
    THROW:   [F + "Sound/Soundboard/Fall.ogg", .4],
    ABSORB:  [F + "Sound/bond_create.wav", .4],
    START:   [F + "Sound/cooking_begin.mp3", .5],
    RESULTS: [F + "Sound/bond_level_3.wav", .8],
    EAT:     [F + "Sound/Eating.mp3", .5],
    TICK:    [F + "Sound/BattleCursor_2.wav", .3],
    SAD:     [F + "Sound/emotion_down.wav", .45],
    CLASH:   [F + "Sound/Soundboard/Parry.ogg", .35],
    PRISM:   [F + "Sound/bond_level_2.wav", .6],
    FAIL:    [F + "Sound/failed_1.wav", .6],
    GOOP:    [F + "Sound/Soundboard/Disappointment.ogg", .6],
    COMBO1:  [F + "Sound/Success_1.wav", .3],
    COMBO2:  [F + "Sound/success2.ogg", .42],
    COMBO3:  [F + "Sound/Fabula_Point.ogg", .55],
    SPOOK:   [F + "Sound/Spook.mp3", .22],
  };
  let _hoverSfxTs = 0;
  const _sfxCache = {};
  function _ifaceVol() { try { return Number(game.settings.get("core", "globalInterfaceVolume")) || 0.5; } catch { return 0.5; } }
  function _sfx(key, { vol = null, rate = 1 } = {}) {
    const s = SFX[key]; if (!s) return;
    try {
      const a = (_sfxCache[key] ??= new Audio(s[0]));
      const c = a.cloneNode();
      c.volume = Math.max(0, Math.min(1, (vol ?? s[1]) * _ifaceVol() * 1.6));
      if (rate !== 1) { c.preservesPitch = false; c.playbackRate = rate; }
      c.play().catch(() => {});
    } catch (e) {}
  }
  const COMBO = [["COMBO1", .3, 1], ["COMBO2", .42, 1.06], ["COMBO3", .55, 1.12]];
  const _comboSfx = n => { const [k, v, r] = COMBO[Math.min(n, COMBO.length) - 1]; _sfx(k, { vol: v, rate: r }); };

  // ── Tastes (flavor wheel order: neighbours harmonize, across the chart clash) ──
  const TASTES = ["bitter", "sweet", "sour", "salty", "umami"];
  const TASTE_META = {
    bitter: { label: "Bitter", color: "#3a7a3a", angle: 90,   tip: "Wit: +1 to checks, then Max IP at higher tiers" },
    sweet:  { label: "Sweet",  color: "#b03060", angle: 18,   tip: "Spirit: Max MP (+10 / +20 / +30)" },
    sour:   { label: "Sour",   color: "#c07020", angle: -54,  tip: "Offense: bonus damage (+1 / +3 / +5)" },
    salty:  { label: "Salty",  color: "#2a5fa8", angle: -126, tip: "Guard: Shield when you eat (10 / 20 / 30)" },
    umami:  { label: "Umami",  color: "#7040b0", angle: 162,  tip: "Vitality: Max HP (+10 / +20 / +30)" },
  };
  const STYLE_LABEL = { sea: "Sea", meat: "Meat", monster: "Monster", garden: "Garden", pantry: "Pantry", arcane: "Arcane" };
  const LINK = 2, MUDDLED_AT = 4;
  const rel = (a, b) => { if (a === b) return "same"; const d = Math.abs(TASTES.indexOf(a) - TASTES.indexOf(b)); return d === 1 || d === 4 ? "harm" : "clash"; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const wait = ms => new Promise(r => setTimeout(r, reduceMotion() ? Math.min(ms, 60) : ms));
  const sgn = v => (v >= 0 ? "+" : "−") + Math.abs(v);

  // ── Spider chart (scale starts at the pot rim so the first ingredient shows past the pot) ──
  const _CHART_R = 108, _CHART_CX = 150, _CHART_CY = 150, _R0 = 40, CHART_PX = 320, LIFT = 14;
  function _chartPt(t, frac) {
    const rad = TASTE_META[t].angle * Math.PI / 180, d = _R0 + frac * (_CHART_R - _R0);
    return { x: _CHART_CX + d * Math.cos(rad), y: _CHART_CY - d * Math.sin(rad) };
  }
  function _spiderSvg() {
    let g = "";
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const pts = TASTES.map(t => { const p = _chartPt(t, f); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ");
      g += `<polygon class="grid" points="${pts}" fill="none" stroke="rgba(91,63,38,${f === 1 ? 0.22 : 0.09})" stroke-width="${f === 1 ? 0.8 : 0.45}"/>`;
    }
    g += `<circle class="grid" cx="${_CHART_CX}" cy="${_CHART_CY}" r="${_R0}" fill="none" stroke="rgba(91,63,38,.16)" stroke-width=".6" stroke-dasharray="2 3"/>`;
    for (const t of TASTES) { const p = _chartPt(t, 1), q = _chartPt(t, 0); g += `<line class="grid" x1="${q.x.toFixed(1)}" y1="${q.y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="rgba(91,63,38,0.13)" stroke-width="0.55"/>`; }
    g += `<polygon class="oni-cook-data-poly" points="" fill="rgba(184,153,64,0.22)" stroke="rgba(141,100,20,0.7)" stroke-width="1.4" stroke-linejoin="round" style="display:none"/>`;
    g += `<g class="oni-cook-data-dots">${TASTES.map(t => `<circle data-taste="${t}" r="4" fill="${TASTE_META[t].color}" stroke="rgba(255,255,255,0.6)" stroke-width="1.2" style="display:none"/>`).join("")}</g>`;
    for (const t of TASTES) { const p = _chartPt(t, 1.25); g += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${TASTE_META[t].color}" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#f6ebd3" stroke-width="2.5">${TASTE_META[t].label}</text>`; }
    return `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" class="oni-cook-chart">${g}</svg>`;
  }
  function _updateChartDOM(svgEl, tv) {
    const vals = TASTES.map(t => Math.min(1, (Number(tv?.[t] ?? 0)) / 8));
    const has = vals.some(v => v > 0.001);
    const poly = svgEl.querySelector(".oni-cook-data-poly");
    if (poly) { poly.setAttribute("points", TASTES.map((t, i) => { const p = _chartPt(t, vals[i]); return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; }).join(" ")); poly.style.display = has ? "" : "none"; }
    TASTES.forEach((t, i) => {
      const dot = svgEl.querySelector(`circle[data-taste="${t}"]`); if (!dot) return;
      if (vals[i] > 0.001) { const p = _chartPt(t, vals[i]); dot.setAttribute("cx", p.x.toFixed(2)); dot.setAttribute("cy", p.y.toFixed(2)); dot.style.display = ""; }
      else dot.style.display = "none";
    });
  }
  function _blend(tv) {
    const tot = TASTES.reduce((s, t) => s + (tv?.[t] || 0), 0); if (!tot) return null;
    let r = 0, g = 0, b = 0;
    for (const t of TASTES) { const w = (tv[t] || 0) / tot, c = TASTE_META[t].color; r += w * parseInt(c.slice(1, 3), 16); g += w * parseInt(c.slice(3, 5), 16); b += w * parseInt(c.slice(5, 7), 16); }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  const COOK_CSS = `
    #oni-cook-main{position:fixed;inset:0;z-index:1600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);pointer-events:auto}
    .oni-cook-main-panel{position:relative;background:linear-gradient(180deg,#f6ebd3 0%,#eddecb 55%,#e4d0b5 100%);border:2.5px solid rgba(91,63,38,.9);border-radius:16px;box-shadow:0 12px 36px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,248,232,.7);color:#3b2a19;width:680px;max-width:95vw;display:flex;flex-direction:column;overflow:hidden}
    .oni-cook-panel-header{position:relative;padding:9px 16px;text-align:center;background:linear-gradient(180deg,#e8d5a3,#dfc890);border-bottom:2px solid rgba(184,153,64,.55);font-size:15px;font-weight:900;color:#5a3800;letter-spacing:.06em}
    .oni-cook-board{display:grid;grid-template-areas:"tl center tr" "bl center br";grid-template-columns:160px 1fr 160px;grid-template-rows:175px 175px;gap:8px;padding:10px;position:relative}
    .oni-cook-corner-area.tl{grid-area:tl}.oni-cook-corner-area.tr{grid-area:tr}.oni-cook-corner-area.bl{grid-area:bl}.oni-cook-corner-area.br{grid-area:br}
    .oni-cook-center-area{grid-area:center;display:flex;align-items:center;justify-content:center;position:relative}
    .oni-cook-corner{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px;border-radius:12px;height:100%;box-sizing:border-box;background:rgba(255,255,255,.35);border:1.5px solid rgba(91,63,38,.2);position:relative;z-index:3;transition:background .3s,box-shadow .2s}
    .oni-cook-corner.lit{z-index:4;background:rgba(255,245,220,.92);box-shadow:0 0 18px rgba(255,200,90,.7)}
    .oni-cook-corner .cooker-tag{position:absolute;top:6px;right:6px;font-size:8.5px;font-weight:900;background:#5a3800;color:#f6ebd3;border-radius:999px;padding:0 6px;letter-spacing:.04em}
    .oni-cook-portrait{width:52px;height:52px;border-radius:50%;object-fit:cover;object-position:top;border:2px solid rgba(91,63,38,.35);flex-shrink:0}
    .oni-cook-actor-name{font-size:11px;color:#5a3800;text-align:center;font-weight:700;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;line-height:1.3}
    .oni-cook-ing-slot{width:60px;height:60px;border:2px dashed rgba(91,63,38,.3);border-radius:9px;display:flex;align-items:center;justify-content:center;transition:border-color .2s,background .2s;background:rgba(255,255,255,.3);flex-shrink:0;font-size:22px;font-weight:900;color:rgba(91,63,38,.45)}
    .oni-cook-ing-slot.preview{border-color:rgba(184,153,64,.75);background:rgba(255,200,50,.1)}
    .oni-cook-ing-slot.locked{border-style:solid;border-color:#2e7d32;background:rgba(46,125,50,.12)}
    .oni-cook-ing-slot.secret{border-style:solid;border-color:#5a3800;background:rgba(59,42,25,.18)}
    .oni-cook-ing-img{width:50px;height:50px;object-fit:contain;border:none!important}
    .oni-cook-ing-img.silhouette{filter:brightness(0) opacity(.55)}
    .oni-cook-ing-name{font-size:9.5px;font-weight:700;text-align:center;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:4px;line-height:1.4;min-height:1.4em}
    .oni-cook-ing-name.preview{color:#5a3800}.oni-cook-ing-name.locked{color:#1b6b1f}
    .oni-cook-chart{width:${CHART_PX}px;height:${CHART_PX}px;position:absolute;top:calc(50% - ${LIFT}px);left:50%;transform:translate(-50%,-50%);pointer-events:none;opacity:.95;transition:opacity .4s}
    .oni-cook-pot-img{width:68px;height:68px;object-fit:contain;position:relative;top:-${LIFT}px;z-index:2;filter:drop-shadow(0 3px 8px rgba(91,63,38,.4));transition:transform .3s;border:none!important}
    @keyframes oni-cook-pot-bounce{0%,100%{transform:translateY(0) scale(1)}30%{transform:translateY(-10px) scale(1.06)}60%{transform:translateY(2px) scale(.96)}80%{transform:translateY(-4px) scale(1.02)}}
    @keyframes oni-cook-pot-idle{0%,100%{transform:translateY(0) rotate(0deg)}35%{transform:translateY(-4px) rotate(-1.2deg)}65%{transform:translateY(-3px) rotate(0.8deg)}}
    @keyframes oni-cook-anticipate{0%,100%{filter:drop-shadow(0 3px 8px rgba(91,63,38,.4))}50%{filter:drop-shadow(0 0 20px rgba(200,160,30,.8)) drop-shadow(0 3px 8px rgba(91,63,38,.4))}}
    @keyframes oni-cook-pot-hello{0%,100%{transform:translateY(0) scale(1)}15%{transform:translateY(-6px) scale(1.04,.97)}30%{transform:translateY(0) scale(.97,1.03)}48%{transform:translateY(-4px) scale(1.02,.98)}64%{transform:translateY(0) scale(.99,1.01)}80%{transform:translateY(-1.5px)}}
    .oni-cook-pot-img.bouncing{animation:oni-cook-pot-bounce .7s ease}
    .oni-cook-pot-img.idling{animation:oni-cook-pot-idle 2.4s ease-in-out infinite}
    .oni-cook-pot-img.hello{animation:oni-cook-pot-hello 1.2s ease-in-out}
    .oni-cook-anticipating .oni-cook-pot-img.idling{animation:oni-cook-pot-idle 2.4s ease-in-out infinite,oni-cook-anticipate 1.3s ease infinite}
    .oni-cook-glow{position:absolute;top:calc(50% - ${LIFT}px);left:50%;width:110px;height:110px;transform:translate(-50%,-50%);border-radius:50%;z-index:1;opacity:0;transition:opacity .6s,background .6s;filter:blur(20px);pointer-events:none}
    .oni-cook-steam{position:absolute;top:calc(50% - ${70 + LIFT}px);left:50%;width:80px;height:60px;transform:translateX(-50%);pointer-events:none;z-index:3}
    .oni-cook-steam i{position:absolute;bottom:0;width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,.9);filter:blur(4px);opacity:0}
    .oni-cook-steam.on i{animation:oni-cook-steam 1.6s infinite ease-out}
    .oni-cook-steam i:nth-child(1){left:14px}.oni-cook-steam i:nth-child(2){left:34px;animation-delay:.5s}.oni-cook-steam i:nth-child(3){left:52px;animation-delay:1s}
    @keyframes oni-cook-steam{0%{transform:translateY(0) scale(.6);opacity:0}25%{opacity:.85}100%{transform:translateY(-50px) scale(2);opacity:0}}
    .oni-cook-dark{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:0;transition:opacity .7s;background:radial-gradient(circle at 50% 50%,rgba(255,160,60,.22) 0,rgba(15,8,3,.88) 38%)}
    .oni-cook-main-panel.lights-out .oni-cook-dark{opacity:1}
    .oni-cook-commit-area{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:4;white-space:nowrap}
    .oni-cook-commit-btn{padding:5px 20px;background:linear-gradient(180deg,#4caf50,#2e7d32);color:#fff;font-size:11.5px;font-weight:700;border:2px solid #2e7d32;border-radius:6px;cursor:pointer;letter-spacing:.03em;transition:filter .12s,transform .1s;box-shadow:0 2px 7px rgba(0,0,0,.22)}
    .oni-cook-commit-btn:hover:not(:disabled){filter:brightness(1.1);transform:translateY(-1px)}
    .oni-cook-commit-btn:disabled{opacity:.32;cursor:default;pointer-events:none}
    .oni-cook-harmony{position:absolute;top:calc(50% + 30px);left:50%;transform:translateX(-50%);z-index:4;font-size:10px;font-weight:800;white-space:nowrap;padding:1px 8px;border-radius:999px;background:rgba(255,250,235,.85);border:1px solid rgba(91,63,38,.25)}
    .oni-cook-harmony:empty{display:none}
    .oni-cook-harmony.bad{background:#fde2de;border-color:#b23a2a;color:#9a2418}
    .oni-cook-lhs{position:absolute;width:44px;height:18px;transform:translate(-50%,-50%);z-index:4;cursor:help}
    .oni-cook-taste-tip,.oni-cook-tooltip{position:fixed;z-index:99999;pointer-events:none;background:rgba(255,252,248,.97);border:1.5px solid rgba(91,63,38,.5);border-radius:8px;padding:7px 11px;max-width:230px;font-size:11px;color:#2a1200;line-height:1.55;box-shadow:0 5px 18px rgba(0,0,0,.35)}
    .oni-cook-tt-name{font-weight:800;color:#3d1a00;margin-bottom:3px;font-size:12px}
    .oni-cook-tt-desc{color:#5a3000;font-style:italic;opacity:.9}
    .oni-cook-tt-meta{margin-top:4px;font-size:10.5px;font-weight:700}
    .oni-cook-ing-slot.oni-cook-drop-hover{border-style:solid!important;border-color:#4caf50!important;background:rgba(76,175,80,.18)!important;box-shadow:0 0 8px rgba(76,175,80,.4)}
    .oni-cook-picker-slot[draggable="true"]{cursor:grab}
    @keyframes oni-cook-bg-in{from{opacity:0}to{opacity:1}}
    @keyframes oni-cook-bg-out{from{opacity:1}to{opacity:0}}
    @keyframes oni-cook-panel-in{from{opacity:0;transform:translateX(40px) scale(.96)}to{opacity:1;transform:none}}
    @keyframes oni-cook-panel-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(40px) scale(.96)}}
    #oni-cook-main{animation:oni-cook-bg-in .22s ease both}
    .oni-cook-main-panel{animation:oni-cook-panel-in .32s cubic-bezier(.22,.61,.36,1) both}
    #oni-cook-main.oni-cook-exit{animation:oni-cook-bg-out .24s ease both;pointer-events:none}
    #oni-cook-main.oni-cook-exit .oni-cook-main-panel{animation:oni-cook-panel-out .22s ease-in both}
    @keyframes oni-cook-picker-in{from{opacity:0;transform:translateX(-22px)}to{opacity:1;transform:none}}
    @keyframes oni-cook-picker-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(-22px)}}
    #oni-cook-picker{animation:oni-cook-picker-in .26s cubic-bezier(.22,.61,.36,1) both}
    #oni-cook-picker.oni-cook-picker-exit{animation:oni-cook-picker-out .18s ease-in both;pointer-events:none}
    .oni-cook-status-bar{padding:5px 14px;background:rgba(0,0,0,.07);border-top:1px solid rgba(91,63,38,.2);font-size:11px;color:#7a5000;text-align:center;font-style:italic;min-height:1.5em;position:relative;z-index:3}
    .oni-cook-dice{display:inline-flex;gap:4px;vertical-align:middle;margin:0 2px}
    .oni-cook-dice b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:4px;background:#fff8e6;border:1px solid #8a6440;font-style:normal;color:#3d1a00;font-size:11px}
    /* results */
    .oni-cook-results-overlay{position:absolute;inset:0;z-index:10;background:rgba(20,10,5,.95);border-radius:14px;display:flex;align-items:center;justify-content:center}
    @keyframes oni-cook-burst{0%{transform:scale(.3) rotate(-4deg);opacity:0}55%{transform:scale(1.12) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
    @keyframes oni-cook-flash{0%,100%{background:rgba(20,10,5,.95)}18%{background:rgba(184,153,64,.25)}38%{background:rgba(20,10,5,.95)}}
    .oni-cook-results-overlay.bursting{animation:oni-cook-flash .7s ease}
    .oni-cook-results-inner{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 20px;text-align:center}
    .oni-cook-results-inner.burst-in{animation:oni-cook-burst .75s cubic-bezier(.34,1.56,.64,1) both}
    .oni-cook-results-img{width:96px;height:96px;object-fit:contain;border:none!important;filter:drop-shadow(0 0 20px rgba(220,180,50,.8))}
    .oni-cook-results-img.spoiled{filter:drop-shadow(0 0 16px rgba(160,40,40,.7)) saturate(.6)}
    .oni-cook-results-kind{font-size:12px;color:#d4a844;font-style:italic}
    .oni-cook-results-name{font-size:22px;font-weight:900;color:#ffd700;text-shadow:0 0 22px rgba(255,215,0,.5),0 2px 4px rgba(0,0,0,.9);letter-spacing:.05em}
    .oni-cook-results-name.spoiled{color:#c9a27a;text-shadow:none}
    .oni-cook-results-tier{font-size:13px;color:#ffd700;letter-spacing:.2em}
    .oni-cook-results-tier.spoiled{color:#e57373;letter-spacing:.08em;font-weight:900}
    .oni-cook-results-tier.dark{color:#d1a6ff;text-shadow:0 0 12px rgba(180,120,255,.8)}
    .oni-cook-results-new{font-size:10.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#1b1206;background:#ffd700;border-radius:999px;padding:2px 10px}
    .oni-cook-results-who{display:flex;gap:10px;justify-content:center}
    .oni-cook-who{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:9.5px;color:#e8d8a0;width:72px}
    .oni-cook-who img{width:38px;height:38px;object-fit:contain;border-radius:8px;background:rgba(255,255,255,.06);padding:2px;border:none!important}
    .oni-cook-who .w-name{font-weight:800;color:#c8a864}
    .oni-cook-who.feat img{box-shadow:0 0 0 2px #ffd700,0 0 10px rgba(255,215,0,.6)}
    .oni-cook-who.feat .w-item{color:#ffd700;font-weight:800}
    .oni-cook-results-check{font-size:12px;color:#c8a864;font-style:italic}
    .oni-cook-results-effect{font-size:11.5px;color:#e8d8a0;max-width:380px;line-height:1.65;background:rgba(255,255,255,.07);border:1px solid rgba(220,180,50,.25);border-radius:6px;padding:7px 12px;text-align:left}
    .oni-cook-results-effect small{display:block;color:#b8a070;font-size:10.5px;margin-top:2px}
    .oni-cook-results-hint{font-size:11px;color:#a5d6a7;font-style:italic;max-width:380px}
    .oni-cook-proceed-btn{margin-top:4px;padding:10px 30px;background:linear-gradient(180deg,#4caf50,#2e7d32);color:#fff;font-size:14px;font-weight:800;border:2px solid #2e7d32;border-radius:8px;cursor:pointer;letter-spacing:.04em;transition:filter .12s,transform .1s;box-shadow:0 4px 12px rgba(0,0,0,.3)}
    .oni-cook-proceed-btn:hover{filter:brightness(1.12);transform:translateY(-1px)}
    .oni-cook-fly-ing{position:fixed;width:52px;height:52px;object-fit:contain;pointer-events:none!important;z-index:9999!important;border:none!important;border-radius:8px}
    /* layout + picker */
    .oni-cook-layout{display:flex;flex-direction:row;align-items:flex-start;gap:12px}
    #oni-cook-picker-slot{display:flex;align-items:stretch}
    #oni-cook-picker{position:fixed;bottom:20px;right:20px;z-index:1650;background:linear-gradient(180deg,#f6ebd3 0%,#eddecb 55%,#e4d0b5 100%);border:2.5px solid rgba(91,63,38,.9);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,248,232,.7);color:#3b2a19;width:300px;display:flex;flex-direction:column;overflow:hidden;max-height:calc(100vh - 40px)}
    #oni-cook-picker.oni-cook-picker--docked{position:relative;bottom:auto;right:auto;z-index:auto;max-height:min(560px,calc(100vh - 80px))}
    .oni-cook-picker-header{padding:8px 14px 6px;background:linear-gradient(180deg,#e8d5a3,#dfc890);border-bottom:2px solid rgba(184,153,64,.5);font-size:11.5px;color:#5a3800;text-align:center;font-weight:600}
    .oni-cook-picker-filter{display:flex;gap:4px;flex-wrap:wrap;padding:7px 10px 0}
    .oni-cook-picker-filter button{font:700 10px inherit;line-height:1.5;border:1px solid rgba(91,63,38,.3);background:rgba(255,255,255,.5);color:#5a3800;border-radius:999px;padding:0 8px;cursor:pointer;width:auto;flex:0 0 auto}
    .oni-cook-picker-filter button.on{background:#5a3800;color:#f6ebd3}
    .oni-cook-picker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:10px;overflow-y:auto;flex:1}
    .oni-cook-picker-grid::-webkit-scrollbar{width:5px}
    .oni-cook-picker-grid::-webkit-scrollbar-thumb{background:rgba(91,63,38,.35);border-radius:3px}
    .oni-cook-picker-slot{position:relative;aspect-ratio:1;border-radius:9px;border:2px solid rgba(91,63,38,.25);background:rgba(255,255,255,.5);cursor:pointer;transition:border-color .12s,background .12s,transform .08s;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .oni-cook-picker-slot:hover{border-color:rgba(184,153,64,.8);background:rgba(255,220,100,.15);transform:translateY(-2px);box-shadow:0 3px 8px rgba(0,0,0,.15)}
    .oni-cook-picker-slot.selected{border-color:#2e7d32;background:rgba(46,125,50,.15);box-shadow:0 0 0 1px rgba(46,125,50,.4) inset}
    .oni-cook-picker-slot img{width:46px;height:46px;object-fit:contain;border:none!important;pointer-events:none}
    .oni-cook-slot-qty{position:absolute;bottom:2px;right:3px;font-size:9px;font-weight:900;color:#fff;background:rgba(59,42,25,.7);border-radius:999px;padding:0 4px;min-width:14px;text-align:center;pointer-events:none}
    .oni-cook-slot-check{position:absolute;top:2px;left:3px;font-size:10px;display:none;pointer-events:none}
    .oni-cook-picker-slot.selected .oni-cook-slot-check{display:block}
    .oni-cook-slot-new{position:absolute;top:1px;right:3px;font-size:10px;color:#b8501f;font-weight:900;pointer-events:none}
    .oni-cook-taste-dot{position:absolute;top:4px;left:4px;width:7px;height:7px;border-radius:50%;pointer-events:none;box-shadow:0 0 0 1px rgba(255,255,255,.8)}
    .oni-cook-picker-slot.selected .oni-cook-taste-dot{display:none}
    .oni-cook-picker-foot{padding:6px 10px 9px;font-size:10.5px;color:#7a5000;font-style:italic;border-top:1px solid rgba(91,63,38,.15)}
    .oni-cook-picker-empty{padding:12px 16px 4px;text-align:center;font-style:italic;color:#8a6840;font-size:12px}
    .oni-cook-skip-slot{border-style:dashed!important;border-color:rgba(91,63,38,.3)!important;background:rgba(0,0,0,.04)!important;flex-direction:column!important;gap:2px}
    .oni-cook-skip-slot:hover{border-color:rgba(160,50,50,.55)!important;background:rgba(200,50,50,.06)!important}
    .oni-cook-skip-slot.selected{border-color:rgba(180,60,60,.8)!important;background:rgba(200,50,50,.14)!important}
    .oni-cook-skip-icon{font-size:17px;color:rgba(91,63,38,.35);line-height:1;pointer-events:none}
    .oni-cook-skip-slot:hover .oni-cook-skip-icon,.oni-cook-skip-slot.selected .oni-cook-skip-icon{color:rgba(180,60,60,.8)}
    .oni-cook-skip-label{font-size:9px;color:rgba(91,63,38,.5);font-weight:700;pointer-events:none}
    /* header: cookbook + Yaminabe switch */
    .oni-cook-book-btn{position:absolute;left:8px;top:50%;transform:translateY(-50%);width:22px;height:22px;padding:0;line-height:1;border:none;background:transparent;font-size:14px;cursor:pointer;opacity:.6;transition:opacity .15s}
    .oni-cook-book-btn:hover{opacity:1}
    .oni-cook-mode-slot{position:absolute;right:8px;top:50%;transform:translateY(-50%)}
    .oni-cook-mode-pill{display:inline-block;font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:#5a3800;color:#f6ebd3}
    .oni-cook-yami-btn{font:800 10.5px inherit;letter-spacing:.03em;padding:2px 9px;border-radius:999px;border:1.5px solid #3a3a40;background:#26262a;color:#ececee;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25);width:auto;line-height:1.6}
    .oni-cook-yami-btn small{font-weight:700;opacity:.65;margin-left:3px}
    .oni-cook-yami-btn:hover:not(:disabled){filter:brightness(1.2)}
    .oni-cook-yami-btn:disabled{opacity:.35;cursor:not-allowed}
    /* pot "hello", ink, confirm */
    .oni-cook-ink{position:absolute;inset:0;width:100%;height:100%;z-index:11;pointer-events:none;transition:opacity .7s ease}
    .oni-cook-ink.fade{opacity:0}
    .oni-cook-confirm,.oni-cook-book{position:absolute;inset:0;z-index:12;display:grid;place-items:center;background:rgba(10,10,12,.72);border-radius:14px;animation:oni-cook-bg-in .3s ease}
    .oni-cook-confirm[hidden],.oni-cook-book[hidden]{display:none!important}
    .oni-cook-confirm-card{width:min(360px,86%);background:linear-gradient(180deg,#26262a,#1b1b1e);border:1.5px solid #3c3c42;border-radius:14px;padding:18px 20px 16px;color:#e6e6e8;text-align:center;box-shadow:0 14px 40px rgba(0,0,0,.6)}
    .yc-candle{font-size:26px;animation:yc-flicker 1.6s infinite}
    @keyframes yc-flicker{0%,100%{opacity:1;filter:drop-shadow(0 0 8px rgba(255,190,90,.8))}45%{opacity:.82;filter:drop-shadow(0 0 3px rgba(255,190,90,.5))}60%{opacity:.95}}
    .yc-title{font-weight:900;font-size:17px;letter-spacing:.04em;margin:4px 0 8px}
    .yc-body{font-size:12px;line-height:1.6;color:#c8c8cc;margin:0 0 6px}
    .yc-whisper{font-style:italic;color:#9a9aa0}
    .yc-rules{font-size:10.5px;color:#a6a6ac;background:rgba(255,255,255,.05);border-radius:8px;padding:6px 8px;margin:8px 0 12px;line-height:1.5}
    .yc-btns{display:flex;gap:8px;justify-content:center}
    .yc-btns button{font-weight:800;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;width:auto;line-height:1.4}
    .yc-no{background:transparent;border:1.5px solid #55555c;color:#d8d8dc}
    .yc-yes{background:#ececee;border:1.5px solid #ececee;color:#1b1b1e}
    /* cookbook overlay (minimal) */
    .oni-cook-book{background:rgba(20,12,6,.55)}
    .oni-cook-book-card{width:min(560px,92%);max-height:88%;overflow:auto;background:linear-gradient(180deg,#f6ebd3,#e9d8bc);border:2px solid rgba(91,63,38,.7);border-radius:12px;padding:10px 14px 12px;color:#3b2a19;font-size:11px}
    .ob-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
    .ob-head b{font-size:13px;color:#5a3800}
    .ob-head button{width:auto;line-height:1.2;padding:1px 8px;font-size:11px;border-radius:6px;border:1px solid rgba(91,63,38,.4);background:rgba(255,255,255,.5);cursor:pointer}
    .ob-grid{border-collapse:collapse;width:100%;margin-bottom:8px}
    .ob-grid th,.ob-grid td{padding:2px 4px;border-bottom:1px solid rgba(91,63,38,.12);text-align:left;font-size:10.5px}
    .ob-grid th{color:#7a5000;font-weight:800}
    .ob-grid td.miss{opacity:.4}
    .ob-sec{font-weight:800;color:#7a5000;margin:6px 0 3px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
    .ob-pills{display:flex;flex-wrap:wrap;gap:4px}
    .ob-pills span{padding:1px 7px;border-radius:999px;border:1px solid rgba(91,63,38,.25);display:inline-flex;gap:3px;align-items:center}
    .ob-pills span.got{background:#5a3800;color:#f6ebd3;border-color:#5a3800}
    .ob-pills span.hint{border-style:dashed;border-color:#b8501f}
    .ob-pills span.miss{opacity:.5}
    .ob-pills img{width:14px;height:14px;object-fit:contain;border:none!important}
    .ob-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
    /* flavor pips (cooking phase, where the commit button was; no box of its own) */
    .oni-cook-links{position:absolute;left:50%;bottom:6px;transform:translateX(-50%) translateY(6px);z-index:6;display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px 10px 5px;width:230px;opacity:0;transition:opacity .3s,transform .3s}
    .oni-cook-links.in{opacity:1;transform:translateX(-50%)}
    .lk-row{position:relative;width:100%;height:50px}
    .lk-pip{position:absolute;border-radius:50%;border:2px solid rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.3);display:grid;place-items:center;transition:left .4s cubic-bezier(.34,1.4,.64,1),top .4s,width .4s cubic-bezier(.34,1.4,.64,1),height .4s cubic-bezier(.34,1.4,.64,1),filter .6s}
    .lk-pip img{width:62%;height:62%;object-fit:contain;filter:drop-shadow(0 0 1.5px #fff);border:none!important}
    .lk-n{position:absolute;right:-5px;bottom:-4px;font-weight:900;font-size:9px;line-height:1;color:#fff;background:#5a3800;border-radius:999px;padding:2px 4px}
    .lk-pip.turn{top:calc(50% - 22px)!important;box-shadow:0 0 0 2px #ffd700,0 0 10px rgba(255,215,0,.7)}
    .lk-pip.fused{animation:lkfused .55s cubic-bezier(.34,1.56,.64,1)}
    @keyframes lkfused{0%{box-shadow:0 0 0 0 rgba(255,236,150,.9)}40%{transform:scale(1.22);box-shadow:0 0 0 7px rgba(255,236,150,.55),0 0 18px rgba(255,220,110,.9)}100%{transform:scale(1);box-shadow:0 1px 4px rgba(0,0,0,.3)}}
    .lk-pip.shake{animation:lkpipshake .16s infinite}
    @keyframes lkpipshake{0%,100%{translate:0 0}25%{translate:-2px 1px}75%{translate:2px -1px}}
    .lk-pip.muddy{filter:grayscale(.85) brightness(.7) sepia(.35);border-color:#8a7a68;box-shadow:0 0 10px 3px rgba(60,40,70,.55)}
    .lk-pip.prism{animation:lkprism 1.6s linear infinite;box-shadow:0 0 14px 4px rgba(255,255,255,.75)}
    .lk-pip.prism::before{content:"";position:absolute;inset:-7px;border-radius:50%;background:conic-gradient(#ff5f6d,#ffc371,#fff176,#69f0ae,#40c4ff,#b388ff,#ff5f6d);filter:blur(5px);opacity:.85;z-index:-1;animation:lkspin 1.6s linear infinite}
    @keyframes lkprism{0%,100%{filter:saturate(1.3) brightness(1.1)}50%{filter:saturate(1.6) brightness(1.3) hue-rotate(40deg)}}
    @keyframes lkspin{to{transform:rotate(360deg)}}
    .lk-spark{position:absolute;width:6px;height:6px;border-radius:50%;pointer-events:none;z-index:3}
    .lk-spark.wisp{width:9px;height:9px;filter:blur(2px);opacity:.8}
    .lk-badge{font-size:10.5px;font-weight:800;color:#5a3800;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;padding:1px 9px;border-radius:999px;background:rgba(91,63,38,.08)}
    .lk-badge.pop{animation:lkpop .35s cubic-bezier(.34,1.56,.64,1)}
    @keyframes lkpop{0%{transform:scale(.85);opacity:.4}100%{transform:none;opacity:1}}
    .lk-badge.good{background:#dff3e2;color:#1f6b33}
    .lk-badge.bad{background:#f7ddd8;color:#8e2418}
    .lk-badge.prism{background:linear-gradient(90deg,#ffe0e3,#fff5c9,#dcfbe9,#dbefff,#efe3ff);color:#5a3800}
    .lk-sum{margin-left:4px;padding:0 5px;border-radius:999px;background:#5a3800;color:#fff;font-size:9.5px}
    .lk-combo{color:#b8860b;font-weight:900;letter-spacing:.02em}
    /* wheel */
    .oni-cook-wheel{position:absolute;inset:-${LIFT}px 0 ${LIFT}px 0;z-index:7;pointer-events:none}
    .oni-cook-wseg{position:absolute;left:50%;top:50%;width:64px;display:flex;flex-direction:column;align-items:center;gap:1px;padding:4px 2px;border-radius:10px;background:rgba(255,250,235,.92);border:1.5px solid var(--seg,rgba(91,63,38,.35));box-shadow:0 2px 6px rgba(0,0,0,.2);transition:background .08s,box-shadow .08s}
    .oni-cook-wseg img{width:30px;height:30px;object-fit:contain;border:none!important}
    .oni-cook-wseg .g{display:grid;place-items:center;width:30px;height:30px;font-weight:900;font-size:20px;line-height:1;color:#5a3800}
    .oni-cook-wseg b{font-size:10px;line-height:1.1;color:#3d1a00;text-align:center}
    .oni-cook-wseg i{font-size:8.5px;font-style:normal;color:#7a5000;font-weight:800}
    .oni-cook-wseg.on{background:#fff3c4;box-shadow:0 0 0 2px #ffd700,0 0 14px rgba(255,215,0,.7)}
    .oni-cook-wseg.landed{background:#ffd700;box-shadow:0 0 0 3px #fff,0 0 24px rgba(255,215,0,.9);scale:1.18;transition:scale .25s cubic-bezier(.34,1.56,.64,1)}
    .oni-cook-wtitle{position:absolute;top:2px;left:50%;transform:translateX(-50%);font-size:10.5px;font-weight:900;letter-spacing:.06em;color:#5a3800;background:rgba(255,250,235,.9);border:1px solid rgba(91,63,38,.3);border-radius:999px;padding:1px 10px;white-space:nowrap}
    /* ===== Yaminabe = app-style dark mode (neutral greys, no purple) ===== */
    .oni-cook-main-panel,#oni-cook-picker,.oni-cook-panel-header,.oni-cook-corner,.oni-cook-status-bar,.oni-cook-picker-header{transition:background .45s,border-color .45s,color .45s}
    .oni-cook-yami .oni-cook-main-panel,.oni-cook-yami #oni-cook-picker,body.oni-cook-yami #oni-cook-picker{background:linear-gradient(180deg,#26262a 0%,#202023 60%,#1b1b1e 100%);border-color:#3c3c42;color:#e6e6e8;box-shadow:0 12px 36px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05)}
    body.oni-cook-yami .oni-cook-panel-header,body.oni-cook-yami .oni-cook-picker-header{background:linear-gradient(180deg,#303035,#2a2a2e);border-bottom-color:#3c3c42;color:#ececee}
    body.oni-cook-yami .oni-cook-mode-pill{background:#ececee;color:#1f1f22}
    body.oni-cook-yami .oni-cook-corner{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09)}
    body.oni-cook-yami .oni-cook-corner.lit{background:rgba(255,255,255,.14);box-shadow:0 0 18px rgba(255,220,140,.45)}
    body.oni-cook-yami .oni-cook-corner .cooker-tag{background:#ececee;color:#1f1f22}
    body.oni-cook-yami .oni-cook-portrait{border-color:rgba(255,255,255,.2)}
    body.oni-cook-yami .oni-cook-actor-name{color:#d8d8dc}
    body.oni-cook-yami .oni-cook-ing-slot{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.03);color:rgba(255,255,255,.4)}
    body.oni-cook-yami .oni-cook-ing-slot.secret{border-color:rgba(255,255,255,.35);background:rgba(0,0,0,.3)}
    body.oni-cook-yami .oni-cook-ing-slot.locked{border-color:#4caf50;background:rgba(76,175,80,.12)}
    body.oni-cook-yami .oni-cook-ing-img.silhouette{filter:brightness(0) invert(1) opacity(.35)}
    body.oni-cook-yami .oni-cook-ing-name.locked{color:#81c784}
    body.oni-cook-yami .oni-cook-ing-name.preview{color:#d8d8dc}
    body.oni-cook-yami .oni-cook-status-bar{background:rgba(0,0,0,.28);border-top-color:#3c3c42;color:#b4b4ba}
    body.oni-cook-yami .oni-cook-chart .grid{stroke:rgba(255,255,255,.16)}
    body.oni-cook-yami .oni-cook-chart .oni-cook-data-poly{fill:rgba(255,215,120,.14);stroke:rgba(255,215,120,.6)}
    body.oni-cook-yami .oni-cook-chart text{stroke:#222226;filter:brightness(1.45)}
    body.oni-cook-yami .oni-cook-harmony,body.oni-cook-yami .lk-badge{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);color:#d8d8dc}
    body.oni-cook-yami .lk-badge.good{background:rgba(76,175,80,.18);color:#a5d6a7}
    body.oni-cook-yami .lk-badge.bad{background:rgba(229,115,115,.16);color:#ef9a9a}
    body.oni-cook-yami .lk-badge.prism{background:linear-gradient(90deg,rgba(255,95,109,.22),rgba(255,195,113,.22),rgba(105,240,174,.22),rgba(64,196,255,.22),rgba(179,136,255,.22));color:#f2f2f4}
    body.oni-cook-yami .lk-sum{background:#ececee;color:#1f1f22}
    body.oni-cook-yami .lk-combo{color:#ffd54f}
    body.oni-cook-yami .oni-cook-wseg,body.oni-cook-yami .oni-cook-wtitle{background:rgba(44,44,48,.95);border-color:rgba(255,255,255,.18)}
    body.oni-cook-yami .oni-cook-wseg b,body.oni-cook-yami .oni-cook-wtitle{color:#ececee}
    body.oni-cook-yami .oni-cook-wseg i{color:#b4b4ba}
    body.oni-cook-yami .oni-cook-wseg .g{filter:brightness(1.35)}
    body.oni-cook-yami .oni-cook-wseg.on{background:#3a3626}
    body.oni-cook-yami .oni-cook-wseg.landed{background:#ffd700}
    body.oni-cook-yami .oni-cook-wseg.landed b,body.oni-cook-yami .oni-cook-wseg.landed i{color:#1f1f22}
    body.oni-cook-yami .oni-cook-picker-slot{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12)}
    body.oni-cook-yami .oni-cook-picker-slot:hover{background:rgba(255,215,0,.08);border-color:rgba(255,215,0,.6)}
    body.oni-cook-yami .oni-cook-picker-slot.selected{background:rgba(76,175,80,.16);border-color:#4caf50}
    body.oni-cook-yami .oni-cook-skip-slot{background:rgba(255,255,255,.02)!important;border-color:rgba(255,255,255,.2)!important}
    body.oni-cook-yami .oni-cook-skip-icon,body.oni-cook-yami .oni-cook-skip-label{color:rgba(255,255,255,.4)}
    body.oni-cook-yami .oni-cook-picker-filter button{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.15);color:#d8d8dc;filter:brightness(1.2)}
    body.oni-cook-yami .oni-cook-picker-filter button.on{background:#ececee;color:#1f1f22;filter:none}
    body.oni-cook-yami .oni-cook-picker-foot,body.oni-cook-yami .oni-cook-picker-empty{color:#a6a6ac;border-top-color:rgba(255,255,255,.08)}
    body.oni-cook-yami .oni-cook-tooltip,body.oni-cook-yami .oni-cook-taste-tip{background:rgba(40,40,44,.97);border-color:rgba(255,255,255,.18);color:#e6e6e8}
    body.oni-cook-yami .oni-cook-tt-name{color:#f2f2f4}
    body.oni-cook-yami .oni-cook-tt-desc{color:#b4b4ba}
    body.oni-cook-yami .oni-cook-dice b{background:#2c2c30;border-color:#55555c;color:#f2f2f4}
    body.oni-cook-yami .oni-cook-status-bar [style*="color"],body.oni-cook-yami .oni-cook-tt-meta [style*="color"]{filter:brightness(1.7) saturate(1.1)}
    body.oni-cook-yami .oni-cook-book-btn{filter:invert(1)}
  `;

  // ── CookingMainPanel ───────────────────────────────────────────────────────
  class CookingMainPanel {
    constructor(sessionId, entries, cookerActorId, opts = {}) {
      this.sessionId = sessionId;
      this.entries = entries;
      this.cookerActorId = cookerActorId;
      this.cookerUserId = opts.cookerUserId ?? null;
      this.mode = opts.mode ?? "open";
      this.view = opts.view ?? {};
      this._el = null;
      this._slots = {};
      this._hover = {};
      this._mine = {};                       // actorId → { itemImg, itemName } picked on THIS client
      this._tastes = Object.fromEntries(TASTES.map(t => [t, 0]));
      this._displayedTv = Object.fromEntries(TASTES.map(t => [t, 0]));
      this._chartAnimId = null;
      this.LK = null;
      this._inking = false;
    }
    get rendered() { return !!this._el && document.body.contains(this._el); }
    $(sel) { return this._el?.querySelector(sel); }

    render() {
      document.getElementById("oni-cook-main")?.remove();
      const el = document.createElement("div");
      el.id = "oni-cook-main";
      el.innerHTML = this._buildHTML();
      document.body.appendChild(el);
      this._el = el;
      document.body.classList.toggle("oni-cook-yami", this.mode === "dark");
      this._bindEvents();
      this._renderModeSlot();
      this._refreshStatus();
      this.potBobble();
    }

    _cornerHTML(e, pos) {
      if (!e) return `<div class="oni-cook-corner-area ${pos}"></div>`;
      return `<div class="oni-cook-corner-area ${pos}">
        <div class="oni-cook-corner" data-actor-id="${e.actorId}">
          ${e.actorId === this.cookerActorId ? `<span class="cooker-tag">COOK</span>` : ""}
          <img class="oni-cook-portrait" src="${e.portraitUrl || "icons/svg/mystery-man.svg"}">
          <div class="oni-cook-actor-name">${esc(e.actorName)}</div>
          <div class="oni-cook-ing-slot" data-actor-id="${e.actorId}"><img class="oni-cook-ing-img" src="" style="display:none"></div>
          <div class="oni-cook-ing-name"></div>
        </div></div>`;
    }
    _labelHotspots() {
      const sc = CHART_PX / 300, hf = CHART_PX / 2;
      return TASTES.map(t => {
        const p = _chartPt(t, 1.25);
        return `<div class="oni-cook-lhs" data-taste="${t}" style="left:calc(50% + ${(p.x * sc - hf).toFixed(1)}px);top:calc(50% + ${(p.y * sc - hf - LIFT).toFixed(1)}px)"></div>`;
      }).join("");
    }
    _buildHTML() {
      const POS = ["tl", "tr", "bl", "br"];
      const corners = POS.map((pos, i) => this._cornerHTML(this.entries[i], pos)).join("");
      return `<div class="oni-cook-layout">
        <div id="oni-cook-picker-slot"></div>
        <div class="oni-cook-main-panel">
          <div class="oni-cook-panel-header"><button class="oni-cook-book-btn" title="Cookbook">📖</button>🍲 Party Hot-Pot<span class="oni-cook-mode-slot"></span></div>
          <div class="oni-cook-board">
            <div class="oni-cook-dark"></div>
            ${corners}
            <div class="oni-cook-center-area">
              <div class="oni-cook-glow"></div>
              ${_spiderSvg()}
              <div class="oni-cook-steam"><i></i><i></i><i></i></div>
              <img class="oni-cook-pot-img" src="${F}Item%20Icon/pht.png">
              ${this._labelHotspots()}
              <div class="oni-cook-harmony"></div>
              <div class="oni-cook-commit-area" style="display:none"><button class="oni-cook-commit-btn" disabled>Into the Pot! 🍲</button></div>
            </div>
          </div>
          <div class="oni-cook-status-bar">Waiting for everyone to choose an ingredient...</div>
          <div class="oni-cook-results-overlay" style="display:none"></div>
          <div class="oni-cook-confirm" hidden>
            <div class="oni-cook-confirm-card" role="dialog" aria-modal="true">
              <div class="yc-candle">🕯️</div>
              <div class="yc-title">Turn off the lights?</div>
              <p class="yc-body">Once the lights go out, they stay out. Nobody will see what anyone throws in, and nobody can promise what crawls back out of the pot.</p>
              <p class="yc-body yc-whisper">Your friends trust you. Perhaps they shouldn't.</p>
              <p class="yc-rules">Yaminabe: +2 potency · picks are secret · four tastes spoil the pot.<br>This can't be undone for this pot.</p>
              <div class="yc-btns"><button class="yc-no">Keep the lights on</button><button class="yc-yes">Lights out</button></div>
            </div>
          </div>
          <div class="oni-cook-book" hidden><div class="oni-cook-book-card"></div></div>
        </div>
      </div>`;
    }

    _bindEvents() {
      // taste label tooltips (correct effects + friends/foes)
      this._tasteTip = document.createElement("div");
      this._tasteTip.className = "oni-cook-taste-tip";
      this._tasteTip.style.display = "none";
      document.body.appendChild(this._tasteTip);
      this._el.querySelectorAll(".oni-cook-lhs").forEach(hs => {
        const me = hs.dataset.taste, m = TASTE_META[me];
        const friends = TASTES.filter(t => rel(me, t) === "harm").map(t => TASTE_META[t].label);
        const foes = TASTES.filter(t => rel(me, t) === "clash").map(t => TASTE_META[t].label);
        const move = ev => { this._tasteTip.style.left = `${ev.clientX + 14}px`; this._tasteTip.style.top = `${ev.clientY - 8}px`; };
        hs.addEventListener("mouseenter", ev => {
          this._tasteTip.innerHTML = `<div class="oni-cook-tt-name" style="color:${m.color}">${m.label}</div><div class="oni-cook-tt-desc">${m.tip}</div>
            <div class="oni-cook-tt-meta"><span style="color:#2e7d32">Harmonizes with ${friends.join(" and ")}</span> (neighbours)<br><span style="color:#b23a2a">Clashes with ${foes.join(" and ")}</span> (across the chart)</div>`;
          this._tasteTip.style.display = ""; move(ev);
        });
        hs.addEventListener("mousemove", move);
        hs.addEventListener("mouseleave", () => { this._tasteTip.style.display = "none"; });
      });
      // Yaminabe confirm + cookbook
      this.$(".yc-no")?.addEventListener("click", () => { this.$(".oni-cook-confirm").hidden = true; _sfx("TICK", { vol: .35 }); });
      this.$(".yc-yes")?.addEventListener("click", () => {
        this.$(".oni-cook-confirm").hidden = true;
        globalThis.FUCompanion?.api?.cooking?.requestYaminabe?.(this.sessionId);
      });
      this.$(".oni-cook-book-btn")?.addEventListener("click", () => this.toggleCookbook());
      this.$(".oni-cook-book")?.addEventListener("click", ev => { if (ev.target.classList.contains("oni-cook-book")) this.toggleCookbook(false); });
    }

    // ── mode ──
    _canSwitch() {
      if (this.mode === "dark" || this._busy) return false;
      return Object.values(this._slots).every(s => !s.locked);
    }
    _isCook() { return game.user?.isGM || (this.cookerUserId && game.user?.id === this.cookerUserId) || !!game.actors?.get(this.cookerActorId)?.isOwner; }
    _renderModeSlot() {
      const el = this.$(".oni-cook-mode-slot"); if (!el) return;
      if (this.mode === "dark") { el.innerHTML = `<span class="oni-cook-mode-pill">🌑 Yaminabe</span>`; return; }
      if (!this._isCook()) { el.innerHTML = ""; return; }
      const can = this._canSwitch();
      el.innerHTML = `<button class="oni-cook-yami-btn" ${can ? "" : "disabled"} title="${can ? "Only the cook can do this" : "Too late: someone already locked in an ingredient"}">🌑 Yaminabe <small>cook only</small></button>`;
      el.querySelector("button").addEventListener("click", () => {
        if (!this._canSwitch()) return;
        this.$(".oni-cook-confirm").hidden = false; _sfx("OPEN", { vol: .3 });
        this.$(".yc-no")?.focus();
      });
    }
    async setMode(mode, { animate = false, byName = null } = {}) {
      if (this.mode === mode) return;
      if (mode === "dark" && animate && !reduceMotion()) {
        this._inking = true; this._hover = {};
        _sfx("SPOOK");
        this._status(`${esc(byName ?? "The cook")} is turning off the lights…`);
        await this._inkSpread(() => { this.mode = mode; document.body.classList.add("oni-cook-yami"); this._afterModeChange(); });
        this._inking = false;
      } else {
        this.mode = mode; document.body.classList.toggle("oni-cook-yami", mode === "dark"); this._afterModeChange();
        if (mode === "dark") _sfx("SPOOK");
      }
      this.potBobble();
      if (mode === "dark") this._status(`${esc(byName ?? "The cook")} turned off the lights. Choose in secret…`);
      setTimeout(() => this._refreshStatus(), 2200);
    }
    _afterModeChange() {
      this._hover = {};
      Object.keys(this._slots).forEach(id => this._repaintSlot(id));
      this.entries.forEach(e => this._repaintSlot(e.actorId));
      this._renderModeSlot();
      this._renderChart(this.mode === "dark" ? {} : this._tastes);
      this._renderPreviewBadge();
      globalThis.CookingUI?._picker?.refreshModeLabel?.();
    }
    _inkSpread(onCovered) {
      return new Promise(resolve => {
        const panel = this.$(".oni-cook-main-panel"), po = this.$(".oni-cook-pot-img");
        if (!panel || !po) { onCovered?.(); return resolve(); }
        const pr = panel.getBoundingClientRect(), pp = po.getBoundingClientRect();
        const W = pr.width, H = pr.height, cx = pp.left + pp.width / 2 - pr.left, cy = pp.top + pp.height / 2 - pr.top;
        const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.12;
        const NS = "http://www.w3.org/2000/svg", seed = Math.floor(Math.random() * 999), fid = "oni-ink-" + seed;
        const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "oni-cook-ink"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.innerHTML = `<defs><filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency=".022" numOctaves="3" seed="${seed}" result="n"/>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="46" xChannelSelector="R" yChannelSelector="G"/></filter></defs>
          <g filter="url(#${fid})" fill="#1d1d20"></g>`;
        panel.appendChild(svg);
        const g = svg.querySelector("g"), turb = svg.querySelector("feTurbulence");
        const mk = (x, y) => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 0); g.appendChild(c); return c; };
        const main = mk(cx, cy);
        const sats = Array.from({ length: 7 }, (_, i) => { const a = i / 7 * Math.PI * 2 + Math.random() * .6, d = R * (.35 + Math.random() * .4);
          return { c: mk(cx + Math.cos(a) * d, cy + Math.sin(a) * d * .7), start: .18 + Math.random() * .35, size: R * (.16 + Math.random() * .14) }; });
        const dur = 1700, t0 = performance.now(); let covered = false;
        const ease = p => 1 - Math.pow(1 - p, 2.2);
        const step = now => {
          const p = Math.min(1, (now - t0) / dur);
          main.setAttribute("r", (R * ease(p)).toFixed(1));
          for (const s of sats) { const q = Math.max(0, Math.min(1, (p - s.start) / (1 - s.start))); s.c.setAttribute("r", (s.size * ease(q) * (1 + p * .6)).toFixed(1)); }
          turb.setAttribute("baseFrequency", (.022 + Math.sin(now / 260) * .003).toFixed(4));
          if (!covered && p > .9) { covered = true; onCovered?.(); }
          if (p < 1) requestAnimationFrame(step);
          else { svg.classList.add("fade"); setTimeout(() => { svg.remove(); resolve(); }, 700); }
        };
        requestAnimationFrame(step);
      });
    }
    potBobble() {
      const p = this.$(".oni-cook-pot-img"); if (!p) return;
      p.classList.remove("hello"); void p.offsetWidth; p.classList.add("hello");
      setTimeout(() => p.classList.remove("hello"), 1300);
    }

    // ── cookbook ──
    setView(view) { if (view) this.view = { ...this.view, ...view }; if (!this.$(".oni-cook-book")?.hidden) this._renderCookbook(); }
    toggleCookbook(force) {
      const box = this.$(".oni-cook-book"); if (!box) return;
      const show = force ?? box.hidden;
      if (show) this._renderCookbook();
      box.hidden = !show;
      _sfx("TICK", { vol: .3 });
    }
    _renderCookbook() {
      const card = this.$(".oni-cook-book-card"); const cb = this.view?.cookbook;
      if (!card) return;
      if (!cb) { card.innerHTML = `<div class="ob-head"><b>📖 Cookbook</b><button class="ob-close">Close</button></div><div>No entries yet.</div>`; card.querySelector(".ob-close").onclick = () => this.toggleCookbook(false); return; }
      const styles = cb.matrix?.[0]?.styles ?? [];
      const grid = `<table class="ob-grid"><thead><tr><th></th>${styles.map(s => `<th>${esc(s.label)}</th>`).join("")}</tr></thead><tbody>
        ${cb.matrix.map(r => `<tr><th><span class="ob-dot" style="background:${TASTE_META[r.taste]?.color}"></span>${esc(r.label)}</th>${r.styles.map(s => `<td class="${s.got ? "" : "miss"}">${s.got ? `${esc(r.adj)} ${esc(s.noun)}` : "???"}</td>`).join("")}</tr>`).join("")}
      </tbody></table>`;
      const pill = (got, label, img, hint) => `<span class="${got ? "got" : hint ? "hint" : "miss"}">${got && img ? `<img src="${img}">` : ""}${esc(got ? label : (hint ?? "???"))}</span>`;
      const named = (cb.recipes ?? []).filter(r => !r.pattern), pats = (cb.recipes ?? []).filter(r => r.pattern);
      card.innerHTML = `<div class="ob-head"><b>📖 Cookbook</b><span>${cb.found} / ${cb.total} <button class="ob-close">Close</button></span></div>
        ${grid}
        <div class="ob-sec">Fusions</div><div class="ob-pills">${(cb.fusions ?? []).map(f => pill(f.got, f.label, null, `${f.hint} ?`)).join("")}</div>
        ${named.length ? `<div class="ob-sec">Recipes</div><div class="ob-pills">${named.map(r => pill(r.got, r.name, r.img, r.hint)).join("")}</div>` : ""}
        ${pats.length ? `<div class="ob-sec">Pattern recipes</div><div class="ob-pills">${pats.map(r => pill(r.got, r.name, r.img, r.hint)).join("")}</div>` : ""}
        <div class="ob-sec">Specials</div><div class="ob-pills">${(cb.specials ?? []).map(s => pill(s.got, s.name, s.img, s.group === "dark" ? `★ ${TASTE_META[s.taste]?.label} ?` : s.group === "spoiled" ? `✖ ${TASTE_META[s.taste]?.label} ?` : "???")).join("")}</div>`;
      card.querySelector(".ob-close").onclick = () => this.toggleCookbook(false);
    }

    // ── slots / hover / chart ──
    _slotEl(actorId) { return this.$(`.oni-cook-ing-slot[data-actor-id="${actorId}"]`); }
    _repaintSlot(actorId) {
      if (!this.rendered) return;
      const slot = this._slotEl(actorId); if (!slot) return;
      const img = slot.querySelector(".oni-cook-ing-img");
      const nameEl = slot.closest(".oni-cook-corner")?.querySelector(".oni-cook-ing-name");
      const s = this._slots[actorId], mine = this._mine[actorId], hover = this._hover[actorId];
      const locked = !!s?.locked;
      const dark = this.mode === "dark";
      // what this client is allowed to see of the slot
      let show = null, secret = false;
      if (locked) {
        if (s.itemImg) show = { itemImg: s.itemImg, itemName: s.itemName };
        else if (mine) show = mine;
        else secret = true;                         // Yaminabe: someone else's pick
      } else if (hover?.itemImg) show = hover;
      slot.classList.toggle("locked", locked && !secret);
      slot.classList.toggle("secret", locked && secret);
      slot.classList.toggle("preview", !locked && !!show);
      if (show?.itemImg) { img.src = show.itemImg; img.style.display = ""; img.classList.remove("silhouette"); slot.childNodes.forEach(n => { if (n.nodeType === 3) n.remove(); }); }
      else { img.style.display = "none"; }
      if (secret && !slot.querySelector(".oni-cook-q")) slot.insertAdjacentHTML("beforeend", `<span class="oni-cook-q">?</span>`);
      if (!secret) slot.querySelector(".oni-cook-q")?.remove();
      if (nameEl) {
        if (secret) { nameEl.textContent = "✓ Ready"; nameEl.className = "oni-cook-ing-name locked"; }
        else if (show?.itemName) { nameEl.textContent = locked ? `✓ ${show.itemName}` : show.itemName; nameEl.className = `oni-cook-ing-name ${locked ? "locked" : "preview"}`; }
        else { nameEl.textContent = locked ? "✓ Skipped" : ""; nameEl.className = "oni-cook-ing-name"; }
      }
      void dark;
    }
    setHover(actorId, itemImg, itemName, itemTaste, itemTaste2) {
      if (this._slots[actorId]?.locked) return;
      this._hover[actorId] = itemImg ? { itemImg, itemName, taste: itemTaste } : null;
      this._repaintSlot(actorId);
      if (this.mode === "dark") return;               // Yaminabe: no live taste preview
      const hypo = { ...this._tastes };
      if (itemImg && itemTaste && TASTES.includes(itemTaste)) hypo[itemTaste] = (hypo[itemTaste] || 0) + 2;
      if (itemImg && itemTaste2 && TASTES.includes(itemTaste2)) hypo[itemTaste2] = (hypo[itemTaste2] || 0) + 1;
      this._renderChart(itemImg ? hypo : this._tastes);
      this._renderPreviewBadge(itemImg ? hypo : this._tastes);
    }
    _renderChart(tv) {
      if (!this.rendered) return;
      const svgEl = this.$(".oni-cook-chart"); if (!svgEl) return;
      if (this._chartAnimId) { cancelAnimationFrame(this._chartAnimId); this._chartAnimId = null; }
      const from = { ...this._displayedTv }, to = tv ?? {};
      if (TASTES.every(t => Math.abs((from[t] || 0) - (to[t] || 0)) < 0.001)) return;
      const start = performance.now(), dur = 320;
      const step = now => {
        if (!this.rendered) return;
        const p = Math.min(1, (now - start) / dur), e = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
        const interp = {}; for (const t of TASTES) interp[t] = (from[t] || 0) + ((to[t] || 0) - (from[t] || 0)) * e;
        _updateChartDOM(svgEl, interp); this._displayedTv = interp;
        if (p < 1) this._chartAnimId = requestAnimationFrame(step); else { this._chartAnimId = null; this._displayedTv = { ...to }; }
      };
      this._chartAnimId = requestAnimationFrame(step);
      const glow = this.$(".oni-cook-glow"), col = _blend(to);
      if (glow) { glow.style.opacity = col ? .22 : 0; if (col) glow.style.background = col; }
    }
    // Hot Pot planning preview: what the links would add (Yaminabe hides it)
    _renderPreviewBadge(tv = this._tastes) {
      const h = this.$(".oni-cook-harmony"); if (!h) return;
      h.textContent = ""; h.className = "oni-cook-harmony";
      if (this.mode === "dark" || this._busy) return;
      const pres = TASTES.filter(t => (tv?.[t] || 0) > 0), n = TASTES.reduce((s, t) => s + (tv?.[t] || 0) / 2, 0);
      if (pres.length >= MUDDLED_AT) { h.classList.add("bad"); h.textContent = `${pres.length} tastes: it will spoil!`; return; }
      if (n < 2) return;
      let v = LINK * (Math.round(n) - pres.length), hh = 0, cc = 0;
      for (let i = 0; i < pres.length; i++) for (let j = i + 1; j < pres.length; j++) { if (rel(pres[i], pres[j]) === "harm") { hh++; v += LINK; } else { cc++; v -= LINK; } }
      h.innerHTML = `Flavor links <b style="color:${v > 0 ? "#2e7d32" : v < 0 ? "#b23a2a" : "#7a5000"}">${sgn(v)}</b>${hh ? ` · <span style="color:#2e7d32">${hh} harmony</span>` : ""}${cc ? ` · <span style="color:#b23a2a">${cc} clash</span>` : ""}`;
    }
    setSlot(actorId, itemImg, itemName, locked) {
      this._slots[actorId] = { itemImg: itemImg || null, itemName: itemName || null, locked };
      this._hover[actorId] = null;
      this._repaintSlot(actorId);
      this._refreshStatus();
      this._renderModeSlot();
    }
    setTastes(tv) {
      this._tastes = tv ?? this._tastes;
      if (this.mode === "dark") { this._renderChart({}); return; }
      this._renderChart(this._tastes); this._renderPreviewBadge(this._tastes);
    }
    _status(html) { const b = this.$(".oni-cook-status-bar"); if (b) b.innerHTML = html; }
    _refreshStatus() {
      if (this._busy || this._inking) return;
      const n = Object.values(this._slots).filter(s => s.locked).length, t = this.entries.length;
      this._status(n >= t ? "🍲 All ingredients in! Preparing the pot..." : `Waiting... (${n}/${t} ready)`);
    }

    // ── phase: throws (+ Hot Pot flavor pips) ──
    async runAnimation(contributions, mode = this.mode) {
      if (!this.rendered) return;
      this._busy = true; this._renderModeSlot(); this._renderPreviewBadge();
      const dark = mode === "dark";
      const panel = this.$(".oni-cook-main-panel"), potEl = this.$(".oni-cook-pot-img");
      if (!potEl) return;
      if (dark) { panel.classList.add("lights-out"); this.$(".oni-cook-chart").style.opacity = 0; this._status("The lights go out. Nobody knows what's going in…"); await wait(1300); }
      else this._status("🍲 Into the pot...");
      const live = Object.fromEntries(TASTES.map(t => [t, 0]));
      for (const c of contributions) {
        if (!this.rendered) break;
        _sfx("THROW");
        const pRect = potEl.getBoundingClientRect(), sEl = this._slotEl(c.actorId);
        if (sEl) {
          const sRect = sEl.getBoundingClientRect();
          const fly = document.createElement("img");
          fly.src = c.itemImg || "icons/svg/item-bag.svg"; fly.className = "oni-cook-fly-ing";
          if (dark) fly.style.filter = "brightness(0) opacity(.7)";
          Object.assign(fly.style, { left: `${sRect.left + sRect.width / 2 - 26}px`, top: `${sRect.top + sRect.height / 2 - 26}px`,
            transition: "left .85s cubic-bezier(.3,0,.15,1.4),top .85s cubic-bezier(.3,0,.15,1.4),opacity .25s .72s,transform .85s" });
          document.body.appendChild(fly);
          // the ingredient leaves the slot the moment it's thrown
          sEl.querySelector(".oni-cook-ing-img").style.display = "none"; sEl.querySelector(".oni-cook-q")?.remove();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          fly.style.left = `${pRect.left + pRect.width / 2 - 26}px`; fly.style.top = `${pRect.top + pRect.height / 2 - 26}px`;
          fly.style.opacity = "0"; fly.style.transform = "scale(0.15) rotate(180deg)";
          await wait(900); fly.remove(); _sfx("ABSORB");
          potEl.classList.remove("bouncing"); void potEl.offsetWidth; potEl.classList.add("bouncing");
          setTimeout(() => potEl.classList.remove("bouncing"), 750);
        }
        if (!dark) {
          if (c.taste) live[c.taste] += 2;
          this._renderChart(live);
          this._status(`<b>${esc(c.actorName ?? "")}</b> throws in <b style="color:${TASTE_META[c.taste]?.color ?? "inherit"}">${esc(c.itemName)}</b>!`);
        } else this._status(`<b>${esc(c.actorName ?? "")}</b> slips something into the dark pot… <i>plop.</i>`);
        await wait(650);
      }
      if (!dark) { this._status("Flavor Check"); await this._lkPopAll(contributions); await this._lkCombine(); }
      potEl.classList.add("idling");
      panel.classList.add("oni-cook-anticipating");
      this.$(".oni-cook-steam")?.classList.add("on");
      const cookName = this.entries.find(e => e.actorId === this.cookerActorId)?.actorName ?? "The cook";
      this._status(`<b>${esc(cookName)}</b> is cooking…`);
    }

    // ── phase: after the check — Yaminabe reveal (+ pips), then a wheel if the host spun one ──
    async runResolve(contributions, mode, wheel) {
      if (!this.rendered) return;
      if (mode === "dark") {
        const panel = this.$(".oni-cook-main-panel");
        panel.classList.remove("lights-out"); this.$(".oni-cook-chart").style.opacity = .95;
        this._status("Lights on! What did everyone throw in?"); await wait(700);
        const rv = Object.fromEntries(TASTES.map(t => [t, 0])), order = [];
        for (const c of contributions) {
          const corner = this.$(`.oni-cook-corner[data-actor-id="${c.actorId}"]`);
          const slot = corner?.querySelector(".oni-cook-ing-slot"), im = corner?.querySelector(".oni-cook-ing-img"), nm = corner?.querySelector(".oni-cook-ing-name");
          if (im) { im.src = c.itemImg; im.style.display = ""; im.classList.remove("silhouette"); }
          slot?.querySelector(".oni-cook-q")?.remove();
          if (slot) slot.className = "oni-cook-ing-slot locked";
          if (nm) { nm.textContent = c.itemName; nm.className = "oni-cook-ing-name locked"; }
          corner?.classList.add("lit"); _sfx("SELECT");
          const isNew = c.taste && !order.includes(c.taste); if (isNew) order.push(c.taste);
          if (c.taste) rv[c.taste] += 2;
          this._renderChart(rv);
          this._status(`It was <b>${esc(c.actorName ?? "")}</b>'s <b style="color:${TASTE_META[c.taste]?.color ?? "inherit"}">${esc(c.itemName)}</b>!`
            + (isNew && order.length >= MUDDLED_AT ? ` <b style="color:#b23a2a">That's ${order.length} tastes… oh no.</b>` : ""));
          await wait(800); corner?.classList.remove("lit");
        }
        this._status("Flavor Check");
        await this._lkPopAll(contributions); await this._lkCombine();
      }
      if (wheel?.segments?.length > 1) {
        if (wheel.type === "taste" && wheel.title?.startsWith("Whose")) { this._status(`<b style="color:#b23a2a">${wheel.segments.length} tastes are fighting in the pot. It's muddled!</b>`); await wait(900); }
        else if (wheel.type === "taste") this._status(`${wheel.segments.map(s => `<b style="color:${TASTE_META[s.taste]?.color}">${esc(s.name)}</b>`).join(" vs ")}: no taste wins… <b>Taste wheel!</b>`);
        else this._status(`${wheel.segments.length} recipes fit this pot… <b>Recipe wheel!</b>`);
        await this._spin(wheel);
      }
    }

    // ── the wheel (host decides landIdx; every client replays the same spin) ──
    async _spin(wheel) {
      const area = this.$(".oni-cook-center-area"); if (!area) return;
      const segs = wheel.segments, n = segs.length, R = n <= 2 ? 84 : 112;
      this.$(".oni-cook-chart").style.opacity = 0; const lk = this.$(".oni-cook-links"); if (lk) lk.style.visibility = "hidden";
      const ring = document.createElement("div"); ring.className = "oni-cook-wheel";
      ring.innerHTML = `<div class="oni-cook-wtitle">${esc(wheel.title ?? "")}</div>` + segs.map((s, i) => {
        const a = (n === 2 ? -180 : -90) + i * 360 / n, x = Math.cos(a * Math.PI / 180) * R, y = Math.sin(a * Math.PI / 180) * R;
        const col = s.taste ? TASTE_META[s.taste]?.color : null;
        const face = s.img ? `<img src="${s.img}">` : `<span class="g" style="${col ? `color:${col}` : ""}">${s.taste ? TASTE_META[s.taste]?.label[0] : "?"}</span>`;
        return `<div class="oni-cook-wseg" style="transform:translate(calc(-50% + ${x.toFixed(1)}px),calc(-50% + ${y.toFixed(1)}px));${col ? `--seg:${col}` : ""}">${face}<b>${esc(s.name)}</b><i>${Math.round((s.p ?? 0) * 100)}%</i></div>`;
      }).join("");
      area.appendChild(ring);
      await wait(600);
      const els = [...ring.querySelectorAll(".oni-cook-wseg")], land = Math.max(0, Math.min(n - 1, wheel.landIdx ?? 0));
      const total = 3 * n + land;
      for (let i = 0; i <= total; i++) { els.forEach(s => s.classList.remove("on")); els[i % n].classList.add("on"); _sfx("HOVER", { vol: .25 }); await wait(60 + Math.pow(i / total, 3) * 380); }
      els[land].classList.add("landed"); _sfx("SELECT");
      await wait(1200);
      ring.remove(); this.$(".oni-cook-chart").style.opacity = .95; if (lk) lk.style.visibility = "";
    }

    // ── flavor pips ──
    // A pip is a "blob". Same taste or neighbours fuse into one blob; a clash bounces off. In a 5-taste
    // wheel no three tastes are all neighbours, so a blob holds at most 2 tastes and the show matches the math.
    _lkStart() {
      this.$(".oni-cook-links")?.remove();
      const el = document.createElement("div"); el.className = "oni-cook-links";
      el.innerHTML = `<div class="lk-row"></div><div class="lk-badge">Flavors</div>`;
      this.$(".oni-cook-center-area").appendChild(el);
      requestAnimationFrame(() => el.classList.add("in"));
      this.LK = { blobs: [], tastes: [], total: 0, n: 0, combo: 0, muddy: false, final: false };
    }
    _badge(msg, cls = "") {
      const b = this.$(".lk-badge"); if (!b) return;
      const LK = this.LK;
      if (!msg.includes("lk-combo")) b.dataset.msg = msg;
      b.className = "lk-badge " + cls;
      b.innerHTML = msg + (LK && LK.n > 1 && !LK.muddy && !LK.final ? ` <span class="lk-sum">Total ${sgn(LK.total)}</span>` : "");
      b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
    }
    _blobPaint(b) {
      const cols = b.items.map(i => TASTE_META[i.taste]?.color ?? "#8a7a68");
      b.el.style.background = cols.length > 1 ? `conic-gradient(${cols.map((c, i) => `${c} ${i * 100 / cols.length}% ${(i + 1) * 100 / cols.length}%`).join(",")})` : cols[0];
      b.size = Math.min(26 + 7 * (b.items.length - 1), 46);
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Legendary: 4 };
      const best = b.items.slice().sort((x, y) => (rank[y.rarity] ?? 1) - (rank[x.rarity] ?? 1))[0];
      b.el.innerHTML = `<img src="${best.itemImg}">${b.items.length > 1 ? `<span class="lk-n">×${b.items.length}</span>` : ""}`;
      b.el.title = b.items.map(i => `${i.actorName}: ${i.itemName}`).join("\n");
    }
    _layout() {
      const row = this.$(".lk-row"); if (!row) return;
      const W = row.clientWidth, H = row.clientHeight, GAP = 16;
      const total = this.LK.blobs.reduce((s, b) => s + b.size, 0) + GAP * Math.max(0, this.LK.blobs.length - 1);
      let x = (W - total) / 2;
      for (const b of this.LK.blobs) { b.x = x + b.size / 2; Object.assign(b.el.style, { left: x + "px", top: (H - b.size) / 2 + "px", width: b.size + "px", height: b.size + "px" }); x += b.size + GAP; }
    }
    _particles(x, colors, { n = 12, spread = 34, cls = "" } = {}) {
      const row = this.$(".lk-row"); if (!row) return;
      const y = row.clientHeight / 2;
      for (let i = 0; i < n; i++) {
        const p = document.createElement("i"); p.className = "lk-spark " + cls; p.style.background = colors[i % colors.length];
        p.style.left = x + "px"; p.style.top = y + "px"; row.appendChild(p);
        const a = Math.random() * Math.PI * 2, d = spread * (.5 + Math.random() * .7);
        p.animate([{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px),calc(-50% + ${Math.sin(a) * d - 6}px)) scale(.2)`, opacity: 0 }],
          { duration: 600 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)" }).finished.then(() => p.remove());
      }
    }
    _addPip(c) {
      if (!this.LK) this._lkStart();
      const LK = this.LK; LK.n++;
      const el = document.createElement("div"); el.className = "lk-pip"; this.$(".lk-row").appendChild(el);
      const b = { el, items: [c], tastes: c.taste ? [c.taste] : [], x: 0, size: 26 }; this._blobPaint(b);
      LK.blobs.push(b); this._layout();
      el.animate([{ transform: "translateY(-18px) scale(.3,.3)", opacity: 0 }, { transform: "translateY(2px) scale(1.25,.72)", opacity: 1, offset: .45 },
        { transform: "translateY(-2px) scale(.88,1.14)", offset: .65 }, { transform: "translateY(0) scale(1.06,.95)", offset: .82 }, { transform: "none" }], { duration: 380, easing: "ease-out" });
      _sfx("TICK", { vol: .42, rate: [1, 1.12, 1.25, 1.4][Math.min(LK.n, 4) - 1] });
      this._badge(`Ingredients ${LK.n}`);
    }
    async _lkPopAll(contributions) {
      this.LK = null;
      const tasted = contributions.filter(c => c.taste);
      if (!tasted.length) return;
      for (const c of tasted) { this._addPip(c); await wait(150); }
      await wait(320);
    }
    async _fuse(mover, target) {
      const LK = this.LK, dx = target.x - mover.x;
      await mover.el.animate([{ transform: "translateX(0) scale(1)" }, { transform: `translateX(${dx * .85}px) scale(1.05)`, offset: .75 }, { transform: `translateX(${dx}px) scale(.4)`, opacity: .2 }],
        { duration: 420, easing: "cubic-bezier(.5,0,.75,0)" }).finished;
      mover.el.remove(); LK.blobs.splice(LK.blobs.indexOf(mover), 1);
      target.items.push(...mover.items); for (const t of mover.tastes) if (!target.tastes.includes(t)) target.tastes.push(t);
      this._blobPaint(target); this._layout();
      target.el.classList.remove("fused"); void target.el.offsetWidth; target.el.classList.add("fused");
      LK.combo++; _comboSfx(LK.combo);
      this._particles(target.x, target.tastes.map(t => TASTE_META[t].color).concat(["#fff7c2"]), { n: 10 + LK.combo * 4, spread: 30 + LK.combo * 6 });
      if (LK.combo > 1) this._badge(`${this.$(".lk-badge").dataset.msg} · <span class="lk-combo">Combo ×${LK.combo}</span>`, "good");
      await wait(520);
    }
    async _bounce(mover, target) {
      const dx = target.x - mover.x, sg = Math.sign(dx) || 1, touch = dx - sg * (target.size / 2 + mover.size / 2 - 2);
      const hit = [{ transform: "translateX(0)" }, { transform: `translateX(${touch}px)`, offset: .4 }, { transform: `translateX(${-sg * 10}px) rotate(${-sg * 14}deg)`, offset: .7 }, { transform: "translateX(0)" }];
      const kick = [{ transform: "translateX(0)" }, { transform: "translateX(0)", offset: .4 }, { transform: `translateX(${sg * 8}px) rotate(${sg * 10}deg)`, offset: .65 }, { transform: "translateX(0)" }];
      this.LK.combo = 0;                                        // a clash breaks the chain
      const a = mover.el.animate(hit, { duration: 620, easing: "ease-out" }), b = target.el.animate(kick, { duration: 620, easing: "ease-out" });
      setTimeout(() => { _sfx("CLASH"); this._particles(target.x - sg * target.size / 2, ["#e8e8f0", "#b8c0cc", "#fff7c2"], { n: 8, spread: 20 }); }, 250);
      await Promise.all([a.finished, b.finished]); await wait(220);
    }
    async _lkMuddy() {
      const LK = this.LK; LK.muddy = true;
      LK.blobs.forEach(b => b.el.classList.add("shake")); this._badge(`${LK.tastes.length} Tastes`, "bad");
      await wait(700);
      LK.blobs.forEach(b => { b.el.classList.remove("shake"); b.el.classList.add("muddy"); });
      _sfx("SAD"); this._badge(`Muddled · Spoiled`, "bad");
      const wisps = setInterval(() => {
        if (!this.rendered || !this.$(".oni-cook-links")) return clearInterval(wisps);
        const b = LK.blobs[Math.floor(Math.random() * LK.blobs.length)];
        if (b) this._particles(b.x, ["#4a3a4f", "#5b4a3a", "#3c4a3a"], { n: 2, spread: 22, cls: "wisp" });
      }, 260);
      this._wisps = wisps;
      await wait(1000);
    }
    async _lkCombine() {
      const LK = this.LK; if (!LK) return;
      const order = LK.blobs.slice();
      const distinct = [...new Set(order.map(b => b.tastes[0]).filter(Boolean))];
      await wait(450);
      if (distinct.length >= MUDDLED_AT) { LK.tastes = distinct; await this._lkMuddy(); return; }
      if (order.length < 2) { LK.final = true; this._badge(`Links +0`); await wait(500); return; }
      this._badge(`Flavor Check`); await wait(500);
      const done = new Set([order[0]]); LK.tastes = [order[0].tastes[0]];
      for (const me of order.slice(1)) {
        if (!this.rendered) return;
        const t = me.tastes[0], others = LK.blobs.filter(b => done.has(b));
        me.el.classList.add("turn");
        if (LK.tastes.includes(t)) {
          const home = others.find(b => b.tastes.includes(t)); LK.total += LINK;
          this._badge(`Resonance +${LINK}`, "good"); await this._fuse(me, home); continue;
        }
        LK.tastes.push(t);
        let fuseTo = null, friends = 0, foes = 0; const clashWith = [];
        for (const b of others) {
          let clashHere = false;
          for (const x of b.tastes) { if (rel(x, t) === "harm") { friends++; LK.total += LINK; } else { foes++; LK.total -= LINK; clashHere = true; } }
          if (clashHere) clashWith.push(b); else if (!fuseTo) fuseTo = b;
        }
        const word = [friends ? `Harmony +${LINK * friends}` : "", foes ? `Clash −${LINK * foes}` : ""].filter(Boolean).join(" · ");
        this._badge(word, foes && !friends ? "bad" : friends && !foes ? "good" : "");
        for (const b of clashWith) await this._bounce(me, b);
        if (fuseTo) await this._fuse(me, fuseTo); else { me.el.classList.remove("turn"); done.add(me); }
      }
      // finish
      if (LK.blobs.length === 1) {
        const b = LK.blobs[0]; b.el.classList.add("prism"); LK.final = true;
        _sfx("PRISM"); this._badge(`Perfect Harmony · Links ${sgn(LK.total)}`, "prism");
        for (let i = 0; i < 3; i++) { this._particles(b.x, ["#ff5f6d", "#ffc371", "#fff176", "#69f0ae", "#40c4ff", "#b388ff"], { n: 14, spread: 44 }); await wait(260); }
        await wait(500);
      } else { LK.final = true; this._badge(`Links ${sgn(LK.total)}`, LK.total > 0 ? "good" : LK.total < 0 ? "bad" : ""); await wait(500); }
    }

    // ── results ──
    showResults(o, isCookerHere) {
      if (!this.rendered) return;
      if (o.cookbook) this.setView({ cookbook: o.cookbook });
      _sfx(o.sfx ?? "RESULTS");
      const overlay = this.$(".oni-cook-results-overlay"); if (!overlay) return;
      const tierHtml = o.kind === "spoiled" ? `<div class="oni-cook-results-tier spoiled">✖ Spoiled</div>`
        : o.tier ? `<div class="oni-cook-results-tier ${o.tier === 4 ? "dark" : ""}">${"★".repeat(o.tier)}${o.tier < 4 ? "☆".repeat(3 - o.tier) : ""}</div>` : "";
      const c = o.cookerCheck;
      let line = c ? `🎲 Check: ${c.total}${c.isCrit ? " — Critical!" : c.isFumble ? " — Fumble!" : ""}` : "";
      if (o.potency != null && o.parts) {
        const p = o.parts, sg = v => v >= 0 ? `+ ${v}` : `− ${-v}`;
        line += `${line ? " · " : ""}Potency ${p.rarity} ${sg(p.check)} check${p.resonance ? ` + ${p.resonance} resonance` : ""}${p.harm ? ` + ${p.harm} harmony` : ""}${p.clash ? ` − ${p.clash} clash` : ""}${p.yami ? ` + ${p.yami} yaminabe` : ""} = <b>${o.potency}</b>`;
      }
      const effect = o.dishEffect ? `Everyone who eats: <b>${esc(o.dishEffect)}</b>${o.baseDishName ? `<small>Same buff as ${esc(o.baseDishName)}.</small>` : ""}` : "";
      overlay.innerHTML = `<div class="oni-cook-results-inner burst-in">
        <img class="oni-cook-results-img ${o.kind === "spoiled" ? "spoiled" : ""}" src="${o.dishImg || "icons/svg/item-bag.svg"}">
        <div class="oni-cook-results-kind">${esc(o.label ?? "")}</div>
        <div class="oni-cook-results-name ${o.kind === "spoiled" ? "spoiled" : ""}">${esc(o.dishName ?? "???")}</div>
        ${tierHtml}
        ${o.isNew ? `<div class="oni-cook-results-new">New in the Cookbook · ${o.cookbook?.found ?? "?"}/${o.cookbook?.total ?? "?"}</div>` : ""}
        <div class="oni-cook-results-who">${(o.contributors ?? []).map(x => `<div class="oni-cook-who ${x.featured ? "feat" : ""}"><img src="${x.itemImg}"><span class="w-name">${esc(x.actorName)}</span><span class="w-item">${esc(x.itemName)}</span></div>`).join("")}</div>
        ${line ? `<div class="oni-cook-results-check">${line}</div>` : ""}
        ${effect ? `<div class="oni-cook-results-effect">${effect}</div>` : ""}
        ${o.hint ? `<div class="oni-cook-results-hint">${esc(o.hint)}</div>` : ""}
        <button class="oni-cook-proceed-btn" style="display:${isCookerHere ? "" : "none"}">🍽️ Proceed</button>
      </div>`;
      overlay.querySelector(".oni-cook-proceed-btn")?.addEventListener("click", () => {
        _sfx("EAT");
        game.socket?.emit(SOCKET_CH, { type: "COOKING_SFX", sfx: "EAT", sessionId: this.sessionId });
        game.socket?.emit(SOCKET_CH, { type: "COOKING_PROCEED", sessionId: this.sessionId, userId: game.user?.id });
        globalThis.FUCompanion?.api?.cooking?.proceed?.(this.sessionId);
        this.close();
      });
      overlay.classList.add("bursting"); setTimeout(() => overlay.classList.remove("bursting"), 750);
      this.$(".oni-cook-main-panel")?.classList.remove("oni-cook-anticipating");
      this.$(".oni-cook-pot-img")?.classList.remove("idling");
      this.$(".oni-cook-steam")?.classList.remove("on");
      this._status(o.kind === "spoiled" ? "…everyone eats it anyway." : "Dinner is served.");
      overlay.style.display = "";
    }

    close() {
      if (this._chartAnimId) { cancelAnimationFrame(this._chartAnimId); this._chartAnimId = null; }
      if (this._wisps) clearInterval(this._wisps);
      this._tasteTip?.remove(); this._tasteTip = null;
      document.body.classList.remove("oni-cook-yami");
      const el = this._el; this._el = null;
      if (el) { el.classList.add("oni-cook-exit"); setTimeout(() => el.remove(), 260); }
    }
  }

  // ── CookingPickerPanel ─────────────────────────────────────────────────────
  class CookingPickerPanel {
    constructor(sessionId, actorId, choices, onSubmit, actorName = null) {
      this.sessionId = sessionId; this.actorId = actorId; this.actorName = actorName;
      this.choices = choices; this._selected = null; this._onSubmit = onSubmit;
      this._el = null; this._tip = null; this._filter = "all";
    }
    get rendered() { return !!this._el && document.body.contains(this._el); }
    get _main() { return globalThis.CookingUI?.getMain?.(); }
    get _dark() { return this._main?.mode === "dark"; }

    render() {
      document.getElementById("oni-cook-picker")?.remove();
      document.querySelectorAll(".oni-cook-tooltip").forEach(t => t.remove());
      const el = document.createElement("div");
      el.id = "oni-cook-picker";
      const anchor = document.getElementById("oni-cook-picker-slot");
      if (anchor) { el.classList.add("oni-cook-picker--docked"); anchor.appendChild(el); } else document.body.appendChild(el);
      this._el = el;
      this._tip = document.createElement("div"); this._tip.className = "oni-cook-tooltip"; this._tip.style.display = "none";
      document.body.appendChild(this._tip);
      this._paint();
      // commit button lives in the main panel
      const commitArea = document.querySelector(".oni-cook-commit-area"), commitBtn = document.querySelector(".oni-cook-commit-btn");
      if (commitArea) commitArea.style.display = "";
      if (commitBtn) {
        this._onCommit = () => { _sfx("CONFIRM"); this._submit(this._selected === "__skip__" ? null : this._selected); };
        commitBtn.addEventListener("click", this._onCommit);
        if (!this.choices.length) { this._selected = "__skip__"; commitBtn.disabled = false; } else commitBtn.disabled = true;
      }
      // drag & drop onto the actor's slot / the pot
      const actorSlot = document.querySelector(`.oni-cook-ing-slot[data-actor-id="${this.actorId}"]`), potImg = document.querySelector(".oni-cook-pot-img");
      this._onDragOver = ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; };
      this._onDrop = ev => { ev.preventDefault(); const id = ev.dataTransfer.getData("text/plain"); if (id) { _sfx("CONFIRM"); this._submit(id); } };
      this._onDragEnter = () => actorSlot?.classList.add("oni-cook-drop-hover");
      this._onDragLeave = () => actorSlot?.classList.remove("oni-cook-drop-hover");
      [actorSlot, potImg].forEach(t => { if (!t) return; t.addEventListener("dragover", this._onDragOver); t.addEventListener("drop", this._onDrop); });
      if (actorSlot) { actorSlot.addEventListener("dragenter", this._onDragEnter); actorSlot.addEventListener("dragleave", this._onDragLeave); }
    }
    refreshModeLabel() { if (this.rendered) this._paint(); }
    _kind(name) { const k = this._main?.view?.kinds?.[name]; return STYLE_LABEL[k] ?? null; }
    _tasted(name) { return (this._main?.view?.tasted ?? []).includes(name); }
    _paint() {
      const el = this._el; if (!el) return;
      const header = `<div class="oni-cook-picker-header">🥘 ${this.actorName ? `Picking for <b>${esc(this.actorName)}</b>` : "Choose Your Ingredient"}${this._dark ? " · 🤫 secret" : ""}</div>`;
      if (!this.choices.length) {
        el.innerHTML = `${header}<div class="oni-cook-picker-empty">No materials to contribute.</div><div class="oni-cook-picker-grid">${this._skipHTML(true)}</div>`;
        this._bind(); return;
      }
      const filters = `<div class="oni-cook-picker-filter">${["all", ...TASTES].map(t => `<button data-t="${t}" class="${this._filter === t ? "on" : ""}" ${t !== "all" && this._filter !== t ? `style="color:${TASTE_META[t].color}"` : ""}>${t === "all" ? "All" : TASTE_META[t].label}</button>`).join("")}</div>`;
      const shown = this.choices.filter(c => this._filter === "all" || c.taste === this._filter);
      const slots = shown.map(c => `
        <div class="oni-cook-picker-slot ${this._selected === c.id ? "selected" : ""}" draggable="true" data-id="${c.id}" data-img="${c.img || ""}" data-name="${esc(c.name)}" data-taste="${c.taste || ""}" data-taste2="${c.taste2 || ""}" data-rarity="${esc(c.rarity || "")}" data-desc="${esc(c.description || "")}">
          ${c.taste ? `<span class="oni-cook-taste-dot" style="background:${TASTE_META[c.taste].color}"></span>` : ""}
          <img src="${c.img || "icons/svg/item-bag.svg"}">
          <span class="oni-cook-slot-qty">${c.qty}</span><span class="oni-cook-slot-check">✓</span>
          ${this._tasted(c.name) ? "" : `<span class="oni-cook-slot-new">✦</span>`}
        </div>`).join("");
      el.innerHTML = `${header}${filters}<div class="oni-cook-picker-grid">${slots}${this._skipHTML(this._selected === "__skip__")}</div><div class="oni-cook-picker-foot">✦ = not in a pot yet · dot = taste</div>`;
      this._bind();
    }
    _skipHTML(sel = false) { return `<div class="oni-cook-picker-slot oni-cook-skip-slot${sel ? " selected" : ""}" data-id="__skip__"><span class="oni-cook-skip-icon">✕</span><span class="oni-cook-skip-label">Skip</span></div>`; }
    _updateCommitBtn() { const btn = document.querySelector(".oni-cook-commit-btn"); if (btn) btn.disabled = !this._selected; }
    // Yaminabe: hovers stay on this client only (nobody else may see them)
    _emitHover(img, name, t, t2, isSelect = false) {
      if (!this._dark) game.socket?.emit(SOCKET_CH, { type: "COOKING_HOVER", sessionId: this.sessionId, actorId: this.actorId, itemImg: img, itemName: name, itemTaste: t, itemTaste2: t2, ...(isSelect ? { isSelect: true } : {}) });
      globalThis.CookingUI?._applyHover(this.actorId, img, name, t, t2, isSelect, true);
    }
    _bind() {
      const el = this._el;
      el.querySelectorAll(".oni-cook-picker-filter button").forEach(b => b.addEventListener("click", () => { this._filter = b.dataset.t; _sfx("TICK", { vol: .25 }); this._paint(); }));
      el.querySelectorAll(".oni-cook-picker-slot").forEach(slot => {
        const isSkip = slot.classList.contains("oni-cook-skip-slot");
        const move = ev => { if (this._tip) { this._tip.style.left = `${ev.clientX + 14}px`; this._tip.style.top = `${ev.clientY - 8}px`; } };
        slot.addEventListener("mouseenter", ev => {
          const s = ev.currentTarget;
          if (isSkip) {
            this._tip.innerHTML = `<div class="oni-cook-tt-name" style="color:#8a2020">Skip</div><div class="oni-cook-tt-desc">Contribute nothing to the pot</div>`;
            this._tip.style.display = ""; move(ev);
            if (this._selected && this._selected !== "__skip__") return;
            this._emitHover(null, null, null, null); return;
          }
          const taste = s.dataset.taste, taste2 = s.dataset.taste2 || null, kind = this._kind(s.dataset.name);
          this._tip.innerHTML = `<div class="oni-cook-tt-name">${esc(s.dataset.name)}</div>${s.dataset.desc ? `<div class="oni-cook-tt-desc">${esc(s.dataset.desc)}</div>` : ""}
            <div class="oni-cook-tt-meta">${taste ? `<span style="color:${TASTE_META[taste].color}">${TASTE_META[taste].label}</span> · ` : ""}${esc(s.dataset.rarity)}${kind ? ` · ${kind} style` : ""}</div>`;
          this._tip.style.display = ""; move(ev);
          const now = Date.now(); if (now - _hoverSfxTs > 100) { _sfx("HOVER"); _hoverSfxTs = now; }
          if (this._selected !== s.dataset.id) this._emitHover(s.dataset.img, s.dataset.name, taste || null, taste2);
        });
        slot.addEventListener("mousemove", move);
        slot.addEventListener("mouseleave", () => {
          if (this._tip) this._tip.style.display = "none";
          if (this._selected && this._selected !== "__skip__") {
            const sel = el.querySelector(`.oni-cook-picker-slot[data-id="${this._selected}"]`);
            if (sel) { this._emitHover(sel.dataset.img, sel.dataset.name, sel.dataset.taste || null, sel.dataset.taste2 || null); return; }
          }
          this._emitHover(null, null, null, null);
        });
        if (!isSkip) slot.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/plain", slot.dataset.id); ev.dataTransfer.effectAllowed = "copy"; });
        slot.addEventListener("click", ev => {
          const s = ev.currentTarget, id = s.dataset.id;
          if (this._selected === id) {
            _sfx("SELECT"); this._selected = null;
            el.querySelectorAll(".oni-cook-picker-slot").forEach(e => e.classList.remove("selected"));
            this._updateCommitBtn(); this._emitHover(null, null, null, null);
          } else {
            _sfx("HOVER"); this._selected = id;
            el.querySelectorAll(".oni-cook-picker-slot").forEach(e => e.classList.remove("selected"));
            s.classList.add("selected"); this._updateCommitBtn();
            if (isSkip) this._emitHover(null, null, null, null);
            else this._emitHover(s.dataset.img, s.dataset.name, s.dataset.taste || null, s.dataset.taste2 || null, true);
          }
        });
      });
    }
    _submit(itemId) {
      const choice = this.choices.find(c => c.id === itemId);
      globalThis.CookingUI?._rememberMine(this.actorId, choice ? { itemImg: choice.img, itemName: choice.name } : null);
      const cb = this._onSubmit; this.close(); cb?.(itemId);
    }
    _cleanup() {
      this._tip?.remove(); this._tip = null;
      const commitBtn = document.querySelector(".oni-cook-commit-btn");
      if (commitBtn && this._onCommit) { commitBtn.removeEventListener("click", this._onCommit); this._onCommit = null; }
      const commitArea = document.querySelector(".oni-cook-commit-area"); if (commitArea) commitArea.style.display = "none";
      const actorSlot = document.querySelector(`.oni-cook-ing-slot[data-actor-id="${this.actorId}"]`), potImg = document.querySelector(".oni-cook-pot-img");
      [actorSlot, potImg].forEach(t => { if (!t) return; t.removeEventListener("dragover", this._onDragOver); t.removeEventListener("drop", this._onDrop); });
      if (actorSlot) { actorSlot.removeEventListener("dragenter", this._onDragEnter); actorSlot.removeEventListener("dragleave", this._onDragLeave); actorSlot.classList.remove("oni-cook-drop-hover"); }
    }
    close() {
      this._cleanup();
      if (globalThis.CookingUI?._picker === this) globalThis.CookingUI._picker = null;
      const el = this._el; this._el = null;
      if (el) { el.classList.add("oni-cook-picker-exit"); setTimeout(() => el.remove(), 200); }
    }
  }

  // ── Manager singleton ──────────────────────────────────────────────────────
  let _main = null;
  const _ok = sessionId => _main?.rendered && _main.sessionId === sessionId;

  const CookingUI = {
    _picker: null,
    _applyHover(actorId, itemImg, itemName, itemTaste, itemTaste2, isSelect = false, local = false) {
      if (!local && _main?.mode === "dark") return;             // never show someone else's Yaminabe hover
      if (isSelect && itemImg && !local) _sfx("HOVER");
      _main?.setHover(actorId, itemImg || null, itemName || null, itemTaste || null, itemTaste2 || null);
    },
    _rememberMine(actorId, pick) { if (_main) { if (pick) _main._mine[actorId] = pick; else delete _main._mine[actorId]; } },
    playSfx(key) { if (SFX[key]) _sfx(key); },
    openMainPanel(sessionId, entries, cookerActorId, opts = {}) {
      _main?.close();
      _main = new CookingMainPanel(sessionId, entries, cookerActorId, opts);
      _main.render();
      _sfx("OPEN");
      return _main;
    },
    openPicker(sessionId, actorId, choices, actorName = null) {
      return new Promise(resolve => {
        const p = new CookingPickerPanel(sessionId, actorId, choices, resolve, actorName);
        CookingUI._picker = p; p.render();
      });
    },
    applyState(sessionId, slots, tasteValues) {
      if (!_ok(sessionId)) return;
      for (const [id, s] of Object.entries(slots ?? {})) _main.setSlot(id, s.itemImg || null, s.itemName || null, !!s.locked);
      if (tasteValues) _main.setTastes(tasteValues);
    },
    async setMode(sessionId, mode, opts) { if (_ok(sessionId)) await _main.setMode(mode, opts); },
    async runAnimation(sessionId, contributions, mode) { if (_ok(sessionId)) await _main.runAnimation(contributions, mode); },
    async runResolve(sessionId, contributions, mode, wheel) { if (_ok(sessionId)) await _main.runResolve(contributions, mode, wheel); },
    showResults(sessionId, outcome) {
      if (!_ok(sessionId)) return;
      const cooker = game.actors?.get(_main.cookerActorId);
      const watching = globalThis.FUCompanion?.api?.Spectator?.isSpectator?.();
      const isMine = cooker && (game.user?.isGM || (cooker.isOwner && !watching));
      _main.showResults(outcome, isMine);
    },
    closeAll() {
      _main?.close(); _main = null;
      document.getElementById("oni-cook-picker")?.remove();
      document.querySelectorAll(".oni-cook-tooltip,.oni-cook-taste-tip").forEach(t => t.remove());
      document.body.classList.remove("oni-cook-yami");
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
