// ═════════ The game's battle HUD, damage numbers, NPC HP bar, namecard and crit cut-in, ported for the mockup
// Markup = director-player-hud.js makePlate / makeCompactCard; CSS = the real injectStyles() text (vendor/hud.css).
// Numbers = director-damage-numbers.js + damage-number-style.js; NPC bar = director-hp-bar.js; namecard = director-vfx.js
// options through namecard-receiver.js; crit cut-in = director-cutin.js. Sizes: the HUD at a 1920-wide screen (hudScale 1).
const HUD_SCALE = W / 1920;
const HUDL = document.createElement("div"); HUDL.id = "hud"; $("view").appendChild(HUDL);
const OVL = document.createElement("div"); OVL.id = "ovl"; $("view").appendChild(OVL);   // namecard + crit cut-in (above the numbers)
const nice = (x) => new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x) || 0)));
const pctW = (v, m) => `${(clamp(v / m, 0, 1) * 100).toFixed(4)}%`;
const dotRow = (m, v) => Array.from({ length: m }, (_, i) => `<i class="${i < v ? "on" : ""}"></i>`).join("");
const TONE = { hpA: "#6bd66b", hpB: "#2fbf71", hp50: "#a2e33a", hp25: "#ffb84a", hp10: "#ff5a5a" };
function tintHp(el, v, m) { const p = clamp(v / m, 0, 1);
  el.style.background = p <= .10 ? `linear-gradient(90deg, ${TONE.hp10}, #ff7676)` : p <= .25 ? `linear-gradient(90deg, ${TONE.hp25}, #ff9a5c)` : p <= .50 ? `linear-gradient(90deg, ${TONE.hp50}, #89e14a)` : `linear-gradient(90deg, ${TONE.hpA}, ${TONE.hpB})`; }

// the party as the world has them (actors export, 2026-11-21)
const PCS = {
  hina:    { name: "Hina",    hp: 157, hpm: 157, mp: 120, mpm: 120, ip: 6, ipm: 6,  zp: 3, fp: 8, lv: 45, def: 8,  mdef: 14, zname: "A MILLION POSSIBILITY", dex: 6, mig: 8 },
  zarg:    { name: "Zarg",    hp: 145, hpm: 145, mp: 85,  mpm: 85,  ip: 8, ipm: 12, zp: 6, fp: 6, lv: 45, def: 14, mdef: 10, zname: "Meteor Shower", dex: 12, mig: 8 },
  keren:   { name: "Keren",   hp: 85,  hpm: 85,  mp: 70,  mpm: 70,  ip: 8, ipm: 8,  zp: 6, fp: 0, lv: 45, def: 11, mdef: 13, zname: "Last Den of Cinders", dex: 8, mig: 6 },
  blanche: { name: "Blanche", hp: 174, hpm: 174, mp: 85,  mpm: 94,  ip: 10, ipm: 10, zp: 6, fp: 8, lv: 45, def: 19, mdef: 15, zname: "Give me tips or 5stars.", dex: 12, mig: 12 },
};
const ORDER = ["hina", "zarg", "keren", "blanche"];
const ST = {};   // live HUD values per PC
const HUD = {};  // id -> element handle
let WIELD = "zarg", FORM = 1;

function plateHTML(id) { const p = PCS[id];
  return `<div class="dhud-take is-off" role="button" tabindex="-1" aria-disabled="true"><span class="face"><span class="ico" aria-hidden="true"></span>
      <span class="txt"><span class="lab">Take Turn</span><span class="why"></span></span><span class="key">Enter</span></span><span class="face-tab" aria-hidden="true">Turn Action</span></div>
    <div class="dhud-wait" role="status"><span class="hg" aria-hidden="true"></span><span class="t"></span></div>
    <div class="dhud-pcard"><div class="art"><img src="${M.sprites["portrait_" + id]}" alt=""></div><span class="dhud-pname"><span class="dhud-name">${p.name}</span><span class="lv">Lv ${p.lv}</span></span></div>
    <div class="dhud-drawer"><div class="dhud-dclip"><div class="dhud-dbody"></div></div></div>
    <div class="dhud-plate">
      <div class="dhud-row1"><div class="dhud-statuses"></div><span class="grow"></span>
        <span class="dhud-lbl">IP</span><span class="dhud-ip"></span>
        <span class="dhud-fp"><span class="dhud-lbl">FP</span><b class="dhud-fpnum">${p.fp}</b></span></div>
      <div class="dhud-row2">
        <div class="dhud-res hp"><div class="head"><span class="dhud-lbl">HP</span>
          <span class="num dhud-hpnum"><span class="dhud-hpcur"></span><span class="sl">/</span><span class="dhud-hpmax">${nice(p.hpm)}</span></span>
          <span class="dhud-stamp">Crisis</span></div>
          <div class="dhud-bar dhud-hp"><i class="dhud-trail"></i><div class="dhud-fill"></div><i class="dhud-cost"></i></div></div>
        <div class="dhud-res mp"><div class="head"><span class="dhud-lbl">MP</span>
          <span class="num"><span class="dhud-mpnum"></span><span class="sl">/</span><span class="dhud-mpmax">${nice(p.mpm)}</span></span></div>
          <div class="dhud-bar dhud-mp"><div class="dhud-fill"></div><i class="dhud-cost"></i></div></div>
        <div class="dhud-res zp"><div class="head"><span class="dhud-lbl zname dhud-zname-text" title="${p.zname}">ZP · ${p.zname}</span><span class="grow"></span>
          <span class="dhud-ready">Ready</span><span class="num"><span class="dhud-zpnum"></span><span class="sl">/</span>6</span></div>
          <div class="dhud-bar dhud-zp"><div class="dhud-fill"></div></div></div>
      </div>
      <div class="dhud-row3"><div class="dhud-shelf is-empty"></div><span class="dhud-readies"></span>
        <span class="dhud-def"><span class="dhud-lbl">DEF</span><b class="dhud-defnum"></b><span class="dhud-lbl">M.DEF</span><b class="dhud-mdefnum"></b></span></div>
    </div>`; }
function cardHTML(id) { const p = PCS[id];
  return `<div class="dhud-ctab"><div class="dhud-statuses"></div><div class="dhud-readies"></div></div>
    <div class="dhud-pcard"><div class="art"><img src="${M.sprites["portrait_" + id]}" alt=""></div></div>
    <div class="dhud-cbody">
      <div class="dhud-top"><span class="dhud-name">${p.name}</span><span class="dhud-ip${p.ipm > 8 ? " is-many" : ""}"></span></div>
      <div class="dhud-hpline">
        <span class="big dhud-hpnum"><span class="dhud-hpcur"></span><span class="sl">/</span><span class="dhud-hpmax">${nice(p.hpm)}</span></span>
        <span class="dhud-stamp">Crisis</span>
        <span class="mp"><span class="dhud-lbl">MP</span><span class="dhud-mpnum"></span></span>
      </div>
      <div class="dhud-cbars">
        <span class="dhud-lbl">HP</span><div class="dhud-bar dhud-hp"><i class="dhud-trail"></i><div class="dhud-fill"></div></div>
        <span class="dhud-lbl">MP</span><div class="dhud-bar dhud-mp"><div class="dhud-fill"></div></div>
        <span class="dhud-lbl">ZP</span><div class="dhud-bar dhud-zp"><div class="dhud-fill"></div></div>
      </div>
    </div>
    <div class="dhud-resgrid is-empty"></div>`; }

function hudBuild() {
  HUDL.innerHTML = ""; for (const k of Object.keys(HUD)) delete HUD[k];
  const root = document.createElement("div"); root.className = "dhud-root"; root.style.transform = `scale(${HUD_SCALE})`;
  const plateRoot = document.createElement("div"); plateRoot.className = "dhud-plate-root"; plateRoot.style.transform = `scale(${HUD_SCALE})`;
  HUDL.append(root, plateRoot);
  for (const id of ORDER) { const el = document.createElement("div"); const mine = id === WIELD;
    el.className = mine ? "dhud-unit no-take" : "dhud-card"; el.dataset.actorId = id; el.innerHTML = mine ? plateHTML(id) : cardHTML(id);
    (mine ? plateRoot : root).appendChild(el); el.classList.add("dhud-appear");
    HUD[id] = { el, kind: mine ? "plate" : "card", q: (s) => el.querySelector(s) }; }
  HUD.plateRoot = plateRoot; gaugeMount(plateRoot); hudResetValues(true);
}
function hudResetValues(instant) { for (const id of ORDER) ST[id] = { ...PCS[id] }; FORM = FORM || 1; for (const id of ORDER) hudPaint(id, instant); hudForm(FORM, true); hudCost(0); }
function hudPaint(id, instant) { const h = HUD[id], s = ST[id]; if (!h) return;
  const fills = h.el.querySelectorAll(".dhud-fill"); if (instant) fills.forEach((f) => f.style.transition = "none");
  const hpF = h.q(".dhud-hp .dhud-fill"), tr = h.q(".dhud-hp .dhud-trail"); tintHp(hpF, s.hp, s.hpm); hpF.style.width = pctW(s.hp, s.hpm); if (tr) tr.style.width = pctW(s.hp, s.hpm);
  h.q(".dhud-mp .dhud-fill").style.width = pctW(s.mp, s.mpm); const zf = h.q(".dhud-zp .dhud-fill"); zf.style.width = pctW(s.zp, 6); zf.classList.toggle("dhud-glow", s.zp >= 6);
  h.q(".dhud-hpcur").textContent = nice(s.hp); h.q(".dhud-mpnum").textContent = nice(s.mp); h.q(".dhud-ip").innerHTML = dotRow(s.ipm, s.ip);
  if (h.kind === "plate") { h.q(".dhud-zpnum").textContent = s.zp; h.el.classList.toggle("zp-full", s.zp >= 6); h.q(".dhud-defnum").textContent = s.def; h.q(".dhud-mdefnum").textContent = s.mdef; }
  const crisis = s.hp > 0 && s.hp <= s.hpm / 2; h.el.classList.toggle("is-crisis", crisis);
  if (instant) { void h.el.offsetWidth; fills.forEach((f) => f.style.transition = ""); }
}
const hudFlash = (el) => { if (!el) return; el.classList.remove("dhud-flash"); void el.offsetWidth; el.classList.add("dhud-flash"); };
// the plate's cost preview (paintCost): striped segment over the MP the action will spend
function hudCost(mp) { const h = HUD[WIELD]; if (!h) return; const el = h.q(".dhud-bar.dhud-mp .dhud-cost"); const s = ST[WIELD];
  if (!mp) { el.classList.remove("is-on"); return; } const spend = Math.min(mp, s.mp);
  el.style.left = pctW(Math.max(0, s.mp - spend), s.mpm); el.style.width = pctW(Math.max(spend, s.mpm * .012), s.mpm); el.classList.toggle("is-short", mp > s.mp); el.classList.add("is-on"); }
function hudSpendMP(n) { const s = ST[WIELD]; s.mp = Math.max(0, s.mp - n); hudCost(0); hudPaint(WIELD); hudFlash(HUD[WIELD].q(".dhud-mp .dhud-fill")); }

// ───────── the form badge: a plate-shelf item in the Clock style (ringSVG, light) — NEW, nothing like it ships yet
let RSEQ = 0;
function ringSVG(size, img, colorA, colorB, glowC) { const id = "lhr" + (++RSEQ), c = size / 2, sw = Math.max(2.5, size * .085), rad = c - sw / 2 - .5, inner = size - 2 * sw - 2;
  return `<svg class="dhud-ring is-full" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="--dhud-ring-glow:${glowC}" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colorA}"/><stop offset="1" stop-color="${colorB}"/></linearGradient>
    <clipPath id="c${id}"><circle cx="${c}" cy="${c}" r="${(inner / 2).toFixed(2)}"/></clipPath></defs>
    <circle cx="${c}" cy="${c}" r="${c - .5}" fill="rgba(14,9,4,.82)" stroke="rgba(122,106,85,.7)"/>
    <circle class="on" cx="${c}" cy="${c}" r="${rad.toFixed(2)}" stroke="url(#g${id})" stroke-width="${sw.toFixed(2)}" fill="none"/>
    <image href="${img}" x="${(c - inner / 2).toFixed(2)}" y="${(c - inner / 2).toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" clip-path="url(#c${id})" preserveAspectRatio="xMidYMid slice"/></svg>`; }
const FORMS = { 1: { roman: "I", name: "Sword", a: "#ffb340", b: "#ff6a00", glow: "rgba(255,150,40,.6)" }, 2: { roman: "II", name: "Firearm", a: "#bfe3ff", b: "#3f7fd6", glow: "rgba(90,160,255,.6)" } };
function hudForm(f, quiet) { FORM = f; const h = HUD[WIELD]; if (!h) return; const shelf = h.q(".dhud-shelf"); const F = FORMS[f];
  shelf.classList.remove("is-empty");
  shelf.innerHTML = `<div class="dhud-ritem lh-form f${f}"><span class="dhud-rslot${quiet ? "" : " dhud-res-enter"}">${ringSVG(32, M.sprites.icon_gb, F.a, F.b, F.glow)}</span>
    <div><div class="dhud-rn">Gunblade</div><div class="dhud-rv">${F.name}</div></div></div>`;
  hudPaint(WIELD);   // Gunblade: no DEF / M.DEF change between forms
  if (!quiet) hudFlash(shelf); }
// the shelf with no weapon badge (Sonic Katar has no form)
function hudNoForm() { const h = HUD[WIELD]; if (!h) return; const shelf = h.q(".dhud-shelf"); shelf.innerHTML = ""; shelf.classList.add("is-empty"); }

// ───────── damage numbers (the game's resolveDamageNumberStyle + the .fud-dn markup)
const DN2 = document.createElement("div"); DN2.id = "dn2"; Object.assign(DN2.style, { position: "absolute", left: 0, top: 0, width: W + "px", height: H + "px", pointerEvents: "none", zIndex: 61, overflow: "hidden" }); $("view").appendChild(DN2);
const DN_SLOT2 = new Map();
function gameNum(t, amount, { kind = "loss", resource = "hp", element = "physical", weak = false, crit = false, critBanner = true, isHit = true } = {}) {
  if (FAST) return; const spec = { tag: null, critBanner: false, number: null, color: "#ffffff", fontPx: Math.round(30 + Math.min(26, Math.max(0, amount) / 7)), crit, shake: false };
  // MISS: the game's big outlined word in the numeral slot (damage-number-style.js kind "miss": #eef2f7, 46 px)
  if (kind === "miss") { spec.number = "MISS"; spec.color = "#eef2f7"; spec.fontPx = 46; }
  else if (kind === "gain") { spec.number = `+${Math.abs(amount)}`; spec.color = resource === "mp" ? "#3fb6ff" : "#52e36a"; }
  else if (kind === "spend") { spec.number = `-${Math.abs(amount)}`; spec.color = "#cfd2da"; spec.fontPx = Math.round(spec.fontPx * .8); }
  else { spec.number = `${Math.abs(amount)}`; spec.color = resource === "mp" ? "#7fb6ff" : (DN_COLOR[element] || "#ffffff");
    if (weak) { spec.tag = "WEAK!"; spec.color = "#ff7a2f"; spec.fontPx = Math.round(spec.fontPx * 1.18); spec.shake = true; } }
  if (crit && kind === "loss") { spec.fontPx = Math.round(spec.fontPx * 1.38); spec.critBanner = critBanner; }
  const now = performance.now(); const slot = Math.max(now, DN_SLOT2.get(t.id) ?? 0); DN_SLOT2.set(t.id, slot + 120 / SPEED);
  const rid = RUN, jx = Math.round((Math.random() - .5) * 26);
  setTimeout(() => { if (rid !== RUN) return; const p = numAt(t)();
    const root = document.createElement("div"); root.className = "fud-dn fud-dn--" + kind + (spec.crit ? " fud-dn--crit" : "") + (spec.shake ? " fud-dn--shake" : "");
    root.style.left = (p.x + jx) + "px"; root.style.top = p.y + "px";
    root.innerHTML = `<div class="fud-dn-riser"><div class="fud-dn-inner">${spec.critBanner ? '<div class="fud-dn-crit-banner">CRITICAL!</div>' : ""}${spec.tag ? `<div class="fud-dn-tag fud-dn-tag--weak">${spec.tag}</div>` : ""}<div class="fud-dn-num" style="--dn-color:${spec.color};--dn-size:${spec.fontPx}px"><span>${spec.number}</span></div></div></div>`;
    DN2.appendChild(root); if (kind === "loss" && resource === "hp") { if (isHit) hcAdd(amount); else hcDmg(amount); } setTimeout(() => root.remove(), 1150 + 60); }, slot - now);
}

// damage onto the hit counter without a new hit (Sonic Blow's Perfect bonus)
function hcDmg(n) { HC.dmg += n; const el = $("hc"); if (HC.hits < 2) return; el.className = "on"; el.querySelector(".dmg b").textContent = HC.dmg;
  clearTimeout(HC.t); HC.t = setTimeout(() => { el.className = "on out"; }, 1600 / SPEED); }
// ───────── NPC HP bar (studied hostile): green slides fast, red ghost holds then drains, lingers, fades
const HPB = { el: null };
const HPBT = window.HPBAR_T;
function npcBar(t, from, to, max) { if (FAST) return; const b = HPB.el || (() => { const r = document.createElement("div"); r.className = "fud-hpbar";
    r.innerHTML = `<div class="fud-hpbar-track"><div class="fud-hpbar-ghost"></div><div class="fud-hpbar-shieldbar"></div><div class="fud-hpbar-fill"></div><div class="fud-hpbar-gloss"></div></div>`;
    r.style.position = "absolute"; DN2.appendChild(r); HPB.el = r; HPB.fill = r.querySelector(".fud-hpbar-fill"); HPB.ghost = r.querySelector(".fud-hpbar-ghost"); HPB.sb = r.querySelector(".fud-hpbar-shieldbar");
    HPB.fill.style.width = pctW(from, max); HPB.ghost.style.width = pctW(from, max); HPB.sb.style.width = pctW(from, max); return r; })();
  const p = FCAM.screen({ x: OX(t), y: OY(t) }); const w = GRID * .95 * .8 * FCAM.z, hgt0 = 10 * .8;
  Object.assign(b.style, { left: p.x + "px", top: (p.y - 12 + 8) + "px", width: w + "px", height: hgt0 + "px", opacity: 1, transform: "translate(-50%, 0)" });
  const f = to / max; HPB.fill.style.setProperty("--hpbar-color", f <= .25 ? "#e04b3a" : f <= .5 ? "#e5c33b" : "#57c96b");
  HPB.fill.style.width = pctW(to, max); HPB.sb.style.width = pctW(to, max);
  clearTimeout(HPB.t1); clearTimeout(HPB.t2);
  HPB.t1 = setTimeout(() => { HPB.ghost.style.width = pctW(to, max); }, (HPBT.GREEN_SLIDE_MS + HPBT.HOLD_MS));
  HPB.t2 = setTimeout(() => { b.style.opacity = 0; b.style.transform = `translate(calc(-50% - ${HPBT.SLIDE_PX}px), 0)`; }, HPBT.GREEN_SLIDE_MS + HPBT.HOLD_MS + HPBT.DRAIN_MS + HPBT.LINGER_MS);
}
function npcBarReset() { if (HPB.el) { HPB.el.remove(); HPB.el = null; } clearTimeout(HPB.t1); clearTimeout(HPB.t2); }

// ───────── action namecard (director-vfx.js buildActionNamecardOptions, friendly theme, rendered like namecard-receiver.js)
async function namecard(title, icon = "💥") { if (FAST) return; const s = HUD_SCALE * 1.2;   // the vh scaler at 1080 = 1.2
  const card = document.createElement("div"); card.className = "oni-namecard";
  Object.assign(card.style, { position: "absolute", left: "50%", top: (8 + 64 * s) + "px", width: "640px", marginLeft: "-320px", transform: `scale(${s})`, transformOrigin: "50% 0", opacity: 0 });
  card.style.setProperty("--oni-accent", "#7fb5ff");
  card.innerHTML = `<div class="oni-namecard__plate" data-mask="1"></div><div class="oni-namecard__titlewrap"><span class="oni-namecard__line">${icon ? `<span class="oni-namecard__icon" style="font-size:${30 * .93}px">${icon}</span>` : ""}<span class="oni-namecard__text">${title}</span></span></div>`;
  OVL.appendChild(card);
  await tween(350, (t) => cubicBez(.22, .9, .24, 1, t), (t) => { card.style.opacity = t; card.style.transform = `scale(${s}) translateX(${-40 * (1 - t)}px)`; });
  setTimeout(() => { tween(400, (t) => cubicBez(.2, .7, .4, 1, t), (t) => { card.style.opacity = 1 - t; card.style.transform = `scale(${s}) translateX(${40 * t}px)`; }).catch(() => {}).then(() => card.remove()); }, 1400 / SPEED);
}

// ───────── crit cut-in (director-cutin.js playDirectorCutinLocal: dim .6, flash .85, portrait 92vh from the right, drift, exit left)
async function critCutin(id) { if (FAST) return; sfx("burstmax", .8 / .75);
  const dim = document.createElement("div"), fl = document.createElement("div"), img = document.createElement("img");
  Object.assign(dim.style, { position: "absolute", inset: 0, background: "#000", opacity: 0 }); Object.assign(fl.style, { position: "absolute", inset: 0, background: "#fff", opacity: 0 });
  img.src = M.sprites["cutin_" + id]; Object.assign(img.style, { position: "absolute", bottom: 0, right: (W * .06) + "px", height: (H * .92) + "px", width: "auto" });
  OVL.append(dim, fl, img); const vw = W / 100;
  const tx = (v) => img.style.transform = `translateX(${v}px)`; tx(120 * vw);
  tween(200, EASE.out, (t) => dim.style.opacity = .6 * t).catch(() => {});
  tween(320, EASE.out, (t) => fl.style.opacity = .85 * (t < .5 ? t * 2 : 2 - t * 2)).catch(() => {});
  await tween(500, (t) => cubicBez(.1, .9, .25, 1, t), (t) => tx(lerp(120 * vw, 0, t)));
  await tween(1500, EASE.lin, (t) => tx(lerp(0, -3 * vw, t)));
  tween(300, EASE.in, (t) => dim.style.opacity = .6 * (1 - t)).catch(() => {});
  await tween(450, (t) => cubicBez(.6, 0, .9, .15, t), (t) => tx(lerp(-3 * vw, -120 * vw, t)));
  dim.remove(); fl.remove(); img.remove();
}
