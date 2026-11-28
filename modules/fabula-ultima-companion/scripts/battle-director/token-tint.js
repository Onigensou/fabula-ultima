// AE-driven token body tint — a creature's sprite takes on a colour for as long
// as an Active Effect says so.
//
// Built for King Gorger's Elemental Overflow: the companion belches a Wellspring
// onto the Field and its body glows that element's colour until the Wellspring
// runs out. "Until it runs out" is the LIFETIME OF AN AE (the 1-round Field AE
// the chain applies), so the tint is bound to that AE rather than to the
// one-shot wave cinematic — a replaced Wellspring recolours, an expired one
// clears, and an F5 mid-fight comes back tinted.
//
// Deliberately GENERIC: any AE on any actor can carry it.
//
//   flags.fabula-ultima-companion.tokenTint         "#rrggbb" / css colour — the tint
//   flags.fabula-ultima-companion.tokenTintMode     "multiply" (default) | "recolor"
//   flags.fabula-ultima-companion.tokenTintTarget   "bearer" (default) | "applier"
//   flags.fabula-ultima-companion.tokenTintStrength 0..1 (default 1)
//
// A third mode, "grade" (a colour matrix + gamma + rim glow, see "Grade mode"
// below), is reachable only through the status tint provider (the Zombie
// status), never through these flags.
//
// Two MODES, because "tint the body" means two different things:
//   multiply — classic mesh.tint: every pixel is multiplied by the colour, so a
//              white belly turns the colour too and the whole sprite is dyed
//              (a Frozen-blue / Poisoned-green status wash).
//   recolor  — a fragment-shader filter that keys on SATURATION: pixels that
//              already carry colour are re-hued to the tint colour at their own
//              brightness, while white / grey / black pixels (highlights, outlines)
//              are left exactly as drawn. The sprite keeps its shading and its
//              whites and only "changes element" (King Gorger's rainbow scales →
//              ice-blue scales, belly still white). `tokenTintStrength` is the
//              mix amount in both modes.
//
// `applier` tints the token of the actor that APPLIED the AE (read from the
// director's `directorAppliedBy.reactorActorUuid` stamp) instead of its bearer.
// That is the Field case: the Wellspring AE lives on the hidden Field actor,
// but the creature that should glow is the one that produced it.
//
// ARCHITECTURE — same shape as aspect-aura.js:
//   - Fully AE-replication-driven: the AE replicates to every client, each
//     client resolves its own tints off create/update/deleteActiveEffect. Zero
//     socket traffic; F5-safe via the canvasReady rescan.
//   - multiply writes `token.mesh.tint` (composed with the document's own texture
//     tint); recolor pushes ONE shared filter instance onto `token.mesh.filters`.
//     Foundry re-stamps mesh.tint from the document on every refresh
//     (_refreshMesh), so the refreshToken / drawToken hooks re-assert; a
//     per-frame ticker runs ONLY while a tint is fading in/out.
//   - Fade: ~500 ms in, ~700 ms out, so a Wellspring swap reads as a wash rather
//     than a hard cut.
//
// Cinematic clones (oni.cloneToken) copy mesh.tint AND mesh.filters, so a tinted
// body stays tinted through its own animation.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

const FADE_IN_MS = 500;
const FADE_OUT_MS = 700;

// tokenId -> { mode, color:[r,g,b], strength, cur, from, tgt (progress 0..1), t0, dur }
const _tints = new Map();
let _tickerOn = false;
let _hooksOn = false;

/* ── Colour helpers ─────────────────────────────────────────────────────── */

const WHITE = [1, 1, 1];

function parseColor(css) {
  try {
    const c = foundry.utils.Color.from(css);
    if (!Number.isFinite(Number(c))) return null;
    return [c.r, c.g, c.b];
  } catch { return null; }
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mul3(a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; }
function toHexNumber(rgb) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(rgb[0]) << 16) | (q(rgb[1]) << 8) | q(rgb[2]);
}
function same3(a, b) { return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3; }

/* ── Recolor filter ─────────────────────────────────────────────────────── */
//
// Saturation-keyed hue replacement. For each pixel: s = HSV saturation, l =
// luminance. Neutral pixels (s below uSatFloor) pass through; saturated ones
// become the tint colour scaled to the pixel's own luminance (so shading, the
// darker scale edges and the bright highlights survive), mixed by uStrength.
// Premultiplied alpha is unpacked / repacked around the maths.
const RECOLOR_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 uTint;
uniform float uStrength;
uniform float uSatFloor;
void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.001) { gl_FragColor = c; return; }
  vec3 rgb = c.rgb / c.a;
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float sat = mx <= 0.0 ? 0.0 : (mx - mn) / mx;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float lum = dot(rgb, LUMA);
  vec3 target = clamp(uTint * (lum / max(dot(uTint, LUMA), 0.0001)), 0.0, 1.0);
  float m = smoothstep(uSatFloor, uSatFloor + 0.25, sat) * uStrength;
  vec3 o = mix(rgb, target, m);
  gl_FragColor = vec4(o * c.a, c.a);
}`;

// Built lazily: PIXI is a canvas-time global, and this module is imported at
// boot by director-boot before any filter is needed.
let _RecolorFilter = null;
function makeRecolorFilter() {
  if (!_RecolorFilter) {
    _RecolorFilter = class RecolorFilter extends PIXI.Filter {
      constructor() {
        super(undefined, RECOLOR_FRAG, { uTint: [1, 1, 1], uStrength: 0, uSatFloor: 0.18 });
        this.fudTokenTint = true;
      }
    };
  }
  return new _RecolorFilter();
}

/* ── Grade mode (a colour grade + gamma + outer rim glow) ──────────────── */
//
// Built for the Zombie status (approved 2026-11-28, claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX,
// section "Zombie"). `mesh.tint` can only multiply; the approved look is a
// pipeline, run in this order (the mockup's order bar):
//   sprite → saturation → contrast → drain → exposure → tint (blend) → brightness lift
//          → gamma → rim glow
// Everything up to the brightness lift is linear, so it folds into ONE 3×4 colour
// matrix per token (built once, never per frame). Gamma is not linear: it is a
// per-channel pow() in the same shader pass. The rim glow is the mockup's CSS
// `drop-shadow(0 0 R px rim)`: a Gaussian blur of the sprite's alpha (σ = R/2),
// filled with the rim colour and drawn BEHIND the sprite — two cheap 1-D blur
// passes. Neutral values (saturation 1, contrast 1, drain 0, exposure 1, tint 0,
// lift 0, gamma 1, glow 0) give the identity: the sprite as drawn.
//
// The maths is a straight port of the mockup's buildMatrix / hueShift (pure, so
// the tests can check it without Foundry).

export const IDENTITY_3X4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
const LW = [0.299, 0.587, 0.114];
// 3×4 row-major [r g b offset] per row; B·A (A first).
function mm(B, A) {
  const o = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) o.push(B[i * 4] * A[j] + B[i * 4 + 1] * A[4 + j] + B[i * 4 + 2] * A[8 + j]);
    o.push(B[i * 4] * A[3] + B[i * 4 + 1] * A[7] + B[i * 4 + 2] * A[11] + B[i * 4 + 3]);
  }
  return o;
}
function diag(a, b, c, o = [0, 0, 0]) { return [a, 0, 0, o[0], 0, b, 0, o[1], 0, 0, c, o[2]]; }
function satM(s) {
  return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0];
}
/** Rotate an rgb (0..1) colour's hue by `deg` in HSL (the mockup's hueShift). */
export function hueShiftHsl(c, deg) {
  const [r, g, b] = c; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  h = ((h + deg / 360) % 1 + 1) % 1;
  const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
}
/**
 * The grade's colour matrix (3×4 row-major). `tint` = rgb 0..1, `str` = tint amount,
 * `blend` = "mul" (multiply, = today's mesh.tint wash) | "col" (colour, keep lightness)
 * | "scr" (screen). Port of the mockup's buildMatrix.
 */
export function buildGradeMatrix({ sat = 1, con = 1, drain = 0, exp = 1, blend = "mul", tint = [1, 1, 1], str = 0, bright = 0 } = {}) {
  const C = tint, a = str, b = bright;
  let M = IDENTITY_3X4.slice();
  M = mm(satM(sat), M);
  M = mm(diag(con, con, con, [0.5 - 0.5 * con, 0.5 - 0.5 * con, 0.5 - 0.5 * con]), M);
  M = mm(satM(1 - drain), M);
  M = mm(diag(exp, exp, exp), M);
  let Tm;
  if (blend === "mul") Tm = diag(1 + (C[0] - 1) * a, 1 + (C[1] - 1) * a, 1 + (C[2] - 1) * a);
  else if (blend === "scr") Tm = diag(1 - a * C[0], 1 - a * C[1], 1 - a * C[2], [a * C[0], a * C[1], a * C[2]]);
  else {
    // colour, keep lightness: x -> lerp(x, L(x)·C/L(C), a)
    const Lc = LW[0] * C[0] + LW[1] * C[1] + LW[2] * C[2] || 1; Tm = [];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) Tm.push((i === j ? 1 - a : 0) + a * C[i] / Lc * LW[j]); Tm.push(0); }
  }
  M = mm(Tm, M);
  M = mm(diag(1 - b * C[0], 1 - b * C[1], 1 - b * C[2], [b * C[0], b * C[1], b * C[2]]), M);   // brightness: screen lift toward the tint
  return M;
}
/**
 * A full grade spec from the mockup's config names: { tintHex, hue, sat, con, drain, exp,
 * blend, str, bright, gamma, glow, glowPx, refH }. Returns the frozen object token-tint
 * carries per token: { key, matrix, gamma, glow, glowPx, refH, rim }.
 */
export function makeGradeSpec(cfg) {
  const hex = String(cfg.tintHex ?? "#ffffff").replace("#", "");
  const base = [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
  const tint = hueShiftHsl(base, Number(cfg.hue) || 0);
  const matrix = buildGradeMatrix({ ...cfg, tint });
  // Rim = the tint colour lightened 35% toward white (mockup applyTint).
  const rim = tint.map((x) => Math.round((x + (1 - x) * 0.35) * 255) / 255);
  return Object.freeze({
    key: JSON.stringify(cfg), matrix: Object.freeze(matrix), gamma: Number(cfg.gamma) || 1,
    glow: Number(cfg.glow) || 0, glowPx: Number(cfg.glowPx) || 0, refH: Number(cfg.refH) || 250, rim: Object.freeze(rim), tint,
  });
}
/** The grade at fade progress p (0 = the sprite as drawn, 1 = the full look). */
export function gradeAt(spec, p) {
  const t = Math.max(0, Math.min(1, Number(p) || 0));
  const matrix = spec.matrix.map((v, i) => IDENTITY_3X4[i] + (v - IDENTITY_3X4[i]) * t);
  return { matrix, exponent: 1 / (1 + (spec.gamma - 1) * t), glowA: spec.glow * t };
}
// Column-major mat3 + offset vector for the shader.
function matUniforms(m) {
  return { m3: new Float32Array([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]), off: new Float32Array([m[3], m[7], m[11]]) };
}

const GRADE_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform mat3 uM;
uniform vec3 uO;
uniform float uExp;
void main(void) {
  vec4 c = texture2D(uSampler, vTextureCoord);
  if (c.a <= 0.0001) { gl_FragColor = vec4(0.0); return; }
  vec3 rgb = clamp(uM * (c.rgb / c.a) + uO, 0.0, 1.0);
  rgb = pow(rgb, vec3(uExp));
  gl_FragColor = vec4(rgb * c.a, c.a);
}`;
// 1-D Gaussian of the alpha channel, 12 taps each side at σ/4 (covers 3σ).
const BLUR_H_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform highp vec4 inputSize;   // highp: must match the filter vertex shader
uniform highp vec4 inputClamp;
uniform vec2 uStep;
void main(void) {
  float s = 0.0, w = 0.0;
  for (int i = -12; i <= 12; i++) {
    float fi = float(i);
    float wi = exp(-0.5 * fi * fi / 16.0);
    vec2 uv = clamp(vTextureCoord + uStep * inputSize.zw * fi, inputClamp.xy, inputClamp.zw);
    s += texture2D(uSampler, uv).a * wi; w += wi;
  }
  gl_FragColor = vec4(0.0, 0.0, 0.0, s / w);
}`;
// Second blur direction + the glow composited UNDER the graded sprite.
const GLOW_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform sampler2D uGraded;
uniform highp vec4 inputSize;   // highp: must match the filter vertex shader
uniform highp vec4 inputClamp;
uniform vec2 uStep;
uniform vec3 uRim;
uniform float uGlowA;
void main(void) {
  float s = 0.0, w = 0.0;
  for (int i = -12; i <= 12; i++) {
    float fi = float(i);
    float wi = exp(-0.5 * fi * fi / 16.0);
    vec2 uv = clamp(vTextureCoord + uStep * inputSize.zw * fi, inputClamp.xy, inputClamp.zw);
    s += texture2D(uSampler, uv).a * wi; w += wi;
  }
  float sa = clamp(s / w, 0.0, 1.0) * uGlowA;
  vec4 g = texture2D(uGraded, vTextureCoord);
  gl_FragColor = g + vec4(uRim * sa, sa) * (1.0 - g.a);
}`;

let _GradeFilter = null;
function makeGradeFilter() {
  if (!_GradeFilter) {
    _GradeFilter = class GradeFilter extends PIXI.Filter {
      constructor() {
        super(undefined, GRADE_FRAG, { uM: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), uO: new Float32Array(3), uExp: 1 });
        this.fudTokenTint = true;
        this.fudTintKind = "grade";
        this.blurH = new PIXI.Filter(undefined, BLUR_H_FRAG, { uStep: new Float32Array([1, 0]) });
        this.glowPass = new PIXI.Filter(undefined, GLOW_FRAG, { uStep: new Float32Array([0, 1]), uGraded: PIXI.Texture.EMPTY, uRim: new Float32Array([1, 1, 1]), uGlowA: 0 });
        this.glowA = 0; this.glowPx = 0; this.refH = 250;
        this.padding = 8;
      }
      /** Push one fade state (called on fades / re-asserts only, never per frame). */
      setGrade(spec, p) {
        const g = gradeAt(spec, p), u = matUniforms(g.matrix);
        this.uniforms.uM = u.m3; this.uniforms.uO = u.off; this.uniforms.uExp = g.exponent;
        this.glowA = g.glowA; this.glowPx = spec.glowPx; this.refH = spec.refH;
        this.glowPass.uniforms.uRim = new Float32Array(spec.rim); this.glowPass.uniforms.uGlowA = g.glowA;
      }
      apply(fm, input, output, clearMode, state) {
        // Glow size follows the DRAWN body (zoom, depth, 3D stage) like the cue --k:
        // σ = (glowPx at a refH-tall sprite) / 2, read off the filtered object itself,
        // so a cinematic clone sharing this filter gets its own size.
        let h = 0;
        try { h = state?.target?.getBounds?.(true)?.height || 0; } catch { h = 0; }
        const sigma = h > 0 ? (this.glowPx * (h / this.refH)) / 2 : 0;
        this.padding = Math.ceil(sigma * 3) + 2;        // takes effect next frame
        if (!(this.glowA > 0.003) || sigma < 0.05) { fm.applyFilter(this, input, output, clearMode); return; }
        const a = fm.getFilterTexture(input), b = fm.getFilterTexture(input);
        fm.applyFilter(this, input, a, PIXI.CLEAR_MODES.CLEAR);
        const step = sigma / 4;
        this.blurH.uniforms.uStep[0] = step; this.blurH.uniforms.uStep[1] = 0;
        fm.applyFilter(this.blurH, a, b, PIXI.CLEAR_MODES.CLEAR);
        this.glowPass.uniforms.uStep[0] = 0; this.glowPass.uniforms.uStep[1] = step;
        this.glowPass.uniforms.uGraded = a;
        fm.applyFilter(this.glowPass, b, output, clearMode);
        this.glowPass.uniforms.uGraded = PIXI.Texture.EMPTY;
        fm.returnFilterTexture(a); fm.returnFilterTexture(b);
      }
      destroy() { try { this.blurH.destroy(); this.glowPass.destroy(); } catch { /* */ } super.destroy(); }
    };
  }
  return new _GradeFilter();
}

/* ── Reading the flag ───────────────────────────────────────────────────── */

function tintFlagOf(effect) {
  const f = effect?.flags?.[FLAG_NS];
  const raw = f?.tokenTint;
  if (!raw || effect?.disabled) return null;
  const rgb = parseColor(raw);
  if (!rgb) return null;
  let strength = Number(f.tokenTintStrength);
  if (!Number.isFinite(strength)) strength = 1;
  strength = Math.max(0, Math.min(1, strength));
  return {
    color: rgb,
    strength,
    mode: String(f.tokenTintMode ?? "multiply").trim().toLowerCase() === "recolor" ? "recolor" : "multiply",
    target: String(f.tokenTintTarget ?? "bearer").trim().toLowerCase() === "applier" ? "applier" : "bearer",
    applierActorUuid: f.directorAppliedBy?.reactorActorUuid ?? null,
  };
}

// Every actor whose AEs could tint SOMEONE: world actors (the Field is one) plus
// unlinked token actors on the current canvas. Event-driven, never per-frame.
function* candidateBearers() {
  const seen = new Set();
  for (const a of game.actors?.contents ?? []) { if (a && !seen.has(a.uuid)) { seen.add(a.uuid); yield a; } }
  for (const t of canvas?.tokens?.placeables ?? []) {
    const a = t?.actor;
    if (a && !seen.has(a.uuid)) { seen.add(a.uuid); yield a; }
  }
}

// Status washes (token status plan "G + E", status-cues.js): a provider that
// returns a tint spec for a status like Poisoned or Wet. Consulted only when no
// AE carries its own tokenTint flag, so authored tints always win.
let _statusTintProvider = null;
export function setStatusTintProvider(fn) { _statusTintProvider = typeof fn === "function" ? fn : null; }

// Desired tint spec for an actor ({ color, strength, mode } or null): its own
// bearer-mode AEs first, else any applier-mode AE anywhere that names it, else
// the status wash. First match wins (replace_family keeps one anyway).
export function readTokenTint(actor) {
  return readFlagTint(actor) ?? statusWashOf(actor);
}
function statusWashOf(actor) {
  if (!_statusTintProvider || !actor) return null;
  try { return _statusTintProvider(actor) ?? null; } catch { return null; }
}
function readFlagTint(actor) {
  if (!actor) return null;
  try {
    for (const e of actor.effects ?? []) {
      const spec = tintFlagOf(e);
      if (spec?.target === "bearer") return spec;
    }
  } catch { /* fall through */ }
  for (const bearer of candidateBearers()) {
    let effects = [];
    try { effects = [...(bearer.effects ?? [])]; } catch { continue; }
    for (const e of effects) {
      const spec = tintFlagOf(e);
      if (spec?.target === "applier" && spec.applierActorUuid === actor.uuid) return spec;
    }
  }
  return null;
}

/* ── Apply ──────────────────────────────────────────────────────────────── */

function docTintOf(token) {
  try {
    const c = foundry.utils.Color.from(token.document?.texture?.tint ?? 0xFFFFFF);
    return Number.isFinite(Number(c)) ? [c.r, c.g, c.b] : WHITE;
  } catch { return WHITE; }
}

// One tint filter per mesh, of one kind ("recolor" | "grade"); a kind change swaps it.
function setFilter(mesh, kind, rec, amount) {
  const existing = (mesh.filters ?? []).find((f) => f?.fudTokenTint);
  if (kind && existing && (existing.fudTintKind ?? "recolor") !== kind) { setFilter(mesh, null); setFilter(mesh, kind, rec, amount); return; }
  if (kind === "recolor") {
    const f = existing ?? makeRecolorFilter();
    f.uniforms.uTint = rec.color;
    f.uniforms.uStrength = amount;
    if (!existing) mesh.filters = [...(mesh.filters ?? []), f];
  } else if (kind === "grade") {
    const f = existing ?? makeGradeFilter();
    f.setGrade(rec.grade, amount);
    if (!existing) mesh.filters = [...(mesh.filters ?? []), f];
  } else if (existing) {
    const rest = (mesh.filters ?? []).filter((f) => f !== existing);
    mesh.filters = rest.length ? rest : null;
    try { existing.destroy(); } catch {}
  }
}

// Write the record's CURRENT state onto the mesh (progress-scaled).
function applyRec(token, rec) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return;
  const amount = rec ? rec.strength * rec.cur : 0;
  try {
    if (rec?.mode === "recolor" || (rec?.mode === "grade" && rec.grade)) {
      mesh.tint = toHexNumber(docTintOf(token));
      // Attach the filter as soon as the record exists — even at progress 0 —
      // so a cinematic clone taken in the same tick the AE lands (oni.cloneToken
      // copies mesh.filters) carries it and fades in along with the real mesh.
      setFilter(mesh, rec.mode, rec, amount);
    } else {
      setFilter(mesh, null);
      mesh.tint = toHexNumber(mul3(docTintOf(token), rec ? lerp3(WHITE, rec.color, amount) : WHITE));
    }
  } catch {}
}

function ensureTicker() {
  if (_tickerOn) return;
  try { canvas.app.ticker.add(tintTick); _tickerOn = true; } catch {}
}
function dropTicker() {
  if (!_tickerOn) return;
  try { canvas.app.ticker.remove(tintTick); } catch {}
  _tickerOn = false;
}

function tintTick() {
  if (!_tints.size) { dropTicker(); return; }
  const now = performance.now();
  let animating = false;
  for (const [tokenId, rec] of _tints) {
    const token = canvas?.tokens?.get?.(tokenId);
    if (!token || token.destroyed) { _tints.delete(tokenId); continue; }
    const t = rec.dur > 0 ? Math.min(1, (now - rec.t0) / rec.dur) : 1;
    rec.cur = rec.from + (rec.tgt - rec.from) * t;
    applyRec(token, rec);
    if (t < 1) animating = true;
    else if (rec.tgt === 0) {
      // Faded back to neutral — hand the mesh back to Foundry's own tint.
      _tints.delete(tokenId);
      applyRec(token, null);
    }
  }
  if (!animating) dropTicker();
}

// Steer a token toward `spec` (null = back to neutral) with a fade.
function setTokenTint(token, spec) {
  if (!token?.id) return;
  const rec = _tints.get(token.id);
  if (spec) {
    if (rec && rec.mode === spec.mode && same3(rec.color, spec.color) && rec.strength === spec.strength && rec.grade?.key === spec.grade?.key && rec.tgt === 1) return;
    if (rec && rec.mode === spec.mode) {
      // Colour / strength swap in the same mode: cross-fade the progress from
      // wherever it is, re-pointed at the new colour.
      rec.color = spec.color; rec.strength = spec.strength; rec.grade = spec.grade ?? null;
      rec.from = rec.cur; rec.tgt = 1; rec.t0 = performance.now(); rec.dur = FADE_IN_MS;
    } else {
      if (rec) applyRec(token, null); // mode change: drop the old representation first
      _tints.set(token.id, { mode: spec.mode, color: spec.color, strength: spec.strength, grade: spec.grade ?? null, cur: 0, from: 0, tgt: 1, t0: performance.now(), dur: FADE_IN_MS });
    }
  } else {
    if (!rec || rec.tgt === 0) return; // already neutral / fading out
    rec.from = rec.cur; rec.tgt = 0; rec.t0 = performance.now(); rec.dur = FADE_OUT_MS;
  }
  ensureTicker();
}

/* ── Sync ───────────────────────────────────────────────────────────────── */

export function syncActorTint(actor) {
  if (!actor) return;
  const spec = readTokenTint(actor);
  let tokens = [];
  try { tokens = actor.getActiveTokens?.(true) ?? []; } catch {}
  for (const token of tokens) setTokenTint(token, spec);
}

async function syncActorByUuid(uuid) {
  if (!uuid) return;
  try {
    const doc = await fromUuid(uuid);
    const actor = doc?.documentName === "Actor" ? doc : doc?.actor ?? null;
    if (actor) syncActorTint(actor);
  } catch (e) { warn("token-tint: sync by uuid threw", e); }
}

function rescanCanvas() {
  // Snap (no fade) on a rescan — this is "restore what should already be there".
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (!token?.actor) continue;
    const spec = readTokenTint(token.actor);
    if (spec) {
      const rec = { mode: spec.mode, color: spec.color, strength: spec.strength, grade: spec.grade ?? null, cur: 1, from: 1, tgt: 1, t0: performance.now(), dur: 0 };
      _tints.set(token.id, rec);
      applyRec(token, rec);
    } else if (_tints.has(token.id)) {
      _tints.delete(token.id);
      applyRec(token, null);
    }
  }
  if (_tints.size) log(`token-tint: rescan — ${_tints.size} tinted token(s) on ${canvas?.scene?.name ?? "?"}`);
}

// Exported for manual probing / recovery (FUCompanion console use).
export function rescanTokenTints() { rescanCanvas(); }
export function tintedTokenIds() { return Array.from(_tints.keys()); }

/* ── Boot ───────────────────────────────────────────────────────────────── */

// Idempotent — called on every client from director-boot's ready hook.
export function initTokenTint() {
  if (_hooksOn) return;
  _hooksOn = true;

  // An AE event touches at most two actors: the bearer (bearer mode) and the
  // stamped applier (applier mode). On DELETE the flag is still readable off
  // the deleted document, so the applier can be resolved and cleared.
  const onAeEvent = (effect) => {
    if (!effect?.flags?.[FLAG_NS]?.tokenTint) return;
    const bearer = effect.parent?.documentName === "Actor" ? effect.parent : null;
    if (bearer) syncActorTint(bearer);
    const applier = effect.flags?.[FLAG_NS]?.directorAppliedBy?.reactorActorUuid ?? null;
    if (applier && applier !== bearer?.uuid) syncActorByUuid(applier);
  };
  Hooks.on("createActiveEffect", onAeEvent);
  Hooks.on("updateActiveEffect", onAeEvent);
  Hooks.on("deleteActiveEffect", onAeEvent);

  // Foundry re-stamps mesh.tint from the document on every refresh / redraw
  // (and a redraw builds a fresh mesh with no filters); re-assert ours. Cheap:
  // a Map lookup per refresh, a write only when tinted.
  const reassert = (token) => {
    const rec = _tints.get(token?.id);
    if (rec) applyRec(token, rec);
  };
  Hooks.on("refreshToken", reassert);
  Hooks.on("drawToken", reassert);
  Hooks.on("destroyToken", (token) => { _tints.delete(token?.id); });

  // Token spawned mid-scene (director PREP spawns, summons) whose actor is
  // already tinted. Defer so the mesh exists before the first write.
  Hooks.on("createToken", (tokenDoc) => {
    if (!tokenDoc?.actor) return;
    setTimeout(() => {
      try { syncActorTint(tokenDoc.actor); }
      catch (e) { warn("token-tint: createToken sync threw", e); }
    }, 100);
  });

  Hooks.on("canvasTearDown", () => { _tints.clear(); dropTicker(); });
  Hooks.on("canvasReady", () => {
    setTimeout(() => {
      try { rescanCanvas(); }
      catch (e) { warn("token-tint: canvasReady rescan threw", e); }
    }, 250);
  });

  if (canvas?.ready) rescanCanvas();
  setTimeout(() => {
    try { rescanCanvas(); }
    catch (e) { warn("token-tint: deferred boot rescan threw", e); }
  }, 3000);

  try {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.tokenTint = { rescan: rescanCanvas, read: readTokenTint, tintedTokenIds };
  } catch {}

  log("token-tint: watcher installed");
}
