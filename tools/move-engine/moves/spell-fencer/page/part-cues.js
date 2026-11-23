// ═════════ Spell Fencer status cues — the PORT SOURCE for battle-director/status-cues.js (same technique, same scale)
// A DOM layer docked to the rendered sprite rect; CSS-animated <i>/<svg> particles sized by k = sprite height / REF_H (250),
// seeded per token (rng(id + letter)) so a rebuild does not reshuffle them. On the page the layer docks to Keren's drawn
// rect every frame (unit-anchors spriteRect in the game) and hides during an action animation (fuBattleMarksHidden).
//
//   sfspell   Next Spell    soft BLUE aura: slow rising pixel motes + faint blue underglow at the feet
//   sfattack  Next Attack   soft RED aura, same language (calmer than berserk: 7 motes at 2.6-3.8 s vs 9 streaks at 0.55-0.9 s,
//                           a slow 2.6 s breathing underglow vs a .5 s throb, square pixel motes vs long streaks, no body wash)
//   sfreso    Resonance ready (2+ stacks): gold / violet motes orbiting the waist + an occasional pixel music note rising;
//                           layers on top of sfspell / sfattack
//   sfbraid   Rhapsody Turn  red and blue motes braiding up in a double helix + a red / blue underglow
// Precedence (sfPick): sfbraid hides sfspell / sfattack / sfreso while it is held (the sandbox's "both" mode).
//
// CUE_P holds every number (the page's cue sliders write it; the port bakes the approved values as constants).
const CUE_P = {
  spell: { n: 7, dmin: 2.6, dmax: 3.8, size: 7, rise: 0.45, glow: 0.55, breathe: 2.6, col: 0 },
  attack: { n: 7, dmin: 2.6, dmax: 3.8, size: 7, rise: 0.45, glow: 0.55, breathe: 2.6, col: 0 },
  reso: { n: 6, period: 3.2, size: 7, rx: 0.42, ry: 12, notes: 2, noteEvery: 4.2, cell: 3.5 },
  braid: { n: 8, period: 2.4, size: 6, r: 0.3, turns: 1.25, glow: 0.4 },
};
const CUE_COLS = {
  spell: [["#e0f2ff", "#a8d8ff", "77,166,255"], ["#f2fbff", "#cfeaff", "130,200,255"], ["#d8ecff", "#6fb6ff", "40,120,240"]],
  attack: [["#ffe0d0", "#ffb199", "255,77,61"], ["#fff0e8", "#ffcab8", "255,120,100"], ["#ffd0c0", "#ff7a66", "220,40,30"]],
};
const SF_NOTE_ROWS = ["..##.", "..#.#", "..#..", "..#..", "###..", "###..", ".#..."];
const sfNoteSvg = (fill) => `<svg viewBox="0 0 5 7" shape-rendering="crispEdges">${SF_NOTE_ROWS.map((r, y) => [...r].map((c, x) => (c === "#" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : "")).join("")).join("")}</svg>`.replace("<svg ", `<svg fill="${fill}" `);

// ── CSS (status-cues.js ensureStyles: append to its st.textContent). Orbit / helix keyframes are generated (12 / 16 steps).
function sfCueCss() {
  const orbit = [], helA = [], helB = [];
  for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), back = s < 0;
    orbit.push(`${(i / 12 * 100).toFixed(2)}% { transform: translate(calc(var(--rx) * ${c.toFixed(3)}), calc(var(--ry) * ${s.toFixed(3)})) scale(${back ? .7 : 1}); opacity: ${back ? .35 : 1}; }`); }
  for (let i = 0; i <= 16; i++) { const u = i / 16, fade = u < .12 ? u / .12 : u > .85 ? (1 - u) / .15 : 1;
    for (const [arr, ph] of [[helA, 0], [helB, Math.PI]]) { const a = u * Math.PI * 2 * 1 + ph, s = Math.sin(a), c = Math.cos(a), back = c < 0;
      arr.push(`${(u * 100).toFixed(2)}% { transform: translate(calc(var(--r) * ${s.toFixed(3)}), calc(var(--rise) * ${u.toFixed(3)})) scale(${back ? .7 : 1}); opacity: ${((back ? .4 : 1) * fade).toFixed(3)}; }`); } }
  return `
/* spell fencer: Next Spell / Next Attack (calm aura) */
.fu-cue .sfg { left: 10%; right: 10%; bottom: 0; height: 12%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(var(--rgb), var(--ga)), rgba(var(--rgb), 0) 70%); animation: fuCueSfBreathe var(--br) ease-in-out infinite alternate; }
.fu-cue .sfm { width: var(--s); height: var(--s); margin-left: calc(var(--s) * -.5); background: var(--c1);
  box-shadow: 0 0 0 calc(var(--s) * .25) var(--c2), 0 0 calc(var(--s) * 2) rgba(var(--rgb), .85); opacity: 0; animation: fuCueSfRise 3s ease-out infinite; }
@keyframes fuCueSfBreathe { from { opacity: .45; transform: scaleX(.95); } to { opacity: .9; transform: scaleX(1.04); } }
@keyframes fuCueSfRise { 0% { transform: translate(0, 0); opacity: 0; } 18% { opacity: 1; } 70% { opacity: .85; }
  100% { transform: translate(var(--w), var(--rise)); opacity: 0; } }
/* spell fencer: Resonance ready (orbit at the waist + rising notes) */
.fu-cue .sfo { width: var(--s); height: var(--s); margin: calc(var(--s) * -.5) 0 0 calc(var(--s) * -.5); background: var(--c1);
  box-shadow: 0 0 calc(var(--s) * 1.6) var(--c2); animation: fuCueSfOrbit 3.2s linear infinite; }
.fu-cue .sfn { width: calc(var(--u) * 5); height: calc(var(--u) * 7); overflow: visible; opacity: 0;
  filter: drop-shadow(0 0 2px rgba(255,208,74,.8)); animation: fuCueSfNote 4.2s ease-out infinite; }
@keyframes fuCueSfOrbit { ${orbit.join(" ")} }
@keyframes fuCueSfNote { 0% { transform: translate(0, 0); opacity: 0; } 6% { opacity: 1; } 30% { opacity: .9; }
  40% { transform: translate(var(--dx), var(--rise)); opacity: 0; } 100% { transform: translate(var(--dx), var(--rise)); opacity: 0; } }
/* spell fencer: Rhapsody Turn (red + blue double helix) */
.fu-cue .sfbg { left: 8%; right: 8%; bottom: 0; height: 12%; border-radius: 50%;
  background: radial-gradient(ellipse at 30% 50%, rgba(255,77,61,var(--ga)), rgba(255,77,61,0) 55%), radial-gradient(ellipse at 70% 50%, rgba(77,166,255,var(--ga)), rgba(77,166,255,0) 55%);
  animation: fuCueSfBreathe 2.2s ease-in-out infinite alternate; }
.fu-cue .sfh { width: var(--s); height: var(--s); margin-left: calc(var(--s) * -.5); opacity: 0; animation: fuCueSfHelixA 2.4s linear infinite; }
.fu-cue .sfh.r { background: #ffb199; box-shadow: 0 0 calc(var(--s) * 1.8) rgba(255,77,61,.95); }
.fu-cue .sfh.b { background: #a8d8ff; box-shadow: 0 0 calc(var(--s) * 1.8) rgba(77,166,255,.95); animation-name: fuCueSfHelixB; }
@keyframes fuCueSfHelixA { ${helA.join(" ")} }
@keyframes fuCueSfHelixB { ${helB.join(" ")} }
`;
}

// ── HTML (status-cues.js cueHTML: add these blocks; r / d / px / rng are that file's own helpers)
function sfCueHTML(id, cues, w, H, P = CUE_P) {
  const k = H / 250; let h = "", r, d;
  for (const key of ["spell", "attack"]) {
    if (!cues.has("sf" + key)) continue;
    const p = P[key], [c1, c2, rgb] = CUE_COLS[key][p.col] || CUE_COLS[key][0];
    r = rng(id + (key === "spell" ? "s" : "a"));
    h += `<i class="sfg" style="--rgb:${rgb};--ga:${p.glow};--br:${p.breathe}s"></i>`;
    for (let i = 0; i < p.n; i++) {
      d = p.dmin + r() * (p.dmax - p.dmin);
      h += `<i class="sfm" style="--c1:${c1};--c2:${c2};--rgb:${rgb};left:${px(w * (0.18 + r() * 0.64))};bottom:${px(H * (0.02 + r() * 0.33))};--s:${px(Math.max(2, (p.size - 1 + r() * 2) * k))};--w:${px((r() * 16 - 8) * k)};--rise:${px(-H * p.rise)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("sfreso")) {
    const p = P.reso; r = rng(id + "r");
    const cx = w * 0.5, cy = H * 0.55;
    for (let i = 0; i < p.n; i++) {
      const gold = i % 2 === 0;
      h += `<i class="sfo" style="left:${px(cx)};top:${px(cy)};--rx:${px(w * p.rx)};--ry:${px(p.ry * k)};--s:${px(Math.max(2, p.size * k))};--c1:${gold ? "#ffe08a" : "#d8c2ff"};--c2:${gold ? "rgba(255,208,74,.9)" : "rgba(184,140,255,.9)"};animation-duration:${p.period}s;animation-delay:-${(i / p.n * p.period).toFixed(2)}s"></i>`;
    }
    for (let i = 0; i < p.notes; i++) {
      const u = Math.max(1.5, p.cell * k), left = i % 2 ? 0.74 : 0.2;
      h += `<span class="sfn" style="left:${px(w * left)};top:${px(H * (0.5 + r() * 0.1))};--u:${u.toFixed(2)}px;--dx:${px((i % 2 ? 6 : -6) * k)};--rise:${px(-H * 0.32)};animation-duration:${p.noteEvery}s;animation-delay:-${(i * p.noteEvery / Math.max(1, p.notes) + r() * 0.6).toFixed(2)}s">${sfNoteSvg(i % 2 ? "#b88cff" : "#ffd04a")}</span>`;
    }
  }
  if (cues.has("sfbraid")) {
    const p = P.braid;
    h += `<i class="sfbg" style="--ga:${p.glow}"></i>`;
    for (const strand of ["r", "b"]) for (let i = 0; i < p.n; i++) {
      h += `<i class="sfh ${strand}" style="left:${px(w * 0.5)};bottom:${px(H * 0.04)};--r:${px(w * p.r)};--rise:${px(-H * 0.86)};--s:${px(Math.max(2, p.size * k))};animation-duration:${p.period}s;animation-delay:-${(i / p.n * p.period).toFixed(2)}s"></i>`;
    }
  }
  return h;
}

// ── which Spell Fencer cues show (status-cues.js: from the actor's AEs; the page: from the sandbox state)
//   next spell   → sfspell     (AE "Next Spell", status fud-next-spell)
//   next attack  → sfattack    (AE "Next Attack", status fud-next-attack)
//   rhapsody turn → sfbraid    (AE "Rhapsody Turn", status fud-rhapsody-turn)
//   sfreso: an AE with flags chargeKey "resonance" and charges >= 2 (key off the chargeKey, NEVER the name: Chanter's Resonance)
function sfPick({ next = null, reso = 0, rhap = false } = {}) {
  const s = new Set();
  if (rhap) { s.add("sfbraid"); return s; }
  if (next === "spell") s.add("sfspell"); else if (next === "attack") s.add("sfattack");
  if (reso >= 2) s.add("sfreso");
  return s;
}

// ═════════ page-only: the docked layer (status-cues.js renderCues / place do this in the game)
const rng = (seed) => { let s = 7; for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const px = (v) => `${Math.round(v)}px`;
const CUE = { el: null, sig: "", cues: new Set(), hidden: false, a: null, w: 0, h: 0, berserk: false };
{ const st = document.createElement("style"); st.textContent = `
.fu-cue { position: absolute; left: 0; top: 0; pointer-events: none; transition: opacity 250ms ease; }
.fu-cue.is-anim-hidden { opacity: 0 !important; }
.fu-cue i, .fu-cue b, .fu-cue svg, .fu-cue span { position: absolute; display: block; }
/* berserk (status-cues.js, verbatim) — for the side-by-side only */
.fu-cue .bz { left: 4%; right: 4%; bottom: 0; height: 16%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(255,40,30,.75), rgba(200,0,0,0) 70%); animation: fuCueRage .5s ease-in-out infinite alternate; }
.fu-cue .bs { width: calc(var(--s) * .32); height: var(--s); margin-left: calc(var(--s) * -.16); border-radius: 50%;
  background: linear-gradient(to top, rgba(255,40,30,0), rgba(255,60,40,.95) 45%, #ffd0c0); filter: drop-shadow(0 0 3px rgba(255,30,20,.9));
  opacity: 0; animation: fuCueRageUp .7s ease-in infinite; }
@keyframes fuCueRage { from { opacity: .55; transform: scaleX(.92); } to { opacity: 1; transform: scaleX(1.06); } }
@keyframes fuCueRageUp { 0% { transform: translateY(0) scaleY(.4); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(var(--rise)) scaleY(1.1); opacity: 0; } }
.fu-cue .sfn svg { position: static; width: 100%; height: 100%; }
` + sfCueCss(); document.head.appendChild(st); }
// berserk's own cueHTML block (status-cues.js), so the two reds can be compared on the same body
function berserkHTML(id, w, H) { const k = H / 250, r = rng(id + "z"); let h = `<i class="bz"></i>`, d;
  for (let i = 0; i < 9; i++) { d = 0.55 + r() * 0.35; const side = i % 2 ? 1 : 0;
    h += `<i class="bs" style="left:${px(w * (side ? 0.62 + r() * 0.22 : 0.16 + r() * 0.22))};bottom:${px(H * (0.1 + r() * 0.55))};--s:${px((22 + r() * 16) * k)};--rise:${px(-60 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`; }
  return h; }
function cueMount(a) { CUE.a = a; CUE.el = document.createElement("div"); CUE.el.className = "fu-cue"; CUE.el.id = "sfcue"; CUE.el.style.zIndex = 4400;
  $("field").insertBefore(CUE.el, $("ffx")); requestAnimationFrame(cueTick); }
function cueSet(cues) { CUE.cues = cues; cueRender(true); }
function cueHide(h) { CUE.hidden = h; if (CUE.el) CUE.el.classList.toggle("is-anim-hidden", h); }
// the drawn sprite rect of a battler on the stage (field coords): what unit-anchors spriteRect gives in the game
function cueRect(a) { const w = a.wb * a.s * (a.kx ?? 1), h = a.hb * a.s * (a.ky ?? 1); return { left: OX(a) - w / 2, top: OY(a) - (a.lift || 0) - h, width: w, height: h }; }
function cueRender(force) { if (!CUE.el || !CUE.a) return; const R = cueRect(CUE.a);
  const sig = [...CUE.cues].sort().join(",") + (CUE.berserk ? "|bz" : "") + "|" + JSON.stringify(CUE_P);
  if (force || sig !== CUE.sig || Math.abs(R.height - CUE.h) > CUE.h * .08) {
    CUE.el.innerHTML = (CUE.berserk ? berserkHTML("keren", R.width, R.height) : "") + sfCueHTML("keren", CUE.cues, R.width, R.height);
    CUE.el.style.setProperty("--k", (R.height / 250).toFixed(3)); CUE.sig = sig; CUE.w = R.width; CUE.h = R.height; } }
function cueTick() { if (CUE.el && CUE.a) { const R = cueRect(CUE.a);
  Object.assign(CUE.el.style, { transform: `translate(${Math.round(R.left)}px, ${Math.round(R.top)}px)`, width: Math.round(R.width) + "px", height: Math.round(R.height) + "px" });
  if (Math.abs(R.height - CUE.h) > CUE.h * .08) cueRender(true); }
  requestAnimationFrame(cueTick); }
