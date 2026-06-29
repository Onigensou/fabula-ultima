// Battle Director — per-client player resource HUD.
//
// Self-contained: owns its CSS, socketlib channel, and reload gate. Does NOT
// depend on resource-ui-manager.js / OniHud2. Visual spec is identical to
// OniHud2 (same card layout, 420ms ease slide-in, dhud-* CSS classes).
//
// Lifecycle:
//   buildDirectorHud(entries, scene)  — called from director-init.js after
//     entrance animations complete. Persists scene flags for reload survival,
//     then broadcasts via socket so every client builds locally. GM builds
//     with full token refs (executeForOthers path); others resolve from
//     actorIds via game.actors.
//
//   destroyDirectorHud(scene)         — called from state-handlers.js
//     Stopped.onEnter. Broadcasts destroy to all clients, then clears flags.
//
// Reload gate: Hooks.on("canvasReady") + Hooks.once("ready") both call
// tryReloadRecovery, which reads scene flags and rebuilds locally if the HUD
// is missing. canvasTearDown destroys local HUD on scene switch; canvasReady
// rebuilds it from flags when the scene is re-entered.

import { log, warn } from "./logger.js";

const MODULE_ID  = "fabula-ultima-companion";
const ACTION_BUILD   = "FU_DIRECTOR_HUD_BUILD";
const ACTION_DESTROY = "FU_DIRECTOR_HUD_DESTROY";
const FLAG_KEY    = "directorHudKey";
const FLAG_ACTORS = "directorHudActorIds";
const STYLE_ID    = "fu-director-hud-style";
const FONT_LINK_ID = "fu-director-hud-fonts";

// ── design constants (match OniHud2) ────────────────────────────────────────
const HUD_UI_SCALE       = 1.00;
const HUD_PORTRAIT_SCALE = 0.85;
const TONE = {
  hpA: "#6bd66b", hpB: "#2fbf71",
  mpA: "#5aa8ff", mpB: "#2e7bd6",
  zpA: "#ffd95a", zpB: "#ff9c2e",
  hp50: "#a2e33a", hp25: "#ffb84a", hp10: "#ff5a5a",
  tick: "rgba(255,255,255,.12)",
};

// ── actor stat paths ──────────────────────────────────────────────────────────
const P_HP_V = "system.props.current_hp";
const P_HP_M = "system.props.max_hp";
const P_MP_V = "system.props.current_mp";
const P_MP_M = "system.props.max_mp";
const P_IP_V = "system.props.current_ip";
const P_IP_M = "system.props.max_ip";
const P_ZP_V = "system.props.zero_power_value";
const ZP_MAX  = 6;

// ── custom-resource (tagged AE) reading ─────────────────────────────────────
// An Active Effect opts into the HUD by carrying `system.tags` including
// "resource". Display value/cap come from the existing charges flags
// (flags.fabula-ultima-companion.charges / chargesMax). A "points" tag (or a
// blank/zero max) renders as an uncapped running counter instead of a clock.
const RES_TAG        = "resource";
const RES_POINTS_TAG = "points";
const RES_SEG_MAX    = 12;          // beyond this many segments, use a continuous bar
const RES_ACCENT_A   = "#b98cff";   // violet → magenta — distinct from HP/MP/ZP
const RES_ACCENT_B   = "#ff79c6";

// ── per-key registry  { key → { root, cards, offFns } } ─────────────────────
const byKey = new Map();

let _socket = null;

// ── helpers ───────────────────────────────────────────────────────────────────
const pick  = (o, p) => { try { return getProperty(o, p); } catch { return undefined; } };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pct   = (v, m) => `${(clamp(v / m, 0, 1) * 100).toFixed(4)}%`;
const nice  = x => new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x) || 0)));

const pair = (a, vp, mp) => {
  const v = Number(pick(a, vp)), m = Number(pick(a, mp));
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
  return { v, m };
};
const readHP = a => pair(a, P_HP_V, P_HP_M);
const readMP = a => pair(a, P_MP_V, P_MP_M) ?? { v: 0, m: 1 };
const readIP = a => {
  const v = Number(pick(a, P_IP_V));
  let m   = Number(pick(a, P_IP_M));
  if (!Number.isFinite(m) || m <= 0) m = 6;
  return { v: Number.isFinite(v) ? clamp(v, 0, m) : 0, m };
};
const readZP = a => {
  const v = Number(pick(a, P_ZP_V));
  return { v: Number.isFinite(v) ? Math.max(0, v) : 0, m: ZP_MAX };
};

const lc = s => String(s ?? "").toLowerCase();

// Lower-cased `system.tags` array of an Active Effect (the canonical AE tag store
// — same field the Battle Director already reads to count debuffs).
function aeTags(eff) {
  const t = eff?.system?.tags;
  return Array.isArray(t) ? t.map(lc) : [];
}

// Strip the trailing noun so chips read "Brainwave 3/4" not "Brainwave Clock 3/4".
function shortResName(n) {
  const s = String(n ?? "");
  return s.replace(/\s*(clock|gauge|meter|points?)\s*$/i, "").trim() || s;
}

// Every HUD-tagged resource currently on the actor, newest-grant order.
function collectHudResources(actor) {
  const out = [], seen = new Set();
  let effs = [];
  try { effs = Array.from(actor?.allApplicableEffects?.() ?? []); } catch { effs = []; }
  for (const eff of effs) {
    if (!eff) continue;
    const tags = aeTags(eff);
    if (!tags.includes(RES_TAG)) continue;
    const uid = eff.id ?? eff.name;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const f = eff.flags?.[MODULE_ID] ?? {};
    const v    = Number(f.charges);
    const mRaw = Number(f.chargesMax);
    out.push({
      uid,
      name:   shortResName(eff.name),
      img:    eff.img ?? eff.icon ?? "",
      v:      Number.isFinite(v) ? Math.max(0, v) : 0,
      m:      Number.isFinite(mRaw) && mRaw > 0 ? mRaw : null,
      points: tags.includes(RES_POINTS_TAG),
    });
  }
  return out;
}

// An AE update/create/delete belongs to this actor if the effect's parent is the
// actor (actor-direct) or an item owned by the actor (item-granted).
function effBelongsToActor(eff, actorId) {
  const p = eff?.parent;
  if (!p) return false;
  return p.id === actorId || p.parent?.id === actorId;
}

function glideNumber(node, from, to, ms = 420) {
  if (!node) return;
  const t0 = performance.now(), d = to - from;
  function loop(t) {
    const n = Math.min(1, (t - t0) / ms);
    const e = n < 0.5 ? 2 * n * n : 1 - Math.pow(-2 * n + 2, 2) / 2;
    node.textContent = nice(from + d * e);
    if (n < 1) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function tintHp(fillEl, v, m) {
  const p = Math.max(0, Math.min(1, v / m));
  if      (p <= 0.10) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp10}, #ff7676)`;
  else if (p <= 0.25) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp25}, #ff9a5c)`;
  else if (p <= 0.50) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp50}, #89e14a)`;
  else                fillEl.style.background = `linear-gradient(90deg, ${TONE.hpA}, ${TONE.hpB})`;
}

const dotRow = (m, v) =>
  Array.from({ length: m }, (_, i) => `<i class="${i < v ? "on" : ""}"></i>`).join("");

const flash = el => {
  el.classList.remove("dhud-flash");
  void el.offsetWidth;
  el.classList.add("dhud-flash");
};

// ── CSS injection ─────────────────────────────────────────────────────────────
function mountFonts() {
  const families = [
    "family=" + encodeURIComponent("Merriweather:wght@400;600;700;900"),
    "family=" + encodeURIComponent("Merriweather:ital,wght@0,400;0,700;1,400;1,700"),
  ].join("&");
  const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  let link = document.getElementById(FONT_LINK_ID);
  if (!link) {
    link = document.createElement("link");
    link.id  = FONT_LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  mountFonts();
  const css = `
.dhud-root {
  --dhud-portrait-scale: ${HUD_PORTRAIT_SCALE};
  --dhud-hp-a: ${TONE.hpA}; --dhud-hp-b: ${TONE.hpB};
  --dhud-mp-a: ${TONE.mpA}; --dhud-mp-b: ${TONE.mpB};
  --dhud-zp-a: ${TONE.zpA}; --dhud-zp-b: ${TONE.zpB};
  --dhud-tick: ${TONE.tick};
  position: fixed; left: 1.25rem; bottom: 6rem;
  z-index: var(--z-index-canvas, 0);
  pointer-events: none; display: grid; grid-auto-flow: column; gap: .6rem;
  transform-origin: bottom left; transform: scale(1);
}
.dhud-card {
  pointer-events: auto; display: inline-flex; align-items: flex-start; gap: .6rem;
  opacity: 0; transform: translateX(-24px);
  transition: opacity 420ms ease, transform 420ms ease;
}
.dhud-card.dhud-appear { opacity: 1; transform: translateX(0); }
.dhud-portrait {
  pointer-events: none; background: transparent !important;
  filter: drop-shadow(0 18px 32px rgba(0,0,0,.55));
}
.dhud-portrait img {
  display: block; width: auto; height: auto; object-fit: contain;
  max-width:  min(calc(24vmin * var(--dhud-portrait-scale)), calc(360px * var(--dhud-portrait-scale)));
  max-height: min(calc(24vmin * var(--dhud-portrait-scale)), calc(360px * var(--dhud-portrait-scale)));
  background: transparent !important; border: none !important;
  outline: none !important; box-shadow: none !important;
}
.dhud-panel {
  position: relative; min-width: 22rem; max-width: 28rem;
  background: linear-gradient(180deg, rgba(18,18,20,0), rgba(12,12,14,0)) !important;
  border: none; border-radius: .9rem; padding: 1rem;
  box-shadow: 0 12px 28px rgba(0,0,0,0.45); backdrop-filter: blur(3px); overflow: visible;
}
.dhud-top { display: flex; align-items: center; gap: .5rem; margin-bottom: .12rem; }
.dhud-name {
  font-family: "Merriweather", system-ui, sans-serif;
  font-size: .95rem; font-weight: 700; letter-spacing: .02em; color: #fff;
  transform: skewX(-8deg);
  text-shadow: 0 4px 5px rgba(0,0,0,.98), 0 6px 16px rgba(0,0,0,.65), 0 0 3px rgba(0,0,0,.85);
  flex: 1 1 auto;
}
.dhud-ip { display: flex; gap: 6px; }
.dhud-ip i {
  width: 12px; height: 12px; border-radius: 999px;
  background: rgba(255,255,255,.25); box-shadow: 0 0 0 1px rgba(0,0,0,.25) inset;
}
.dhud-ip i.on { background: #ffb84a; }
.dhud-hpbig {
  position: relative; margin: .05rem 0 .45rem 0;
  font-family: "Merriweather", monospace;
  font-size: 2.28rem; font-style: italic; font-weight: 400; letter-spacing: .5px; color: #fff;
  text-shadow: 0 4px 6.5px rgba(0,0,0,.95), 0 6px 20px rgba(0,0,0,.55), 0 0 3px rgba(0,0,0,.85);
}
.dhud-mpmini {
  position: absolute; right: .5rem; bottom: .1rem;
  display: flex; align-items: baseline; gap: .4rem;
}
.dhud-mpmini .tag {
  font-weight: 700; font-size: .85rem; color: rgba(255,255,255,.86);
  text-shadow: 0 3px 4px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.85);
}
.dhud-mpmini .num {
  font-family: "Merriweather", monospace;
  font-size: 1.58rem; font-style: italic; color: #fff;
  text-shadow: 0 4px 6.5px rgba(0,0,0,.95), 0 6px 20px rgba(0,0,0,.55), 0 0 3px rgba(0,0,0,.85);
}
.dhud-bar {
  position: relative; height: 1rem; border-radius: .6rem; overflow: hidden;
  border: 1px solid rgba(255,255,255,.20);
  background: linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.65));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.65);
}
.dhud-fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(90deg, var(--dhud-hp-a), var(--dhud-hp-b));
  transition: width 240ms ease, background 120ms linear;
}
.dhud-ticks {
  position: absolute; inset: 0; pointer-events: none; opacity: .25;
  background-image: repeating-linear-gradient(
    to right, var(--dhud-tick) 0 1px, transparent 1px 12px
  );
}
.dhud-mp { height: .65rem; margin-top: .25rem; }
.dhud-mp .dhud-fill { background: linear-gradient(90deg, var(--dhud-mp-a), var(--dhud-mp-b)); }
.dhud-zp { height: .65rem; }
.dhud-zp .dhud-fill { background: linear-gradient(90deg, var(--dhud-zp-a), var(--dhud-zp-b)); }
.dhud-zprow { display: flex; align-items: center; gap: .5rem; margin-top: .25rem; }
.dhud-zplabel {
  font-family: "Merriweather", system-ui, sans-serif;
  font-weight: 700; letter-spacing: .06em; color: #fff; user-select: none;
  text-shadow: 0 4px 6.5px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.85);
}
.dhud-zp .dhud-fill.dhud-glow {
  filter: drop-shadow(0 0 6px rgba(80,140,255,.65)) drop-shadow(0 0 12px rgba(80,140,255,.35));
  animation: dhudZpGlow 1.2s ease-in-out infinite alternate;
}
@keyframes dhudZpGlow {
  0%   { box-shadow: 0 0 0 rgba(80,140,255,0); }
  100% { box-shadow: 0 0 22px rgba(80,140,255,.55); }
}
.dhud-flash { animation: dhudFlash .35s ease; }
@keyframes dhudFlash {
  0%   { filter: brightness(1.15); }
  100% { filter: brightness(1); }
}

/* ── custom-resource overlay ──────────────────────────────────────────────
   Floats just below the panel's bottom edge (under the ZP bar), jittered
   right. position:absolute → contributes NO layout height, so every panel
   stays the same size and the row stays aligned regardless of resource count.
   Up to 2 columns (set inline from the resource count), then wraps downward. */
.dhud-resbar {
  --dhud-res-a: ${RES_ACCENT_A}; --dhud-res-b: ${RES_ACCENT_B};
  position: absolute; top: 100%; left: 0; right: 0;
  margin-top: .3rem; transform: translateX(1.15rem);   /* jitter right */
  display: grid; justify-content: end; align-content: start;
  gap: .3rem .4rem; pointer-events: none;
}
.dhud-reschip {
  display: inline-flex; align-items: center; gap: .32rem;
  padding: .16rem .5rem .16rem .28rem; border-radius: .7rem;
  background: linear-gradient(180deg, rgba(20,16,28,.62), rgba(10,8,14,.74));
  border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 6px 16px rgba(0,0,0,.45); backdrop-filter: blur(3px);
  animation: dhudResIn .42s ease both; white-space: nowrap;
}
@keyframes dhudResIn {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dhud-resicon {
  width: 1.15rem; height: 1.15rem; border-radius: .35rem; object-fit: cover;
  flex: 0 0 auto; background: transparent !important; border: none !important;
  outline: none !important; box-shadow: 0 0 0 1px rgba(0,0,0,.5);
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.6));
}
.dhud-resname {
  font-family: "Merriweather", system-ui, sans-serif;
  font-size: .72rem; font-weight: 700; letter-spacing: .02em; color: #fff;
  transform: skewX(-8deg);
  text-shadow: 0 3px 4px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.85);
}
.dhud-resgauge { display: inline-flex; gap: 2px; align-items: center; }
.dhud-resseg {
  width: 7px; height: 11px; border-radius: 2px;
  background: rgba(255,255,255,.18); box-shadow: inset 0 0 0 1px rgba(0,0,0,.45);
  transition: background .18s ease;
}
.dhud-resseg.on {
  background: linear-gradient(180deg, var(--dhud-res-a), var(--dhud-res-b));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.35), 0 0 4px rgba(185,140,255,.55);
}
.dhud-resbar2 {
  position: relative; width: 4.5rem; height: .55rem; border-radius: .4rem;
  overflow: hidden; background: rgba(0,0,0,.5); box-shadow: inset 0 0 0 1px rgba(0,0,0,.6);
}
.dhud-resbar2fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, var(--dhud-res-a), var(--dhud-res-b));
  transition: width .24s ease;
}
.dhud-resval, .dhud-resnum {
  font-family: "Merriweather", monospace; font-weight: 700; font-style: italic;
  color: #fff; text-shadow: 0 3px 4px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.85);
}
.dhud-resval { font-size: .76rem; }
.dhud-resnum { font-size: .92rem; color: #ffe9a8; }
.dhud-respts .dhud-resnum::before {
  content: "✦"; margin-right: .18rem; color: var(--dhud-res-a);
  font-style: normal; font-size: .8em;
}
.dhud-res-full .dhud-resgauge {
  animation: dhudResPulse 1.1s ease-in-out infinite alternate;
}
@keyframes dhudResPulse {
  0%   { filter: drop-shadow(0 0 0 rgba(185,140,255,0)); }
  100% { filter: drop-shadow(0 0 6px rgba(255,121,198,.75)); }
}
.dhud-res-flash { animation: dhudFlash .35s ease; }
`;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = css;
  document.head.appendChild(st);
}

// ── custom-resource chips ───────────────────────────────────────────────────
function resChipHtml(r) {
  const icon = r.img ? `<img class="dhud-resicon" src="${r.img}" alt="">` : "";

  // Points (or any uncapped resource): icon + name + running number, no bar.
  if (r.points || !r.m) {
    return `<div class="dhud-reschip dhud-respts" data-uid="${r.uid}">
        ${icon}<span class="dhud-resname">${r.name}</span>
        <span class="dhud-resnum">${nice(r.v)}</span>
      </div>`;
  }

  // Clock: segmented gauge (continuous bar past RES_SEG_MAX segments) + N/max.
  const full = r.v >= r.m;
  const gauge = r.m <= RES_SEG_MAX
    ? `<span class="dhud-resgauge">${
        Array.from({ length: r.m }, (_, i) =>
          `<i class="dhud-resseg ${i < r.v ? "on" : ""}"></i>`).join("")
      }</span>`
    : `<span class="dhud-resbar2"><span class="dhud-resbar2fill" style="width:${pct(r.v, r.m)}"></span></span>`;

  return `<div class="dhud-reschip dhud-resclock ${full ? "dhud-res-full" : ""}" data-uid="${r.uid}">
      ${icon}<span class="dhud-resname">${r.name}</span>
      ${gauge}
      <span class="dhud-resval">${nice(r.v)}/${nice(r.m)}</span>
    </div>`;
}

// (Re)build the resource overlay that floats below the panel. Absolute + zero
// layout height, so panels stay the same size regardless of resource count.
// Up to 2 columns, then wrap downward. No tagged resources → no overlay.
function renderResources(panel, actor) {
  if (!panel) return;
  const list = collectHudResources(actor);
  let bar = panel.querySelector(".dhud-resbar");
  if (!list.length) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "dhud-resbar";
    panel.appendChild(bar);
  }
  bar.style.gridTemplateColumns = `repeat(${Math.min(list.length, 2)}, max-content)`;
  bar.innerHTML = list.map(resChipHtml).join("");
  bar.classList.remove("dhud-res-flash");
  void bar.offsetWidth;
  bar.classList.add("dhud-res-flash");
}

// ── card DOM builder ──────────────────────────────────────────────────────────
function makeCard(actor, token) {
  const hp = readHP(actor);
  if (!hp) return null;
  const mp = readMP(actor), zp = readZP(actor), ip = readIP(actor);
  const portrait = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";

  const card = document.createElement("div");
  card.className = "dhud-card";
  card.innerHTML = `
    <div class="dhud-portrait"><img src="${portrait}" alt=""></div>
    <div class="dhud-panel">
      <div class="dhud-top">
        <div class="dhud-name">${token?.name || actor?.name || "—"}</div>
        <div class="dhud-ip">${dotRow(ip.m, ip.v)}</div>
      </div>
      <div class="dhud-hpbig">
        <span class="dhud-hpcur">${nice(hp.v)}</span> / <span class="dhud-hpmax">${nice(hp.m)}</span>
        <div class="dhud-mpmini"><span class="tag">MP</span><span class="num">${nice(mp.v)}</span></div>
      </div>
      <div class="dhud-bar dhud-hp"><div class="dhud-fill dhud-hpfill"></div><div class="dhud-ticks"></div></div>
      <div class="dhud-bar dhud-mp"><div class="dhud-fill dhud-mpfill"></div></div>
      <div class="dhud-zprow">
        <div class="dhud-zplabel">ZP</div>
        <div class="dhud-bar dhud-zp" style="flex:1 1 auto; min-width:6rem;">
          <div class="dhud-fill dhud-zpfill"></div>
        </div>
      </div>
    </div>
  `;
  requestAnimationFrame(() => card.classList.add("dhud-appear"));

  const hpFill = card.querySelector(".dhud-hpfill");
  const mpFill = card.querySelector(".dhud-mpfill");
  const zpFill = card.querySelector(".dhud-zpfill");
  const hpCur  = card.querySelector(".dhud-hpcur");
  const mpNum  = card.querySelector(".dhud-mpmini .num");
  const ipRow  = card.querySelector(".dhud-ip");
  const panel  = card.querySelector(".dhud-panel");

  tintHp(hpFill, hp.v, hp.m);
  hpFill.style.width = pct(hp.v, hp.m); flash(hpFill);
  mpFill.style.width = pct(mp.v, mp.m); flash(mpFill);
  zpFill.style.width = pct(zp.v, zp.m); flash(zpFill);
  zpFill.classList.toggle("dhud-glow", zp.v >= zp.m);

  renderResources(panel, actor);

  return { el: card, hpFill, mpFill, zpFill, hpCur, mpNum, ipRow, panel };
}

function updateCard(card, actor) {
  const hp = readHP(actor);
  if (hp) {
    const prev = Number(card.hpCur?.textContent?.replace(/,/g, "")) || 0;
    glideNumber(card.hpCur, prev, hp.v, 420);
    tintHp(card.hpFill, hp.v, hp.m);
    card.hpFill.style.width = pct(hp.v, hp.m);
    flash(card.hpFill);
  }
  const mp = readMP(actor);
  if (mp) {
    const prev = Number(card.mpNum?.textContent?.replace(/,/g, "")) || 0;
    glideNumber(card.mpNum, prev, mp.v, 420);
    card.mpFill.style.width = pct(mp.v, mp.m);
    flash(card.mpFill);
  }
  const zp = readZP(actor);
  if (zp) {
    card.zpFill.style.width = pct(zp.v, zp.m);
    flash(card.zpFill);
    card.zpFill.classList.toggle("dhud-glow", zp.v >= zp.m);
  }
  const ip = readIP(actor);
  if (ip && card.ipRow) card.ipRow.innerHTML = dotRow(ip.m, ip.v);
}

// ── root scaling (matches OniHud2 breakpoints) ────────────────────────────────
function scaleRoot(root, count) {
  const vmin   = Math.min(window.innerWidth, window.innerHeight);
  const base   = clamp(vmin / 1080, 0.75, 1.15);
  const factor = count >= 4 ? 0.78 : count === 3 ? 0.85 : 1.00;
  root.style.transform = `scale(${(base * factor * HUD_UI_SCALE).toFixed(4)})`;
}

// ── build / destroy by key ────────────────────────────────────────────────────
function buildLocally(key, entries) {
  destroyLocally(key);
  injectStyles();

  const root = document.createElement("div");
  root.className = "dhud-root";
  root.id = `dhud-root-${key}`;
  document.body.appendChild(root);

  const offFns = [];
  const cards  = new Map();

  for (const { actor, token } of entries) {
    if (!actor) continue;
    const card = makeCard(actor, token);
    if (!card) continue;

    const setName = nm => {
      const el = card.el.querySelector(".dhud-name");
      if (el) el.textContent = nm;
    };

    const h1 = Hooks.on("updateActor", (doc, diff) => {
      if (doc?.id !== actor.id) return;
      if (typeof diff?.name === "string") setName(diff.name);
      const live = game.actors?.get(actor.id);
      if (live) updateCard(card, live);
    });
    const h2 = Hooks.on("updateToken", (tok, chg) => {
      if (tok?.actor?.id !== actor.id) return;
      if (typeof chg?.name === "string") setName(chg.name || tok?.actor?.name);
      if (tok.actor) updateCard(card, tok.actor);
    });

    // Custom resources live on Active Effect charge flags, so they change via
    // the AE hooks (not updateActor). Rebuild only the resource overlay — kept
    // off updateCard so an HP tick doesn't flash the gauges.
    const onAE = eff => {
      if (!effBelongsToActor(eff, actor.id)) return;
      const live = game.actors?.get(actor.id);
      if (live) renderResources(card.panel, live);
    };
    const h3 = Hooks.on("createActiveEffect", onAE);
    const h4 = Hooks.on("updateActiveEffect", onAE);
    const h5 = Hooks.on("deleteActiveEffect", onAE);
    offFns.push(
      () => Hooks.off("updateActor", h1),
      () => Hooks.off("updateToken", h2),
      () => Hooks.off("createActiveEffect", h3),
      () => Hooks.off("updateActiveEffect", h4),
      () => Hooks.off("deleteActiveEffect", h5),
    );

    root.appendChild(card.el);
    cards.set(actor.id, card);
  }

  scaleRoot(root, cards.size);
  byKey.set(key, { root, cards, offFns });
  log(`[DirectorHud] built key=${key} cards=${cards.size}`);
}

function destroyLocally(key) {
  const owner = byKey.get(key);
  if (!owner) {
    document.getElementById(`dhud-root-${key}`)?.remove();
    return;
  }
  for (const fn of owner.offFns) { try { fn(); } catch { /* */ } }
  owner.offFns.length = 0;
  owner.root?.remove();
  owner.cards.clear();
  byKey.delete(key);
  log(`[DirectorHud] destroyed key=${key}`);
}

// ── socket ────────────────────────────────────────────────────────────────────
function ensureSocket() {
  if (_socket) return _socket;
  const sockMod = game.modules?.get("socketlib");
  if (!sockMod?.active || !window.socketlib) return null;

  const socket = window.socketlib.registerModule(MODULE_ID);

  socket.register(ACTION_BUILD, ({ key, actorIds } = {}) => {
    try {
      const entries = (actorIds ?? [])
        .map(id => ({ actor: game.actors?.get(id), token: null }))
        .filter(e => e.actor);
      buildLocally(key, entries);
    } catch (e) { warn("[DirectorHud] socket BUILD error:", e); }
  });

  socket.register(ACTION_DESTROY, ({ key } = {}) => {
    try { destroyLocally(key); }
    catch (e) { warn("[DirectorHud] socket DESTROY error:", e); }
  });

  _socket = socket;
  return _socket;
}

// ── reload gate ───────────────────────────────────────────────────────────────
function tryReloadRecovery(trigger) {
  const key      = canvas?.scene?.getFlag(MODULE_ID, FLAG_KEY);
  const actorIds = canvas?.scene?.getFlag(MODULE_ID, FLAG_ACTORS);
  if (!key || !actorIds?.length) return;
  if (byKey.has(key)) return;
  log(`[DirectorHud] reload-recovery (${trigger}): rebuilding key=${key}`);
  const entries = actorIds
    .map(id => ({ actor: game.actors?.get(id), token: null }))
    .filter(e => e.actor);
  if (entries.length) buildLocally(key, entries);
}

// ── self-registration (runs on every client via side-effect import) ───────────
Hooks.once("ready", () => {
  ensureSocket();
  tryReloadRecovery("ready");
});
Hooks.on("canvasReady",    () => tryReloadRecovery("canvasReady"));
Hooks.on("canvasTearDown", () => {
  for (const key of byKey.keys()) destroyLocally(key);
});

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Build the player HUD on all clients and write reload-gate scene flags.
 * Call from the GM after entrance animations complete; fire-and-forget is safe.
 *
 * @param {Array<{actor: Actor, token: TokenDocument|null}>} entries  Party members.
 * @param {Scene} scene  The active battle scene (used for flag storage + key).
 */
export async function buildDirectorHud(entries, scene) {
  if (!entries?.length || !scene) return;
  const key      = `director-${scene.id}`;
  const valid    = entries.filter(e => e.actor);
  const actorIds = valid.map(e => e.actor.id);
  if (!actorIds.length) return;

  // Write flags before broadcasting so any client that reloads mid-broadcast
  // will find them on its next canvasReady.
  await Promise.all([
    scene.setFlag(MODULE_ID, FLAG_KEY,    key),
    scene.setFlag(MODULE_ID, FLAG_ACTORS, actorIds),
  ]);

  const socket = ensureSocket();
  if (socket) {
    // GM builds with full token refs (correct token names).
    // Other clients receive actorIds and resolve via game.actors.
    buildLocally(key, valid);
    socket.executeForOthers(ACTION_BUILD, { key, actorIds });
  } else {
    buildLocally(key, valid);
  }
}

/**
 * Destroy the player HUD on all clients and clear reload-gate scene flags.
 * Called from Stopped.onEnter.
 *
 * @param {Scene} scene  The active battle scene.
 */
export async function destroyDirectorHud(scene) {
  if (!scene) return;
  const key = scene.getFlag(MODULE_ID, FLAG_KEY) ?? `director-${scene.id}`;

  const socket = ensureSocket();
  if (socket) {
    await socket.executeForEveryone(ACTION_DESTROY, { key });
  } else {
    destroyLocally(key);
  }

  await Promise.all([
    scene.unsetFlag(MODULE_ID, FLAG_KEY).catch(() => {}),
    scene.unsetFlag(MODULE_ID, FLAG_ACTORS).catch(() => {}),
  ]);
}
