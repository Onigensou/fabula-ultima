// spell-fencer-cues.js — the Spell Fencer's four rhythm auras, drawn by status-cues.js (same DOM layer, same technique and scale
// as burn / poison / berserk: CSS particles sized by k = sprite height / 250, seeded per token so a rebuild never reshuffles them).
//
// PORTED VERBATIM from the approved mockup's cue code (tools/move-engine/moves/spell-fencer/page/part-cues.js, page
// https://claude.ai/artifact/94H4XUhvbu42SzSYknv5e7). Every number lives in CUE_P / CUE_COLS below: after a review round, fold
// the approved slider values in HERE and nowhere else (feedback: mockup = spec, port exactly).
//
//   sfspell   AE "Next Spell"     (last action was a weapon attack)  soft BLUE aura: slow rising pixel motes + blue underglow
//   sfattack  AE "Next Attack"    (last action was an Offensive Spell) soft RED aura, calmer than berserk
//   sfreso    Resonance ready     an AE with chargeKey "resonance" holding 2+ charges (keyed off the charge key, NEVER the AE name:
//                                 Chanter's skill is also called Resonance): gold / violet motes orbiting the waist + rising notes
//   sfbraid   AE "Rhapsody Turn"  red and blue motes braiding up in a double helix; while held it hides the other three
//
// The marker AEs → cue ids mapping is status-classifier.js STATUS_CUES ("next spell", "next attack", "rhapsody turn").

const NS = "fabula-ultima-companion";

export const CUE_P = {
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

const SF_CUES = ["sfspell", "sfattack", "sfreso", "sfbraid"];

/** Add / drop the Spell Fencer cues on a cue set built from the actor's AEs (status-cues.js cuesOf). */
export function applySpellFencerCues(actor, cues) {
  let reso = 0;
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const f = e.flags?.[NS];
      if (String(f?.chargeKey ?? "") === "resonance") reso = Math.max(reso, Number(f?.charges) || 0);
    }
  } catch { /* */ }
  if (reso >= 2) cues.add("sfreso");
  if (cues.has("sfbraid")) { cues.delete("sfspell"); cues.delete("sfattack"); cues.delete("sfreso"); }
  return cues;
}
export const isSpellFencerCue = (c) => SF_CUES.includes(c);

/** CSS appended to status-cues.js's stylesheet. Orbit / helix keyframes are generated (12 / 16 steps). */
export function sfCueCss() {
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
.fu-cue .sfn svg { position: static; width: 100%; height: 100%; }
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

/** The cue blocks for one token (id = token id for the seed, w × H = the drawn sprite rect). rng / px = status-cues.js helpers. */
export function sfCueHTML(id, cues, w, H, rng, px, P = CUE_P) {
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
